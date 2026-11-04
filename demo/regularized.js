import { analyzeModel, generateSeeds, generateAdaptiveSeeds, generateCellLayout } from './geometry.js';
import { readPattern } from './pattern.js';
import { readGeneratorPolicy } from './generator-policy.js';
import { measureLayoutQuality } from './quality.js';

const add = (a, b) => a.map((x, i) => x + b[i]);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const mul = (a, scale) => a.map(x => x * scale);
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(...a);
const distance = (a, b) => length(sub(a, b));
const key = p => p.map(x => Math.round(x * 1e5)).join(',');

function closestTriangle(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), normal = cross(ab, ac), denominator = dot(normal, normal);
  const v = dot(cross(ap, ac), normal) / denominator, w = dot(cross(ab, ap), normal) / denominator;
  if (v >= 0 && w >= 0 && v + w <= 1) return add(a, add(mul(ab, v), mul(ac, w)));
  let closest = a, best = Infinity;
  for (const [start, end] of [[a, b], [b, c], [c, a]]) {
    const edge = sub(end, start), t = Math.max(0, Math.min(1, dot(sub(p, start), edge) / (dot(edge, edge) || 1)));
    const candidate = add(start, mul(edge, t)), d = distance(candidate, p);
    if (d < best) { best = d; closest = candidate; }
  }
  return closest;
}

function nearest(point, triangles) {
  let best = Infinity, result;
  for (const triangle of triangles) {
    if (triangle.center && distance(point, triangle.center) - triangle.radius > best) continue;
    const position = closestTriangle(point, ...triangle.points), d = distance(position, point);
    if (d < best) { best = d; result = { position, triangle, distance: d }; }
  }
  return result;
}

class Heap {
  constructor() { this.nodes = []; this.values = []; }
  push(node, value) {
    let i = this.nodes.length; this.nodes.push(node); this.values.push(value);
    while (i) { const p = (i - 1) >> 1; if (this.values[p] <= value) break; this.nodes[i] = this.nodes[p]; this.values[i] = this.values[p]; i = p; }
    this.nodes[i] = node; this.values[i] = value;
  }
  pop() {
    const result = [this.nodes[0], this.values[0]], node = this.nodes.pop(), value = this.values.pop();
    if (this.nodes.length) {
      let i = 0;
      while (i * 2 + 1 < this.nodes.length) {
        const a = i * 2 + 1, b = a + 1, child = b < this.nodes.length && this.values[b] < this.values[a] ? b : a;
        if (this.values[child] >= value) break; this.nodes[i] = this.nodes[child]; this.values[i] = this.values[child]; i = child;
      }
      this.nodes[i] = node; this.values[i] = value;
    }
    return result;
  }
}

const metricCache = new WeakMap();
function metricFor(prepared) {
  if (metricCache.has(prepared)) return metricCache.get(prepared);
  const dependents = Array.from({ length: prepared.graphPoints.length }, () => []);
  for (const triangle of prepared.triangles) for (let k = 0; k < 3; k++) {
    const target = triangle.graphIds[k], a = triangle.graphIds[(k + 1) % 3], b = triangle.graphIds[(k + 2) % 3];
    const pa = prepared.graphPoints[a], pb = prepared.graphPoints[b], pc = prepared.graphPoints[target];
    const edge = sub(pb, pa), offset = sub(pc, pa), l = length(edge), x = dot(offset, edge) / l;
    const update = { target, a, b, l, x, h: length(cross(offset, edge)) / l, ca: length(offset), cb: distance(pc, pb) };
    dependents[a].push(update); dependents[b].push(update);
  }
  const metric = { prepared, dependents };
  metricCache.set(prepared, metric); return metric;
}

/** Approximate intrinsic distances: interpolate arrival times along an edge
 * and minimize the path through the incident triangle interior. Unlike an
 * edge-only Dijkstra field, paths can cross faces in any direction. Values
 * remain a mesh-dependent wavefront approximation, not exact geodesics.
 * Graph IDs already distinguish point-contact fans in geometry.js.
 */
export function triangleDistanceField(position, prepared) {
  const metric = metricFor(prepared), distances = new Float64Array(prepared.graphPoints.length).fill(Infinity), heap = new Heap();
  const anchor = nearest(position, prepared.triangles);
  for (const id of anchor.triangle.graphIds) { distances[id] = distance(position, prepared.graphPoints[id]); heap.push(id, distances[id]); }
  let updates = 0;
  while (heap.nodes.length) {
    const [node, known] = heap.pop();
    if (known > distances[node]) continue;
    for (const step of metric.dependents[node]) {
      const da = distances[step.a], db = distances[step.b];
      let candidate = Math.min(da + step.ca, db + step.cb);
      const difference = db - da;
      if (Number.isFinite(difference) && Math.abs(difference) < step.l) {
        const along = step.x - step.h * difference / Math.sqrt(step.l * step.l - difference * difference);
        if (along > 0 && along < step.l) candidate = Math.min(candidate, da + difference * along / step.l + Math.hypot(step.x - along, step.h));
      }
      const previous = distances[step.target];
      if (Number.isFinite(candidate) && (!Number.isFinite(previous) || candidate < previous - Math.max(1e-8, previous * 1e-10))) {
        distances[step.target] = candidate; heap.push(step.target, candidate);
        if (++updates > prepared.graphPoints.length * 300) throw new Error('The source mesh is too irregular for bounded surface-distance propagation.');
      }
    }
  }
  return distances;
}

function sourceComponents(model, seeds) {
  const triangles = model.triangles.map(ids => ({ points: ids.map(i => model.vertices[i]) }))
    .filter(({ points: [a, b, c] }) => length(cross(sub(b, a), sub(c, a))) / 2 >= 1e-9)
    .map((triangle, id) => ({ ...triangle, id }));
  const edges = new Map(), neighbors = triangles.map(() => new Set());
  for (const triangle of triangles) for (let k = 0; k < 3; k++) {
    const edge = [key(triangle.points[k]), key(triangle.points[(k + 1) % 3])].sort().join('|');
    if (edges.has(edge)) { const other = edges.get(edge); neighbors[other].add(triangle.id); neighbors[triangle.id].add(other); }
    else edges.set(edge, triangle.id);
  }
  const labels = new Int32Array(triangles.length).fill(-1), components = [];
  for (let i = 0; i < triangles.length; i++) if (labels[i] < 0) {
    const queue = [i], label = components.length; labels[i] = label;
    for (let j = 0; j < queue.length; j++) for (const next of neighbors[queue[j]]) if (labels[next] < 0) { labels[next] = label; queue.push(next); }
    components.push(queue);
  }
  if (components.length > seeds.length) throw new Error('Use smaller cells so every disconnected source sheet can receive a centre.');
  const owners = seeds.map(seed => labels[nearest(seed.position, triangles).triangle.id]);
  const counts = components.map((_, label) => owners.filter(owner => owner === label).length);
  let reassigned = 0;
  components.forEach((indices, label) => {
    if (counts[label]) return;
    const donor = counts.indexOf(Math.max(...counts)), index = owners.findLastIndex(owner => owner === donor);
    const face = indices.map(i => triangles[i]).sort((a, b) => length(cross(sub(b.points[1], b.points[0]), sub(b.points[2], b.points[0]))) - length(cross(sub(a.points[1], a.points[0]), sub(a.points[2], a.points[0]))))[0];
    seeds[index].position = mul(face.points.reduce(add), 1 / 3); counts[donor]--; counts[label]++; owners[index] = label; reassigned++;
  });
  return { componentCount: components.length, reassigned };
}

function centroid(cell) {
  let area = 0, center = [0, 0, 0];
  for (let i = 0; i < cell.triangles.length; i++) {
    const [a, b, c] = cell.triangles[i].map(id => cell.positions[id]);
    const weight = length(cross(sub(b, a), sub(c, a))) / 2 * (cell.triangleDensities?.[i] ?? 1);
    area += weight; center = add(center, mul(add(add(a, b), c), weight / 3));
  }
  if (!(area > 0) || !Number.isFinite(area)) throw new Error('The requested cell-size range cannot be regularized. Use a narrower range.');
  return mul(center, 1 / area);
}

function diagnosticsFor(surface) {
  const areas = surface.cells.map(cell => cell.area), mean = areas.reduce((a, b) => a + b, 0) / areas.length;
  const edges = new Map(), boundary = new Set();
  for (const cell of surface.cells) for (const loop of cell.loops) for (let i = 0; i < loop.length; i++) {
    const edge = [key(cell.positions[loop[i]]), key(cell.positions[loop[(i + 1) % loop.length]])].sort().join('|');
    if (!edges.has(edge)) edges.set(edge, []); edges.get(edge).push(cell.id);
  }
  for (const owners of edges.values()) if (owners.length === 1) boundary.add(owners[0]);
  const degrees = {}, interiorDegrees = {};
  for (const cell of surface.cells) { degrees[cell.neighbors.length] = (degrees[cell.neighbors.length] || 0) + 1; if (!boundary.has(cell.id)) interiorDegrees[cell.neighbors.length] = (interiorDegrees[cell.neighbors.length] || 0) + 1; }
  const interiorCount = surface.cells.length - boundary.size;
  return { cellCount: areas.length, areaCV: Math.sqrt(areas.reduce((sum, area) => sum + (area / mean - 1) ** 2, 0) / areas.length),
    minArea: Math.min(...areas), maxArea: Math.max(...areas), neighborCounts: degrees, interiorNeighborCounts: interiorDegrees,
    interiorCount, interior567Fraction: interiorCount ? [5, 6, 7].reduce((sum, n) => sum + (interiorDegrees[n] || 0), 0) / interiorCount : null,
    sourceComponentFailures: surface.cells.filter(c => c.sourceComponentCount !== 1).length, coverageError: surface.stats.coverageError,
    projectedShape: measureLayoutQuality(surface.cells) };
}

function layoutProblem(surface, count) {
  if (surface.cells.length !== count) return 'Some centres have no source cell. Use larger cells or a finer source mesh before regularizing.';
  if (surface.stats.coverageError >= 1e-8) return 'Regularization could not preserve complete source coverage. Check the source mesh.';
  if (surface.cells.some(cell => /topology conflict|outline is not closed/i.test(cell.issues.join(' ')))) return 'Regularization produced an open or conflicting source outline. Check the source topology or use a finer mesh.';
  if (surface.cells.some(cell => cell.sourceComponentCount !== 1)) return 'This source produces disconnected cell pieces. Use smaller cells before regularizing.';
  return null;
}

function energy(surface, seeds, initial, regularity) {
  const current = new Map(seeds.map(seed => [seed.id, seed.position]));
  let total = 0;
  for (const cell of surface.cells) {
    const origin = current.get(cell.id);
    let mass = 0;
    for (let i = 0; i < cell.triangles.length; i++) {
      const points = cell.triangles[i].map(id => cell.positions[id]), q = points.map(p => sub(p, origin));
      const area = length(cross(sub(points[1], points[0]), sub(points[2], points[0]))) / 2 * (cell.triangleDensities?.[i] ?? 1);
      mass += area;
      total += regularity * area / 6 * (q.reduce((sum, p) => sum + dot(p, p), 0) + dot(q[0], q[1]) + dot(q[1], q[2]) + dot(q[2], q[0]));
    }
    const movement = sub(origin, initial.get(cell.id));
    total += (1 - regularity) * (cell.triangleDensities ? mass : cell.area) * dot(movement, movement);
  }
  return total;
}

/** Deterministic surface-constrained centroid relaxation. Regularity blends
 * each cell's (optionally density-weighted) centroid with its initial site;
 * it does not simply change the number of solver iterations. Ownership uses
 * approximate intrinsic distance. Projection stays on the currently owned
 * source patch and intrinsic step limits prevent shortcuts across close folds.
 */
export function generateRegularizedLayout(model, input, options = {}) {
  const pattern = readPattern(input), size = Number(options.size);
  const policy = readGeneratorPolicy(options.generatorPolicy, pattern);
  if (pattern.type !== 'regularized') throw new Error('Choose the regularized surface pattern.');
  if (!Number.isFinite(size) || size < 10) throw new Error('Set a regularized cell spacing of at least 10 mm.');
  if (options.cornerEdits?.length) throw new Error('Use direct corner editing for a regularized layout.');
  // Keep the initial sampler identical to the ordinary .3-variation baseline;
  // the Regularity control affects relaxation rather than a second jitter knob.
  const adaptive = policy ? generateAdaptiveSeeds(model, policy, .3, options.randomSeed ?? 7, options.maxGeneratedCells) : null;
  let seeds = adaptive?.seeds ?? generateSeeds(model, size, .3, options.randomSeed ?? 7, options.maxGeneratedCells);
  if (analyzeModel(model).triangleCount * seeds.length * 9 > 12_000_000) throw new Error('The source is too detailed for the regularization work budget. Simplify its mesh or use larger cells.');
  const components = sourceComponents(model, seeds), initial = new Map(seeds.map(seed => [seed.id, [...seed.position]]));
  const baseline = generateCellLayout(model, seeds, { size });
  let metricPrepared, fields;
  const calculate = sites => {
    fields = new Map();
    return generateCellLayout(model, sites, { size, triangleDensity: adaptive?.sizing.triangleDensity, distanceField(position, prepared) {
      metricPrepared = prepared; const field = triangleDistanceField(position, prepared); fields.set(position, field); return field;
    } });
  };
  let surface = calculate(seeds);
  const initialProblem = layoutProblem(surface, seeds.length);
  if (initialProblem) throw new Error(initialProblem);
  const initialMetric = diagnosticsFor(surface), iterationLog = [];
  let objective = energy(surface, seeds, initial, pattern.regularity), acceptedIterations = 0;
  const initialObjective = objective;
  for (let iteration = 0; iteration < 8 && pattern.regularity > 0; iteration++) {
    const currentFields = fields, byCell = new Map(surface.cells.map(cell => [cell.id, cell]));
    let maxStepRatio = 0;
    const candidates = seeds.map(seed => {
      const cell = byCell.get(seed.id), target = add(mul(initial.get(seed.id), 1 - pattern.regularity), mul(centroid(cell), pattern.regularity));
      const triangles = cell.triangles.map(ids => ({ points: ids.map(id => cell.positions[id]) }));
      let damping = .65, projected = seed.position;
      for (let attempt = 0; attempt < 8; attempt++, damping *= .5) {
        const proposal = nearest(add(seed.position, mul(sub(target, seed.position), damping)), triangles).position;
        const address = nearest(proposal, metricPrepared.triangles), [a, b, c] = address.triangle.points;
        const ab = sub(b, a), ac = sub(c, a), ap = sub(proposal, a), normal = cross(ab, ac), denominator = dot(normal, normal);
        const v = dot(cross(ap, ac), normal) / denominator, w = dot(cross(ab, ap), normal) / denominator;
        const values = address.triangle.graphIds.map(id => currentFields.get(seed.position)[id]);
        const travel = [1 - v - w, v, w].reduce((sum, value, i) => Math.abs(value) < 1e-12 ? sum : sum + value * values[i], 0);
        const localSize = adaptive ? address.triangle.graphIds.reduce((sum, id, i) => sum + [1 - v - w, v, w][i] * adaptive.sizing.vertexSizes[id], 0) : size;
        if (Number.isFinite(travel) && travel <= localSize * .45) {
          projected = proposal; maxStepRatio = Math.max(maxStepRatio, travel / localSize); break;
        }
      }
      return { ...seed, position: [...projected] };
    });
    const maxMovement = Math.max(...candidates.map((seed, i) => distance(seed.position, seeds[i].position)));
    if (maxMovement < (policy?.minSizeMm ?? size) * 1e-5) break;
    const proposed = calculate(candidates), nextObjective = energy(proposed, candidates, initial, pattern.regularity);
    const problem = layoutProblem(proposed, seeds.length), accepted = !problem && nextObjective < objective - Math.max(1e-5, objective * 1e-8);
    iterationLog.push({ iteration: iteration + 1, accepted, maxMovement, objective: nextObjective,
      ...(adaptive ? { maxStepRatio } : {}), ...(problem ? { reason: problem } : {}) });
    if (!accepted) break;
    seeds = candidates; surface = proposed; objective = nextObjective; acceptedIterations++;
  }
  return { seeds, surface, diagnostics: { method: adaptive ? 'triangle-interior surface distances with anchored density-weighted centroid relaxation' : 'triangle-interior surface distances with anchored area-centroid relaxation',
    limitation: 'Distances and local centroids approximate the intrinsic surface metric; results depend on mesh resolution and do not guarantee hexagons or convex panels.',
    iterations: acceptedIterations, iterationBudget: 8, regularity: pattern.regularity, ...components,
    ...(adaptive ? { sizing: adaptive.sizing.diagnostics, initialObjective } : {}),
    baseline: diagnosticsFor(baseline), initialMetric, final: diagnosticsFor(surface), iterationLog } };
}
