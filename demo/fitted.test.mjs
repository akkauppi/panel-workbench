import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCells, generateSeeds, generateCellLayout, createMergeGroups, rebuildSurfaceCells } from './geometry.js';
import { fitSharedPanels } from './fitted.js';
import { wavyGrid, foldedOpening } from './test-fixtures.mjs';

function grid(n = 12, hole = false, curved = false) {
  const vertices = [], triangles = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push([x * 80, y * 80, curved ? (x - n / 2) ** 2 * 2 + (y - n / 2) ** 2 * 1.4 : 0]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (hole && x >= 4 && x < 7 && y >= 4 && y < 7) continue;
    const a = y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1;
    triangles.push([a, b, c], [a, c, d]);
  }
  return { vertices, triangles };
}

function checkShared(result) {
  const owners = new Map(); let comparisons = 0;
  for (const cell of result.cells) for (let i = 0; i < cell.sharedVertexIds.length; i++) {
    const id = cell.sharedVertexIds[i], point = cell.flatPositions[i];
    if (owners.has(id)) { assert.deepEqual(point, owners.get(id)); comparisons++; }
    else owners.set(id, point);
  }
  assert.ok(comparisons > 3);
}

test('neighbouring fitted panels share identical vertices while remaining flat', () => {
  const model = grid(12, false, true);
  const source = generateCells(model, generateSeeds(model, 280, .25, 1));
  const fitted = fitSharedPanels(source);
  checkShared(fitted);
  assert.equal(fitted.stats.maxSeamGap, 0);
  assert.ok(fitted.stats.maxPlanarityError < .25);
  assert.ok(fitted.stats.sharedVertexCount < fitted.stats.sourceBoundaryVertexCount / 2);
  for (const cell of fitted.cells.filter(c => c.valid)) for (const point of cell.flatPositions) {
    const residual = point.reduce((sum, x, k) => sum + (x - cell.plane.origin[k]) * cell.plane.normal[k], 0);
    assert.ok(Math.abs(residual) <= .25);
  }
});

test('boundary simplification preserves a window hole without filling it', () => {
  const model = grid(12, true);
  const source = generateCells(model, [{ id: 0, position: [100, 100, 0] }]);
  const fitted = fitSharedPanels(source, { straightness: 1 });
  const cell = fitted.cells[0];
  assert.equal(cell.loops.length, 2);
  assert.equal(cell.holeCount, 1);
  assert.ok(cell.valid, cell.issues.join(' '));
  assert.ok(Math.abs(cell.area - source.cells[0].area) < 1e-6);
  assert.ok(cell.positions.length < source.cells[0].positions.length);
});

test('a wavy surface keeps shared fitting bounded and reports unresolved outlines', () => {
  const model = wavyGrid({ amplitude: 30 });
  const source = generateCells(model, generateSeeds(model, 250, .3, 1), { size: 250 });
  const fitted = fitSharedPanels(source);
  checkShared(fitted);
  assert.equal(fitted.cells.length, source.cells.length);
  assert.ok(fitted.stats.maxReferenceDisplacement <= Math.sqrt(source.stats.totalArea / source.cells.length) * .75 + 1e-6);
  assert.ok(fitted.cells.filter(c => c.valid).length > fitted.cells.length * .8);
  assert.ok(fitted.stats.invalidCellCount > 0, 'the stress surface must exercise unresolved-outline reporting');
  assert.equal(fitted.stats.invalidCellCount, fitted.cells.filter(c => !c.valid).length);
  assert.ok(fitted.cells.every(c => c.flatPositions.every(p => p.every(Number.isFinite))));
  for (const cell of fitted.cells) if (cell.maxPlanarityError > .25) assert.equal(cell.valid, false);
});

test('wavy fitting coalesces converged planes and repairs reversed edges without relaxing flatness', () => {
  const model = wavyGrid(), seeds = generateSeeds(model, 250, .3, 1);
  const source = generateCellLayout(model, seeds, { size: 250 }), before = JSON.stringify(source);
  const fitted = fitSharedPanels(source, { straightness: .7, iterations: 300 });
  assert.equal(fitted.cells.length, source.cells.length);
  assert.ok(fitted.stats.refinedCoplanarGroupCount > 0);
  assert.ok(fitted.stats.constrainedSharedEdgeCount > 0);
  assert.ok(fitted.stats.constrainedCrossingCount > 0);
  assert.equal(fitted.stats.unstableVertexCount, 0);
  assert.ok(fitted.stats.maxPlanarityError < 1e-5, 'refinement must solve shared planes, not relax flatness validation');
  assert.equal(fitted.stats.invalidCellCount, 0, `unresolved: ${fitted.cells.filter(cell => !cell.valid).map(cell => cell.id)}`);
  assert.ok(fitted.stats.maxReferenceDisplacement <= Math.sqrt(source.stats.totalArea / source.cells.length) * .75 + 1e-6);
  assert.equal(JSON.stringify(source), before, 'fitting cannot change the authored source partition');
  checkShared(fitted);
});

test('coalescing planes cannot make disconnected source regions into one valid panel', () => {
  const model = { vertices: [[0, 0, 0], [100, 0, 0], [0, 100, 0], [300, 0, 0], [400, 0, 0], [300, 100, 0]], triangles: [[0, 1, 2], [3, 4, 5]] };
  const source = rebuildSurfaceCells(model, [{ id: 0, seed: [30, 30, 0], weight: 1, memberSeedIds: [0], positions: model.vertices, triangles: model.triangles }]);
  const fitted = fitSharedPanels(source);
  assert.equal(fitted.cells.length, 1);
  assert.equal(fitted.cells[0].sourceComponentCount, 2);
  assert.equal(fitted.cells[0].valid, false);
  assert.ok(fitted.cells[0].issues.some(issue => /separate source-surface pieces/.test(issue)));
});

test('flattening cannot silently collapse a connected surface opening into a line', () => {
  const model = foldedOpening();
  const source = rebuildSurfaceCells(model, [{ id: 0, seed: [0, -50, -5], weight: 1, memberSeedIds: [0], positions: model.vertices, triangles: model.triangles }]);
  assert.equal(source.cells[0].sourceComponentCount, 1);
  const fitted = fitSharedPanels(source, { straightness: 0, iterations: 300 });
  assert.equal(fitted.cells[0].loops.length, 2, 'the opening remains represented for inspection');
  assert.equal(fitted.cells[0].valid, false);
  assert.ok(fitted.cells[0].issues.some(issue => /collapsed outline/.test(issue)));
  assert.ok(fitted.cells[0].issues.some(issue => /touches or overlaps/.test(issue)));
});

test('curved-layout handles map to their exact fitted shared vertices, including perimeter corners', () => {
  const model = grid(12, false, true), seeds = generateSeeds(model, 280, .25, 1);
  const source = generateCellLayout(model, seeds, { size: 280 }), fitted = fitSharedPanels(source, { straightness: 1 });
  assert.ok(fitted.corners.some(corner => corner.boundary));
  assert.ok(fitted.corners.some(corner => !corner.boundary));
  let displaced = 0;
  for (const corner of fitted.corners) {
    assert.ok(Number.isInteger(corner.sharedVertexId), corner.id);
    assert.deepEqual(corner.flatPosition, fitted.sharedVertices[corner.sharedVertexId]);
    assert.deepEqual(corner.position, source.corners.find(item => item.id === corner.id).position);
    for (const owner of corner.cells) {
      const cell = fitted.cells.find(item => item.id === owner), local = cell.sharedVertexIds.indexOf(corner.sharedVertexId);
      assert.notEqual(local, -1);
      assert.deepEqual(corner.flatPosition, cell.flatPositions[local]);
    }
    if (Math.hypot(...corner.flatPosition.map((value, i) => value - corner.position[i])) > 1) displaced++;
  }
  assert.ok(displaced > 0, 'the displayed handle must follow fitting displacement');
});

test('merged corners retain exact display mapping and missing anchors never borrow a nearby vertex', () => {
  const model = grid(12, false, true), seeds = generateSeeds(model, 280, .25, 1);
  const base = generateCellLayout(model, seeds, { size: 280 });
  const group = createMergeGroups(base.cells, [], [base.cells[0].id, base.cells[0].neighbors[0]]);
  const source = generateCellLayout(model, seeds, { size: 280, mergeGroups: group });
  const original = source.corners[0];
  source.corners.push({ ...original, id: 'missing-source-anchor', position: original.position.map((value, i) => value + (i === 0 ? .001 : 0)) });
  const fitted = fitSharedPanels(source);
  assert.ok(fitted.corners.some(corner => corner.owners.some(members => members.length > 1)));
  for (const corner of fitted.corners.slice(0, -1)) assert.deepEqual(corner.flatPosition, fitted.sharedVertices[corner.sharedVertexId]);
  assert.equal(fitted.corners.at(-1).flatPosition, null);
  assert.equal(fitted.corners.at(-1).sharedVertexId, null);
});
