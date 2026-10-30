// Shape diagnostics only. These measurements never repair a polygon or make
// a panel exportable; planarity, source coverage and solid checks stay separate.
const EPS = 1e-10;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const length = a => Math.hypot(...a);
const distance = (a, b) => length(sub(a, b));
const signedArea = ring => ring.reduce((sum, a, i) => sum + cross(a, ring[(i + 1) % ring.length]), 0) / 2;
const perimeter = ring => ring.reduce((sum, a, i) => sum + distance(a, ring[(i + 1) % ring.length]), 0);

function onSegment(point, a, b) {
  return Math.abs(cross(sub(b, a), sub(point, a))) <= EPS * distance(a, b)
    && point[0] >= Math.min(a[0], b[0]) - EPS && point[0] <= Math.max(a[0], b[0]) + EPS
    && point[1] >= Math.min(a[1], b[1]) - EPS && point[1] <= Math.max(a[1], b[1]) + EPS;
}

function segmentsMeet(a, b, c, d) {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) - EPS || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) - EPS
    || Math.max(a[1], b[1]) < Math.min(c[1], d[1]) - EPS || Math.max(c[1], d[1]) < Math.min(a[1], b[1]) - EPS) return false;
  if (onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b)) return true;
  const ab = sub(b, a), cd = sub(d, c);
  return cross(ab, sub(c, a)) * cross(ab, sub(d, a)) < 0
    && cross(cd, sub(a, c)) * cross(cd, sub(b, c)) < 0;
}

function inside(point, ring) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function removeCollinear(ring) {
  const result = [...ring];
  let changed = true;
  while (changed && result.length >= 3) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      const a = result[(i + result.length - 1) % result.length], b = result[i], c = result[(i + 1) % result.length];
      if (distance(a, c) > EPS && Math.abs(cross(sub(c, a), sub(b, a))) <= EPS * distance(a, c)
        && dot(sub(b, a), sub(b, c)) <= EPS * EPS) {
        result.splice(i, 1); changed = true; break;
      }
    }
  }
  return result;
}

function hullArea(points) {
  const ordered = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  function half(input) {
    const result = [];
    for (const p of input) {
      while (result.length >= 2 && cross(sub(result.at(-1), result.at(-2)), sub(p, result.at(-1))) <= 0) result.pop();
      result.push(p);
    }
    return result;
  }
  const lower = half(ordered), upper = half([...ordered].reverse());
  return Math.abs(signedArea([...lower.slice(0, -1), ...upper.slice(0, -1)]));
}

function emptyQuality() {
  return { classification: 'degenerate', valid: false, convex: false, degenerate: true, selfIntersects: false,
    holeCount: 0, componentCount: 0, cornerCount: 0, concaveVertexCount: 0,
    area: 0, perimeter: 0, edgeLengthCV: null, compactness: null,
    minInteriorAngle: null, maxInteriorAngle: null, reflexTurnFraction: null, hullDeficit: null };
}

/** Inspect cell.outline2d (an array of rings). Ring order and winding do not
 * determine holes: containment does. Angles are degrees; area/perimeter retain
 * input units. CV, compactness, reflex turns and hull deficit are unitless.
 * Collinear subdivisions and a repeated closing point do not add corners.
 * Touching/overlapping rings are invalid, including a hole touching its shell. */
export function inspectPolygon(outline2d) {
  const result = emptyQuality();
  if (!Array.isArray(outline2d) || !outline2d.length || outline2d.some(ring => !Array.isArray(ring) || ring.length < 3
    || ring.some(point => !Array.isArray(point) || point.length !== 2 || point.some(value => !Number.isFinite(value))))) return result;
  const points = outline2d.flat(), low = [Infinity, Infinity], high = [-Infinity, -Infinity];
  for (const point of points) for (let axis = 0; axis < 2; axis++) {
    low[axis] = Math.min(low[axis], point[axis]); high[axis] = Math.max(high[axis], point[axis]);
  }
  const scale = Math.max(high[0] - low[0], high[1] - low[1]);
  if (!Number.isFinite(scale) || scale <= 0) return result;
  const origin = low.map((value, axis) => value / 2 + high[axis] / 2);
  const rawRings = outline2d.map(ring => {
    const normalized = ring.map(point => point.map((value, axis) => (value - origin[axis]) / scale));
    if (distance(normalized[0], normalized.at(-1)) <= EPS) normalized.pop();
    return normalized;
  });
  let degenerate = rawRings.some(ring => ring.length < 3 || ring.some((point, i) => distance(point, ring[(i + 1) % ring.length]) <= EPS));
  const rings = rawRings.map(removeCollinear), areas = rings.map(signedArea);
  degenerate ||= rings.some((ring, i) => ring.length < 3 || Math.abs(areas[i]) <= EPS * EPS);
  if (rings.some(ring => ring.length < 3)) return { ...result,
    cornerCount: rings.reduce((sum, ring) => sum + ring.length, 0), perimeter: rawRings.reduce((sum, ring) => sum + perimeter(ring), 0) * scale };
  const edges = rings.flatMap((ring, r) => ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length], r, i })));
  let selfIntersects = false;
  for (let i = 0; i < edges.length && !selfIntersects; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i], b = edges[j];
    const adjacent = a.r === b.r && (Math.abs(a.i - b.i) === 1 || Math.abs(a.i - b.i) === rings[a.r].length - 1);
    if (adjacent) {
      // Consecutive collinear edges may meet, but may not double back.
      const axis = Math.abs(a.b[0] - a.a[0]) >= Math.abs(a.b[1] - a.a[1]) ? 0 : 1;
      const overlap = Math.min(Math.max(a.a[axis], a.b[axis]), Math.max(b.a[axis], b.b[axis]))
        - Math.max(Math.min(a.a[axis], a.b[axis]), Math.min(b.a[axis], b.b[axis]));
      if (overlap > EPS && Math.abs(cross(sub(a.b, a.a), sub(b.a, a.a))) <= EPS * distance(a.a, a.b)
        && Math.abs(cross(sub(a.b, a.a), sub(b.b, a.a))) <= EPS * distance(a.a, a.b)) selfIntersects = true;
    } else if (segmentsMeet(a.a, a.b, b.a, b.b)) selfIntersects = true;
    if (selfIntersects) break;
  }
  Object.assign(result, { degenerate, selfIntersects, cornerCount: rings.reduce((sum, ring) => sum + ring.length, 0),
    perimeter: rawRings.reduce((sum, ring) => sum + perimeter(ring), 0) * scale });
  if (selfIntersects) { result.classification = 'self-crossing'; return result; }
  if (degenerate) return result;
  const depths = rings.map((ring, i) => rings.reduce((depth, outer, j) => depth + (i !== j && inside(ring[0], outer) ? 1 : 0), 0));
  result.holeCount = depths.filter(depth => depth % 2 === 1).length;
  result.componentCount = depths.filter(depth => depth % 2 === 0).length;
  const area = areas.reduce((sum, value, i) => sum + Math.abs(value) * (depths[i] % 2 ? -1 : 1), 0);
  result.area = area * scale * scale;
  if (result.componentCount !== 1) { result.classification = 'disconnected'; return result; }
  result.valid = true;
  const lengths = rings.flatMap(ring => ring.map((point, i) => distance(point, ring[(i + 1) % ring.length])));
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  result.edgeLengthCV = Math.sqrt(lengths.reduce((sum, value) => sum + (value / mean - 1) ** 2, 0) / lengths.length);
  const totalPerimeter = lengths.reduce((sum, value) => sum + value, 0);
  result.compactness = Math.max(0, Math.min(1, 4 * Math.PI * area / (totalPerimeter * totalPerimeter)));
  if (result.holeCount) { result.classification = 'holed'; return result; }
  const ring = rings[0], orientation = Math.sign(areas[0]), angles = ring.map((point, i) => {
    const incoming = sub(point, ring[(i + ring.length - 1) % ring.length]), outgoing = sub(ring[(i + 1) % ring.length], point);
    return 180 - orientation * Math.atan2(cross(incoming, outgoing), dot(incoming, outgoing)) * 180 / Math.PI;
  });
  result.minInteriorAngle = Math.min(...angles); result.maxInteriorAngle = Math.max(...angles);
  result.concaveVertexCount = angles.filter(angle => angle > 180 + 1e-7).length;
  result.reflexTurnFraction = angles.reduce((sum, angle) => sum + Math.max(0, angle - 180), 0) / 360;
  const hull = hullArea(ring);
  result.hullDeficit = Math.max(0, Math.min(1, (hull - area) / hull));
  result.convex = result.concaveVertexCount === 0;
  result.classification = result.convex ? 'convex' : 'concave';
  return result;
}

/** Aggregate fitted or source-projected outlines without conflating shape
 * quality with the cell.valid fabrication decision. */
export function measureLayoutQuality(cells) {
  const quality = cells.map(cell => inspectPolygon(cell.outline2d));
  const count = classification => quality.filter(value => value.classification === classification).length;
  const mean = key => {
    const values = quality.map(value => value[key]).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return { totalCount: quality.length, convexCount: count('convex'), concaveCount: count('concave'), holedCount: count('holed'),
    disconnectedCount: count('disconnected'), degenerateCount: count('degenerate'), selfCrossingCount: count('self-crossing'),
    invalidCount: quality.filter(value => !value.valid).length, meanCompactness: mean('compactness'),
    meanEdgeLengthCV: mean('edgeLengthCV'), meanHullDeficit: mean('hullDeficit'), meanReflexTurnFraction: mean('reflexTurnFraction') };
}
