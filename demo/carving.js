// The supplied mesh describes the finished inside surface. This operation moves
// real mesh vertices; the outside cap stays flat and its vertices stay fixed.
// Shared stock vertices use one projection and one blending weight, so mating
// faces generated with the same triangulation remain coincident after carving.
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => Math.hypot(...a);
const pointKey = p => p.map(x => Math.round(x * 1e5)).join(',');
const edgeKey = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const triangleNormal = (p, t) => cross(sub(p[t[1]], p[t[0]]), sub(p[t[2]], p[t[0]]));

// Closest point on a triangle, including edges and vertices (Voronoi regions).
function closestTriangle(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, mul(sub(c, b), (d4 - d3) / (d4 - d3 + d5 - d6)));
  const denominator = va + vb + vc;
  if (Math.abs(denominator) < 1e-20) return a;
  return add(a, add(mul(ab, vb / denominator), mul(ac, vc / denominator)));
}

function makeReferenceQuery(model) {
  if (!model?.vertices?.length || !model.triangles?.length) throw new Error('Load the finished inside mesh before carving.');
  const triangles = model.triangles.map(t => t.map(i => model.vertices[i])).filter(p =>
    p.every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) && norm(cross(sub(p[1], p[0]), sub(p[2], p[0]))) > 1e-10);
  if (!triangles.length) throw new Error('The inside mesh has no usable surface.');
  function build(ids) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const id of ids) for (const p of triangles[id]) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    const node = { min, max };
    if (ids.length <= 12) { node.ids = ids; return node; }
    const spans = sub(max, min), axis = spans.indexOf(Math.max(...spans));
    ids.sort((a, b) => triangles[a].reduce((s, p) => s + p[axis], 0) - triangles[b].reduce((s, p) => s + p[axis], 0));
    const middle = Math.floor(ids.length / 2);
    node.left = build(ids.slice(0, middle)); node.right = build(ids.slice(middle));
    return node;
  }
  const tree = build(triangles.map((_, i) => i));
  function boxDistance(p, node) {
    let total = 0;
    for (let k = 0; k < 3; k++) { const d = p[k] < node.min[k] ? node.min[k] - p[k] : Math.max(0, p[k] - node.max[k]); total += d * d; }
    return total;
  }
  return p => {
    let best = null, distance2 = Infinity;
    function visit(node) {
      if (boxDistance(p, node) > distance2 + 1e-12) return;
      if (node.ids) {
        for (const i of node.ids) {
          const q = closestTriangle(p, ...triangles[i]), d = sub(p, q), d2 = dot(d, d);
          if (d2 < distance2) { distance2 = d2; best = q; }
        }
      } else {
        const leftFirst = boxDistance(p, node.left) <= boxDistance(p, node.right);
        visit(leftFirst ? node.left : node.right); visit(leftFirst ? node.right : node.left);
      }
    }
    visit(tree);
    return { point: [...best], distance: Math.sqrt(distance2) };
  };
}

function subdivide(solid, passes) {
  const positions = solid.positions.map(p => [...p]);
  let triangles = solid.triangles.map(t => [...t]), groups = [...solid.triangleGroups];
  let patches = solid.trianglePatches?.slice();
  const capLoops = Object.fromEntries(['positive', 'negative'].map(side => [side, solid.caps[side].boundaryLoops.map(loop => [...loop])]));
  for (let pass = 0; pass < passes; pass++) {
    const midpoints = new Map(), nextTriangles = [], nextGroups = [], nextPatches = patches ? [] : undefined;
    const midpoint = (a, b) => {
      const key = edgeKey(a, b);
      if (!midpoints.has(key)) { midpoints.set(key, positions.length); positions.push(mul(add(positions[a], positions[b]), 0.5)); }
      return midpoints.get(key);
    };
    triangles.forEach(([a, b, c], i) => {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      nextTriangles.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      nextGroups.push(groups[i], groups[i], groups[i], groups[i]);
      if (patches) nextPatches.push(patches[i], patches[i], patches[i], patches[i]);
    });
    for (const side of ['positive', 'negative']) capLoops[side] = capLoops[side].map(loop => loop.flatMap((id, i) => [id, midpoint(id, loop[(i + 1) % loop.length])]));
    triangles = nextTriangles; groups = nextGroups; patches = nextPatches;
  }
  const caps = {};
  for (const side of ['positive', 'negative']) {
    const triangleIndices = groups.flatMap((group, i) => group === side ? [i] : []);
    const vertexIndices = [...new Set(triangleIndices.flatMap(i => triangles[i]))];
    caps[side] = { ...solid.caps[side], triangleIndices, vertexIndices, boundaryLoops: capLoops[side] };
  }
  return { ...solid, positions, triangles, triangleGroups: groups, ...(patches ? { trianglePatches: patches } : {}), caps, issues: [...(solid.issues || [])] };
}

function closedTopology(positions, triangles) {
  const edges = new Map();
  for (const t of triangles) {
    if (t.length !== 3 || t.some(i => !Number.isInteger(i) || !positions[i])) return false;
    for (let j = 0; j < 3; j++) {
      const a = t[j], b = t[(j + 1) % 3], k = edgeKey(a, b);
      if (!edges.has(k)) edges.set(k, []);
      edges.get(k).push(a < b ? 1 : -1);
    }
  }
  return [...edges.values()].every(uses => uses.length === 2 && uses[0] !== uses[1]);
}

function segmentCross(a, b, c, d) {
  const turn = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const ab = turn(a, b, c), ac = turn(a, b, d), cd = turn(c, d, a), ce = turn(c, d, b);
  return ab * ac < -1e-12 && cd * ce < -1e-12;
}

function boundaryCrosses(solid, cap) {
  const { origin, u, v } = solid.plane;
  const rings = cap.boundaryLoops.map(loop => loop.map(i => { const d = sub(solid.positions[i], origin); return [dot(d, u), dot(d, v)]; }));
  const edges = rings.flatMap((ring, ri) => ring.map((p, i) => ({ a: p, b: ring[(i + 1) % ring.length], ri, i, n: ring.length })));
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i], b = edges[j];
    if (a.ri === b.ri && ((a.i + 1) % a.n === b.i || (b.i + 1) % b.n === a.i)) continue;
    if (segmentCross(a.a, a.b, b.a, b.b)) return true;
  }
  return false;
}

/**
 * Approximate the finished inside with a subdivided triangle cap. The result
 * reports sample-to-reference error and stock-depth failures. It does not add
 * material where the input stock is too thin, and export must reject !valid.
 * Use buildPanelSolids(...,{roundoverSide:'positive'}) for negative-side carving.
 */
export function buildCarvedPanels(solids, cells, model, options = {}) {
  if (!Array.isArray(solids)) throw new Error('Expected solid panels to carve.');
  const minimumThickness = Number(options.minimumThickness ?? 12);
  const innerSide = options.innerSide === 'positive' ? 'positive' : 'negative';
  const outerSide = innerSide === 'negative' ? 'positive' : 'negative';
  const sign = outerSide === 'positive' ? 1 : -1;
  const passes = clamp(Math.round(Number(options.subdivisions ?? 2)), 0, 3);
  const tolerance = Number(options.tolerance ?? 0.15);
  if (!(minimumThickness > 0) || !Number.isFinite(minimumThickness + passes + tolerance)) throw new Error('Set a positive minimum wood thickness.');
  const closest = makeReferenceQuery(model);
  const prepared = solids.map(solid => {
    if (!solid.valid || !solid.caps?.[innerSide] || !solid.caps?.[outerSide]) return { ...solid, issues: [...(solid.issues || [])], carved: false, stockValid: false };
    if (solid.caps[innerSide].inset > 1e-6) return { ...solid, valid: false, carved: false, stockValid: false,
      issues: [...(solid.issues || []), 'Round only the outside edges when carving the inside face.'] };
    return subdivide(solid, passes);
  });
  const mapping = new Map();
  for (const solid of prepared) {
    if (!solid.valid || !solid.caps) continue;
    solid._beforeCarve = solid.positions.map(p => [...p]);
    const inner = new Set(solid.caps[innerSide].vertexIndices), outer = new Set(solid.caps[outerSide].vertexIndices);
    const h = solid.thickness / 2, radius = Math.max(0, solid.actualRadius || 0);
    for (let i = 0; i < solid.positions.length; i++) {
      const p = solid.positions[i], z = sign * dot(sub(p, solid.plane.origin), solid.plane.normal);
      const weight = inner.has(i) ? 1 : outer.has(i) ? 0 : clamp((h - radius - z) / Math.max(1e-9, 2 * h - radius), 0, 1);
      // Transport the movement of the inside stock face through the depth.
      // Projecting each side point separately would make a flat source buckle
      // the side wall: its lower rows would move past one another.
      const anchor = sub(p, mul(solid.plane.normal, sign * (z + h)));
      const key = pointKey(p);
      if (!mapping.has(key) || weight < mapping.get(key).weight) mapping.set(key, { source: p, anchor, weight });
    }
  }
  for (const entry of mapping.values()) {
    entry.target = entry.weight < 1e-12 ? entry.source : add(entry.source, mul(sub(closest(entry.anchor).point, entry.anchor), entry.weight));
  }
  for (const solid of prepared) {
    if (!solid._beforeCarve) continue;
    const before = solid._beforeCarve; delete solid._beforeCarve;
    const outerVertices = new Set(solid.caps[outerSide].vertexIndices);
    solid.positions = before.map((p, i) => outerVertices.has(i) ? [...p] : [...mapping.get(pointKey(p)).target]);
    const insideCap = solid.caps[innerSide], h = solid.thickness / 2;
    let minRemaining = Infinity, maxRemaining = -Infinity, maxCarveDepth = 0, stockOverrun = 0, maxSurfaceError = 0;
    for (const i of insideCap.vertexIndices) {
      const z = sign * dot(sub(solid.positions[i], solid.plane.origin), solid.plane.normal);
      const remaining = h - z;
      minRemaining = Math.min(minRemaining, remaining); maxRemaining = Math.max(maxRemaining, remaining);
      maxCarveDepth = Math.max(maxCarveDepth, z + h);
      stockOverrun = Math.max(stockOverrun, -h - z, z - h, 0);
      maxSurfaceError = Math.max(maxSurfaceError, closest(solid.positions[i]).distance);
    }
    let folded = false, collapsed = false;
    for (let i = 0; i < solid.triangles.length; i++) {
      const t = solid.triangles[i], n = triangleNormal(solid.positions, t), old = triangleNormal(before, t);
      if (norm(n) < 1e-8) collapsed = true;
      if (dot(n, old) <= 0) folded = true;
      if (solid.triangleGroups[i] === innerSide) {
        const center = mul(add(add(solid.positions[t[0]], solid.positions[t[1]]), solid.positions[t[2]]), 1 / 3);
        maxSurfaceError = Math.max(maxSurfaceError, closest(center).distance);
      }
    }
    const closed = closedTopology(solid.positions, solid.triangles), crossing = boundaryCrosses(solid, insideCap);
    solid.carved = true; solid.carvedSide = innerSide;
    solid.minRemainingThickness = minRemaining; solid.maxRemainingThickness = maxRemaining;
    solid.maxCarveDepth = maxCarveDepth; solid.stockOverrun = stockOverrun;
    solid.maxSurfaceError = maxSurfaceError; solid.carveSubdivisions = passes;
    solid.stockValid = stockOverrun <= tolerance && minRemaining >= minimumThickness - tolerance;
    solid.carvingValidation = { closed, collapsed, folded, boundaryCrossing: crossing, stockDepth: solid.stockValid, sampleSurfaceError: maxSurfaceError };
    if (stockOverrun > tolerance) solid.issues.push(`The inside surface exceeds the stock by ${stockOverrun.toFixed(1)} mm. Increase the thickness or reshape the panel.`);
    if (minRemaining < minimumThickness - tolerance) solid.issues.push(`Only ${minRemaining.toFixed(1)} mm of wood remains; ${minimumThickness.toFixed(1)} mm is required.`);
    if (!closed) solid.issues.push('Carving produced an unmatched or inconsistently oriented solid edge.');
    if (collapsed || folded || crossing) solid.issues.push('The carved face folds or collapses. Use smaller cells or adjust this panel.');
    solid.valid = solid.valid && solid.stockValid && closed && !collapsed && !folded && !crossing;
    // Side faces can become curved, while still matching the adjacent panel.
    // This is a geometry study; tool access and machining strategy are external.
    solid.curvedJointFaces = true;
    solid.cutsAreReferenceOnly = true;
    for (const side of ['positive', 'negative']) {
      const cap = solid.caps[side];
      cap.localPositions = cap.vertexIndices.map(i => { const d = sub(solid.positions[i], solid.plane.origin); return [dot(d, solid.plane.u), dot(d, solid.plane.v)]; });
    }
    solid.caps[innerSide] = { ...insideCap, carved: true, zRange: [h - maxRemaining, h - minRemaining].map(z => z * sign).sort((a, b) => a - b) };
  }
  return prepared;
}

export function summarizeCarving(solids) {
  const carved = solids.filter(s => s.carved);
  return { carvedCount: carved.length, invalidCount: solids.filter(s => !s.valid).length,
    minRemainingThickness: carved.length ? Math.min(...carved.map(s => s.minRemainingThickness)) : null,
    maxCarveDepth: carved.length ? Math.max(...carved.map(s => s.maxCarveDepth)) : null,
    maxSurfaceError: carved.length ? Math.max(...carved.map(s => s.maxSurfaceError)) : null,
    stockValid: solids.length > 0 && solids.every(s => s.stockValid) };
}
