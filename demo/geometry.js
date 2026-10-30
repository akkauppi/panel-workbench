/**
 * Surface-cell studies in the source model's millimetres.
 *
 * Each source triangle is clipped by interpolated graph-geodesic distances.
 * This partitions the supplied surface itself, following the surface around
 * folds and openings rather than jumping through the empty space between them.
 * Flat candidates are separate best-fit-plane projections, not a claim that
 * those independently flattened parts join without gaps.
 */

const cache = new WeakMap();
const WELD = 1e-5;
const AREA_EPS = 1e-9;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, x) => [a[0] * x, a[1] * x, a[2] * x];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.sqrt(dot(a, a));
const normalized = a => mul(a, 1 / (length(a) || 1));
const distance2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const positionKey = p => `${Math.round(p[0] / WELD)},${Math.round(p[1] / WELD)},${Math.round(p[2] / WELD)}`;
const edgeKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;

function disjointSet(size) {
  const parents = Int32Array.from({ length: size }, (_, i) => i);
  function find(i) {
    while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; }
    return i;
  }
  return { find, join(a, b) { a = find(a); b = find(b); if (a !== b) parents[b] = a; } };
}

function prepare(model) {
  if (cache.has(model)) return cache.get(model);
  if (!Array.isArray(model.vertices) || !Array.isArray(model.triangles)) throw new Error('The model needs vertices and triangles.');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of model.vertices) for (let k = 0; k < 3; k++) {
    if (!Number.isFinite(p[k])) throw new Error('The model contains an invalid coordinate.');
    min[k] = Math.min(min[k], p[k]);
    max[k] = Math.max(max[k], p[k]);
  }
  let area = 0;
  const centroidSum = [0, 0, 0];
  const triangles = [];
  for (const indices of model.triangles) {
    const points = indices.map(i => model.vertices[i]);
    if (points.length !== 3 || points.some(p => !p)) throw new Error('The model contains an invalid triangle.');
    const normal = cross(sub(points[1], points[0]), sub(points[2], points[0]));
    const triangleArea = length(normal) * 0.5;
    if (triangleArea < AREA_EPS) continue;
    const center = mul(add(add(points[0], points[1]), points[2]), 1 / 3);
    const radius = Math.sqrt(Math.max(...points.map(p => distance2(p, center))));
    area += triangleArea;
    for (let k = 0; k < 3; k++) centroidSum[k] += center[k] * triangleArea;
    triangles.push({ points, center, radius, area: triangleArea, cumulativeArea: area });
  }
  if (!triangles.length) throw new Error('The model has no usable surface triangles.');
  // Coincident vertices need not belong to the same surface fan. Joining them
  // by position alone lets distances jump through a point contact to another
  // sheet. Weld triangle corners only through their shared source edges.
  const fans = disjointSet(triangles.length * 3), sourceEdges = new Map();
  triangles.forEach((triangle, ti) => {
    const keys = triangle.points.map(positionKey);
    for (let k = 0; k < 3; k++) {
      const next = (k + 1) % 3, key = edgeKey(keys[k], keys[next]);
      const current = { a: ti * 3 + k, b: ti * 3 + next, aKey: keys[k] }, previous = sourceEdges.get(key);
      if (previous) {
        const sameDirection = previous.aKey === current.aKey;
        fans.join(current.a, sameDirection ? previous.a : previous.b);
        fans.join(current.b, sameDirection ? previous.b : previous.a);
      } else sourceEdges.set(key, current);
    }
  });
  const graphPoints = [], graphPointMap = new Map(), graph = [];
  triangles.forEach((triangle, ti) => {
    triangle.graphIds = triangle.points.map((point, k) => {
      const fan = fans.find(ti * 3 + k);
      if (!graphPointMap.has(fan)) { graphPointMap.set(fan, graphPoints.length); graphPoints.push(point); graph.push(new Map()); }
      return graphPointMap.get(fan);
    });
    for (let i = 0; i < 3; i++) {
      const a = triangle.graphIds[i], b = triangle.graphIds[(i + 1) % 3];
      const d = Math.sqrt(distance2(graphPoints[a], graphPoints[b]));
      graph[a].set(b, d); graph[b].set(a, d);
    }
  });
  const prepared = { triangles, graphPoints, graph: graph.map(neighbors => [...neighbors]), area, bounds: { min, max }, center: mul(add(min, max), 0.5), centroid: mul(centroidSum, 1 / area) };
  cache.set(model, prepared);
  return prepared;
}

export function analyzeModel(model) {
  const p = prepare(model);
  return { area: p.area, bounds: p.bounds, center: p.center, centroid: p.centroid,
    dimensions: sub(p.bounds.max, p.bounds.min), vertexCount: model.vertices.length, triangleCount: p.triangles.length };
}

function randomGenerator(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function surfaceSample(p, random) {
  const a = random() * p.area;
  let lo = 0, hi = p.triangles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.triangles[mid].cumulativeArea < a) lo = mid + 1;
    else hi = mid;
  }
  const [v0, v1, v2] = p.triangles[lo].points;
  const s = Math.sqrt(random()), t = random();
  return [0, 1, 2].map(k => v0[k] * (1 - s) + v1[k] * s * (1 - t) + v2[k] * s * t);
}

/** targetSize is the approximate distance between neighbouring cell centres. */
export function generateSeeds(model, targetSize = 600, variation = 0.35, seed = 1) {
  const p = prepare(model);
  const size = Math.max(10, Number(targetSize) || 600);
  const count = Math.max(12, Math.min(240, Math.round(p.area / (Math.sqrt(3) * 0.5 * size * size))));
  const random = randomGenerator(seed);
  const poolSize = Math.min(9000, Math.max(1500, count * 35));
  const candidates = Array.from({ length: poolSize }, () => surfaceSample(p, random));
  const weights = candidates.map(() => 1 + Math.min(1, Math.max(0, variation)) * 1.2 * (random() - 0.5));
  const nearest = new Float64Array(poolSize).fill(Infinity);
  const seeds = [];
  let chosen = Math.floor(random() * poolSize);
  for (let i = 0; i < count; i++) {
    const position = candidates[chosen];
    seeds.push({ id: i, position: [...position], weight: 1 });
    let best = -1;
    for (let j = 0; j < poolSize; j++) {
      nearest[j] = Math.min(nearest[j], distance2(position, candidates[j]));
      const score = nearest[j] * weights[j];
      if (score > best) { best = score; chosen = j; }
    }
  }
  return seeds;
}

function nearestTriangle(point, prepared) {
  // The centres originate on the surface. Testing distance to all triangles
  // also supports centres supplied by saved studies or pointer projection.
  let best = Infinity, chosen = prepared.triangles[0];
  for (const triangle of prepared.triangles) {
    const centerDistance = Math.sqrt(distance2(point, triangle.center));
    if (centerDistance - triangle.radius > Math.sqrt(best)) continue;
    const [a, b, c] = triangle.points;
    const ab = sub(b, a), ac = sub(c, a), ap = sub(point, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    let closest;
    if (d1 <= 0 && d2 <= 0) closest = a;
    else {
      const bp = sub(point, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
      if (d3 >= 0 && d4 <= d3) closest = b;
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) closest = add(a, mul(ab, d1 / (d1 - d3)));
        else {
          const cp = sub(point, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
          if (d6 >= 0 && d5 <= d6) closest = c;
          else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) closest = add(a, mul(ac, d2 / (d2 - d6)));
            else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 >= d3 && d5 >= d6) closest = add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
              else { const inv = 1 / (va + vb + vc); closest = add(a, add(mul(ab, vb * inv), mul(ac, vc * inv))); }
            }
          }
        }
      }
    }
    const d = distance2(point, closest);
    if (d < best) { best = d; chosen = triangle; }
  }
  return chosen;
}

function geodesicField(position, prepared) {
  const distances = new Float64Array(prepared.graph.length).fill(Infinity);
  const heapNodes = [], heapDistances = [];
  function push(node, distance) {
    let i = heapNodes.length;
    heapNodes.push(node); heapDistances.push(distance);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapDistances[parent] <= distance) break;
      heapNodes[i] = heapNodes[parent]; heapDistances[i] = heapDistances[parent]; i = parent;
    }
    heapNodes[i] = node; heapDistances[i] = distance;
  }
  function pop() {
    const result = [heapNodes[0], heapDistances[0]];
    const node = heapNodes.pop(), distance = heapDistances.pop();
    if (heapNodes.length) {
      let i = 0;
      while (true) {
        const left = i * 2 + 1, right = left + 1;
        if (left >= heapNodes.length) break;
        const child = right < heapNodes.length && heapDistances[right] < heapDistances[left] ? right : left;
        if (heapDistances[child] >= distance) break;
        heapNodes[i] = heapNodes[child]; heapDistances[i] = heapDistances[child]; i = child;
      }
      heapNodes[i] = node; heapDistances[i] = distance;
    }
    return result;
  }
  const anchor = nearestTriangle(position, prepared);
  for (const id of anchor.graphIds) {
    distances[id] = Math.sqrt(distance2(position, prepared.graphPoints[id]));
    push(id, distances[id]);
  }
  while (heapNodes.length) {
    const [node, distance] = pop();
    if (distance > distances[node]) continue;
    for (const [neighbor, weight] of prepared.graph[node]) {
      const next = distance + weight;
      if (next < distances[neighbor]) { distances[neighbor] = next; push(neighbor, next); }
    }
  }
  return distances;
}

function clipBarycentric(polygon, values, zeroTolerance = 0) {
  const out = [];
  if (!polygon.length) return out;
  const signed = point => { const value = dot(point, values); return Math.abs(value) <= zeroTolerance ? 0 : value; };
  let a = polygon[polygon.length - 1], da = signed(a);
  for (const b of polygon) {
    const db = signed(b);
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
    if (db <= 0) out.push(b);
    a = b; da = db;
  }
  return out;
}

// Symmetric 3x3 Jacobi eigensolver. The smallest eigenvector is a fitted normal.
function eigenSymmetric(matrix) {
  const a = matrix.map(r => [...r]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iteration = 0; iteration < 24; iteration++) {
    let p = 0, q = 1;
    if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; }
    if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
    if (Math.abs(a[p][q]) <= 1e-12 * Math.max(1, Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]))) break;
    const angle = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(angle), s = Math.sin(angle);
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      if (k !== p && k !== q) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = a[p][k] = c * akp - s * akq;
        a[k][q] = a[q][k] = s * akp + c * akq;
      }
      const vkp = v[k][p], vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }
  return [0, 1, 2].map(i => ({ value: a[i][i], vector: v.map(row => row[i]) })).sort((x, y) => x.value - y.value);
}

function fitPlane(positions, triangles) {
  const weighted = new Float64Array(positions.length);
  const origin = [0, 0, 0], normalSum = [0, 0, 0];
  let area = 0;
  for (const ids of triangles) {
    const [a, b, c] = ids.map(i => positions[i]);
    const n = cross(sub(b, a), sub(c, a));
    const triArea = length(n) * 0.5;
    area += triArea;
    for (let k = 0; k < 3; k++) normalSum[k] += n[k];
    for (const id of ids) weighted[id] += triArea / 3;
  }
  for (let i = 0; i < positions.length; i++) for (let k = 0; k < 3; k++) origin[k] += positions[i][k] * weighted[i] / area;
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < positions.length; i++) {
    const d = sub(positions[i], origin), w = weighted[i] / area;
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) covariance[j][k] += d[j] * d[k] * w;
  }
  const eigen = eigenSymmetric(covariance);
  let normal = normalized(eigen[0].vector);
  if (dot(normal, normalSum) < 0) normal = mul(normal, -1);
  let u = normalized(eigen[2].vector);
  const major = Math.abs(u[0]) > Math.abs(u[1]) ? (Math.abs(u[0]) > Math.abs(u[2]) ? 0 : 2) : (Math.abs(u[1]) > Math.abs(u[2]) ? 1 : 2);
  if (u[major] < 0) u = mul(u, -1);
  const v = normalized(cross(normal, u));
  u = normalized(cross(v, normal));
  let maxDeviation = 0, squared = 0;
  const flatPositions = [], projected = [];
  const min2 = [Infinity, Infinity], max2 = [-Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const d = sub(positions[i], origin), h = dot(d, normal);
    maxDeviation = Math.max(maxDeviation, Math.abs(h));
    squared += h * h * weighted[i] / area;
    flatPositions.push(sub(positions[i], mul(normal, h)));
    const xy = [dot(d, u), dot(d, v)];
    projected.push(xy);
    for (let k = 0; k < 2; k++) { min2[k] = Math.min(min2[k], xy[k]); max2[k] = Math.max(max2[k], xy[k]); }
  }
  let foldedTriangleCount = 0;
  for (const ids of triangles) {
    const [a, b, c] = ids.map(i => flatPositions[i]);
    if (dot(cross(sub(b, a), sub(c, a)), normal) < -AREA_EPS) foldedTriangleCount++;
  }
  return { plane: { origin, normal, u, v }, flatPositions, projected, area, maxDeviation,
    rmsDeviation: Math.sqrt(squared), width: max2[0] - min2[0], height: max2[1] - min2[1], bounds2d: { min: min2, max: max2 }, foldedTriangleCount };
}

/** Trace through face adjacency so coincident boundary contacts do not merge holes. */
function boundaryLoops(triangles) {
  const halfedges = [], edges = new Map(), components = disjointSet(triangles.length);
  let nonManifoldEdges = 0, inconsistentEdges = 0;
  for (const ids of triangles) {
    const start = halfedges.length;
    for (let j = 0; j < 3; j++) {
      const a = ids[j], b = ids[(j + 1) % 3], index = halfedges.length;
      const edge = { a, b, next: start + (j + 1) % 3, opposite: -1 };
      halfedges.push(edge);
      const key = edgeKey(a, b), other = edges.get(key);
      if (other === undefined) edges.set(key, index);
      else {
        components.join(Math.floor(index / 3), Math.floor(other / 3));
        if (halfedges[other].opposite !== -1) nonManifoldEdges++;
        else {
          if (halfedges[other].a !== b) inconsistentEdges++;
          edge.opposite = other;
          halfedges[other].opposite = index;
        }
      }
    }
  }
  const visited = new Set(), loops = [];
  let openChains = 0;
  for (let start = 0; start < halfedges.length; start++) {
    if (halfedges[start].opposite !== -1 || visited.has(start)) continue;
    const loop = [];
    let current = start, safe = 0;
    while (safe++ <= halfedges.length) {
      if (visited.has(current)) break;
      visited.add(current);
      loop.push(halfedges[current].a);
      let next = halfedges[current].next, around = 0;
      while (halfedges[next].opposite !== -1 && around++ <= halfedges.length) next = halfedges[halfedges[next].opposite].next;
      if (around > halfedges.length) { current = -1; break; }
      current = next;
      if (current === start) break;
    }
    if (current !== start) openChains++;
    if (loop.length >= 3) loops.push(loop);
  }
  const sourceComponentCount = new Set(triangles.map((_, i) => components.find(i))).size;
  return { loops, nonManifoldEdges, inconsistentEdges, openChains, sourceComponentCount };
}

function signedArea2d(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area * 0.5;
}

function crossingOutlines(rings) {
  const segments = [];
  for (let r = 0; r < rings.length; r++) for (let i = 0; i < rings[r].length; i++) {
    const a = rings[r][i], b = rings[r][(i + 1) % rings[r].length];
    segments.push({ a, b, r, i, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
  }
  const side = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const a = segments[i], b = segments[j];
    if (a.r === b.r && (Math.abs(a.i - b.i) === 1 || Math.abs(a.i - b.i) === rings[a.r].length - 1)) continue;
    if (a.minX >= b.maxX - WELD || b.minX >= a.maxX - WELD || a.minY >= b.maxY - WELD || b.minY >= a.maxY - WELD) continue;
    const ab = side(a.a, a.b, b.a), ac = side(a.a, a.b, b.b), ba = side(b.a, b.b, a.a), bc = side(b.a, b.b, a.b);
    if (ab * ac < -1e-10 && ba * bc < -1e-10) return true;
  }
  return false;
}

function finalizeCell(builder, preservedLoops = null) {
  const positions = builder.positions, triangles = builder.triangles;
  if (!triangles.length) return null;
  const fit = fitPlane(positions, triangles);
  const topology = boundaryLoops(triangles);
  if (preservedLoops) topology.loops = preservedLoops;
  const outline2d = topology.loops.map(loop => loop.map(i => fit.projected[i]));
  const loopAreas = outline2d.map(signedArea2d);
  const outerLoopCount = loopAreas.filter(a => a > AREA_EPS).length;
  const issues = [];
  if (topology.openChains) issues.push('An outline is not closed.');
  if (topology.nonManifoldEdges || topology.inconsistentEdges) issues.push('The source surface has a topology conflict in this cell.');
  if (topology.sourceComponentCount !== 1) issues.push('This cell has separate surface pieces. Move its centre or use smaller cells.');
  if (fit.foldedTriangleCount) issues.push('Parts of this cell reverse direction when flattened. Move its centre or use smaller cells.');
  if (crossingOutlines(outline2d)) issues.push('The flattened outline crosses itself. Move its centre or use smaller cells.');
  const { projected, ...measures } = fit;
  return { id: builder.id, seed: [...builder.seed], weight: builder.weight, positions, triangles, loops: topology.loops,
    outline2d, loopAreas, ...measures, neighbors: [], maxSeamGap: 0, valid: issues.length === 0,
    issues, sourceComponentCount: topology.sourceComponentCount, holeCount: loopAreas.filter(a => a < -AREA_EPS).length, outerLoopCount };
}

function connectCells(cells) {
  const vertexMap = new Map(), sharedEdges = new Map();
  for (const cell of cells) for (const loop of cell.loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      const ka = positionKey(cell.positions[a]), kb = positionKey(cell.positions[b]);
      if (ka === kb) continue;
      for (const [key, id] of [[ka, a], [kb, b]]) {
        if (!vertexMap.has(key)) vertexMap.set(key, { position: cell.positions[id], cells: new Map(), neighbors: new Set(), boundary: false });
        vertexMap.get(key).cells.set(cell.id, { cell, flat: cell.flatPositions[id] });
      }
      const edge = edgeKey(ka, kb);
      if (!sharedEdges.has(edge)) sharedEdges.set(edge, { a: ka, b: kb, cells: new Set() });
      sharedEdges.get(edge).cells.add(cell.id);
    }
  }
  const byId = new Map(cells.map(c => [c.id, c]));
  const adjacency = new Map(cells.map(c => [c.id, new Set()]));
  let seamLength = 0;
  for (const edge of sharedEdges.values()) {
    const a = vertexMap.get(edge.a), b = vertexMap.get(edge.b);
    if (edge.cells.size >= 2) {
      a.neighbors.add(edge.b); b.neighbors.add(edge.a);
      const ids = [...edge.cells];
      for (const x of ids) for (const y of ids) if (x !== y) adjacency.get(x).add(y);
      seamLength += Math.sqrt(distance2(a.position, b.position));
    } else { a.boundary = true; b.boundary = true; }
  }
  let maxSeamGap = 0, sumGap2 = 0, gapCount = 0;
  const junctions = [];
  for (const entry of vertexMap.values()) {
    const owners = [...entry.cells.values()];
    for (let i = 0; i < owners.length; i++) for (let j = i + 1; j < owners.length; j++) {
      const gap = Math.sqrt(distance2(owners[i].flat, owners[j].flat));
      maxSeamGap = Math.max(maxSeamGap, gap);
      owners[i].cell.maxSeamGap = Math.max(owners[i].cell.maxSeamGap, gap);
      owners[j].cell.maxSeamGap = Math.max(owners[j].cell.maxSeamGap, gap);
      sumGap2 += gap * gap; gapCount++;
    }
    if (entry.boundary || entry.neighbors.size < 3 || owners.length < 3) continue;
    const normal = normalized(owners.reduce((sum, x) => add(sum, x.cell.plane.normal), [0, 0, 0]));
    const branches = [...entry.neighbors].map(k => {
      const d = sub(vertexMap.get(k).position, entry.position);
      return normalized(sub(d, mul(normal, dot(d, normal))));
    });
    const angles = [];
    for (let i = 0; i < branches.length; i++) for (let j = i + 1; j < branches.length; j++) angles.push(Math.acos(Math.max(-1, Math.min(1, dot(branches[i], branches[j])))) * 180 / Math.PI);
    const kind = branches.length === 3 ? (Math.max(...angles) >= 160 ? 'T' : 'Y') : 'other';
    junctions.push({ position: entry.position, kind, angles, cells: owners.map(x => x.cell.id) });
  }
  for (const [id, neighbors] of adjacency) byId.get(id).neighbors = [...neighbors];
  return { maxSeamGap, rmsSeamGap: Math.sqrt(sumGap2 / (gapCount || 1)), seamLength, junctions };
}

function validateMergeGroups(groups, knownIds) {
  if (!Array.isArray(groups)) throw new Error('Merge groups must be a list.');
  const used = new Set();
  return groups.map(group => {
    if (!group || !Number.isSafeInteger(group.id) || group.id < 0 || !Array.isArray(group.members) || group.members.length < 2) {
      throw new Error('Each merge group needs a surviving cell ID and at least two original cell IDs.');
    }
    const members = [...group.members];
    if (members.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(members).size !== members.length || !members.includes(group.id)) {
      throw new Error('Merge group members must be unique cell IDs and include the surviving cell.');
    }
    for (const id of members) {
      if (!knownIds.has(id)) throw new Error(`Merge group refers to missing cell ${id}. Restore the layout or clear its merges.`);
      if (used.has(id)) throw new Error('A cell cannot belong to more than one merge group.');
      used.add(id);
    }
    return { id: group.id, members: members.sort((a, b) => a - b) };
  }).sort((a, b) => a.id - b.id);
}

function edgeAdjacency(cells) {
  const edges = new Map(), adjacent = new Map(cells.map(cell => [cell.id, new Set()]));
  for (const cell of cells) for (const loop of cell.loops) for (let i = 0; i < loop.length; i++) {
    const a = positionKey(cell.positions[loop[i]]), b = positionKey(cell.positions[loop[(i + 1) % loop.length]]);
    if (a === b) continue;
    const key = edgeKey(a, b);
    if (!edges.has(key)) edges.set(key, new Set());
    edges.get(key).add(cell.id);
  }
  for (const owners of edges.values()) for (const a of owners) for (const b of owners) if (a !== b) adjacent.get(a).add(b);
  return adjacent;
}

function requireConnectedCells(ids, adjacent) {
  const selected = new Set(ids), reached = new Set([ids[0]]), queue = [ids[0]];
  for (let i = 0; i < queue.length; i++) for (const next of adjacent.get(queue[i]) || []) {
    if (selected.has(next) && !reached.has(next)) { reached.add(next); queue.push(next); }
  }
  if (reached.size !== selected.size) throw new Error('Select cells connected by shared edges. Separate cells or corner-only contacts cannot be merged.');
}

/** Compose a merge of the currently visible cells, retaining their original seeds. */
export function createMergeGroups(cells, currentGroups = [], selectedIds = []) {
  if (!Array.isArray(cells)) throw new Error('Expected a cell layout to merge.');
  const byId = new Map(cells.map(cell => [cell.id, cell]));
  const knownIds = new Set(cells.flatMap(cell => cell.memberSeedIds || [cell.id]));
  const groups = validateMergeGroups(currentGroups, knownIds);
  const groupsById = new Map(groups.map(group => [group.id, group]));
  for (const cell of cells) {
    const actual = [...(cell.memberSeedIds || [cell.id])].sort((a, b) => a - b);
    const expected = groupsById.get(cell.id)?.members || [cell.id];
    if (actual.length !== expected.length || actual.some((id, i) => id !== expected[i])) {
      throw new Error('The cell layout no longer matches its merge groups. Recalculate before merging.');
    }
  }
  if (groups.some(group => !byId.has(group.id))) throw new Error('A merged cell is missing from the current layout. Recalculate before merging.');
  const selected = selectedIds instanceof Set ? [...selectedIds] : selectedIds;
  if (!Array.isArray(selected) || selected.length < 2 || new Set(selected).size !== selected.length) {
    throw new Error('Select at least two different cells to merge.');
  }
  if (selected.some(id => !byId.has(id))) throw new Error('A selected cell is missing from the current layout.');
  requireConnectedCells(selected, edgeAdjacency(cells));
  const selection = new Set(selected);
  const members = selected.flatMap(id => byId.get(id).memberSeedIds || [id]).sort((a, b) => a - b);
  const next = [...groups.filter(group => !selection.has(group.id)), { id: Math.min(...selected), members }];
  return validateMergeGroups(next, knownIds);
}

function unionSurfaceCells(cells, group) {
  const survivor = cells.find(cell => cell.id === group.id);
  const builder = { id: group.id, seed: survivor.seed, weight: survivor.weight, positions: [], triangles: [] };
  const vertices = new Map();
  for (const cell of cells) {
    const remap = cell.positions.map(point => {
      const key = positionKey(point);
      if (!vertices.has(key)) { vertices.set(key, builder.positions.length); builder.positions.push([...point]); }
      return vertices.get(key);
    });
    for (const triangle of cell.triangles) builder.triangles.push(triangle.map(id => remap[id]));
  }
  const topology = boundaryLoops(builder.triangles);
  if (topology.openChains || topology.nonManifoldEdges || topology.inconsistentEdges) {
    throw new Error('These cells have conflicting surface edges and cannot be merged.');
  }
  // Connectivity is measured on the surface, independently of whether a flat
  // projection folds or crosses itself. Those fitting problems remain visible.
  const triangleEdges = new Map(), neighbors = builder.triangles.map(() => []);
  builder.triangles.forEach((triangle, ti) => triangle.forEach((a, i) => {
    const key = edgeKey(a, triangle[(i + 1) % 3]);
    if (triangleEdges.has(key)) { const other = triangleEdges.get(key); neighbors[ti].push(other); neighbors[other].push(ti); }
    else triangleEdges.set(key, ti);
  }));
  const reached = new Set([0]), queue = [0];
  for (let i = 0; i < queue.length; i++) for (const next of neighbors[queue[i]] || []) {
    if (!reached.has(next)) { reached.add(next); queue.push(next); }
  }
  if (reached.size !== builder.triangles.length) throw new Error('These cells contain separate surface pieces and cannot become one merged panel.');
  return { ...finalizeCell(builder), memberSeedIds: [...group.members] };
}

/** Union original surface regions without redistributing their area to neighbors. */
export function mergeSurfaceCells(result, mergeGroups = []) {
  if (!result || !Array.isArray(result.cells)) throw new Error('Expected generated surface cells to merge.');
  const original = result.cells, byId = new Map(original.map(cell => [cell.id, cell]));
  const groups = validateMergeGroups(mergeGroups, new Set(byId.keys()));
  const adjacent = groups.length ? edgeAdjacency(original) : null;
  const groupFor = new Map();
  for (const group of groups) {
    requireConnectedCells(group.members, adjacent);
    for (const id of group.members) groupFor.set(id, group);
  }
  const cells = [];
  for (const cell of original) {
    const group = groupFor.get(cell.id);
    if (group && group.id !== cell.id) continue;
    cells.push(group ? unionSurfaceCells(group.members.map(id => byId.get(id)), group)
      : { ...cell, neighbors: [], maxSeamGap: 0, memberSeedIds: [cell.id] });
  }
  const seams = connectCells(cells), totalArea = cells.reduce((sum, cell) => sum + cell.area, 0);
  const sourceArea = result.stats.sourceArea;
  const stats = { ...result.stats, cellCount: cells.length, mergedCellCount: original.length - cells.length,
    totalArea, coverageError: sourceArea ? Math.abs(totalArea - sourceArea) / sourceArea : 0,
    maxDeviation: Math.max(0, ...cells.map(cell => cell.maxDeviation)),
    rmsDeviation: Math.sqrt(cells.reduce((sum, cell) => sum + cell.rmsDeviation ** 2 * cell.area, 0) / (totalArea || 1)),
    maxSeamGap: seams.maxSeamGap, rmsSeamGap: seams.rmsSeamGap, seamLength: seams.seamLength,
    junctionCount: seams.junctions.length, tJunctionCount: seams.junctions.filter(j => j.kind === 'T').length,
    yJunctionCount: seams.junctions.filter(j => j.kind === 'Y').length,
    invalidCellCount: cells.filter(cell => !cell.valid).length,
    minArea: cells.length ? Math.min(...cells.map(cell => cell.area)) : 0, maxArea: Math.max(0, ...cells.map(cell => cell.area)),
  };
  return { ...result, cells, stats, junctions: seams.junctions };
}

/** Rebuild derived measurements from an authored source partition, without
 * regenerating its geometry from seeds. Callers validate source ownership. */
export function rebuildSurfaceCells(model, sourceCells, generation = {}) {
  const prepared = prepare(model);
  if (!Array.isArray(sourceCells) || !sourceCells.length) throw new Error('An authored layout needs at least one cell.');
  const cells = sourceCells.map(source => {
    const cell = finalizeCell(source, source.loops);
    if (!cell) throw new Error('An authored cell has no source triangles.');
    return { ...cell, memberSeedIds: [...(source.memberSeedIds || [source.id])] };
  });
  const seams = connectCells(cells), totalArea = cells.reduce((sum, cell) => sum + cell.area, 0);
  const requestedCellCount = generation.requestedCellCount ?? cells.length;
  const stats = { cellCount: cells.length, requestedCellCount, emptyCellCount: generation.emptyCellCount ?? 0,
    mergedCellCount: generation.mergedCellCount ?? 0, totalArea, sourceArea: prepared.area,
    coverageError: Math.abs(totalArea - prepared.area) / prepared.area,
    maxDeviation: Math.max(0, ...cells.map(cell => cell.maxDeviation)),
    rmsDeviation: Math.sqrt(cells.reduce((sum, cell) => sum + cell.rmsDeviation ** 2 * cell.area, 0) / (totalArea || 1)),
    maxSeamGap: seams.maxSeamGap, rmsSeamGap: seams.rmsSeamGap, seamLength: seams.seamLength,
    junctionCount: seams.junctions.length, tJunctionCount: seams.junctions.filter(junction => junction.kind === 'T').length,
    yJunctionCount: seams.junctions.filter(junction => junction.kind === 'Y').length,
    invalidCellCount: cells.filter(cell => !cell.valid).length,
    minArea: Math.min(...cells.map(cell => cell.area)), maxArea: Math.max(...cells.map(cell => cell.area)),
  };
  return { cells, stats, junctions: seams.junctions };
}

export function generateCells(model, seeds, options = {}) {
  const prepared = prepare(model);
  if (!seeds?.length) throw new Error('At least one cell centre is needed.');
  if (seeds.length > 500) throw new Error('This demo supports at most 500 cell centres.');
  const unique = [], seen = new Set();
  for (let i = 0; i < seeds.length; i++) {
    const position = seeds[i].position || seeds[i].seed || seeds[i];
    if (position.length !== 3 || position.some(v => !Number.isFinite(v))) throw new Error('A cell centre has an invalid position.');
    const key = positionKey(position);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ id: seeds[i].id ?? i, position, weight: Math.max(.1, Math.min(3, Number(seeds[i].weight) || 1)) });
  }
  const builders = unique.map(s => ({ id: s.id, seed: s.position, weight: s.weight, positions: [], triangles: [], vertexMap: new Map() }));
  const spacing = Number(options.size) || Math.sqrt(prepared.area / (unique.length * .8660254));
  const fields = unique.map(s => {
    if (options.score) {
      const field = Float64Array.from(prepared.graphPoints, point => options.score(point, s));
      if (field.some(value => !Number.isFinite(value))) throw new Error('A cell score field contains a non-finite value.');
      return field;
    }
    const distances = options.distanceField ? options.distanceField(s.position, prepared) : geodesicField(s.position, prepared);
    if (distances.length !== prepared.graphPoints.length || distances.some(value => Number.isNaN(value) || value === -Infinity)) throw new Error('A surface distance field is invalid.');
    const bias = (s.weight - 1) * spacing * .5;
    if (bias) for (let i = 0; i < distances.length; i++) distances[i] -= bias;
    return distances;
  });
  if (options.adjustFields) options.adjustFields(prepared, unique, fields);
  const values = Array.from({ length: unique.length }, () => [0, 0, 0]);
  for (let ti = 0; ti < prepared.triangles.length; ti++) {
    const triangle = prepared.triangles[ti];
    let upperBound = Infinity;
    for (let i = 0; i < unique.length; i++) {
      for (let k = 0; k < 3; k++) values[i][k] = fields[i][triangle.graphIds[k]];
      upperBound = Math.min(upperBound, Math.max(...values[i]));
    }
    if (!Number.isFinite(upperBound)) {
      // A disconnected source island with no centre still needs coverage. This
      // fallback is disclosed by the resulting cell's separate-piece validity.
      for (let i = 0; i < unique.length; i++) for (let k = 0; k < 3; k++) values[i][k] = Math.sqrt(distance2(unique[i].position, triangle.points[k]));
      upperBound = Math.min(...values.map(v => Math.max(...v)));
    }
    // An affine field is bounded by its vertex values. If a site's minimum is
    // above another site's maximum, it cannot own any point in this triangle.
    const candidates = [];
    for (let i = 0; i < unique.length; i++) if (Math.min(...values[i]) <= upperBound + WELD) candidates.push(i);
    for (const index of candidates) {
      let barycentric = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      for (const other of candidates) {
        if (index === other) continue;
        // Analytic bisectors can coincide exactly with a source edge. Roundoff
        // in equal affine scores must not invent an arbitrary cut halfway down
        // that edge on just one side of the seam. Keep the tolerance at the
        // floating-point evaluation scale, far below source-position welding.
        const zeroTolerance = options.score || options.distanceField ? Number.EPSILON * 64 * Math.max(1, ...values[index].filter(Number.isFinite).map(Math.abs), ...values[other].filter(Number.isFinite).map(Math.abs)) : 0;
        const differences = values[index].map((x, k) => { const difference = x - values[other][k]; return Math.abs(difference) <= zeroTolerance ? 0 : difference; });
        if (differences.every(x => Math.abs(x) < 1e-9)) {
          if (other < index) { barycentric = []; break; }
          continue;
        }
        barycentric = clipBarycentric(barycentric, differences, zeroTolerance);
        if (barycentric.length < 3) break;
      }
      if (barycentric.length < 3) continue;
      const polygon = barycentric.map(weights => [0, 1, 2].map(k => weights[0] * triangle.points[0][k] + weights[1] * triangle.points[1][k] + weights[2] * triangle.points[2][k]));
      const builder = builders[index];
      const ids = [];
      for (const p of polygon) {
        const key = positionKey(p);
        let id = builder.vertexMap.get(key);
        if (id === undefined) {
          id = builder.positions.length;
          builder.positions.push([...p]); builder.vertexMap.set(key, id);
        }
        if (ids[ids.length - 1] !== id) ids.push(id);
      }
      if (ids[0] === ids[ids.length - 1]) ids.pop();
      for (let j = 1; j < ids.length - 1; j++) {
        const tri = [ids[0], ids[j], ids[j + 1]];
        const [a, b, c] = tri.map(i => builder.positions[i]);
        if (length(cross(sub(b, a), sub(c, a))) * 0.5 > AREA_EPS) builder.triangles.push(tri);
      }
    }
    if (options.onProgress && ti % 1000 === 0) options.onProgress(ti / prepared.triangles.length);
  }
  const cells = builders.map(builder => finalizeCell(builder)).filter(Boolean);
  const seams = connectCells(cells);
  const totalArea = cells.reduce((sum, c) => sum + c.area, 0);
  const stats = {
    cellCount: cells.length, requestedCellCount: seeds.length, emptyCellCount: seeds.length - cells.length,
    totalArea, sourceArea: prepared.area, coverageError: Math.abs(totalArea - prepared.area) / prepared.area,
    maxDeviation: Math.max(0, ...cells.map(c => c.maxDeviation)),
    rmsDeviation: Math.sqrt(cells.reduce((sum, c) => sum + c.rmsDeviation ** 2 * c.area, 0) / (totalArea || 1)),
    maxSeamGap: seams.maxSeamGap, rmsSeamGap: seams.rmsSeamGap, seamLength: seams.seamLength,
    junctionCount: seams.junctions.length, tJunctionCount: seams.junctions.filter(j => j.kind === 'T').length,
    yJunctionCount: seams.junctions.filter(j => j.kind === 'Y').length,
    invalidCellCount: cells.filter(c => !c.valid).length,
    minArea: Math.min(...cells.map(c => c.area)), maxArea: Math.max(0, ...cells.map(c => c.area)),
  };
  return { cells, stats, junctions: seams.junctions };
}

function cornerNetwork(cells) {
  const nodes = new Map(), edges = new Map();
  for (const cell of cells) for (const loop of cell.loops) for (let i = 0; i < loop.length; i++) {
    const pair = [loop[i], loop[(i + 1) % loop.length]].map(id => {
      const position = cell.positions[id], key = positionKey(position);
      if (!nodes.has(key)) nodes.set(key, { key, position, owners: new Set(), boundary: false });
      nodes.get(key).owners.add(cell.id);
      return key;
    });
    if (pair[0] === pair[1]) continue;
    const key = edgeKey(...pair);
    if (!edges.has(key)) edges.set(key, { pair, owners: new Set() });
    edges.get(key).owners.add(cell.id);
  }
  const boundaryNeighbors = new Map();
  for (const { pair, owners } of edges.values()) if (owners.size === 1) for (let i = 0; i < 2; i++) {
    nodes.get(pair[i]).boundary = true;
    if (!boundaryNeighbors.has(pair[i])) boundaryNeighbors.set(pair[i], new Set());
    boundaryNeighbors.get(pair[i]).add(pair[1 - i]);
  }
  const paths = new Map(), boundaryKeys = new Map(), visited = new Set();
  for (const start of boundaryNeighbors.keys()) {
    if (visited.has(start) || boundaryNeighbors.get(start).size !== 2) continue;
    const keys = []; let current = start, previous = null;
    while (!visited.has(current) && boundaryNeighbors.get(current)?.size === 2) {
      keys.push(current); visited.add(current);
      const next = [...boundaryNeighbors.get(current)].find(key => key !== previous);
      previous = current; current = next;
    }
    if (current === start && keys.length >= 3) {
      const path = [...keys, start].map(key => nodes.get(key).position);
      // Clipping inserts seam endpoints along a fixed source perimeter. Its
      // lexicographically least vertex remains stable as those endpoints move.
      const minimum = path.reduce((a, b) => a[0] !== b[0] ? (a[0] < b[0] ? a : b)
        : a[1] !== b[1] ? (a[1] < b[1] ? a : b) : (a[2] < b[2] ? a : b));
      for (const key of keys) { paths.set(key, path); boundaryKeys.set(key, positionKey(minimum)); }
    }
  }
  const corners = [...nodes.values()].filter(node => node.owners.size >= (node.boundary ? 2 : 3)).map(node => ({
    ...node, owners: [...node.owners].sort((a, b) => a - b), boundaryPath: paths.get(node.key), boundaryKey: boundaryKeys.get(node.key),
  }));
  return { corners, edges };
}

function surfaceAddress(point, prepared) {
  const triangle = nearestTriangle(point, prepared), [a, b, c] = triangle.points;
  const ab = sub(b, a), ac = sub(c, a), ap = sub(point, a);
  const aa = dot(ab, ab), bb = dot(ac, ac), abac = dot(ab, ac), denominator = aa * bb - abac * abac;
  const v = (bb * dot(ap, ab) - abac * dot(ap, ac)) / denominator;
  const w = (aa * dot(ap, ac) - abac * dot(ap, ab)) / denominator;
  const barycentric = [1 - v - w, v, w], projected = add(a, add(mul(ab, v), mul(ac, w)));
  if (barycentric.some(x => !Number.isFinite(x) || x < -1e-7) || distance2(point, projected) > 1e-6) {
    throw new Error('Keep the corner on the original mesh surface.');
  }
  return { triangle, barycentric };
}

function sampleField(field, address) {
  return address.triangle.graphIds.reduce((sum, id, i) => Math.abs(address.barycentric[i]) < 1e-14 ? sum : sum + field[id] * address.barycentric[i], 0);
}

function pathDistance(point, path) {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], d = sub(path[i], a), t = Math.max(0, Math.min(1, dot(sub(point, a), d) / (dot(d, d) || 1)));
    best = Math.min(best, Math.sqrt(distance2(point, add(a, mul(d, t)))));
  }
  return best;
}

function solveCornerSystem(matrix, values) {
  const n = matrix.length, rows = matrix.map((row, i) => [...row, ...values[i]]), width = rows[0].length;
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let i = column + 1; i < n; i++) if (Math.abs(rows[i][column]) > Math.abs(rows[pivot][column])) pivot = i;
    if (Math.abs(rows[pivot][column]) < 1e-7) throw new Error('These corner targets are too close to solve independently. Move them farther apart.');
    [rows[pivot], rows[column]] = [rows[column], rows[pivot]];
    const divisor = rows[column][column];
    for (let k = column; k < width; k++) rows[column][k] /= divisor;
    for (let i = 0; i < n; i++) if (i !== column) {
      const factor = rows[i][column];
      for (let k = column; k < width; k++) rows[i][k] -= factor * rows[column][k];
    }
  }
  return rows.map(row => row.slice(n));
}

function applyCornerFields(prepared, seeds, fields, edits) {
  const seedIndices = new Map(seeds.map((seed, i) => [seed.id, i]));
  const addresses = edits.map(edit => surfaceAddress(edit.target, prepared));
  const kernels = edits.map((edit, i) => {
    const distances = geodesicField(edit.target, prepared);
    const kernel = Float64Array.from(distances, d => Math.max(0, 1 - d / edit.radius) ** 2);
    const normalizer = sampleField(kernel, addresses[i]);
    if (!(normalizer > 1e-6)) throw new Error('The mesh is too coarse for this corner move. Try a closer target.');
    return kernel.map(value => value / normalizer);
  });
  const values = edits.map((edit, i) => {
    const scores = fields.map(field => sampleField(field, addresses[i]));
    const groupScores = edit.owners.map(group => Math.min(...group.map(id => scores[seedIndices.get(id)])));
    if (groupScores.some(score => !Number.isFinite(score))) throw new Error('A corner group has no connected surface at that target.');
    let common = Math.min(...groupScores);
    const ownerIds = new Set(edit.owners.flat());
    const other = Math.min(Infinity, ...seeds.map((seed, j) => ownerIds.has(seed.id) ? Infinity : scores[j]));
    if (other <= common) common = other - Math.max(.01, edit.radius * 1e-5);
    const shifts = new Array(seeds.length).fill(0);
    edit.owners.forEach((group, gi) => group.forEach(id => { shifts[seedIndices.get(id)] = common - groupScores[gi]; }));
    return shifts;
  });
  const matrix = addresses.map(address => kernels.map(kernel => sampleField(kernel, address)));
  const coefficients = solveCornerSystem(matrix, values);
  for (let seed = 0; seed < fields.length; seed++) for (let edit = 0; edit < edits.length; edit++) {
    const coefficient = coefficients[edit][seed];
    if (!coefficient) continue;
    for (let vertex = 0; vertex < fields[seed].length; vertex++) fields[seed][vertex] += coefficient * kernels[edit][vertex];
  }
}

function cornerSignature(corner) { return `${corner.boundary ? `boundary:${corner.boundaryKey}` : 'inside'}:${corner.owners.join(',')}`; }

function checkCornerTopology(before, after, beforeNetwork, afterNetwork) {
  if (after.stats.coverageError > 1e-8) throw new Error('The move would leave the source surface incompletely covered.');
  for (const cell of after.cells) {
    const topology = boundaryLoops(cell.triangles);
    if (topology.openChains) throw new Error('The move creates an open cell outline.');
    if (topology.nonManifoldEdges) throw new Error('The move creates a non-manifold surface edge.');
    if (topology.inconsistentEdges) throw new Error('The move creates inconsistent surface-edge orientation.');
  }
  if (before.cells.length !== after.cells.length) throw new Error('This move adds or removes a cell. Cell creation and removal are not supported by the current corner editor.');
  const byId = new Map(after.cells.map(cell => [cell.id, cell]));
  for (const cell of before.cells) {
    const other = byId.get(cell.id);
    if (!other) throw new Error('This move replaces a cell. Cell creation and removal are not supported by the current corner editor.');
    if (other.area < Math.max(1e-6, cell.area * 1e-5)) throw new Error('The move leaves a degenerate cell. Cell collapse is not supported by the current corner editor.');
    if (cell.loops.length !== other.loops.length) throw new Error('This move changes a cell boundary connection. Boundary topology changes are not supported by the current corner editor.');
    if ([...cell.neighbors].sort().join(',') !== [...other.neighbors].sort().join(',')) throw new Error('This move changes which cells are neighbours. Topology-changing corner edits are not supported yet.');
  }
  const signatures = network => network.corners.map(cornerSignature).sort().join('|');
  if (signatures(beforeNetwork) !== signatures(afterNetwork)) throw new Error('This move creates, removes or reconnects a junction. Topology-changing corner edits are not supported yet.');
}

/** Source-surface corner targets modify the partition before merging and fitting. */
export function generateCellLayout(model, seeds, options = {}) {
  const { size, mergeGroups = [], cornerEdits = [] } = options;
  if (!Array.isArray(cornerEdits) || cornerEdits.length > 128) throw new Error('Use a list of at most 128 corner edits.');
  if ((options.score || options.distanceField) && cornerEdits.length) throw new Error('Use direct corner editing for a structured or regularized layout.');
  const base = generateCells(model, seeds, { size, score: options.score, distanceField: options.distanceField }), baseNetwork = cornerNetwork(base.cells), prepared = prepare(model);
  const spacing = Number(size) || Math.sqrt(prepared.area / (seeds.length * .8660254));
  const baseCorners = baseNetwork.corners.map(corner => ({ ...corner,
    id: `corner:${corner.owners.join('-')}:${corner.key}`,
    radius: Math.max(10, spacing * 1.5, nearestTriangle(corner.position, prepared).radius * 2),
  }));
  const byId = new Map(baseCorners.map(corner => [corner.id, corner]));
  const seedIds = new Set(base.cells.map(cell => cell.id)), editedIds = new Set();
  for (const edit of cornerEdits) {
    const corner = edit && byId.get(edit.id);
    if (!corner || editedIds.has(edit.id)) throw new Error('A corner edit no longer matches this starting layout. Reset the corner edits before regenerating.');
    editedIds.add(edit.id);
    if (![edit.anchor, edit.target].every(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)) ||
      distance2(edit.anchor, corner.position) > 1e-6 || !Number.isFinite(edit.radius) || edit.radius <= 0) {
      throw new Error('The saved corner anchor, target or influence radius is invalid.');
    }
    if (distance2(edit.target, edit.anchor) > (edit.radius * .6) ** 2) throw new Error('This corner is beyond its total movement range from the original layout. Choose a closer target.');
    if (baseCorners.some(other => other.id !== corner.id && cornerSignature(other) === cornerSignature(corner) &&
      distance2(edit.target, other.position) + 1e-6 < distance2(edit.target, corner.position))) {
      throw new Error('That move would exchange two corners of the same cells. Try a smaller move.');
    }
    if (!Array.isArray(edit.owners) || edit.owners.length < (corner.boundary ? 2 : 3)) throw new Error('A corner edit needs its incident cell groups.');
    const members = new Set();
    for (const group of edit.owners) {
      if (!Array.isArray(group) || !group.length || !group.some(id => corner.owners.includes(id))) throw new Error('A corner edit has an invalid incident cell group.');
      for (const id of group) {
        if (!seedIds.has(id) || members.has(id)) throw new Error('A corner edit contains a missing or repeated cell centre.');
        members.add(id);
      }
    }
    if (corner.owners.some(id => !members.has(id))) throw new Error('A corner edit is missing an incident cell.');
    if (corner.boundary && (!corner.boundaryPath || pathDistance(edit.target, corner.boundaryPath) > .001)) {
      throw new Error('Keep a boundary corner on its original perimeter or opening.');
    }
    surfaceAddress(edit.target, prepared);
  }
  const surface = cornerEdits.length ? generateCells(model, seeds, { size,
    adjustFields: (mesh, sites, fields) => applyCornerFields(mesh, sites, fields, cornerEdits),
  }) : base;
  const network = cornerEdits.length ? cornerNetwork(surface.cells) : baseNetwork;
  if (cornerEdits.length) checkCornerTopology(base, surface, baseNetwork, network);
  const currentBySignature = new Map();
  for (const corner of network.corners) {
    const signature = cornerSignature(corner);
    if (!currentBySignature.has(signature)) currentBySignature.set(signature, []);
    currentBySignature.get(signature).push(corner);
  }
  const editsById = new Map(cornerEdits.map(edit => [edit.id, edit])), resolved = new Map();
  // Resolve constrained junctions first; other corners retain their nearest
  // original identity within the same incident-cell and boundary signature.
  for (const original of [...baseCorners].sort((a, b) => Number(editsById.has(b.id)) - Number(editsById.has(a.id)))) {
    const edit = editsById.get(original.id), target = edit?.target || original.position;
    const candidates = currentBySignature.get(cornerSignature(original));
    candidates.sort((a, b) => distance2(a.position, target) - distance2(b.position, target));
    const current = candidates.shift();
    if (edit && distance2(current.position, target) > 1e-6) throw new Error('This corner cannot reach that point without changing its seams. Try a smaller move.');
    resolved.set(original.id, current);
  }
  const result = mergeSurfaceCells(surface, mergeGroups), visibleFor = new Map();
  for (const cell of result.cells) for (const id of cell.memberSeedIds) visibleFor.set(id, cell);
  result.corners = baseCorners.flatMap(original => {
    const current = resolved.get(original.id);
    const visible = [...new Map(current.owners.map(id => [visibleFor.get(id).id, visibleFor.get(id)])).values()].sort((a, b) => a.id - b.id);
    if (visible.length < (original.boundary ? 2 : 3) || (original.boundary && !original.boundaryPath)) return [];
    return [{ id: original.id, anchor: [...original.position], position: [...current.position],
      owners: visible.map(cell => [...cell.memberSeedIds]), cells: visible.map(cell => cell.id), radius: editsById.get(original.id)?.radius ?? original.radius,
      boundary: original.boundary, ...(original.boundary ? { boundaryPath: original.boundaryPath.map(point => [...point]) } : {}),
    }];
  });
  return result;
}
