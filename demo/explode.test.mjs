import test from 'node:test';
import assert from 'node:assert/strict';
import { computeExplodedOffsets } from './explode.js';

const add = (a, b) => a.map((value, i) => value + b[i]);
const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
function rectangle(id, x, y, width = 100, height = 100, z = 0, normal = [0, 0, 1]) {
  const positions = [[x, y, z], [x + width, y, z], [x + width, y + height, z], [x, y + height, z]];
  return { id, positions: structuredClone(positions), flatPositions: positions, triangles: [[0, 1, 2], [0, 2, 3]], loops: [[0, 1, 2, 3]], plane: { origin: [x, y, z], normal } };
}
function centre(cell) { return cell.flatPositions[0].map((value, i) => (value + cell.flatPositions[2][i]) / 2); }
function radius(cell) { return Math.max(...cell.flatPositions.map(point => distance(point, centre(cell)))); }
function checkSeparated(cells, offsets, tolerance = 1e-6) {
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const a = cells[i], b = cells[j];
    assert.ok(distance(add(centre(a), offsets.get(a.id)), add(centre(b), offsets.get(b.id))) > radius(a) + radius(b) + tolerance,
      `Bounding spheres of ${a.id} and ${b.id} have positive clearance`);
  }
}

test('zero amount exactly preserves assembled positions without mutating inputs', () => {
  const cells = [rectangle(7, 0, 0), rectangle(3, 100, 0)], before = structuredClone(cells);
  assert.deepEqual([...computeExplodedOffsets({ cells, amount: 0 })], [[3, [0, 0, 0]], [7, [0, 0, 0]]]);
  computeExplodedOffsets({ cells, amount: 1 });
  assert.deepEqual(cells, before);
});

test('coplanar split panels separate instead of translating together along their normal', () => {
  const cells = [rectangle(0, 0, 0), rectangle(1, 100, 0)];
  const offsets = computeExplodedOffsets({ cells, amount: 1 });
  assert.notDeepEqual(offsets.get(0), offsets.get(1));
  assert.ok(offsets.get(0)[0] < 0 && offsets.get(1)[0] > 0);
  checkSeparated(cells, offsets);
});

test('unequal adjoining panels and a central small panel receive size-aware clearance', () => {
  const cells = [rectangle(0, 0, 0, 600, 160), rectangle(1, 600, 0, 20, 20), rectangle(2, 280, 160, 40, 40)];
  const offsets = computeExplodedOffsets({ cells, amount: 1 });
  checkSeparated(cells, offsets);
  assert.ok([...offsets.values()].every(vector => vector.every(Number.isFinite)));
});

test('symmetric neighbours and an exact centre panel remain distinct', () => {
  const cells = [rectangle(0, -150, -50), rectangle(1, 50, -50), rectangle(2, -50, -150), rectangle(3, -50, 50), rectangle(4, -50, -50)];
  checkSeparated(cells, computeExplodedOffsets({ cells, amount: 1, center: [0, 0, 0] }));
});

test('coincident panel centroids and opposing normals have deterministic separate placements', () => {
  const cells = Array.from({ length: 8 }, (_, id) => rectangle(id, -50, -50, 100, 100, 0, [0, 0, id % 2 ? -1 : 1]));
  const offsets = computeExplodedOffsets({ cells, amount: 1 });
  checkSeparated(cells, offsets);
  const reversed = cells.map(cell => ({ ...cell, plane: { ...cell.plane, normal: cell.plane.normal.map(value => -value) } }));
  assert.deepEqual(computeExplodedOffsets({ cells: reversed, amount: 1 }), offsets, 'arbitrary face winding does not flip exploded directions');
});

test('stacked faces separate with clearance at full amount', () => {
  const cells = Array.from({ length: 6 }, (_, id) => rectangle(id, -50, -50, 100, 100, id * 2));
  checkSeparated(cells, computeExplodedOffsets({ cells, amount: 1 }));
});

test('every amount is an exact fraction of one target, with monotonically growing displacement', () => {
  const cells = [rectangle(0, -50, -50), rectangle(2, 50, -50), rectangle(8, -50, -50)];
  const full = computeExplodedOffsets({ cells, amount: 1 });
  const previous = new Map(cells.map(cell => [cell.id, 0]));
  for (const amount of [0, .001, .1, .25, .5, .75, 1]) {
    const offsets = computeExplodedOffsets({ cells, amount });
    for (const [id, point] of offsets) {
      assert.deepEqual(point, amount === 0 ? [0, 0, 0] : full.get(id).map(value => value * amount));
      const size = Math.hypot(...point); assert.ok(size >= previous.get(id)); previous.set(id, size);
    }
  }
});

test('reordering panels and solids cannot change offsets or map order', () => {
  const cells = [rectangle(12, 0, 0), rectangle(3, 100, 0), rectangle(8, 0, 100)];
  const solids = cells.map(cell => ({ id: cell.id, positions: cell.flatPositions.flatMap(point => [add(point, [0, 0, -20]), add(point, [0, 0, 20])]) }));
  const expected = computeExplodedOffsets({ cells, solids, amount: 1 });
  assert.deepEqual(computeExplodedOffsets({ cells: [...cells].reverse(), solids: [...solids].reverse(), amount: 1 }), expected);
  assert.deepEqual(computeExplodedOffsets({ cells, solids, amount: 1 }), expected);
});

test('surface, flat and solid views use one stable arrangement with full stock envelopes', () => {
  const cells = [rectangle(0, 0, 0), rectangle(1, 100, 0)];
  cells[0].positions[0][2] = 30;
  const solids = cells.map(cell => ({ id: cell.id, positions: cell.flatPositions.flatMap(point => [add(point, [0, 0, -150]), add(point, [0, 0, 150])]) }));
  const expected = computeExplodedOffsets({ cells, solids, view: 'surface', amount: 1 });
  for (const view of ['flat', 'solid']) assert.deepEqual(computeExplodedOffsets({ cells, solids, view, amount: 1 }), expected);
  const stockRadius = Math.hypot(50, 50, 150);
  assert.ok(distance(add(centre(cells[0]), expected.get(0)), add(centre(cells[1]), expected.get(1))) > stockRadius * 2);
});

test('translation of the whole assembly does not change its relative explosion', () => {
  const cells = [rectangle(0, 0, 0), rectangle(1, 100, 0)], translation = [1000000, -2000000, 3000000];
  const expected = computeExplodedOffsets({ cells, amount: 1 });
  const moved = cells.map(cell => ({ ...cell, positions: cell.positions.map(point => add(point, translation)), flatPositions: cell.flatPositions.map(point => add(point, translation)) }));
  const actual = computeExplodedOffsets({ cells: moved, amount: 1 });
  for (const [id, point] of expected) assert.ok(distance(point, actual.get(id)) < 1e-8);
});

test('a denser triangulation of the same face does not move its explosion centre', () => {
  const cells = [rectangle(0, 0, 0), rectangle(1, 100, 0)], refined = structuredClone(cells);
  refined[0].flatPositions.push([50, 50, 0]);
  refined[0].triangles = [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]];
  const before = computeExplodedOffsets({ cells, amount: 1 }), after = computeExplodedOffsets({ cells: refined, amount: 1 });
  for (const [id, point] of before) assert.ok(distance(point, after.get(id)) < 1e-9);
});

test('a coplanar grid has positive panel-envelope spacing after bounded relaxation', () => {
  const cells = Array.from({ length: 36 }, (_, id) => rectangle(id, (id % 6) * 100, Math.floor(id / 6) * 100));
  checkSeparated(cells, computeExplodedOffsets({ cells, amount: 1 }));
});

test('source-only and unresolved geometry still produce finite offsets', () => {
  const cells = [rectangle(0, 0, 0), { id: 1, positions: [[NaN, 0, 0], [100, 0, 0], [100, 20, 0]], plane: { normal: [0, 0, 0] } }, { id: 2, positions: [], seed: [100, 0, 0] }];
  delete cells[0].flatPositions;
  assert.ok([...computeExplodedOffsets({ cells, amount: 1 }).values()].every(point => point.every(Number.isFinite)));
  assert.deepEqual([...computeExplodedOffsets({ cells: [], amount: 1 })], []);
});

test('invalid options and duplicate IDs are rejected explicitly', () => {
  const cell = rectangle(0, 0, 0);
  for (const amount of [-1, 2, NaN, Infinity]) assert.throws(() => computeExplodedOffsets({ cells: [cell], amount }), /amount/);
  assert.throws(() => computeExplodedOffsets({ cells: [cell, cell], amount: 1 }), /unique/);
  assert.throws(() => computeExplodedOffsets({ cells: [cell, null], amount: 1 }), /unique/);
  assert.throws(() => computeExplodedOffsets({ cells: [cell], amount: 1, center: [NaN, 0, 0] }), /centre/);
  assert.throws(() => computeExplodedOffsets({ cells: [cell], amount: 1, view: 'other' }), /view/);
});
