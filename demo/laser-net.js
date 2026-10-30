import { ShapeUtils, Vector2 } from './vendor/three.core.js';

// Geometry only: no kerf, plywood bending or laser settings are inferred.
// Sheet coordinates are millimetres, y-up. Front is the coherent positive
// face normal; a bend towards that face receives a front engraving line.
const EPS = 1e-7;
const add = (a, b) => a.map((x, i) => x + b[i]);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const mul = (a, s) => a.map(x => x * s);
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(...a);
const unit = a => { const n = length(a); if (n < 1e-12) throw new Error('A face has no stable direction.'); return mul(a, 1 / n); };
const turn = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const area = ring => ring.reduce((sum, a, i) => { const b = ring[(i + 1) % ring.length]; return sum + a[0] * b[1] - a[1] * b[0]; }, 0) / 2;
const pairKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
const finitePoint = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const panelName = cell => typeof cell.name === 'string' && cell.name.trim() ? cell.name.trim() : Number.isInteger(cell.id) && cell.id >= 0 ? `P${String(cell.id + 1).padStart(3, '0')}` : `P-${String(cell.id)}`;
const bounds = points => ({ min: [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1]))], max: [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))] });
const apply = (p, t) => [t.c * p[0] - t.s * p[1] + t.x, t.s * p[0] + t.c * p[1] + t.y];
const identity = () => ({ c: 1, s: 0, x: 0, y: 0 });
function distanceToSegment(p, a, b) { const d = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), d) / (dot(d, d) || 1))); return length(sub(p, add(a, mul(d, t)))); }
function inside(p, ring) {
  let value = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) value = !value;
  }
  return value;
}
function materialContains(p, loops) { return inside(p, loops[0]) && !loops.slice(1).some(ring => inside(p, ring)); }
function segmentsMeet(a, b, c, d) {
  if (turn(a, b, c) * turn(a, b, d) < -EPS * EPS && turn(c, d, a) * turn(c, d, b) < -EPS * EPS) return true;
  return distanceToSegment(a, c, d) < EPS || distanceToSegment(b, c, d) < EPS || distanceToSegment(c, a, b) < EPS || distanceToSegment(d, a, b) < EPS;
}
function validateLoops(loops) {
  for (const [ri, ring] of loops.entries()) {
    if (ring.length < 3 || Math.abs(area(ring)) < EPS) throw new Error('An outline has no usable area.');
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], c = ring[(i + 2) % ring.length];
      if (length(sub(a, b)) < EPS) throw new Error('An outline contains a collapsed edge.');
      if (Math.abs(turn(a, b, c)) < EPS && dot(sub(b, a), sub(c, b)) < 0) throw new Error('An outline doubles back along an edge.');
      for (let j = i + 2; j < ring.length; j++) {
        if (i === 0 && j === ring.length - 1) continue;
        if (segmentsMeet(a, b, ring[j], ring[(j + 1) % ring.length])) throw new Error('An outline crosses or touches itself.');
      }
    }
    if (ri && !inside(ring[0], loops[0])) throw new Error('An opening lies outside its panel.');
    for (let rj = 0; rj < ri; rj++) {
      const other = loops[rj];
      if (rj && (inside(ring[0], other) || inside(other[0], ring))) throw new Error('Two openings overlap.');
      for (let i = 0; i < ring.length; i++) for (let j = 0; j < other.length; j++) if (segmentsMeet(ring[i], ring[(i + 1) % ring.length], other[j], other[(j + 1) % other.length])) throw new Error('Two outline boundaries touch or cross.');
    }
  }
}

export class LaserNetError extends Error {
  constructor(message, diagnostics = []) { super(message); this.name = 'LaserNetError'; this.diagnostics = diagnostics; }
}
const failure = (code, message, panelIds = []) => new LaserNetError(message, [{ severity: 'error', code, message, panelIds }]);

function prepare(cells, scale, options, diagnostics) {
  const vertices = [], buckets = new Map(), shared = new Map(), ids = new Set(), excludedPanelIds = [];
  const tolerance = 1e-5, planarityTolerance = 1e-4;
  const vertex = (point, sharedId) => {
    if (sharedId !== undefined && shared.has(sharedId)) {
      const found = shared.get(sharedId);
      if (length(sub(found.point, point)) > tolerance) throw new Error('A shared corner has different positions in adjacent panels.');
      return found;
    }
    const grid = point.map(x => Math.floor(x / tolerance)); let found;
    for (let x = -1; x <= 1 && !found; x++) for (let y = -1; y <= 1 && !found; y++) for (let z = -1; z <= 1 && !found; z++) {
      for (const candidate of buckets.get(`${grid[0] + x},${grid[1] + y},${grid[2] + z}`) || []) {
        // Explicit shared IDs distinguish coincident, disconnected sheets.
        // Coordinate welding remains the fallback for outlines without IDs.
        if (sharedId !== undefined && candidate.sharedIds.size && !candidate.sharedIds.has(sharedId)) continue;
        if (length(sub(candidate.point, point)) <= tolerance) { found = candidate; break; }
      }
    }
    if (!found) {
      found = { index: vertices.length, key: sharedId === undefined ? `p${point.map(x => Math.round(x / tolerance)).join(',')}` : `v${sharedId}`, point: [...point], sharedIds: new Set() };
      vertices.push(found); const key = grid.join(','); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(found);
    }
    if (sharedId !== undefined) { shared.set(sharedId, found); found.sharedIds.add(sharedId); }
    return found;
  };
  const panels = [];
  for (const cell of cells.slice().sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))) {
    if (!(typeof cell?.id === 'string' || Number.isFinite(cell?.id)) || ids.has(cell.id)) throw failure('panel-id', 'Every panel needs a unique stable ID.');
    ids.add(cell.id);
    if (cell.valid === false) {
      if (options.allowPartial !== true) throw failure('invalid-panel', `${panelName(cell)} is unresolved. Resolve its outline or explicitly export only resolved panels.`, [cell.id]);
      excludedPanelIds.push(cell.id); continue;
    }
    try {
      if (!Array.isArray(cell.flatPositions) || !cell.loops?.length || !finitePoint(cell.plane?.normal)) throw new Error('A fitted planar outline is required.');
      const normal = unit(cell.plane.normal), origin = finitePoint(cell.plane.origin) ? [...cell.plane.origin] : cell.flatPositions[cell.loops[0][0]];
      if (!finitePoint(origin)) throw new Error('The face origin is not finite.');
      const first = cell.loops[0], reference = finitePoint(cell.plane.u) ? cell.plane.u : sub(cell.flatPositions[first[1]], cell.flatPositions[first[0]]);
      const u = unit(sub(reference, mul(normal, dot(reference, normal)))), v = unit(cross(normal, u));
      const rings = cell.loops.map(loop => {
        const indices = [...loop]; if (indices.length > 1 && indices[0] === indices.at(-1)) indices.pop();
        return indices.map(i => {
          const p = cell.flatPositions[i]; if (!Number.isInteger(i) || !finitePoint(p)) throw new Error('An outline contains an invalid corner.');
          if (Math.abs(dot(sub(p, origin), normal)) > planarityTolerance) throw new Error('The face is not planar enough for rigid unfolding.');
          return vertex(p, cell.sharedVertexIds?.[i]);
        });
      });
      panels.push({ id: cell.id, name: panelName(cell), normal, origin: [...origin], u, v, rings });
    } catch (error) { throw failure('invalid-outline', `${panelName(cell)}: ${error.message}`, [cell.id]); }
  }
  if (!panels.length) throw failure('no-panels', 'There are no resolved panels to unfold.', excludedPanelIds);
  if (vertices.length > 5000) throw failure('complexity', 'The folding export supports at most 5000 outline corners. Simplify this model first.');
  // Split collinear shared segments before adjacency. A T junction is usable
  // when a long edge is divided into the same physical segments on both sides.
  for (const panel of panels) panel.rings = panel.rings.map(ring => ring.flatMap((a, i) => {
    const b = ring[(i + 1) % ring.length], direction = sub(b.point, a.point), squared = dot(direction, direction);
    const along = vertices.filter(candidate => candidate !== a && candidate !== b).map(candidate => ({ candidate, t: dot(sub(candidate.point, a.point), direction) / squared }))
      .filter(({ candidate, t }) => t > 1e-8 && t < 1 - 1e-8 && distanceToSegment(candidate.point, a.point, b.point) <= tolerance).sort((a, b) => a.t - b.t);
    return [a, ...along.map(item => item.candidate)];
  }));
  const local = (panel, vertex) => { const d = sub(vertex.point, panel.origin); return [dot(d, panel.u) / scale, dot(d, panel.v) / scale]; };
  const normalizeRings = panel => {
    panel.rings.sort((a, b) => Math.abs(area(b.map(p => local(panel, p)))) - Math.abs(area(a.map(p => local(panel, p)))));
    panel.rings.forEach((ring, i) => { if ((area(ring.map(p => local(panel, p))) > 0) !== (i === 0)) ring.reverse(); });
  };
  panels.forEach(normalizeRings);
  const adjacency = () => {
    const edges = new Map();
    panels.forEach((panel, pi) => panel.rings.forEach((ring, ri) => ring.forEach((a, ei) => {
      const b = ring[(ei + 1) % ring.length], key = pairKey(a.index, b.index);
      if (!edges.has(key)) edges.set(key, { key, a, b, uses: [] });
      edges.get(key).uses.push({ pi, ri, ei, from: a.index, to: b.index });
    })));
    for (const edge of edges.values()) if (edge.uses.length > 2 || new Set(edge.uses.map(use => use.pi)).size !== edge.uses.length) throw failure('nonmanifold', 'An edge belongs to more than two faces or is repeated within a panel.', edge.uses.map(use => panels[use.pi].id));
    return edges;
  };
  let edges = adjacency(); const signs = new Map(), components = [];
  const links = panels.map(() => []);
  for (const edge of edges.values()) if (edge.uses.length === 2) {
    const [a, b] = edge.uses, relation = a.from === b.from ? -1 : 1;
    links[a.pi].push([b.pi, relation]); links[b.pi].push([a.pi, relation]);
  }
  for (let root = 0; root < panels.length; root++) if (!signs.has(root)) {
    const component = [root]; signs.set(root, 1);
    for (let i = 0; i < component.length; i++) for (const [next, relation] of links[component[i]]) {
      const sign = signs.get(component[i]) * relation;
      if (!signs.has(next)) { signs.set(next, sign); component.push(next); }
      else if (signs.get(next) !== sign) throw failure('orientation', 'This connected surface cannot be oriented consistently for folding.', component.map(pi => panels[pi].id));
    }
    if (finitePoint(options.outwardCenter)) {
      const score = component.reduce((sum, pi) => {
        const panel = panels[pi], weight = Math.abs(panel.rings.reduce((total, ring) => total + area(ring.map(vertex => local(panel, vertex))), 0));
        return sum + weight * signs.get(pi) * dot(panel.normal, sub(panel.origin, options.outwardCenter));
      }, 0);
      if (score < 0) component.forEach(pi => signs.set(pi, -signs.get(pi)));
    }
    components.push(component);
  }
  panels.forEach((panel, pi) => {
    if (signs.get(pi) * (options.flipDirection ? -1 : 1) < 0) { panel.normal = mul(panel.normal, -1); panel.v = mul(panel.v, -1); }
    normalizeRings(panel);
    panel.local = new Map(panel.rings.flat().map(p => [p.index, local(panel, p)]));
    panel.loops = panel.rings.map(ring => ring.map(p => panel.local.get(p.index)));
    try {
      validateLoops(panel.loops);
      const points = panel.loops.flat(), vectors = panel.loops.map(ring => ring.map(p => new Vector2(...p)));
      panel.triangles = ShapeUtils.triangulateShape(vectors[0], vectors.slice(1)).map(ids => ids.map(i => points[i]));
      panel.area = Math.abs(area(panel.loops[0])) - panel.loops.slice(1).reduce((sum, ring) => sum + Math.abs(area(ring)), 0);
      if (!panel.triangles.length || Math.abs(panel.triangles.reduce((sum, triangle) => sum + Math.abs(area(triangle)), 0) - panel.area) > Math.max(EPS, panel.area * 1e-7)) throw new Error('The outline could not be triangulated reliably.');
    } catch (error) { throw failure('invalid-outline', `${panel.name}: ${error.message}`, [panel.id]); }
  });
  edges = adjacency();
  if (excludedPanelIds.length) diagnostics.push({ severity: 'warning', code: 'partial', message: `${excludedPanelIds.length} unresolved panel(s) excluded; this is an incomplete assembly.`, panelIds: excludedPanelIds });
  if (components.length > 1) diagnostics.push({ severity: 'info', code: 'disconnected', message: `The input has ${components.length} disconnected surface pieces.`, count: components.length });
  return { panels, edges, components, excludedPanelIds };
}

// Material intersection, not just outline crossing: triangle clipping catches
// containment while correctly leaving the holes in either panel empty.
function triangleOverlap(a, b) {
  let polygon = a.slice(); const clip = area(b) >= 0 ? b : [...b].reverse();
  for (let i = 0; i < 3 && polygon.length; i++) {
    const p = clip[i], q = clip[(i + 1) % 3], next = [];
    for (let j = 0; j < polygon.length; j++) {
      const x = polygon[j], y = polygon[(j + 1) % polygon.length], dx = turn(p, q, x), dy = turn(p, q, y);
      if (dx >= -EPS) next.push(x);
      if ((dx >= -EPS) !== (dy >= -EPS)) { const t = dx / (dx - dy); next.push(add(x, mul(sub(y, x), t))); }
    }
    polygon = next;
  }
  return polygon.length > 2 && Math.abs(area(polygon)) > 1e-8;
}
function overlaps(a, b) {
  if (a.bounds.max[0] <= b.bounds.min[0] + EPS || b.bounds.max[0] <= a.bounds.min[0] + EPS || a.bounds.max[1] <= b.bounds.min[1] + EPS || b.bounds.max[1] <= a.bounds.min[1] + EPS) return false;
  return a.triangles.some(x => b.triangles.some(y => triangleOverlap(x, y)));
}
function placed(panel, transform) {
  const loops = panel.loops.map(ring => ring.map(p => apply(p, transform))), triangles = panel.triangles.map(triangle => triangle.map(p => apply(p, transform)));
  return { panel, transform, loops, triangles, bounds: bounds(loops.flat()) };
}
function hull(points) {
  const ordered = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), lower = [], upper = [];
  for (const p of ordered) { while (lower.length > 1 && turn(lower.at(-2), lower.at(-1), p) <= EPS) lower.pop(); lower.push(p); }
  for (const p of ordered.slice().reverse()) { while (upper.length > 1 && turn(upper.at(-2), upper.at(-1), p) <= EPS) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
function fittingRotation(points, width, height) {
  const outline = hull(points), quarter = Math.PI / 2;
  const angles = [0, quarter];
  for (let i = 0; i < outline.length; i++) { const d = sub(outline[(i + 1) % outline.length], outline[i]); angles.push(((-Math.atan2(d[1], d[0]) % quarter) + quarter) % quarter); }
  const breaks = [...new Set(angles)].sort((a, b) => a - b), candidates = [...breaks];
  for (let i = 0; i + 1 < breaks.length; i++) {
    const low = breaks[i], high = breaks[i + 1], middle = (low + high) / 2, c = Math.cos(middle), s = Math.sin(middle);
    const xs = outline.map(p => c * p[0] - s * p[1]), ys = outline.map(p => s * p[0] + c * p[1]);
    const dx = sub(outline[xs.indexOf(Math.max(...xs))], outline[xs.indexOf(Math.min(...xs))]), dy = sub(outline[ys.indexOf(Math.max(...ys))], outline[ys.indexOf(Math.min(...ys))]);
    const a = dx[0] / width, b = -dx[1] / width, f = dy[1] / height, g = dy[0] / height;
    for (const angle of [Math.atan2(b, a), Math.atan2(g, f), Math.atan2(-(a - f), b - g)]) for (let k = -2; k <= 2; k++) { const t = angle + k * Math.PI; if (t > low && t < high) candidates.push(t); }
  }
  let best;
  for (const angle of candidates) {
    const rotation = { c: Math.cos(angle), s: Math.sin(angle), x: 0, y: 0 }, box = bounds(outline.map(p => apply(p, rotation)));
    const w = box.max[0] - box.min[0], h = box.max[1] - box.min[1], score = Math.max(w / width, h / height);
    if (!best || score < best.score - 1e-12 || Math.abs(score - best.score) < 1e-12 && w * h < best.width * best.height) best = { ...rotation, angle, bounds: box, width: w, height: h, score, fits: w <= width + EPS && h <= height + EPS };
  }
  return best;
}

function sharedSeams(panels, edges) {
  const byPair = new Map();
  for (const edge of edges.values()) if (edge.uses.length === 2) {
    const pair = edge.uses.map(use => use.pi).sort((a, b) => a - b), key = pair.join(':');
    if (!byPair.has(key)) byPair.set(key, []); byPair.get(key).push(edge);
  }
  const seams = [];
  for (const list of byPair.values()) {
    const remaining = new Set(list);
    while (remaining.size) {
      const first = remaining.values().next().value, chain = [first], direction = unit(sub(first.b.point, first.a.point)); remaining.delete(first);
      for (let i = 0; i < chain.length; i++) for (const other of [...remaining]) {
        const connected = [chain[i].a.index, chain[i].b.index].some(id => id === other.a.index || id === other.b.index);
        if (connected && length(cross(direction, unit(sub(other.b.point, other.a.point)))) < 1e-8 && length(cross(sub(other.a.point, first.a.point), direction)) < 1e-5) {
          remaining.delete(other); chain.push(other);
        }
      }
      const vertices = [...new Map(chain.flatMap(edge => [edge.a, edge.b]).map(p => [p.index, p])).values()].sort((a, b) => dot(a.point, direction) - dot(b.point, direction));
      const a = vertices[0], b = vertices.at(-1), uses = first.uses, p = panels[uses[0].pi], q = panels[uses[1].pi];
      const edgeDirection = unit(sub((uses[0].from === first.a.index ? first.b : first.a).point, (uses[0].from === first.a.index ? first.a : first.b).point));
      const signedAngleDegrees = Math.atan2(dot(edgeDirection, cross(p.normal, q.normal)), Math.max(-1, Math.min(1, dot(p.normal, q.normal)))) * 180 / Math.PI;
      const panelIds = [p.id, q.id].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));
      const key = `${panelIds.map(String).join(':')}/${[a.key, b.key].sort().join('/')}`;
      seams.push({ id: key, key, a, b, indices: uses.map(use => use.pi), panels: panelIds, sourceEdgeKeys: chain.map(edge => edge.key), length: length(sub(b.point, a.point)), angleDegrees: Math.abs(signedAngleDegrees), signedAngleDegrees, side: signedAngleDegrees < 0 ? 'front' : 'back' });
    }
  }
  seams.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
  seams.forEach((seam, i) => { seam.name = `E${String(i + 1).padStart(3, '0')}`; });
  return seams;
}
function attach(parent, child, seam) {
  const a = apply(parent.panel.local.get(seam.a.index), parent.transform), b = apply(parent.panel.local.get(seam.b.index), parent.transform);
  const x = child.local.get(seam.a.index), y = child.local.get(seam.b.index), from = unit(sub(y, x)), to = unit(sub(b, a));
  const c = dot(from, to), s = from[0] * to[1] - from[1] * to[0];
  if (Math.abs(length(sub(y, x)) - length(sub(b, a))) > 1e-5) throw failure('hinge-length', 'Adjacent planar faces disagree on their shared edge length.', seam.panels);
  return placed(child, { c, s, x: a[0] - c * x[0] + s * x[1], y: a[1] - s * x[0] - c * x[1] });
}
function interiorCandidates(panel) {
  const candidates = [];
  for (const triangle of panel.triangles) {
    const centroid = mul(triangle.reduce(add, [0, 0]), 1 / 3);
    candidates.push(centroid);
    triangle.forEach(point => candidates.push(add(mul(centroid, .7), mul(point, .3))));
  }
  const clearance = point => Math.min(...panel.loops.flatMap(ring => ring.map((a, i) => distanceToSegment(point, a, ring[(i + 1) % ring.length]))));
  return candidates.filter(p => materialContains(p, panel.loops)).map(position => ({ position, clearance: clearance(position) })).sort((a, b) => b.clearance - a.clearance);
}
function rectangle(position, angle, width, height) {
  const radians = angle * Math.PI / 180, t = { c: Math.cos(radians), s: Math.sin(radians), x: position[0], y: position[1] };
  return [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]].map(p => apply(p, t));
}
function fitLabel(panel, text, preferred, angle, nominalHeight, occupied, diagnostics, extra = {}) {
  const interior = interiorCandidates(panel), candidates = [...preferred, ...interior.map(item => item.position)];
  const safeRectangle = rect => {
    // A convex text box stays in material when its corners do and it crosses
    // no boundary; an enclosed hole also disqualifies it.
    if (!rect.every(point => materialContains(point, panel.loops))) return false;
    for (const ring of panel.loops) {
      if (ring.some(point => inside(point, rect))) return false;
      for (let i = 0; i < rect.length; i++) for (let j = 0; j < ring.length; j++) if (segmentsMeet(rect[i], rect[(i + 1) % rect.length], ring[j], ring[(j + 1) % ring.length])) return false;
    }
    const tris = [[rect[0], rect[1], rect[2]], [rect[0], rect[2], rect[3]]];
    return !occupied.some(other => tris.some(a => [[other[0], other[1], other[2]], [other[0], other[2], other[3]]].some(b => triangleOverlap(a, b))));
  };
  let chosen;
  const heights = [];
  for (let value = nominalHeight; value > .1; value *= .72) heights.push(value);
  heights.push(.1);
  for (const height of heights) {
    for (const position of candidates) {
      const rect = rectangle(position, angle, text.length * height * .95, height);
      if (safeRectangle(rect)) { chosen = { position, height, rect }; break; }
    }
    if (chosen) break;
  }
  if (!chosen) throw failure('label-too-small', `${panel.name}: ${text} cannot fit inside its panel at the minimum 0.1 mm label height. Decrease the scale denominator to make a larger model.`, [panel.id]);
  if (chosen.height < .6) diagnostics.push({ severity: 'warning', code: 'small-label', message: `${panel.name}: ${text} is too small to read reliably at this scale. Use a larger model or the assembly preview.`, panelIds: [panel.id], seamId: extra.seamId });
  occupied.push(chosen.rect);
  return { text, position: [...chosen.position], angle, height: chosen.height, panelId: panel.id, ...extra };
}

// A direct annotation leader can cross an opening and engrave a different
// panel parked inside it. Route through the triangulated material instead;
// each centroid-to-shared-edge segment stays inside one convex triangle.
const leaderNavigation = new WeakMap();
function routeLeader(panel, start, end) {
  let graph = leaderNavigation.get(panel);
  if (!graph) {
    const triangles = panel.triangles, neighbors = triangles.map(() => []), edges = new Map();
    triangles.forEach((triangle, ti) => triangle.forEach((a, i) => {
      const b = triangle[(i + 1) % triangle.length], key = [a, b].map(p => p.map(x => Math.round(x / EPS)).join(',')).sort().join('|');
      if (edges.has(key)) {
        const other = edges.get(key), midpoint = mul(add(a, b), .5);
        neighbors[ti].push({ to: other, midpoint }); neighbors[other].push({ to: ti, midpoint });
      } else edges.set(key, ti);
    }));
    graph = { triangles, neighbors, centers: triangles.map(triangle => mul(triangle.reduce(add, [0, 0]), 1 / 3)) };
    leaderNavigation.set(panel, graph);
  }
  const contains = (point, triangle) => {
    const signs = triangle.map((a, i) => turn(a, triangle[(i + 1) % triangle.length], point));
    return signs.every(value => value >= -EPS) || signs.every(value => value <= EPS);
  };
  const from = graph.triangles.findIndex(triangle => contains(start, triangle)), to = graph.triangles.findIndex(triangle => contains(end, triangle));
  if (from < 0 || to < 0) throw failure('label-route', `${panel.name}: an assembly label cannot be connected to its seam inside the panel. Use a larger model scale.`, [panel.id]);
  if (from === to) return [[...start], [...end]];
  const queue = [from], previous = new Map([[from, null]]);
  for (let i = 0; i < queue.length && !previous.has(to); i++) for (const link of graph.neighbors[queue[i]]) if (!previous.has(link.to)) {
    previous.set(link.to, { from: queue[i], midpoint: link.midpoint }); queue.push(link.to);
  }
  if (!previous.has(to)) throw failure('label-route', `${panel.name}: its label route crosses disconnected material. Inspect the panel outline.`, [panel.id]);
  const links = []; let current = to;
  while (current !== from) { const step = previous.get(current); links.push({ ...step, to: current }); current = step.from; }
  const points = [[...start], [...graph.centers[from]]];
  for (const step of links.reverse()) points.push([...step.midpoint], [...graph.centers[step.to]]);
  points.push([...end]);
  return points.filter((point, i) => !i || length(sub(point, points[i - 1])) > EPS);
}

/** Unfold fitted midsurface panels without stretching or changing their source
 * boundaries. The result is a set of fabrication templates, not a simulation
 * that proves engraved plywood hinges can reach the specified angles. */
export function buildLaserNet(cells, options = {}) {
  if (!Array.isArray(cells) || !cells.length) throw failure('no-panels', 'Select at least one fitted panel to unfold.');
  if (cells.length > 400) throw failure('panel-limit', 'The folding export supports at most 400 panels at once.');
  const scale = Number(options.scale ?? 10), width = Number(options.width ?? 400), height = Number(options.height ?? 400), margin = Number(options.margin ?? 10), gap = Number(options.gap ?? 8);
  if (![scale, width, height, margin, gap].every(Number.isFinite) || scale <= 0 || width <= 0 || height <= 0 || margin < 0 || gap < 0 || width <= margin * 2 || height <= margin * 2) throw failure('settings', 'Use a positive model scale and sheet size, with margins smaller than half the sheet.');
  const innerWidth = width - 2 * margin, innerHeight = height - 2 * margin, diagnostics = [];
  const input = prepare(cells, scale, options, diagnostics), panels = input.panels, seams = sharedSeams(panels, input.edges), seamForEdge = new Map();
  seams.forEach(seam => seam.sourceEdgeKeys.forEach(key => seamForEdge.set(key, seam)));
  const adjacent = panels.map(() => []); seams.forEach(seam => seam.indices.forEach(pi => adjacent[pi].push(seam)));
  const forced = new Set(options.forcedCuts || []), hinges = new Set(), rejections = new Map(), remaining = new Set(panels.map((_, i) => i)), nets = [];
  for (const panel of panels) {
    const rotation = fittingRotation(panel.loops.flat(), innerWidth, innerHeight);
    if (!rotation?.fits) throw failure('panel-too-large', `${panel.name} does not fit this bed at 1:${scale}. Increase the denominator to at least ${Math.ceil(scale * rotation.score * 10) / 10}.`, [panel.id]);
  }
  while (remaining.size) {
    const root = [...remaining].sort((a, b) => panels[b].area - panels[a].area || a - b)[0], placedPanels = new Map([[root, placed(panels[root], identity())]]), frontier = [...adjacent[root]], seen = new Set();
    remaining.delete(root);
    while (frontier.length) {
      frontier.sort((a, b) => b.length - a.length || a.key.localeCompare(b.key));
      const seam = frontier.shift(); if (seen.has(seam.id)) continue; seen.add(seam.id);
      if (forced.has(seam.id) || forced.has(seam.name)) { rejections.set(seam.id, 'forced'); continue; }
      const parentId = seam.indices.find(pi => placedPanels.has(pi)), childId = seam.indices.find(pi => remaining.has(pi));
      if (parentId === undefined || childId === undefined) continue;
      const candidate = attach(placedPanels.get(parentId), panels[childId], seam);
      if ([...placedPanels.values()].some(other => overlaps(candidate, other))) { rejections.set(seam.id, 'overlap'); continue; }
      const allPoints = [...placedPanels.values(), candidate].flatMap(item => item.loops.flat());
      if (!fittingRotation(allPoints, innerWidth, innerHeight).fits) { rejections.set(seam.id, 'bed'); continue; }
      hinges.add(seam.id); placedPanels.set(childId, candidate); remaining.delete(childId); frontier.push(...adjacent[childId]);
    }
    const rotation = fittingRotation([...placedPanels.values()].flatMap(item => item.loops.flat()), innerWidth, innerHeight);
    nets.push({ id: `N${String(nets.length + 1).padStart(3, '0')}`, placed: placedPanels, rotation });
  }
  const netForPanel = new Map(); nets.forEach(net => [...net.placed.keys()].forEach(pi => netForPanel.set(pi, net.id)));
  seams.forEach(seam => { seam.mode = hinges.has(seam.id) ? 'fold' : 'cut'; seam.reason = seam.mode === 'fold' ? undefined : rejections.get(seam.id) || (netForPanel.get(seam.indices[0]) === netForPanel.get(seam.indices[1]) ? 'cycle' : 'separate-net'); });
  if (nets.length > input.components.length) diagnostics.push({ severity: 'info', code: 'split-nets', message: `The surface unfolds into ${nets.length} pieces to avoid overlap and fit the laser bed. Join matching E labels after cutting.`, count: nets.length });
  const sheets = [], outputPanels = [], outputNets = [], sheetForPanel = new Map();
  // Pack each connected net as one rigid object. Shelves never intersect and
  // retain the requested gap; new sheets are created instead of shrinking.
  for (const net of nets.slice().sort((a, b) => b.rotation.height - a.rotation.height || b.rotation.width - a.rotation.width || a.id.localeCompare(b.id))) {
    let destination;
    const rotations = [net.rotation, fittingRotation([...net.placed.values()].flatMap(item => item.loops.flat()), innerHeight, innerWidth)];
    rotations[1] = { ...rotations[1], c: -rotations[1].s, s: rotations[1].c };
    for (const rotation of rotations) {
      const box = bounds([...net.placed.values()].flatMap(item => item.loops.flat()).map(p => apply(p, rotation))), w = box.max[0] - box.min[0], h = box.max[1] - box.min[1];
      if (w > innerWidth + EPS || h > innerHeight + EPS) continue;
      for (const sheet of sheets) {
        for (const shelf of sheet.shelves) if (h <= shelf.height + EPS && shelf.x + w <= innerWidth + EPS) {
          const score = shelf.height - h;
          if (!destination || score < destination.score) destination = { sheet, shelf, rotation, box, w, h, score };
        }
        const y = sheet.shelves.reduce((sum, shelf) => Math.max(sum, shelf.y + shelf.height + gap), 0);
        if (y + h <= innerHeight + EPS && !destination) destination = { sheet, shelf: { x: 0, y, height: h }, fresh: true, rotation, box, w, h, score: Infinity };
      }
    }
    if (!destination) {
      const sheet = { index: sheets.length, width, height, margin, scale, valid: true, panels: [], cuts: [], folds: [], labels: [], tabs: [], shelves: [] }; sheets.push(sheet);
      const rotation = net.rotation, box = rotation.bounds;
      destination = { sheet, shelf: { x: 0, y: 0, height: rotation.height }, fresh: true, rotation, box, w: rotation.width, h: rotation.height };
    }
    const { sheet, shelf, rotation, box, w, h } = destination;
    if (destination.fresh) sheet.shelves.push(shelf);
    const transform = { c: rotation.c, s: rotation.s, x: margin + shelf.x - box.min[0], y: margin + shelf.y - box.min[1] };
    const netBounds = { min: [margin + shelf.x, margin + shelf.y], max: [margin + shelf.x + w, margin + shelf.y + h] };
    shelf.x += w + gap;
    for (const [pi, item] of net.placed) {
      const t = item.transform, origin = apply([t.x, t.y], transform), combined = { c: transform.c * t.c - transform.s * t.s, s: transform.s * t.c + transform.c * t.s, x: origin[0], y: origin[1] };
      const result = placed(item.panel, combined), output = { id: item.panel.id, name: item.panel.name, netId: net.id, sheetIndex: sheet.index, loops: result.loops, triangles: result.triangles,
        sourceLoops: item.panel.rings.map(ring => ring.map(vertex => [...vertex.point])), sourceVertexIds: item.panel.rings.map(ring => ring.map(vertex => vertex.key)),
        transform2D: combined, assemblyPlane: { origin: [...item.panel.origin], normal: [...item.panel.normal], u: [...item.panel.u], v: [...item.panel.v] }, scale };
      sheet.panels.push(output); outputPanels.push(output); sheetForPanel.set(pi, { sheet, output, transform: combined });
    }
    outputNets.push({ id: net.id, panelIds: [...net.placed.keys()].map(pi => panels[pi].id), foldIds: seams.filter(seam => hinges.has(seam.id) && net.placed.has(seam.indices[0])).map(seam => seam.id), sheetIndex: sheet.index, bounds: netBounds });
  }
  for (const sheet of sheets) {
    const cutMap = new Map(), occupied = new Map();
    const cutKey = (a, b) => [a, b].map(p => p.map(x => Math.round(x / EPS)).join(',')).sort().join('|');
    for (const output of sheet.panels) {
      const pi = panels.findIndex(panel => panel.id === output.id), panel = panels[pi], placement = sheetForPanel.get(pi);
      occupied.set(output.id, []);
      sheet.labels.push(fitLabel(output, output.name, [], 0, 2.5, occupied.get(output.id), diagnostics, { kind: 'panel' }));
      panel.rings.forEach((ring, ri) => ring.forEach((vertex, ei) => {
        const next = ring[(ei + 1) % ring.length], seam = seamForEdge.get(pairKey(vertex.index, next.index));
        if (seam?.mode === 'fold') return;
        const a = apply(panel.local.get(vertex.index), placement.transform), b = apply(panel.local.get(next.index), placement.transform), key = cutKey(a, b);
        if (cutMap.has(key)) { const cut = cutMap.get(key); if (!cut.panelIds.includes(panel.id)) cut.panelIds.push(panel.id); }
        else cutMap.set(key, { a, b, panelId: panel.id, panelIds: [panel.id], ...(seam ? { seamId: seam.id } : {}) });
      }));
    }
    sheet.cuts = [...cutMap.values()];
    for (const seam of seams) {
      if (seam.mode === 'fold') {
        const placement = sheetForPanel.get(seam.indices[0]); if (placement.sheet !== sheet || seam.angleDegrees < 1e-5) continue;
        const panel = panels[seam.indices[0]];
        sheet.folds.push({ a: apply(panel.local.get(seam.a.index), placement.transform), b: apply(panel.local.get(seam.b.index), placement.transform), seamId: seam.id, panelIds: [...seam.panels], angleDegrees: seam.angleDegrees, signedAngleDegrees: seam.signedAngleDegrees, side: seam.side });
      } else for (const pi of seam.indices) {
        const placement = sheetForPanel.get(pi); if (placement.sheet !== sheet) continue;
        const panel = panels[pi], output = placement.output, a = apply(panel.local.get(seam.a.index), placement.transform), b = apply(panel.local.get(seam.b.index), placement.transform), midpoint = mul(add(a, b), .5), vector = unit(sub(b, a));
        let angle = Math.atan2(vector[1], vector[0]) * 180 / Math.PI; if (angle > 90) angle -= 180; if (angle < -90) angle += 180;
        const preferred = [];
        for (const offset of [2, 3, 4, 6]) for (const side of [-1, 1]) { const p = add(midpoint, mul([-vector[1], vector[0]], offset * side)); if (materialContains(p, output.loops)) preferred.push(p); }
        const label = fitLabel(output, seam.name, preferred, angle, 1.8, occupied.get(panel.id), diagnostics, { kind: 'join', seamId: seam.id });
        if (!preferred.some(point => length(sub(point, label.position)) < EPS)) label.leader = routeLeader(output, midpoint, label.position);
        sheet.labels.push(label);
      }
    }
    delete sheet.shelves;
  }
  const outputSeams = seams.map(({ a, b, indices, sourceEdgeKeys, ...seam }) => ({ ...seam, sourceEdge: [[...a.point], [...b.point]], netIds: indices.map(pi => netForPanel.get(pi)) }));
  const cuts = sheets.flatMap(sheet => sheet.cuts.map(cut => ({ ...cut, sheetIndex: sheet.index }))), folds = sheets.flatMap(sheet => sheet.folds.map(fold => ({ ...fold, sheetIndex: sheet.index })));
  return { valid: true, scale, width, height, margin, gap, sheets, nets: outputNets, panels: outputPanels, seams: outputSeams, cuts, folds, diagnostics,
    excludedPanelIds: input.excludedPanelIds, componentCount: input.components.length, summary: { panels: outputPanels.length, sheets: sheets.length, nets: nets.length, folds: folds.length, joinSeams: outputSeams.filter(seam => seam.mode === 'cut').length, excluded: input.excludedPanelIds.length } };
}
