// Small, read-only inspection evidence derived from the actual displayed
// candidate. Do not invent an exact failed seam when the calculation only
// provides a panel-level issue. All outputs are copies, never solver inputs.
const point = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const sub = (a, b) => a.map((value, axis) => value - b[axis]);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const distance = (a, b) => Math.hypot(...sub(a, b));
const lerp = (a, b, t) => a.map((value, axis) => value + (b[axis] - value) * t);
const mean = points => points.reduce((sum, p) => sum.map((value, axis) => value + p[axis] / points.length), [0, 0, 0]);
const mm = value => `${Number(value.toFixed(3))} mm`;
const side = (a, b, p) => (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);

function edgesFor(cell) {
  const edges = [];
  for (let ri = 0; ri < (cell.loops || []).length; ri++) {
    const ring = cell.loops[ri];
    for (let i = 0; i < ring.length; i++) {
      const from = ring[i], to = ring[(i + 1) % ring.length], a = cell.flatPositions?.[from], b = cell.flatPositions?.[to];
      if (!point(a) || !point(b)) continue;
      const ga = cell.sharedVertexIds?.[from], gb = cell.sharedVertexIds?.[to];
      edges.push({ ri, i, count: ring.length, from, to, a, b, length: distance(a, b),
        key: Number.isSafeInteger(ga) && Number.isSafeInteger(gb) ? [ga, gb].sort((x, y) => x - y).join(':') : null });
    }
  }
  return edges;
}

function localProject(cell) {
  const plane = cell.plane;
  if (!point(plane?.origin) || !point(plane?.u) || !point(plane?.v)) return null;
  return p => { const d = sub(p, plane.origin); return [dot(d, plane.u), dot(d, plane.v)]; };
}

function crossing(edges, project) {
  if (!project) return null;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const first = edges[i], second = edges[j];
    if (first.ri === second.ri && (Math.abs(first.i-second.i) === 1 || Math.abs(first.i-second.i) === first.count - 1)) continue;
    const [a, b, c, d] = [first.a, first.b, second.a, second.b].map(project);
    const one = side(a, b, c), two = side(a, b, d), three = side(c, d, a), four = side(c, d, b);
    const epsilon = 1e-8 * Math.max(1, first.length, second.length);
    if (one * two < -epsilon * epsilon && three * four < -epsilon * epsilon) {
      const t = three / (three - four), position = lerp(first.a, first.b, t);
      return { first, second, position, kind: 'crossing' };
    }
    // Nonadjacent touching or overlapping boundaries are also actionable,
    // but adjacency above excludes normal corners of the same ring.
    const on = (p, q, r) => Math.abs(side(p, q, r)) <= epsilon && r[0] >= Math.min(p[0], q[0])-1e-8 && r[0] <= Math.max(p[0], q[0])+1e-8 && r[1] >= Math.min(p[1], q[1])-1e-8 && r[1] <= Math.max(p[1], q[1])+1e-8;
    for (const [p, q, r, world] of [[a,b,c,second.a],[a,b,d,second.b],[c,d,a,first.a],[c,d,b,first.b]]) if (on(p, q, r)) return { first, second, position: [...world], kind: 'overlap' };
  }
  return null;
}

function stockMismatch(selected, solids, neighbours) {
  const own = solids.get(selected.id);
  if (!own?.cornerAnchors?.length) return null;
  let worst = null;
  for (const id of neighbours) {
    const other = solids.get(id);
    if (!other?.cornerAnchors?.length) continue;
    const lookup = new Map(other.cornerAnchors.map(anchor => [anchor.sharedVertexId, anchor]));
    for (const anchor of own.cornerAnchors) {
      const paired = lookup.get(anchor.sharedVertexId);
      if (!paired) continue;
      for (const side of ['positive', 'negative']) {
        if (own.carved && side === (own.carvedSide || 'negative') || other.carved && side === (other.carvedSide || 'negative')) continue;
        const a = anchor[side], b = paired[side];
        if (!point(a) || !point(b)) continue;
        const gap = distance(a, b);
        if (!worst || gap > worst.gap) worst = { gap, a, b, otherId: id, sharedVertexId: anchor.sharedVertexId };
      }
    }
  }
  return worst;
}

export function inspectPanelJoint(result, panelId) {
  const cells = new Map((result?.cells || []).map(cell => [cell.id, cell])), selected = cells.get(panelId);
  if (!selected) throw new Error('This panel is no longer in the current calculation. Wait for the panels to update and select it again.');
  const edges = edgesFor(selected), owners = new Map();
  for (const cell of cells.values()) for (const edge of edgesFor(cell)) if (edge.key) {
    if (!owners.has(edge.key)) owners.set(edge.key, new Set());
    owners.get(edge.key).add(cell.id);
  }
  const neighbours = new Set((selected.neighbors || []).filter(id => id !== panelId && cells.has(id)));
  for (const edge of edges) for (const id of owners.get(edge.key) || []) if (id !== panelId) neighbours.add(id);
  const sharedEdges = edges.filter(edge => (owners.get(edge.key)?.size || 0) > 1);
  const solids = new Map((result?.solids || []).map(solid => [solid.id, solid]));
  const shortest = edges.reduce((best, edge) => !best || edge.length < best.length ? edge : best, null);
  let planarity = null;
  if (point(selected.plane?.origin) && point(selected.plane?.normal)) {
    const normalLength = Math.hypot(...selected.plane.normal);
    if (normalLength > 1e-12) for (const p of selected.flatPositions || []) if (point(p)) {
      const signed = dot(sub(p, selected.plane.origin), selected.plane.normal) / normalLength;
      if (!planarity || Math.abs(signed) > planarity.distance) planarity = { point: p, distance: Math.abs(signed), projected: p.map((value, axis) => value - signed * selected.plane.normal[axis] / normalLength) };
    }
  }
  const mismatch = stockMismatch(selected, solids, neighbours), crossed = crossing(edges, localProject(selected));
  const issues = [...(selected.issues || []), ...(solids.get(panelId)?.issues || [])].join(' ');
  let segments = [], points = [], precision = 'panel', kind = 'panel', explanation;
  if (crossed) {
    segments = [[crossed.first.a, crossed.first.b], [crossed.second.a, crossed.second.b]];
    points = [crossed.position]; precision = 'exact'; kind = crossed.kind;
    explanation = crossed.kind === 'crossing' ? 'The highlighted edges cross in this panel’s flat outline. Move their source corners apart or divide the region.'
      : 'The highlighted nonadjacent edges touch or overlap in the flat outline. Separate these boundaries by moving nearby source corners.';
    for (const edge of [crossed.first, crossed.second]) for (const id of owners.get(edge.key) || []) if (id !== panelId) neighbours.add(id);
  } else if (mismatch && mismatch.gap > 1e-5 && /joint corner differs|incident offset faces|incompatible mitres/i.test(issues)) {
    segments = [[mismatch.a, mismatch.b]]; points = [mismatch.a, mismatch.b]; precision = 'exact'; kind = 'stock-joint';
    explanation = `These unrounded stock-joint corners miss each other by ${mm(mismatch.gap)}. Adjust the meeting panels or try less thickness.`;
  } else if (planarity && planarity.distance > 1e-5 && /not flat enough|out of plane|offset-junction|meet at this offset/i.test(`${issues} ${(selected.offsetIssueCodes || []).join(' ')}`)) {
    segments = [[planarity.point, planarity.projected]]; points = [planarity.point]; precision = 'exact'; kind = 'planarity';
    explanation = `The highlighted corner is ${mm(planarity.distance)} away from this panel’s required flat face. Adjust nearby corners or reduce the panel offsets.`;
  } else if (shortest && shortest.length < 1e-5) {
    segments = [[shortest.a, shortest.b]]; points = [shortest.a, shortest.b]; precision = 'exact'; kind = 'collapsed-edge';
    explanation = 'The highlighted outline edge has collapsed to almost zero length. Move its source corners apart or merge the unwanted small region.';
  } else {
    segments = (sharedEdges.length ? sharedEdges : edges).slice(0, 96).map(edge => [edge.a, edge.b]);
    if (shortest) points = [lerp(shortest.a, shortest.b, .5)];
    explanation = selected.valid && solids.get(panelId)?.valid ? 'This panel passes the current geometry checks. Shared edges and neighbours are shown for inspection.'
      : 'The calculation identifies this panel but does not locate one exact failed joint. Its shared edges and neighbouring panels are shown so you can inspect the region; the shortest outline edge is marked.';
  }
  const panelIds = [panelId, ...[...neighbours].sort((a, b) => a - b)];
  // A stock failure can sit beyond the nominal outline. Include the actual
  // part and highlighted anchors so zoom and section range do not hide it.
  const all = [...panelIds.flatMap(id => [...(cells.get(id)?.flatPositions || []), ...(solids.get(id)?.positions || [])]), ...points].filter(point);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of all) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], p[axis]); max[axis] = Math.max(max[axis], p[axis]); }
  if (!all.length) { min.fill(0); max.fill(0); }
  const focus = points.length ? mean(points) : all.length ? mean(all) : [0, 0, 0];
  return { panelId, panelIds, segments: segments.map(segment => segment.map(p => [...p])), points: points.map(p => [...p]), focus, bounds: { min, max },
    sectionNormal: point(selected.plane?.normal) ? [...selected.plane.normal] : [0, 0, 1],
    measurements: { shortestEdgeMm: shortest?.length ?? null, maxPlanarityMm: planarity?.distance ?? null, maxSharedCornerMismatchMm: mismatch?.gap ?? null },
    explanation, precision, kind };
}
