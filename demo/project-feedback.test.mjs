import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCalculation, readCalculationSummary, compareCalculations, createDiagnosticReport } from './project-feedback.js';
import { createWorkerHandler } from './worker.js';

function result(ids = [0, 1]) {
  const cells = ids.map(id => ({ id, valid: true, issues: [], fittedShared: true,
    positions: [[id, 0, 0], [id + 10, 0, 0], [id, 10, 0]],
    flatPositions: [[id, 0, 2], [id + 10, 0, 2], [id, 10, 2]],
    loops: [[0, 1, 2]], triangles: [[0, 1, 2]], maxPlanarityError: 0,
  }));
  return { cells, solids: cells.map(cell => ({ id: cell.id, valid: true, issues: [],
    positions: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
    triangles: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]],
  })) };
}

test('summary measures corresponding source corners and keeps only bounded evidence', () => {
  const input = result(), before = structuredClone(input), summary = summarizeCalculation(input);
  assert.equal(summary.panels[0].sourceCornerDriftMm, 2);
  assert.equal(summary.panels[0].planarityMm, 0);
  assert.equal(summary.counts.failed, 0);
  assert.match(summary.panels[0].fingerprint, /^pf1:[a-f0-9]{16}$/);
  assert.deepEqual(input, before);
  for (const forbidden of ['positions', 'flatPositions', 'triangles', 'loops']) assert.equal(JSON.stringify(summary).includes(`"${forbidden}"`), false);
  assert.deepEqual(readCalculationSummary(JSON.parse(JSON.stringify(summary))), summary);
});

test('fingerprints catch geometry/topology changes even when metrics and validity match', () => {
  const baseline = result(), moved = structuredClone(baseline);
  moved.cells[0].flatPositions[0][0] += .1;
  moved.cells[0].maxReferenceDisplacement = 2;
  baseline.cells[0].maxReferenceDisplacement = 2;
  const old = summarizeCalculation(baseline), next = summarizeCalculation(moved);
  assert.equal(old.panels[0].sourceCornerDriftMm, next.panels[0].sourceCornerDriftMm);
  assert.deepEqual(compareCalculations(old, next).changedIds, [0]);
  const stock = result(); stock.solids[1].positions[0][2] = .5;
  assert.deepEqual(compareCalculations(summarizeCalculation(result()), stock).changedIds, [1]);
  const topology = result(); topology.cells[0].triangles = [[0, 2, 1]];
  assert.deepEqual(compareCalculations(summarizeCalculation(result()), topology).changedIds, [0]);
});

test('fingerprint precision ignores sub-micrometre noise and result-array order', () => {
  const original = result(), noisy = result();
  noisy.cells[0].flatPositions[0][0] += 1e-8;
  noisy.cells.reverse(); noisy.solids.reverse();
  assert.deepEqual(summarizeCalculation(original), summarizeCalculation(noisy));
});

test('comparison separates changed, recovered, newly failed, added and removed panels', () => {
  const original = result([0, 1, 2]), next = result([0, 1, 3]);
  original.cells[0].valid = false; original.cells[0].issues = ['The fitted outline crosses itself.'];
  next.solids[1].valid = false; next.solids[1].issues = ['The solid has an unmatched edge.'];
  assert.deepEqual(compareCalculations(summarizeCalculation(original), next), {
    comparable: true, reason: null, changedIds: [0, 1], resolvedIds: [0], newFailedIds: [1], addedIds: [3], removedIds: [2],
    counts: { changed: 2, resolved: 1, newFailed: 1, added: 1, removed: 1 },
  });
});

test('missing stock is unknown, never a recovered panel', () => {
  const before = result(), after = result(); before.solids[0].valid = false; after.solids = [];
  const summary = summarizeCalculation(after);
  assert.equal(summary.counts.solidUnknown, 2);
  assert.deepEqual(compareCalculations(summarizeCalculation(before), summary).resolvedIds, []);
  assert.equal(summarizeCalculation({ cells: [], surfaceCells: [{ id: 9 }] }).panels[0].flatValid, null);
});

test('bounded summaries count every panel and refuse incomplete comparisons', () => {
  const input = result([0, 1, 2]); input.cells[2].valid = false;
  const summary = summarizeCalculation(input, { maxPanels: 1 });
  assert.equal(summary.panels.length, 1); assert.equal(summary.panelCount, 3);
  assert.equal(summary.counts.flatInvalid, 1); assert.equal(summary.truncatedPanelCount, 2);
  assert.deepEqual(readCalculationSummary(summary), summary);
  assert.equal(compareCalculations(summary, input).reason, 'truncated-summary');
  assert.equal(compareCalculations(null, input).reason, 'no-baseline');
  assert.throws(() => summarizeCalculation(input, { maxPanels: 2001 }), /limit/);
});

test('unknown metrics stay unknown when no corresponding fitted corner anchors exist', () => {
  const input = result(); input.cells[0].fittedShared = false; delete input.cells[0].maxPlanarityError;
  input.cells[1].maxReferenceDisplacement = 12.12345678;
  const summary = summarizeCalculation(input);
  assert.equal(summary.panels[0].sourceCornerDriftMm, null); assert.equal(summary.panels[0].planarityMm, null);
  assert.equal(summary.panels[1].sourceCornerDriftMm, 12.123457);
});

test('known issue codes are stable and arbitrary error text never leaks', () => {
  const input = result();
  input.cells[0].issues = ['The fitted outline crosses itself. Move its centre.', 'The fitted outline crosses itself.'];
  input.solids[0].issues = ['Only 1 mm of wood remains; 12 mm is required.', 'Loading /home/private/secret-name.3dm at [12, 34, 56] failed'];
  const panel = summarizeCalculation(input).panels[0];
  assert.deepEqual(panel.issues.map(value => value.code), ['outline-crossing', 'carving-thickness', 'unclassified']);
  assert.doesNotMatch(JSON.stringify(panel), /secret-name|\/home|12, 34, 56/);
});

test('saved summary rejects inconsistent counts, IDs, versions and unbounded content', () => {
  const valid = summarizeCalculation(result());
  for (const mutate of [
    value => { value.version = 2; }, value => { value.panels[1].id = 0; },
    value => { value.panels[0].fingerprint = 'unknown'; }, value => { value.counts.failed = 1; },
    value => { value.panels[0].sourceCornerDriftMm = -1; }, value => { value.panels[0].flatValid = undefined; },
    value => { value.panels[0].issues = Array(13).fill({ stage: 'flat', code: 'unclassified' }); },
    value => { value.panels[0].issues = [{ stage: 'flat', code: 'private-name' }]; },
    value => { value.complete = false; }, value => { value.panelCount = 100001; },
  ]) { const altered = structuredClone(valid); mutate(altered); assert.throws(() => readCalculationSummary(altered), /summary is invalid/); }
  const duplicate = result([0, 0]); assert.throws(() => summarizeCalculation(duplicate), /duplicate/);
});

test('saved-summary normalization strips extra objects and replaces supplied issue text', () => {
  const summary = summarizeCalculation(result());
  summary.privatePath = '/home/private'; summary.panels[0].positions = [[1, 2, 3]];
  summary.panels[0].issues = [{ stage: 'flat', code: 'outline-crossing', text: 'private-name at [1,2,3]' }];
  const restored = readCalculationSummary(summary);
  assert.doesNotMatch(JSON.stringify(restored), /private|positions|\[1,2,3\]/);
  assert.equal(restored.panels[0].issues[0].text, 'The outline crosses itself.');
});

test('shareable report allowlists context and excludes private geometry and arbitrary strings', () => {
  const input = result();
  const report = createDiagnosticReport({ project: { id: 'project-123', revision: 4, name: 'private-name', path: '/home/private' },
    build: '2026-10-30T12:00:00Z', result: input, previousSummary: summarizeCalculation(input), selectedIds: [1, 0, 1, -1],
    settings: { size: 300, thickness: 40, carve: false, units: 'mm', up: 'z', name: 'private-name', rawModel: input, seeds: [{ position: [1, 2, 3] }], pattern: { type: 'regularized', angle: 20, frequency: 2, regularity: .7, name: 'private-name' },
      generatorPolicy: { type: 'curvature', version: 1, minSizeMm: 180, maxSizeMm: 300, name: 'private-name', source: input } },
    latestAcceptedEdit: { type: 'move-cell', cellId: 0, affectedCellIds: [1, 0], target: [1, 2, 3], source: input },
    latestRejection: { type: 'split-cell', message: 'Cannot split private-name at [1,2,3] in /home/private.3dm', cellId: 1, start: [1, 2, 3] },
  });
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /private-name|\/home|positions|rawModel|seeds|"target"|"start"|\[1,2,3\]/);
  assert.deepEqual(report.selectedIds, [0, 1]);
  assert.equal(report.project.revision, 4); assert.equal(report.calculation.counts.panels, 2);
  assert.deepEqual(report.settings.pattern, { type: 'regularized', angle: 20, frequency: 2, regularity: .7 });
  assert.deepEqual(report.settings.generatorPolicy, { type: 'curvature', version: 1, minSizeMm: 180, maxSizeMm: 300 });
  assert.equal(report.latestRejection.issue.code, 'edit-rejected');
  assert.deepEqual(report.comparison.changedIds, []);
  assert.equal(report.privacy.includesProjectFile, false);
});

test('diagnostic report also works before a calculation exists and caps ID lists', () => {
  const report = createDiagnosticReport({ project: { id: '/home/private/file', revision: NaN }, build: 'https://private.test/key', selectedIds: Array.from({ length: 3000 }, (_, i) => i), latestRejection: { type: '/home/private', error: 'secret-project' } });
  assert.equal(report.calculation, null); assert.equal(report.comparison, null);
  assert.equal(report.project.id, null); assert.equal(report.build, null);
  assert.equal(report.selectedIds.length, 2000);
  assert.doesNotMatch(JSON.stringify(report), /secret-project|\/home|private.test/);
});

test('diagnostics retain safe graph corner handles and authored document event types', () => {
  for (const type of ['edit', 'history', 'orientation', 'preference', 'reserve-panel-id']) {
    const report = createDiagnosticReport({ latestAcceptedEdit: { type, cornerId: 'vertex:v123', revision: 8 },
      latestRejection: { type: 'move-corner', cornerId: 'corner:12.1,23.2,34.3', target: [12.1, 23.2, 34.3] } });
    assert.deepEqual(report.latestAcceptedEdit, { type, cornerId: 'vertex:v123', revision: 8 });
    assert.deepEqual(report.latestRejection, { type: 'move-corner' });
  }
  for (const cornerId of ['vertex:v1/private', 'vertex:v1\n', 'vertex:v' + '1'.repeat(65), 'vertex:v1.2', '12,34,56']) {
    assert.equal(createDiagnosticReport({ latestAcceptedEdit: { type: 'move-corner', cornerId } }).latestAcceptedEdit.cornerId, undefined);
  }
});

test('diagnostics preserve the full bounded project ID and build lengths accepted by export', () => {
  const id = 'p'.repeat(128), build = 'b'.repeat(256);
  const report = createDiagnosticReport({ project: { id, revision: 2 }, build });
  assert.equal(report.project.id, id); assert.equal(report.build, build);
  assert.equal(createDiagnosticReport({ project: { id: id + 'x', revision: 2 }, build: build + 'x' }).project.id, null);
  assert.equal(createDiagnosticReport({ build: build + 'x' }).build, null);
});

test('real worker calculation round-trips evidence and detects stock-only recomputation', () => {
  const replies = [], handler = createWorkerHandler(reply => replies.push(reply));
  const inputs = { id: 1, model: { vertices: [[0, 0, 0], [200, 0, 0], [200, 100, 0], [0, 100, 0]], triangles: [[0, 1, 2], [0, 2, 3]] },
    seeds: [{ id: 0, position: [50, 50, 0], weight: 1 }, { id: 1, position: [150, 50, 0], weight: 1 }], size: 100, thickness: 20, roundover: 0 };
  handler({ data: inputs });
  assert.equal(replies[0].error, undefined);
  const before = summarizeCalculation(replies[0].result);
  assert.equal(before.counts.flatValid, 2); assert.equal(before.counts.solidValid, 2);
  assert.deepEqual(readCalculationSummary(JSON.parse(JSON.stringify(before))), before);
  handler({ data: { ...inputs, id: 2, model: undefined, thickness: 30 } });
  assert.equal(replies[1].error, undefined);
  const after = summarizeCalculation(replies[1].result);
  assert.deepEqual(compareCalculations(before, after).changedIds, [0, 1]);
  assert.deepEqual(compareCalculations(before, after).newFailedIds, []);
});
