import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLaserPaths, exportLaserSVG, createLaserCoupon } from './laser-export.js';
import { buildLaserNet } from './laser-net.js';

function panel(id, x, y, width, height) {
  const loop = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  return { id, name: `P${String(id + 1).padStart(3, '0')}`, loops: [loop], triangles: [[loop[0], loop[1], loop[2]], [loop[0], loop[2], loop[3]]] };
}
function segments(loop, panelId = 0) { return loop.map((a, i) => ({ a, b: loop[(i + 1) % loop.length], panelId })); }
function wings(side = 'front') {
  const panels = [panel(0, 10, 20, 40, 40), panel(1, 50, 20, 40, 40)];
  return { index: 0, panels, cuts: segments([[10, 20], [50, 20], [90, 20], [90, 60], [50, 60], [10, 60]]),
    folds: [{ a: [50, 20], b: [50, 60], panelIds: [0, 1], seamId: 'E004', side, angleDegrees: 70 }],
    labels: [{ text: 'P001', position: [30, 40], height: 2.5 }, { text: 'P002', position: [70, 40], height: 2.5 }] };
}
const layer = (drawing, id) => drawing.layers.find(layer => layer.id === id);
const length = path => path.points.reduce((sum, p, i, a) => sum + (i ? Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) : 0), 0)
  + (path.closed ? Math.hypot(path.points[0][0] - path.points.at(-1)[0], path.points[0][1] - path.points.at(-1)[1]) : 0);
const bounds = paths => {
  const points = paths.flatMap(path => path.points);
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
};

test('SVG preserves millimetres, exact operation colours, stable labels and explicit metadata', () => {
  const svg = exportLaserSVG(wings(), { name: 'A < B & C', scale: 20, excludedPanelIds: [24, 49] });
  assert.match(svg, /width="400mm" height="400mm" viewBox="0 0 400 400"/);
  for (const color of ['#000000', '#0000FF', '#FF0000', '#B4B4B4']) assert.ok(svg.includes(`stroke="${color}"`));
  assert.match(svg, /<title>A &lt; B &amp; C<\/title>/);
  assert.match(svg, /&quot;scale&quot;:20/); assert.match(svg, /&quot;excludedPanelIds&quot;:\[24,49\]/);
  assert.match(svg, /data-label="P001"/); assert.match(svg, /data-label="P002"/);
  assert.doesNotMatch(svg, /<text\b|font-family|<image\b|<script\b/);
  assert.match(svg, /engrave the back first/); assert.match(svg, /engrave the front and cut last/);
});

test('retained fold has one closed outer cut contour and is never a cut', () => {
  const sheet = wings(), drawing = buildLaserPaths(sheet, { registration: false }), cuts = layer(drawing, 'CUT').paths;
  assert.equal(cuts.length, 1); assert.equal(cuts[0].closed, true); assert.equal(length(cuts[0]), 240);
  assert.equal(layer(drawing, 'GROOVE').paths.length, 1);
  assert.equal(length(layer(drawing, 'GROOVE').paths[0]), 40);
  assert.ok(cuts[0].points.every(([x, y]) => y === 20 || y === 60 || x === 10 || x === 90));
  // A shared seam accidentally marked as both operations must never reach the laser.
  sheet.cuts.push({ a: [50, 30], b: [50, 50] });
  assert.throws(() => exportLaserSVG(sheet), /also marked as a through cut/);
});

test('duplicate cuts are removed and hole contours remain closed exactly once', () => {
  const sheet = wings(); sheet.folds = [];
  const hole = [[20, 30], [20, 35], [25, 35], [25, 30]];
  sheet.cuts.push(...segments(hole), ...sheet.cuts.map(cut => ({ a: cut.b, b: cut.a })));
  const paths = layer(buildLaserPaths(sheet, { registration: false }), 'CUT').paths;
  assert.equal(paths.length, 2); assert.ok(paths.every(path => path.closed));
  assert.deepEqual(paths.map(length).sort((a, b) => a - b), [20, 240]);
});

test('open cut slits are not closed by inventing another cut', () => {
  const sheet = wings(); sheet.folds = []; sheet.cuts = [{ a: [20, 20], b: [30, 30] }, { a: [30, 30], b: [40, 20] }];
  const path = layer(buildLaserPaths(sheet, { registration: false }), 'CUT').paths[0];
  assert.equal(path.closed, false); assert.equal(path.points.length, 3);
  assert.equal(length(path), 2 * Math.sqrt(200));
});

test('back export mirrors around the complete sheet and contains only back grooves and registration', () => {
  const sheet = wings('back'), drawing = buildLaserPaths(sheet, { side: 'back', width: 300, height: 250 });
  assert.deepEqual(layer(drawing, 'GROOVE').paths[0].points, [[250, 20], [250, 60]]);
  assert.equal(layer(drawing, 'CUT'), undefined); assert.equal(layer(drawing, 'LABEL'), undefined);
  const svg = exportLaserSVG(sheet, { side: 'back', width: 300, height: 250 });
  assert.match(svg, /d="M250 230 L250 190"/);
  assert.doesNotMatch(svg, /id="CUT"|id="LABEL"|data-label=/);
  const front = buildLaserPaths(sheet, { width: 300, height: 250 });
  assert.equal(layer(front, 'GROOVE'), undefined);
  assert.deepEqual(bounds(layer(front, 'ALIGN').paths), [4, 4, 296, 246]);
  assert.deepEqual(bounds(layer(drawing, 'ALIGN').paths), [4, 4, 296, 246]);
});

test('registration uses four small reference circles, with no bed frame in the cut operation', () => {
  const drawing = buildLaserPaths(wings());
  const holes = layer(drawing, 'ALIGN').paths;
  assert.equal(holes.length, 4); assert.ok(holes.every(hole => hole.closed && hole.diameter === 2));
  assert.deepEqual(bounds(holes), [4, 4, 396, 396]);
  assert.deepEqual(bounds(layer(drawing, 'CUT').paths), [10, 20, 90, 60]);
});

test('a finite engraving width is a closed physical band, inset inside actual panels', () => {
  const drawing = buildLaserPaths(wings(), { engravingWidth: 2, registration: false });
  const band = layer(drawing, 'GROOVE').paths[0];
  assert.equal(band.closed, true); assert.equal(band.kind, 'groove-band'); assert.equal(band.endInset, 1);
  assert.deepEqual(bounds([band]), [49, 21, 51, 59]); assert.equal(layer(drawing, 'GROOVE').mode, 'Fill');
  const alias = buildLaserPaths(wings(), { hingeWidth: 2, registration: false });
  assert.deepEqual(layer(alias, 'GROOVE').paths, [band]);
});

test('groove bands cannot engrave across a hole or beyond the incident panel material', () => {
  const sheet = wings(), left = sheet.panels[0]; left.triangles = [];
  const xs = [10, 48, 49, 50], ys = [20, 35, 45, 60];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    if (i === 1 && j === 1) continue;
    left.triangles.push(...panel(0, xs[i], ys[j], xs[i + 1] - xs[i], ys[j + 1] - ys[j]).triangles);
  }
  assert.throws(() => buildLaserPaths(sheet, { engravingWidth: 6 }), /engraving band leaves the panels/);
  assert.doesNotThrow(() => buildLaserPaths(sheet, { engravingWidth: 0 }));
  const short = wings(); short.folds[0].b = [50, 30];
  assert.throws(() => buildLaserPaths(short, { engravingWidth: 20 }), /too short/);
});

test('labels and paired seam leaders remain real vector strokes and obey label visibility', () => {
  const sheet = wings(); sheet.labels = [
    { text: 'E013', position: [30, 40], seamId: 'E013', leader: [[10, 40], [25, 40]], angle: 30, height: 2 },
    { text: 'E013', position: [70, 40], seamId: 'E013', leader: [[90, 40], [75, 40]], angle: -30, height: 2 },
  ];
  const drawing = buildLaserPaths(sheet), marks = layer(drawing, 'LABEL').paths;
  assert.equal(marks.filter(path => path.kind === 'label-leader').length, 2);
  assert.ok(marks.filter(path => path.kind === 'label').length > 8);
  assert.ok(marks.every(path => path.text === 'E013'));
  assert.equal(layer(buildLaserPaths(sheet, { labels: false }), 'LABEL'), undefined);
  assert.deepEqual(sheet.labels[0].leader, [[10, 40], [25, 40]]);
});

test('coupon provides four test pieces, separate Line/Fill operations and a true 50 mm guide', () => {
  const sheet = createLaserCoupon(), drawing = buildLaserPaths(sheet);
  const cuts = layer(drawing, 'CUT').paths;
  assert.equal(cuts.length, 4); assert.ok(cuts.every(path => path.closed && length(path) === 224));
  assert.equal(layer(drawing, 'GROOVE').paths.length, 1); assert.equal(layer(drawing, 'GROOVE').mode, 'Line');
  const bands = layer(drawing, 'GROOVE_BANDS');
  assert.equal(bands.mode, 'Fill'); assert.equal(bands.color, '#00E0E0');
  assert.deepEqual(bands.paths.map(path => path.engravingWidth), [1, 2, 3]);
  const guides = layer(drawing, 'LABEL').paths.filter(path => path.kind === 'scale-guide');
  assert.equal(guides.length, 3); assert.equal(length(guides[0]), 50);
  assert.ok(sheet.labels.some(label => label.text === '50 MM'));
  const svg = exportLaserSVG(sheet);
  assert.match(svg, /width="400mm"/); assert.match(svg, /GROOVE BANDS/); assert.doesNotMatch(svg, /power=|speed=/i);
});

test('export never rescales already packed sheet paths or mutates the prepared sheet', () => {
  const sheet = wings(), before = structuredClone(sheet);
  const a = buildLaserPaths(sheet, { scale: 10 }), b = buildLaserPaths(sheet, { scale: 100 });
  assert.deepEqual(a.layers, b.layers); assert.deepEqual(sheet, before);
  assert.equal(exportLaserSVG(sheet, { scale: 10 }), exportLaserSVG(sheet, { scale: 10 }));
});

test('invalid dimensions, face, panels and non-finite toolpaths fail explicitly', () => {
  assert.throws(() => buildLaserPaths(wings(), { width: Infinity }), /Sheet width/);
  assert.throws(() => buildLaserPaths(wings(), { side: 'both' }), /front or back/);
  assert.throws(() => buildLaserPaths(wings(), { engravingWidth: -1 }), /Engraving width/);
  const invalid = wings(); invalid.panels[0].valid = false; assert.throws(() => exportLaserSVG(invalid), /invalid panels/);
  const missing = wings(); missing.folds[0].side = undefined; assert.throws(() => exportLaserSVG(missing), /explicit front\/back/);
  const bad = wings(); bad.cuts[0].a = [NaN, 20]; assert.throws(() => exportLaserSVG(bad), /non-finite/);
  const outside = wings(); outside.labels.push({ text: 'P100', position: [399, 399] }); assert.throws(() => exportLaserSVG(outside), /beyond/);
});


test('an internal duplicate cycle seam is cut once while its enclosing contour stays closed', () => {
  const sheet = wings(); sheet.folds = [];
  sheet.cuts.push({ a: [50, 20], b: [50, 60], panelId: 0 }, { a: [50, 60], b: [50, 20], panelId: 1 });
  const paths = layer(buildLaserPaths(sheet), 'CUT').paths;
  assert.equal(paths.length, 2);
  assert.deepEqual(paths.filter(path => path.closed).map(length), [240]);
  assert.deepEqual(paths.filter(path => !path.closed).map(length), [40]);
  const deduplicated = wings(); deduplicated.folds = [];
  deduplicated.cuts.push({ a: [50, 20], b: [50, 60], panelId: 0, panelIds: [0, 1] });
  assert.deepEqual(layer(buildLaserPaths(deduplicated), 'CUT').paths, paths, 'engine-deduplicated seams keep both owners');
});

test('actual unfolded right-angle panels export at scale with correct front/back separation', () => {
  const make = (id, flatPositions, normal, u) => ({ id, valid: true, flatPositions, loops: [[0, 1, 2, 3]], plane: { origin: flatPositions[0], normal, u } });
  const a = make(0, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]], [0, 0, 1], [1, 0, 0]);
  for (const sign of [1, -1]) {
    const b = make(1, [[100, 0, 0], [100, 0, sign * 100], [100, 100, sign * 100], [100, 100, 0]], [-sign, 0, 0], [0, 0, sign]);
    const net = buildLaserNet([a, b], { scale: 10 }), sheet = net.sheets[0];
    assert.equal(net.sheets.length, 1); assert.equal(sheet.folds.length, 1);
    const side = sign === 1 ? 'front' : 'back'; assert.equal(sheet.folds[0].side, side);
    const front = buildLaserPaths(sheet, { side: 'front' }), face = buildLaserPaths(sheet, { side, engravingWidth: 1 });
    assert.equal(layer(front, 'CUT').paths.length, 1); assert.equal(length(layer(front, 'CUT').paths[0]), 60);
    assert.equal(layer(face, 'GROOVE').paths[0].closed, true);
    assert.equal(layer(face, 'GROOVE').paths[0].engravingWidth, 1);
    assert.match(exportLaserSVG(sheet, { side, engravingWidth: 1 }), /width="400mm"/);
  }
});
