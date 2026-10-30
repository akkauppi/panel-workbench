import { Triangle, Vector3 } from './vendor/three.core.js';

const meshes = new WeakMap();
const pointKey = p => p.map(value => Math.round(value * 1e5)).join(',');

/** Display metadata follows the fitted network, never a nearest unrelated vertex. */
export function cornerDisplayPosition(corner, view, cameraPosition) {
  if (view === 'surface') return corner.position;
  if (view === 'reference' || !corner.flatPosition) return null;
  if (view !== 'solid' || !corner.solidPositions?.length) return corner.flatPosition;
  let closest = null, distance = Infinity;
  for (const candidate of corner.solidPositions) {
    const d = candidate.position.reduce((sum, value, i) => sum + (value - cameraPosition[i]) ** 2, 0);
    if (d < distance) { distance = d; closest = candidate.position; }
  }
  return closest;
}

function projectionMesh(model) {
  if (meshes.has(model)) return meshes.get(model);
  const edges = new Map();
  const triangles = model.triangles.map((ids, index) => {
    const points = ids.map(id => model.vertices[id]), keys = points.map(pointKey);
    const triangle = new Triangle(...points.map(point => new Vector3(...point)));
    const center = triangle.getMidpoint(new Vector3());
    const radius = Math.max(...points.map(point => center.distanceTo(new Vector3(...point))));
    for (let i = 0; i < 3; i++) {
      const key = [keys[i], keys[(i + 1) % 3]].sort().join('|');
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push(index);
    }
    return { triangle, center, radius, neighbors: new Set() };
  });
  for (const owners of edges.values()) for (const a of owners) for (const b of owners) if (a !== b) triangles[a].neighbors.add(b);
  meshes.set(model, triangles);
  return triangles;
}

/** Restrict projection to a connected, local patch so nearby sheets cannot steal the drag. */
export function cornerProjectionPatch(model, corner) {
  const triangles = projectionMesh(model), point = new Vector3(...corner.position), closest = new Vector3();
  let start = -1, minimum = Infinity;
  for (let i = 0; i < triangles.length; i++) {
    triangles[i].triangle.closestPointToPoint(point, closest);
    const distance = closest.distanceToSquared(point);
    if (distance < minimum) { minimum = distance; start = i; }
  }
  if (start < 0 || minimum > 1e-6) throw new Error('The corner is not attached to the reference surface.');
  const distances = new Map([[start, 0]]), queue = [{ id: start, distance: 0 }], patch = [];
  while (queue.length) {
    queue.sort((a, b) => b.distance - a.distance);
    const entry = queue.pop();
    if (entry.distance !== distances.get(entry.id)) continue;
    const current = triangles[entry.id];
    patch.push(current.triangle);
    for (const next of current.neighbors) {
      const distance = entry.distance + current.center.distanceTo(triangles[next].center);
      if (distance > corner.radius + current.radius + triangles[next].radius || distance >= (distances.get(next) ?? Infinity)) continue;
      distances.set(next, distance); queue.push({ id: next, distance });
    }
  }
  return patch;
}

export function projectCornerDisplacement(corner, displacement, patch) {
  const source = new Vector3(...corner.position);
  // Exact no-op matters when the source and fitted corners are far apart.
  if (displacement.lengthSq() < 1e-16) return source;
  const target = source.clone().add(displacement), candidate = new Vector3();
  let result = null, distance = Infinity;
  for (const triangle of patch) {
    triangle.closestPointToPoint(target, candidate);
    const d = candidate.distanceToSquared(target);
    if (d < distance) { distance = d; result = candidate.clone(); }
  }
  return result || source;
}
