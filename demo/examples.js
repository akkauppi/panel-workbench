// Original procedural examples, expressed in millimetres with Y pointing up.
// Factories return independent meshes; no imported asset or licence is needed.
import { createGeodesicSphere } from './structured.js';

export const DEFAULT_EXAMPLE_ID = 'barrel-vault';

export const EXAMPLES = Object.freeze([
  { id: 'barrel-vault', name: 'Barrel vault', description: 'A cylindrical roof with open ends and a smooth, continuous bend.', initialSize: 624 },
  { id: 'dome', name: 'Shallow dome', description: 'A spherical cap with curvature in both directions and a circular perimeter.', initialSize: 728 },
  { id: 'aperture-sheet', name: 'Sheet with an opening', description: 'A flat rectangular sheet with a genuine rectangular opening.', initialSize: 318 },
  { id: 'saddle', name: 'Saddle surface', description: 'A smooth sheet that curves upward in one direction and downward in the other.', initialSize: 520 },
  { id: 'organic-vessel', name: 'Organic vessel', description: 'A rounded asymmetric body with an offset neck, a flared open rim, and a curved closed base.', initialSize: 380 },
  { id: 'geodesic-sphere', name: 'Geodesic sphere', description: 'A whole sphere for geodesic layouts: frequency 2 gives 12 pentagons and 30 hexagons.', initialSize: 880,
    pattern: Object.freeze({ type: 'geodesic', angle: 0, frequency: 2 }) },
].map(example => Object.freeze({ ...example, units: 'mm', up: 'y' })));

function grid(columns, rows, point, include = () => true) {
  const vertices = [], triangles = [];
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) vertices.push(point(column / columns, row / rows));
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    if (!include(column, row)) continue;
    const a = row * (columns + 1) + column, b = a + 1, d = a + columns + 1, c = d + 1;
    triangles.push([a, d, c], [a, c, b]);
  }
  // Remove unreferenced points inside an aperture, preserving deterministic
  // ordering and keeping each example a compact source mesh.
  const used = new Set(triangles.flat()), remap = new Map(), points = [];
  vertices.forEach((position, id) => { if (used.has(id)) { remap.set(id, points.length); points.push(position); } });
  return { vertices: points, triangles: triangles.map(triangle => triangle.map(id => remap.get(id))) };
}

function barrelVault() {
  const radius = 2000, halfAngle = Math.PI / 3;
  return grid(40, 36, (u, v) => {
    const angle = (u * 2 - 1) * halfAngle;
    return [radius * Math.sin(angle), radius * (Math.cos(angle) - Math.cos(halfAngle)), (v - .5) * 3600];
  });
}

function dome() {
  const radius = 3600, rim = 1800, rings = 12, sectors = 64;
  const offset = Math.sqrt(radius * radius - rim * rim), vertices = [[0, radius - offset, 0]], triangles = [];
  for (let ring = 1; ring <= rings; ring++) for (let sector = 0; sector < sectors; sector++) {
    const r = rim * ring / rings, angle = sector * Math.PI * 2 / sectors;
    vertices.push([r * Math.cos(angle), Math.sqrt(radius * radius - r * r) - offset, r * Math.sin(angle)]);
  }
  for (let sector = 0; sector < sectors; sector++) {
    const next = (sector + 1) % sectors;
    triangles.push([0, 1 + next, 1 + sector]);
    for (let ring = 1; ring < rings; ring++) {
      const a = 1 + (ring - 1) * sectors + sector, b = 1 + (ring - 1) * sectors + next;
      const c = 1 + ring * sectors + next, d = 1 + ring * sectors + sector;
      triangles.push([a, b, c], [a, c, d]);
    }
  }
  return { vertices, triangles };
}

function apertureSheet() {
  return grid(40, 30, (u, v) => [(u - .5) * 4000, 0, (v - .5) * 3000],
    (column, row) => !(column >= 16 && column < 24 && row >= 12 && row < 18));
}

function saddle() {
  return grid(36, 28, (u, v) => {
    const x = u * 2 - 1, z = v * 2 - 1;
    return [x * 1800, 220 * (x * x - z * z), z * 1400];
  });
}

function organicVessel() {
  const sectors = 48, vertices = [[0, 0, 0]], triangles = [], profile = [];
  // Three cubic curves describe radius and height: a rounded base and belly,
  // a narrowing shoulder, then a flared neck. Tangents agree at the joins.
  const sections = [
    { steps: 10, points: [[0, 0], [400, 0], [1000, 180], [1050, 800]] },
    { steps: 12, points: [[1050, 800], [1100, 1420], [380, 1460], [360, 1900]] },
    { steps: 6, points: [[360, 1900], [350, 2120], [480, 2240], [520, 2300]] },
  ];
  for (const { steps, points } of sections) for (let i = 1; i <= steps; i++) {
    const u = i / steps, v = 1 - u;
    profile.push([0, 1].map(axis => v ** 3 * points[0][axis] + 3 * v * v * u * points[1][axis]
      + 3 * v * u * u * points[2][axis] + u ** 3 * points[3][axis]));
  }
  for (const [radius, y] of profile) {
    const t = y / 2300;
    for (let sector = 0; sector < sectors; sector++) {
      const angle = sector * Math.PI * 2 / sectors;
      const r = radius * (1 + .06 * Math.sin(3 * angle + .9 * t) * Math.sin(Math.PI * t));
      vertices.push([200 * t * t + r * Math.cos(angle), y, 80 * Math.sin(Math.PI * t) * t + .9 * r * Math.sin(angle)]);
    }
  }
  for (let sector = 0; sector < sectors; sector++) {
    const next = (sector + 1) % sectors;
    // The single bottom pole closes the base without coincident vertices.
    triangles.push([0, 1 + sector, 1 + next]);
    for (let ring = 0; ring < profile.length - 1; ring++) {
      const a = 1 + ring * sectors + sector, b = 1 + ring * sectors + next;
      const c = b + sectors, d = a + sectors;
      triangles.push([a, d, c], [a, c, b]);
    }
  }
  // The final ring is deliberately uncapped: this is an open vessel surface.
  return { vertices, triangles };
}

export function createExample(id = DEFAULT_EXAMPLE_ID) {
  const example = EXAMPLES.find(example => example.id === id);
  if (!example) throw new RangeError(`Unknown example: ${String(id)}`);
  const factory = { 'barrel-vault': barrelVault, dome, 'aperture-sheet': apertureSheet, saddle, 'organic-vessel': organicVessel, 'geodesic-sphere': createGeodesicSphere }[id];
  return { name: example.name, ...factory() };
}
