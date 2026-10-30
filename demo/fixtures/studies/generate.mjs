// Run against an isolated checkout of the manifest's released commit:
// node generate.mjs /path/to/released/checkout scenario output.json
// This script never imports the current implementation. Fixtures are synthetic.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [checkout, scenario, output] = process.argv.slice(2);
const released = file => import(pathToFileURL(resolve(checkout, 'demo', file)).href);
const { resolveSourceLayout } = await released('design.js');
const { transactLayout } = await released('layout-edit.js');
const { createStudy } = await released('study.js');
const vertices = [], triangles = [], n = 6, hole = scenario === 'split-retired';
for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push([x * 200, y * 200,
  scenario === 'curved-merge' ? 12 * (x - 3) ** 2 + 8 * (y - 3) ** 2 : 0]);
for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
  if (hole && x === 2 && y === 2) continue;
  const a = y * (n + 1) + x;
  triangles.push([a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]);
}
const model = { vertices, triangles };
const points = hole ? [[600, 600, 0]] : [[250, 300, 0], [950, 300, 0], [600, 950, 0]];
const state = { name: `Compatibility ${scenario}`, rawModel: model,
  seeds: points.map((position, id) => ({ id, position, weight: 1 })),
  size: 500, variation: .3, randomSeed: 7, mergeGroups: [], cornerEdits: [],
  straightness: .7, thickness: 40, roundover: 2, carve: false, minimumThickness: 12, flipOutside: false,
  view: 'surface', allowCellRemoval: true, directBase: null,
};
if (scenario === 'structured') { state.pattern = { type: 'hexagonal', angle: 17, frequency: 2 }; state.seeds = []; }
const first = resolveSourceLayout(model, state);
state.seeds = first.seeds; state.layout = first.layout;
if (scenario === 'curved-merge') {
  const parent = first.surface.cells.find(cell => cell.neighbors.length);
  state.directBase = state.layout;
  state.layout = transactLayout(model, state.layout, { type: 'merge-cells', cellIds: [parent.id, parent.neighbors[0]] }).layout;
}
if (scenario === 'split-retired') {
  state.directBase = state.layout;
  state.layout = transactLayout(model, state.layout, { type: 'split-cell', cellId: 0, start: [800, 0, 0], end: [800, 1200, 0], nextCellId: 20 }).layout;
  state.layout = transactLayout(model, state.layout, { type: 'merge-cells', cellIds: [0, 20] }).layout;
  state.layout = transactLayout(model, state.layout, { type: 'split-cell', cellId: 0, start: [0, 700, 0], end: [1200, 700, 0], nextCellId: 21 }).layout;
  state.nextCellId = 100; // IDs reserved by later cancelled/undone edits stay retired.
}
const study = createStudy(state, { units: 'mm', up: 'z', camera: [1800, -1800, 2000], target: [600, 600, 0] });
await writeFile(output, JSON.stringify(study) + '\n');
