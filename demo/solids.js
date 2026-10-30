import { ShapeUtils, Vector2 } from './vendor/three.module.js';

const EPS = 1e-8;
const KEY_TOLERANCE = 1e-4;
const add = (a, b) => a.map((x, i) => x + b[i]);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const mul = (a, s) => a.map(x => x * s);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(...a);
const unit = a => { const size = length(a); if (size < EPS) throw new Error('A panel has no stable normal.'); return mul(a, 1 / size); };
const distance = (a, b) => length(sub(a, b));
const key = p => p.map(x => Math.round(x / KEY_TOLERANCE)).join(',');
const edgeKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
const area = p => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - a[1] * b[0]; }, 0) / 2;
const turn = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function pointInside(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function intersects(a, b, c, d) {
  const ab = Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
  const cd = Math.max(1, Math.hypot(d[0] - c[0], d[1] - c[1]));
  const x = turn(a, b, c), y = turn(a, b, d), z = turn(c, d, a), w = turn(c, d, b);
  if (x * y < -EPS * ab * ab && z * w < -EPS * cd * cd) return true;
  const on = (p, q, r, value, scale) => Math.abs(value) < EPS * scale
    && r[0] >= Math.min(p[0], q[0]) - EPS && r[0] <= Math.max(p[0], q[0]) + EPS
    && r[1] >= Math.min(p[1], q[1]) - EPS && r[1] <= Math.max(p[1], q[1]) + EPS;
  return on(a, b, c, x, ab) || on(a, b, d, y, ab) || on(c, d, a, z, cd) || on(c, d, b, w, cd);
}

function checkRings(rings) {
  for (let ri = 0; ri < rings.length; ri++) {
    const ring = rings[ri];
    if (ring.length < 3 || ring.some(p => !p.every(Number.isFinite))) throw new Error('An offset outline is not finite.');
    const signed = area(ring);
    if ((ri === 0 && signed <= EPS) || (ri > 0 && signed >= -EPS)) throw new Error('The thickness or edge rounding collapses an outline.');
    for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) {
      if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue;
      if (intersects(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length])) throw new Error('The thickness or edge rounding makes an outline cross itself.');
    }
    if (ri > 0 && !pointInside(ring[0], rings[0])) throw new Error('The edge rounding closes or moves an opening outside its panel.');
    for (let rj = 0; rj < ri; rj++) {
      const other = rings[rj];
      for (let i = 0; i < ring.length; i++) for (let j = 0; j < other.length; j++) {
        if (intersects(ring[i], ring[(i + 1) % ring.length], other[j], other[(j + 1) % other.length])) throw new Error('The edge rounding joins two outline boundaries.');
      }
      if (rj > 0 && (pointInside(ring[0], other) || pointInside(other[0], ring))) throw new Error('Two openings overlap after offsetting.');
    }
  }
}

function prepare(cell, index, flip = 1) {
  if (cell.valid === false) throw new Error('Reshape this cell before making a solid panel.');
  const source = cell.flatPositions;
  if (!Array.isArray(source) || !source.length || !cell.loops?.length) throw new Error('The cell has no flat closed outline.');
  if (source.some(p => p?.length !== 3 || !p.every(Number.isFinite))) throw new Error('The cell has an invalid position.');
  const normal = mul(unit(cell.plane.normal), flip);
  const origin = [...(cell.plane.origin || source[0])];
  let u = cell.plane.u || sub(source[cell.loops[0][1]], source[cell.loops[0][0]]);
  u = unit(sub(u, mul(normal, dot(u, normal))));
  const v = unit(cross(normal, u));
  const plane = { origin, u, v, normal };
  const local = p => { const d = sub(p, origin); return [dot(d, u), dot(d, v)]; };
  const planarity = Math.max(...source.map(p => Math.abs(dot(sub(p, origin), normal))));
  if (planarity > 0.15) throw new Error(`The face is ${planarity.toFixed(2)} mm out of plane; fit it before adding thickness.`);
  const raw = cell.loops.map(loop => {
    const ids = loop.slice();
    if (ids.length > 1 && ids[0] === ids.at(-1)) ids.pop();
    if (ids.length < 3 || ids.some(i => !Number.isInteger(i) || !source[i])) throw new Error('A panel has an invalid boundary.');
    return { ids, xy: ids.map(i => local(source[i])) };
  });
  raw.sort((a, b) => Math.abs(area(b.xy)) - Math.abs(area(a.xy)));
  raw.forEach((ring, ri) => {
    if (ri > 0 && !pointInside(ring.xy[0], raw[0].xy)) throw new Error('This cell has separate pieces and cannot be one solid panel.');
    if ((area(ring.xy) > 0) !== (ri === 0)) { ring.ids.reverse(); ring.xy.reverse(); }
    ring.world = ring.ids.map(i => source[i]);
    ring.keys = ring.world.map(key);
    ring.boundaryPlanes = ring.ids.map(i => cell.boundaryPlanes?.[i] || null);
  });
  checkRings(raw.map(r => r.xy));
  return { cell, index, plane, rings: raw, planarity };
}

function adjacency(prepared) {
  const edges = new Map();
  for (const p of prepared) if (p) for (let ri = 0; ri < p.rings.length; ri++) {
    const ring = p.rings[ri];
    for (let ei = 0; ei < ring.keys.length; ei++) {
      const from = ring.keys[ei], to = ring.keys[(ei + 1) % ring.keys.length];
      const k = edgeKey(from, to), entry = { panel: p.index, ri, ei, from, to };
      if (!edges.has(k)) edges.set(k, []);
      edges.get(k).push(entry);
    }
  }
  return edges;
}

// The source may mix face-normal signs. Shared-edge direction determines a
// coherent offset side without assuming all dihedral angles are acute.
function orient(prepared, edges) {
  const links = new Map();
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const [a, b] = list;
    const relation = a.from === b.from ? -1 : 1;
    if (!links.has(a.panel)) links.set(a.panel, []);
    if (!links.has(b.panel)) links.set(b.panel, []);
    links.get(a.panel).push([b.panel, relation]);
    links.get(b.panel).push([a.panel, relation]);
  }
  const signs = new Map(), conflicts = new Set(), components = [];
  for (const root of prepared) if (root && !signs.has(root.index)) {
    signs.set(root.index, 1);
    const queue = [root.index];
    for (let qi = 0; qi < queue.length; qi++) {
      const current = queue[qi];
      for (const [next, relation] of links.get(current) || []) {
        const sign = signs.get(current) * relation;
        if (!signs.has(next)) { signs.set(next, sign); queue.push(next); }
        else if (signs.get(next) !== sign) { conflicts.add(current); conflicts.add(next); }
      }
    }
    components.push(queue);
  }
  return { signs, conflicts, components };
}

function sidePlanes(panel, all, edges) {
  const { origin, u, v, normal } = panel.plane;
  let minEdge = Infinity;
  const cuts = panel.rings.map(ring => ring.world.map((start, i) => {
    const end = ring.world[(i + 1) % ring.world.length];
    const edge = sub(end, start), edgeLength = length(edge);
    if (edgeLength < 1e-5) throw new Error('A boundary edge is too short for a solid panel.');
    minEdge = Math.min(minEdge, edgeLength);
    const list = edges.get(edgeKey(ring.keys[i], ring.keys[(i + 1) % ring.keys.length]));
    if (list.length > 2) throw new Error('More than two panels share an edge.');
    const neighborEntry = list.find(e => e.panel !== panel.index);
    const neighbor = neighborEntry && all[neighborEntry.panel];
    const firstTrim = ring.boundaryPlanes[i], lastTrim = ring.boundaryPlanes[(i + 1) % ring.world.length];
    const trim = !neighbor && firstTrim && lastTrim && Math.abs(dot(firstTrim.normal, lastTrim.normal) - 1) < 1e-8 && Math.abs(firstTrim.d - lastTrim.d) < 1e-5 ? firstTrim : null;
    let m = neighbor ? sub(normal, neighbor.plane.normal) : trim ? [...trim.normal] : cross(edge, normal);
    let worldConstant = neighbor ? dot(normal, origin) - dot(neighbor.plane.normal, neighbor.plane.origin) : trim ? trim.d : dot(m, start);
    let a = dot(m, u), b = dot(m, v), c = dot(m, normal);
    const tangentLength = Math.hypot(a, b);
    if (tangentLength < 1e-8) {
      if (neighbor && dot(normal, neighbor.plane.normal) < 0) throw new Error('A folded-back joint cannot be cut at this thickness.');
      m = cross(edge, normal);
      worldConstant = dot(m, start);
      a = dot(m, u); b = dot(m, v); c = dot(m, normal);
    }
    const xyStart = ring.xy[i], xyEnd = ring.xy[(i + 1) % ring.xy.length];
    const outward = [xyEnd[1] - xyStart[1], xyStart[0] - xyEnd[0]];
    const factor = (a * outward[0] + b * outward[1] >= 0 ? 1 : -1) / Math.hypot(a, b);
    a *= factor; b *= factor; c *= factor; m = mul(m, factor);
    worldConstant *= factor;
    const d = worldConstant - dot(m, origin);
    return { a, b, c, d, normal: m, constant: worldConstant, from: [...start], to: [...end],
      fromKey: ring.keys[i], toKey: ring.keys[(i + 1) % ring.keys.length], neighborIndex: neighbor?.index ?? null, neighborId: neighbor?.cell.id ?? null,
      kind: neighbor ? 'shared-mitre-plane' : trim ? 'source-boundary-plane' : 'boundary-ruled' };
  }));
  return { cuts, minEdge };
}

function symmetricSolver(matrix) {
  const a = matrix.map(r => [...r]), vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iteration = 0; iteration < 32; iteration++) {
    let p = 0, q = 1;
    for (const [i, j] of [[0, 2], [1, 2]]) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j; }
    if (Math.abs(a[p][q]) < 1e-14) break;
    const angle = Math.atan2(2 * a[p][q], a[q][q] - a[p][p]) / 2, c = Math.cos(angle), s = Math.sin(angle);
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 3; k++) if (k !== p && k !== q) {
      const akp = a[k][p], akq = a[k][q];
      a[k][p] = a[p][k] = c * akp - s * akq;
      a[k][q] = a[q][k] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = vectors[k][p], vkq = vectors[k][q];
      vectors[k][p] = c * vkp - s * vkq; vectors[k][q] = s * vkp + c * vkq;
    }
  }
  const limit = Math.max(a[0][0], a[1][1], a[2][2]) * 1e-12;
  return b => {
    const x = [0, 0, 0];
    for (let i = 0; i < 3; i++) if (a[i][i] > limit) {
      const vector = [vectors[0][i], vectors[1][i], vectors[2][i]], scale = dot(vector, b) / a[i][i];
      for (let k = 0; k < 3; k++) x[k] += vector[k] * scale;
    }
    return x;
  };
}

// Offset every shared node once. A boundary node shared by two panels remains
// on both offset face planes; independently square-cut boundary edges would
// otherwise produce different ends for the same joint.
function offsetNetwork(prepared) {
  const nodes = new Map();
  for (const panel of prepared) if (panel) for (const ring of panel.rings) ring.world.forEach((p, i) => {
    const k = ring.keys[i];
    if (!nodes.has(k)) nodes.set(k, { base: p, panels: new Set() });
    nodes.get(k).panels.add(panel.index);
    if (ring.boundaryPlanes[i]) nodes.get(k).boundary = ring.boundaryPlanes[i];
  });
  for (const node of nodes.values()) {
    const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], zero = [0, 0, 0], slope = [0, 0, 0];
    const base = node.boundary ? add(node.base, mul(node.boundary.normal, node.boundary.d - dot(node.boundary.normal, node.base))) : node.base;
    for (const index of node.panels) {
      const { normal, origin } = prepared[index].plane;
      const residual = dot(normal, sub(origin, base));
      const tangent = node.boundary ? sub(normal, mul(node.boundary.normal, dot(normal, node.boundary.normal))) : normal;
      for (let i = 0; i < 3; i++) {
        zero[i] += tangent[i] * residual; slope[i] += tangent[i];
        for (let j = 0; j < 3; j++) matrix[i][j] += tangent[i] * tangent[j];
      }
    }
    const solve = symmetricSolver(matrix);
    node.origin = add(base, solve(zero)); node.direction = solve(slope);
    node.cache = new Map();
    node.point = z => {
      if (node.cache.has(z)) return node.cache.get(z);
      const point = add(node.origin, mul(node.direction, z));
      for (const index of node.panels) {
        const plane = prepared[index].plane, residual = Math.abs(dot(plane.normal, sub(point, plane.origin)) - z);
        if (residual > 0.15) throw new Error('The incident offset faces do not meet at this thickness. Reshape the junction.');
      }
      if (distance(point, node.base) > Math.max(500, Math.abs(z) * 20)) throw new Error('A nearly parallel junction makes an excessively long mitre.');
      node.cache.set(z, point); return point;
    };
  }
  for (const panel of prepared) if (panel) panel.rings.forEach(ring => { ring.offsetNodes = ring.keys.map(k => nodes.get(k)); });
}

function slice(panel, z, inset) {
  return panel.rings.map(ring => {
    const baseRing = ring.offsetNodes.map(node => {
      const d = sub(node.point(z), panel.plane.origin);
      return [dot(d, panel.plane.u), dot(d, panel.plane.v)];
    });
    if (inset < EPS) return baseRing;
    const cuts = baseRing.map((start, i) => {
      const end = baseRing[(i + 1) % baseRing.length], size = Math.hypot(end[0] - start[0], end[1] - start[1]);
      if (size < EPS) throw new Error('An offset boundary edge collapses.');
      const a = (end[1] - start[1]) / size, b = (start[0] - end[0]) / size;
      return { a, b, d: a * start[0] + b * start[1] - inset };
    });
    return baseRing.map((base, i) => {
    const previous = cuts[(i + baseRing.length - 1) % baseRing.length], current = cuts[i];
    const p = previous.d, q = current.d;
    const det = previous.a * current.b - previous.b * current.a;
    if (Math.abs(det) < 1e-9) {
      const align = previous.a * current.a + previous.b * current.b;
      if (align < 0 || Math.abs(p - q) > 1e-4) throw new Error('A nearly straight corner has incompatible mitres.');
      const shift = q - current.a * base[0] - current.b * base[1];
      return [base[0] + current.a * shift, base[1] + current.b * shift];
    }
    const result = [(p * current.b - previous.b * q) / det, (previous.a * q - p * current.a) / det];
    if (!result.every(Number.isFinite)) throw new Error('A mitre corner is not finite.');
    return result;
    });
  });
}

function world(panel, xy, z) {
  const { origin, u, v, normal } = panel.plane;
  return add(add(add(origin, mul(u, xy[0])), mul(v, xy[1])), mul(normal, z));
}

function levels(thickness, radius, segments, roundoverSide) {
  const h = thickness / 2;
  if (radius < EPS) return [{ z: -h, inset: 0 }, { z: h, inset: 0 }];
  const result = [];
  if (roundoverSide === 'positive') result.push({ z: -h, inset: 0 });
  else for (let i = segments; i >= 0; i--) {
    const angle = Math.PI / 2 * i / segments;
    result.push({ z: -h + radius - radius * Math.sin(angle), inset: radius * (1 - Math.cos(angle)) });
  }
  if (roundoverSide === 'negative') result.push({ z: h, inset: 0 });
  else for (let i = 0; i <= segments; i++) {
    const angle = Math.PI / 2 * i / segments;
    const level = { z: h - radius + radius * Math.sin(angle), inset: radius * (1 - Math.cos(angle)) };
    if (Math.abs(level.z - result.at(-1).z) > EPS || Math.abs(level.inset - result.at(-1).inset) > EPS) result.push(level);
  }
  return result;
}

function capTriangles(rings) {
  const flat = rings.flat(), offsets = [];
  let count = 0;
  for (const ring of rings) { offsets.push(count); count += ring.length; }
  // Almost collinear triples can make Earcut emit a numerical sliver as well
  // as the spanning cap edge. Remove them for triangulation, then restore
  // every original boundary vertex when splitting the cap edges below.
  const retained = rings.map((ring, ri) => {
    const ids = ring.map((_, i) => offsets[ri] + i);
    for (let i = 0; ids.length > 3 && i < ids.length;) {
      const a = flat[ids[(i + ids.length - 1) % ids.length]], b = flat[ids[i]], c = flat[ids[(i + 1) % ids.length]];
      const dx = c[0] - a[0], dy = c[1] - a[1], length2 = dx * dx + dy * dy;
      const t = ((b[0] - a[0]) * dx + (b[1] - a[1]) * dy) / length2;
      if (t > 0 && t < 1 && Math.abs(turn(a, c, b)) < 1e-7 * Math.max(1, Math.sqrt(length2))) {
        ids.splice(i, 1); i = 0;
      } else i++;
    }
    return ids;
  });
  const mapping = retained.flat(), vectors = retained.map(ids => ids.map(id => new Vector2(...flat[id])));
  const triangulated = ShapeUtils.triangulateShape(vectors[0], vectors.slice(1)).map(triangle => triangle.map(i => mapping[i]));
  // Earcut can omit collinear boundary vertices. Split those cap edges so the
  // caps still share every side-face edge, with no topological T-junctions.
  const chain = (a, b) => {
    for (let ri = 0; ri < rings.length; ri++) {
      const start = offsets[ri], end = start + rings[ri].length;
      if (a < start || a >= end || b < start || b >= end) continue;
      const n = end - start;
      for (const direction of [1, -1]) {
        const path = [a]; let current = a;
        for (let i = 0; i < n; i++) {
          current = start + (current - start + direction + n) % n;
          path.push(current);
          if (current === b) break;
        }
        if (path.at(-1) !== b || path.length <= 2) continue;
        const pa = flat[a], pb = flat[b], dx = pb[0] - pa[0], dy = pb[1] - pa[1], length2 = dx * dx + dy * dy;
        if (path.slice(1, -1).every(index => {
          const p = flat[index], t = ((p[0] - pa[0]) * dx + (p[1] - pa[1]) * dy) / length2;
          return Math.abs(turn(pa, pb, p)) < 1e-7 * Math.max(1, Math.sqrt(length2)) && t > 0 && t < 1;
        })) return path;
      }
    }
    return [a, b];
  };
  const triangles = [];
  for (const t of triangulated) {
    const paths = [chain(t[0], t[1]), chain(t[1], t[2]), chain(t[2], t[0])];
    if (paths.every(p => p.length === 2)) { triangles.push(t); continue; }
    const center = [0, 0];
    for (const i of t) { center[0] += flat[i][0] / 3; center[1] += flat[i][1] / 3; }
    const ci = flat.length; flat.push(center);
    for (const path of paths) for (let j = 0; j + 1 < path.length; j++) triangles.push([path[j], path[j + 1], ci]);
  }
  if (!triangles.length) throw new Error('The panel face could not be triangulated.');
  return { positions: flat, triangles, boundaryCount: count };
}

function topology(positions, triangles) {
  const edges = new Map();
  for (const t of triangles) {
    if (length(cross(sub(positions[t[1]], positions[t[0]]), sub(positions[t[2]], positions[t[0]]))) < 1e-9) return 'A solid contains a collapsed face.';
    for (let j = 0; j < 3; j++) {
      const a = t[j], b = t[(j + 1) % 3], k = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edges.has(k)) edges.set(k, []);
      edges.get(k).push(a < b ? 1 : -1);
    }
  }
  for (const uses of edges.values()) if (uses.length !== 2 || uses[0] + uses[1] !== 0) return 'The solid has an unmatched or inconsistently oriented edge.';
  return null;
}

function boundaryViolation(panel, positions) {
  let maximum = 0;
  for (const plane of panel.cell.supportPlanes || []) for (const point of positions) maximum = Math.max(maximum, -(dot(plane.normal, point) - plane.d) * plane.support);
  return maximum;
}

function buildAtRadius(panel, thickness, radius, requestedRadius, segments, roundoverSide) {
  const slices = levels(thickness, radius, segments, roundoverSide);
  const sliceRings = slices.map(level => { const rings = slice(panel, level.z, level.inset); checkRings(rings); return rings; });
  const positions = [], triangles = [], triangleGroups = [], trianglePatches = [];
  const ringOffsets = [], ringVertexCount = panel.rings.reduce((n, r) => n + r.xy.length, 0);
  let offset = 0;
  for (const ring of panel.rings) { ringOffsets.push(offset); offset += ring.xy.length; }
  for (let li = 0; li < slices.length; li++) {
    const level = slices[li], rings = sliceRings[li];
    for (let ri = 0; ri < rings.length; ri++) for (let vi = 0; vi < rings[ri].length; vi++) {
      positions.push(level.inset < EPS ? [...panel.rings[ri].offsetNodes[vi].point(level.z)] : world(panel, rings[ri][vi], level.z));
    }
  }
  for (let li = 0; li + 1 < slices.length; li++) for (let ri = 0; ri < panel.rings.length; ri++) {
    const ring = panel.rings[ri], base = li * ringVertexCount + ringOffsets[ri], next = (li + 1) * ringVertexCount + ringOffsets[ri];
    for (let i = 0; i < ring.xy.length; i++) {
      const j = (i + 1) % ring.xy.length;
      const a = base + i, b = base + j, c = next + j, d = next + i;
      if (edgeKey(key(positions[a]), key(positions[c])) < edgeKey(key(positions[b]), key(positions[d]))) triangles.push([a, b, c], [a, c, d]);
      else triangles.push([a, b, d], [b, c, d]);
      triangleGroups.push('edge', 'edge');
      // Each outline edge defines one physical wall and its rounded strips.
      // Keep this identity separate from the manufacturing face categories so
      // the renderer never smooths across two distinct side or mitre faces.
      trianglePatches.push(`side:${ri}:${i}`, `side:${ri}:${i}`);
    }
  }
  const caps = {};
  for (const [name, li, sign] of [['negative', 0, -1], ['positive', slices.length - 1, 1]]) {
    const cap = capTriangles(sliceRings[li]), base = li * ringVertexCount;
    const localToGlobal = cap.positions.map((xy, i) => i < ringVertexCount ? base + i : positions.push(world(panel, xy, slices[li].z)) - 1);
    const triangleIndices = [];
    for (const t of cap.triangles) {
      const points = t.map(i => cap.positions[i]);
      const ordered = Math.sign(turn(...points)) === sign ? t : [t[0], t[2], t[1]];
      triangleIndices.push(triangles.length);
      triangles.push(ordered.map(i => localToGlobal[i]));
      triangleGroups.push(name);
      trianglePatches.push(name);
    }
    caps[name] = { z: slices[li].z, inset: slices[li].inset, triangleIndices,
      boundaryLoops: panel.rings.map((ring, ri) => ring.xy.map((_, i) => base + ringOffsets[ri] + i)),
      vertexIndices: localToGlobal, localPositions: cap.positions };
  }
  if (boundaryViolation(panel, positions) > 1e-5) throw new Error('The stock extends past a planar source opening. Reshape the nearby cells or reduce thickness.');
  const problem = topology(positions, triangles);
  if (problem) throw new Error(problem);
  // Unrounded mitre corners are used to verify that neighboring stock pieces
  // share complete joint faces, not merely the same infinite cutting plane.
  const envelope = [-thickness / 2, thickness / 2].map(z => panel.rings.map(ring => ring.offsetNodes.map(node => node.point(z))));
  const cornerAnchors = panel.rings.flatMap((ring, ri) => ring.ids.flatMap((id, vi) => {
    const sharedVertexId = panel.cell.sharedVertexIds?.[id];
    return Number.isInteger(sharedVertexId) ? [{ sharedVertexId,
      positive: [...envelope[1][ri][vi]], negative: [...envelope[0][ri][vi]],
    }] : [];
  }));
  return { id: panel.cell.id, positions, triangles, triangleGroups, trianglePatches, caps, plane: panel.plane,
    valid: true, issues: [], actualRadius: radius, requestedRadius, radiusClamped: radius + EPS < requestedRadius,
    thickness, roundoverSide, maxJointMismatch: 0, cuts: panel.cuts, planarityError: panel.planarity,
    cornerAnchors, _envelope: envelope, _rings: panel.rings };
}

function buildOne(panel, thickness, requestedRadius, segments, roundoverSide) {
  const radius = Math.min(requestedRadius, thickness / 2, panel.minEdge * 0.2);
  const build = value => buildAtRadius(panel, thickness, value, requestedRadius, segments, roundoverSide);
  try { return build(radius); }
  catch (error) {
    if (radius === 0) throw error;
    // Thickness must work on its own. Validate the complete unrounded mesh
    // before reducing only the optional rounding; a bad base still fails.
    const unrounded = build(0);
    let low = 0, high = radius, best = unrounded;
    for (let i = 0; i < 18; i++) {
      const middle = (low + high) / 2;
      // A valid outline is insufficient: cap triangulation and side strips
      // can still collapse. Retain only fully validated candidate meshes.
      try { const candidate = build(middle); low = middle; best = candidate; }
      catch { high = middle; }
    }
    return low < 1e-6 ? unrounded : best;
  }
}

function prepareStockNetwork(cells, options, onInvalid) {
  const prepared = cells.map((cell, i) => {
    try { return prepare(cell, i); } catch (error) { onInvalid(i, error.message); return null; }
  });
  let edges = adjacency(prepared);
  const { signs, conflicts, components } = orient(prepared, edges);
  const center = options.outwardCenter;
  const hasCenter = Array.isArray(center) && center.length === 3 && center.every(Number.isFinite);
  for (const component of components) {
    let score = 0;
    if (hasCenter) for (const index of component) {
      const panel = prepared[index], weight = Math.abs(panel.rings.reduce((sum, ring) => sum + area(ring.xy), 0));
      score += weight * signs.get(index) * dot(panel.plane.normal, sub(panel.plane.origin, center));
    }
    const flip = (hasCenter && score < 0 ? -1 : 1) * (options.flipDirection ? -1 : 1);
    if (flip === -1) for (const index of component) signs.set(index, -signs.get(index));
  }
  for (let i = 0; i < prepared.length; i++) if (prepared[i]) {
    if (conflicts.has(i)) { onInvalid(i, 'The neighboring faces cannot be oriented consistently.'); prepared[i] = null; }
    else if (signs.get(i) === -1) prepared[i] = prepare(cells[i], i, -1);
  }
  edges = adjacency(prepared);
  offsetNetwork(prepared);
  return { prepared, edges };
}

/** Fast unrounded stock checks for fitting. This checks both offset outlines
 * using the same coupled nodes as solid construction, without triangulation
 * or rounding. Passing this check does not replace final mesh validation. */
export function inspectStockEnvelopes(cells, options = {}) {
  const thickness = Number(options.thickness ?? 40), results = new Array(cells.length);
  if (!(thickness > 0) || !Number.isFinite(thickness)) throw new Error('Use a positive finite stock thickness.');
  const fail = (i, message) => { results[i] = { id: cells[i].id, valid: false, issues: [message], envelopes: [] }; };
  const { prepared, edges } = prepareStockNetwork(cells, options, fail);
  for (let i = 0; i < prepared.length; i++) if (prepared[i]) {
    const envelopes = []; let violation = 0;
    try {
      Object.assign(prepared[i], sidePlanes(prepared[i], prepared, edges));
      for (const z of [-thickness / 2, thickness / 2]) envelopes.push(slice(prepared[i], z, 0));
      violation = boundaryViolation(prepared[i], envelopes.flatMap((rings, side) => rings.flat().map(xy => world(prepared[i], xy, (side ? 1 : -1) * thickness / 2))));
      if (violation > 1e-5) throw new Error('The stock extends past a planar source opening. Reshape the nearby cells or reduce thickness.');
      for (const rings of envelopes) checkRings(rings);
      results[i] = { id: cells[i].id, valid: true, issues: [], envelopes, boundaryViolation: violation };
    } catch (error) { results[i] = { id: cells[i].id, valid: false, issues: [error.message], envelopes, boundaryViolation: violation }; }
  }
  return results;
}

/**
 * Build cuttable flat stock solids with shared mitre planes and inward edge
 * roundovers. Positive/negative cap metadata is retained for a later real
 * carving operation; no curved-face shading is substituted for geometry.
 */
export function buildPanelSolids(cells, options = {}) {
  const thickness = Number(options.thickness ?? 40), radius = Number(options.radius ?? 2);
  const segments = Math.max(2, Math.min(12, Math.round(options.segments || 4)));
  const roundoverSide = ['positive', 'negative'].includes(options.roundoverSide) ? options.roundoverSide : 'both';
  const invalid = (cell, message) => ({ id: cell.id, positions: [], triangles: [], triangleGroups: [], valid: false, issues: [message], thickness, requestedRadius: radius, actualRadius: 0, maxJointMismatch: 0 });
  if (!Array.isArray(cells)) throw new Error('Expected panel cells.');
  if (!(thickness > 0) || !(radius >= 0) || !Number.isFinite(thickness + radius)) return cells.map(cell => invalid(cell, 'Use a positive thickness and a nonnegative edge radius.'));
  const results = new Array(cells.length);
  const { prepared, edges } = prepareStockNetwork(cells, options, (i, message) => { results[i] = invalid(cells[i], message); });
  for (let i = 0; i < prepared.length; i++) if (prepared[i]) {
    try {
      Object.assign(prepared[i], sidePlanes(prepared[i], prepared, edges));
      results[i] = buildOne(prepared[i], thickness, radius, segments, roundoverSide);
    } catch (error) { results[i] = invalid(cells[i], error.message); }
  }
  const jointTolerance = Number(options.jointTolerance ?? 0.2);
  for (const pair of edges.values()) if (pair.length === 2) {
    const [a, b] = pair, sa = results[a.panel], sb = results[b.panel];
    if (!sa?._envelope || !sb?._envelope) continue;
    let mismatch = 0;
    for (let side = 0; side < 2; side++) for (const endpoint of [a.from, a.to]) {
      const ia = sa._rings[a.ri].keys.indexOf(endpoint), ib = sb._rings[b.ri].keys.indexOf(endpoint);
      mismatch = Math.max(mismatch, distance(sa._envelope[side][a.ri][ia], sb._envelope[side][b.ri][ib]));
    }
    sa.maxJointMismatch = Math.max(sa.maxJointMismatch, mismatch); sb.maxJointMismatch = Math.max(sb.maxJointMismatch, mismatch);
  }
  for (const solid of results) {
    if (solid.valid && solid.maxJointMismatch > jointTolerance) {
      solid.valid = false;
      solid.issues.push(`A joint corner differs by ${solid.maxJointMismatch.toFixed(2)} mm at this thickness. Reshape the meeting before fabrication.`);
    }
    delete solid._envelope; delete solid._rings;
  }
  return results;
}

/** Shared stock-joint anchors for editing handles. Rounding opens a small
 * groove around these original joint corners; each owner keeps its own entry
 * so the preview can apply the matching panel's exploded offset. */
export function attachSolidCornerPositions(corners, solids) {
  const byId = new Map(solids.map(solid => [solid.id, solid]));
  return corners.map(corner => {
    const solidPositions = [];
    if (Number.isInteger(corner.sharedVertexId)) for (const cellId of corner.cells) {
      const solid = byId.get(cellId);
      if (!solid?.positions?.length) continue;
      const anchor = solid.cornerAnchors?.find(item => item.sharedVertexId === corner.sharedVertexId);
      if (!anchor) continue;
      const carvedSide = solid.carved ? solid.carvedSide || 'negative' : null;
      for (const side of ['positive', 'negative']) {
        // The carved face has moved away from the stock envelope. Its opposite
        // face remains fixed and supplies a reliable editing handle.
        if (side === carvedSide || !anchor[side]?.every(Number.isFinite)) continue;
        solidPositions.push({ position: [...anchor[side]], cellId, side });
      }
    }
    return { ...corner, solidPositions,
      solidPosition: solidPositions.length ? [...solidPositions[0].position] : null,
      solidCellId: solidPositions[0]?.cellId ?? null,
    };
  });
}

const numeric = value => { if (!Number.isFinite(value)) throw new Error('A solid contains an invalid coordinate.'); return String(Number(value.toFixed(6))); };

export function exportSolidsOBJ(solids, options = {}) {
  if (!solids?.length) throw new Error('There are no solid panels to export.');
  if (solids.some(s => !s.valid)) throw new Error('Some solid panels need reshaping before export.');
  const explode = Number(options.explode || 0);
  const lines = ['# Panel Workbench solid panels', '# Units: millimetres', solids.some(s => s.carved) ? '# Flat exterior caps, carved interior faces, and matching joint meshes.' : '# Mitred flat stock with inward edge roundovers.'];
  let offset = 1;
  solids.forEach((solid, index) => {
    const label = `P${String(Number.isInteger(solid.id) ? solid.id + 1 : index + 1).padStart(3, '0')}`;
    const normal = solid.plane?.normal || options.cells?.find(c => c.id === solid.id)?.plane.normal || [0, 0, 0];
    lines.push(`o ${label}`, `g ${label}`);
    for (const p of solid.positions) lines.push(`v ${p.map((v, axis) => numeric(v + normal[axis] * explode)).join(' ')}`);
    for (const t of solid.triangles) lines.push(`f ${t.map(i => i + offset).join(' ')}`);
    offset += solid.positions.length;
  });
  return `${lines.join('\n')}\n`;
}

export function exportSolidsSTL(solids, options = {}) {
  if (!solids?.length || solids.some(s => !s.valid)) throw new Error('Choose valid solid panels to export.');
  const explode = Number(options.explode || 0), lines = ['solid panels_mm'];
  for (const solid of solids) {
    const direction = solid.plane?.normal || [0, 0, 0];
    for (const t of solid.triangles) {
      const p = t.map(i => add(solid.positions[i], mul(direction, explode)));
      const normal = unit(cross(sub(p[1], p[0]), sub(p[2], p[0])));
      lines.push(`facet normal ${normal.map(numeric).join(' ')}`, ' outer loop');
      for (const v of p) lines.push(`  vertex ${v.map(numeric).join(' ')}`);
      lines.push(' endloop', 'endfacet');
    }
  }
  lines.push('endsolid panels_mm');
  return `${lines.join('\n')}\n`;
}
