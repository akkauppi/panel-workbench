const finitePoint = point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite);
// Use the fitter's source-coordinate identity, never a nearest-point search
// across neighbouring panels or through the stock thickness.
const pointKey = point => point.map(value => Math.round(value * 1e5)).join(',');
const edgeKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
const sharpTurnCosine = Math.cos(Math.PI / 6);

function outlineVertices(cell) {
  const vertices = new Map();
  for (const loop of cell?.loops || []) for (const index of loop) {
    const point = cell.positions?.[index];
    if (finitePoint(point)) vertices.set(pointKey(point), index);
  }
  return vertices;
}

function fixedRimCorners(surfaceCells) {
  const edges = new Map(), points = new Map();
  for (const cell of surfaceCells) for (const loop of cell.loops || []) {
    for (let i = 0; i < loop.length; i++) {
      const a = cell.positions?.[loop[i]], b = cell.positions?.[loop[(i + 1) % loop.length]];
      if (!finitePoint(a) || !finitePoint(b)) continue;
      const ka = pointKey(a), kb = pointKey(b);
      if (ka === kb) continue;
      points.set(ka, a); points.set(kb, b);
      const key = edgeKey(ka, kb);
      if (!edges.has(key)) edges.set(key, { ends: [ka, kb], owners: new Set() });
      edges.get(key).owners.add(cell.id);
    }
  }
  const perimeter = new Map();
  for (const { ends, owners } of edges.values()) if (owners.size === 1) {
    for (let i = 0; i < 2; i++) {
      const key = ends[i];
      if (!perimeter.has(key)) perimeter.set(key, { neighbours: new Set(), owners: new Set() });
      const node = perimeter.get(key);
      node.neighbours.add(ends[1 - i]);
      for (const owner of owners) node.owners.add(owner);
    }
  }
  const corners = [];
  for (const [key, node] of perimeter) {
    // A branch or open endpoint has no unambiguous fixed rim turn.
    if (node.neighbours.size !== 2) continue;
    const point = points.get(key), [previous, next] = [...node.neighbours].map(id => points.get(id));
    const incoming = point.map((value, i) => value - previous[i]);
    const outgoing = next.map((value, i) => value - point[i]);
    const lengths = Math.hypot(...incoming) * Math.hypot(...outgoing);
    if (!(lengths > 0)) continue;
    const cosine = incoming.reduce((sum, value, i) => sum + value * outgoing[i], 0) / lengths;
    // Source meshes carry no CAD curve semantics. An abrupt >=30 degree turn
    // is a conservative fallback for fixed corners; smooth rim samples stay
    // out even if fitting later replaces their curve with coarse chords.
    if (cosine <= sharpTurnCosine + 1e-12) corners.push({ id: `rim:${key}`, position: point, cells: [...node.owners] });
  }
  return corners;
}

/** Logical cell corners for sparse assembly connectors; no render offsets.
 * Source junctions take priority over sharp fixed perimeter turns. Solid views
 * use one actual stock-joint anchor per owner, never both cap tessellations.
 */
export function assemblyGuideCorners({ cells = [], surfaceCells = cells, corners = [], solids = [], view = 'flat' } = {}) {
  const output = new Map(cells.map(cell => [cell.id, []]));
  if (!['surface', 'flat', 'solid'].includes(view)) return output;
  const byId = new Map(cells.map(cell => [cell.id, cell]));
  const sourceById = new Map(surfaceCells.map(cell => [cell.id, cell]));
  const solidsById = new Map(solids.map(solid => [solid.id, solid]));
  const sourceIndices = new Map(surfaceCells.map(cell => [cell.id, outlineVertices(cell)]));
  const fittedIndices = new Map(cells.map(cell => [cell.id, outlineVertices(cell)]));
  const seen = new Map(cells.map(cell => [cell.id, new Set()]));
  const candidates = corners.filter(corner => corner && (typeof corner.id === 'string' || Number.isSafeInteger(corner.id)))
    .map(corner => ({ ...corner, id: `corner:${corner.id}` }));
  candidates.push(...fixedRimCorners(surfaceCells));
  for (const candidate of candidates) {
    if (!finitePoint(candidate.position) || !Array.isArray(candidate.cells)) continue;
    const key = pointKey(candidate.position);
    for (const id of candidate.cells) {
      if (!output.has(id) || seen.get(id).has(key)) continue;
      const sourceIndex = sourceIndices.get(id)?.get(key);
      if (sourceIndex === undefined) continue;
      let position;
      if (view === 'surface') position = sourceById.get(id).positions[sourceIndex];
      else {
        const cell = byId.get(id), index = fittedIndices.get(id).get(key);
        if (index === undefined || !finitePoint(cell.flatPositions?.[index])) continue;
        if (view === 'flat') position = cell.flatPositions[index];
        else {
          const solid = solidsById.get(id), sharedVertexId = cell.sharedVertexIds?.[index];
          if (!solid?.positions?.length || !Number.isInteger(sharedVertexId)) continue;
          const side = solid.carved && solid.carvedSide === 'positive' ? 'negative' : 'positive';
          position = solid.cornerAnchors?.find(anchor => anchor.sharedVertexId === sharedVertexId)?.[side];
        }
      }
      if (!finitePoint(position)) continue;
      output.get(id).push({ id: candidate.id, position: [...position] });
      seen.get(id).add(key);
    }
  }
  return output;
}
