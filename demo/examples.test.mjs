import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES, DEFAULT_EXAMPLE_ID, createExample } from './examples.js';
import { analyzeModel, generateSeeds, generateCellLayout } from './geometry.js';
import { fitSharedPanels } from './fitted.js';
import { buildPanelSolids } from './solids.js';
import { generateStructuredLayout } from './structured.js';

const sub = (a, b) => a.map((x, i) => x - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function components(adjacency) {
  const unseen = new Set(adjacency.keys());
  let count = 0;
  while (unseen.size) {
    count++;
    const queue = [unseen.values().next().value];
    unseen.delete(queue[0]);
    for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i])) if (unseen.delete(next)) queue.push(next);
  }
  return count;
}

function inspectTopology(model) {
  const edges = new Map(), used = new Set(), uniqueTriangles = new Set();
  const adjacency = new Map(model.triangles.map((_, i) => [i, new Set()]));
  for (const [triangleId, triangle] of model.triangles.entries()) {
    assert.equal(triangle.length, 3);
    assert.equal(new Set(triangle).size, 3);
    for (const id of triangle) { assert.ok(Number.isInteger(id) && id >= 0 && id < model.vertices.length); used.add(id); }
    const key = [...triangle].sort((a, b) => a - b).join(',');
    assert.ok(!uniqueTriangles.has(key), 'duplicate source triangle'); uniqueTriangles.add(key);
    const [a, b, c] = triangle.map(id => model.vertices[id]), normal = cross(sub(b, a), sub(c, a));
    assert.ok(Math.hypot(...normal) > 1, 'source triangles must have meaningful nonzero area in millimetres');
    for (let i = 0; i < 3; i++) {
      const a = triangle[i], b = triangle[(i + 1) % 3], key = [a, b].sort((x, y) => x - y).join(',');
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push({ triangleId, a, b });
    }
  }
  assert.equal(used.size, model.vertices.length, 'source contains no unreferenced vertices');
  const boundary = new Map();
  for (const incidence of edges.values()) {
    assert.ok(incidence.length <= 2, 'source has no nonmanifold edges');
    if (incidence.length === 2) {
      const [a, b] = incidence;
      assert.equal(a.a, b.b); assert.equal(a.b, b.a);
      adjacency.get(a.triangleId).add(b.triangleId); adjacency.get(b.triangleId).add(a.triangleId);
    } else {
      const { a, b } = incidence[0];
      if (!boundary.has(a)) boundary.set(a, new Set());
      if (!boundary.has(b)) boundary.set(b, new Set());
      boundary.get(a).add(b); boundary.get(b).add(a);
    }
  }
  assert.equal(components(adjacency), 1, 'source is one edge-connected surface');
  assert.ok([...boundary.values()].every(neighbors => neighbors.size === 2), 'source openings have simple closed boundaries');
  return { boundaryLoops: components(boundary), boundaryVertices: [...boundary.keys()], euler: model.vertices.length - edges.size + model.triangles.length };
}

test('gallery catalog is deterministic, independent, and expressed in millimetres with Y up', () => {
  assert.equal(new Set(EXAMPLES.map(example => example.id)).size, EXAMPLES.length);
  assert.equal(DEFAULT_EXAMPLE_ID, 'barrel-vault');
  assert.deepEqual(createExample(), createExample(DEFAULT_EXAMPLE_ID));
  assert.throws(() => createExample('missing-example'), /Unknown example/);
  for (const example of EXAMPLES) {
    assert.equal(example.units, 'mm'); assert.equal(example.up, 'y');
    assert.ok(example.name && example.description && example.initialSize > 0);
    const first = createExample(example.id), second = createExample(example.id);
    assert.deepEqual(first, second);
    first.vertices[0][0] += 1; first.triangles[0][0] = -1;
    assert.deepEqual(second, createExample(example.id), 'each factory call must own all of its geometry');
    for (const point of second.vertices) assert.ok(point.length === 3 && point.every(Number.isFinite));
    const topology = inspectTopology(second), opening = example.id === 'aperture-sheet', sphere = example.id === 'geodesic-sphere';
    assert.equal(topology.boundaryLoops, sphere ? 0 : opening ? 2 : 1);
    assert.equal(topology.euler, sphere ? 2 : opening ? 0 : 1);
    if (!['organic-vessel', 'geodesic-sphere'].includes(example.id)) for (const triangle of second.triangles) {
      const [a, b, c] = triangle.map(id => second.vertices[id]);
      assert.ok(cross(sub(b, a), sub(c, a))[1] > 0, 'the four sheet examples consistently point upward');
    }
    const heights = second.vertices.map(point => point[1]);
    assert.ok(opening ? heights.every(height => height === 0) : Math.max(...heights) - Math.min(...heights) > 400);
  }
});

test('the organic vessel surrounds space with an outward body, a closed curved base and one open rim', () => {
  const model = createExample('organic-vessel'), topology = inspectTopology(model);
  assert.equal(model.vertices.length, 1345);
  assert.equal(model.triangles.length, 2640);
  assert.equal(topology.boundaryVertices.length, 48);
  assert.ok(topology.boundaryVertices.every(id => model.vertices[id][1] === 2300), 'only the top rim is open');
  assert.equal(model.vertices.filter(point => point[1] === 0).length, 1, 'the rounded base closes at one shared pole');
  let upward = 0, downward = 0;
  for (const triangle of model.triangles) {
    const [a, b, c] = triangle.map(id => model.vertices[id]), normal = cross(sub(b, a), sub(c, a));
    const center = [0, 1, 2].map(axis => (a[axis] + b[axis] + c[axis]) / 3), t = center[1] / 2300;
    const radial = [center[0] - 200 * t * t, 0, center[2] - 80 * Math.sin(Math.PI * t) * t];
    assert.ok(normal.reduce((sum, value, axis) => sum + value * radial[axis], 0) > 0, 'side normals point away from the bent axis');
    if (normal[1] > 0) upward++; else if (normal[1] < 0) downward++;
  }
  assert.ok(upward > 500 && downward > 500, 'the vessel wraps underneath and over its belly instead of forming a height field');
  const rings = new Map();
  for (const point of model.vertices.slice(1)) {
    if (!rings.has(point[1])) rings.set(point[1], []);
    rings.get(point[1]).push(point);
  }
  const widths = [...rings].map(([y, points]) => ({ y, width: Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0])) }));
  const belly = Math.max(...widths.filter(ring => ring.y < 1500).map(ring => ring.width));
  const neck = Math.min(...widths.filter(ring => ring.y > 1700).map(ring => ring.width)), rim = widths.at(-1).width;
  assert.ok(belly > rim * 1.9 && rim > neck * 1.3, 'the silhouette has a pronounced belly, pinched neck and flared opening');
  const rimCenter = rings.get(2300).reduce((sum, point) => sum + point[0], 0) / 48;
  assert.ok(Math.abs(rimCenter - 200) < 1e-9, 'the neck is visibly offset from the base');
});

test('the aperture remains an actual opening through source clipping, fitting and solid construction', () => {
  const model = createExample('aperture-sheet');
  assert.equal(analyzeModel(model).area, 11_520_000);
  const source = generateCellLayout(model, [{ id: 0, position: [-1000, 0, -1000], weight: 1 }], { size: 500 });
  assert.equal(source.cells[0].holeCount, 1);
  assert.equal(source.cells[0].loops.length, 2);
  const fitted = fitSharedPanels(source, { straightness: .7, iterations: 700 });
  assert.equal(fitted.cells[0].valid, true);
  assert.equal(fitted.cells[0].loops.length, 2);
  const [solid] = buildPanelSolids(fitted.cells, { thickness: 40, radius: 2 });
  assert.equal(solid.valid, true, solid.issues.join('; '));
  for (const triangle of solid.triangles) {
    const center = [0, 2].map(axis => triangle.reduce((sum, id) => sum + solid.positions[id][axis], 0) / 3);
    assert.ok(!(Math.abs(center[0]) < 399 && Math.abs(center[1]) < 299), 'solid must not fill the source opening');
  }
});

const expectedCounts = { 'barrel-vault': 45, dome: 24, 'aperture-sheet': 132, saddle: 44, 'organic-vessel': 100, 'geodesic-sphere': 42 };
for (const example of EXAMPLES) test(`${example.name} starting preset resolves every flat and solid panel`, () => {
  const model = createExample(example.id), before = structuredClone(model), analysis = analyzeModel(model);
  const source = example.pattern ? generateStructuredLayout(model, example.pattern, { size: example.initialSize }).surface
    : generateCellLayout(model, generateSeeds(model, example.initialSize, .3, 7), { size: example.initialSize });
  assert.equal(source.cells.length, expectedCounts[example.id]);
  assert.ok(source.stats.coverageError < 1e-10);
  assert.ok(source.cells.every(cell => cell.sourceComponentCount === 1 && cell.valid));
  const fitted = fitSharedPanels(source, { straightness: .7, iterations: 700 });
  assert.equal(fitted.cells.length, source.cells.length);
  assert.deepEqual(fitted.cells.filter(cell => !cell.valid).map(cell => ({ id: cell.id, issues: cell.issues })), []);
  assert.ok(fitted.stats.maxPlanarityError < .15);
  const solids = buildPanelSolids(fitted.cells, { thickness: 40, radius: 2, outwardCenter: analysis.center });
  assert.equal(solids.length, source.cells.length);
  assert.deepEqual(solids.filter(solid => !solid.valid).map(solid => ({ id: solid.id, issues: solid.issues })), []);
  for (const solid of solids) {
    const edges = new Map();
    for (const triangle of solid.triangles) for (let i = 0; i < 3; i++) {
      const key = [triangle[i], triangle[(i + 1) % 3]].sort((a, b) => a - b).join(',');
      edges.set(key, (edges.get(key) || 0) + 1);
    }
    assert.ok([...edges.values()].every(count => count === 2), 'each solid must be watertight');
  }
  assert.deepEqual(model, before, 'generation and derived views must not modify the example source');
});
