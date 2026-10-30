import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelSolids } from './solids.js';
import { buildCarvedPanels, summarizeCarving } from './carving.js';

const makeCell = (id, x0, x1) => ({ id, flatPositions: [[x0, 0, 0], [x1, 0, 0], [x1, 100, 0], [x0, 100, 0]], loops: [[0, 1, 2, 3]], valid: true,
  plane: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] } });
function reference(height = (x, y) => 0) {
  const vertices = [], triangles = [], n = 8;
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push([x * 200 / n - 50, y * 200 / n - 50, height(x * 200 / n - 50, y * 200 / n - 50)]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const a = y * (n + 1) + x; triangles.push([a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]); }
  return { vertices, triangles };
}
function closed(s) {
  const edges = new Map();
  for (const t of s.triangles) for (let i = 0; i < 3; i++) { const a = t[i], b = t[(i + 1) % 3], key = [a, b].sort((x, y) => x - y).join(','); edges.set(key, (edges.get(key) || 0) + 1); }
  assert.ok([...edges.values()].every(n => n === 2));
}

test('carving changes the real inside cap and leaves outside vertices fixed', () => {
  const cells = [makeCell(0, 0, 100)], solids = buildPanelSolids(cells, { thickness: 40, radius: 0 });
  const result = buildCarvedPanels(solids, cells, reference(), { minimumThickness: 12 });
  assert.equal(result[0].valid, true, result[0].issues.join('; ')); closed(result[0]);
  assert.ok(Math.abs(result[0].minRemainingThickness - 20) < 1e-8);
  for (const id of solids[0].caps.positive.vertexIndices) assert.deepEqual(result[0].positions[id], solids[0].positions[id]);
  for (const id of result[0].caps.negative.vertexIndices) assert.ok(Math.abs(result[0].positions[id][2]) < 1e-8);
  assert.ok(result[0].triangles.length > solids[0].triangles.length);
  assert.equal(summarizeCarving(result).stockValid, true);
});

test('finished curved surface produces a nonplanar inside cap', () => {
  const cells = [makeCell(0, 0, 100)], solids = buildPanelSolids(cells, { thickness: 60, radius: 0 });
  const [carved] = buildCarvedPanels(solids, cells, reference((x, y) => -5 + (x - 50) ** 2 / 500), { minimumThickness: 12 });
  assert.equal(carved.valid, true, carved.issues.join('; ')); closed(carved);
  const z = carved.caps.negative.vertexIndices.map(i => carved.positions[i][2]);
  assert.ok(Math.max(...z) - Math.min(...z) > 1);
  assert.ok(carved.maxSurfaceError < 3);
});

test('insufficient stock is reported and cannot become exportable geometry', () => {
  const cells = [makeCell(0, 0, 100)], solids = buildPanelSolids(cells, { thickness: 40, radius: 0 });
  const [thin] = buildCarvedPanels(solids, cells, reference(() => 15), { minimumThickness: 12 });
  assert.equal(thin.valid, false); assert.equal(thin.stockValid, false);
  assert.ok(Math.abs(thin.minRemainingThickness - 5) < 1e-8);
  const [outside] = buildCarvedPanels(solids, cells, reference(() => -30), { minimumThickness: 12 });
  assert.equal(outside.valid, false); assert.ok(outside.stockOverrun > 9.9);
});

test('two adjacent panels keep identical carved seam vertices', () => {
  const cells = [makeCell(0, 0, 50), makeCell(1, 50, 100)], solids = buildPanelSolids(cells, { thickness: 40, radius: 0 });
  const carved = buildCarvedPanels(solids, cells, reference((x, y) => -3 + (y - 50) ** 2 / 800), { minimumThickness: 12 });
  for (const s of carved) { assert.equal(s.valid, true, s.issues.join('; ')); closed(s); }
  const seam = s => new Set(s.positions.filter(p => Math.abs(p[0] - 50) < 1e-7).map(p => p.map(v => v.toFixed(6)).join(',')));
  assert.deepEqual(seam(carved[0]), seam(carved[1]));
});

test('rounding the inside is rejected until its boundary can be carved consistently', () => {
  const cells = [makeCell(0, 0, 100)], solids = buildPanelSolids(cells, { thickness: 40, radius: 2 });
  const [carved] = buildCarvedPanels(solids, cells, reference());
  assert.equal(carved.valid, false); assert.match(carved.issues.join(' '), /Round only the outside/);
});

test('outside-only roundover remains compatible with real inside carving', () => {
  const cells = [makeCell(0, 0, 100)], solids = buildPanelSolids(cells, { thickness: 40, radius: 2, roundoverSide: 'positive' });
  const [carved] = buildCarvedPanels(solids, cells, reference());
  assert.equal(carved.valid, true, carved.issues.join('; ')); closed(carved);
  for (const id of solids[0].caps.positive.vertexIndices) assert.deepEqual(carved.positions[id], solids[0].positions[id]);
});
