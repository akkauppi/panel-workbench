// Small, deterministic meshes authored for regression tests. These contain no
// imported model data and deliberately include difficult numerical cases.
export function wavyGrid({ n = 12, step = 100, amplitude = 180 } = {}) {
  const vertices = [], triangles = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
    vertices.push([x * step, y * step, amplitude * (Math.sin(x * .47) + Math.cos(y * .39))]);
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x;
    triangles.push([a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]);
  }
  return { vertices, triangles };
}

export function foldedOpening() {
  const vertices = [[-100, -100, 0], [100, -100, 0], [100, 100, 0], [-100, 100, 0],
    [-10, 0, -10], [10, 0, -10], [10, 0, 10], [-10, 0, 10]], triangles = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    triangles.push([i, j, 4 + j], [i, 4 + j, 4 + i]);
  }
  return { vertices, triangles };
}

export function thinStrip() {
  // A rotated planar mesh with a 0.003 mm strip beside a 1000 mm sheet.
  // Its long, thin faces exercise attachment arithmetic without axis alignment.
  const rotate = ([x, y, z]) => [x * .8 - y * .36 + z * .48, x * .6 + y * .48 - z * .64, y * .8 + z * .6];
  const vertices = [0, .003, 1000].flatMap(y => [0, 1000, 2000].map(x => rotate([x, y, 0]))), triangles = [];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const a = y * 3 + x;
    triangles.push([a, a + 1, a + 4], [a, a + 4, a + 3]);
  }
  return { model: { vertices, triangles }, seeds: [rotate([300, 400, 0]), rotate([1600, 400, 0])].map((position, id) => ({ id, position, weight: 1 })) };
}
