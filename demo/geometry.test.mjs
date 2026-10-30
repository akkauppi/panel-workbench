import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeModel, generateSeeds, generateCells } from './geometry.js';
import { wavyGrid } from './test-fixtures.mjs';

function grid(n = 10, height = () => 0, include = () => true) {
  const vertices = [], triangles = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push([x * 100, y * 100, height(x * 100, y * 100)]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (include(x, y)) {
    const a = y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1;
    triangles.push([a, b, c], [a, c, d]);
  }
  return { vertices, triangles };
}

function close(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test('surface clipping preserves total area and neighbouring boundary positions', () => {
  const model = grid();
  const result = generateCells(model, [{ id: 0, position: [200, 500, 0] }, { id: 1, position: [800, 500, 0] }]);
  close(result.stats.totalArea, 1_000_000);
  close(result.stats.maxSeamGap, 0);
  close(result.stats.maxDeviation, 0);
  assert.equal(result.cells.length, 2);
  assert.deepEqual(result.cells[0].neighbors, [1]);
  assert.ok(result.cells.every(cell => cell.valid));
});

test('a window remains a genuine hole in both surface and flattened outlines', () => {
  const model = grid(10, () => 0, (x, y) => !(x >= 4 && x < 6 && y >= 4 && y < 6));
  const { cells, stats } = generateCells(model, [{ id: 0, position: [200, 200, 0] }]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].loops.length, 2);
  assert.equal(cells[0].holeCount, 1);
  assert.ok(cells[0].valid);
  close(stats.totalArea, 960_000);
  close(cells[0].loopAreas.reduce((a, b) => a + b, 0), 960_000);
  for (const t of cells[0].triangles) {
    const centroid = [0, 1].map(k => t.reduce((sum, i) => sum + cells[0].positions[i][k], 0) / 3);
    assert.ok(!(centroid[0] > 400 && centroid[0] < 600 && centroid[1] > 400 && centroid[1] < 600));
  }
});

test('flat previews are genuinely planar and report the loss of surface fit', () => {
  const model = grid(10, (x, y) => (x - 500) ** 2 / 1800 + (y - 500) ** 2 / 2200);
  const result = generateCells(model, [{ id: 0, position: [200, 500, 50] }, { id: 1, position: [800, 500, 50] }]);
  assert.ok(result.stats.maxDeviation > 10);
  assert.ok(result.stats.maxSeamGap > 1);
  for (const cell of result.cells) for (const point of cell.flatPositions) {
    const distance = point.reduce((sum, value, i) => sum + (value - cell.plane.origin[i]) * cell.plane.normal[i], 0);
    close(distance, 0, 1e-8);
  }
  close(result.stats.totalArea, analyzeModel(model).area, 1e-6);
});

test('moving a centre changes its cell geometry without losing surface coverage', () => {
  const model = grid();
  const before = generateCells(model, [{ id: 0, position: [200, 500, 0] }, { id: 1, position: [800, 500, 0] }]);
  const after = generateCells(model, [{ id: 0, position: [400, 500, 0] }, { id: 1, position: [800, 500, 0] }]);
  assert.ok(Math.abs(before.cells[0].area - after.cells[0].area) > 50_000);
  close(before.stats.totalArea, after.stats.totalArea);
});

test('cell sizes control count and variation is reproducible', () => {
  const model = grid(20);
  const first = generateSeeds(model, 300, .35, 4);
  const repeat = generateSeeds(model, 300, .35, 4);
  const larger = generateSeeds(model, 500, .35, 4);
  assert.deepEqual(first, repeat);
  assert.ok(first.length > larger.length);
  assert.notDeepEqual(first, generateSeeds(model, 300, .35, 5));
});

test('increasing one centre weight grows its area while retaining coverage', () => {
  const model = grid();
  const seeds = [{ id: 0, position: [200, 500, 0], weight: 1 }, { id: 1, position: [800, 500, 0], weight: 1 }];
  const before = generateCells(model, seeds, { size: 500 });
  seeds[0].weight = 1.6;
  const after = generateCells(model, seeds, { size: 500 });
  assert.ok(after.cells[0].area > before.cells[0].area + 30_000);
  close(before.stats.totalArea, after.stats.totalArea);
  assert.equal(after.cells[0].weight, 1.6);
});

test('opposing source winding and separate pieces are flagged instead of silently cut', () => {
  const model = { vertices: [[0, 0, 0], [100, 0, 0], [0, 100, 0], [200, 0, 0], [300, 0, 0], [200, 100, 0]], triangles: [[0, 1, 2], [3, 5, 4]] };
  const { cells } = generateCells(model, [{ id: 0, position: [30, 30, 0] }]);
  assert.equal(cells[0].valid, false);
  assert.equal(cells[0].sourceComponentCount, 2);
  assert.ok(cells[0].issues.some(issue => issue.includes('separate surface pieces')));
});

test('surface distances follow shared-edge fans instead of jumping through a point contact', () => {
  const vertices = [], triangles = [], indices = new Map();
  // The two lower end squares touch at [100,100], but their surface connection
  // follows a long corridor around the top. A position-only graph crosses the
  // contact and gives cell 0 a second disconnected patch inside cell 1's square.
  for (const [x, y] of [[0, 0], [-1, 0], [-1, 1], [-1, 2], [0, 2], [1, 2], [1, 1]]) {
    const ids = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([a, b]) => {
      const key = `${a},${b}`;
      if (!indices.has(key)) { indices.set(key, vertices.length); vertices.push([a * 100, b * 100, 0]); }
      return indices.get(key);
    });
    triangles.push([ids[0], ids[1], ids[2]], [ids[0], ids[2], ids[3]]);
  }
  const model = { vertices, triangles };
  const duplicatedVertices = triangles.flatMap(triangle => triangle.map(id => [...vertices[id]]));
  const duplicated = { vertices: duplicatedVertices, triangles: triangles.map((_, i) => [3 * i, 3 * i + 1, 3 * i + 2]) };
  const seeds = [{ id: 0, position: [90, 90, 0] }, { id: 1, position: [180, 180, 0] }];
  for (const input of [model, duplicated]) {
    const before = structuredClone(input), result = generateCells(input, seeds, { size: 100 });
    assert.deepEqual(input, before, 'source coordinates and triangle indices remain unchanged');
    assert.equal(result.cells.length, 2);
    close(result.stats.totalArea, 70000);
    assert.ok(result.cells.every(cell => cell.sourceComponentCount === 1 && cell.valid));
    const first = result.cells.find(cell => cell.id === 0);
    for (const triangle of first.triangles) {
      const center = [0, 1].map(k => triangle.reduce((sum, id) => sum + first.positions[id][k], 0) / 3);
      assert.ok(!(center[0] > 100 && center[1] > 100 && center[1] < 200), 'the point contact does not bypass the corridor');
    }
  }
});

test('a procedural wavy surface keeps connected source regions with complete coverage', () => {
  const model = wavyGrid();
  const seeds = generateSeeds(model, 250, .3, 1), before = structuredClone(seeds);
  const result = generateCells(model, seeds, { size: 250 });
  assert.equal(result.cells.length, seeds.length);
  assert.ok(result.cells.length > 20);
  assert.deepEqual(seeds, before);
  assert.ok(result.cells.every(cell => cell.sourceComponentCount === 1));
  assert.ok(result.stats.coverageError < 1e-10);
  assert.ok(result.cells.every(cell => cell.area > 0));
});

test('a procedural curved surface remains covered after a manual centre move', () => {
  const model = wavyGrid();
  const seeds = generateSeeds(model, 250, .3, 1);
  const original = generateCells(model, seeds);
  assert.equal(original.cells.length, seeds.length);
  assert.ok(original.stats.coverageError < 1e-10);
  assert.ok(original.stats.yJunctionCount > 20);
  assert.ok(original.cells.every(c => c.loops.length > 0));
  seeds[0].position = [...model.vertices[100]];
  const moved = generateCells(model, seeds);
  assert.ok(moved.stats.coverageError < 1e-10);
  assert.ok(moved.cells.every(c => c.positions.every(p => p.every(Number.isFinite))));
});
