import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectStockEnvelopes, buildPanelSolids, exportSolidsOBJ, exportSolidsSTL, attachSolidCornerPositions } from './solids.js';
import { buildCarvedPanels } from './carving.js';
import { parseOBJ } from './io.js';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const sub = (a, b) => a.map((x, i) => x - b[i]);
function cell(id, points, loops = [points.map((_, i) => i)], plane = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] }) {
  return { id, flatPositions: points, loops, plane, valid: true };
}
function volume(solid) { return solid.triangles.reduce((sum, t) => sum + dot(solid.positions[t[0]], cross(solid.positions[t[1]], solid.positions[t[2]])) / 6, 0); }
function closed(solid) {
  const edges = new Map();
  for (const triangle of solid.triangles) for (let j = 0; j < 3; j++) {
    const a = triangle[j], b = triangle[(j + 1) % 3], k = [a, b].sort((x, y) => x - y).join(',');
    edges.set(k, (edges.get(k) || 0) + 1);
  }
  assert.ok([...edges.values()].every(count => count === 2));
}

test('square stock is a closed solid with exact expected volume', () => {
  const [solid] = buildPanelSolids([cell(0, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]])], { thickness: 40, radius: 0 });
  assert.equal(solid.valid, true, solid.issues.join('; ')); closed(solid);
  assert.ok(Math.abs(volume(solid) - 400000) < 1e-6);
  assert.equal(solid.caps.positive.z, 20); assert.equal(solid.caps.negative.z, -20);
});

test('roundover adds real geometry, stays inside stock and remains closed', () => {
  const [solid] = buildPanelSolids([cell(0, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]])], { thickness: 40, radius: 4 });
  assert.equal(solid.valid, true, solid.issues.join('; ')); closed(solid);
  assert.ok(solid.positions.length > 16);
  assert.ok(volume(solid) < 400000 && volume(solid) > 350000);
  assert.ok(solid.positions.every(p => p[0] >= -1e-8 && p[0] <= 100.00000001 && p[1] >= -1e-8 && p[1] <= 100.00000001 && Math.abs(p[2]) <= 20.00000001));
  assert.equal(solid.actualRadius, 4);
});

test('folded adjacent panels share the same mitre plane and joint corners', () => {
  const angle = Math.PI / 3, c = Math.cos(angle), s = Math.sin(angle);
  const a = cell(0, [[-100, 0, 0], [0, 0, 0], [0, 100, 0], [-100, 100, 0]]);
  const b = cell(1, [[0, 0, 0], [100 * c, 0, 100 * s], [100 * c, 100, 100 * s], [0, 100, 0]], undefined,
    { origin: [0, 0, 0], u: [c, 0, s], v: [0, 1, 0], normal: [-s, 0, c] });
  const solids = buildPanelSolids([a, b], { thickness: 20, radius: 2 });
  for (const solid of solids) { assert.equal(solid.valid, true, solid.issues.join('; ')); closed(solid); assert.ok(solid.maxJointMismatch < 1e-7); }
  const cuts = solids.map(solid => solid.cuts.flat().find(cut => cut.neighborIndex !== null));
  assert.ok(Math.abs(dot(cuts[0].normal, cuts[1].normal) + Math.hypot(...cuts[0].normal) * Math.hypot(...cuts[1].normal)) < 1e-7);
  assert.ok(Math.abs(cuts[0].constant + cuts[1].constant) < 1e-7);
});

test('a sloping window boundary keeps complete neighboring joint faces matched', () => {
  const angle = Math.PI / 3, c = Math.cos(angle), s = Math.sin(angle);
  const a = cell(0, [[-100, 0, 0], [0, 0, 0], [0, 100, 0], [-100, 100, 0]]);
  const b = cell(1, [[0, 0, 0], [100 * c, 40, 100 * s], [100 * c, 100, 100 * s], [0, 100, 0]], undefined,
    { origin: [0, 0, 0], u: [c, 0, s], v: [0, 1, 0], normal: [-s, 0, c] });
  const solids = buildPanelSolids([a, b], { thickness: 20, radius: 2 });
  for (const solid of solids) { assert.equal(solid.valid, true, solid.issues.join('; ')); closed(solid); assert.equal(solid.maxJointMismatch, 0); }
  const faceKeys = solids.map(solid => {
    const cut = solid.cuts.flat().find(c => c.neighborIndex !== null);
    return solid.triangles.filter((triangle, i) => solid.triangleGroups[i] === 'edge'
      && triangle.every(v => Math.abs(dot(cut.normal, solid.positions[v]) - cut.constant) < 1e-7))
      .map(triangle => triangle.map(v => solid.positions[v].map(x => x.toFixed(6)).join(',')).sort().join('|')).sort();
  });
  assert.equal(faceKeys[0].length, 2);
  assert.deepEqual(faceKeys[0], faceKeys[1]);
});

test('opposing input face-normal signs are coherently oriented by shared topology', () => {
  const a = cell(0, [[-100, 0, 0], [0, 0, 0], [0, 100, 0], [-100, 100, 0]]);
  const b = cell(1, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]], undefined,
    { origin: [0, 0, 0], u: [1, 0, 0], v: [0, -1, 0], normal: [0, 0, -1] });
  const solids = buildPanelSolids([a, b], { thickness: 20, radius: 0 });
  for (const solid of solids) { assert.equal(solid.valid, true, solid.issues.join('; ')); closed(solid); assert.equal(solid.maxJointMismatch, 0); }
  assert.ok(dot(solids[0].plane.normal, solids[1].plane.normal) > .999);
});

test('positive cap can be oriented outward from a reference center and explicitly flipped', () => {
  const input = cell(0, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]], undefined,
    { origin: [0, 0, 0], u: [1, 0, 0], v: [0, -1, 0], normal: [0, 0, -1] });
  const [outward] = buildPanelSolids([input], { thickness: 20, radius: 2, outwardCenter: [50, 50, -100] });
  assert.equal(outward.valid, true, outward.issues.join('; '));
  assert.ok(outward.plane.normal[2] > .999);
  assert.ok(outward.caps.positive.vertexIndices.every(i => outward.positions[i][2] > 9.99));
  const [flipped] = buildPanelSolids([input], { thickness: 20, radius: 2, outwardCenter: [50, 50, -100], flipDirection: true });
  assert.equal(flipped.valid, true, flipped.issues.join('; '));
  assert.ok(flipped.plane.normal[2] < -.999);
  assert.ok(flipped.caps.positive.vertexIndices.every(i => flipped.positions[i][2] < -9.99));
});

test('one-sided roundover retains the other full cap for subsequent carving', () => {
  const [solid] = buildPanelSolids([cell(0, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]])], { thickness: 20, radius: 2, roundoverSide: 'positive' });
  assert.equal(solid.valid, true, solid.issues.join('; ')); closed(solid);
  assert.equal(solid.caps.negative.inset, 0);
  assert.ok(Math.abs(solid.caps.positive.inset - 2) < 1e-12);
  assert.equal(solid.caps.negative.z, -10);
});

test('an opening remains open through a closed panel solid', () => {
  const points = [[0, 0, 0], [200, 0, 0], [200, 200, 0], [0, 200, 0], [50, 50, 0], [50, 150, 0], [150, 150, 0], [150, 50, 0]];
  const [solid] = buildPanelSolids([cell(0, points, [[0, 1, 2, 3], [4, 5, 6, 7]])], { thickness: 20, radius: 0 });
  assert.equal(solid.valid, true, solid.issues.join('; ')); closed(solid);
  assert.ok(Math.abs(volume(solid) - 600000) < 1e-6);
  assert.equal(solid.caps.positive.boundaryLoops.length, 2);
});

test('collinear perimeter corners retain manifold cap connections', () => {
  const [solid] = buildPanelSolids([cell(0, [[0, 0, 0], [50, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]])], { thickness: 20, radius: 2 });
  assert.equal(solid.valid, true, solid.issues.join('; ')); closed(solid);
});

test('numerically collinear cap corners stay manifold without losing boundary connections', () => {
  for (const noise of [-1e-10, -1e-12]) {
    const points = [[0, 0, 0], [1, noise, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]];
    const [solid] = buildPanelSolids([cell(0, points)], { thickness: 40, radius: 2 });
    assert.equal(solid.valid, true, solid.issues.join('; '));
    closed(solid);
    for (const cap of Object.values(solid.caps)) assert.equal(cap.boundaryLoops[0].length, points.length);
    assert.ok(volume(solid) > 0);
  }
});

test('roundover shrinks to a valid inset at a narrow corner and reports the actual radius', () => {
  const points = [[0, 0, 0], [10, 0, 0], [1, .1, 0], [100, 10, 0], [100, 100, 0], [0, 100, 0]];
  const [solid] = buildPanelSolids([cell(0, points)], { thickness: 40, radius: 2 });
  assert.equal(solid.valid, true, solid.issues.join('; '));
  closed(solid);
  assert.equal(solid.requestedRadius, 2);
  assert.equal(solid.radiusClamped, true);
  assert.ok(solid.actualRadius > 0 && solid.actualRadius < .1);
  assert.equal(solid.thickness, 40);
  assert.ok(volume(solid) > 0);
});

test('roundover fallback validates the complete mesh when short side strips collapse', () => {
  // Synthetic square with one almost-collinear, very short boundary segment.
  // Its rounded outlines are valid, but the resulting side strips contain
  // collapsed triangles even at the edge-length radius cap.
  const panel = cell(0, [[0, 0, 0], [.0001, -1e-8, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]]);
  const [unrounded] = buildPanelSolids([panel], { thickness: 40, radius: 0 });
  const [solid] = buildPanelSolids([panel], { thickness: 40, radius: 2 });
  assert.equal(unrounded.valid, true, unrounded.issues.join('; '));
  assert.equal(solid.valid, true, solid.issues.join('; '));
  assert.equal(solid.requestedRadius, 2);
  assert.equal(solid.actualRadius, 0);
  assert.equal(solid.radiusClamped, true);
  assert.equal(solid.thickness, 40);
  assert.deepEqual(solid.positions, unrounded.positions, 'fallback preserves the unrounded stock');
  assert.deepEqual(solid.triangles, unrounded.triangles);
  closed(solid);
  for (const t of solid.triangles) {
    assert.ok(Math.hypot(...cross(sub(solid.positions[t[1]], solid.positions[t[0]]), sub(solid.positions[t[2]], solid.positions[t[0]]))) >= 1e-9);
  }
  assert.equal(solid.caps.positive.boundaryLoops[0].length, panel.flatPositions.length);
  assert.match(exportSolidsSTL([solid]), /^solid panels_mm/);
});

test('roundover fallback does not turn invalid unrounded stock into a valid solid', () => {
  const angle = Math.PI / 3, c = Math.cos(angle), s = Math.sin(angle);
  const panels = [
    cell(0, [[-100, 0, 0], [0, 0, 0], [0, 100, 0], [-100, 100, 0]]),
    cell(1, [[0, 0, 0], [100 * c, 0, 100 * s], [100 * c, 100, 100 * s], [0, 100, 0]], undefined,
      { origin: [0, 0, 0], u: [c, 0, s], v: [0, 1, 0], normal: [-s, 0, c] }),
  ];
  const unrounded = buildPanelSolids(panels, { thickness: 400, radius: 0 });
  const rounded = buildPanelSolids(panels, { thickness: 400, radius: 2 });
  for (let i = 0; i < panels.length; i++) {
    assert.equal(unrounded[i].valid, false);
    assert.equal(rounded[i].valid, false);
    assert.deepEqual(rounded[i].issues, unrounded[i].issues);
    assert.equal(rounded[i].positions.length, 0);
  }
  assert.throws(() => exportSolidsSTL(rounded), /valid solid panels/);
});

test('invalid cells cannot silently become exportable solids', () => {
  const bad = cell(0, [[0, 0, 0], [10, 0, 0], [10, 10, 0]]); bad.valid = false;
  const result = buildPanelSolids([bad], { thickness: 20 });
  assert.equal(result[0].valid, false);
  assert.throws(() => exportSolidsOBJ(result), /reshaping/);
});

test('OBJ and STL export the actual rounded solid triangles', () => {
  const solids = buildPanelSolids([cell(0, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]])], { thickness: 20, radius: 2 });
  const obj = exportSolidsOBJ(solids), stl = exportSolidsSTL(solids);
  assert.equal(obj.split('\n').filter(line => line.startsWith('f ')).length, solids[0].triangles.length);
  assert.equal(stl.split('\n').filter(line => line.startsWith('facet normal')).length, solids[0].triangles.length);
});

test('solid OBJ and STL offsets match panel translations, preserve normals and leave geometry untouched', () => {
  const solids = buildPanelSolids([
    cell(3, [[0,0,0],[100,0,0],[100,100,0],[0,100,0]]),
    cell(8, [[250,0,0],[350,0,0],[350,100,0],[250,100,0]]),
  ], { thickness: 20, radius: 2 });
  assert.ok(solids.every(solid => solid.valid));
  const before = structuredClone(solids), offsets = new Map([[3, [-24,12,30]], [8, [40,-8,-15]]]);
  const rounded = value => Number(value.toFixed(6));
  const translated = solid => solid.positions.map(p => p.map((value, axis) => rounded(value + offsets.get(solid.id)[axis])));
  const obj = exportSolidsOBJ(solids, { offsets, explode: 999 });
  assert.deepEqual(parseOBJ(obj).vertices, solids.flatMap(translated));
  assert.match(obj, /o P004\ng P004/); assert.match(obj, /o P009\ng P009/);
  assert.deepEqual(parseOBJ(exportSolidsOBJ([solids[1]], { offsets })).vertices, translated(solids[1]));
  const stl = exportSolidsSTL(solids, { offsets, explode: 999 });
  const vertices = text => [...text.matchAll(/^  vertex (.+)$/gm)].map(match => match[1].split(' ').map(Number));
  const normals = text => [...text.matchAll(/^facet normal (.+)$/gm)].map(match => match[1].split(' ').map(Number));
  assert.deepEqual(vertices(stl), solids.flatMap(solid => {
    const points = translated(solid); return solid.triangles.flatMap(triangle => triangle.map(index => points[index]));
  }));
  assert.deepEqual(vertices(exportSolidsSTL([solids[1]], { offsets })), solids[1].triangles.flatMap(triangle => triangle.map(index => translated(solids[1])[index])));
  const originalNormals = normals(exportSolidsSTL(solids));
  normals(stl).forEach((normal, index) => assert.ok(Math.hypot(...sub(normal, originalNormals[index])) <= 1e-6, 'A pure translation keeps each facet normal.'));
  assert.deepEqual(solids, before);
});

test('solid offsets preserve assembled defaults and unmapped panels retain numeric explode', () => {
  const solids = buildPanelSolids([
    cell(3, [[0,0,0],[100,0,0],[100,100,0],[0,100,0]]),
    cell(8, [[250,0,0],[350,0,0],[350,100,0],[250,100,0]]),
  ], { thickness: 20, radius: 0 });
  const zeros = new Map(solids.map(solid => [solid.id, [0,0,0]]));
  for (const exporter of [exportSolidsOBJ, exportSolidsSTL]) {
    assert.equal(exporter(solids), exporter(solids, { offsets: zeros }));
    assert.equal(exporter(solids, { explode: 15 }), exporter(solids, { explode: 15, offsets: new Map() }));
  }
  const partial = { explode: 15, offsets: new Map([[3, [0,0,0]]]) };
  const expected = solids.flatMap(solid => solid.positions.map(p => p.map((value, axis) => value + (solid.id === 3 ? 0 : solid.plane.normal[axis] * 15))));
  assert.deepEqual(parseOBJ(exportSolidsOBJ(solids, partial)).vertices, expected);
  const full = exportSolidsSTL(solids, partial);
  assert.equal(full, exportSolidsSTL(solids, { offsets: new Map([[3, [0,0,0]], [8, solids[1].plane.normal.map(value => value * 15)]]) }));
});

test('solid exports reject malformed offsets without weakening solid validity checks', () => {
  const solids = buildPanelSolids([cell(3, [[0,0,0],[100,0,0],[100,100,0],[0,100,0]])], { thickness: 20, radius: 0 });
  for (const exporter of [exportSolidsOBJ, exportSolidsSTL]) {
    assert.throws(() => exporter(solids, { offsets: { 3: [1,2,3] } }), /offsets must be a Map/);
    for (const offset of [null, undefined, [1,2], [1,2,3,4], [1,NaN,3], [1,Infinity,3], ['1',2,3]]) {
      assert.throws(() => exporter(solids, { offsets: new Map([[3, offset]]) }), /invalid export offset/);
    }
    assert.throws(() => exporter([{ ...solids[0], valid: false }], { offsets: new Map([[3, [1,2,3]]]) }), /valid solid|reshaping/);
  }
});

test('solid corner handles follow both exact stock offsets and match across folded owners', () => {
  const angle = Math.PI / 3, c = Math.cos(angle), s = Math.sin(angle);
  const a = cell(0, [[-100, 0, 0], [0, 0, 0], [0, 100, 0], [-100, 100, 0]]);
  const b = cell(1, [[0, 0, 0], [100 * c, 0, 100 * s], [100 * c, 100, 100 * s], [0, 100, 0]], undefined,
    { origin: [0, 0, 0], u: [c, 0, s], v: [0, 1, 0], normal: [-s, 0, c] });
  a.sharedVertexIds = [0, 1, 2, 3]; b.sharedVertexIds = [1, 4, 5, 2];
  const solids = buildPanelSolids([a, b], { thickness: 20, radius: 0 });
  const corner = { id: 'joint', position: [0, 0, 0], flatPosition: [0, 0, 0], sharedVertexId: 1, cells: [0, 1] };
  const [displayed] = attachSolidCornerPositions([corner], solids);
  assert.equal(displayed.solidPositions.length, 4);
  assert.deepEqual(displayed.solidPosition, displayed.solidPositions[0].position);
  assert.equal(displayed.solidCellId, 0);
  for (const entry of displayed.solidPositions) {
    const solid = solids.find(item => item.id === entry.cellId), sign = entry.side === 'positive' ? 1 : -1;
    assert.ok(solid.positions.some(point => Math.hypot(...sub(point, entry.position)) < 1e-7));
    assert.ok(Math.abs(dot(sub(entry.position, solid.plane.origin), solid.plane.normal) - sign * 10) < 1e-7);
    assert.ok(Math.hypot(...sub(entry.position, corner.flatPosition)) >= 10);
  }
  for (const side of ['positive', 'negative']) {
    const positions = displayed.solidPositions.filter(entry => entry.side === side).map(entry => entry.position);
    assert.deepEqual(positions[0], positions[1]);
  }
  assert.equal(corner.solidPositions, undefined, 'metadata attachment must not mutate source corners');
});

test('solid handles retain displayed invalid geometry and exclude missing mappings or empty solids', () => {
  const panel = cell(0, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]]);
  panel.sharedVertexIds = [10, 11, 12, 13];
  const [solid] = buildPanelSolids([panel], { thickness: 20, radius: 2 });
  const corner = { id: 'corner', sharedVertexId: 10, cells: [0] };
  const [invalid] = attachSolidCornerPositions([corner], [{ ...solid, valid: false }]);
  assert.equal(invalid.solidPositions.length, 2);
  assert.deepEqual(invalid.solidPosition, solid.cornerAnchors.find(anchor => anchor.sharedVertexId === 10).positive);
  for (const [corners, solids] of [
    [[corner], [{ ...solid, positions: [] }]],
    [[{ ...corner, sharedVertexId: null }], [solid]],
    [[{ ...corner, sharedVertexId: 99 }], [solid]],
  ]) {
    const [result] = attachSolidCornerPositions(corners, solids);
    assert.deepEqual(result.solidPositions, []);
    assert.equal(result.solidPosition, null);
    assert.equal(result.solidCellId, null);
  }
});

test('carved corner handles use the fixed outside stock face and omit the deformed inside envelope', () => {
  const panel = cell(0, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]]);
  panel.sharedVertexIds = [10, 11, 12, 13];
  const model = { vertices: panel.flatPositions, triangles: [[0, 1, 2], [0, 2, 3]] };
  const solids = buildPanelSolids([panel], { thickness: 20, radius: 2, roundoverSide: 'positive' });
  const carved = buildCarvedPanels(solids, [panel], model, { minimumThickness: 5, subdivisions: 1 });
  assert.equal(carved[0].carved, true);
  const [corner] = attachSolidCornerPositions([{ id: 'corner', sharedVertexId: 10, cells: [0] }], carved);
  assert.deepEqual(corner.solidPositions.map(entry => entry.side), ['positive']);
  assert.deepEqual(corner.solidPosition, solids[0].cornerAnchors.find(anchor => anchor.sharedVertexId === 10).positive);
  assert.equal(corner.solidPosition[2], 10);
});


test('fast stock envelopes detect a thickness-only crossing of a source support plane', () => {
  const c = .5, s = Math.sqrt(3) / 2;
  const panel = cell(0, [[0, 0, 2], [100, 0, 2], [100, 100 * c, 2 + 100 * s], [0, 100 * c, 2 + 100 * s]], undefined,
    { origin: [0, 0, 2], u: [1, 0, 0], v: [0, c, s], normal: [0, -s, c] });
  panel.supportPlanes = [{ normal: [0, 0, 1], d: 0, support: 1 }];
  const [envelope] = inspectStockEnvelopes([panel], { thickness: 40 });
  const [solid] = buildPanelSolids([panel], { thickness: 40, radius: 2 });
  assert.equal(envelope.valid, false);
  assert.ok(envelope.boundaryViolation > 7.9);
  assert.equal(solid.valid, false);
  assert.match(solid.issues.join(' '), /past a planar source opening/);
  assert.ok(panel.flatPositions.every(point => point[2] > 0), 'the midsurface is inside; the thick cap is the failure');
  assert.equal(inspectStockEnvelopes([panel], { thickness: 2 })[0].valid, true);
  assert.equal(buildPanelSolids([panel], { thickness: 2, radius: 0 })[0].valid, true);
});

test('a source rim trims thick stock even when an adjacent panel is invalid', () => {
  const c = .5, s = Math.sqrt(3) / 2, rim = { normal: [0, 0, 1], d: 0, support: 1 };
  const panel = cell(0, [[0, 0, 0], [100, 0, 0], [100, 100 * c, 100 * s], [0, 100 * c, 100 * s]], undefined,
    { origin: [0, 0, 0], u: [1, 0, 0], v: [0, c, s], normal: [0, -s, c] });
  panel.boundaryPlanes = [rim, rim, null, null]; panel.supportPlanes = [rim];
  const invalid = { ...panel, id: 1, valid: false };
  const [solid, rejected] = buildPanelSolids([panel, invalid], { thickness: 20, radius: 2 });
  assert.equal(solid.valid, true, solid.issues.join('; '));
  assert.equal(rejected.valid, false);
  assert.ok(solid.positions.every(point => point[2] >= -1e-7));
  assert.ok(solid.cuts.flat().some(cut => cut.kind === 'source-boundary-plane'));
  assert.ok(solid.positions.some(point => Math.abs(point[2]) < 1e-7));
  closed(solid);
});
