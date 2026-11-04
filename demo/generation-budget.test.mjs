import test from 'node:test';
import assert from 'node:assert/strict';
import { readMaxGeneratedCells, DEFAULT_MAX_GENERATED_CELLS, MIN_GENERATED_CELLS, MAX_GENERATED_CELLS, GENERATION_BUDGET_FEATURE } from './generator-policy.js';
import { generateSeeds, generateAdaptiveSeeds, generateCells } from './geometry.js';
import { generateRegularizedLayout } from './regularized.js';
import { resolveSourceLayout } from './design.js';
import { layoutRecipe } from './layout.js';
import { transactLayout } from './layout-edit.js';
import { createStudy, captureDesign, readStudy, serializeStudy } from './study.js';
import { createCheckpoint, checkpointStudy } from './checkpoints.js';
import { requiredStudyFeatures } from './project-document.js';
import { createDiagnosticReport } from './project-feedback.js';
import { createWorkerHandler } from './worker.js';
import { readRequiredFeatures as releasedFeatures } from './fixtures/studies/6e4cee2/project-document.js';

function grid(n = 18) {
  const vertices = [], triangles = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push([x * 1200 / n, y * 1200 / n, 0]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x; triangles.push([a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]);
  }
  return { vertices, triangles };
}
const model = grid(), policy = { type: 'curvature', version: 1, minSizeMm: 75, maxSizeMm: 75 };
const inputs = (type = 'organic', adaptive = false, maxGeneratedCells = 300) => ({
  size: 75, variation: .3, randomSeed: 7, pattern: { type, regularity: .2 }, generatorPolicy: adaptive ? policy : null,
  maxGeneratedCells, mergeGroups: [], cornerEdits: [], seeds: [], layout: null, directBase: null,
});
const generated = new Map();
function generation(type = 'organic', adaptive = false) {
  const key = `${type}:${adaptive}`;
  if (!generated.has(key)) generated.set(key, resolveSourceLayout(model, inputs(type, adaptive)));
  return generated.get(key);
}
function study(type = 'organic', adaptive = false) {
  const result = generation(type, adaptive);
  return createStudy({ ...inputs(type, adaptive), ...result, rawModel: model, name: 'Synthetic generation budget', view: 'flat' },
    { units: 'mm', up: 'z', camera: [0, 0, 2500], target: [600, 600, 0] });
}
const store = state => createStudy(state, { units: state.units, up: state.up, camera: state.camera, target: state.target });

test('generation limit is an explicit bounded integer, with the former default', () => {
  assert.equal(DEFAULT_MAX_GENERATED_CELLS, 240); assert.equal(MIN_GENERATED_CELLS, 12); assert.equal(MAX_GENERATED_CELLS, 500);
  for (const value of [undefined, null, 240]) assert.equal(readMaxGeneratedCells(value), 240);
  for (const value of [12, 300, 500]) assert.equal(readMaxGeneratedCells(value), value);
  for (const value of [0, 11, 501, 300.5, Infinity, NaN, '300', true, [], {}]) assert.throws(() => readMaxGeneratedCells(value), /whole number from 12 to 500/);
});

test('uniform sampling honours the chosen ceiling and preserves exact default seeds', () => {
  const before = structuredClone(model), legacy = generateSeeds(model, 60, .3, 7);
  assert.equal(legacy.length, 240);
  assert.deepEqual(generateSeeds(model, 60, .3, 7, 240), legacy);
  for (const limit of [12, 80, 300, 500]) assert.equal(generateSeeds(model, 10, .3, 7, limit).length, limit);
  assert.deepEqual(model, before);
});

test('adaptive requests above the selected budget explain both available adjustments', () => {
  assert.throws(() => generateAdaptiveSeeds(model, policy), /requests 296 cells.*240-cell limit.*Maximum generated cells.*500.*cell sizes/);
  assert.throws(() => generateAdaptiveSeeds(model, policy, .3, 7, 280), /selected 280-cell limit/);
  const result = generateAdaptiveSeeds(model, policy, .3, 7, 300);
  assert.equal(result.seeds.length, 296);
  assert.deepEqual(result.seeds, generateAdaptiveSeeds(model, policy, .3, 7, 500).seeds, 'extra headroom does not change the requested arrangement');
  assert.throws(() => generateAdaptiveSeeds(model, { ...policy, minSizeMm: 10, maxSizeMm: 10 }, .3, 7, 500), /500-cell limit.*Increase the minimum\/maximum/);
});

for (const type of ['organic', 'regularized']) for (const adaptive of [false, true]) test(`${type} ${adaptive ? 'adaptive' : 'uniform'} generates and reopens more than 240 accepted cells`, () => {
  const result = generation(type, adaptive), saved = study(type, adaptive), reopened = readStudy(serializeStudy(saved));
  assert.equal(result.seeds.length, 296); assert.equal(result.layout.cells.length, 296);
  assert.ok(result.layout.cells.length <= 300); assert.ok(result.surface.stats.coverageError < 1e-8);
  assert.equal(saved.maxGeneratedCells, 300); assert.equal(saved.layout.recipe.maxGeneratedCells, 300);
  assert.ok(saved.requiredFeatures.includes(GENERATION_BUDGET_FEATURE)); assert.deepEqual(reopened, saved);
  const restored = resolveSourceLayout(model, reopened, { strict: true });
  assert.equal(restored.source, 'stored'); assert.deepEqual(restored.layout, saved.layout);
});

test('accepted cells, checkpoint snapshots and Undo are independent of the new-generation ceiling', () => {
  const raised = study(), low = structuredClone(raised);
  low.maxGeneratedCells = 12; low.layout.recipe.maxGeneratedCells = 12;
  const saved = store(low), before = structuredClone(saved);
  assert.equal(saved.layout.cells.length, 296, 'a generation preference must not delete authored cells');
  assert.equal(resolveSourceLayout(model, saved, { strict: true }).source, 'stored');
  const checkpoint = createCheckpoint(raised, 'More headroom');
  const parent = store({ ...saved, checkpoints: [checkpoint] });
  assert.equal(readStudy(serializeStudy(parent)).checkpoints[0].study.maxGeneratedCells, 300);
  const restored = readStudy(checkpointStudy(checkpoint, parent));
  assert.equal(restored.maxGeneratedCells, 300); assert.deepEqual(restored.layout, raised.layout);
  const current = { ...raised }, undo = captureDesign(saved), redo = captureDesign(raised);
  Object.assign(current, undo); assert.equal(current.maxGeneratedCells, 12);
  Object.assign(current, redo); assert.equal(current.maxGeneratedCells, 300);
  assert.equal(captureDesign({}).maxGeneratedCells, 240);
  assert.deepEqual(saved, before);
});

test('default fields remain absent in canonical documents and frozen readers reject custom budgets', () => {
  const raised = study(), defaults = structuredClone(raised);
  defaults.maxGeneratedCells = 240; defaults.layout.recipe.maxGeneratedCells = 240;
  const ordinary = store(defaults);
  assert.equal('maxGeneratedCells' in ordinary, false); assert.equal('maxGeneratedCells' in ordinary.layout.recipe, false);
  assert.equal(ordinary.requiredFeatures.includes(GENERATION_BUDGET_FEATURE), false);
  assert.deepEqual(releasedFeatures(ordinary.requiredFeatures, ordinary), ordinary.requiredFeatures);
  assert.throws(() => releasedFeatures(raised.requiredFeatures, raised), /unsupported features: generation-budget-v1/);
  assert.deepEqual(layoutRecipe({ ...defaults, maxGeneratedCells: undefined }), ordinary.layout.recipe);
});

test('direct edits retain custom-budget provenance in their original reset baseline', () => {
  const original = study(), cell = generation().surface.cells.find(cell => cell.neighbors.length);
  const merged = transactLayout(model, original.layout, { type: 'merge-cells', cellIds: [cell.id, cell.neighbors[0]] });
  const saved = store({ ...original, layout: merged.layout, directBase: original.layout });
  const reopened = readStudy(serializeStudy(saved));
  assert.equal(reopened.maxGeneratedCells, 300);
  assert.equal(reopened.layout.recipe.maxGeneratedCells, 300);
  assert.equal(reopened.directBase.recipe.maxGeneratedCells, 300);
  assert.deepEqual(reopened.directBase, original.layout);
  assert.equal(resolveSourceLayout(model, reopened, { strict: true }).source, 'stored');
  const changed = structuredClone(reopened); changed.directBase.recipe.maxGeneratedCells = 400;
  assert.throws(() => readStudy(changed), /baseline does not match/);
});

test('feature gates include reset provenance and reject missing declarations or inconsistent budgets atomically', () => {
  for (const record of [{ maxGeneratedCells: 300 }, { layout: { recipe: { maxGeneratedCells: 300 } } }, { directBase: { recipe: { maxGeneratedCells: 300 } } }]) {
    assert.ok(requiredStudyFeatures(record).includes(GENERATION_BUDGET_FEATURE));
  }
  const original = study();
  for (const [mutate, expected] of [
    [value => { value.requiredFeatures = value.requiredFeatures.filter(feature => feature !== GENERATION_BUDGET_FEATURE); }, /required generation-budget-v1/],
    [value => { delete value.maxGeneratedCells; }, /does not match/],
    [value => { delete value.layout.recipe.maxGeneratedCells; }, /does not match/],
    [value => { value.maxGeneratedCells = 501; }, /whole number/],
    [value => { value.version = 5; }, /requires study file version 6/],
  ]) {
    const changed = structuredClone(original); mutate(changed); const before = structuredClone(changed);
    assert.throws(() => readStudy(changed), expected); assert.deepEqual(changed, before);
  }
  const parent = store({ ...original, checkpoints: [createCheckpoint(original, 'Budget retained')] });
  parent.checkpoints[0].study.requiredFeatures = parent.checkpoints[0].study.requiredFeatures.filter(feature => feature !== GENERATION_BUDGET_FEATURE);
  assert.throws(() => readStudy(parent), /required generation-budget-v1/);
});

test('the editable 500-cell ceiling and regularization work budget remain separate', () => {
  assert.throws(() => generateCells(model, Array.from({ length: 501 }, (_, id) => ({ id, position: [id, 0, 0] }))), /at most 500/);
  assert.throws(() => generateRegularizedLayout(grid(40), { type: 'regularized' }, { size: 10, maxGeneratedCells: 500 }), /regularization work budget/);
  const doc = study(); doc.seeds = Array.from({ length: 501 }, (_, id) => ({ id, position: [id, 0, 0], weight: 1 }));
  assert.throws(() => readStudy(doc), /between 1 and 500/);
});

test('worker validation receives generation budget and feedback retains only a valid numeric value', () => {
  const messages = [], worker = createWorkerHandler(message => messages.push(message));
  worker({ data: { ...inputs(), validationId: 1, model } });
  assert.equal(messages[0].error, undefined); assert.equal(messages[0].layout.cells.length, 296);
  assert.equal(messages[0].layout.recipe.maxGeneratedCells, 300);
  worker({ data: { ...inputs('organic', true, 240), validationId: 2, model } });
  assert.match(messages[1].error, /selected 240-cell limit/);
  assert.equal(createDiagnosticReport({ settings: { maxGeneratedCells: 300 } }).settings.maxGeneratedCells, 300);
  for (const value of [undefined, 240, 501, 'private text']) assert.equal('maxGeneratedCells' in createDiagnosticReport({ settings: { maxGeneratedCells: value } }).settings, false);
});
