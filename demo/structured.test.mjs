import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeodesicSphere, generateStructuredLayout } from './structured.js';
import { createExample } from './examples.js';
import { generateCells } from './geometry.js';
import { captureLayout, restoreLayout, layoutRecipe } from './layout.js';
import { fitSharedPanels } from './fitted.js';
import { buildPanelSolids } from './solids.js';

const sub = (a, b) => a.map((x, axis) => x - b[axis]);
const dot = (a, b) => a.reduce((sum, x, axis) => sum + x * b[axis], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const distance = (a, b) => Math.hypot(...sub(a, b));
function sheet(n, reverse = false, transform = p => p) {
  const vertices = [], triangles = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push(transform([(x / n - .5) * 3000, 0, (y / n - .5) * 2400]));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1;
    triangles.push(...(reverse ? [[a, d, b], [b, d, c]] : [[a, d, c], [a, c, b]]));
  }
  return { vertices, triangles };
}
function polygon(cell, loop = cell.loops[0]) {
  const points = loop.map(id => cell.positions[id]);
  for (let i = 0; points.length > 3 && i < points.length;) {
    const a = sub(points[i], points[(i + points.length - 1) % points.length]), b = sub(points[(i + 1) % points.length], points[i]);
    if (Math.hypot(...cross(a, b)) < 1e-7 * Math.hypot(...a) * Math.hypot(...b)) { points.splice(i, 1); i = 0; } else i++;
  }
  return points;
}
function canonicalBoundaries(surface) {
  return surface.cells.map(cell => ({ id: cell.id, loops: cell.loops.map(loop => polygon(cell, loop).map(p => p.map(x => Math.round(x * 1e5))).sort()) }));
}
function savedRoundTrip(model, pattern, size, generated) {
  const recipe = layoutRecipe({ seeds: generated.seeds, pattern, size, mergeGroups: [], cornerEdits: [] });
  const layout = captureLayout(model, generated.surface, { recipe }), restored = restoreLayout(model, structuredClone(layout));
  assert.deepEqual(restored.cells.map(c => ({ id: c.id, positions: c.positions, triangles: c.triangles, loops: c.loops })),
    generated.surface.cells.map(c => ({ id: c.id, positions: c.positions, triangles: c.triangles, loops: c.loops })));
  return layout;
}

test('planar hexagons have exact straight bisectors and do not depend on source triangulation', () => {
  const pattern = { type: 'hexagonal', angle: 17, frequency: 2 }, options = { size: 400 };
  const first = generateStructuredLayout(sheet(6), pattern, options), second = generateStructuredLayout(sheet(11, true), pattern, options);
  assert.deepEqual(canonicalBoundaries(first.surface), canonicalBoundaries(second.surface));
  assert.ok(first.surface.stats.coverageError < 1e-12);
  assert.equal(first.seeds.length, first.surface.stats.requestedCellCount);
  assert.equal(first.surface.stats.emptyCellCount, 0);
  const middle = first.surface.cells.find(c => c.neighbors.length === 6 && Math.hypot(...c.seed) < 500);
  const corners = polygon(middle);
  assert.equal(corners.length, 6);
  assert.ok(Math.abs(middle.area - Math.sqrt(3) / 2 * 400 ** 2) < 1e-6);
  for (let i = 0; i < 6; i++) {
    assert.ok(Math.abs(distance(corners[i], corners[(i + 1) % 6]) - 400 / Math.sqrt(3)) < 1e-7);
    const a = sub(corners[(i + 5) % 6], corners[i]), b = sub(corners[(i + 1) % 6], corners[i]);
    assert.ok(Math.abs(dot(a, b) / Math.hypot(...a) / Math.hypot(...b) + .5) < 1e-9);
  }
  const model = sheet(6), before = structuredClone(model);
  assert.deepEqual(generateStructuredLayout(model, pattern, options), generateStructuredLayout(model, pattern, options));
  assert.deepEqual(model, before);
  assert.notDeepEqual(canonicalBoundaries(first.surface), canonicalBoundaries(generateStructuredLayout(model, { ...pattern, angle: 47 }, options).surface));
});

test('hex lattice orientation is deterministic on an oblique plane with tied normal components', () => {
  const transform = ([x, , z]) => [100 + x / Math.sqrt(2), -200 + x / Math.sqrt(2), z + 700];
  const pattern = { type: 'hexagonal', angle: 23, frequency: 2 }, options = { size: 500 };
  const a = generateStructuredLayout(sheet(5, false, transform), pattern, options);
  const b = generateStructuredLayout(sheet(9, true, transform), pattern, options);
  assert.deepEqual(canonicalBoundaries(a.surface), canonicalBoundaries(b.surface));
});

test('source-edge-aligned hexagons and rotated layouts pass strict snapshot integrity with openings intact', () => {
  const model = createExample('aperture-sheet');
  for (const [size, angle] of [[600, 0], [600, 30], [400, 30], [318, 30]]) {
    const pattern = { type: 'hexagonal', angle, frequency: 2 }, generated = generateStructuredLayout(model, pattern, { size });
    assert.ok(Math.abs(generated.surface.stats.totalArea - 11_520_000) < 1e-6);
    assert.ok(generated.surface.stats.coverageError < 1e-12);
    savedRoundTrip(model, pattern, size, generated);
    for (const cell of generated.surface.cells) for (const triangle of cell.triangles) {
      const center = [0, 2].map(axis => triangle.reduce((sum, id) => sum + cell.positions[id][axis], 0) / 3);
      assert.ok(!(Math.abs(center[0]) < 400 - 1e-7 && Math.abs(center[1]) < 300 - 1e-7));
    }
  }
  const single = generateStructuredLayout(model, { type: 'hexagonal' }, { size: 10000 });
  assert.equal(single.seeds.length, 1); assert.equal(single.surface.cells[0].holeCount, 1);
  assert.equal(single.surface.cells[0].loops.length, 2);
});

test('whole-sphere geodesic duals have twelve pentagons, the correct hexagons, and closed topology', () => {
  const model = createGeodesicSphere({ subdivisions: 6 });
  for (const frequency of [1, 2, 3, 6]) {
    const { seeds, surface } = generateStructuredLayout(model, { type: 'geodesic', frequency }, { size: 500 });
    assert.equal(seeds.length, 10 * frequency * frequency + 2);
    assert.equal(surface.cells.filter(c => c.neighbors.length === 5).length, 12);
    assert.equal(surface.cells.filter(c => c.neighbors.length === 6).length, seeds.length - 12);
    assert.equal(surface.corners.length, 20 * frequency * frequency);
    assert.ok(surface.corners.every(c => !c.boundary && c.cells.length === 3));
    assert.ok(surface.cells.every(c => c.sourceComponentCount === 1 && c.loops.length === 1 && c.valid));
    const edges = surface.cells.reduce((sum, c) => sum + c.neighbors.length, 0) / 2;
    assert.equal(surface.corners.length - edges + seeds.length, 2);
    assert.ok(surface.stats.coverageError < 1e-12);
  }
});

test('spherical sites rotate deterministically, clip spherical patches, and retain exact saved source geometry', () => {
  const model = createGeodesicSphere(), pattern = { type: 'geodesic', frequency: 2, angle: 17 };
  const generated = generateStructuredLayout(model, pattern, { size: 880 });
  assert.deepEqual(generated, generateStructuredLayout(model, pattern, { size: 880 }));
  assert.notDeepEqual(generated.surface.corners, generateStructuredLayout(model, { ...pattern, angle: 0 }, { size: 880 }).surface.corners);
  savedRoundTrip(model, pattern, 880, generated);
  const dome = generateStructuredLayout(createExample('dome'), pattern, { size: 880 });
  assert.ok(dome.seeds.length > 0 && dome.seeds.length < 42);
  assert.ok(dome.surface.corners.some(c => c.boundary));
  assert.ok(dome.surface.stats.coverageError < 1e-12);
});

test('structured surfaces fit, form valid solids, and merge without changing the generated partition elsewhere', () => {
  for (const [model, pattern, size] of [[sheet(10), { type: 'hexagonal' }, 500], [createGeodesicSphere(), { type: 'geodesic', frequency: 2 }, 880]]) {
    const generated = generateStructuredLayout(model, pattern, { size }), fitted = fitSharedPanels(generated.surface, { straightness: .7, iterations: 700 });
    assert.ok(fitted.cells.every(c => c.valid), JSON.stringify(fitted.cells.filter(c => !c.valid).map(c => c.issues)));
    assert.ok(fitted.stats.maxSeamGap < 1e-6); assert.ok(fitted.stats.maxPlanarityError < .15);
    const solids = buildPanelSolids(fitted.cells, { thickness: 40, radius: 2, outwardCenter: [0, 0, 0] });
    assert.ok(solids.every(s => s.valid), JSON.stringify(solids.filter(s => !s.valid).map(s => s.issues)));
    const a = generated.surface.cells[0], b = generated.surface.cells.find(c => c.id === a.neighbors[0]), members = [a.id, b.id].sort((x, y) => x - y);
    const merged = generateStructuredLayout(model, pattern, { size, mergeGroups: [{ id: members[0], members }] });
    assert.equal(merged.surface.cells.length, generated.surface.cells.length - 1);
    assert.ok(Math.abs(merged.surface.cells.find(c => c.id === members[0]).area - a.area - b.area) < 1e-6);
    for (const cell of generated.surface.cells.filter(c => !members.includes(c.id))) assert.deepEqual(merged.surface.cells.find(c => c.id === cell.id).positions, cell.positions);
  }
});

test('unsupported surfaces, invalid controls and excessive candidate lattices are rejected explicitly', () => {
  assert.throws(() => generateStructuredLayout(createExample('organic-vessel'), { type: 'hexagonal' }, { size: 400 }), /planar/);
  assert.throws(() => generateStructuredLayout(createExample('organic-vessel'), { type: 'geodesic' }), /spherical/);
  assert.throws(() => generateStructuredLayout(sheet(1), { type: 'geodesic' }), /spherical/);
  assert.throws(() => generateStructuredLayout(sheet(1), { type: 'hexagonal' }, { size: 0 }), /spacing/);
  assert.throws(() => generateStructuredLayout(sheet(1), { type: 'geodesic', frequency: 7 }), /frequency/i);
  assert.throws(() => generateStructuredLayout(sheet(1), { type: 'hexagonal', angle: Infinity }, { size: 500 }), /angle/i);
  assert.throws(() => generateStructuredLayout(sheet(1, false, p => p.map(x => x * 1e6)), { type: 'hexagonal' }, { size: 10 }), /500 candidate/);
  assert.throws(() => generateStructuredLayout(sheet(1), { type: 'hexagonal' }, { size: 400, cornerEdits: [{}] }), /direct corner/);
  assert.throws(() => generateCells(sheet(1), [{ id: 0, position: [0, 0, 0] }], { score: () => NaN }), /score field/);
});
