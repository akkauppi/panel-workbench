import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readGeneratorPolicy, CURVATURE_SIZING_FEATURE } from './generator-policy.js';
import { captureDesign, createStudy, readStudy, serializeStudy } from './study.js';
import { layoutRecipe, captureLayout } from './layout.js';
import { generateCellLayout } from './geometry.js';
import { resolveSourceLayout } from './design.js';
import { transactLayout } from './layout-edit.js';
import { readPattern } from './pattern.js';
import { readRequiredFeatures as releasedFeatureReader } from './fixtures/studies/3ed57fb-project-document.mjs';

const policy = { type: 'curvature', version: 1, minSizeMm: 200, maxSizeMm: 400 };

function fixture(type = 'organic', generatorPolicy = policy) {
  const n = 4, vertices = [], triangles = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push([x * 300, y * 300, 0]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x; triangles.push([a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]);
  }
  // Explicit accepted seed positions are authoritative, regardless of which
  // generator originally proposed them. These fixtures do not rerun seeding.
  const state = { rawModel: { vertices, triangles }, name: 'Adaptive source fixture',
    seeds: [[300, 300, 0], [900, 300, 0], [300, 900, 0], [900, 900, 0]].map((position, index) => ({ id: [2, 7, 9, 11][index], position, weight: 1 })),
    mergeGroups: [], cornerEdits: [], directBase: null, pattern: readPattern({ type, regularity: .4 }), generatorPolicy: readGeneratorPolicy(generatorPolicy),
    size: 400, variation: .3, randomSeed: 7, straightness: .7, thickness: 40, roundover: 2, carve: false, minimumThickness: 12,
    flipOutside: false, view: 'surface', units: 'mm', up: 'z', nextCellId: 100,
    project: { id: `adaptive-${type}-test`, revision: 2, createdAt: '2026-11-02T08:00:00.000Z', updatedAt: '2026-11-02T08:01:00.000Z' } };
  const surface = generateCellLayout(state.rawModel, state.seeds, state);
  state.layout = captureLayout(state.rawModel, surface, { recipe: layoutRecipe(state) });
  return state;
}
const save = state => createStudy(state, { units: state.units, up: state.up, camera: [0, 0, 2500], target: [600, 600, 0] });

test('the released v6 feature reader rejects adaptive files before unknown settings could be lost', async () => {
  // Exact read-only module snapshot from public release 3ed57fb. Keep it frozen;
  // do not replace this compatibility proof with today's feature validator.
  const bytes = await readFile(new URL('./fixtures/studies/3ed57fb-project-document.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '64b4948aa1aa057907e00dcd6a028188fe23102b23cdfe06926c4f1f094cdeb3');
  const adaptive = save(fixture()), before = structuredClone(adaptive);
  assert.throws(() => releasedFeatureReader(adaptive.requiredFeatures, adaptive), /unsupported features: curvature-sizing-v1.*newer compatible.*original file unchanged/);
  assert.deepEqual(adaptive, before);
  const uniform = save(fixture('organic', null));
  assert.deepEqual(releasedFeatureReader(uniform.requiredFeatures, uniform), uniform.requiredFeatures);
});

test('adaptive Organic and Regularized studies retain policy, recipe, source and IDs on reopen', () => {
  for (const type of ['organic', 'regularized']) {
    const original = fixture(type), before = structuredClone(original), saved = save(original), reopened = readStudy(serializeStudy(saved));
    assert.equal(saved.version, 6);
    assert.ok(saved.requiredFeatures.includes(CURVATURE_SIZING_FEATURE));
    assert.deepEqual(reopened, saved);
    assert.deepEqual(reopened.generatorPolicy, policy);
    assert.deepEqual(reopened.layout.recipe.generatorPolicy, policy);
    assert.deepEqual(reopened.layout, original.layout);
    assert.deepEqual(reopened.seeds, original.seeds);
    assert.equal(reopened.nextCellId, 100);
    assert.equal(reopened.engines.sourceLayout, 'authored-source-v1');
    const restored = resolveSourceLayout(original.rawModel, { ...reopened, thickness: 80, straightness: .1 }, { strict: true });
    assert.equal(restored.source, 'stored'); assert.strictEqual(restored.layout, reopened.layout);
    assert.deepEqual(original, before);
    reopened.generatorPolicy.minSizeMm = 250;
    assert.deepEqual(saved.generatorPolicy, policy, 'reading cannot alias the supplied document');
  }
});

test('direct merge and split edits preserve adaptive provenance and their exact reset baseline', () => {
  for (const type of ['organic', 'regularized']) {
    const state = fixture(type), baseline = structuredClone(state.layout);
    const merged = transactLayout(state.rawModel, state.layout, { type: 'merge-cells', cellIds: [2, 7] });
    state.directBase = state.layout; state.layout = merged.layout;
    const divided = transactLayout(state.rawModel, state.layout, { type: 'split-cell', cellId: 2, start: [300, -100, 0], end: [300, 1300, 0], nextCellId: 100 });
    state.layout = divided.layout; state.nextCellId = 101;
    const saved = save(state), restored = readStudy(serializeStudy(saved));
    assert.equal(restored.layout.version, 3);
    assert.deepEqual(restored.generatorPolicy, policy);
    assert.deepEqual(restored.layout.recipe.generatorPolicy, policy);
    assert.deepEqual(restored.directBase, baseline);
    assert.deepEqual(restored.layout, divided.layout);
    assert.equal(restored.nextCellId, 101);
    assert.ok(restored.layout.cells.some(cell => cell.id === 100));
    assert.equal(resolveSourceLayout(state.rawModel, restored, { strict: true }).source, 'stored');
    const reset = { ...restored, layout: restored.directBase, directBase: null };
    assert.deepEqual(resolveSourceLayout(state.rawModel, reset, { strict: true }).layout, baseline);
  }
});

test('off policies stay absent in serialized documents while history can explicitly undo adaptive mode', () => {
  const uniform = fixture('organic', null), adaptive = fixture(), state = structuredClone(adaptive);
  const history = captureDesign(uniform), redo = captureDesign(adaptive);
  assert.equal(history.generatorPolicy, null);
  Object.assign(state, history);
  assert.equal(state.generatorPolicy, null);
  const saved = save(state);
  assert.equal('generatorPolicy' in saved, false);
  assert.equal('generatorPolicy' in saved.layout.recipe, false);
  assert.equal(saved.requiredFeatures.includes(CURVATURE_SIZING_FEATURE), false);
  assert.equal(resolveSourceLayout(state.rawModel, saved, { strict: true }).source, 'stored');
  assert.deepEqual(readStudy({ ...saved, generatorPolicy: null }), saved);
  Object.assign(state, redo);
  assert.deepEqual(save(state).generatorPolicy, policy);
  assert.deepEqual(captureDesign({}).generatorPolicy, null);
});

test('policy disagreements, missing feature declarations and unsupported combinations fail atomically', () => {
  const state = fixture(), first = save(state);
  const merged = transactLayout(state.rawModel, state.layout, { type: 'merge-cells', cellIds: [2, 7] });
  const direct = save({ ...state, directBase: state.layout, layout: merged.layout });
  const cases = [
    [first, value => { value.requiredFeatures = value.requiredFeatures.filter(feature => feature !== CURVATURE_SIZING_FEATURE); }, /required curvature-sizing-v1/],
    [first, value => { delete value.generatorPolicy; }, /does not match/],
    [first, value => { delete value.layout.recipe.generatorPolicy; }, /does not match/],
    [first, value => { value.generatorPolicy.minSizeMm = 300; }, /does not match/],
    [first, value => { value.generatorPolicy.version = 2; }, /version is unsupported/],
    [first, value => { value.pattern.type = 'hexagonal'; }, /only for Organic and Regularized/],
    [first, value => { value.version = 5; }, /requires study file version 6/],
    [direct, value => { value.directBase.recipe.generatorPolicy.maxSizeMm = 500; }, /baseline does not match/],
  ];
  for (const [original, mutate, expected] of cases) {
    const changed = structuredClone(original); mutate(changed); const before = structuredClone(changed);
    assert.throws(() => readStudy(changed), expected);
    assert.deepEqual(changed, before);
  }
  assert.throws(() => resolveSourceLayout(state.rawModel, { ...first, generatorPolicy: null }, { strict: true }), /does not match/);
  assert.throws(() => resolveSourceLayout(state.rawModel, { ...direct, generatorPolicy: null }), /Reset direct edits/);
});

test('policy object order is canonical and uniform recipe identity remains unchanged', () => {
  const state = fixture(), expected = layoutRecipe(state);
  assert.deepEqual(layoutRecipe({ ...state, generatorPolicy: { maxSizeMm: 400, minSizeMm: 200, version: 1, type: 'curvature' } }), expected);
  const uniform = fixture('organic', null), missing = { ...uniform }; delete missing.generatorPolicy;
  assert.deepEqual(layoutRecipe(missing), layoutRecipe(uniform));
  assert.equal('generatorPolicy' in layoutRecipe(uniform), false);
});

test('fresh adaptive generation produces canonical stored layouts for both supported patterns', () => {
  for (const type of ['organic', 'regularized']) {
    const state = fixture(type), input = { ...state, seeds: [], layout: null, directBase: null };
    const generated = resolveSourceLayout(state.rawModel, input);
    assert.equal(generated.source, 'generated');
    assert.ok(generated.seeds.length > 1);
    assert.deepEqual(generated.layout.recipe.generatorPolicy, policy);
    assert.ok(generated.surface.stats.coverageError < 1e-8);
    const accepted = { ...input, seeds: generated.seeds, layout: generated.layout };
    assert.equal(resolveSourceLayout(state.rawModel, accepted, { strict: true }).source, 'stored');
    assert.deepEqual(resolveSourceLayout(state.rawModel, input).layout, generated.layout, 'generation remains deterministic for a fixed policy and random seed');
  }
});
