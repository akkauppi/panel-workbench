import { BufferGeometry, Float32BufferAttribute } from './vendor/three.module.js';

const sub = (a, b) => a.map((value, axis) => value - b[axis]);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = vector => { const length = Math.hypot(...vector); return length ? vector.map(value => value / length) : [0, 0, 0]; };

/** Build display geometry without changing the solid or manufacturing exports.
 * Normals are shared only within an authored physical surface patch. In
 * particular, two walls meeting at a corner never borrow each other's normals.
 */
export function createSolidGeometry(solid) {
  const { positions, triangles } = solid;
  const capNormal = unit(solid.plane?.normal || [0, 0, 0]);
  const isCarved = side => solid.caps?.[side]?.carved || (solid.carved && solid.carvedSide === side);
  const flatCap = side => (side === 'positive' || side === 'negative') && !isCarved(side);
  const capDirection = side => capNormal.map(value => value * (side === 'positive' ? 1 : -1));
  const patches = new Map();
  const patchIds = triangles.map((_, i) => solid.trianglePatches?.[i]
    || (solid.triangleGroups?.[i] === 'edge' ? `facet:${i}` : solid.triangleGroups?.[i] || `facet:${i}`));
  const faceNormals = triangles.map(triangle => unit(cross(sub(positions[triangle[1]], positions[triangle[0]]), sub(positions[triangle[2]], positions[triangle[0]]))));
  const vertexNormal = (patchId, vertexId) => {
    if (!patches.has(patchId)) patches.set(patchId, new Map());
    const patch = patches.get(patchId);
    if (!patch.has(vertexId)) patch.set(vertexId, { sum: [0, 0, 0], fixed: null });
    return patch.get(vertexId);
  };
  for (let i = 0; i < triangles.length; i++) {
    const triangle = triangles[i], patchId = patchIds[i], normal = faceNormals[i];
    const side = /^side:(\d+):(\d+)$/.exec(patchId);
    const cut = side && solid.cuts?.[Number(side[1])]?.[Number(side[2])];
    const cutLength = cut && Math.hypot(...cut.normal), cutNormal = cutLength ? unit(cut.normal) : null;
    // A genuine flat wall stays flat all the way to the roundover tangent.
    // Carved walls use this only where their actual geometry still lies on the
    // reference cut plane; otherwise their surface normals follow the carving.
    const planarWall = cutNormal && dot(normal, cutNormal) > 1 - 1e-8
      && triangle.every(id => Math.abs((dot(cut.normal, positions[id]) - cut.constant) / cutLength) < 1e-5);
    for (let corner = 0; corner < 3; corner++) {
      const id = triangle[corner], a = sub(positions[triangle[(corner + 1) % 3]], positions[id]);
      const b = sub(positions[triangle[(corner + 2) % 3]], positions[id]);
      const angle = Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));
      const entry = vertexNormal(patchId, id);
      for (let axis = 0; axis < 3; axis++) entry.sum[axis] += normal[axis] * angle;
      if (planarWall) entry.fixed = cutNormal;
    }
  }
  // A rounded strip meets an uncarved cap tangentially. Its last render normal
  // equals that cap's normal instead of the last polygon segment's slope.
  for (const side of ['positive', 'negative']) {
    if (!flatCap(side) || !(solid.caps?.[side]?.inset > 1e-8)) continue;
    const ids = new Set(solid.caps[side].boundaryLoops.flat()), normal = capDirection(side);
    for (const [patchId, entries] of patches) if (patchId.startsWith('side:')) {
      for (const id of ids) if (entries.has(id)) entries.get(id).fixed = normal;
    }
  }
  const displayPositions = [], displayNormals = [];
  triangles.forEach((triangle, i) => {
    const group = solid.triangleGroups?.[i], patch = patches.get(patchIds[i]);
    for (const id of triangle) {
      displayPositions.push(...positions[id]);
      const entry = patch.get(id);
      displayNormals.push(...(flatCap(group) ? capDirection(group) : entry.fixed || unit(entry.sum)));
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(displayPositions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(displayNormals, 3));
  return geometry;
}
