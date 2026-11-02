import { ShapeUtils, Vector2 } from './vendor/three.core.js';
import { inspectStockEnvelopes, buildPanelSolids } from './solids.js';
import { readPanelOffsets } from './panel-offsets.js';

// A shared vertex is solved once for every panel touching it. Independent
// flattening is deliberately not used here: neighbouring edges remain identical.
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map(v => v * s);
const norm = a => Math.sqrt(dot(a, a));
const normalize = a => scale(a, 1 / (norm(a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const key = p => p.map(x => Math.round(x * 1e5)).join(',');
const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;

function eigen(matrix) {
  const a = matrix.map(r => [...r]), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iteration = 0; iteration < 28; iteration++) {
    let p = 0, q = 1;
    if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; }
    if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
    if (Math.abs(a[p][q]) < 1e-13 * Math.max(1, Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]))) break;
    const t = .5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(t), s = Math.sin(t);
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      if (k !== p && k !== q) {
        const x = a[k][p], y = a[k][q];
        a[k][p] = a[p][k] = c * x - s * y;
        a[k][q] = a[q][k] = s * x + c * y;
      }
      const x = v[k][p], y = v[k][q];
      v[k][p] = c * x - s * y; v[k][q] = s * x + c * y;
    }
  }
  return [0, 1, 2].map(i => ({ value: a[i][i], vector: v.map(row => row[i]) })).sort((a, b) => a.value - b.value);
}

function planeFor(ids, positions, reference, fixedOrigin = null) {
  const origin = fixedOrigin ? [...fixedOrigin] : [0, 0, 0], covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  if (!fixedOrigin) for (const id of ids) for (let k = 0; k < 3; k++) origin[k] += positions[id][k] / ids.length;
  for (const id of ids) {
    const d = sub(positions[id], origin);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) covariance[a][b] += d[a] * d[b] / ids.length;
  }
  const eig = eigen(covariance);
  let normal = normalize(eig[0].vector);
  if (dot(normal, reference) < 0) normal = scale(normal, -1);
  let u = normalize(eig[2].vector);
  if (u.find(x => Math.abs(x) > .3) < 0) u = scale(u, -1);
  const v = normalize(cross(normal, u)); u = normalize(cross(v, normal));
  return { origin, normal, u, v, d: dot(normal, origin), degenerate: eig[1].value < 1e-8 };
}

// A boundary face must contain its source-rim chord. Merely intersecting
// freely fitted faces with the rim plane can move a near-parallel junction
// a long way sideways along that plane.
function fitAroundBoundary(ids, positions, reference, boundary) {
  if (!boundary) return planeFor(ids, positions, reference);
  const { origin, tangent, rimNormal } = boundary, side = normalize(cross(tangent, rimNormal));
  let aa = 0, ab = 0, bb = 0;
  for (const id of ids) {
    const delta = sub(positions[id], origin), a = dot(delta, rimNormal), b = dot(delta, side);
    aa += a * a; ab += a * b; bb += b * b;
  }
  const angle = .5 * Math.atan2(2 * ab, aa - bb);
  let normal = normalize(add(scale(rimNormal, -Math.sin(angle)), scale(side, Math.cos(angle))));
  if (dot(normal, reference) < 0) normal = scale(normal, -1);
  const u = tangent, v = normalize(cross(normal, u));
  return { origin, normal, u, v, d: dot(normal, origin), degenerate: aa + bb < 1e-8 };
}

function intersection(planes, anchor, regularization = 0, boundary = null) {
  if (boundary) anchor = add(anchor, scale(boundary.normal, boundary.d - dot(boundary.normal, anchor)));
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const plane of planes) {
    const residual = plane.d - dot(plane.normal, anchor);
    const n = boundary ? sub(plane.normal, scale(boundary.normal, dot(plane.normal, boundary.normal))) : plane.normal;
    for (let i = 0; i < 3; i++) {
      b[i] += n[i] * residual;
      for (let j = 0; j < 3; j++) a[i][j] += n[i] * n[j];
    }
  }
  const eig = eigen(a), max = Math.max(1, eig[2].value);
  let result = [...anchor];
  for (const e of eig) {
    if (e.value < max * 1e-10 && !regularization) continue;
    result = add(result, scale(e.vector, dot(e.vector, b) / (Math.max(0, e.value) + regularization)));
  }
  return result;
}

function segmentDistance(point, a, b) {
  const d = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(point, a), d) / (dot(d, d) || 1)));
  return norm(sub(point, add(a, scale(d, t))));
}

function simplifyPath(ids, points, tolerance) {
  if (ids.length <= 2) return ids;
  let largest = -1, split = 0;
  for (let i = 1; i < ids.length - 1; i++) {
    const d = segmentDistance(points[ids[i]], points[ids[0]], points[ids[ids.length - 1]]);
    if (d > largest) { largest = d; split = i; }
  }
  if (largest <= tolerance) return [ids[0], ids[ids.length - 1]];
  return [...simplifyPath(ids.slice(0, split + 1), points, tolerance).slice(0, -1), ...simplifyPath(ids.slice(split), points, tolerance)];
}

function buildNetwork(cells, straightness, corners = []) {
  const points = [], map = new Map(), owners = [], neighbors = [], edges = new Map();
  const rawLoops = cells.map((cell, ci) => cell.loops.map(loop => loop.map(i => {
    const p = cell.positions[i], k = key(p);
    if (!map.has(k)) { map.set(k, points.length); points.push(p); owners.push(new Set()); neighbors.push(new Set()); }
    const id = map.get(k); owners[id].add(ci); return id;
  })));
  for (let ci = 0; ci < rawLoops.length; ci++) for (const loop of rawLoops[ci]) for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length]; if (a === b) continue;
    const k = edgeKey(a, b);
    if (!edges.has(k)) edges.set(k, { a, b, owners: new Set() });
    edges.get(k).owners.add(ci); neighbors[a].add(b); neighbors[b].add(a);
  }
  // A planar source opening is a trim plane, shared by the complete rim.
  // Detect it before simplifying paths, so tessellation and panel ownership
  // cannot make separate, slightly different rim planes.
  const boundaryNeighbors = new Map();
  for (const edge of edges.values()) if (edge.owners.size === 1) {
    for (const [a, b] of [[edge.a, edge.b], [edge.b, edge.a]]) {
      if (!boundaryNeighbors.has(a)) boundaryNeighbors.set(a, new Set());
      boundaryNeighbors.get(a).add(b);
    }
  }
  const boundaryFor = new Map(), boundaryComponents = [], boundaryPaths = new Map(), boundaryOwners = new Map(), seenBoundary = new Set();
  for (const start of boundaryNeighbors.keys()) {
    if (seenBoundary.has(start)) continue;
    const ids = [start]; seenBoundary.add(start);
    for (let i = 0; i < ids.length; i++) for (const next of boundaryNeighbors.get(ids[i])) if (!seenBoundary.has(next)) {
      seenBoundary.add(next); ids.push(next);
    }
    if (ids.length < 3 || ids.some(id => boundaryNeighbors.get(id).size !== 2)) continue;
    const plane = planeFor(ids, points, [0, 0, 1]);
    const span = Math.max(1, ...ids.map(id => norm(sub(points[id], plane.origin))));
    const tolerance = Math.max(1e-5, span * 1e-7);
    if (plane.degenerate || ids.some(id => Math.abs(dot(plane.normal, points[id]) - plane.d) > tolerance)) continue;
    // A planar sheet's perimeter lies in its own face plane: it must remain
    // free to extrude. A trim applies only where every incident source face
    // meets the opening plane at a stable, nonparallel angle.
    if (ids.some(id => [...owners[id]].some(ci => Math.abs(dot(normalize(cells[ci].plane.normal), plane.normal)) > .995))) continue;
    let minimum = Infinity, maximum = -Infinity;
    for (const cell of cells) for (const point of cell.positions) {
      const distance = dot(plane.normal, point) - plane.d;
      minimum = Math.min(minimum, distance); maximum = Math.max(maximum, distance);
    }
    const support = minimum >= -tolerance ? 1 : maximum <= tolerance ? -1 : 0;
    const constraint = { normal: plane.normal, d: plane.d, support };
    for (const id of ids) boundaryFor.set(id, constraint);
    boundaryComponents.push(constraint);
    const component = new Set(ids);
    boundaryPaths.set(constraint, [...edges.values()].filter(edge => edge.owners.size === 1 && component.has(edge.a)).map(edge => [points[edge.a], points[edge.b]]));
    boundaryOwners.set(constraint, new Set(ids.flatMap(id => [...owners[id]])));
  }
  const keep = new Set();
  for (let i = 0; i < points.length; i++) if (owners[i].size >= 3 || neighbors[i].size !== 2) keep.add(i);
  // Editing handles refer to exact source vertices. Preserve them through
  // perimeter simplification so each view can show the same logical corner.
  for (const corner of corners) {
    const id = map.get(key(corner.position));
    if (id !== undefined) keep.add(id);
  }
  const target = Math.sqrt(cells.reduce((sum, c) => sum + c.area, 0) / cells.length);
  const tolerance = Math.max(.5, target * (.002 + .07 * straightness));
  const visited = new Set();
  function walk(start, next) {
    const path = [start]; let previous = start, current = next;
    const firstEdge = edges.get(edgeKey(start, next));
    while (true) {
      visited.add(edgeKey(previous, current)); path.push(current);
      if (keep.has(current) || current === start) break;
      const choices = [...neighbors[current]].filter(x => x !== previous);
      if (choices.length !== 1 || visited.has(edgeKey(current, choices[0]))) break;
      previous = current; current = choices[0];
    }
    let simplified;
    if (path.at(-1) === path[0]) {
      const middle = Math.floor((path.length - 1) / 2);
      simplified = [...simplifyPath(path.slice(0, middle + 1), points, tolerance).slice(0, -1), ...simplifyPath(path.slice(middle), points, tolerance)];
      if (new Set(simplified).size < 3) simplified.push(path[Math.floor(path.length / 3)], path[Math.floor(path.length * 2 / 3)]);
    } else simplified = firstEdge.owners.size === 1 ? simplifyPath(path, points, tolerance) : [path[0], path.at(-1)];
    for (const id of simplified) keep.add(id);
  }
  for (const start of [...keep]) for (const next of neighbors[start]) if (!visited.has(edgeKey(start, next))) walk(start, next);
  for (const edge of edges.values()) if (!visited.has(edgeKey(edge.a, edge.b))) walk(edge.a, edge.b);
  // Retain at least three distinct vertices for every ring. Shared additions
  // enter all incident cells, so no hanging vertices are introduced.
  for (const loops of rawLoops) for (const loop of loops) {
    if (new Set(loop.filter(i => keep.has(i))).size < 3) {
      for (const f of [0, 1 / 3, 2 / 3]) keep.add(loop[Math.floor(loop.length * f)]);
    }
  }
  const retained = [...keep], remap = new Map(retained.map((id, i) => [id, i]));
  const loops = rawLoops.map(rings => rings.map(loop => {
    const out = loop.filter(id => keep.has(id)).map(id => remap.get(id));
    return out.filter((id, i) => id !== out[(i + out.length - 1) % out.length]);
  }));
  const sharedOwners = retained.map(() => new Set());
  loops.forEach((rings, ci) => rings.flat().forEach(id => sharedOwners[id].add(ci)));
  return { points: retained.map(id => [...points[id]]), loops, owners: sharedOwners, tolerance, sourceVertexCount: points.length, boundaryPlanes: retained.map(id => boundaryFor.get(id) || null), boundaryComponents, boundaryPaths, boundaryOwners, boundaryTolerance: tolerance };
}

function area2(ring) {
  return ring.reduce((sum, a, i) => { const b = ring[(i + 1) % ring.length]; return sum + a[0] * b[1] - b[0] * a[1]; }, 0) * .5;
}

function inside(point, ring) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function crossingPairs(rings) {
  const edges = [];
  const pairs = [];
  rings.forEach((ring, r) => ring.forEach((a, i) => edges.push({ a, b: ring[(i + 1) % ring.length], r, i })));
  const side = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i], b = edges[j];
    if (a.r === b.r && (Math.abs(a.i - b.i) === 1 || Math.abs(a.i - b.i) === rings[a.r].length - 1)) continue;
    if (side(a.a, a.b, b.a) * side(a.a, a.b, b.b) < -1e-7 && side(b.a, b.b, a.a) * side(b.a, b.b, a.b) < -1e-7) pairs.push([a, b]);
  }
  return pairs;
}

function crosses(rings) { return crossingPairs(rings).length > 0; }

function touchesOrOverlaps(rings) {
  const epsilon = 1e-6, edges = [];
  rings.forEach((ring, r) => ring.forEach((a, i) => edges.push({ a, b: ring[(i + 1) % ring.length], r, i, count: ring.length })));
  const side = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const onSegment = (p, a, b) => Math.abs(side(a, b, p)) <= epsilon * Math.hypot(b[0] - a[0], b[1] - a[1]) &&
    p[0] >= Math.min(a[0], b[0]) - epsilon && p[0] <= Math.max(a[0], b[0]) + epsilon && p[1] >= Math.min(a[1], b[1]) - epsilon && p[1] <= Math.max(a[1], b[1]) + epsilon;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i], b = edges[j];
    const adjacent = a.r === b.r && (Math.abs(a.i - b.i) === 1 || Math.abs(a.i - b.i) === a.count - 1);
    if (adjacent) {
      const lineTolerance = epsilon * Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]);
      if (Math.abs(side(a.a, a.b, b.a)) > lineTolerance || Math.abs(side(a.a, a.b, b.b)) > lineTolerance) continue;
      const axis = Math.abs(a.b[0] - a.a[0]) > Math.abs(a.b[1] - a.a[1]) ? 0 : 1;
      const overlap = Math.min(Math.max(a.a[axis], a.b[axis]), Math.max(b.a[axis], b.b[axis])) - Math.max(Math.min(a.a[axis], a.b[axis]), Math.min(b.a[axis], b.b[axis]));
      if (overlap > epsilon) return true;
    } else if (onSegment(a.a, b.a, b.b) || onSegment(a.b, b.a, b.b) || onSegment(b.a, a.a, a.b) || onSegment(b.b, a.a, a.b)) return true;
  }
  return false;
}

/** Search in face-plane space. Shared vertices are recomputed from all their
 * incident planes for every candidate; a vertex-only correction would be
 * undone by the shared stock offsets and could conceal a nonplanar panel. */
function repairCoupledPlanes({ original, network, anchors, planes, groups, groupFor, adjacent,
  displacementLimit, planarityTolerance, options, initialCells, buildCells, groupBoundaries, boundaryTargets, initialPoints, initialUnstable }) {
  const thickness = Number(options.thickness), characteristicSize = Math.sqrt(original.reduce((sum, cell) => sum + cell.area, 0) / original.length);
  const budget = Math.max(0, Math.min(480, Math.floor(Number(options.repairBudget ?? 240)) || 0));
  const moveLimit = Math.min(displacementLimit * .25, characteristicSize * .15);
  const shiftLimit = Math.min(moveLimit * .5, thickness * .3), angleLimit = Math.cos(Math.PI / 60);
  const supports = network.boundaryComponents.filter(plane => plane.support);
  const stockOptions = { thickness, outwardCenter: options.outwardCenter, flipDirection: options.flipDirection };
  const metrics = { attempts: 0, acceptedSteps: 0, applied: false, warmStartAccepted: false,
    initialInvalidFlat: initialCells.filter(cell => !cell.valid).length, finalInvalidFlat: initialCells.filter(cell => !cell.valid).length,
    initialInvalidStock: 0, finalInvalidStock: 0, recoveredPanels: 0, recoveredPanelIds: [], maxVertexMove: 0, maxVertexMoveLimit: moveLimit,
    initialMaxReferenceDisplacement: Math.max(...initialCells.map(cell => cell.maxReferenceDisplacement)) };
  const baselinePoints = initialPoints;
  const evaluate = trialPlanes => {
    metrics.attempts++;
    const unstable = new Set(); let overflow = 0;
    const points = anchors.map((anchor, id) => {
      const exact = intersection([...network.owners[id]].map(ci => trialPlanes[ci]), anchor, 0, network.boundaryPlanes[id]);
      const excess = Math.max(norm(sub(exact, anchor)) - displacementLimit, norm(sub(exact, baselinePoints[id])) - moveLimit);
      if (exact.some(value => !Number.isFinite(value)) || excess > 0) {
        unstable.add(id); overflow += Number.isFinite(excess) ? Math.min(displacementLimit, excess) : displacementLimit;
        return baselinePoints[id];
      }
      return exact;
    });
    // An already unstable fit still deserves a bounded repair attempt. Its
    // diagnostic vertices remain explicitly invalid until the plane equations
    // meet within both bounds; no clipped vertex becomes a fabricated part.
    // Stable cold fits retain the original, stricter candidate search path.
    if (unstable.size && !initialUnstable.size) return null;
    let crossings = 0, penetration = 0;
    const measureCrossings = rings => {
      const pairs = crossingPairs(rings); crossings += pairs.length;
      const distanceToLine = (p, a, b) => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
      for (const [a, b] of pairs) penetration += Math.min(distanceToLine(a.a, b.a, b.b), distanceToLine(a.b, b.a, b.b), distanceToLine(b.a, a.a, a.b), distanceToLine(b.b, a.a, a.b));
      return pairs.length;
    };
    const flatBad = new Set();
    const cells = original.map((source, ci) => {
      const plane = trialPlanes[ci], flatPositions = network.loops[ci].flat().map(id => points[id]);
      const rings = network.loops[ci].map(ring => ring.map(id => { const d = sub(points[id], plane.origin); return [dot(d, plane.u), dot(d, plane.v)]; }));
      const crossingCount = measureCrossings(rings);
      const boundaryViolation = Math.max(0, ...flatPositions.flatMap(point => supports.map(plane => -(dot(plane.normal, point) - plane.d) * plane.support)));
      const rimAdjustment = Math.max(0, ...network.loops[ci].flat().filter(id => boundaryTargets[id]).map(id => norm(sub(points[id], boundaryTargets[id])) - network.boundaryTolerance));
      penetration += boundaryViolation + rimAdjustment;
      const invalid = network.loops[ci].flat().some(id => unstable.has(id)) || source.sourceComponentCount > 1 || plane.degenerate || boundaryViolation > 1e-5 || rimAdjustment > 1e-5
        || flatPositions.some(point => Math.abs(dot(point, plane.normal) - plane.d) > planarityTolerance)
        || rings.some(ring => ring.length < 3 || Math.abs(area2(ring)) < 1e-8)
        || crossingCount || touchesOrOverlaps(rings) || rings.slice(1).some(ring => !inside(ring[0], rings[0]));
      if (invalid) flatBad.add(ci);
      let offset = 0;
      return { id: source.id, flatPositions, supportPlanes: supports, boundaryPlanes: network.loops[ci].flat().map(id => network.boundaryPlanes[id]), loops: network.loops[ci].map(ring => ring.map(() => offset++)), plane, valid: !invalid };
    });
    const envelopes = inspectStockEnvelopes(cells, stockOptions), bad = new Set();
    envelopes.forEach((stock, ci) => { if (!stock.valid) bad.add(ci); penetration += stock.boundaryViolation || 0; for (const rings of stock.envelopes) measureCrossings(rings); });
    const drift = points.reduce((sum, point, id) => { const d = sub(point, anchors[id]); return sum + dot(d, d); }, 0) / points.length;
    return { planes: trialPlanes, points, bad, flatBad, unstable, score: overflow * 10 + bad.size * 1e6 + flatBad.size * 1e4 + crossings * 100 + penetration + drift * 1e-6 };
  };
  let best = evaluate(planes);
  if (!best) {
    metrics.initialInvalidStock = metrics.finalInvalidStock = inspectStockEnvelopes(initialCells, stockOptions).filter(stock => !stock.valid).length;
    return { metrics };
  }
  metrics.initialInvalidStock = metrics.finalInvalidStock = best.bad.size;
  if (!best.bad.size || budget < 2) return { metrics };
  const baselinePlanes = planes;
  const take = candidate => {
    if (!candidate || [...candidate.bad].some(ci => !best.bad.has(ci)) || [...candidate.flatBad].some(ci => !best.flatBad.has(ci)) || candidate.score >= best.score - 1e-5) return false;
    best = candidate; metrics.acceptedSteps++; return true;
  };
  const planeWithinBounds = (plane, initial) => dot(plane.normal, initial.normal) >= angleLimit && norm(sub(plane.origin, initial.origin)) <= shiftLimit;
  const assignGroup = (trial, group, plane) => {
    for (const ci of groups[group]) trial[ci] = dot(plane.normal, original[ci].plane.normal) >= 0 ? plane
      : { ...plane, normal: scale(plane.normal, -1), v: scale(plane.v, -1), d: -plane.d };
  };
  const neighboringGroups = () => {
    const result = new Set([...best.bad].map(ci => groupFor[ci]));
    for (const ci of best.bad) for (const other of adjacent[ci]) result.add(groupFor[other]);
    return [...result];
  };
  // Start from the same cold solution for every edit/reopen. A locally better
  // warm proposal can consume the search budget on a worse path, so cached
  // planes do not influence this bounded deterministic repair.
  const firstStep = Math.min(2, thickness * .05, shiftLimit / 4);
  for (const step of [firstStep, firstStep * 4, firstStep * .25]) {
    for (const group of neighboringGroups()) {
      if (metrics.attempts >= budget || !best.bad.size) break;
      if (groups[group].some(ci => options.fixedPanelIds?.has(original[ci].id))) continue;
      for (const axis of (groupBoundaries[group] ? ['v'] : ['offset', 'u', 'v'])) for (const sign of [-1, 1]) {
        if (metrics.attempts >= budget) break;
        const ci = groups[group][0], old = best.planes[ci], delta = sign * step;
        const normal = axis === 'offset' ? old.normal : normalize(add(old.normal, scale(old[axis], delta / characteristicSize)));
        const origin = axis === 'offset' ? add(old.origin, scale(normal, delta)) : old.origin;
        const u = normalize(sub(old.u, scale(normal, dot(old.u, normal)))), v = normalize(cross(normal, u));
        const plane = { ...old, normal, origin, u, v, d: dot(normal, origin) };
        if (!planeWithinBounds(plane, baselinePlanes[ci])) continue;
        const trial = best.planes.slice(); assignGroup(trial, group, plane);
        take(evaluate(trial));
      }
    }
  }
  if (!metrics.acceptedSteps) return { metrics };
  const repairedCells = buildCells(best.points, best.planes, best.unstable);
  const originalBad = new Set(initialCells.filter(cell => !cell.valid).map(cell => cell.id));
  const repairedBad = new Set(repairedCells.filter(cell => !cell.valid).map(cell => cell.id));
  // The fast envelope objective never grants exportability. Before committing
  // plane changes, validate complete unrounded meshes and keep every formerly
  // valid panel valid; final rounded/carved construction still runs afterward.
  const baseStock = buildPanelSolids(initialCells, { ...stockOptions, radius: 0 });
  const finalStock = buildPanelSolids(repairedCells, { ...stockOptions, radius: 0 });
  const baseBadStock = new Set(baseStock.filter(stock => !stock.valid).map(stock => stock.id));
  const finalBadStock = new Set(finalStock.filter(stock => !stock.valid).map(stock => stock.id));
  metrics.initialInvalidStock = metrics.finalInvalidStock = baseBadStock.size;
  if ([...repairedBad].some(id => !originalBad.has(id)) || [...finalBadStock].some(id => !baseBadStock.has(id))
    || finalBadStock.size >= baseBadStock.size && repairedBad.size >= originalBad.size) return { metrics };
  metrics.applied = true; metrics.finalInvalidFlat = repairedBad.size; metrics.finalInvalidStock = finalBadStock.size;
  metrics.recoveredPanelIds = [...baseBadStock].filter(id => !finalBadStock.has(id));
  metrics.recoveredPanels = metrics.recoveredPanelIds.length;
  metrics.maxVertexMove = Math.max(...best.points.map((point, id) => norm(sub(point, baselinePoints[id]))));
  return { metrics, cells: repairedCells, points: best.points, planes: best.planes, unstable: best.unstable };
}

/** Offsets are authored against a fresh unoffset fit, never against the last
 * displayed candidate. Reopening, Undo and repeated edits therefore cannot
 * accumulate displacement. The source graph remains the authoritative layout. */
export function fitSharedPanels(result, options = {}) {
  if (!result?.cells?.length) return result;
  const offsets = readPanelOffsets(options.panelOffsets, result.surfaceCells || result.cells);
  const { offsetFeedback: previousOffsetFeedback, ...input } = result;
  const { offsetPanelCount: previousOffsetCount, offsetCoupledPanelIds: previousCoupledIds, ...sourceStats } = result.stats || {};
  input.stats = sourceStats;
  const baseline = fitPanels(input, { ...options, offsetBaseline: undefined, offsetRegion: undefined });
  const references = new Map(baseline.cells.map(cell => [cell.id, {
    origin: [...cell.plane.origin], normal: [...cell.plane.normal],
  }]));
  let fitted = offsets.length ? fitPanels(input, { ...options, offsetBaseline: baseline, panelOffsets: offsets }) : baseline;
  if (offsets.length && fitted.stats.invalidCellCount) {
    const region = coplanarOffsetRegion(baseline, offsets);
    if (region) {
      const alternative = fitPanels(input, { ...options, offsetBaseline: baseline, panelOffsets: offsets, offsetRegion: region });
      // A broad fallback is useful only if it restores every flat panel and
      // produces valid stock. It never hides a different unresolved region.
      const stock = Number.isFinite(options.thickness) && options.thickness > 0
        ? buildPanelSolids(alternative.cells, { thickness: options.thickness, radius: 0, outwardCenter: options.outwardCenter, flipDirection: options.flipDirection }) : [];
      if (!alternative.stats.invalidCellCount && stock.every(panel => panel.valid)) {
        fitted = alternative;
        fitted.stats.offsetCoupledPanelIds = [...region.ids];
        fitted.offsetFeedback = [`To keep the shared edges flat, this calculation moved ${region.ids.size} panels on the same flat surface together. Use Undo if you wanted a local change.`];
      }
    }
  }
  const byId = new Map(offsets.map(offset => [offset.id, offset.offsetMm]));
  for (const cell of fitted.cells) {
    cell.offsetMm = byId.get(cell.id) || 0;
    cell.offsetReference = references.get(cell.id);
  }
  if (offsets.length) fitted.stats.offsetPanelCount = offsets.length;
  return fitted;
}

// A conservative fallback for a genuinely flat connected sheet. The general
// local solve can be ill-conditioned near zero curvature; a rigid translation
// is valid only when every authored offset in the component agrees. Never
// silently translate a curved shell, bridge disconnected components, or erase
// one of several conflicting offsets.
function coplanarOffsetRegion(baseline, offsets) {
  const byId = new Map(baseline.cells.map(cell => [cell.id, cell]));
  const first = byId.get(offsets[0].id), reference = first.plane;
  const ids = new Set([first.id]), queue = [first.id];
  for (let i = 0; i < queue.length; i++) for (const id of byId.get(queue[i]).neighbors || []) if (!ids.has(id) && byId.has(id)) { ids.add(id); queue.push(id); }
  if (offsets.some(item => !ids.has(item.id))) return null;
  if ([...ids].some(id => {
    const cell = byId.get(id);
    return !cell.valid || Math.abs(dot(cell.plane.normal, reference.normal)) < 1 - 1e-10
      || cell.flatPositions.some(point => Math.abs(dot(reference.normal, point) - reference.d) > 1e-5);
  })) return null;
  const translation = scale(reference.normal, offsets[0].offsetMm);
  if (offsets.some(item => Math.abs(dot(byId.get(item.id).plane.normal, translation) - item.offsetMm) > 1e-7)) return null;
  return { ids, translation };
}

function fitPanels(result, options = {}) {
  if (!result?.cells?.length) return result;
  const original = result.surfaceCells || result.cells;
  const straightness = Math.max(0, Math.min(1, options.straightness ?? .7));
  const iterations = Math.max(0, Math.min(1000, options.iterations ?? 300));
  const planarityTolerance = options.planarityTolerance ?? .25;
  const network = buildNetwork(original, straightness, result.corners);
  function enforceBoundary(point, id) {
    const boundary = network.boundaryPlanes[id];
    if (boundary) point = add(point, scale(boundary.normal, boundary.d - dot(boundary.normal, point)));
    for (const plane of network.boundaryComponents) {
      const distance = (dot(plane.normal, point) - plane.d) * plane.support;
      if (plane.support && distance < 0) point = add(point, scale(plane.normal, -distance * plane.support));
    }
    return point;
  }
  const offsetBaseline = options.offsetBaseline;
  const offsetById = new Map((offsetBaseline ? options.panelOffsets : []).map(item => [item.id, item.offsetMm]));
  const fixedPlanes = new Map();
  if (offsetBaseline) for (const cell of offsetBaseline.cells) if (offsetById.has(cell.id)) {
    const plane = cell.plane, origin = add(plane.origin, scale(plane.normal, offsetById.get(cell.id)));
    fixedPlanes.set(cell.id, { ...plane, origin, d: dot(plane.normal, origin) });
  }
  const anchors = network.points, faceIds = network.loops.map(rings => [...new Set(rings.flat())]);
  const affected = new Set(original.flatMap((cell, ci) => offsetById.has(cell.id) ? [ci] : []));
  const queue = [...affected];
  for (let i = 0; i < queue.length; i++) for (const id of faceIds[queue[i]]) for (const ci of network.owners[id]) if (!affected.has(ci)) { affected.add(ci); queue.push(ci); }
  const lockedPlanes = new Map(fixedPlanes);
  if (offsetBaseline) for (let ci = 0; ci < original.length; ci++) if (!affected.has(ci)) lockedPlanes.set(original[ci].id, offsetBaseline.cells[ci].plane);
  const affectedVertex = id => [...network.owners[id]].some(ci => affected.has(ci));
  // Start neighbours near a local displacement instead of leaving them on
  // parallel baseline planes whose intersections would be undefined. Only
  // authored planes are fixed; the smooth seed is not a validity relaxation.
  const solveAnchors = offsetBaseline ? offsetBaseline.sharedVertices.map((point, id) => {
    if (!affectedVertex(id)) return [...point];
    if (options.offsetRegion) return add(point, [...network.owners[id]].some(ci => options.offsetRegion.ids.has(original[ci].id)) ? options.offsetRegion.translation : [0, 0, 0]);
    let displacement = [0, 0, 0], weight = 0;
    for (const [panelId, plane] of fixedPlanes) {
      const cell = offsetBaseline.cells.find(cell => cell.id === panelId);
      const distance = Math.min(...cell.flatPositions.map(vertex => norm(sub(point, vertex))));
      const radius = Math.max(1, Math.sqrt(cell.area));
      const influence = Math.exp(-2 * (distance / radius) ** 2);
      displacement = add(displacement, scale(plane.normal, influence * offsetById.get(panelId)));
      weight += influence;
    }
    return add(point, scale(displacement, 1 / Math.max(1, weight)));
  }) : anchors;
  const displacementLimit = options.maxDisplacement ?? Math.sqrt(original.reduce((sum, c) => sum + c.area, 0) / original.length) * .75;
  let positions = solveAnchors.map((point, id) => {
    const delta = sub(point, anchors[id]), distance = norm(delta);
    return distance > displacementLimit ? add(anchors[id], scale(delta, displacementLimit / distance)) : [...point];
  });
  let planes;
  function compatibleBoundaryGroups(members) {
    for (const rim of network.boundaryComponents) {
      const participating = members.filter(ci => faceIds[ci].some(id => network.boundaryPlanes[id] === rim));
      if (participating.length < 2) continue;
      const ids = [...new Set(participating.flatMap(ci => faceIds[ci].filter(id => network.boundaryPlanes[id] === rim)))];
      const line = planeFor(ids, anchors, rim.normal);
      if (ids.some(id => norm(cross(sub(anchors[id], line.origin), line.u)) > 1e-5)) return false;
    }
    return true;
  }
  const boundaryDistance = (point, id) => {
    const rim = network.boundaryPlanes[id];
    return rim ? Math.min(...network.boundaryPaths.get(rim).map(([a, b]) => segmentDistance(point, a, b))) : 0;
  };
  // Near-flat areas in a rough mesh should share a plane. Otherwise three
  // numerically almost parallel planes can intersect arbitrarily far away.
  const groups = [], groupFor = new Array(original.length).fill(-1);
  const initialPlanes = faceIds.map((ids, i) => planeFor(ids, anchors, original[i].plane.normal));
  for (let ci = 0; ci < original.length; ci++) {
    if (groupFor[ci] !== -1) continue;
    const group = [ci], reference = initialPlanes[ci]; groupFor[ci] = groups.length;
    if (!offsetBaseline && original[ci].maxDeviation < 12) {
      for (let offset = 0; offset < group.length; offset++) {
        const adjacent = new Set(faceIds[group[offset]].flatMap(id => [...network.owners[id]]));
        for (const other of adjacent) {
          if (groupFor[other] !== -1 || original[other].maxDeviation >= 12) continue;
          const candidate = initialPlanes[other];
          if (Math.abs(dot(reference.normal, candidate.normal)) < Math.cos(5 * Math.PI / 180)) continue;
          if (Math.abs(dot(reference.normal, candidate.origin) - reference.d) > 5) continue;
          if (!compatibleBoundaryGroups([...group, other])) continue;
          group.push(other); groupFor[other] = groups.length;
        }
      }
    }
    groups.push(group);
  }
  let groupIds = groups.map(group => [...new Set(group.flatMap(ci => faceIds[ci]))]);
  let groupOrigins = groups.map(group => scale(group.reduce((sum, ci) => add(sum, original[ci].seed), [0, 0, 0]), 1 / group.length));
  function boundaryLines() {
    if (offsetBaseline) return groups.map(() => null);
    return groupIds.map((ids, group) => {
      const rims = new Map();
      for (const id of ids) {
        const rim = network.boundaryPlanes[id];
        if (!rim) continue;
        if (!rims.has(rim)) rims.set(rim, []);
        rims.get(rim).push(id);
      }
      const entries = [...rims].filter(([, points]) => points.length > 1);
      // A face spanning multiple openings may have incompatible source chords.
      // Keep those planes coupled to both rims instead of privileging one.
      if (entries.length !== 1) return null;
      const entry = entries[0];
      const [rim, boundaryIds] = entry;
      if ([...network.boundaryOwners.get(rim)].every(ci => groups[group].includes(ci))) return null;
      const endpoints = boundaryIds.filter(id => [...network.owners[id]].some(ci => !groups[group].includes(ci)));
      // Keep the exact authored ends of an opening segment. A least-squares
      // tangent can shift two nearly parallel neighbouring chords' crossing
      // far along the rim, despite a small normal fitting error.
      if (endpoints.length === 2) return { rim, origin: scale(add(anchors[endpoints[0]], anchors[endpoints[1]]), .5),
        tangent: normalize(sub(anchors[endpoints[1]], anchors[endpoints[0]])), rimNormal: rim.normal };
      const line = planeFor(boundaryIds, anchors, rim.normal);
      return { rim, origin: line.origin, tangent: line.u, rimNormal: rim.normal };
    });
  }
  let groupBoundaries = boundaryLines();
  function fittedPlanes(points) {
    const fitted = groupIds.map((ids, i) => groupBoundaries[i] ? fitAroundBoundary(ids, points, original[groups[i][0]].plane.normal, groupBoundaries[i])
      : planeFor(ids, points, original[groups[i][0]].plane.normal, options.anchorPlanesToSeeds ? groupOrigins[i] : null));
    return original.map((cell, ci) => {
      const plane = lockedPlanes.get(cell.id) || fitted[groupFor[ci]];
      if (dot(plane.normal, cell.plane.normal) >= 0) return plane;
      return { ...plane, normal: scale(plane.normal, -1), v: scale(plane.v, -1), d: -plane.d };
    });
  }
  let orderedEdges = [], shapeConstraints = [];
  function relax(count, anneal) {
    for (let iteration = 0; iteration < count; iteration++) {
      planes = fittedPlanes(positions);
      const regularization = (anneal ? .03 * (1 - iteration / Math.max(1, count)) ** (offsetBaseline ? 3 : 1) : 0) + (offsetBaseline ? 1e-8 : .0001);
      positions = positions.map((point, id) => {
        const candidate = intersection([...network.owners[id]].map(i => planes[i]), solveAnchors[id], regularization, network.boundaryPlanes[id]);
        const delta = sub(candidate, anchors[id]), distance = norm(delta);
        const bounded = distance > displacementLimit ? add(anchors[id], scale(delta, displacementLimit / distance)) : candidate;
        return add(scale(point, .2), scale(bounded, .8));
      });
      for (const constraint of shapeConstraints) {
        const direction = sub(positions[constraint.b], positions[constraint.a]);
        const normal = normalize(cross(planes[constraint.ci].normal, direction));
        const signed = dot(normal, sub(positions[constraint.p], positions[constraint.a]));
        const deficit = .1 - constraint.sign * signed;
        if (deficit <= 0) continue;
        const candidate = add(positions[constraint.p], scale(normal, constraint.sign * deficit));
        const delta = sub(candidate, anchors[constraint.p]), distance = norm(delta);
        positions[constraint.p] = distance > displacementLimit ? add(anchors[constraint.p], scale(delta, displacementLimit / distance)) : candidate;
      }
      for (let pass = 0; pass < 2; pass++) for (const edge of orderedEdges) {
        const squared = dot(edge.direction, edge.direction);
        const deficit = squared * .1 - dot(sub(positions[edge.b], positions[edge.a]), edge.direction);
        if (deficit <= 0) continue;
        const correction = scale(edge.direction, deficit / (2 * squared));
        positions[edge.a] = sub(positions[edge.a], correction);
        positions[edge.b] = add(positions[edge.b], correction);
        for (const id of [edge.a, edge.b]) {
          const delta = sub(positions[id], anchors[id]), distance = norm(delta);
          if (distance > displacementLimit) positions[id] = add(anchors[id], scale(delta, displacementLimit / distance));
        }
      }
      positions = positions.map(enforceBoundary);
    }
  }
  relax(iterations, true);
  // The solve can bring curved neighbours onto effectively the same plane.
  // Keeping separate, almost parallel equations then gives distant exact
  // intersections, even though their bounded preview is already nearly flat.
  // Coalesce only adjacent planes with both a small normal difference and a
  // measured fit of their complete boundary to one plane; solve the joined
  // system again rather than accepting nonplanar vertices or hiding failures.
  const initialGroupCount = groups.length;
  const adjacent = original.map((_, ci) => new Set(faceIds[ci].flatMap(id => [...network.owners[id]])));
  const coplanarTolerance = Math.max(1e-6, Math.min(1, planarityTolerance * 4));
  for (let pass = 0; pass < 3 && iterations > 0 && !offsetBaseline; pass++) {
    planes = fittedPlanes(positions);
    let joined = false;
    for (let ci = 0; ci < original.length; ci++) for (const other of adjacent[ci]) {
      const a = groupFor[ci], b = groupFor[other];
      if (a === b || Math.abs(dot(planes[ci].normal, planes[other].normal)) < Math.cos(.5 * Math.PI / 180)) continue;
      const members = [...groups[a], ...groups[b]], ids = [...new Set(members.flatMap(index => faceIds[index]))];
      if (!compatibleBoundaryGroups(members)) continue;
      const candidate = planeFor(ids, positions, planes[ci].normal);
      if (candidate.degenerate || ids.some(id => Math.abs(dot(candidate.normal, sub(positions[id], candidate.origin))) > coplanarTolerance)) continue;
      groups[a] = members; groups[b] = [];
      for (const id of members) groupFor[id] = a;
      joined = true;
    }
    if (!joined) break;
    const compact = groups.filter(group => group.length);
    groups.splice(0, groups.length, ...compact);
    groups.forEach((group, index) => group.forEach(ci => { groupFor[ci] = index; }));
    groupIds = groups.map(group => [...new Set(group.flatMap(ci => faceIds[ci]))]);
    groupOrigins = groups.map(group => scale(group.reduce((sum, ci) => add(sum, original[ci].seed), [0, 0, 0]), 1 / group.length));
    groupBoundaries = boundaryLines();
    relax(Math.min(iterations, 100), false);
  }
  // A short shared edge can reverse while neighbouring planes are settling,
  // crossing both incident panel outlines. Preserve its source direction in
  // the coupled solve; changing a final vertex alone would break flatness.
  planes = fittedPlanes(positions);
  const provisional = positions.map((point, id) => {
    const exact = intersection([...network.owners[id]].map(i => planes[i]), anchors[id], 0, network.boundaryPlanes[id]);
    return exact.every(Number.isFinite) && norm(sub(exact, anchors[id])) <= displacementLimit ? exact : point;
  });
  const crossingPanels = network.loops.map((rings, ci) => crosses(rings.map(ring => ring.map(id => {
    const delta = sub(provisional[id], planes[ci].origin);
    return [dot(delta, planes[ci].u), dot(delta, planes[ci].v)];
  }))));
  const candidateEdges = new Map();
  network.loops.forEach((rings, ci) => rings.forEach(ring => ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length], key = edgeKey(a, b);
    if (!candidateEdges.has(key)) candidateEdges.set(key, { a, b, owners: new Set(), direction: sub(anchors[b], anchors[a]) });
    candidateEdges.get(key).owners.add(ci);
  })));
  orderedEdges = [...candidateEdges.values()].filter(edge => edge.owners.size > 1 && [...edge.owners].some(ci => crossingPanels[ci]) &&
    dot(edge.direction, edge.direction) > 1e-8 && dot(sub(provisional[edge.b], provisional[edge.a]), edge.direction) < 0);
  if (orderedEdges.length) relax(Math.min(iterations, 300), false);
  // A crossing at a three-plane junction cannot be fixed by sliding that
  // final vertex: its planes must adapt together. Pick the smallest crossing
  // clearance correction and impose its half-plane during the same solve.
  // Free boundary points are excluded: pushing one across a narrow opening
  // can trade one crossing for another or reverse the opening's mouth.
  planes = fittedPlanes(positions);
  const shapeTrial = positions.map((point, id) => {
    const exact = intersection([...network.owners[id]].map(i => planes[i]), anchors[id], 0, network.boundaryPlanes[id]);
    return exact.every(Number.isFinite) && norm(sub(exact, anchors[id])) <= displacementLimit ? exact : point;
  });
  for (let ci = 0; ci < network.loops.length; ci++) {
    const rings = network.loops[ci];
    const project = id => { const delta = sub(shapeTrial[id], planes[ci].origin); return [dot(delta, planes[ci].u), dot(delta, planes[ci].v)]; };
    const side = (a, b, point) => (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    for (const [first, second] of crossingPairs(rings.map(ring => ring.map(project)))) {
      const ids = edge => [rings[edge.r][edge.i], rings[edge.r][(edge.i + 1) % rings[edge.r].length]];
      const [a, b] = ids(first), [c, d] = ids(second);
      const candidates = [[a, b, c, d], [b, a, c, d], [c, d, a, b], [d, c, a, b]].map(([p, q, a, b]) => {
        const aa = project(a), bb = project(b);
        return { ci, p, a, b, sign: Math.sign(side(aa, bb, project(q))), distance: Math.abs(side(aa, bb, project(p))) / Math.hypot(bb[0] - aa[0], bb[1] - aa[1]) };
      }).sort((a, b) => a.distance - b.distance);
      const best = candidates[0], matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (const owner of network.owners[best.p]) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) matrix[i][j] += planes[owner].normal[i] * planes[owner].normal[j];
      const values = eigen(matrix);
      if (best.sign && values[0].value >= Math.max(1, values[2].value) * 1e-10) shapeConstraints.push(best);
    }
  }
  if (shapeConstraints.length) relax(Math.min(iterations, 300), false);
  planes = fittedPlanes(positions);
  const unstableVertices = new Set();
  let solved = positions.map((point, id) => {
    const exact = intersection([...network.owners[id]].map(i => planes[i]), anchors[id], 0, network.boundaryPlanes[id]);
    if (norm(sub(exact, anchors[id])) > displacementLimit || exact.some(x => !Number.isFinite(x))) {
      unstableVertices.add(id);
      // Keep a shared, bounded preview and report the unmet planarity instead
      // of showing a many-metres-long spike or exporting a misleading panel.
      return point;
    }
    return exact;
  });
  const boundaryTargets = anchors.map((anchor, id) => {
    const rim = network.boundaryPlanes[id];
    if (!rim || offsetBaseline) return null;
    const chords = [...new Set([...network.owners[id]].map(ci => groupFor[ci]))].map(group => groupBoundaries[group]).filter(chord => chord?.rim === rim);
    const constraints = chords.map(chord => {
      const normal = normalize(cross(chord.tangent, rim.normal));
      return { normal, d: dot(normal, chord.origin) };
    });
    return intersection(constraints, anchor, 0, rim);
  });
  const boundaryAdjustment = (point, id) => boundaryTargets[id] ? norm(sub(point, boundaryTargets[id])) : 0;
  const maxBoundaryApproximation = Math.max(0, ...boundaryTargets.map((point, id) => point ? boundaryDistance(point, id) : 0));
  function buildCells(solved, planes, unstableVertices) {
    return original.map((source, ci) => {
      const plane = planes[ci], globalRings = network.loops[ci];
      const projectedRings = globalRings.map(ring => ring.map(id => { const d = sub(solved[id], plane.origin); return [dot(d, plane.u), dot(d, plane.v)]; }));
      const order = projectedRings.map((ring, i) => ({ i, area: Math.abs(area2(ring)) })).sort((a, b) => b.area - a.area).map(x => x.i);
      const rings = order.map(i => globalRings[i]), outline2d = order.map(i => projectedRings[i]);
      const sourcePositions = [], flatPositions = [], loops = [], sharedVertexIds = [];
      for (const ring of rings) {
        const indices = [];
        for (const id of ring) { indices.push(flatPositions.length); sourcePositions.push(anchors[id]); flatPositions.push(solved[id]); sharedVertexIds.push(id); }
        loops.push(indices);
      }
      const issues = [], offsetIssueCodes = [];
      if (source.sourceComponentCount > 1) issues.push('This cell contains separate source-surface pieces and cannot form one panel. Split its source region first.');
      const maxPlanarityError = Math.max(0, ...flatPositions.map(p => Math.abs(dot(plane.normal, p) - plane.d)));
      const maxReferenceDisplacement = Math.max(0, ...sharedVertexIds.map(id => norm(sub(solved[id], anchors[id]))));
      if (flatPositions.some(point => network.boundaryComponents.some(plane => plane.support && (dot(plane.normal, point) - plane.d) * plane.support < -1e-5))) issues.push('The fitted panel extends past a planar source opening. Move its centre or reshape the nearby corners.');
      if (sharedVertexIds.some(id => boundaryAdjustment(solved[id], id) > network.boundaryTolerance + 1e-5)) issues.push(`The fitted rim moves more than ${network.boundaryTolerance.toFixed(2)} mm beyond its source boundary chords. Reshape its nearby cells.`);
      if (maxPlanarityError > planarityTolerance) issues.push(`This panel is not flat enough (${maxPlanarityError.toFixed(2)} mm). Move its centre or change the size.`);
      if (sharedVertexIds.some(id => unstableVertices.has(id))) issues.push('The shared edges cannot meet nearby while keeping this panel flat. Move its centre or use smaller cells.');
      if (plane.degenerate || loops.some(ring => ring.length < 3) || outline2d.some(ring => Math.abs(area2(ring)) < 1e-8 || new Set(ring.map(key)).size < 3)) issues.push('This panel has a collapsed outline. Move its centre.');
      if (outline2d.slice(1).some(ring => !inside(ring[0], outline2d[0]))) issues.push('This cell has separate outlines. Move its centre or use smaller cells.');
      if (crosses(outline2d)) issues.push('The fitted outline crosses itself. Move its centre or use smaller cells.');
      else if (touchesOrOverlaps(outline2d)) issues.push('The fitted outline touches or overlaps itself. Its openings and boundary must remain separate.');
      let triangles = [];
      if (outline2d.length && loops.every(ring => ring.length >= 3)) {
        const vectors = outline2d.map(ring => ring.map(p => new Vector2(...p)));
        triangles = ShapeUtils.triangulateShape(vectors[0], vectors.slice(1));
        for (const triangle of triangles) {
          const [a, b, c] = triangle.map(i => flatPositions[i]);
          if (dot(cross(sub(b, a), sub(c, a)), plane.normal) < 0) [triangle[1], triangle[2]] = [triangle[2], triangle[1]];
        }
      }
      if (offsetBaseline) {
        const authoredMismatch = sharedVertexIds.some(id => [...network.owners[id]].some(owner => {
          const requested = fixedPlanes.get(original[owner].id);
          return requested && Math.abs(dot(requested.normal, solved[id]) - requested.d) > Math.min(planarityTolerance, 1e-4);
        }));
        if (maxPlanarityError > planarityTolerance || authoredMismatch) {
          offsetIssueCodes.push('offset-junction');
          issues.push('The calculation could not make these panels meet at this offset while staying flat. Reduce or reset nearby offsets, or divide a neighbouring cell.');
        }
        if (sharedVertexIds.some(id => unstableVertices.has(id))) {
          offsetIssueCodes.push('offset-distance');
          issues.push('This offset would push a shared corner too far from the shell. Reduce or reset the offset, or reshape the nearby cells.');
        }
        if (flatPositions.some(point => network.boundaryComponents.some(plane => plane.support && (dot(plane.normal, point) - plane.d) * plane.support < -1e-5))) {
          offsetIssueCodes.push('offset-opening');
          issues.push('This offset conflicts with an opening in the shell. Reduce or reset the offset, or reshape the cells beside the opening.');
        }
      }
      if (!triangles.length) issues.push('This panel has no usable area.');
      const expectedArea = outline2d.length ? Math.abs(area2(outline2d[0])) - outline2d.slice(1).reduce((sum, ring) => sum + Math.abs(area2(ring)), 0) : 0;
      const area = triangles.reduce((sum, ids) => { const [a, b, c] = ids.map(i => flatPositions[i]); return sum + norm(cross(sub(b, a), sub(c, a))) * .5; }, 0);
      if (Math.abs(area - expectedArea) > Math.max(1, Math.abs(expectedArea) * .001)) issues.push('The fitted outline could not be triangulated reliably.');
      const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
      for (const ring of outline2d) for (const p of ring) for (let k = 0; k < 2; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
      const deviations = source.positions.map(p => Math.abs(dot(plane.normal, p) - plane.d));
      return { ...source, positions: sourcePositions, flatPositions, loops, outline2d, triangles, plane,
        sharedVertexIds, supportPlanes: network.boundaryComponents.filter(plane => plane.support), boundaryPlanes: sharedVertexIds.map(id => network.boundaryPlanes[id]), area, sourceArea: source.area, width: max[0] - min[0], height: max[1] - min[1], bounds2d: { min, max },
        loopAreas: outline2d.map(area2), holeCount: Math.max(0, loops.length - 1), maxSeamGap: 0,
        maxDeviation: Math.max(0, ...deviations), rmsDeviation: Math.sqrt(deviations.reduce((sum, d) => sum + d * d, 0) / (deviations.length || 1)),
        maxPlanarityError, maxReferenceDisplacement, ...(offsetIssueCodes.length ? { offsetIssueCodes } : {}), valid: issues.length === 0, issues, fittedShared: true };
    });
  }
  let cells = buildCells(solved, planes, unstableVertices), repair = null;
  if (Number.isFinite(options.thickness) && options.thickness > 0 && iterations > 0) {
    const candidate = repairCoupledPlanes({ original, network, anchors, planes, groups, groupFor, adjacent,
      displacementLimit, planarityTolerance, options: { ...options, fixedPanelIds: new Set(lockedPlanes.keys()) }, initialCells: cells, buildCells, groupBoundaries, boundaryTargets, initialPoints: solved, initialUnstable: unstableVertices });
    repair = candidate.metrics;
    if (candidate.cells) { cells = candidate.cells; solved = candidate.points; planes = candidate.planes; unstableVertices.clear(); for (const id of candidate.unstable) unstableVertices.add(id); }
  }
  const edgeOwners = new Map(), vertexNeighbors = solved.map(() => new Set()), boundaryVertices = new Set();
  network.loops.forEach((rings, ci) => rings.forEach(ring => ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length], k = edgeKey(a, b);
    if (!edgeOwners.has(k)) edgeOwners.set(k, { a, b, owners: new Set() });
    edgeOwners.get(k).owners.add(ci);
  })));
  let seamLength = 0;
  for (const { a, b, owners } of edgeOwners.values()) {
    if (owners.size < 2) { boundaryVertices.add(a); boundaryVertices.add(b); }
    else { vertexNeighbors[a].add(b); vertexNeighbors[b].add(a); seamLength += norm(sub(solved[a], solved[b])); }
  }
  const junctions = [];
  for (let id = 0; id < solved.length; id++) {
    if (boundaryVertices.has(id) || vertexNeighbors[id].size < 3 || network.owners[id].size < 3) continue;
    const owners = [...network.owners[id]], referenceNormal = planes[owners[0]].normal;
    const normal = normalize(owners.reduce((sum, ci) => add(sum, scale(planes[ci].normal, dot(referenceNormal, planes[ci].normal) < 0 ? -1 : 1)), [0, 0, 0]));
    const directions = [...vertexNeighbors[id]].map(other => { const d = sub(solved[other], solved[id]); return normalize(sub(d, scale(normal, dot(d, normal)))); });
    const angles = [];
    for (let a = 0; a < directions.length; a++) for (let b = a + 1; b < directions.length; b++) angles.push(Math.acos(Math.max(-1, Math.min(1, dot(directions[a], directions[b])))) * 180 / Math.PI);
    const kind = directions.length === 3 ? (Math.max(...angles) > 160 ? 'T' : 'Y') : 'other';
    junctions.push({ position: solved[id], kind, angles, cells: owners.map(ci => cells[ci].id) });
  }
  const stats = { ...result.stats, ...(repair ? { repair } : {}), planarBoundaryCount: network.boundaryComponents.length, maxBoundaryDisplacement: Math.max(0, ...solved.map(boundaryDistance)), boundaryDisplacementLimit: offsetBaseline ? displacementLimit : maxBoundaryApproximation + network.boundaryTolerance, maxBoundaryApproximation, maxBoundaryAdjustment: Math.max(0, ...solved.map(boundaryAdjustment)), boundaryAdjustmentLimit: network.boundaryTolerance,
    maxSeamGap: 0, rmsSeamGap: 0, maxPlanarityError: Math.max(...cells.map(c => c.maxPlanarityError)),
    maxReferenceDisplacement: Math.max(...cells.map(c => c.maxReferenceDisplacement)),
    maxDeviation: Math.max(...cells.map(c => c.maxDeviation)),
    rmsDeviation: Math.sqrt(cells.reduce((sum, c) => sum + c.rmsDeviation ** 2 * c.area, 0) / (cells.reduce((sum, c) => sum + c.area, 0) || 1)),
    invalidCellCount: cells.filter(c => !c.valid).length, flatSurfaceArea: cells.reduce((sum, c) => sum + c.area, 0),
    sharedVertexCount: solved.length, sourceBoundaryVertexCount: network.sourceVertexCount,
    unstableVertexCount: unstableVertices.size, coplanarGroupCount: groups.length,
    refinedCoplanarGroupCount: initialGroupCount - groups.length,
    constrainedSharedEdgeCount: orderedEdges.length,
    constrainedCrossingCount: shapeConstraints.length,
    boundarySimplificationTolerance: network.tolerance, planarityTolerance, matchedSharedEdges: true,
    seamLength, junctionCount: junctions.length, tJunctionCount: junctions.filter(j => j.kind === 'T').length,
    yJunctionCount: junctions.filter(j => j.kind === 'Y').length,
  };
  const anchorIds = new Map(anchors.map((point, id) => [key(point), id]));
  const corners = result.corners?.map(corner => {
    const id = anchorIds.get(key(corner.position));
    const owners = id === undefined ? [] : [...network.owners[id]].map(ci => original[ci].id).sort((a, b) => a - b);
    const expected = [...corner.cells].sort((a, b) => a - b);
    const matched = id !== undefined && owners.length === expected.length && owners.every((owner, i) => owner === expected[i]);
    return { ...corner, sharedVertexId: matched ? id : null, flatPosition: matched ? [...solved[id]] : null };
  });
  return { ...result, ...(corners ? { corners } : {}), cells, surfaceCells: original, surfaceJunctions: result.surfaceJunctions || result.junctions, junctions, stats, sharedVertices: solved };
}
