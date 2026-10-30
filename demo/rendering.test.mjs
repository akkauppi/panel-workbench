import test from 'node:test';
import assert from 'node:assert/strict';
import { createSolidGeometry } from './rendering.js';
import { buildPanelSolids, exportSolidsOBJ, exportSolidsSTL } from './solids.js';
import { buildCarvedPanels } from './carving.js';

const sub = (a, b) => a.map((value, axis) => value - b[axis]);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = vector => { const length = Math.hypot(...vector); return vector.map(value => value / length); };
const normalAt = (geometry, triangle, corner) => Array.from(geometry.getAttribute('normal').array.slice((triangle * 3 + corner) * 3, (triangle * 3 + corner + 1) * 3));
const faceNormal = (solid, triangle) => { const [a, b, c] = solid.triangles[triangle].map(id => solid.positions[id]); return unit(cross(sub(b, a), sub(c, a))); };
function closeVector(actual, expected, message = '') { assert.ok(actual.every((value, axis) => Math.abs(value - expected[axis]) < 1e-6), `${message}: ${actual} versus ${expected}`); }
function cell(points = [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]], id = 0) {
  return { id, flatPositions: points, loops: [points.map((_, i) => i)], valid: true,
    plane: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] } };
}
function assertFlatFaces(solid) {
  assert.equal(solid.valid, true, solid.issues.join('; '));
  const geometry = createSolidGeometry(solid);
  solid.triangles.forEach((_, i) => { for (let j = 0; j < 3; j++) closeVector(normalAt(geometry, i, j), faceNormal(solid, i), 'a sharp face has one geometric normal'); });
  geometry.dispose();
}

test('sharp box corners retain three distinct face normals without changing solid geometry or exports', () => {
  const [solid] = buildPanelSolids([cell()], { thickness: 40, radius: 0 });
  const before = structuredClone(solid), obj = exportSolidsOBJ([solid]), stl = exportSolidsSTL([solid]);
  assertFlatFaces(solid);
  const geometry = createSolidGeometry(solid), normals = [];
  solid.triangles.forEach((triangle, i) => triangle.forEach((id, j) => { if (id === 0) normals.push(normalAt(geometry, i, j)); }));
  assert.equal(new Set(normals.map(normal => normal.join(','))).size, 3);
  assert.equal(geometry.index, null, 'render vertices split at physical face boundaries');
  assert.equal(geometry.getAttribute('position').count, solid.triangles.length * 3);
  assert.deepEqual(Array.from(geometry.getAttribute('position').array), solid.triangles.flatMap(triangle => triangle.flatMap(id => solid.positions[id].map(Math.fround))));
  assert.deepEqual(solid, before);
  assert.equal(exportSolidsOBJ([solid]), obj); assert.equal(exportSolidsSTL([solid]), stl);
  geometry.dispose();
});

test('shallow outline corners and shared mitre faces stay sharp regardless of their angle', () => {
  const shallow = cell([[0, 0, 0], [100, 0, 0], [140, 10, 0], [100, 100, 0], [0, 100, 0]]);
  const [solid] = buildPanelSolids([shallow], { thickness: 40, radius: 0 });
  assertFlatFaces(solid);
  assert.ok(dot(unit(solid.cuts[0][0].normal), unit(solid.cuts[0][1].normal)) > .95, 'fixture includes a shallow hard corner');
  const angle = Math.PI / 3, c = Math.cos(angle), s = Math.sin(angle);
  const left = cell([[-100, 0, 0], [0, 0, 0], [0, 100, 0], [-100, 100, 0]], 0);
  const right = cell([[0, 0, 0], [100 * c, 0, 100 * s], [100 * c, 100, 100 * s], [0, 100, 0]], 1);
  right.plane = { origin: [0, 0, 0], u: [c, 0, s], v: [0, 1, 0], normal: [-s, 0, c] };
  const solids = buildPanelSolids([left, right], { thickness: 20, radius: 0 });
  for (const part of solids) { assert.ok(part.cuts.flat().some(cut => cut.neighborId !== null)); assertFlatFaces(part); }
});

test('roundover arcs shade smoothly within each side while flat walls and caps keep their tangent normals', () => {
  const [solid] = buildPanelSolids([cell()], { thickness: 40, radius: 4, segments: 4 });
  assert.equal(solid.valid, true);
  const geometry = createSolidGeometry(solid), samples = new Map();
  let wallTriangles = 0, smoothArcSamples = 0, capTangents = 0;
  solid.triangles.forEach((triangle, i) => {
    const patch = solid.trianglePatches[i], face = faceNormal(solid, i);
    if (solid.triangleGroups[i] !== 'edge') {
      for (let j = 0; j < 3; j++) closeVector(normalAt(geometry, i, j), [0, 0, solid.triangleGroups[i] === 'positive' ? 1 : -1]);
      return;
    }
    const isWall = triangle.every(id => Math.abs(solid.positions[id][2]) <= 16 + 1e-8);
    if (isWall) wallTriangles++;
    triangle.forEach((id, j) => {
      const normal = normalAt(geometry, i, j), z = solid.positions[id][2], key = `${patch}/${id}`;
      if (samples.has(key)) closeVector(normal, samples.get(key), 'all triangles on one side share their arc normal');
      samples.set(key, normal);
      if (isWall) closeVector(normal, face, 'flat walls do not acquire a bevel shading gradient');
      if (Math.abs(z) > 16 + 1e-5 && Math.abs(z) < 20 - 1e-5 && dot(normal, face) < .999) smoothArcSamples++;
      if (Math.abs(Math.abs(z) - 20) < 1e-8) { capTangents++; closeVector(normal, [0, 0, Math.sign(z)], 'rounded rim meets the cap tangentially'); }
    });
  });
  assert.equal(wallTriangles, 8); assert.ok(smoothArcSamples > 16); assert.ok(capTangents > 0);
  const corner = solid.positions.findIndex(p => p[0] > 0 && p[0] < 4 && p[1] > 0 && p[1] < 4 && p[2] > 17 && p[2] < 19);
  assert.ok(corner >= 0);
  assert.ok(dot(samples.get(`side:0:0/${corner}`), samples.get(`side:0:3/${corner}`)) < .8, 'two rounded side patches still retain their real corner');
  geometry.dispose();
});

function curvedReference() {
  const vertices = [], triangles = [], n = 8;
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
    const px = x * 25 - 50, py = y * 25 - 50;
    vertices.push([px, py, -5 + (px - 50) ** 2 / 500]);
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x;
    triangles.push([a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]);
  }
  return { vertices, triangles };
}

test('carving preserves side patch identity and smooths either carved cap without flattening it or blending into walls', () => {
  for (const carvedSide of ['positive', 'negative']) {
    const cells = [cell()], [base] = buildPanelSolids(cells, { thickness: 60, radius: 0 });
    const [solid] = buildCarvedPanels([base], cells, curvedReference(), { innerSide: carvedSide, subdivisions: 2, minimumThickness: 12 });
    assert.equal(solid.valid, true, solid.issues.join('; '));
    assert.equal(solid.trianglePatches.length, solid.triangles.length);
    base.trianglePatches.forEach((patch, i) => assert.ok(solid.trianglePatches.slice(i * 16, (i + 1) * 16).every(value => value === patch)));
    const geometry = createSolidGeometry(solid), normals = new Map(), outside = carvedSide === 'positive' ? 'negative' : 'positive';
    let tilted = 0, smoothed = 0;
    solid.triangles.forEach((triangle, i) => {
      const group = solid.triangleGroups[i];
      triangle.forEach((id, j) => {
        const normal = normalAt(geometry, i, j);
        assert.ok(normal.every(Number.isFinite)); assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-6);
        if (group === outside) closeVector(normal, [0, 0, outside === 'positive' ? 1 : -1]);
        if (group !== carvedSide) return;
        if (Math.abs(normal[0]) > .02) tilted++;
        if (dot(normal, faceNormal(solid, i)) < .99999) smoothed++;
        if (normals.has(id)) closeVector(normal, normals.get(id)); else normals.set(id, normal);
        assert.ok(Math.abs(normal[2]) > .95, 'the carved cap does not borrow vertical wall normals at its perimeter');
      });
    });
    assert.ok(tilted > 5 && smoothed > 5, 'curved cap normals retain the sampled surface curvature');
    geometry.dispose();
  }
});

test('older solids without surface patch metadata safely retain sharp side facets', () => {
  const [solid] = buildPanelSolids([cell()], { thickness: 40, radius: 0 });
  delete solid.trianglePatches;
  assertFlatFaces(solid);
});

test('invalid carved geometry remains renderable for diagnosis even with a collapsed triangle', () => {
  const [solid] = buildPanelSolids([cell()], { thickness: 40, radius: 0 });
  solid.valid = false; solid.carved = true; solid.carvedSide = 'positive';
  const [a, b] = solid.triangles[0];
  solid.positions[b] = [...solid.positions[a]];
  const before = structuredClone(solid), geometry = createSolidGeometry(solid);
  assert.ok(Array.from(geometry.getAttribute('normal').array).every(Number.isFinite));
  assert.equal(geometry.getAttribute('position').count, solid.triangles.length * 3);
  assert.deepEqual(solid, before);
  geometry.dispose();
});
