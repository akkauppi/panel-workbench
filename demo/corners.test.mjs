import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCells, generateCellLayout, mergeSurfaceCells, createMergeGroups } from './geometry.js';
import { fitSharedPanels } from './fitted.js';

function grid({ curved = false, hole = false } = {}) {
  const vertices = [], triangles = [];
  for (let y = 0; y <= 6; y++) for (let x = 0; x <= 6; x++) vertices.push([x * 200, y * 200, curved ? (x - 3) ** 2 * 12 + (y - 3) ** 2 * 8 : 0]);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
    if (hole && x === 2 && y === 2) continue;
    const a = y * 7 + x, b = a + 1, d = a + 7, c = d + 1;
    triangles.push([a, b, c], [a, c, d]);
  }
  return { vertices, triangles };
}
const seeds = [[250, 300, 0], [950, 300, 0], [600, 950, 0]].map((position, id) => ({ id, position, weight: 1 }));
const fourSeeds = [[250, 300, 0], [950, 250, 0], [350, 950, 0], [1000, 1000, 0]].map((position, id) => ({ id, position, weight: 1 }));
function edit(corner, target) { return { id: corner.id, anchor: [...corner.anchor], owners: structuredClone(corner.owners), target, radius: corner.radius }; }
function closePoint(actual, expected) { assert.ok(Math.hypot(...actual.map((value, i) => value - expected[i])) < .001, `${actual} differs from ${expected}`); }
function onGrid(model, x, y) {
  const ix = Math.min(5, Math.floor(x / 200)), iy = Math.min(5, Math.floor(y / 200));
  const fx = x / 200 - ix, fy = y / 200 - iy, a = iy * 7 + ix, b = a + 1, d = a + 7, c = d + 1;
  const z = fy <= fx ? model.vertices[a][2] * (1 - fx) + model.vertices[b][2] * (fx - fy) + model.vertices[c][2] * fy
    : model.vertices[a][2] * (1 - fy) + model.vertices[c][2] * fx + model.vertices[d][2] * (fy - fx);
  return [x, y, z];
}

test('corner metadata leaves the unedited partition exactly unchanged', () => {
  const model = grid(), expected = mergeSurfaceCells(generateCells(model, seeds, { size: 500 }));
  const { corners, ...result } = generateCellLayout(model, seeds, { size: 500 });
  assert.deepEqual(result, expected);
  assert.equal(corners.filter(c => !c.boundary).length, 1);
  assert.equal(corners.filter(c => c.boundary).length, 3);
  for (const corner of corners) {
    assert.ok(corner.id.startsWith('corner:'));
    assert.deepEqual(corner.position, corner.anchor);
    if (corner.boundary) assert.deepEqual(corner.boundaryPath[0], corner.boundaryPath.at(-1));
  }
});

test('moving a planar corner changes real source regions while preserving coverage and exact targets', () => {
  const model = grid(), before = generateCellLayout(model, seeds, { size: 500 });
  const corner = before.corners.find(c => !c.boundary), target = corner.position.map((x, k) => x + [30, 20, 0][k]);
  const cornerEdit = edit(corner, target);
  cornerEdit.radius *= 1.1;
  const snapshot = structuredClone(cornerEdit);
  const after = generateCellLayout(model, seeds, { size: 500, cornerEdits: [cornerEdit] });
  closePoint(after.corners.find(c => c.id === corner.id).position, target);
  assert.equal(after.corners.find(c => c.id === corner.id).radius, cornerEdit.radius);
  assert.notDeepEqual(after.cells.map(c => c.area), before.cells.map(c => c.area));
  assert.ok(after.stats.coverageError < 1e-10);
  assert.deepEqual(cornerEdit, snapshot);
  const fitted = fitSharedPanels(after), shared = new Map();
  for (const cell of fitted.cells) cell.sharedVertexIds.forEach((id, i) => {
    if (shared.has(id)) assert.deepEqual(cell.flatPositions[i], shared.get(id));
    else shared.set(id, cell.flatPositions[i]);
  });
  assert.equal(fitted.stats.maxSeamGap, 0);
  assert.deepEqual(fitted.corners.map(c => ({ id: c.id, position: c.position })), after.corners.map(c => ({ id: c.id, position: c.position })));
});

test('curved source targets use exact triangle interpolation, not fitted-plane coordinates', () => {
  const model = grid({ curved: true }), sites = seeds.map(s => ({ ...s, position: onGrid(model, s.position[0], s.position[1]) }));
  const before = generateCellLayout(model, sites, { size: 500 }), corner = before.corners.find(c => !c.boundary);
  const target = onGrid(model, corner.position[0] + 20, corner.position[1] + 15);
  const after = generateCellLayout(model, sites, { size: 500, cornerEdits: [edit(corner, target)] });
  closePoint(after.corners.find(c => c.id === corner.id).position, target);
  assert.ok(after.stats.coverageError < 1e-10);
  assert.throws(() => generateCellLayout(model, sites, { size: 500, cornerEdits: [edit(corner, [target[0], target[1], target[2] + 10])] }), /original mesh surface/);
});

test('boundary endpoints remain on their original boundary while overlapping targets stay fixed', () => {
  const model = grid(), before = generateCellLayout(model, seeds, { size: 500 });
  const inside = before.corners.find(c => !c.boundary), boundary = before.corners.find(c => c.boundary && c.position[1] === 0);
  const first = edit(inside, inside.position.map((x, k) => x + [30, 20, 0][k]));
  const second = edit(boundary, [boundary.position[0] + 20, 0, 0]);
  const after = generateCellLayout(model, seeds, { size: 500, cornerEdits: [first, second] });
  for (const item of [first, second]) closePoint(after.corners.find(c => c.id === item.id).position, item.target);
  assert.ok(after.stats.coverageError < 1e-10);
  assert.throws(() => generateCellLayout(model, seeds, { size: 500, cornerEdits: [edit(boundary, [boundary.position[0], 10, 0])] }), /original perimeter/);
});

test('merged corner owners can move and subsequent merges retain hidden constraints without changing their union', () => {
  const model = grid(), base = generateCellLayout(model, fourSeeds, { size: 500 });
  const mergeGroups = createMergeGroups(base.cells, [], [0, 1]);
  const merged = generateCellLayout(model, fourSeeds, { size: 500, mergeGroups }), corner = merged.corners.find(c => !c.boundary);
  assert.ok(corner.owners.some(group => group.length === 2));
  const item = edit(corner, corner.position.map((x, k) => x + [15, 15, 0][k]));
  const moved = generateCellLayout(model, fourSeeds, { size: 500, mergeGroups, cornerEdits: [item] });
  closePoint(moved.corners.find(c => c.id === item.id).position, item.target);
  const nextGroups = createMergeGroups(moved.cells, mergeGroups, [0, 2]);
  const expected = mergeSurfaceCells(generateCellLayout(model, fourSeeds, { size: 500, cornerEdits: [item] }), nextGroups);
  const after = generateCellLayout(model, fourSeeds, { size: 500, mergeGroups: nextGroups, cornerEdits: [item] });
  assert.equal(after.corners.some(c => c.id === item.id), false, 'the now-internal junction is hidden');
  assert.deepEqual(after.cells, expected.cells, 'merging must not reinterpret historical field corrections');
  assert.ok(after.stats.coverageError < 1e-10);
});

test('corner edits preserve an existing mesh opening', () => {
  const model = grid({ hole: true }), before = generateCellLayout(model, seeds, { size: 500 });
  const corner = before.corners.find(c => !c.boundary);
  const target = corner.position.map((x, k) => x + [10, 10, 0][k]);
  const after = generateCellLayout(model, seeds, { size: 500, cornerEdits: [edit(corner, target)] });
  assert.ok(after.stats.coverageError < 1e-10);
  assert.equal(after.stats.totalArea, before.stats.totalArea);
  for (const cell of after.cells) for (const tri of cell.triangles) {
    const x = tri.reduce((sum, i) => sum + cell.positions[i][0], 0) / 3, y = tri.reduce((sum, i) => sum + cell.positions[i][1], 0) / 3;
    assert.ok(!(x > 400 && x < 600 && y > 400 && y < 600));
  }
});

test('repeated owner pairs keep their boundary-loop identities and cannot exchange corners', () => {
  const model = grid({ hole: true }), sites = [{ id: 0, position: [200, 600, 0] }, { id: 1, position: [800, 600, 0] }];
  const before = generateCellLayout(model, sites, { size: 500 });
  assert.equal(before.corners.length, 4);
  const corner = before.corners.find(c => c.position[1] === 400), other = before.corners.find(c => c.position[1] === 600);
  const target = [corner.position[0] + 10, 400, 0];
  const after = generateCellLayout(model, sites, { size: 500, cornerEdits: [edit(corner, target)] });
  closePoint(after.corners.find(c => c.id === corner.id).position, target);
  assert.deepEqual(after.corners.map(c => c.id), before.corners.map(c => c.id));
  assert.throws(() => generateCellLayout(model, sites, { size: 500, cornerEdits: [edit(corner, [...other.position])] }), /exchange two corners/);
  assert.throws(() => generateCellLayout(model, sites, { size: 500, cornerEdits: [edit(corner, [corner.position[0], 0, 0])] }), /original perimeter/);
});

test('stale references, invalid owners, crossing moves and collapsed targets are rejected', () => {
  const model = grid(), before = generateCellLayout(model, seeds, { size: 500 });
  const corner = before.corners.find(c => !c.boundary), valid = edit(corner, [...corner.position]);
  for (const changed of [
    { ...valid, id: 'missing' }, { ...valid, anchor: [0, 0, 0] }, { ...valid, radius: 0 },
    { ...valid, owners: [[0], [1], [99]] }, { ...valid, owners: [[0], [1], [1, 2]] },
    { ...valid, target: [1200, 1200, 0] }, { ...valid, target: [NaN, 0, 0] },
  ]) assert.throws(() => generateCellLayout(model, seeds, { size: 500, cornerEdits: [changed] }));
  assert.throws(() => generateCellLayout(model, seeds, { size: 500, cornerEdits: [valid, valid] }), /no longer matches/);
  const boundary = before.corners.find(c => c.boundary && c.position[1] === 0);
  assert.throws(() => generateCellLayout(model, seeds, { size: 500, cornerEdits: [
    { ...edit(corner, [...boundary.position]), radius: 1200 }, edit(boundary, [...boundary.position]),
  ] }), /too close/);
});
