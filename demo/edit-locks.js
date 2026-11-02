/** Editing protection belongs to the authored shell layout. It deliberately
 * does not promise that a protected panel's fitted plane or stock stays fixed. */
export const EDIT_LOCKS_FEATURE = 'source-edit-locks-v1';
const panelName = id => `P${String(id + 1).padStart(3, '0')}`;
const distance = (a, b) => Math.hypot(...a.map((value, axis) => value - b[axis]));
const sub = (a, b) => a.map((value, axis) => value - b[axis]);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

export function readProtectedCellIds(input, cells) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > 500 || input.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(input).size !== input.length) {
    throw new Error('Protected panels need a list of unique panel numbers.');
  }
  const known = cells === undefined ? null : new Set(cells.map(cell => cell.id));
  if (known) for (const id of input) if (!known.has(id)) throw new Error(`Protected panel ${panelName(id)} is not in this layout. Keep the original study unchanged.`);
  return [...input].sort((a, b) => a - b);
}

function boundary(cell, tolerance) {
  return cell.loops.map(loop => {
    let points = loop.map(index => cell.positions[index]);
    if (points.length > 1 && distance(points[0], points.at(-1)) <= tolerance) points = points.slice(0, -1);
    // Changing a neighbouring patch can insert collinear source-triangle
    // samples on the same boundary. Such reindexing is not a design change.
    let changed = true;
    while (changed && points.length > 3) {
      changed = false;
      for (let i = 0; i < points.length; i++) {
        const a = points[(i + points.length - 1) % points.length], p = points[i], b = points[(i + 1) % points.length];
        const ab = sub(b, a), ap = sub(p, a), length2 = dot(ab, ab);
        const t = length2 > 0 ? dot(ap, ab) / length2 : 0;
        const nearest = a.map((value, axis) => value + Math.max(0, Math.min(1, t)) * ab[axis]);
        if (distance(p, nearest) <= tolerance) { points.splice(i, 1); changed = true; break; }
      }
    }
    return points;
  });
}

function sameRing(first, second, tolerance) {
  if (first.length !== second.length) return false;
  for (let start = 0; start < second.length; start++) if (distance(first[0], second[start]) <= tolerance) {
    for (const direction of [1, -1]) if (first.every((point, index) => distance(point, second[(start + direction * index + second.length) % second.length]) <= tolerance)) return true;
  }
  return false;
}

function patchAreas(cell) {
  const result = new Map();
  for (const triangle of cell.triangles) {
    const [a, b, c] = triangle.vertices.map(index => cell.positions[index]);
    const area = Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
    result.set(triangle.sourceTriangle, (result.get(triangle.sourceTriangle) || 0) + area);
  }
  return result;
}

function sameCell(first, second, tolerance) {
  if (!second || first.memberSeedIds.length !== second.memberSeedIds.length || first.memberSeedIds.some(id => !second.memberSeedIds.includes(id))) return false;
  const a = boundary(first, tolerance), b = boundary(second, tolerance);
  if (a.length !== b.length) return false;
  const used = new Set();
  for (const ring of a) {
    const index = b.findIndex((candidate, i) => !used.has(i) && sameRing(ring, candidate, tolerance));
    if (index < 0) return false;
    used.add(index);
  }
  const areasA = patchAreas(first), areasB = patchAreas(second);
  for (const triangle of new Set([...areasA.keys(), ...areasB.keys()])) {
    const areaA = areasA.get(triangle) || 0, areaB = areasB.get(triangle) || 0;
    if (Math.abs(areaA - areaB) > Math.max(1e-6, Math.sqrt(Math.max(areaA, areaB)) * tolerance * 4)) return false;
  }
  return true;
}

/** Compare accepted source candidates, including neighbours of the explicitly
 * edited cell. A shared corner must not bypass another panel's protection. */
export function changedProtectedCellIds(before, after, protectedCellIds, { tolerance = 1e-5 } = {}) {
  const ids = readProtectedCellIds(protectedCellIds, before?.cells);
  if (!ids.length) return [];
  if (!before?.cells || !after?.cells || JSON.stringify(before.source) !== JSON.stringify(after.source)) return ids;
  const first = new Map(before.cells.map(cell => [cell.id, cell])), second = new Map(after.cells.map(cell => [cell.id, cell]));
  return ids.filter(id => !sameCell(first.get(id), second.get(id), tolerance));
}

export function assertProtectedLayoutUnchanged(before, after, protectedCellIds, options) {
  const changed = changedProtectedCellIds(before, after, protectedCellIds, options);
  if (changed.length) throw new Error(`This edit would change protected ${changed.length === 1 ? 'panel' : 'panels'} ${changed.slice(0, 6).map(panelName).join(', ')}${changed.length > 6 ? ' and others' : ''}. Unlock ${changed.length === 1 ? 'it' : 'them'} first, or move a corner that is not shared with a protected panel.`);
  return true;
}

export function protectedCellsTouchedByCorner(layout, cornerId, protectedCellIds) {
  const protectedIds = new Set(readProtectedCellIds(protectedCellIds, layout?.cells));
  return (layout?.corners?.find(corner => corner.id === cornerId)?.cells || []).filter(id => protectedIds.has(id)).sort((a, b) => a - b);
}
