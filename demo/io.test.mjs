import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOBJ, exportCellsOBJ, exportCellsDXF } from './io.js';

function meshAreaXY(model) {
  return model.triangles.reduce((sum, triangle) => {
    const [a, b, c] = triangle.map(i => model.vertices[i]);
    return sum + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }, 0);
}

test('concave polygon triangulation preserves area and its notch', () => {
  const model = parseOBJ('v 0 0 0\nv 3 0 0\nv 3 3 0\nv 2 3 0\nv 2 1 0\nv 1 1 0\nv 1 3 0\nv 0 3 0\nf 1 2 3 4 5 6 7 8');
  assert.equal(model.triangles.length, 6);
  assert.equal(meshAreaXY(model), 7);
  for (const triangle of model.triangles) {
    const center = triangle.map(i => model.vertices[i]).reduce((s, p) => [s[0] + p[0] / 3, s[1] + p[1] / 3], [0, 0]);
    assert.ok(!(center[0] > 1 && center[0] < 2 && center[1] > 1));
  }
});

test('negative references, normals and clockwise n-gons are supported', () => {
  const model = parseOBJ('o Sample\nv 0 0 0\nv 0 2 0\nv 2 2 0\nv 2 0 0\nvn 0 0 1\nf -4//1 -3//1 -2//1 -1//1 # square');
  assert.equal(model.name, 'Sample');
  assert.equal(meshAreaXY(model), 4);
  assert.equal(model.triangles.length, 2);
});

test('invalid coordinates, missing faces and bad indices are rejected', () => {
  assert.throws(() => parseOBJ('v NaN 0 0\nf 1 2 3'), /coordinate/);
  assert.throws(() => parseOBJ('v 0 0 0'), /no surface faces/);
  assert.throws(() => parseOBJ('v 0 0 0\nf 1 2 3'), /missing vertex/);
  assert.throws(() => parseOBJ('v 0 0 0\nf 0 1 2'), /index/);
});

test('a generated curved OBJ sheet preserves its open perimeter and window', () => {
  const lines = ['o Curved sheet with window'], width = 20, height = 12;
  for (let y = 0; y <= height; y++) for (let x = 0; x <= width; x++) lines.push(`v ${x * 100} ${y * 100} ${50 * Math.sin(x / 4)}`);
  let faceCount = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (x >= 8 && x < 12 && y >= 4 && y < 7) continue;
    const a = y * (width + 1) + x + 1;
    lines.push(`f ${a} ${a + 1} ${a + width + 2} ${a + width + 1}`);
    faceCount++;
  }
  const model = parseOBJ(lines.join('\n'));
  assert.equal(model.vertices.length, (width + 1) * (height + 1));
  assert.equal(model.originalFaceCount, faceCount);
  assert.equal(model.triangles.length, faceCount * 2);
  assert.equal(model.skippedFaces, 0);
  assert.equal(meshAreaXY(model), faceCount * 10000);
  for (const triangle of model.triangles) {
    const center = [0, 1].map(k => triangle.reduce((sum, id) => sum + model.vertices[id][k], 0) / 3);
    assert.ok(!(center[0] > 800 && center[0] < 1200 && center[1] > 400 && center[1] < 700));
  }
});

const cell = {
  id: 0,
  positions: [[0, 0, 1], [10, 0, 2], [10, 10, 1], [0, 10, 2]],
  flatPositions: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
  triangles: [[0, 1, 2], [0, 2, 3]],
  plane: { normal: [0, 0, 1] },
  outline2d: [[[0, 0], [10, 0], [10, 10], [0, 10]], [[3, 3], [3, 7], [7, 7], [7, 3]]]
};

test('OBJ export uses actual flat positions and optional preview explosion', () => {
  const flat = parseOBJ(exportCellsOBJ([cell]));
  assert.ok(flat.vertices.every(p => p[2] === 0));
  const exploded = parseOBJ(exportCellsOBJ([cell], { explode: 15 }));
  assert.ok(exploded.vertices.every(p => p[2] === 15));
  const surface = parseOBJ(exportCellsOBJ([cell], { flat: false }));
  assert.deepEqual(surface.vertices, cell.positions);
});

test('OBJ preview offsets translate each panel by ID without changing geometry or doubling explode', () => {
  const other = { ...structuredClone(cell), id: 8, plane: { normal: [0, 1, 0] },
    positions: cell.positions.map(p => [p[0] + 100, p[1], p[2]]),
    flatPositions: cell.flatPositions.map(p => [p[0] + 100, p[1], p[2]]) };
  const cells = [cell, other], before = structuredClone(cells);
  const offsets = new Map([[0, [30, -4, 12]], [8, [-10, 2, 6]]]);
  for (const flat of [true, false]) {
    const exported = exportCellsOBJ(cells, { flat, offsets, explode: 999 });
    const parsed = parseOBJ(exported);
    assert.deepEqual(parsed.vertices, cells.flatMap(panel => (flat ? panel.flatPositions : panel.positions)
      .map(p => p.map((v, axis) => v + offsets.get(panel.id)[axis]))));
    assert.deepEqual(parsed.triangles, [[0,1,2],[0,2,3],[4,5,6],[4,6,7]]);
    assert.match(exported, /o P001\ng P001/); assert.match(exported, /o P009\ng P009/);
    assert.deepEqual(parseOBJ(exportCellsOBJ([other], { flat, offsets })).vertices, parsed.vertices.slice(4), 'Selected export uses the same panel offset as full export.');
  }
  assert.deepEqual(cells, before);
  assert.deepEqual(offsets.get(0), [30, -4, 12]);
});

test('OBJ unmapped panels retain legacy explode and zero offsets preserve assembled output', () => {
  const other = { ...structuredClone(cell), id: 8, plane: { normal: [0, 1, 0] } };
  assert.equal(exportCellsOBJ([cell]), exportCellsOBJ([cell], { offsets: new Map([[0, [0,0,0]]]) }));
  assert.equal(exportCellsOBJ([cell], { explode: 15 }), exportCellsOBJ([cell], { explode: 15, offsets: new Map() }));
  const exported = parseOBJ(exportCellsOBJ([cell, other], { explode: 15, offsets: new Map([[0, [0,0,0]]]) }));
  assert.deepEqual(exported.vertices.slice(0, 4), cell.flatPositions);
  assert.deepEqual(exported.vertices.slice(4), other.flatPositions.map(p => [p[0], p[1] + 15, p[2]]));
});

test('OBJ rejects malformed preview offsets before writing invalid coordinates', () => {
  assert.throws(() => exportCellsOBJ([cell], { offsets: { 0: [1,2,3] } }), /offsets must be a Map/);
  for (const offset of [null, undefined, [1,2], [1,2,3,4], [1,NaN,3], [1,Infinity,3], ['1',2,3]]) {
    assert.throws(() => exportCellsOBJ([cell], { offsets: new Map([[0, offset]]) }), /invalid export offset/);
  }
});

test('DXF contains millimetre units and closed outer and inner rings', () => {
  const dxf = exportCellsDXF([cell]);
  assert.match(dxf, /\$INSUNITS\r\n70\r\n4\r\n/);
  assert.equal((dxf.match(/\r\nLWPOLYLINE\r\n/g) || []).length, 2);
  assert.equal((dxf.match(/90\r\n4\r\n70\r\n1\r\n/g) || []).length, 2);
  assert.match(dxf, /P001/);
  assert.match(dxf, /not optimized sheet nesting/);
  assert.ok(dxf.endsWith('0\r\nEOF\r\n'));
});
