import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLaserNet, LaserNetError } from './laser-net.js';

const sub = (a, b) => a.map((x, i) => x - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = p => Math.hypot(...p);
const normalize = p => p.map(x => x / length(p));
const area = ring => Math.abs(ring.reduce((sum, a, i) => { const b = ring[(i + 1) % ring.length]; return sum + a[0] * b[1] - a[1] * b[0]; }, 0) / 2);
function panel(id, points, loops = [points.map((_, i) => i)]) {
  const u = normalize(sub(points[loops[0][1]], points[loops[0][0]])), normal = normalize(cross(u, sub(points[loops[0][2]], points[loops[0][0]])));
  return { id, valid: true, flatPositions: points, loops, plane: { origin: [...points[0]], normal, u } };
}
function square(id, x = 0, y = 0, size = 100) { return panel(id, [[x, y, 0], [x + size, y, 0], [x + size, y + size, 0], [x, y + size, 0]]); }
function folded(sign = 1) {
  return [square(0), panel(1, [[100, 0, 0], [100, 0, sign * 100], [100, 100, sign * 100], [100, 100, 0]])];
}
function checkBounds(result) {
  for (const sheet of result.sheets) {
    for (const point of [...sheet.panels.flatMap(p => p.loops.flat()), ...sheet.cuts.flatMap(c => [c.a, c.b]), ...sheet.folds.flatMap(f => [f.a, f.b])]) {
      assert.ok(point.every(Number.isFinite));
      assert.ok(point[0] >= result.margin - 1e-6 && point[0] <= result.width - result.margin + 1e-6, `x ${point[0]}`);
      assert.ok(point[1] >= result.margin - 1e-6 && point[1] <= result.height - result.margin + 1e-6, `y ${point[1]}`);
    }
  }
}
function checkRigid(result) {
  for (const output of result.panels) {
    const t = output.transform2D, plane = output.assemblyPlane;
    for (let ri = 0; ri < output.loops.length; ri++) output.loops[ri].forEach((point, i) => {
      const x = point[0] - t.x, y = point[1] - t.y, local = [(t.c * x + t.s * y) * result.scale, (-t.s * x + t.c * y) * result.scale];
      const reconstructed = plane.origin.map((v, k) => v + plane.u[k] * local[0] + plane.v[k] * local[1]);
      assert.ok(length(sub(reconstructed, output.sourceLoops[ri][i])) < 1e-6, 'inverse sheet transform reconstructs the original assembled point');
      const j = (i + 1) % output.loops[ri].length;
      assert.ok(Math.abs(length(sub(point, output.loops[ri][j])) * result.scale - length(sub(output.sourceLoops[ri][i], output.sourceLoops[ri][j]))) < 1e-6);
    });
  }
}
function overlapArea(a, b) {
  let result = a.slice(); const signed = b.reduce((sum, p, i) => { const q = b[(i + 1) % b.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0), clip = signed < 0 ? b.slice().reverse() : b;
  for (let i = 0; i < clip.length && result.length; i++) {
    const p = clip[i], q = clip[(i + 1) % clip.length], side = x => (q[0] - p[0]) * (x[1] - p[1]) - (q[1] - p[1]) * (x[0] - p[0]), next = [];
    for (let j = 0; j < result.length; j++) {
      const x = result[j], y = result[(j + 1) % result.length], sx = side(x), sy = side(y);
      if (sx >= 0) next.push(x);
      if ((sx >= 0) !== (sy >= 0)) { const t = sx / (sx - sy); next.push(x.map((v, k) => v + t * (y[k] - v))); }
    }
    result = next;
  }
  return result.length > 2 ? area(result) : 0;
}
function checkNoOverlap(result) {
  for (const sheet of result.sheets) for (let i = 0; i < sheet.panels.length; i++) for (let j = i + 1; j < sheet.panels.length; j++) {
    const a = sheet.panels[i], b = sheet.panels[j];
    assert.ok(a.triangles.reduce((sum, x) => sum + b.triangles.reduce((part, y) => part + overlapArea(x, y), 0), 0) < 1e-6, `${a.name} and ${b.name} overlap`);
  }
}

test('a rigid two-face fold preserves dimensions, reconstruction and front/back angles', () => {
  for (const sign of [1, -1]) {
    const source = folded(sign), before = structuredClone(source), net = buildLaserNet(source);
    assert.deepEqual(source, before);
    assert.equal(net.scale, 10); assert.equal(net.width, 400); assert.equal(net.height, 400);
    assert.equal(net.nets.length, 1); assert.equal(net.sheets.length, 1); assert.equal(net.folds.length, 1);
    assert.equal(net.folds[0].angleDegrees, 90); assert.equal(net.folds[0].side, sign === 1 ? 'front' : 'back');
    assert.equal(net.cuts.length, 6);
    assert.equal(length(sub(net.folds[0].a, net.folds[0].b)), 10);
    checkRigid(net); checkBounds(net); checkNoOverlap(net);
  }
});

test('opposite input normal signs are reconciled without changing fold-side meaning', () => {
  const source = folded(), expected = buildLaserNet(source);
  source[1].plane.normal = source[1].plane.normal.map(x => -x);
  const actual = buildLaserNet(source);
  assert.deepEqual(actual.folds, expected.folds);
  assert.equal(buildLaserNet(folded(), { flipDirection: true }).folds[0].side, 'back');
});

test('coplanar faces stay connected without an unnecessary engraving line', () => {
  const net = buildLaserNet([square(0), square(1, 100)]);
  assert.equal(net.nets.length, 1); assert.equal(net.folds.length, 0);
  assert.equal(net.seams[0].mode, 'fold'); assert.equal(net.seams[0].angleDegrees, 0);
  assert.equal(net.cuts.length, 6); checkNoOverlap(net);
});

test('closed shells use a spanning tree and paired labels for the remaining joins', () => {
  const p = [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0], [0, 0, 100], [100, 0, 100], [100, 100, 100], [0, 100, 100]];
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]].map((ids, i) => panel(i, ids.map(id => p[id])));
  const net = buildLaserNet(faces);
  assert.equal(net.panels.length, 6); assert.equal(net.seams.length, 12);
  assert.equal(net.seams.filter(s => s.mode === 'fold').length, 6 - net.nets.length);
  for (const seam of net.seams.filter(s => s.mode === 'cut')) {
    const labels = net.sheets.flatMap(sheet => sheet.labels).filter(label => label.seamId === seam.id);
    assert.equal(labels.length, 2); assert.equal(labels[0].text, labels[1].text);
  }
  checkRigid(net); checkBounds(net); checkNoOverlap(net);
  assert.deepEqual(buildLaserNet(faces.slice().reverse()), net, 'input order does not change naming or layout');
});

test('negative-curvature fan splits into non-overlapping nets instead of stretching', () => {
  const count = 8, ring = Array.from({ length: count }, (_, i) => [50 * Math.cos(i * 2 * Math.PI / count), 50 * Math.sin(i * 2 * Math.PI / count), i % 2 ? -60 : 60]);
  const faces = ring.map((p, i) => panel(i, [[0, 0, 0], p, ring[(i + 1) % count]]));
  const net = buildLaserNet(faces);
  assert.ok(net.nets.length > 1);
  assert.ok(net.seams.some(seam => seam.mode === 'cut' && seam.reason === 'overlap'));
  assert.ok(net.diagnostics.some(item => item.code === 'split-nets'));
  checkRigid(net); checkNoOverlap(net); checkBounds(net);
});

test('bed splitting preserves actual scale and creates further sheets', () => {
  const net = buildLaserNet([square(0, 0, 0, 3000), square(1, 3000, 0, 3000)]);
  assert.equal(net.nets.length, 2); assert.equal(net.sheets.length, 2);
  assert.equal(net.seams[0].mode, 'cut'); assert.equal(net.seams[0].reason, 'bed');
  assert.equal(net.seams[0].name, 'E001');
  assert.equal(net.sheets.flatMap(sheet => sheet.labels).filter(label => label.kind === 'join').length, 2);
  checkRigid(net); checkBounds(net);
});

test('oversize individual panels fail explicitly while a diagonal-fitting strip succeeds', () => {
  assert.throws(() => buildLaserNet([square(4, 0, 0, 4000)]), error => error instanceof LaserNetError && error.diagnostics[0].code === 'panel-too-large' && /P005/.test(error.message));
  const strip = panel(0, [[0, 0, 0], [5000, 0, 0], [5000, 100, 0], [0, 100, 0]]), net = buildLaserNet([strip]);
  checkBounds(net); checkRigid(net);
  assert.ok(Math.abs(net.panels[0].transform2D.s) > .5, 'the strip must rotate to fit');
});

test('openings remain empty material and retain their own cut outline', () => {
  const source = panel(0, [[0, 0, 0], [1000, 0, 0], [1000, 1000, 0], [0, 1000, 0], [400, 400, 0], [600, 400, 0], [600, 600, 0], [400, 600, 0]], [[0, 1, 2, 3], [4, 5, 6, 7]]);
  const net = buildLaserNet([source]), output = net.panels[0];
  assert.equal(output.loops.length, 2); assert.equal(net.cuts.length, 8);
  assert.ok(Math.abs(output.triangles.reduce((sum, tri) => sum + area(tri), 0) - 9600) < 1e-6);
  for (const tri of output.triangles) assert.ok(overlapArea(tri, output.loops[1]) < 1e-6);
  checkRigid(net); checkBounds(net);
});

test('split shared segments support T junctions and coincident cuts are emitted once', () => {
  const a = square(0, 0, 0, 200), b = square(1, 200, 0, 100), c = square(2, 200, 100, 100), net = buildLaserNet([a, b, c]);
  assert.equal(net.seams.length, 3); assert.equal(net.nets.length, 1);
  assert.ok(net.panels.find(p => p.id === 0).loops[0].length > 4, 'the long source edge receives the shared subdivision');
  const keys = net.cuts.map(cut => [cut.a, cut.b].map(p => p.map(x => x.toFixed(6)).join(',')).sort().join('|'));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(net.cuts.filter(cut => cut.panelIds.length === 2).length, 1, 'the cut cycle seam is shared, with one laser pass');
  checkNoOverlap(net); checkRigid(net);
});

test('forced cuts retain paired seam names and disconnected input is reported', () => {
  const initial = buildLaserNet(folded()), net = buildLaserNet(folded(), { forcedCuts: [initial.seams[0].id] });
  assert.equal(net.nets.length, 2); assert.equal(net.folds.length, 0); assert.equal(net.seams[0].reason, 'forced');
  assert.equal(net.sheets.flatMap(sheet => sheet.labels).filter(label => label.text === 'E001').length, 2);
  const disconnected = buildLaserNet([square(0), square(2, 1000)]);
  assert.equal(disconnected.componentCount, 2); assert.ok(disconnected.diagnostics.some(item => item.code === 'disconnected'));
  checkNoOverlap(net); checkBounds(net);
});

test('invalid input is strict by default and partial exports identify every omitted panel', () => {
  const source = [square(0), { ...square(1, 100), valid: false }];
  assert.throws(() => buildLaserNet(source), /P002 is unresolved/);
  const partial = buildLaserNet(source, { allowPartial: true });
  assert.deepEqual(partial.excludedPanelIds, [1]); assert.equal(partial.panels.length, 1);
  assert.ok(partial.diagnostics.some(item => item.code === 'partial'));
  const malformed = square(2); malformed.flatPositions[2][2] = 1;
  assert.throws(() => buildLaserNet([malformed], { allowPartial: true }), /not planar enough/);
  assert.throws(() => buildLaserNet([], { allowPartial: true }), /at least one/);
  assert.throws(() => buildLaserNet([square(0)], { scale: 0 }), /positive model scale/);
});

test('nonmanifold adjacency is rejected rather than assigned a misleading hinge', () => {
  const faces = [panel(0, [[0, 0, 0], [100, 0, 0], [0, 100, 0]]), panel(1, [[100, 0, 0], [0, 0, 0], [0, 0, 100]]), panel(2, [[0, 0, 0], [100, 0, 0], [0, -100, 0]])];
  assert.throws(() => buildLaserNet(faces), error => error instanceof LaserNetError && error.diagnostics[0].code === 'nonmanifold');
});


test('material overlap checks allow a hinged face to occupy an opening in the flat template', () => {
  const frame = panel(0, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0], [30, 30, 0], [70, 30, 0], [70, 70, 0], [30, 70, 0]], [[0, 1, 2, 3], [4, 5, 6, 7]]);
  const flap = panel(1, [[30, 30, 0], [30, 30, 40], [30, 70, 40], [30, 70, 0]]), net = buildLaserNet([frame, flap]);
  assert.equal(net.nets.length, 1);
  assert.equal(net.folds.length, 1);
  checkNoOverlap(net); checkRigid(net); checkBounds(net);
  const outer = net.panels.find(p => p.id === 0), inner = net.panels.find(p => p.id === 1);
  assert.ok(Math.abs(inner.triangles.reduce((sum, tri) => sum + overlapArea(tri, outer.loops[1]), 0) - 16) < 1e-6, 'the flap fills the hole only in the unfolded sheet');
});

test('a subdivided straight seam becomes one continuous hinge', () => {
  const a = square(0), b = panel(1, [[100, 0, 0], [200, 0, 0], [200, 100, 0], [100, 100, 0], [100, 50, 0]]), net = buildLaserNet([a, b]);
  assert.equal(net.seams.length, 1);
  assert.equal(net.seams[0].length, 100);
  assert.equal(net.nets.length, 1);
  assert.equal(net.cuts.length, 6);
  checkRigid(net);
});


test('explicitly distinct shared corner IDs keep coincident sheets disconnected', () => {
  const a = square(0), b = square(1);
  a.sharedVertexIds = [0, 1, 2, 3]; b.sharedVertexIds = [4, 5, 6, 7];
  const net = buildLaserNet([a, b]);
  assert.equal(net.componentCount, 2); assert.equal(net.seams.length, 0); assert.equal(net.nets.length, 2);
  checkNoOverlap(net); checkRigid(net);
});

for (const forceAll of [false, true]) test(`join label leaders stay in their own material around holes${forceAll ? ' with forced cuts' : ''}`, () => {
  const frame = panel(0, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0], [1, 1, 0], [99, 1, 0], [99, 99, 0], [1, 99, 0]], [[0, 1, 2, 3], [4, 5, 6, 7]]), fill = square(1, 1, 1, 98);
  const initial = buildLaserNet([frame, fill], { scale: 1 });
  const net = forceAll ? buildLaserNet([frame, fill], { scale: 1, forcedCuts: initial.seams.map(seam => seam.id) }) : initial;
  const contains = (point, triangle) => {
    const signs = triangle.map((a, i) => { const b = triangle[(i + 1) % triangle.length]; return (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]); });
    return signs.every(value => value >= -1e-7) || signs.every(value => value <= 1e-7);
  };
  let checked = 0;
  for (const sheet of net.sheets) for (const label of sheet.labels.filter(label => label.leader)) {
    const owner = sheet.panels.find(p => p.id === label.panelId);
    for (let i = 0; i + 1 < label.leader.length; i++) for (let sample = 0; sample <= 100; sample++) {
      const point = label.leader[i].map((x, k) => x + sample / 100 * (label.leader[i + 1][k] - x));
      assert.ok(owner.triangles.some(triangle => contains(point, triangle)), `${label.text} must not engrave through an opening or another panel`);
      checked++;
    }
  }
  assert.ok(checked > 100, 'the fixture must require routed leaders');
});

test('labels that cannot fit the exporter minimum fail before producing an unusable sheet', () => {
  assert.throws(() => buildLaserNet([square(0, 0, 0, .01)], { scale: 1 }), error => error instanceof LaserNetError && error.diagnostics[0].code === 'label-too-small' && /Decrease the scale denominator/.test(error.message));
  const net = buildLaserNet([square(0, 0, 0, 1)], { scale: 1 });
  assert.ok(net.sheets.flatMap(sheet => sheet.labels).every(label => label.height >= .1));
});
