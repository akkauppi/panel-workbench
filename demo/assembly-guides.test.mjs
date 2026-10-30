import test from 'node:test';
import assert from 'node:assert/strict';
import { assemblyGuideCorners } from './assembly-guides.js';
import { generateCellLayout } from './geometry.js';
import { captureLayout, layoutRecipe, restoreLayout } from './layout.js';
import { transactLayout } from './layout-edit.js';
import { fitSharedPanels } from './fitted.js';
import { buildPanelSolids } from './solids.js';

function polygon(id, points, holes = []) {
  const positions = [], loops = [points, ...holes].map(ring => ring.map(point => { positions.push([...point]); return positions.length - 1; }));
  return { id, positions, flatPositions: structuredClone(positions), loops, sharedVertexIds: positions.map((_, i) => id * 1000 + i) };
}
const rectangle = (id = 0) => polygon(id, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]]);
const positions = entries => entries.map(entry => entry.position);
function mockSolid(cell, extra = {}) {
  return { id: cell.id, positions: [[0, 0, 20]], cornerAnchors: cell.sharedVertexIds.map((sharedVertexId, index) => ({ sharedVertexId,
    positive: cell.flatPositions[index].map((value, axis) => value + (axis === 2 ? 20 : 0)),
    negative: cell.flatPositions[index].map((value, axis) => value - (axis === 2 ? 20 : 0)),
  })), ...extra };
}

test('one rectangular cell has four fixed outline corners without editable junctions', () => {
  const cell = rectangle(), before = structuredClone(cell);
  for (const view of ['surface', 'flat']) {
    const result = assemblyGuideCorners({ cells: [cell], view });
    assert.deepEqual(positions(result.get(0)), cell.positions);
    assert.equal(new Set(result.get(0).map(corner => corner.id)).size, 4);
    result.get(0)[0].position[0] = 999;
    assert.deepEqual(cell, before, 'returned coordinates are copies');
  }
});

test('dense curved rims and straight-edge samples do not become connectors', () => {
  const circle = polygon(0, Array.from({ length: 120 }, (_, i) => [100 * Math.cos(i * Math.PI / 60), 100 * Math.sin(i * Math.PI / 60), 0]));
  assert.deepEqual(assemblyGuideCorners({ cells: [circle], view: 'surface' }).get(0), []);
  const sampled = polygon(1, [[0, 0, 0], [50, 0, 0], [100, 0, 0], [100, 50, 0], [100, 100, 0], [50, 100, 0], [0, 100, 0], [0, 50, 0], [0, 0, 0]]);
  assert.deepEqual(positions(assemblyGuideCorners({ cells: [sampled] }).get(1)), rectangle().positions);
  // Classify from the dense source, not from the fitter's four coarse chords.
  const fitted = polygon(0, [circle.positions[0], circle.positions[30], circle.positions[60], circle.positions[90]]);
  assert.deepEqual(assemblyGuideCorners({ cells: [fitted], surfaceCells: [circle] }).get(0), []);
});

test('sharp concave and hole corners survive without winding assumptions', () => {
  const outer = [[0, 0, 0], [100, 0, 0], [100, 100, 0], [60, 100, 0], [60, 60, 0], [0, 60, 0]];
  const hole = [[10, 10, 0], [10, 30, 0], [30, 30, 0], [30, 10, 0]];
  const cell = polygon(4, outer, [hole]);
  assert.deepEqual(positions(assemblyGuideCorners({ cells: [cell] }).get(4)), [...outer, ...hole]);
  const reversed = polygon(4, [...outer].reverse(), [[...hole].reverse()]);
  assert.deepEqual(new Set(positions(assemblyGuideCorners({ cells: [reversed] }).get(4)).map(JSON.stringify)), new Set([...outer, ...hole].map(JSON.stringify)));
});

test('the fixed-rim threshold retains a 30 degree turn and omits a shallower bend', () => {
  for (const degrees of [29, 30]) {
    const angle = degrees * Math.PI / 180, point = [100, 0, 0];
    const cell = polygon(0, [[0, 0, 0], point, [100 + 100 * Math.cos(angle), 100 * Math.sin(angle), 0], [0, 100, 0]]);
    const found = assemblyGuideCorners({ cells: [cell], view: 'surface' }).get(0).some(corner => JSON.stringify(corner.position) === JSON.stringify(point));
    assert.equal(found, degrees === 30);
  }
});

test('a logical junction remains a connector even on a straight outline, once per owner', () => {
  const left = polygon(7, [[0, 0, 0], [50, 0, 0], [50, 100, 0], [0, 100, 0]]);
  const right = polygon(9, [[50, 0, 0], [100, 0, 0], [100, 100, 0], [50, 100, 0]]);
  const corner = { id: 'vertex:v12', cells: [7, 9], position: [50, 0, 0] };
  const result = assemblyGuideCorners({ cells: [left, right], corners: [corner, corner], view: 'surface' });
  for (const id of [7, 9]) {
    assert.equal(result.get(id).filter(item => item.id === 'corner:vertex:v12').length, 1);
    assert.deepEqual(result.get(id)[0].position, [50, 0, 0]);
    assert.equal(result.get(id).length, 3, 'two fixed outer corners plus the explicit shared junction');
  }
});

test('mapping uses the corresponding source anchor and one stable solid side', () => {
  const source = rectangle(2), fitted = structuredClone(source);
  fitted.flatPositions = fitted.positions.map(point => point.map((value, axis) => value + (axis === 2 ? 3 : 0)));
  const solid = mockSolid(fitted), input = { cells: [fitted], surfaceCells: [source], solids: [solid] }, before = structuredClone(input);
  assert.deepEqual(positions(assemblyGuideCorners({ ...input, view: 'surface' }).get(2)), source.positions);
  assert.deepEqual(positions(assemblyGuideCorners({ ...input, view: 'flat' }).get(2)), fitted.flatPositions);
  assert.deepEqual(positions(assemblyGuideCorners({ ...input, view: 'solid' }).get(2)), solid.cornerAnchors.map(anchor => anchor.positive));
  const carved = { ...solid, carved: true, carvedSide: 'positive' };
  assert.deepEqual(positions(assemblyGuideCorners({ ...input, solids: [carved], view: 'solid' }).get(2)), solid.cornerAnchors.map(anchor => anchor.negative));
  assert.deepEqual(positions(assemblyGuideCorners({ ...input, solids: [{ ...carved, carvedSide: 'negative' }], view: 'solid' }).get(2)), solid.cornerAnchors.map(anchor => anchor.positive));
  assert.deepEqual(input, before);
});

test('missing and non-finite mappings are skipped without fabricated stock or thickness fallbacks', () => {
  const source = rectangle(), fitted = structuredClone(source), solid = mockSolid(fitted);
  const args = { cells: [fitted], surfaceCells: [source], view: 'solid' };
  assert.deepEqual(assemblyGuideCorners(args).get(0), []);
  assert.deepEqual(assemblyGuideCorners({ ...args, solids: [{ ...solid, positions: [] }] }).get(0), []);
  const broken = { ...solid, cornerAnchors: solid.cornerAnchors.slice(1).map((anchor, i) => i ? anchor : { ...anchor, positive: [NaN, 0, 0] }) };
  assert.equal(assemblyGuideCorners({ ...args, solids: [broken] }).get(0).length, 2);
  fitted.flatPositions[2] = [Infinity, 0, 0];
  assert.equal(assemblyGuideCorners({ ...args, solids: [broken] }).get(0).length, 1);
  const offSource = { id: 'unmatched', position: [50, 50, 0], cells: [0] };
  assert.ok(assemblyGuideCorners({ cells: [source], corners: [offSource, null, { id: 'bad', position: [NaN, 0, 0], cells: [0] }], view: 'surface' }).get(0).every(corner => corner.id.startsWith('rim:')));
});

test('pending source-only geometry supplies surface connectors and no flat or solid inventions', () => {
  const source = rectangle(); delete source.flatPositions; delete source.sharedVertexIds;
  assert.equal(assemblyGuideCorners({ cells: [source], view: 'surface' }).get(0).length, 4);
  for (const view of ['flat', 'solid', 'reference']) assert.deepEqual(assemblyGuideCorners({ cells: [source], view }).get(0), []);
});

test('a source corner absent from the fitted outline never snaps to another vertex', () => {
  const source = rectangle(), fitted = polygon(0, source.positions.slice(1));
  assert.equal(assemblyGuideCorners({ cells: [fitted], surfaceCells: [source], view: 'surface' }).get(0).length, 4);
  assert.deepEqual(positions(assemblyGuideCorners({ cells: [fitted], surfaceCells: [source], view: 'flat' }).get(0)), fitted.flatPositions);
});

test('a real split retains junction IDs after layout reload and maps to one anchor in each solid', () => {
  const model = { vertices: [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]], triangles: [[0, 1, 2], [0, 2, 3]] };
  const seeds = [{ id: 0, position: [50, 50, 0], weight: 1 }], source = generateCellLayout(model, seeds, { size: 100 });
  const layout = captureLayout(model, source, { recipe: layoutRecipe({ seeds, size: 100 }) });
  const divided = transactLayout(model, layout, { type: 'split-cell', cellId: 0, start: [50, -10, 0], end: [50, 110, 0] });
  const restored = restoreLayout(model, JSON.parse(JSON.stringify(divided.layout)));
  const before = assemblyGuideCorners({ cells: divided.surface.cells, corners: divided.surface.corners, view: 'surface' });
  assert.deepEqual(assemblyGuideCorners({ cells: restored.cells, corners: restored.corners, view: 'surface' }), before);
  assert.equal(restored.corners.length, 2);
  for (const cell of restored.cells) {
    assert.equal(before.get(cell.id).length, 4);
    assert.equal(before.get(cell.id).filter(corner => corner.id.startsWith('corner:')).length, 2);
  }
  const fitted = fitSharedPanels(restored, { iterations: 20, thickness: 10 }), solids = buildPanelSolids(fitted.cells, { thickness: 10, radius: 2 });
  assert.ok(solids.every(solid => solid.valid));
  const physical = assemblyGuideCorners({ cells: fitted.cells, surfaceCells: restored.cells, corners: fitted.corners, solids, view: 'solid' });
  for (const cell of fitted.cells) {
    assert.deepEqual(physical.get(cell.id).map(corner => corner.id), before.get(cell.id).map(corner => corner.id));
    assert.equal(physical.get(cell.id).length, 4, 'roundovers do not add connectors or a second cap');
    const solid = solids.find(part => part.id === cell.id);
    assert.ok(physical.get(cell.id).every(corner => solid.cornerAnchors.some(anchor => JSON.stringify(anchor.positive) === JSON.stringify(corner.position))));
  }
});
