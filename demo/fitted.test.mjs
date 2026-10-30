import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCells, generateSeeds, generateCellLayout, createMergeGroups, rebuildSurfaceCells } from './geometry.js';
import { fitSharedPanels } from './fitted.js';
import { buildPanelSolids } from './solids.js';
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


test('stock-aware plane repair recovers thick panels without moving source seams or breaking shared flatness', () => {
  const model = wavyGrid(), source = generateCellLayout(model, generateSeeds(model, 250, .3, 1), { size: 250 });
  const before = JSON.stringify(source), options = { iterations: 300, thickness: 40 };
  const cold = fitSharedPanels(source, { ...options, repairBudget: 0 });
  const coldStock = buildPanelSolids(cold.cells, { thickness: 40, radius: 2 });
  assert.ok(coldStock.some(stock => !stock.valid), 'fixture must require thick-stock repair');
  const fitted = fitSharedPanels(source, options), stock = buildPanelSolids(fitted.cells, { thickness: 40, radius: 2 });
  assert.ok(stock.every(panel => panel.valid), stock.filter(panel => !panel.valid).map(panel => panel.issues).join('; '));
  assert.ok(fitted.stats.repair.applied);
  assert.equal(fitted.stats.repair.recoveredPanels, coldStock.filter(panel => !panel.valid).length);
  assert.ok(fitted.stats.repair.attempts <= 240);
  assert.ok(fitted.stats.repair.maxVertexMove <= fitted.stats.repair.maxVertexMoveLimit);
  assert.ok(fitted.stats.maxPlanarityError < 1e-6);
  assert.equal(JSON.stringify(source), before);
  checkShared(fitted);
  const repeated = fitSharedPanels(source, { ...options, previousResult: fitted });
  assert.deepEqual(repeated.sharedVertices, fitted.sharedVertices, 'cached history cannot select a poorer or different search path');
  assert.equal(repeated.stats.repair.warmStartAccepted, false);
});

test('valid stock skips repair and an exhausted budget retains the checked cold fit', () => {
  const model = wavyGrid({ amplitude: 80 }), source = generateCellLayout(model, generateSeeds(model, 250, .3, 1), { size: 250 });
  const fitted = fitSharedPanels(source, { thickness: 40 });
  assert.ok(buildPanelSolids(fitted.cells, { thickness: 40 }).every(stock => stock.valid));
  assert.equal(fitted.stats.repair.attempts, 1);
  assert.equal(fitted.stats.repair.applied, false);
  const difficult = wavyGrid(), difficultSource = generateCellLayout(difficult, generateSeeds(difficult, 250, .3, 1), { size: 250 });
  const base = fitSharedPanels(difficultSource), bounded = fitSharedPanels(difficultSource, { thickness: 40, repairBudget: 1 });
  assert.deepEqual(bounded.sharedVertices, base.sharedVertices);
  assert.equal(bounded.stats.repair.applied, false);
  assert.equal(bounded.stats.repair.attempts, 1);
});

function openCone(rotate = false) {
  const vertices = [], triangles = [], sides = 24;
  for (let level = 0; level <= 6; level++) for (let i = 0; i < sides; i++) {
    const angle = i * 2 * Math.PI / sides, radius = 250 - level * 22;
    const p = [radius * Math.cos(angle), radius * Math.sin(angle), level * 50];
    vertices.push(rotate ? [p[0] * .8 + p[2] * .6, p[1], p[2] * .8 - p[0] * .6] : p);
  }
  for (let level = 0; level < 6; level++) for (let i = 0; i < sides; i++) {
    const a = level * sides + i, b = level * sides + (i + 1) % sides;
    const c = (level + 1) * sides + (i + 1) % sides, d = (level + 1) * sides + i;
    triangles.push([a, b, c], [a, c, d]);
  }
  return { vertices, triangles };
}

for (const rotated of [false, true]) test(`planar open rims constrain fitted and thick geometry${rotated ? ' after rotation' : ''}`, () => {
  const model = openCone(rotated), source = generateCellLayout(model, generateSeeds(model, 100, .3, 7), { size: 100 });
  const before = JSON.stringify(source), fitted = fitSharedPanels(source, { iterations: 700, thickness: 20 });
  const solids = buildPanelSolids(fitted.cells, { thickness: 20, radius: 2 });
  const normal = rotated ? [.6, 0, .8] : [0, 0, 1], height = p => p.reduce((sum, value, i) => sum + value * normal[i], 0);
  assert.equal(fitted.stats.planarBoundaryCount, 2);
  assert.ok(fitted.stats.maxBoundaryDisplacement <= fitted.stats.boundaryDisplacementLimit + 1e-5);
  assert.ok(fitted.stats.maxPlanarityError < 1e-6);
  assert.ok(solids.filter(panel => panel.valid).length >= solids.length * .8);
  for (const panel of fitted.cells) for (const point of panel.flatPositions) assert.ok(height(point) >= -1e-5 && height(point) <= 300 + 1e-5);
  for (const panel of solids.filter(panel => panel.valid)) {
    for (const point of panel.positions) assert.ok(height(point) >= -1e-5 && height(point) <= 300 + 1e-5);
    assert.ok(panel.maxJointMismatch < 1e-7);
  }
  for (const panel of fitted.cells) panel.flatPositions.forEach((point, i) => {
    const rim = panel.boundaryPlanes[i];
    if (rim) assert.ok(Math.abs(point.reduce((sum, x, k) => sum + x * rim.normal[k], 0) - rim.d) < 1e-7);
  });
  checkShared(fitted);
  assert.equal(JSON.stringify(source), before);
});

test('a flat plate boundary remains free to extrude to full thickness', () => {
  const model = grid(4), source = generateCells(model, [{ id: 0, position: [100, 100, 0] }]);
  const fitted = fitSharedPanels(source, { thickness: 40 });
  assert.equal(fitted.stats.planarBoundaryCount, 0);
  assert.ok(fitted.cells.every(cell => cell.boundaryPlanes.every(plane => plane === null)));
  const [solid] = buildPanelSolids(fitted.cells, { thickness: 40, radius: 0 });
  assert.equal(solid.valid, true, solid.issues.join('; '));
  assert.equal(Math.min(...solid.positions.map(point => point[2])), -20);
  assert.equal(Math.max(...solid.positions.map(point => point[2])), 20);
});


test('source vertices inside a cell prevent a false support-halfspace assumption', () => {
  const model = openCone();
  // The two boundary loops remain at z=0 and z=300, while a source vertex
  // strictly inside the lower rim crosses its plane.
  model.vertices[3 * 24 + 4][2] = -10;
  const source = generateCellLayout(model, generateSeeds(model, 100, .3, 7), { size: 100 });
  const fitted = fitSharedPanels(source, { iterations: 0 });
  const bottom = fitted.cells.flatMap(cell => cell.boundaryPlanes).find(plane => plane && Math.abs(plane.d) < 1e-5);
  assert.ok(bottom, 'the actual boundary still defines a planar opening');
  assert.equal(bottom.support, 0, 'interior source triangles can legitimately occupy both sides');
  assert.ok(fitted.cells.every(cell => cell.supportPlanes.every(plane => Math.abs(plane.d) > 1e-5)));
});

test('near-rim interior junctions stay above the source support plane or remain explicitly unresolved', () => {
  const model = openCone();
  for (let i = 24; i < 48; i++) model.vertices[i][2] = 3;
  const source = generateCellLayout(model, generateSeeds(model, 100, .3, 7), { size: 100 });
  const cold = fitSharedPanels(source, { iterations: 700, thickness: 20, repairBudget: 0 });
  assert.ok(cold.stats.unstableVertexCount > 0, 'the fixture must include unresolved plane intersections');
  const coldStock = buildPanelSolids(cold.cells, { thickness: 20, radius: 2 });
  const fitted = fitSharedPanels(source, { iterations: 700, thickness: 20 });
  let nearRimInterior = 0;
  for (const panel of fitted.cells) panel.positions.forEach((sourcePoint, i) => {
    const point = panel.flatPositions[i];
    if (sourcePoint[2] > 0 && sourcePoint[2] < 10 && !panel.boundaryPlanes[i]) {
      nearRimInterior++;
      assert.ok(point[2] >= -1e-5, 'pinning only true boundary vertices must not leave an interior spike below the opening');
    }
    if (point[2] < -1e-5 || point[2] > 300 + 1e-5) {
      assert.equal(panel.valid, false);
      assert.ok(panel.issues.some(issue => /past a planar source opening/.test(issue)));
    }
  });
  assert.ok(nearRimInterior > 0);
  const solids = buildPanelSolids(fitted.cells, { thickness: 20, radius: 2 });
  assert.ok(solids.filter(panel => !panel.valid).length < coldStock.filter(panel => !panel.valid).length, 'unstable junctions must not prevent all bounded stock repair');
  assert.ok(coldStock.filter(panel => panel.valid).every(panel => solids.find(item => item.id === panel.id).valid), 'repair preserves every formerly valid stock panel');
  assert.ok(fitted.stats.repair.applied);
  assert.ok(fitted.stats.repair.maxVertexMove <= fitted.stats.repair.maxVertexMoveLimit);
  assert.ok(fitted.cells.filter(panel => panel.valid).every(panel => panel.maxPlanarityError < 1e-6));
  for (const panel of solids.filter(panel => panel.valid)) for (const point of panel.positions) assert.ok(point[2] >= -1e-5 && point[2] <= 300 + 1e-5);
});
