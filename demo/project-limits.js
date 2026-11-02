/** Project preferences are advisory measurements, independent of the geometric
 * validity gates. Nothing here changes panels or certifies a machining setup. */
export const PROJECT_LIMITS_FEATURE = 'project-limits-v1';
const fields = ['stockWidthMm', 'stockHeightMm', 'minEdgeMm', 'maxDeviationMm'];
const labels = { stockWidthMm: 'stock width', stockHeightMm: 'stock height', minEdgeMm: 'minimum edge length', maxDeviationMm: 'maximum shell deviation' };
const point = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const sub = (a, b) => a.map((value, axis) => value - b[axis]);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = v => { const length = Math.hypot(...v); return length > 1e-12 ? v.map(value => value / length) : null; };
const rounded = value => Number(value.toFixed(3));
const mm = value => `${Number(value.toFixed(2))} mm`;

export function readProjectLimits(input) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Project limits must be distances in millimetres.');
  const result = {};
  for (const field of fields) {
    const value = input[field] ?? null;
    if (value !== null && (!Number.isFinite(value) || value < (field.startsWith('stock') ? Number.MIN_VALUE : 0) || value > 1e7)) throw new Error(`Enter a valid ${labels[field]} in millimetres, or leave it blank.`);
    result[field] = value;
  }
  if ((result.stockWidthMm === null) !== (result.stockHeightMm === null)) throw new Error('Enter both stock width and stock height, or leave both blank.');
  return result;
}

export function hasProjectLimits(input) { return Object.values(readProjectLimits(input)).some(value => value !== null); }

function hull(points) {
  const sorted = [...new Map(points.map(p => [`${p[0]}:${p[1]}`, [...p]])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const turn = (a, b, c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const lower = [], upper = [];
  for (const p of sorted) { while (lower.length > 1 && turn(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p); }
  for (const p of sorted.reverse()) { while (upper.length > 1 && turn(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function extent(points, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), low = [Infinity, Infinity], high = [-Infinity, -Infinity];
  const supports = [null, null, null, null];
  for (const p of points) {
    const x = p[0]*c+p[1]*s, y = -p[0]*s+p[1]*c;
    if (x < low[0]) { low[0] = x; supports[0] = p; }
    if (x > high[0]) { high[0] = x; supports[1] = p; }
    if (y < low[1]) { low[1] = y; supports[2] = p; }
    if (y > high[1]) { high[1] = y; supports[3] = p; }
  }
  return { width: high[0]-low[0], height: high[1]-low[1], angle, supports };
}

/** Exact orientation intervals for a convex footprint. Checking only the
 * minimum-area rectangle can incorrectly reject a usable sheet orientation. */
export function measureStockFootprint(points, stockWidth = null, stockHeight = null) {
  if (!Array.isArray(points) || points.length < 3 || points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) return null;
  const polygon = hull(points);
  if (polygon.length < 3) return null;
  const quarter = Math.PI / 2, angles = [0, quarter];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const angle = ((Math.atan2(b[1]-a[1], b[0]-a[0]) % quarter) + quarter) % quarter;
    angles.push(angle);
  }
  angles.sort((a, b) => a - b);
  const breaks = angles.filter((value, i) => !i || value - angles[i - 1] > 1e-12);
  let best = extent(polygon, 0), fitting = null;
  const configured = stockWidth !== null && stockHeight !== null;
  const consider = angle => {
    const box = extent(polygon, angle);
    if (box.width * box.height < best.width * best.height - 1e-7) best = box;
    if (configured && box.width <= stockWidth + 1e-7 && box.height <= stockHeight + 1e-7 && (!fitting || box.width * box.height < fitting.width * fitting.height)) fitting = box;
  };
  const roots = (a, b, target, low, high) => {
    const radius = Math.hypot(a, b);
    if (!radius || target > radius + 1e-8) return [];
    const center = Math.atan2(b, a), delta = Math.acos(Math.max(-1, Math.min(1, target / radius))), found = [];
    for (const direction of [-1, 1]) for (const revolution of [-1, 0, 1]) {
      const angle = center + direction * delta + revolution * 2 * Math.PI;
      if (angle >= low - 1e-12 && angle <= high + 1e-12) found.push(Math.max(low, Math.min(high, angle)));
    }
    return found;
  };
  for (let i = 1; i < breaks.length; i++) {
    const low = breaks[i - 1], high = breaks[i], middle = extent(polygon, (low + high) / 2), candidates = [low, high];
    if (configured) {
      const [left, right, bottom, top] = middle.supports;
      candidates.push(...roots(right[0]-left[0], right[1]-left[1], stockWidth, low, high));
      candidates.push(...roots(top[1]-bottom[1], -(top[0]-bottom[0]), stockHeight, low, high));
      candidates.push(...roots(right[0]-left[0], right[1]-left[1], stockHeight, low, high));
      candidates.push(...roots(top[1]-bottom[1], -(top[0]-bottom[0]), stockWidth, low, high));
    }
    candidates.sort((a, b) => a - b);
    for (let j = 0; j < candidates.length; j++) {
      consider(candidates[j]); consider(candidates[j] + quarter);
      if (j) { const middle = (candidates[j - 1] + candidates[j]) / 2; consider(middle); consider(middle + quarter); }
    }
  }
  const chosen = fitting || best;
  return { widthMm: rounded(chosen.width), heightMm: rounded(chosen.height), rotationDegrees: rounded(chosen.angle * 180 / Math.PI), fitsStock: configured ? !!fitting : null,
    minimumRectangleWidthMm: rounded(best.width), minimumRectangleHeightMm: rounded(best.height) };
}

function footprint(cell, solid) {
  const plane = solid?.plane || cell.plane;
  if (!plane || !point(plane.origin) || !point(plane.normal) || !point(plane.u)) return null;
  const normal = unit(plane.normal), u = normal && unit(sub(plane.u, normal.map(value => value * dot(plane.u, normal)))), v = normal && u && unit(cross(normal, u));
  if (!normal || !u || !v) return null;
  const flat = (cell.flatPositions || []).filter(point), hasSolid = !!solid?.positions?.length && solid.positions.every(point);
  const points = hasSolid ? [...solid.positions, ...flat] : flat;
  return { points: points.map(p => { const d = sub(p, plane.origin); return [dot(d, u), dot(d, v)]; }), representation: hasSolid ? solid.valid ? 'full-part' : 'solid-candidate' : 'outline-only' };
}

export function evaluateProjectLimits(result, input) {
  const limits = readProjectLimits(input), solids = new Map((result?.solids || []).map(solid => [solid.id, solid]));
  const panels = (result?.cells || []).map(cell => {
    let shortestEdge = Infinity;
    for (const ring of cell.loops || []) for (let i = 0; i < ring.length; i++) {
      const a = cell.flatPositions?.[ring[i]], b = cell.flatPositions?.[ring[(i + 1) % ring.length]];
      if (point(a) && point(b)) shortestEdge = Math.min(shortestEdge, Math.hypot(...sub(a, b)));
    }
    const sourceDeviation = Number.isFinite(cell.maxDeviation) ? cell.maxDeviation : null;
    const projected = footprint(cell, solids.get(cell.id)), stock = projected ? measureStockFootprint(projected.points, limits.stockWidthMm, limits.stockHeightMm) : null;
    const measurements = { shortestEdgeMm: Number.isFinite(shortestEdge) ? rounded(shortestEdge) : null, sourceDeviationMm: sourceDeviation === null ? null : rounded(sourceDeviation),
      stockWidthMm: stock?.widthMm ?? null, stockHeightMm: stock?.heightMm ?? null, stockRotationDegrees: stock?.rotationDegrees ?? null,
      // A candidate can be measured, but must not produce an apparent green
      // manufacturing result while the flat or solid geometry is unresolved.
      fitsStock: cell.valid && projected?.representation === 'full-part' ? stock?.fitsStock ?? null : null, footprint: projected?.representation ?? 'unavailable' };
    const warnings = [];
    if (limits.stockWidthMm !== null) {
      if (!stock || !cell.valid || projected.representation !== 'full-part') warnings.push({ code: 'stock-unchecked', message: 'A valid full part is needed to finish the stock-size check. Any shown dimensions describe the available candidate only.' });
      if (stock?.fitsStock === false) warnings.push({ code: 'stock-size', message: `This ${projected.representation === 'full-part' ? 'part' : 'candidate'} does not fit ${mm(limits.stockWidthMm)} × ${mm(limits.stockHeightMm)} stock at any in-plane rotation. Divide it, adjust the arrangement, or use larger stock.` });
    }
    if (limits.minEdgeMm !== null && Number.isFinite(shortestEdge) && shortestEdge < limits.minEdgeMm - 1e-7) warnings.push({ code: 'short-edge', message: `The shortest fitted outline edge is ${mm(shortestEdge)}; the project minimum is ${mm(limits.minEdgeMm)}. Move the nearby corners apart or merge a small region.` });
    if (limits.maxDeviationMm !== null && sourceDeviation !== null && sourceDeviation > limits.maxDeviationMm + 1e-7) warnings.push({ code: 'shell-deviation', message: `The panel is up to ${mm(sourceDeviation)} from its source samples; the project limit is ${mm(limits.maxDeviationMm)}. Smaller cells or a different arrangement may help. Intentional panel offsets count too.` });
    return { id: cell.id, warnings, measurements };
  });
  const warningPanelIds = panels.filter(panel => panel.warnings.length).map(panel => panel.id);
  return { limits, panels, warningPanelIds, warningCount: panels.reduce((sum, panel) => sum + panel.warnings.length, 0),
    note: 'Advisory checks only. Stock fit uses the full available part footprint with free in-plane rotation; it does not include machining allowance, grain direction, sheet nesting or machine access.' };
}
