import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCells, mergeSurfaceCells, createMergeGroups } from './geometry.js';
import { fitSharedPanels } from './fitted.js';

function grid({ n = 10, hole = false, curved = false } = {}) {
  const vertices = [], triangles = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
    vertices.push([x * 100, y * 100, curved ? (x - n / 2) ** 2 * 3 + (y - n / 2) ** 2 * 2 : 0]);
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (hole && x >= 4 && x < 6 && y >= 4 && y < 6) continue;
    const a = y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1;
    triangles.push([a, b, c], [a, c, d]);
  }
  return { vertices, triangles };
}

const seeds = [200, 500, 800].map((x, id) => ({ id, position: [x, 500, 0], weight: 1 }));
const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

function boundaryEdges(cells) {
  const counts = new Map();
  for (const cell of cells) for (const ring of cell.loops) for (let i = 0; i < ring.length; i++) {
    const points = [cell.positions[ring[i]], cell.positions[ring[(i + 1) % ring.length]]];
    const key = points.map(p => p.map(x => Math.round(x * 1e5)).join(',')).sort().join('|');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].filter(([, count]) => count === 1).map(([key]) => key).sort();
}

test('merging keeps the selected union and unrelated geometry instead of redistributing a deleted seed', () => {
  const model = grid(), source = generateCells(model, seeds), snapshot = structuredClone(source);
  const merged = mergeSurfaceCells(source, [{ id: 0, members: [0, 1] }]);
  const union = merged.cells.find(cell => cell.id === 0), untouched = merged.cells.find(cell => cell.id === 2);
  assert.equal(merged.cells.length, 2);
  close(union.area, 650_000);
  close(untouched.area, 350_000);
  assert.deepEqual(union.memberSeedIds, [0, 1]);
  assert.deepEqual(untouched.memberSeedIds, [2]);
  for (const property of ['positions', 'triangles', 'loops', 'flatPositions', 'plane', 'outline2d']) {
    assert.deepEqual(untouched[property], source.cells[2][property], property);
  }
  assert.deepEqual(boundaryEdges([union]), boundaryEdges(source.cells.slice(0, 2)));
  assert.deepEqual(union.neighbors, [2]);
  assert.deepEqual(untouched.neighbors, [0]);
  close(merged.stats.totalArea, source.stats.totalArea);
  close(merged.stats.coverageError, 0);
  close(merged.stats.seamLength, source.stats.seamLength / 2);
  assert.equal(merged.stats.mergedCellCount, 1);
  assert.equal(merged.stats.emptyCellCount, 0);
  assert.deepEqual(source, snapshot, 'merging must not mutate its input');
  const deleted = generateCells(model, seeds.filter(seed => seed.id !== 1));
  close(deleted.cells.find(cell => cell.id === 2).area, 500_000);
});

test('merging around an opening preserves the hole and source area', () => {
  const source = generateCells(grid({ hole: true }), [seeds[0], seeds[2]]);
  const merged = mergeSurfaceCells(source, [{ id: 0, members: [0, 2] }]);
  const cell = merged.cells[0];
  assert.equal(cell.loops.length, 2);
  assert.equal(cell.holeCount, 1);
  assert.ok(cell.valid, cell.issues.join(' '));
  close(cell.area, 960_000);
  assert.deepEqual(boundaryEdges([cell]), boundaryEdges(source.cells));
  const fitted = fitSharedPanels(merged);
  assert.equal(fitted.cells[0].holeCount, 1);
  close(fitted.cells[0].area, cell.area);
});

test('repeated merges flatten original membership and select the smallest surviving ID', () => {
  const source = generateCells(grid(), seeds);
  const firstGroups = createMergeGroups(source.cells, [], new Set([2, 1]));
  assert.deepEqual(firstGroups, [{ id: 1, members: [1, 2] }]);
  const first = mergeSurfaceCells(source, firstGroups), snapshot = structuredClone(first);
  const secondGroups = createMergeGroups(first.cells, firstGroups, [1, 0]);
  assert.deepEqual(secondGroups, [{ id: 0, members: [0, 1, 2] }]);
  const second = mergeSurfaceCells(source, secondGroups);
  assert.equal(second.cells.length, 1);
  assert.deepEqual(second.cells[0].memberSeedIds, [0, 1, 2]);
  close(second.cells[0].area, 1_000_000);
  assert.equal(second.stats.seamLength, 0);
  assert.deepEqual(first, snapshot);
  assert.deepEqual(firstGroups, [{ id: 1, members: [1, 2] }]);
});

test('separate cells and corner-only contacts cannot be merged', () => {
  const source = generateCells(grid(), seeds);
  assert.throws(() => createMergeGroups(source.cells, [], [0, 2]), /connected by shared edges/);
  assert.throws(() => mergeSurfaceCells(source, [{ id: 0, members: [0, 2] }]), /connected by shared edges/);
  const model = {
    vertices: [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0], [200, 100, 0], [200, 200, 0], [100, 200, 0]],
    triangles: [[0, 1, 2], [0, 2, 3], [2, 4, 5], [2, 5, 6]],
  };
  const touching = generateCells(model, [{ id: 0, position: [0, 0, 0] }, { id: 1, position: [200, 200, 0] }]);
  assert.deepEqual(touching.cells.map(cell => cell.neighbors), [[], []]);
  assert.throws(() => createMergeGroups(touching.cells, [], [0, 1]), /corner-only/);
  assert.throws(() => mergeSurfaceCells(touching, [{ id: 0, members: [0, 1] }]), /corner-only/);
});

test('malformed groups, missing IDs, and stale selections fail clearly', () => {
  const source = generateCells(grid(), seeds);
  for (const groups of [null, {}, [{ id: 0, members: [0] }], [{ id: -1, members: [-1, 0] }],
    [{ id: 0, members: [0, 0] }], [{ id: 2, members: [0, 1] }], [{ id: 0, members: [0, 99] }],
    [{ id: 0, members: [0, 1] }, { id: 1, members: [1, 2] }]]) {
    assert.throws(() => mergeSurfaceCells(source, groups));
  }
  for (const ids of [[], [0], [0, 0], [0, 99]]) assert.throws(() => createMergeGroups(source.cells, [], ids));
  const groups = [{ id: 0, members: [0, 1] }], merged = mergeSurfaceCells(source, groups);
  assert.throws(() => createMergeGroups(merged.cells, [], [0, 2]), /no longer matches/);
  assert.throws(() => createMergeGroups(source.cells, groups, [0, 2]), /no longer matches/);
});

test('no merges preserve generated geometry and add singleton membership without mutating input', () => {
  const source = generateCells(grid({ curved: true }), seeds), snapshot = structuredClone(source);
  const result = mergeSurfaceCells(source);
  assert.deepEqual(result.cells.map(cell => cell.memberSeedIds), [[0], [1], [2]]);
  for (let i = 0; i < source.cells.length; i++) {
    const { memberSeedIds, ...cell } = result.cells[i];
    assert.deepEqual(cell, source.cells[i]);
  }
  assert.deepEqual(source, snapshot);
});

test('conflicting source winding is rejected while poor flat fits remain visible', () => {
  const conflicting = generateCells({
    vertices: [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]],
    triangles: [[0, 1, 2], [0, 3, 2]],
  }, [{ id: 0, position: [80, 20, 0] }, { id: 1, position: [20, 80, 0] }]);
  assert.throws(() => mergeSurfaceCells(conflicting, [{ id: 0, members: [0, 1] }]), /conflicting surface edges/);

  const vertices = [], triangles = [], curvedSeeds = [];
  for (const y of [0, 1000]) for (let i = 0; i <= 6; i++) {
    const angle = i * Math.PI / 4;
    vertices.push([100 * Math.cos(angle), y, 100 * Math.sin(angle)]);
  }
  for (let i = 0; i < 6; i++) {
    triangles.push([i, i + 1, i + 8], [i, i + 8, i + 7]);
    curvedSeeds.push({ id: i, position: [(vertices[i][0] + vertices[i + 1][0]) / 2, 500, (vertices[i][2] + vertices[i + 1][2]) / 2] });
  }
  const curved = generateCells({ vertices, triangles }, curvedSeeds);
  const merged = mergeSurfaceCells(curved, [{ id: 0, members: [0, 1, 2, 3, 4, 5] }]);
  assert.equal(merged.cells[0].valid, false);
  assert.ok(merged.cells[0].foldedTriangleCount > 0);
  close(merged.stats.totalArea, curved.stats.totalArea);
});

test('fitting a merged curved layout retains identical shared seam coordinates', () => {
  const model = grid({ curved: true });
  const source = generateCells(model, [
    { id: 0, position: model.vertices[2 * 11 + 2] }, { id: 1, position: model.vertices[2 * 11 + 8] },
    { id: 2, position: model.vertices[8 * 11 + 2] }, { id: 3, position: model.vertices[8 * 11 + 8] },
  ]);
  const pair = [source.cells[0].id, source.cells[0].neighbors[0]];
  const groups = createMergeGroups(source.cells, [], pair);
  const merged = mergeSurfaceCells(source, groups), fitted = fitSharedPanels(merged);
  const points = new Map(); let shared = 0;
  for (const cell of fitted.cells) cell.sharedVertexIds.forEach((id, i) => {
    if (points.has(id)) { assert.deepEqual(cell.flatPositions[i], points.get(id)); shared++; }
    else points.set(id, cell.flatPositions[i]);
  });
  assert.ok(shared > 0);
  assert.equal(fitted.cells.length, source.cells.length - 1);
  assert.equal(fitted.stats.maxSeamGap, 0);
  assert.deepEqual(fitted.cells.find(cell => cell.id === groups[0].id).memberSeedIds, groups[0].members);
  close(fitted.stats.coverageError, 0);
});
