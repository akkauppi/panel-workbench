import { analyzeModel, generateCells, generateCellLayout } from './geometry.js';
import { readPattern } from './pattern.js';

const add = (a, b) => a.map((value, axis) => value + b[axis]);
const sub = (a, b) => a.map((value, axis) => value - b[axis]);
const mul = (a, scale) => a.map(value => value * scale);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(...a);
const unit = a => mul(a, 1 / length(a));
const rotate = (point, angle) => [Math.cos(angle) * point[0] + Math.sin(angle) * point[2], point[1], -Math.sin(angle) * point[0] + Math.cos(angle) * point[2]];

// Class-I frequency subdivision: f=1 has 12 sites, f=2 has 42, f=3 has 92.
// The spherical Voronoi dual has twelve pentagons and otherwise hexagons.
function subdividedIcosahedron(frequency) {
  const t = (1 + Math.sqrt(5)) / 2;
  const corners = [[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],[t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]].map(unit);
  const faces = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
    [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  const vertices = [], triangles = [], ids = new Map();
  for (const face of faces) {
    const [a, b, c] = face.map(id => corners[id]), local = new Map();
    for (let i = 0; i <= frequency; i++) for (let j = 0; j <= frequency - i; j++) {
      const point = unit(add(add(mul(a, frequency - i - j), mul(b, i)), mul(c, j)));
      const key = point.map(value => Math.round(value * 1e10)).join(',');
      if (!ids.has(key)) { ids.set(key, vertices.length); vertices.push(point); }
      local.set(`${i},${j}`, ids.get(key));
    }
    const id = (i, j) => local.get(`${i},${j}`);
    for (let i = 0; i < frequency; i++) for (let j = 0; j < frequency - i; j++) {
      triangles.push([id(i, j), id(i + 1, j), id(i, j + 1)]);
      if (i + j < frequency - 1) triangles.push([id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  }
  return { vertices, triangles };
}

/** Original spherical source mesh, independent of any panel pattern. */
export function createGeodesicSphere({ radius = 1500, subdivisions = 12 } = {}) {
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isInteger(subdivisions) || subdivisions < 1 || subdivisions > 30) throw new Error('Choose a positive sphere radius and 1–30 source subdivisions.');
  const mesh = subdividedIcosahedron(subdivisions);
  return { name: 'Geodesic sphere', vertices: mesh.vertices.map(point => mul(point, radius)), triangles: mesh.triangles };
}

function planeFor(model) {
  const analysis = analyzeModel(model), diagonal = length(analysis.dimensions);
  const first = model.triangles.find(triangle => length(cross(sub(model.vertices[triangle[1]], model.vertices[triangle[0]]), sub(model.vertices[triangle[2]], model.vertices[triangle[0]]))) > 1e-9);
  let normal = unit(cross(sub(model.vertices[first[1]], model.vertices[first[0]]), sub(model.vertices[first[2]], model.vertices[first[0]])));
  const largest = Math.max(...normal.map(Math.abs)), dominant = normal.findIndex(value => Math.abs(value) >= largest - 1e-10);
  if (normal[dominant] < 0) normal = mul(normal, -1);
  const constant = dot(normal, model.vertices[first[0]]), tolerance = Math.max(1e-4, diagonal * 1e-7);
  if (model.vertices.some(point => Math.abs(dot(normal, point) - constant) > tolerance)) throw new Error('Hexagonal layout requires a planar source surface. Choose a flat sheet or use another pattern.');
  const axis = Math.abs(normal[0]) < .9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(sub(axis, mul(normal, dot(axis, normal)))), v = cross(normal, u);
  const origin = add(analysis.center, mul(normal, constant - dot(normal, analysis.center)));
  return { origin, u, v, normal };
}

function solve(matrix, rhs) {
  const rows = matrix.map((row, i) => [...row, rhs[i]]), n = rows.length;
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    if (Math.abs(rows[pivot][column]) < 1e-11) throw new Error('Geodesic layout requires a spherical surface with enough curvature to determine its centre.');
    [rows[pivot], rows[column]] = [rows[column], rows[pivot]];
    const divisor = rows[column][column];
    for (let k = column; k <= n; k++) rows[column][k] /= divisor;
    for (let row = 0; row < n; row++) if (row !== column) {
      const factor = rows[row][column];
      for (let k = column; k <= n; k++) rows[row][k] -= factor * rows[column][k];
    }
  }
  return rows.map(row => row[n]);
}

function sphereFor(model) {
  const analysis = analyzeModel(model), scale = length(analysis.dimensions), origin = analysis.center;
  const matrix = Array.from({ length: 4 }, () => [0, 0, 0, 0]), rhs = [0, 0, 0, 0];
  for (const point of model.vertices) {
    const p = mul(sub(point, origin), 1 / scale), row = [2 * p[0], 2 * p[1], 2 * p[2], 1], value = dot(p, p);
    for (let i = 0; i < 4; i++) { rhs[i] += row[i] * value; for (let j = 0; j < 4; j++) matrix[i][j] += row[i] * row[j]; }
  }
  const solution = solve(matrix, rhs), offset = solution.slice(0, 3), center = add(origin, mul(offset, scale));
  const radius = scale * Math.sqrt(solution[3] + dot(offset, offset)), tolerance = Math.max(1e-3, radius * 1e-5);
  if (!Number.isFinite(radius) || radius <= 0 || model.vertices.some(point => Math.abs(length(sub(point, center)) - radius) > tolerance)) {
    throw new Error('Geodesic layout requires a spherical source surface. An arbitrary curved model cannot use a spherical pentagon/hexagon pattern.');
  }
  // Radial projection must describe one surface sheet. A triangle through the
  // centre, or mixed inward/outward sheets, is not a spherical source patch.
  let orientation = 0;
  for (const triangle of model.triangles) {
    const [a, b, c] = triangle.map(id => sub(model.vertices[id], center)), normal = cross(sub(b, a), sub(c, a));
    const distance = dot(unit(normal), a), sign = Math.sign(distance);
    if (Math.abs(distance) < radius * .1 || (orientation && sign !== orientation)) throw new Error('The spherical source has folded or inconsistently oriented triangles.');
    orientation = sign;
  }
  return { center, radius };
}

function closestPoint(point, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(point, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(point, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
  const cp = sub(point, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, mul(sub(c, b), (d4 - d3) / (d4 - d3 + d5 - d6)));
  return add(a, add(mul(ab, vb / (va + vb + vc)), mul(ac, vc / (va + vb + vc))));
}

function sourceAnchor(cell, target) {
  let closest = null, best = Infinity;
  for (const triangle of cell.triangles) {
    const point = closestPoint(target, ...triangle.map(id => cell.positions[id])), d = length(sub(point, target));
    if (d < best) { best = d; closest = point; }
  }
  return [...closest];
}

/** Exact affine bisectors clipped against the original source triangles.
 * Plane boundary cells and spherical patches are naturally clipped by the
 * source perimeter and openings. Only a whole sphere has the closed 12/hex rule.
 */
export function generateStructuredLayout(model, input, options = {}) {
  const pattern = readPattern(input), angle = pattern.angle * Math.PI / 180;
  if (pattern.type === 'organic') throw new Error('Choose a structured hexagonal or geodesic pattern.');
  if (options.cornerEdits?.length) throw new Error('Use direct corner editing for a structured layout.');
  let sites, score;
  if (pattern.type === 'hexagonal') {
    const size = Number(options.size);
    if (!Number.isFinite(size) || size < 10) throw new Error('Set a hexagon centre spacing of at least 10 mm.');
    const plane = planeFor(model), u = add(mul(plane.u, Math.cos(angle)), mul(plane.v, Math.sin(angle)));
    const v = add(mul(plane.v, Math.cos(angle)), mul(plane.u, -Math.sin(angle)));
    const coordinates = model.vertices.map(point => { const p = sub(point, plane.origin); return [dot(p, u), dot(p, v)]; });
    const low = [Infinity, Infinity], high = [-Infinity, -Infinity];
    for (const p of coordinates) for (let axis = 0; axis < 2; axis++) { low[axis] = Math.min(low[axis], p[axis]); high[axis] = Math.max(high[axis], p[axis]); }
    sites = []; const rowStep = size * Math.sqrt(3) / 2;
    for (let row = Math.floor(low[1] / rowStep) - 1; row <= Math.ceil(high[1] / rowStep) + 1; row++) {
      for (let column = Math.floor(low[0] / size - row / 2) - 1; column <= Math.ceil(high[0] / size - row / 2) + 1; column++) {
        if (sites.length >= 500) throw new Error('This structured layout needs more than 500 candidate cells. Increase the hexagon spacing.');
        const x = size * (column + row / 2), y = row * rowStep;
        sites.push({ id: sites.length, position: add(plane.origin, add(mul(u, x), mul(v, y))), weight: 1, x, y });
      }
    }
    const byId = new Map(sites.map(site => [site.id, site]));
    score = (point, seed) => {
      const site = byId.get(seed.id), p = sub(point, plane.origin);
      return (site.x * site.x + site.y * site.y - 2 * (site.x * dot(p, u) + site.y * dot(p, v))) / (2 * size);
    };
  } else {
    const sphere = sphereFor(model), mesh = subdividedIcosahedron(pattern.frequency);
    const directions = mesh.vertices.map(point => rotate(point, angle));
    sites = directions.map((direction, id) => ({ id, position: add(sphere.center, mul(direction, sphere.radius)), weight: 1 }));
    score = (point, seed) => -dot(directions[seed.id], sub(point, sphere.center));
  }
  if (sites.length > 500) throw new Error('This structured layout needs more than 500 candidate cells. Increase the hexagon spacing or reduce the geodesic frequency.');
  const initial = generateCells(model, sites, { size: options.size, score });
  const active = new Set(initial.cells.map(cell => cell.id)), activeSites = sites.filter(site => active.has(site.id));
  const surface = generateCellLayout(model, activeSites, { size: options.size, score, mergeGroups: options.mergeGroups || [] });
  const sourceCells = new Map(initial.cells.map(cell => [cell.id, cell]));
  const seeds = activeSites.map(site => ({ id: site.id, position: sourceAnchor(sourceCells.get(site.id), site.position), weight: 1 }));
  const anchors = new Map(seeds.map(seed => [seed.id, seed.position]));
  for (const cell of surface.cells) cell.seed = [...anchors.get(cell.id)];
  return { seeds, surface };
}
