import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { captureDesign, createStudy, readStudy, serializeStudy } from './study.js';
import { createProjectMetadata, advanceProjectRevision, readProjectMetadata, CURRENT_ENGINES,
  MAX_STUDY_BYTES, assertStudySize, utf8Bytes } from './project-document.js';
import { summarizeCalculation } from './project-feedback.js';
import { generateCellLayout } from './geometry.js';
import { captureLayout, restoreLayout, layoutRecipe } from './layout.js';

const old = JSON.parse(await readFile(new URL('./fixtures/studies/18f6da1-split-retired.json', import.meta.url), 'utf8'));
const metadata = () => createProjectMetadata({ id: 'durable-project-test', now: '2026-10-30T12:00:00.000Z' });
const save = (state = old, options = {}) => createStudy(state, { units: state.units, up: state.up, project: metadata(),
  producer: { name: 'Panel Workbench', build: 'release-18f6da1' }, ...options });

test('project identity, explicit revisions and producer provenance stay outside geometry undo', () => {
  const project = metadata(), before = structuredClone(project);
  const next = advanceProjectRevision(project, { now: '2026-10-30T12:30:00.000Z' });
  assert.deepEqual(project, before);
  assert.deepEqual(next, { ...before, revision: 2, updatedAt: '2026-10-30T12:30:00.000Z' });
  assert.equal(advanceProjectRevision(next, { now: '2026-10-30T11:00:00.000Z' }).updatedAt, next.updatedAt, 'a backwards clock cannot rewind the revision time');
  const saved = save(old, { project: next });
  assert.equal(saved.version, 6);
  assert.deepEqual(saved.project, next);
  assert.deepEqual(saved.engines, CURRENT_ENGINES);
  assert.deepEqual(saved.requiredFeatures, ['source-layout', 'direct-layout', 'split-ancestry', 'retired-panel-ids']);
  assert.deepEqual(readStudy(serializeStudy(saved)), saved);
  assert.deepEqual(captureDesign(saved), captureDesign(old));
  for (const key of ['project', 'producer', 'engines', 'requiredFeatures', 'lastCalculation', 'nextCellId']) assert.equal(key in captureDesign(saved), false);
  assert.deepEqual(save(saved, { project: saved.project }).project, saved.project, 'serializing a recovery copy does not advance a revision');
  assert.notEqual(createProjectMetadata().id, createProjectMetadata().id);
});

test('legacy source-only saves upgrade while preserving explicit retired IDs and unfamiliar engine provenance', () => {
  const saved = save();
  saved.engines.fittedPanels = 'future-fitter-v42';
  const reopened = readStudy(serializeStudy(saved));
  assert.equal(reopened.engines.fittedPanels, 'future-fitter-v42');
  assert.equal(createStudy(reopened, { units: reopened.units, up: reopened.up }).engines.fittedPanels, 'future-fitter-v42');
  assert.equal(reopened.nextCellId, 100);
  assert.deepEqual(reopened.layout, old.layout);
  assert.deepEqual(reopened.directBase, old.directBase);
  assert.equal('project' in readStudy(old), false, 'opening a legacy file does not invent a historical project identity');
});

test('unsupported future documents and required features fail before changing the input', () => {
  const saved = save();
  for (const mutation of [value => { value.version = 7; }, value => { value.requiredFeatures.push('future-constrained-divider'); }]) {
    const changed = structuredClone(saved); mutation(changed); const before = structuredClone(changed);
    assert.throws(() => readStudy(changed), /newer compatible Panel Workbench.*original file unchanged/);
    assert.throws(() => serializeStudy(changed), /newer compatible Panel Workbench/);
    assert.deepEqual(changed, before);
  }
  assert.throws(() => readStudy({ ...old, requiredFeatures: ['future-edit'] }), /unsupported features/);
  for (const mutate of [value => { delete value.project; }, value => { delete value.producer; }, value => { delete value.engines; },
    value => { delete value.requiredFeatures; }, value => { value.requiredFeatures = ['source-layout']; },
    value => { value.requiredFeatures.push(value.requiredFeatures[0]); }, value => { delete value.nextCellId; },
    value => { value.project.revision = 0; }, value => { value.project.id = '../other-project'; },
    value => { value.project.updatedAt = '2026-10-29T12:00:00.000Z'; }, value => { value.project.createdAt = 'bad date'; },
    value => { value.producer.build = ''; }, value => { value.engines.panelSolids = ''; }]) {
    const changed = structuredClone(saved); mutate(changed); assert.throws(() => readStudy(changed));
  }
  assert.throws(() => readProjectMetadata({ ...metadata(), revision: Number.MAX_SAFE_INTEGER + 1 }), /revision/);
});

test('a bounded previous calculation can remain attached to an older project revision', () => {
  const summary = summarizeCalculation({ cells: [{ id: 0, valid: true, issues: [], positions: [[0, 0, 0]], flatPositions: [[0, 0, 0]], loops: [], triangles: [] }], solids: [] });
  const project = advanceProjectRevision(metadata(), { now: '2026-10-30T12:30:00.000Z' });
  const lastCalculation = { revision: 1, build: 'earlier-build', summary };
  const saved = save(old, { project, lastCalculation });
  assert.deepEqual(readStudy(serializeStudy(saved)).lastCalculation, lastCalculation);
  assert.deepEqual(createStudy(saved, { units: saved.units, up: saved.up }).lastCalculation, lastCalculation);
  for (const mutate of [value => { value.revision = 3; }, value => { value.revision = 0; }, value => { value.build = ''; },
    value => { value.summary.version = 999; }, value => { value.summary.panels[0].fingerprint = 'bad'; }]) {
    const changed = structuredClone(lastCalculation); mutate(changed);
    assert.throws(() => save(old, { project, lastCalculation: changed }), /calculation|summary|fingerprint/i);
  }
});

test('download and open limits count UTF-8 bytes, including non-ASCII names', () => {
  assert.equal(MAX_STUDY_BYTES, 128 * 1024 * 1024);
  assert.equal(utf8Bytes('aä😀'), 7);
  assert.equal(utf8Bytes('\ud800'), 3, 'unpaired surrogates use UTF-8 replacement encoding');
  assert.equal(assertStudySize(MAX_STUDY_BYTES), MAX_STUDY_BYTES);
  assert.throws(() => assertStudySize(MAX_STUDY_BYTES + 1), /128 MiB/);
  for (const bytes of [-1, .5, NaN, Infinity]) assert.throws(() => assertStudySize(bytes), /invalid file size/);
  const saved = save({ ...old, name: 'Tuomaan kuori — äö 😀' });
  const text = serializeStudy(saved);
  assert.ok(utf8Bytes(text) > text.length);
  assert.equal(readStudy(text).name, saved.name);
});

test('a valid dense source project above the old 30 MB limit remains saveable and reopenable', () => {
  const n = 250, vertices = [], triangles = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push([x * 10, y * 10, 0]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x;
    triangles.push([a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]);
  }
  const model = { vertices, triangles }, state = { name: 'Synthetic dense source', rawModel: model,
    seeds: [{ id: 0, position: [1200, 1200, 0], weight: 1 }], size: 2400, variation: .3, randomSeed: 7,
    mergeGroups: [], cornerEdits: [], view: 'surface' };
  const source = generateCellLayout(model, state.seeds, state);
  state.directBase = captureLayout(model, source, { recipe: layoutRecipe(state) });
  state.layout = { ...state.directBase, version: 2, authority: 'graph' };
  const saved = createStudy(state, { units: 'mm', up: 'z', project: metadata() });
  const text = serializeStudy(saved);
  assert.ok(utf8Bytes(text) > 30e6);
  assert.ok(utf8Bytes(text) < MAX_STUDY_BYTES);
  const reopened = readStudy(text);
  assert.equal(reopened.rawModel.triangles.length, 125000);
  assert.deepEqual(reopened.layout, saved.layout);
  assert.deepEqual(reopened.directBase, saved.directBase);
  assert.equal(restoreLayout(model, reopened.layout).cells.length, 1);
});
