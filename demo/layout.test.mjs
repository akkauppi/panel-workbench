import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCellLayout, generateSeeds, createMergeGroups, rebuildSurfaceCells } from './geometry.js';
import { captureLayout, readLayout, restoreLayout, layoutRecipe } from './layout.js';
import { fitSharedPanels } from './fitted.js';
import { foldedOpening, thinStrip } from './test-fixtures.mjs';

function grid({ n = 6, curved = false, hole = false } = {}) {
  const vertices = [], triangles = [], step = 1200 / n;
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push([x * step, y * step, curved ? (x - n / 2) ** 2 * 12 + (y - n / 2) ** 2 * 8 : 0]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (hole && x === 2 && y === 2) continue;
    const a = y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1;
    triangles.push([a, b, c], [a, c, d]);
  }
  return { vertices, triangles };
}
function fixture(options) {
  const model = grid(options), seeds = [[250, 300, 0], [950, 300, 0], [600, 950, 0]].map((position, id) => ({ id, position, weight: 1 }));
  const inputs = { seeds, size: 500, mergeGroups: [], cornerEdits: [] };
  const source = generateCellLayout(model, seeds, inputs);
  return { model, source, inputs, layout: captureLayout(model, source, { recipe: layoutRecipe(inputs) }) };
}
function changed(layout, mutate) { const copy = structuredClone(layout); mutate(copy); return copy; }

test('authored source snapshots restore exact geometry, corners and derived measurements', () => {
  for (const options of [{}, { curved: true }, { hole: true }]) {
    const { model, source, layout } = fixture(options), before = structuredClone(layout);
    assert.deepEqual(restoreLayout(model, JSON.parse(JSON.stringify(layout))), source);
    const restored = restoreLayout(model, layout), fitted = fitSharedPanels(restored);
    assert.deepEqual(layout, before, 'fitting cannot mutate the persistent source document');
    assert.ok(fitted.cells.length);
    restored.cells[0].positions[0][0] += 10;
    if (restored.corners.length) restored.corners[0].owners[0].push(999);
    assert.deepEqual(layout, before, 'restored editable arrays are independent clones');
  }
});

test('legacy edits and true merges materialize their exact source regions and historical corners', () => {
  const { model, source, inputs, layout } = fixture();
  const corner = source.corners.find(c => !c.boundary);
  const cornerEdits = [{ id: corner.id, anchor: corner.anchor, owners: corner.owners, target: corner.position.map((x, k) => x + [20, 15, 0][k]), radius: corner.radius }];
  const moved = generateCellLayout(model, inputs.seeds, { ...inputs, cornerEdits });
  const mergeGroups = createMergeGroups(moved.cells, [], [0, 1]);
  const merged = generateCellLayout(model, inputs.seeds, { ...inputs, cornerEdits, mergeGroups });
  const snapshot = captureLayout(model, merged, { previous: layout, recipe: layoutRecipe({ ...inputs, cornerEdits, mergeGroups }) });
  assert.deepEqual(restoreLayout(model, snapshot), merged);
  assert.deepEqual(snapshot.recipe.cornerEdits, cornerEdits);
  assert.ok(snapshot.cells.some(cell => cell.memberSeedIds.length === 2));
  assert.equal(snapshot.corners.some(c => c.id === corner.id), false);
});

test('restoring respects a valid authored loop start and loop ordering', () => {
  const model = grid({ hole: true });
  const source = generateCellLayout(model, [{ id: 0, position: [100, 100, 0] }], { size: 500 });
  const layout = captureLayout(model, source);
  layout.cells[0].loops.reverse();
  for (const loop of layout.cells[0].loops) loop.push(loop.shift());
  const restored = restoreLayout(model, layout);
  assert.deepEqual(restored.cells[0].loops, layout.cells[0].loops);
  assert.equal(restored.cells[0].holeCount, 1);
});

test('graph identities survive unchanged geometry and new IDs never recycle removed entities', () => {
  const { model, source, layout, inputs } = fixture();
  const same = captureLayout(model, source, { previous: layout });
  assert.deepEqual(same.vertices.map(v => v.id), layout.vertices.map(v => v.id));
  assert.deepEqual(same.edges.map(e => e.id), layout.edges.map(e => e.id));
  const seeds = structuredClone(inputs.seeds); seeds[0].weight = 1.3;
  const moved = captureLayout(model, generateCellLayout(model, seeds, inputs), { previous: layout });
  const before = new Map(layout.vertices.map(v => [v.position.join(','), v.id]));
  let retained = 0, created = 0;
  for (const vertex of moved.vertices) {
    if (before.has(vertex.position.join(','))) { assert.equal(vertex.id, before.get(vertex.position.join(','))); retained++; }
    else if (!layout.vertices.some(v => v.id === vertex.id)) { assert.ok(Number(vertex.id.slice(1)) >= layout.nextIds.vertex); created++; }
  }
  assert.ok(retained > 0 && created > 0);
  const returned = captureLayout(model, source, { previous: moved });
  assert.ok(returned.nextIds.vertex >= moved.nextIds.vertex);
  assert.ok(returned.nextIds.edge >= moved.nextIds.edge);
});

test('strict shape parsing rejects duplicate IDs, references, indices, ownership and unsafe metadata', () => {
  const { layout } = fixture();
  const mutations = [
    x => x.vertices[1].id = x.vertices[0].id,
    x => x.vertices[0].attachment.triangle = x.source.triangleCount,
    x => x.vertices[0].attachment.barycentric = [1, 1, 1],
    x => x.vertices[0].position[0] = NaN,
    x => x.nextIds.vertex = 0,
    x => x.edges[1].id = x.edges[0].id,
    x => x.edges[0].vertices[0] = 'v999999999',
    x => x.cells[0].triangles[0].vertices[0] = x.cells[0].positions.length,
    x => x.cells[0].triangles[0].sourceTriangle = x.source.triangleCount,
    x => x.cells[0].memberSeedIds.push(x.cells[1].id),
    x => x.cells[0].vertexIds[1] = x.cells[0].vertexIds[0],
    x => x.recipe.engine = 'unknown',
    x => x.generation.emptyCellCount++,
    x => x.corners[0].cells.push(999),
  ];
  for (const mutation of mutations) assert.throws(() => readLayout(changed(layout, mutation)), /source layout/);
  const clone = readLayout(layout); clone.vertices[0].position[0] += 10;
  assert.notDeepEqual(clone.vertices[0].position, layout.vertices[0].position);
  const reordered = changed(layout, x => x.recipe = { cornerEdits: [], size: 500, engine: 'seed-fields-v1', mergeGroups: [], seeds: x.recipe.seeds });
  assert.equal(JSON.stringify(readLayout(reordered).recipe), JSON.stringify(layout.recipe));
});

test('structured source provenance is canonical and survives exact snapshot restoration', () => {
  const { model, source, inputs } = fixture();
  for (const type of ['hexagonal', 'geodesic']) {
    const pattern = { frequency: 3, angle: 17, type };
    const recipe = layoutRecipe({ ...inputs, pattern });
    assert.equal(recipe.engine, 'structured-v1');
    assert.deepEqual(recipe.pattern, { type, angle: 17, frequency: 3 });
    const snapshot = captureLayout(model, source, { recipe });
    const reopened = readLayout(JSON.parse(JSON.stringify(snapshot)));
    assert.deepEqual(reopened.recipe, recipe);
    assert.deepEqual(restoreLayout(model, reopened), source, 'the source snapshot remains authoritative over generator settings');
    pattern.angle = 90;
    assert.equal(reopened.recipe.pattern.angle, 17);
  }
  assert.equal(layoutRecipe(inputs).engine, 'seed-fields-v1');
  assert.equal(Object.hasOwn(layoutRecipe(inputs), 'pattern'), false, 'organic provenance keeps its existing engine and input shape');
});

test('recipe validation rejects mismatched engines, corrupt patterns and unsupported legacy targets', () => {
  const { inputs } = fixture();
  const pattern = { type: 'hexagonal', angle: 20, frequency: 2 };
  for (const extra of [
    { engine: 'structured-v1' },
    { engine: 'seed-fields-v1', pattern },
    { engine: 'unknown', pattern },
    { pattern: { ...pattern, angle: 360 } },
    { pattern: { ...pattern, frequency: 7 } },
    { pattern: { ...pattern, type: 'unsupported' } },
    { pattern, cornerEdits: [{ id: 'legacy-target', anchor: [400, 400, 0], target: [420, 400, 0], owners: [[0], [1]], radius: 100 }] },
  ]) assert.throws(() => layoutRecipe({ ...inputs, ...extra }), /source layout/);
});

test('regularized layouts retain their regularity and ancestry in a distinct canonical recipe', () => {
  const { model, source, inputs } = fixture();
  const recipe = layoutRecipe({ ...inputs, pattern: { type: 'regularized', regularity: .85 } });
  assert.equal(recipe.engine, 'regularized-surface-v1');
  assert.deepEqual(recipe.pattern, { type: 'regularized', angle: 0, frequency: 2, regularity: .85 });
  assert.deepEqual(recipe.seeds, inputs.seeds);
  const layout = captureLayout(model, source, { recipe });
  assert.deepEqual(readLayout(JSON.parse(JSON.stringify(layout))).recipe, recipe);
  assert.deepEqual(restoreLayout(model, layout), source);
  for (const engine of ['seed-fields-v1', 'structured-v1']) assert.throws(() => layoutRecipe({ ...recipe, engine }), /recipe engine/);
  assert.throws(() => readLayout(changed(layout, value => value.recipe.pattern.regularity = 1.01)), /regularity/);
});

test('geometric preflight rejects plausible but corrupt attachments, ownership and phantom handles', () => {
  const { model, layout } = fixture();
  const sharedIndex = layout.edges.findIndex(edge => edge.cells.length === 2);
  for (const mutation of [
    x => x.vertices[0].position[2] += 50,
    x => x.vertices[0].attachment.barycentric = [.2, .3, .5],
    x => x.cells[0].positions[0][0] += 1,
    x => x.cells[0].triangles[0].sourceTriangle = model.triangles.length - 1,
    x => x.cells[0].loops[0].reverse(),
    x => x.edges[sharedIndex].cells.pop(),
    x => x.edges.pop(),
    x => x.corners[0].position[0] += 20,
    x => x.corners[0].owners = [[0], [1], [99]],
    x => x.corners.find(c => c.boundary).boundaryPath[0][2] += 10,
  ]) assert.throws(() => restoreLayout(model, changed(layout, mutation)), /source layout/);
  const otherModel = structuredClone(model); otherModel.vertices[0][2] += 1;
  assert.throws(() => restoreLayout(otherModel, layout), /different source model/);
});

test('per-face coverage rejects a missing patch and equal-area overlapping replacement', () => {
  const model = grid(), source = generateCellLayout(model, [{ id: 0, position: [100, 100, 0] }], { size: 500 });
  const absent = structuredClone(source.cells[0]);
  absent.triangles.splice(20, 1);
  const missing = rebuildSurfaceCells(model, [absent]);
  assert.throws(() => captureLayout(model, missing), /cover|open|boundary/);
  const overlapping = structuredClone(source.cells[0]);
  overlapping.triangles.splice(20, 1, [...overlapping.triangles[30]]);
  const repeated = rebuildSurfaceCells(model, [overlapping]);
  assert.equal(repeated.stats.totalArea, source.stats.totalArea, 'total area alone cannot detect this corruption');
  assert.throws(() => captureLayout(model, repeated), /source layout/);
});

test('holed one-cell source retains opening loops and does not fill the missing mesh', () => {
  const model = grid({ hole: true });
  const source = generateCellLayout(model, [{ id: 0, position: [100, 100, 0] }], { size: 500 });
  assert.equal(source.cells[0].loops.length, 2);
  const layout = captureLayout(model, source);
  assert.deepEqual(restoreLayout(model, layout), source);
  assert.equal(layout.edges.filter(edge => edge.cells.length === 1).length, source.cells[0].loops.flat().length);
});

test('a folded opening restores invalid fitted candidates without rejecting sound source coverage', () => {
  const model = foldedOpening(), seeds = [{ id: 0, position: [0, -50, -5], weight: 1 }];
  const source = generateCellLayout(model, seeds, { size: 100 });
  assert.ok(source.stats.invalidCellCount > 0);
  assert.ok(source.stats.coverageError < 1e-10);
  assert.equal(source.cells[0].sourceComponentCount, 1);
  assert.equal(source.cells[0].loops.length, 2);
  const layout = captureLayout(model, source, { recipe: layoutRecipe({ seeds, size: 100 }) });
  const restored = restoreLayout(model, JSON.parse(JSON.stringify(layout)));
  assert.deepEqual(restored, source);
  const fitted = fitSharedPanels(source);
  assert.deepEqual(captureLayout(model, fitted, { recipe: layout.recipe }), layout, 'capturing a derived result uses its retained source cells');
  assert.ok(fitSharedPanels(restored).stats.invalidCellCount > 0);
});

test('long thin rotated triangles retain stable barycentric attachments after clipping', () => {
  const { model, seeds } = thinStrip(), source = generateCellLayout(model, seeds, { size: 500 });
  const layout = captureLayout(model, source);
  assert.ok(layout.vertices.some(vertex => vertex.attachment.triangle < 4 && vertex.attachment.barycentric.filter(x => x > 1e-7).length > 1), 'clipped points must exercise the thin faces');
  assert.deepEqual(restoreLayout(model, layout), source);
});

test('a valid neighbour transition is reported as unsupported topology, not as a crossing', () => {
  const model = grid({ n: 12 }), seeds = generateSeeds(model, 350, .3, 4);
  const source = generateCellLayout(model, seeds, { size: 350 });
  const corner = source.corners.find(c => c.id === 'corner:0-11-12:65511369,39312576,0');
  assert.ok(corner);
  const edit = { id: corner.id, anchor: corner.anchor, owners: corner.owners,
    target: corner.position.map((x, k) => x + [200, 100, 0][k]), radius: corner.radius };
  assert.throws(() => generateCellLayout(model, seeds, { size: 350, cornerEdits: [edit] }), /changes which cells are neighbours.*not supported/);
  edit.target = corner.position.map((x, k) => x + [corner.radius, 0, 0][k]);
  assert.throws(() => generateCellLayout(model, seeds, { size: 350, cornerEdits: [edit] }), /total movement range from the original layout/);
});
