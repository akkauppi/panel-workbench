import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRegularizedLayout, triangleDistanceField } from './regularized.js';
import { generateCells, generateSeeds, generateCellLayout } from './geometry.js';
import { createExample } from './examples.js';
import { captureLayout, restoreLayout, layoutRecipe } from './layout.js';
import { transactLayout } from './layout-edit.js';
import { fitSharedPanels } from './fitted.js';
import { buildPanelSolids } from './solids.js';

function grid(n = 10, height = () => 0, include = () => true) {
  const vertices = [], triangles = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push([x * 100, y * 100, height(x * 100, y * 100)]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (include(x, y)) {
    const a = y * (n + 1) + x;
    triangles.push([a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]);
  }
  return { vertices, triangles };
}
const pattern = regularity => ({ type: 'regularized', regularity });
const shape = result => result.cells.map(cell => ({ id: cell.id, positions: cell.positions, triangles: cell.triangles, loops: cell.loops }));
function snapshot(model, result, size, regularity = .7) {
  const recipe = layoutRecipe({ pattern: pattern(regularity), seeds: result.seeds, size, randomSeed: 7 });
  const layout = captureLayout(model, result.surface, { recipe }), restored = restoreLayout(model, structuredClone(layout));
  assert.deepEqual(shape(restored), shape(result.surface));
  return layout;
}

test('triangle-interior propagation demonstrably reduces edge-direction distance bias on a plane', () => {
  const model = grid(), seeds = [{ id: 0, position: [0, 0, 0] }];
  let points, edges, faces;
  generateCells(model, seeds, { adjustFields(prepared, _, fields) { points = prepared.graphPoints; edges = [...fields[0]]; } });
  generateCells(model, seeds, { distanceField: triangleDistanceField, adjustFields(_, __, fields) { faces = [...fields[0]]; } });
  const error = values => values.reduce((sum, value, i) => sum + Math.abs(value - Math.hypot(...points[i])), 0) / values.length;
  assert.ok(error(faces) < error(edges) * .3, `${error(faces)} versus edge-only ${error(edges)}`);
  assert.ok(error(faces) > .1, 'the approximation retains a measurable mesh-resolution error, not an exact-geodesic claim');
  assert.ok(faces.every((value, i) => value >= Math.hypot(...points[i]) - 1e-6));
});

test('thin source triangles retain their altitude and stable interior projection', () => {
  const points = [[500000, -1, 0], [0, 0, 0], [1000000, 0, 0], [500000, .001, 0]];
  const prepared = { graphPoints: points, triangles: [[0, 1, 2], [1, 2, 3]].map(graphIds => ({ graphIds, points: graphIds.map(id => points[id]) })) };
  const distances = triangleDistanceField(points[0], prepared);
  assert.ok(Math.abs(distances[3] - (Math.hypot(500000, 1) + .001)) < 1e-7);
  assert.ok(distances[3] - distances[1] > .0009, 'the thin face does not become a zero-height propagation shortcut');
  const interior = triangleDistanceField([500000, .0005, 0], prepared);
  assert.ok(Math.abs(interior[3] - .0005) < 1e-10);
  assert.ok(interior.every(Number.isFinite));
});

test('regularized organic vessel improves area uniformity and mostly 5/6/7 connectivity at the same 100 cells', () => {
  const model = createExample('organic-vessel'), original = structuredClone(model);
  const result = generateRegularizedLayout(model, pattern(.7), { size: 380, randomSeed: 7 }), { diagnostics } = result;
  assert.equal(result.seeds.length, 100);
  assert.equal(diagnostics.baseline.cellCount, 100); assert.equal(diagnostics.final.cellCount, 100);
  assert.ok(diagnostics.final.areaCV < diagnostics.baseline.areaCV * .8);
  assert.ok(diagnostics.final.interior567Fraction > diagnostics.baseline.interior567Fraction);
  assert.ok(diagnostics.final.interior567Fraction >= .95);
  assert.equal(diagnostics.final.sourceComponentFailures, 0);
  assert.ok(result.surface.stats.coverageError < 1e-10);
  assert.equal(diagnostics.iterationBudget, 8); assert.equal(diagnostics.iterations, 8);
  assert.ok(diagnostics.iterationLog.every((step, i, steps) => !i || step.objective < steps[i - 1].objective));
  assert.match(diagnostics.limitation, /mesh resolution.*do not guarantee/i);
  snapshot(model, result, 380);
  assert.deepEqual(generateRegularizedLayout(model, pattern(.7), { size: 380, randomSeed: 7 }), result);
  assert.deepEqual(model, original);
  const fitted = fitSharedPanels(result.surface, { straightness: .7, iterations: 700 });
  assert.ok(fitted.cells.every(cell => cell.valid));
  assert.ok(fitted.stats.maxSeamGap < 1e-6);
  const solids = buildPanelSolids(fitted.cells, { thickness: 40, radius: 2 });
  assert.equal(solids.length, 100);
  assert.ok(solids.filter(solid => solid.valid).length >= 98);
  assert.ok(solids.filter(solid => !solid.valid).every(solid => solid.issues.length > 0), 'remaining fabrication conflicts stay explicit');
});

test('regularity weights initial-site anchoring at a fixed iteration budget rather than changing cell count', () => {
  const model = grid(8, (x, y) => (x - 400) ** 2 / 5000 + (y - 400) ** 2 / 7000), size = 250;
  const initial = generateSeeds(model, size, .3, 7);
  const zero = generateRegularizedLayout(model, pattern(0), { size });
  const low = generateRegularizedLayout(model, pattern(.2), { size }), high = generateRegularizedLayout(model, pattern(.8), { size });
  assert.deepEqual(zero.seeds, initial); assert.equal(zero.diagnostics.iterations, 0);
  assert.equal(low.diagnostics.iterationBudget, high.diagnostics.iterationBudget);
  assert.equal(low.seeds.length, high.seeds.length);
  const displacement = result => result.seeds.reduce((sum, seed, i) => sum + Math.hypot(...seed.position.map((x, axis) => x - initial[i].position[axis])), 0);
  assert.ok(displacement(high) > displacement(low) * 1.5);
  assert.notDeepEqual(shape(low.surface), shape(high.surface));
});

test('source openings and authored graph operations survive regularization and exact snapshots', () => {
  const model = grid(12, () => 0, (x, y) => !(x >= 4 && x < 8 && y >= 4 && y < 8));
  const result = generateRegularizedLayout(model, pattern(.7), { size: 300 });
  assert.ok(Math.abs(result.surface.stats.totalArea - (1200 ** 2 - 400 ** 2)) < 1e-6);
  for (const cell of result.surface.cells) for (const triangle of cell.triangles) {
    const center = [0, 1].map(axis => triangle.reduce((sum, id) => sum + cell.positions[id][axis], 0) / 3);
    assert.ok(!(center[0] > 400 + 1e-7 && center[0] < 800 - 1e-7 && center[1] > 400 + 1e-7 && center[1] < 800 - 1e-7));
  }
  const layout = snapshot(model, result, 300), a = result.surface.cells[0], b = a.neighbors[0];
  const merged = transactLayout(model, layout, { type: 'merge-cells', cellIds: [a.id, b] });
  assert.equal(merged.surface.cells.length, result.seeds.length - 1);
  assert.equal(merged.layout.authority, 'graph');
  assert.ok(Math.abs(merged.surface.stats.totalArea - result.surface.stats.totalArea) < 1e-6);
  assert.deepEqual(shape(restoreLayout(model, structuredClone(merged.layout))), shape(merged.surface));
});

test('close disconnected sheets remain separate and an initially unseeded tiny sheet receives a centre', () => {
  const base = grid(), vertices = [...base.vertices.map(p => [...p]), ...base.vertices.map(([x, y]) => [x, y, 1])];
  const model = { vertices, triangles: [...base.triangles, ...base.triangles.map(t => t.map(id => id + base.vertices.length))] };
  const result = generateRegularizedLayout(model, pattern(.7), { size: 500 });
  assert.equal(result.diagnostics.componentCount, 2);
  assert.ok(result.seeds.some(seed => Math.abs(seed.position[2]) < 1e-8));
  assert.ok(result.seeds.some(seed => Math.abs(seed.position[2] - 1) < 1e-8));
  for (const cell of result.surface.cells) {
    const z = cell.positions.map(p => p[2]);
    assert.ok(Math.max(...z) - Math.min(...z) < 1e-8, 'no site owns the opposing sheet through empty space');
    assert.equal(cell.sourceComponentCount, 1);
  }
  snapshot(model, result, 500);
  const tiny = grid(); tiny.vertices.push([100, 100, 1], [105, 100, 1], [100, 105, 1]); tiny.triangles.push([121, 122, 123]);
  const repaired = generateRegularizedLayout(tiny, pattern(.7), { size: 500 });
  assert.equal(repaired.diagnostics.componentCount, 2); assert.equal(repaired.diagnostics.reassigned, 1);
  assert.equal(repaired.seeds.length, 12);
  assert.ok(repaired.surface.cells.some(cell => Math.abs(cell.area - 12.5) < 1e-8));
  assert.ok(repaired.surface.cells.every(cell => cell.sourceComponentCount === 1));
});

test('a folded connected sheet cannot assign far opposing faces through their small spatial gap', () => {
  const base = grid(), offset = base.vertices.length;
  const vertices = [...base.vertices, ...base.vertices.map(([x, y]) => [x, y, 2])];
  const triangles = [...base.triangles, ...base.triangles.map(([a, b, c]) => [a + offset, c + offset, b + offset])];
  for (let y = 0; y < 10; y++) { const a = y * 11, b = (y + 1) * 11; triangles.push([a, b, b + offset], [a, b + offset, a + offset]); }
  const model = { vertices, triangles }, result = generateRegularizedLayout(model, pattern(.7), { size: 500 });
  assert.equal(result.diagnostics.componentCount, 1);
  for (const cell of result.surface.cells) {
    const z = cell.positions.map(p => p[2]);
    if (Math.max(...z) - Math.min(...z) > 1) assert.ok(cell.triangles.some(triangle => triangle.every(id => Math.abs(cell.positions[id][0]) < 1e-8)), 'ownership on both sides must include the real connecting fold');
    assert.equal(cell.sourceComponentCount, 1);
  }
  assert.ok(result.surface.stats.coverageError < 1e-10);
  snapshot(model, result, 500);
});

test('degenerate source faces do not become phantom sheets or alter deterministic relaxation', () => {
  const model = grid(6), degenerate = structuredClone(model);
  degenerate.triangles.push([0, 0, 0], [0, 1, 2]);
  const first = generateRegularizedLayout(model, pattern(.7), { size: 250 });
  const second = generateRegularizedLayout(degenerate, pattern(.7), { size: 250 });
  assert.equal(second.diagnostics.componentCount, 1);
  assert.deepEqual(second.seeds, first.seeds); assert.deepEqual(shape(second.surface), shape(first.surface));
});

test('invalid settings, insufficient component sites and excessive mesh work fail explicitly', () => {
  assert.throws(() => generateRegularizedLayout(grid(), pattern(2), { size: 400 }), /regularity/i);
  assert.throws(() => generateRegularizedLayout(grid(), pattern(.7), { size: 0 }), /spacing/i);
  assert.throws(() => generateRegularizedLayout(grid(), { type: 'organic' }, { size: 400 }), /regularized/);
  assert.throws(() => generateRegularizedLayout(grid(), pattern(.7), { size: 400, cornerEdits: [{}] }), /direct corner/);
  assert.throws(() => generateCellLayout(grid(), [{ id: 0, position: [200, 200, 0] }], { distanceField: triangleDistanceField, cornerEdits: [{}] }), /direct corner/);
  const vertices = [], triangles = [];
  for (let i = 0; i < 13; i++) { const a = vertices.length; vertices.push([i * 10, 0, 0], [i * 10 + 1, 0, 0], [i * 10, 1, 0]); triangles.push([a, a + 1, a + 2]); }
  assert.throws(() => generateRegularizedLayout({ vertices, triangles }, pattern(.7), { size: 10000 }), /every disconnected source sheet/);
  assert.throws(() => generateRegularizedLayout(grid(100), pattern(.7), { size: 100 }), /work budget/);
});
