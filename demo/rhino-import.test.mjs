import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRhino } from './rhino-runtime.js';
import { parse3DM } from './rhino-import.js';

const rhino = await loadRhino();
const triangle = [[0, 0, 0], [10, 0, 0], [0, 10, 0]];
function document(units = 'Millimeters') {
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem[units];
  const layer = new rhino.Layer(); layer.name = 'Default'; doc.layers().add(layer); layer.delete();
  return doc;
}
function attributes(name = '', layerIndex = 0) { const attrs = new rhino.ObjectAttributes(); attrs.name = name; attrs.layerIndex = layerIndex; return attrs; }
function mesh(points = triangle, faces = [[0, 1, 2]]) {
  const result = new rhino.Mesh(), vertices = result.vertices(), list = result.faces();
  for (const point of points) vertices.add(...point);
  for (const face of faces) list[face.length === 3 ? 'addTriFace' : 'addQuadFace'](...face);
  vertices.delete(); list.delete(); return result;
}
function add(doc, geometry, attrs = attributes()) { const id = doc.objects().add(geometry, attrs); geometry.delete(); attrs.delete(); return id; }
function read(doc) { try { return parse3DM(doc.toByteArray(), rhino); } finally { doc.delete(); } }
function transform(values = {}) { const xform = new rhino.Transform(1); Object.assign(xform, values); return xform; }
function definition(doc, name, geometry, attrs = attributes()) {
  const index = doc.instanceDefinitions().add(name, '', '', '', [0, 0, 0], [geometry], [attrs]);
  geometry.delete(); attrs.delete();
  const block = doc.instanceDefinitions().get(index), id = block.id; block.delete(); return id;
}
function instance(doc, id, values = {}, attrs = attributes()) {
  const xform = transform(values), reference = new rhino.InstanceReference(id, xform);
  xform.delete(); return add(doc, reference, attrs);
}
function outline(points) { return new rhino.PolylineCurve([...points, points[0]]); }
function rectangle(x, y, width, height, z = 0) { return outline([[x, y, z], [x + width, y, z], [x + width, y + height, z], [x, y + height, z]]); }
function areaXY(result) {
  return result.triangles.reduce((sum, face) => {
    const [a, b, c] = face.map(i => result.vertices[i]);
    return sum + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }, 0);
}

test('3dm mesh import triangulates quads and preserves names and coordinates', () => {
  const doc = document();
  add(doc, mesh([[2, 3, 4], [12, 3, 4], [12, 13, 4], [2, 13, 4]], [[0, 1, 2, 3]]), attributes('Shell'));
  const result = read(doc);
  assert.equal(result.name, 'Shell');
  assert.deepEqual(result.vertices[0], [2, 3, 4]);
  assert.equal(result.triangles.length, 2);
  assert.equal(areaXY(result), 100);
  assert.equal(result.units, 'mm');
  assert.equal(result.originalFaceCount, 1);
});

test('3dm units normalize meters, inches and feet without changing axes', () => {
  for (const [units, factor] of [['Meters', 1000], ['Inches', 25.4], ['Feet', 304.8]]) {
    const doc = document(units); add(doc, mesh());
    const result = read(doc);
    assert.deepEqual(result.vertices[1], [10 * factor, 0, 0]);
    assert.equal(result.sourceUnits, units);
  }
  const unknown = document('None'); add(unknown, mesh());
  assert.throws(() => read(unknown), /unspecified or custom units/);
});

test('nested block transforms compose in world order and definition members do not duplicate', () => {
  const doc = document();
  const leaf = definition(doc, 'Leaf', mesh());
  const local = transform({ m03: 10 }), member = new rhino.InstanceReference(leaf, local); local.delete();
  const parent = definition(doc, 'Parent', member);
  instance(doc, parent, { m00: 0, m01: -1, m10: 1, m11: 0, m03: 100 });
  const result = read(doc);
  assert.equal(result.vertices.length, 3);
  assert.equal(result.triangles.length, 1);
  assert.deepEqual(result.vertices, [[100, 10, 0], [100, 20, 0], [90, 10, 0]]);
});

test('mirror instances reverse triangle winding while preserving reflected positions', () => {
  const doc = document(), id = definition(doc, 'Mirror', mesh());
  instance(doc, id, { m00: -1, m03: 100 });
  const result = read(doc);
  assert.deepEqual(result.vertices, [[100, 0, 0], [90, 0, 0], [100, 10, 0]]);
  const [a, b, c] = result.triangles[0].map(i => result.vertices[i]);
  assert.ok((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0);
});

test('workbench flat and repair-layout copies are excluded, ordinary additional block instances remain', () => {
  const doc = document(), id = definition(doc, 'Panel', mesh());
  const assembly = attributes(); assembly.setUserString('panel-workbench-placement', 'assembly');
  const flat = attributes(); flat.setUserString('panel-workbench-placement', 'flat');
  const repair = attributes(); repair.setUserString('panel-workbench-placement', 'repair-layout');
  instance(doc, id, {}, assembly); instance(doc, id, { m03: 100 }, flat); instance(doc, id, { m03: 200 }); instance(doc, id, { m03: 300 }, repair);
  const result = read(doc);
  assert.equal(result.triangles.length, 2);
  assert.ok(result.vertices.some(point => point[0] === 200));
  assert.ok(!result.vertices.some(point => point[0] === 100));
  assert.ok(!result.vertices.some(point => point[0] === 300));
  assert.match(result.warnings.join(' '), /Skipped 2 flat or repair-layout/);
});

test('hidden objects, hidden ancestor layers and paper-space geometry are excluded', () => {
  const doc = document(); add(doc, mesh(), attributes('Visible'));
  const hidden = attributes(); hidden.visible = false; add(doc, mesh(), hidden);
  const paper = attributes(); paper.activeSpace = rhino.ActiveSpace.PageSpace; add(doc, mesh(), paper);
  const parent = new rhino.Layer(); parent.name = 'Hidden'; parent.visible = false;
  const parentIndex = doc.layers().add(parent); parent.delete();
  const savedParent = doc.layers().get(parentIndex);
  const child = new rhino.Layer(); child.name = 'Child'; child.parentLayerId = savedParent.id; child.visible = true;
  savedParent.delete(); const childIndex = doc.layers().add(child); child.delete();
  add(doc, mesh(), attributes('Hidden child', childIndex));
  const result = read(doc);
  assert.equal(result.triangles.length, 1);
  assert.equal(result.name, 'Visible');
});

test('visible Breps require every face render mesh; a partial import is rejected', () => {
  const doc = document(); add(doc, mesh());
  const source = mesh(), brep = rhino.Brep.createFromMesh(source, true); source.delete();
  add(doc, brep, attributes('Unmeshed surface'));
  assert.throws(() => read(doc), /Unmeshed surface, face 1 has no saved render mesh/);
});

test('saved Brep render meshes import through the native file round trip', () => {
  const doc = document(), source = mesh(), brep = rhino.Brep.createFromMesh(source, true);
  const faces = brep.faces(), face = faces.get(0);
  // setMesh transfers the raw mesh into the Brep in rhino3dm 8.35.0. Its JS
  // wrapper must not destroy that mesh separately after ownership is passed.
  const cachedMesh = mesh();
  assert.equal(face.setMesh(cachedMesh, rhino.MeshType.Render), true);
  face.delete(); faces.delete(); source.delete(); add(doc, brep, attributes('Cached Brep'));
  const result = read(doc);
  assert.equal(result.triangles.length, 1);
  assert.deepEqual(result.vertices, triangle);
  assert.equal(result.name, 'Cached Brep');
});

test('closed polyline outlines fill a planar surface and preserve holes', () => {
  const doc = document();
  add(doc, rectangle(3, 3, 4, 4)); // Holes need not follow the outer boundary in file order.
  add(doc, rectangle(0, 0, 10, 10), attributes('Outlined shell'));
  const result = read(doc);
  assert.equal(areaXY(result), 84);
  assert.equal(result.outlinePointCount, 8);
  assert.ok(result.vertices.length > 8);
  assert.equal(result.name, 'Outlined shell');
  assert.equal(result.curveToleranceMm, undefined);
  for (const face of result.triangles) {
    const center = [0, 1].map(k => face.reduce((sum, i) => sum + result.vertices[i][k] / 3, 0));
    assert.ok(!(center[0] > 3 && center[0] < 7 && center[1] > 3 && center[1] < 7));
  }
  const edgeCounts = new Map();
  for (const face of result.triangles) for (let i = 0; i < 3; i++) {
    const a = face[i], b = face[(i + 1) % 3], key = a < b ? `${a}:${b}` : `${b}:${a}`;
    edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    assert.ok(Math.hypot(...result.vertices[a].map((v, axis) => v - result.vertices[b][axis])) <= Math.sqrt(200) / 20 + 1e-10);
  }
  for (const [key, count] of edgeCounts) {
    assert.ok(count <= 2);
    if (count !== 1) continue;
    const [a, b] = key.split(':').map(i => result.vertices[Number(i)]);
    assert.ok([0, 10].some(k => a[0] === k && b[0] === k || a[1] === k && b[1] === k)
      || [3, 7].some(k => a[0] === k && b[0] === k || a[1] === k && b[1] === k), 'Unshared edges must belong to an outline, not a refinement T-joint');
  }
});

test('rational NURBS circles tessellate within 0.1 mm after file unit conversion', () => {
  const doc = document('Meters'), circle = new rhino.Circle([0, 0, 0], 1);
  add(doc, circle.toNurbsCurve()); circle.delete();
  const result = read(doc);
  assert.equal(result.curveToleranceMm, 0.1);
  assert.ok(result.vertices.length > 100);
  for (let i = 0; i < result.outlinePointCount; i++) {
    const a = result.vertices[i], b = result.vertices[(i + 1) % result.outlinePointCount];
    assert.ok(Math.abs(Math.hypot(a[0], a[1]) - 1000) < 1e-7);
    assert.ok(1000 - Math.hypot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) <= 0.1);
  }
  assert.match(result.warnings.join(' '), /maximum chord deviation of 0.1 mm/);
  assert.ok(result.triangles.length <= 50000);
  if (result.refinementLimited) assert.match(result.warnings.join(' '), /50,000-triangle budget/);
});

test('outline block transforms preserve arbitrary planar orientation', () => {
  const doc = document(), id = definition(doc, 'Outline', rectangle(0, 0, 10, 10));
  instance(doc, id, { m11: 0, m12: -1, m21: 1, m22: 0, m13: 20 });
  const result = read(doc);
  assert.ok(result.triangles.length > 2);
  assert.ok(result.vertices.every(p => p[1] === 20));
  assert.deepEqual(result.vertices.slice(0, 4).map(p => p[2]), [0, 0, 10, 10]);
});

test('surface files ignore curves, including open ones, with an explicit warning', () => {
  const doc = document(); add(doc, mesh());
  add(doc, new rhino.PolylineCurve([[0, 0, 0], [0, 0, 10]]));
  const result = read(doc);
  assert.equal(result.triangles.length, 1);
  assert.match(result.warnings.join(' '), /Ignored 1 curve/);
});

test('open, nonplanar and mutually noncoplanar curve-only files fail explicitly', () => {
  const open = document(); add(open, new rhino.PolylineCurve([[0, 0, 0], [0, 1, 0]]));
  assert.throws(() => read(open), /closed outlines/);
  const nonplanar = document(); add(nonplanar, outline([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 2]]));
  assert.throws(() => read(nonplanar), /planar outlines|common plane/);
  const planes = document(); add(planes, rectangle(0, 0, 10, 10)); add(planes, rectangle(3, 3, 1, 1, 1));
  assert.throws(() => read(planes), /common plane/);
});

test('crossing, touching, disjoint and nested-island outlines fail instead of inventing a surface', () => {
  const crossing = document(); add(crossing, outline([[0, 0, 0], [10, 10, 0], [0, 10, 0], [10, 0, 0]]));
  assert.throws(() => read(crossing), /intersect or touch/);
  const touching = document(); add(touching, rectangle(0, 0, 10, 10)); add(touching, rectangle(0, 3, 2, 2));
  assert.throws(() => read(touching), /intersect or touch/);
  const disjoint = document(); add(disjoint, rectangle(0, 0, 10, 10)); add(disjoint, rectangle(20, 20, 2, 2));
  assert.throws(() => read(disjoint), /one outer outline/);
  const islands = document(); add(islands, rectangle(0, 0, 10, 10)); add(islands, rectangle(2, 2, 6, 6)); add(islands, rectangle(4, 4, 1, 1));
  assert.throws(() => read(islands), /Nested islands/);
});

test('invalid files and files with no visible usable geometry fail', () => {
  assert.throws(() => parse3DM(new Uint8Array([1, 2, 3, 4]), rhino), /could not be read/);
  assert.throws(() => parse3DM('not bytes', rhino), /binary/);
  assert.throws(() => read(document()), /no usable visible/);
  const degenerate = document(); add(degenerate, mesh([[0, 0, 0], [1, 0, 0], [2, 0, 0]]));
  assert.throws(() => read(degenerate), /no usable visible/);
});

test('non-finite native mesh coordinates and malformed block transforms fail', () => {
  for (const value of [NaN, Infinity]) {
    const doc = document(); add(doc, mesh([[value, 0, 0], [1, 0, 0], [0, 1, 0]]));
    assert.throws(() => read(doc), /invalid coordinate/);
  }
  const missing = document(); instance(missing, '11111111-2222-3333-4444-555555555555');
  assert.throws(() => read(missing), /missing definition/);
  const singular = document(), id = definition(singular, 'Singular', mesh());
  instance(singular, id, { m00: 0 });
  assert.throws(() => read(singular), /singular or invalid transform/);
});

test('excessive native block nesting is rejected before traversing unbounded depth', () => {
  const doc = document(); let id = definition(doc, 'Leaf', mesh());
  for (let i = 0; i < 65; i++) {
    const xform = transform(), reference = new rhino.InstanceReference(id, xform); xform.delete();
    id = definition(doc, `Nested${i}`, reference);
  }
  instance(doc, id);
  assert.throws(() => read(doc), /cyclic or excessively nested blocks/);
});

test('expanded block placements enforce the aggregate vertex budget', () => {
  const doc = document(), points = Array.from({ length: 100001 }, (_, i) => [i, i % 2, 0]);
  const id = definition(doc, 'Large', mesh(points)); instance(doc, id); instance(doc, id, { m03: 1 });
  assert.throws(() => read(doc), /200,000 vertices/);
});

test('expanded quad meshes enforce the resulting triangle budget', () => {
  const doc = document(), faces = Array.from({ length: 75001 }, () => [0, 1, 2, 3]);
  add(doc, mesh([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces));
  assert.throws(() => read(doc), /150,000 triangles/);
});
