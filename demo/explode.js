// Exploded placement is a presentation transform. It never changes panel
// geometry, source attachment or fabrication validity.
const finitePoint = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const add = (a, b) => a.map((value, i) => value + b[i]);
const sub = (a, b) => a.map((value, i) => value - b[i]);
const mul = (a, value) => a.map(coordinate => coordinate * value);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(...a);
const unit = a => { const size = length(a); return size > 1e-12 ? mul(a, 1 / size) : null; };

function bounds(points) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]);
  }
  return { min, max, center: min.map((value, axis) => value + (max[axis] - value) / 2) };
}

function directionFor(id) {
  let hash = 2166136261;
  for (const character of String(id)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const random = () => {
    hash ^= hash << 13; hash ^= hash >>> 17; hash ^= hash << 5;
    return (hash >>> 0) / 4294967296;
  };
  const z = random() * 2 - 1, angle = random() * Math.PI * 2, radius = Math.sqrt(Math.max(0, 1 - z * z));
  return [radius * Math.cos(angle), radius * Math.sin(angle), z];
}

function centroid(points, triangles) {
  // Area weighting avoids a display shift caused only by denser triangulation.
  // Calculate relative to a local origin for models far from world zero.
  const origin = points[0], sum = [0, 0, 0]; let area = 0;
  for (const value of Array.isArray(triangles) ? triangles : []) {
    const triangle = Array.isArray(value) ? value : value?.vertices;
    if (!Array.isArray(triangle) || triangle.length !== 3 || !triangle.every(i => Number.isInteger(i) && finitePoint(points[i]))) continue;
    const [a, b, c] = triangle.map(i => sub(points[i], origin));
    const weight = length(cross(sub(b, a), sub(c, a)));
    if (!(weight > 0) || !Number.isFinite(weight)) continue;
    for (let axis = 0; axis < 3; axis++) sum[axis] += (a[axis] + b[axis] + c[axis]) * weight / 3;
    area += weight;
  }
  return area > 0 && Number.isFinite(area) && sum.every(Number.isFinite) ? add(origin, mul(sum, 1 / area)) : bounds(points).center;
}

function describe(cell, solid) {
  // Prefer the same fitted face in all three views. Solids enlarge the envelope
  // but do not shift the panel centre to one carved or rounded surface.
  let face = Array.isArray(cell.flatPositions) && cell.flatPositions.length ? cell.flatPositions : cell.positions;
  if (!Array.isArray(face) || !face.some(finitePoint)) face = solid?.positions;
  if (!Array.isArray(face) || !face.some(finitePoint)) face = [finitePoint(cell.plane?.origin) ? cell.plane.origin : finitePoint(cell.seed) ? cell.seed : [0, 0, 0]];
  // Keeping original indices matters for triangle lookup. Invalid coordinates
  // are omitted from envelopes and invalidate only the centroid triangulation.
  const finite = face.filter(finitePoint);
  const center = face.every(finitePoint) ? centroid(face, cell.triangles) : bounds(finite).center;
  const envelope = [...finite, ...(Array.isArray(solid?.positions) ? solid.positions.filter(finitePoint) : [])];
  const radius = envelope.reduce((maximum, point) => Math.max(maximum, length(sub(point, center))), 0);
  const candidate = cell.plane?.normal ?? solid?.plane?.normal;
  const normal = finitePoint(candidate) ? unit(candidate) : null;
  return { id: cell.id, center, radius, normal, envelope };
}

function outward(normal, radial) {
  if (!normal) return [0, 0, 0];
  const agreement = dot(normal, radial);
  if (Math.abs(agreement) > 1e-10) return mul(normal, agreement < 0 ? -1 : 1);
  // Coplanar panels may carry opposite face winding. A canonical perpendicular
  // normal prevents an arbitrary winding change from flipping their placement.
  const axis = normal.reduce((best, value, i) => Math.abs(value) > Math.abs(normal[best]) ? i : best, 0);
  return mul(normal, normal[axis] < 0 ? -1 : 1);
}

/** Deterministic, size-aware presentation offsets, keyed by numeric panel ID.
 * All views use the fitted face (or source fallback) and available solid extent.
 * Full offsets are computed independently of amount; the slider only scales
 * them. Cache amount=1 in the UI when reusing the same geometry.
 *
 * Conservative bounding-sphere relaxation separates adjacent/coplanar parts,
 * including coincident centres. It has a fixed work/displacement budget and is
 * a visual heuristic, not collision-free packing in every camera projection.
 */
export function computeExplodedOffsets({ cells, solids = [], view = 'flat', amount = 0, center } = {}) {
  if (!Array.isArray(cells) || !Array.isArray(solids)) throw new Error('Exploded placement needs panel arrays.');
  if (!['surface', 'flat', 'solid'].includes(view)) throw new Error('Unknown exploded panel view.');
  if (!Number.isFinite(amount) || amount < 0 || amount > 1) throw new Error('Explosion amount must be between zero and one.');
  if (center !== undefined && !finitePoint(center)) throw new Error('The explosion centre must be a finite 3D point.');
  const ids = new Set();
  for (const cell of cells) {
    if (!Number.isSafeInteger(cell?.id) || cell.id < 0 || ids.has(cell.id)) throw new Error('Exploded panels need unique nonnegative IDs.');
    ids.add(cell.id);
  }
  const ordered = [...cells].sort((a, b) => a.id - b.id);
  if (!amount || !ordered.length) return new Map(ordered.map(cell => [cell.id, [0, 0, 0]]));
  const solidById = new Map();
  for (const solid of solids) {
    if (!Number.isSafeInteger(solid?.id) || solid.id < 0 || solidById.has(solid.id)) throw new Error('Exploded solids need unique nonnegative IDs.');
    solidById.set(solid.id, solid);
  }
  const parts = ordered.map(cell => describe(cell, solidById.get(cell.id)));
  const assembly = bounds(parts.flatMap(part => part.envelope)), origin = center ?? assembly.center;
  const span = Math.max(length(sub(assembly.max, assembly.min)), 1e-6);
  const radii = parts.map(part => part.radius).sort((a, b) => a - b);
  const typical = Math.max(radii[Math.floor(radii.length / 2)], span * .001);
  const clearance = Math.max(typical * .18, span * .01);
  const maximumMove = span * 3 + radii.at(-1) * 4 + clearance;
  const targets = parts.map(part => {
    const radial = unit(sub(part.center, origin)) ?? directionFor(part.id);
    const direction = unit(add(radial, mul(outward(part.normal, radial), .35))) ?? radial;
    const distance = span * .12 + part.radius * .8 + clearance;
    return add(part.center, mul(direction, distance));
  });
  // Deterministic Gauss-Seidel sweeps, always in panel-ID order. A small excess
  // over required clearance prevents a retained numerical contact in simple
  // coplanar/stacked cases; no random per-frame jitter or slider thresholds.
  for (let pass = 0; pass < 40; pass++) {
    let largest = 0;
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const delta = sub(targets[j], targets[i]), distance = length(delta);
      const required = parts[i].radius + parts[j].radius + clearance;
      const missing = required - distance;
      if (missing <= clearance * 1e-5) continue;
      largest = Math.max(largest, missing);
      const direction = distance > span * 1e-12 ? mul(delta, 1 / distance) : directionFor(`${parts[i].id}:${parts[j].id}`);
      const push = mul(direction, (missing + clearance * 1e-4) / 2);
      targets[i] = sub(targets[i], push); targets[j] = add(targets[j], push);
    }
    for (let i = 0; i < parts.length; i++) {
      const delta = sub(targets[i], parts[i].center), distance = length(delta);
      if (distance > maximumMove) targets[i] = add(parts[i].center, mul(delta, maximumMove / distance));
    }
    if (largest <= clearance * 1e-5) break;
  }
  return new Map(parts.map((part, i) => [part.id, mul(sub(targets[i], part.center), amount)]));
}
