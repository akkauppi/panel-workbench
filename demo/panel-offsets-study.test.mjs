import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PANEL_OFFSETS_FEATURE, MAX_PANEL_OFFSET_MM, readPanelOffsets, reconcilePanelOffsets } from './panel-offsets.js';
import { captureDesign, createStudy, readStudy, serializeStudy } from './study.js';
import { generateCellLayout } from './geometry.js';
import { captureLayout, layoutRecipe } from './layout.js';
import { transactLayout } from './layout-edit.js';
import { resolveSourceLayout } from './design.js';
import { readPattern } from './pattern.js';
import { createDiagnosticReport, summarizeCalculation } from './project-feedback.js';
import { readRequiredFeatures as releasedFeatureReader } from './fixtures/studies/91a5941/project-document.js';

function fixture() {
  const state = { name: 'Offset fixture',
    rawModel: { vertices: [[0, 0, 0], [1200, 0, 0], [1200, 1200, 0], [0, 1200, 0]], triangles: [[0, 1, 2], [0, 2, 3]] },
    seeds: [[300, 300, 0], [900, 300, 0], [300, 900, 0], [900, 900, 0]].map((position, i) => ({ id: [2, 7, 9, 11][i], position, weight: 1 })),
    mergeGroups: [], cornerEdits: [], directBase: null, pattern: readPattern(),
    panelOffsets: [{ id: 9, offsetMm: -17.5 }, { id: 2, offsetMm: 25 }],
    size: 400, variation: .3, randomSeed: 7, straightness: .7, thickness: 40, roundover: 2,
    carve: false, minimumThickness: 12, flipOutside: false, view: 'flat', nextCellId: 100,
    project: { id: 'offset-persistence-test', revision: 2, createdAt: '2026-11-02T10:00:00.000Z', updatedAt: '2026-11-02T10:01:00.000Z' } };
  const surface = generateCellLayout(state.rawModel, state.seeds, state);
  state.layout = captureLayout(state.rawModel, surface, { recipe: layoutRecipe(state) });
  return state;
}
const save = state => createStudy(state, { units: 'mm', up: 'z', camera: [0, 0, 2500], target: [600, 600, 0] });

test('offsets round-trip independently of source geometry, stock settings and source units', () => {
  const state = fixture(), before = structuredClone(state), expected = readPanelOffsets(state.panelOffsets), saved = save(state);
  assert.equal(saved.version, 6);
  assert.ok(saved.requiredFeatures.includes(PANEL_OFFSETS_FEATURE));
  assert.deepEqual(saved.panelOffsets, expected);
  assert.deepEqual(readStudy(serializeStudy(saved)), saved);
  assert.deepEqual(saved.layout, state.layout);
  const restored = resolveSourceLayout(state.rawModel, { ...saved, thickness: 80, flipOutside: true }, { strict: true });
  assert.equal(restored.source, 'stored');
  assert.deepEqual(restored.layout, state.layout);
  const units = readStudy({ ...saved, units: 'm', rawModel: { ...saved.rawModel, vertices: saved.rawModel.vertices.map(p => p.map(x => x / 1000)) } });
  assert.deepEqual(units.panelOffsets, expected, 'offsets are millimetres regardless of imported source units');
  assert.deepEqual(state, before);
  saved.panelOffsets[0].offsetMm = 99;
  assert.deepEqual(state, before, 'saved offsets must not alias live history');
});

test('latest released feature reader rejects offsets before their editing meaning could be lost', async () => {
  for (const [name, hash] of [
    ['project-document.js', '3c9570841ea36d7dcaf405b76e4c2032f1218e6e16dc3958a4c4f40bc78b635b'],
    ['generator-policy.js', '69ecd35ae92e743fcbbacc6e85193dbdbcbd55578279d5ab11b0cf49c836bb92'],
  ]) {
    const bytes = await readFile(new URL(`./fixtures/studies/91a5941/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `Keep released ${name} frozen`);
  }
  const saved = save(fixture());
  assert.throws(() => releasedFeatureReader(saved.requiredFeatures, saved), /unsupported features: panel-offsets-v1.*newer compatible.*original file unchanged/);
  const plain = save({ ...fixture(), panelOffsets: [] });
  assert.deepEqual(releasedFeatureReader(plain.requiredFeatures, plain), plain.requiredFeatures);
});

test('history clears and restores offsets while no-offset transport retains legacy fields', () => {
  const state = fixture(), withOffsets = captureDesign(state), withoutOffsets = captureDesign({ ...state, panelOffsets: [] });
  Object.assign(state, withoutOffsets);
  assert.deepEqual(state.panelOffsets, []);
  assert.equal('panelOffsets' in save(state), false);
  assert.equal(save(state).requiredFeatures.includes(PANEL_OFFSETS_FEATURE), false);
  Object.assign(state, withOffsets);
  assert.deepEqual(save(state).panelOffsets, readPanelOffsets(withOffsets.panelOffsets));
  assert.deepEqual(captureDesign({}).panelOffsets, []);
  assert.deepEqual(readStudy({ ...save({ ...state, panelOffsets: [] }), panelOffsets: [] }), save({ ...state, panelOffsets: [] }));
});

test('offset parser rejects corrupt distances, duplicate identities and references to absent panels', () => {
  const cells = [{ id: 2 }, { id: 7 }];
  assert.deepEqual(readPanelOffsets([{ id: 7, offsetMm: -3.5, privateField: 'ignored' }, { id: 2, offsetMm: 0 }], cells), [{ id: 7, offsetMm: -3.5 }]);
  assert.deepEqual(readPanelOffsets(undefined, cells), []);
  for (const input of [null, {}, '10', [{ id: -1, offsetMm: 2 }], [{ id: 2.5, offsetMm: 2 }],
    [{ id: 2, offsetMm: NaN }], [{ id: 2, offsetMm: Infinity }], [{ id: 2, offsetMm: '10' }],
    [{ id: 2, offsetMm: MAX_PANEL_OFFSET_MM + 1 }], [{ id: 2, offsetMm: -MAX_PANEL_OFFSET_MM - 1 }],
    [{ id: 2, offsetMm: 0 }, { id: 2, offsetMm: 10 }], [{ id: 99, offsetMm: 10 }]]) {
    assert.throws(() => readPanelOffsets(input, cells), /offset|panel/i);
  }
});

test('invalid saved offsets fail atomically including missing feature and retired IDs', () => {
  const saved = save(fixture());
  for (const [mutate, expected] of [
    [study => { study.requiredFeatures = study.requiredFeatures.filter(x => x !== PANEL_OFFSETS_FEATURE); }, /required panel-offsets-v1/],
    [study => { study.version = 5; }, /file version 6/],
    [study => { study.panelOffsets[0].id = 999; }, /not in this layout/],
    [study => { study.panelOffsets[0].offsetMm = NaN; }, /Enter a panel offset/],
    [study => { study.panelOffsets.push({ ...study.panelOffsets[0] }); }, /repeated/],
  ]) {
    const altered = structuredClone(saved); mutate(altered); const before = structuredClone(altered);
    assert.throws(() => readStudy(altered), expected); assert.deepEqual(altered, before);
  }
});

test('source topology edits explicitly clear affected offsets and preserve unrelated authored IDs', () => {
  const state = fixture(), baseline = structuredClone(state);
  const merged = transactLayout(state.rawModel, state.layout, { type: 'merge-cells', cellIds: [2, 7] });
  state.directBase = state.layout; state.layout = merged.layout;
  state.panelOffsets = reconcilePanelOffsets(state.panelOffsets, state.layout, { clearIds: [2, 7] });
  assert.deepEqual(state.panelOffsets, [{ id: 9, offsetMm: -17.5 }]);
  assert.deepEqual(readStudy(serializeStudy(save(state))).panelOffsets, state.panelOffsets);
  const divided = transactLayout(state.rawModel, state.layout, { type: 'split-cell', cellId: 2, start: [300, -100, 0], end: [300, 1300, 0], nextCellId: 100 });
  const restoredOffset = [{ id: 2, offsetMm: 25 }, ...state.panelOffsets];
  const afterSplit = reconcilePanelOffsets(restoredOffset, divided.layout, { clearIds: [2] });
  assert.deepEqual(afterSplit, state.panelOffsets, 'split parent resets and new child does not inherit an unrelated plane');
  const afterRemoval = reconcilePanelOffsets(restoredOffset, { cells: [{ id: 9 }] });
  assert.deepEqual(afterRemoval, [{ id: 9, offsetMm: -17.5 }]);
  assert.deepEqual(reconcilePanelOffsets(baseline.panelOffsets, baseline.layout), readPanelOffsets(baseline.panelOffsets), 'ordinary centre/corner edits preserve stable IDs');
  assert.deepEqual(baseline.panelOffsets, [{ id: 9, offsetMm: -17.5 }, { id: 2, offsetMm: 25 }], 'reconciliation must not mutate undo state');
});

test('feedback includes bounded distances and safe edit names without private offset fields', () => {
  const report = createDiagnosticReport({ settings: { panelOffsets: [{ id: 2, offsetMm: -15, name: 'private-panel', normal: [123, 456, 789] }] },
    latestAcceptedEdit: { type: 'offset-panel', cellId: 2, target: [123, 456, 789] } });
  assert.deepEqual(report.settings.panelOffsets, [{ id: 2, offsetMm: -15 }]);
  assert.deepEqual(report.latestAcceptedEdit, { type: 'offset-panel', cellId: 2 });
  assert.doesNotMatch(JSON.stringify(report), /private-panel|normal|target|123|456|789/);
  assert.equal(createDiagnosticReport({ settings: { panelOffsets: [{ id: 2, offsetMm: 'private' }] } }).settings.panelOffsets, undefined);
});

test('offset explanations retain known summary codes so saved calculation history stays compatible', () => {
  const summary = summarizeCalculation({ cells: [{ id: 2, valid: false, issues: [
    'The calculation could not make these panels meet at this offset while staying flat. Reduce or reset nearby offsets, or divide a neighbouring cell.',
    'This offset would push a shared corner too far from the shell. Reduce or reset the offset, or reshape the nearby cells.',
    'This offset conflicts with an opening in the shell. Reduce or reset the offset, or reshape the cells beside the opening.',
  ] }] });
  assert.deepEqual(summary.panels[0].issues.map(issue => issue.code), ['shared-junction', 'source-opening']);
});
