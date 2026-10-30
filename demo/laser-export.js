/** Millimetre toolpaths for LightBurn. Colours select layers, not machine settings. */
const EPS = 1e-6;
const pointKey = p => p.map(v => Math.round(v / EPS)).join(',');
const edgeKey = (a, b) => [pointKey(a), pointKey(b)].sort().join('|');
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const area = points => Math.abs(points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p[0] * q[1] - p[1] * q[0]; }, 0)) / 2;
const fail = message => { throw new Error(`Laser export: ${message}`); };
const finitePoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const number = (value, name, minimum, maximum = 10000) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < minimum || n > maximum) fail(`${name} must be between ${minimum} and ${maximum} mm.`);
  return n;
};
const LAYERS = {
  cut: { id: 'CUT', name: 'CUT — through cut / Line', color: '#000000', mode: 'Line' },
  groove: { id: 'GROOVE', name: 'GROOVE', color: '#0000FF' },
  reverseGuide: { id: 'REVERSE_FOLD_GUIDES', name: 'REVERSE FOLD GUIDES — front mark / Line', color: '#00E000', mode: 'Line' },
  band: { id: 'GROOVE_BANDS', name: 'GROOVE BANDS — coupon / Fill', color: '#00E0E0', mode: 'Fill' },
  label: { id: 'LABEL', name: 'LABEL — light mark / Line', color: '#FF0000', mode: 'Line' },
  align: { id: 'ALIGN', name: 'ALIGN — reference only / output off', color: '#B4B4B4', mode: 'Line' },
};

// Compact single-stroke lettering avoids missing fonts and outlined double strokes.
const GLYPHS = {
  '0': '10 30 46 16 00 10|00 46', '1': '13 26 20|00 40', '2': '06 46 43 00 40',
  '3': '06 46 40 00|03 43', '4': '06 03 43|46 40', '5': '46 06 03 43 40 00',
  '6': '46 06 00 40 43 03', '7': '06 46 10', '8': '03 06 46 43 03 00 40 43', '9': '40 46 06 03 43',
  A: '00 26 40|12 32', B: '00 06 36 45 34 04|34 43 41 30 00', C: '46 06 00 40',
  D: '00 06 26 45 41 20 00', E: '46 06 00 40|03 33', F: '00 06 46|03 33',
  G: '46 06 00 40 43 23', H: '00 06|40 46|03 43', I: '06 46|26 20|00 40',
  J: '06 46 40 10 01', K: '00 06|03 46|03 40', L: '06 00 40', M: '00 06 23 46 40',
  N: '00 06 40 46', O: '10 30 41 45 36 16 05 01 10', P: '00 06 46 43 03',
  Q: '10 30 41 45 36 16 05 01 10|22 40', R: '00 06 46 43 03|23 40',
  S: '46 06 03 43 40 00', T: '06 46|26 20', U: '06 01 10 30 41 46',
  V: '06 20 46', W: '06 10 23 30 46', X: '06 40|00 46', Y: '06 23 46|23 20', Z: '06 46 00 40',
  '-': '03 43', '+': '03 43|20 26', '.': '00 10', '/': '00 46', ':': '12 22|14 24',
  '(': '36 15 11 30', ')': '16 35 31 10', '?': '06 46 43 23 22|20 21', '°': '15 16 26 25 15',
};
function strokeLabel(label) {
  const text = String(label.text ?? '').toUpperCase(), height = number(label.height ?? 2.5, 'Label height', .1, 20);
  if (!finitePoint(label.position)) fail('A label has no finite position.');
  const angle = Number(label.angle ?? 0) * Math.PI / 180;
  if (!Number.isFinite(angle)) fail('A label angle is not finite.');
  const unit = height / 6, width = Math.max(0, text.length * 6 - 2) * unit, cos = Math.cos(angle), sin = Math.sin(angle), paths = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') continue;
    const glyph = GLYPHS[text[i]];
    if (!glyph) fail(`The label “${text}” contains unsupported lettering.`);
    for (const stroke of glyph.split('|')) {
      const points = stroke.split(' ').map(pair => {
        const x = (i * 6 + Number(pair[0])) * unit - width / 2, y = Number(pair[1]) * unit - height / 2;
        return [label.position[0] + x * cos - y * sin, label.position[1] + x * sin + y * cos];
      });
      paths.push({ points, closed: false, kind: 'label', text, panelId: label.panelId, seamId: label.seamId });
    }
  }
  return paths;
}

/** Join cut segments without closing an open slit or duplicating shared cuts. */
function joinCuts(cuts) {
  const unique = new Map();
  for (const cut of cuts) {
    if (!finitePoint(cut.a) || !finitePoint(cut.b) || distance(cut.a, cut.b) < EPS) fail('A cut segment is empty or non-finite.');
    const key = edgeKey(cut.a, cut.b);
    if (!unique.has(key)) unique.set(key, { ...cut, a: [...cut.a], b: [...cut.b], key, owners: new Set() });
    for (const owner of cut.panelIds ?? (cut.panelId === undefined ? [] : [cut.panelId])) unique.get(key).owners.add(owner);
  }
  const edges = [...unique.values()];
  // A cycle seam can lie inside a coplanar net. Keep that single slit apart
  // from the enclosing boundary so closed cut contours stay closed.
  return [...traceCutEdges(edges.filter(edge => edge.owners.size < 2)), ...traceCutEdges(edges.filter(edge => edge.owners.size >= 2))];
}
function traceCutEdges(edges) {
  const links = new Map(), points = new Map(), used = new Set(), paths = [];
  edges.forEach((edge, index) => {
    for (const p of [edge.a, edge.b]) {
      const key = pointKey(p); points.set(key, p);
      if (!links.has(key)) links.set(key, []);
      links.get(key).push(index);
    }
  });
  function trace(start, first) {
    const path = [points.get(start)]; let current = start, index = first;
    while (index !== undefined && !used.has(index)) {
      used.add(index); const edge = edges[index], next = pointKey(edge.a) === current ? pointKey(edge.b) : pointKey(edge.a);
      path.push(points.get(next)); current = next;
      if (current === start) break;
      const available = links.get(current).filter(id => !used.has(id));
      if (!available.length || links.get(current).length !== 2) break;
      index = available[0];
    }
    const closed = current === start;
    if (closed) path.pop();
    paths.push({ points: path, closed, kind: 'cut' });
  }
  for (const [point, adjacent] of links) if (adjacent.length !== 2) for (const edge of adjacent) if (!used.has(edge)) trace(point, edge);
  for (let i = 0; i < edges.length; i++) if (!used.has(i)) trace(pointKey(edges[i].a), i);
  return paths;
}
function overlapLength(a, b, c, d) {
  const length = distance(a, b);
  if (!length || Math.abs(cross(a, b, c)) / length > EPS || Math.abs(cross(a, b, d)) / length > EPS) return 0;
  const direction = b.map((v, i) => (v - a[i]) / length), t = p => (p[0] - a[0]) * direction[0] + (p[1] - a[1]) * direction[1];
  return Math.max(0, Math.min(length, Math.max(t(c), t(d))) - Math.max(0, Math.min(t(c), t(d))));
}
function clippedArea(subject, triangle) {
  let polygon = subject;
  const orientation = cross(...triangle) >= 0 ? 1 : -1;
  for (let i = 0; i < 3 && polygon.length; i++) {
    const a = triangle[i], b = triangle[(i + 1) % 3], next = [];
    for (let j = 0; j < polygon.length; j++) {
      const p = polygon[j], q = polygon[(j + 1) % polygon.length], dp = cross(a, b, p) * orientation, dq = cross(a, b, q) * orientation;
      if (dp >= 0) next.push(p);
      if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); next.push(p.map((v, k) => v + (q[k] - v) * t)); }
    }
    polygon = next;
  }
  return polygon.length >= 3 ? area(polygon) : 0;
}
function groovePath(fold, width, panels) {
  if (!finitePoint(fold.a) || !finitePoint(fold.b)) fail('A fold segment is non-finite.');
  const length = distance(fold.a, fold.b);
  if (length < EPS) fail('A fold segment is empty.');
  if (width === 0) return { points: [[...fold.a], [...fold.b]], closed: false, kind: 'groove-line', seamId: fold.seamId };
  const triangles = (fold.panelIds || []).flatMap(id => panels.find(panel => panel.id === id)?.triangles || []);
  if (!triangles.length || triangles.some(triangle => triangle.length !== 3 || triangle.some(p => !finitePoint(p)))) fail(`Fold ${fold.seamId ?? ''} needs incident panel triangles to check its engraving width.`);
  const direction = fold.b.map((v, i) => (v - fold.a[i]) / length), normal = [-direction[1], direction[0]];
  const rectangle = inset => {
    const a = fold.a.map((v, i) => v + direction[i] * inset), b = fold.b.map((v, i) => v - direction[i] * inset);
    return [a.map((v, i) => v + normal[i] * width / 2), b.map((v, i) => v + normal[i] * width / 2), b.map((v, i) => v - normal[i] * width / 2), a.map((v, i) => v - normal[i] * width / 2)];
  };
  const covered = points => {
    const expected = area(points), actual = triangles.reduce((sum, triangle) => sum + clippedArea(points, triangle), 0);
    return expected > EPS && Math.abs(expected - actual) <= Math.max(1e-7, expected * 1e-7);
  };
  let inset = width / 2;
  if (inset >= length / 2) fail(`Fold ${fold.seamId ?? ''} is too short for a ${width} mm engraving band. Use a centreline or detach that seam.`);
  if (!covered(rectangle(inset))) {
    const limit = Math.min(length / 4, width * 2);
    if (limit < inset || !covered(rectangle(limit))) fail(`The ${width} mm engraving band leaves the panels at fold ${fold.seamId ?? ''}. Use a narrower band, a centreline, or detach that seam.`);
    let low = inset, high = limit;
    for (let i = 0; i < 24; i++) { const middle = (low + high) / 2; if (covered(rectangle(middle))) high = middle; else low = middle; }
    inset = high;
  }
  return { points: rectangle(inset), closed: true, kind: 'groove-band', seamId: fold.seamId, engravingWidth: width, endInset: inset };
}

/** Geometry consumed identically by the preview and SVG export; XY is y-up. */
export function buildLaserPaths(sheet, options = {}) {
  if (!sheet || !Array.isArray(sheet.panels) || !Array.isArray(sheet.cuts) || !Array.isArray(sheet.folds)) fail('A complete packed sheet is required.');
  if (sheet.panels.some(panel => panel.valid === false)) fail('Resolve invalid panels before exporting this sheet.');
  const width = number(options.width ?? sheet.width ?? 400, 'Sheet width', 20), height = number(options.height ?? sheet.height ?? 400, 'Sheet height', 20);
  const margin = number(options.margin ?? sheet.margin ?? 10, 'Margin', 4, Math.min(width, height) / 4);
  const engravingWidth = number(options.engravingWidth ?? options.hingeWidth ?? 0, 'Engraving width', 0, 20), side = options.side ?? 'front';
  if (!['front', 'back'].includes(side)) fail('Choose the front or back face.');
  const cutPaths = joinCuts(sheet.cuts);
  const layers = new Map(), add = (definition, paths) => {
    if (!paths.length) return;
    if (!layers.has(definition.id)) layers.set(definition.id, { ...definition, paths: [] });
    layers.get(definition.id).paths.push(...paths);
  };
  const foldKeys = new Set();
  for (const fold of sheet.folds) {
    if (!['front', 'back'].includes(fold.side)) fail('Every fold needs an explicit front/back engraving face.');
    if (!finitePoint(fold.a) || !finitePoint(fold.b)) fail('A fold segment is non-finite.');
    if (sheet.cuts.some(cut => overlapLength(fold.a, fold.b, cut.a, cut.b) > EPS)) fail(`Fold ${fold.seamId ?? ''} is also marked as a through cut.`);
    const key = edgeKey(fold.a, fold.b);
    if (foldKeys.has(key)) fail('A fold is repeated on this sheet.');
    foldKeys.add(key);
  }
  if (options.registration !== false) {
    const diameter = number(options.registrationDiameter ?? 2, 'Registration circle diameter', .5, margin * .8), radius = diameter / 2, offset = margin / 2;
    const paths = [[offset, offset], [width - offset, offset], [width - offset, height - offset], [offset, height - offset]].map(center => ({
      points: Array.from({ length: 48 }, (_, i) => { const angle = i / 48 * Math.PI * 2; return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]; }),
      closed: true, kind: 'registration', diameter,
    }));
    add(LAYERS.align, paths);
  }
  for (const fold of sheet.folds.filter(fold => fold.side === side)) {
    const bandWidth = number(fold.engravingWidth ?? engravingWidth, 'Engraving width', 0, 20), path = groovePath(fold, bandWidth, sheet.panels);
    const definition = sheet.coupon && bandWidth > 0 ? LAYERS.band : { ...LAYERS.groove, name: bandWidth > 0 ? 'GROOVE — closed bands / Fill' : 'GROOVE — centreline / Line', mode: bandWidth > 0 ? 'Fill' : 'Line' };
    add(definition, [path]);
  }
  if (side === 'front') {
    if (options.frontFoldGuides === true) add(LAYERS.reverseGuide, sheet.folds.filter(fold => fold.side === 'back').map(fold => ({
      ...groovePath(fold, 0, sheet.panels), kind: 'reverse-fold-guide',
    })));
    if (options.labels !== false) add(LAYERS.label, (sheet.labels || []).flatMap(label => [...(label.leader ? [{ points: label.leader.map(p => [...p]), closed: false, kind: 'label-leader', text: String(label.text), seamId: label.seamId }] : []), ...strokeLabel(label)]));
    add(LAYERS.label, (sheet.guides || []).map(guide => ({ points: guide.points.map(p => [...p]), closed: !!guide.closed, kind: 'scale-guide' })));
    add(LAYERS.cut, cutPaths);
  }
  for (const layer of layers.values()) for (const path of layer.paths) {
    if (path.points.length < 2 || path.points.some(p => !finitePoint(p) || p[0] < -EPS || p[1] < -EPS || p[0] > width + EPS || p[1] > height + EPS)) fail(`${layer.id} geometry extends beyond the ${width} × ${height} mm sheet.`);
    if (side === 'back') path.points = path.points.map(([x, y]) => [width - x, y]);
  }
  const result = [...layers.values()];
  return { width, height, side, layers: result, legend: result.map(({ id, name, color, mode }) => ({ id, name, color, mode })),
    instructions: 'Assign tested settings in LightBurn. Keep ALIGN output disabled unless intentionally making and testing a registration fixture. For two-sided work, verify physical registration and engrave the back first. Flip left-to-right about the vertical sheet axis using a calibrated jig, then engrave the front and cut last. Back artwork is mirrored; keep the stock located until final cutting. Centreline grooves use Line mode; closed bands use Fill. Groove bands are inset at their ends to stay inside the panels.'
      + (side === 'front' && options.frontFoldGuides === true ? ' Green reverse-fold guides are front-side centreline marks for folds assigned to the back face; they do not change the back-face engraving.' : '') };
}
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const format = value => String(Number(value.toFixed(6)));
export function exportLaserSVG(sheet, options = {}) {
  const drawing = buildLaserPaths(sheet, options), title = options.name ?? (sheet.coupon ? 'Folding test coupons' : `Laser sheet ${(sheet.index ?? 0) + 1}`);
  const pathData = path => path.points.map(([x, y], index) => `${index ? 'L' : 'M'}${format(x)} ${format(drawing.height - y)}`).join(' ') + (path.closed ? ' Z' : '');
  const metadata = { units: 'mm', side: drawing.side, scale: options.scale ?? sheet.scale ?? null, engravingWidth: options.engravingWidth ?? options.hingeWidth ?? 0,
    frontFoldGuides: options.frontFoldGuides === true, legend: drawing.legend, instructions: drawing.instructions, incomplete: !!options.excludedPanelIds?.length, excludedPanelIds: options.excludedPanelIds ?? [] };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${format(drawing.width)}mm" height="${format(drawing.height)}mm" viewBox="0 0 ${format(drawing.width)} ${format(drawing.height)}">\n<title>${xml(title)}</title>\n<desc>${xml(drawing.instructions)}</desc>\n<metadata>${xml(JSON.stringify(metadata))}</metadata>\n${drawing.layers.map(layer => `<g id="${layer.id}" inkscape:groupmode="layer" inkscape:label="${xml(layer.name)}" stroke="${layer.color}" fill="none" stroke-width="0.1" stroke-linecap="round" stroke-linejoin="round">\n${layer.paths.map(path => `<path data-kind="${path.kind}"${path.seamId ? ` data-seam="${xml(path.seamId)}"` : ''}${path.text ? ` data-label="${xml(path.text)}"` : ''} d="${pathData(path)}"/>`).join('\n')}\n</g>`).join('\n')}\n</svg>\n`;
}

/** Four physical test pieces. Widths are comparisons, never validated recipes. */
export function createLaserCoupon(options = {}) {
  const width = number(options.width ?? 400, 'Sheet width', 140), height = number(options.height ?? 400, 'Sheet height', 240), margin = number(options.margin ?? 10, 'Margin', 4, 20);
  const sheet = { index: 0, width, height, margin, scale: 1, coupon: true, panels: [], cuts: [], folds: [], labels: [], guides: [] };
  const rectangle = (id, x, y, w, h) => {
    const loop = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    return { id, name: `T${id + 1}`, loops: [loop], triangles: [[loop[0], loop[1], loop[2]], [loop[0], loop[2], loop[3]]] };
  };
  for (let i = 0; i < 4; i++) {
    const x = margin + 12, y = margin + 18 + i * 48, a = rectangle(i * 2, x, y, 40, 32), b = rectangle(i * 2 + 1, x + 40, y, 40, 32);
    sheet.panels.push(a, b);
    const perimeter = [[x, y], [x + 80, y], [x + 80, y + 32], [x, y + 32]];
    perimeter.forEach((point, j) => sheet.cuts.push({ a: point, b: perimeter[(j + 1) % 4], panelId: a.id }));
    sheet.folds.push({ a: [x + 40, y], b: [x + 40, y + 32], panelIds: [a.id, b.id], seamId: `TEST${i}`, side: 'front', angleDegrees: 90, engravingWidth: i });
    sheet.labels.push({ text: `${i} MM`, position: [x + 20, y + 16], height: 3 }, { text: 'TEST', position: [x + 60, y + 16], height: 3 });
  }
  const x = margin + 12, y = margin + 8;
  sheet.guides.push({ points: [[x, y], [x + 50, y]] }, { points: [[x, y - 2], [x, y + 2]] }, { points: [[x + 50, y - 2], [x + 50, y + 2]] });
  sheet.labels.push({ text: '50 MM', position: [x + 25, y + 5], height: 2.5 });
  return sheet;
}
