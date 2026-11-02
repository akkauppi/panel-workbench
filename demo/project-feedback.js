// Bounded, geometry-free calculation evidence. Fingerprints detect changes;
// they are not cryptographic identities or a substitute for geometric checks.
export const CALCULATION_SUMMARY_VERSION = 1;
const MAX_PANELS = 2000, MAX_ISSUES = 12;
const idOK = value => Number.isSafeInteger(value) && value >= 0;
const metric = value => Number.isFinite(value) && value >= 0 ? Number(value.toFixed(6)) : null;
const valid = value => typeof value === 'boolean' ? value : null;
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._:+()@-]{0,255}$/.test(value) ? value : null;
const projectId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;

// Never copy arbitrary worker/loaded-file error text into a shareable report.
// Known messages map to stable codes and public text; unfamiliar errors remain
// visible as an unclassified issue without leaking a filename or coordinates.
const issueTypes = [
  ['source-disconnected', /separate source-surface|separate outlines|disconnected/i, 'The source region has disconnected pieces.'],
  ['source-opening', /past a planar source opening|source opening|support plane/i, 'The part extends past a source opening.'],
  ['source-rim-drift', /fitted rim|source boundary chords/i, 'The fitted rim exceeds its permitted displacement.'],
  ['nonplanar', /not flat enough|out of plane|planarity/i, 'The panel exceeds its planarity tolerance.'],
  ['shared-junction', /shared edges cannot meet|joint corner differs/i, 'The shared joint cannot meet within its tolerance.'],
  ['outline-crossing', /outline crosses|self.intersect|crossing|crosses itself/i, 'The outline crosses itself.'],
  ['outline-overlap', /touches or overlaps|overlapping|overlaps itself/i, 'The outline touches or overlaps itself.'],
  ['carving-fold', /carved face folds/i, 'The carved surface folds or collapses.'],
  ['collapsed-geometry', /collapsed|collapses|no usable area|no stable normal/i, 'The part contains collapsed geometry or has no usable area.'],
  ['triangulation', /triangulat/i, 'The outline could not be triangulated reliably.'],
  ['mesh-topology', /unmatched|inconsistently oriented|cannot be oriented|non.manifold/i, 'The mesh has inconsistent or unmatched edges.'],
  ['carving-stock', /exceeds the stock|stock overrun/i, 'The carving exceeds the available stock.'],
  ['carving-thickness', /wood remains|minimum thickness/i, 'The carving leaves insufficient material.'],
  ['carving-roundover', /round only the outside/i, 'Carving requires rounding on the outside only.'],
  ['invalid-flat-panel', /reshape this cell before making a solid/i, 'The source fitted panel is unresolved.'],
  ['invalid-geometry', /invalid position|invalid coordinate|invalid boundary/i, 'The part contains invalid geometry.'],
  ['source-coverage', /coverage|source surface|source-surface/i, 'The edit does not preserve a valid source-surface partition.'],
  ['edit-rejected', /cannot split|split.*reject|too close|too small|does not cross|degenerate|chart|seam|boundary|intersect/i, 'The requested edit could not preserve a valid layout.'],
];
const issueText = new Map(issueTypes.map(([code, , text]) => [code, text]));
issueText.set('unclassified', 'The calculation reported an unclassified issue.');

function issue(value, stage) {
  const message = typeof value === 'string' ? value : typeof value?.message === 'string' ? value.message : typeof value?.text === 'string' ? value.text : '';
  const code = issueText.has(value?.code) ? value.code : issueTypes.find(([, expression]) => expression.test(message))?.[0] || 'unclassified';
  return { stage, code, text: issueText.get(code) };
}

function panelIssues(cell, solid) {
  const issues = [], seen = new Set();
  for (const [stage, object] of [['flat', cell], ['solid', solid]]) {
    for (const value of (Array.isArray(object?.issues) ? object.issues : []).slice(0, 100)) {
      const item = issue(value, stage), key = `${stage}:${item.code}`;
      if (!seen.has(key)) { seen.add(key); issues.push(item); }
    }
  }
  return issues.slice(0, MAX_ISSUES);
}

function fingerprint(cell, solid, fields) {
  let first = 2166136261, second = 0x9e3779b9;
  function write(value) {
    const text = typeof value === 'number' ? Number.isFinite(value) ? String(Number(value.toFixed(6))) : 'nonfinite' : String(value);
    for (let i = 0; i <= text.length; i++) {
      const code = i === text.length ? 0 : text.charCodeAt(i);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 2246822519);
    }
  }
  function array(value) {
    if (!Array.isArray(value) && !ArrayBuffer.isView(value)) { write('missing'); return; }
    write(value.length);
    for (const entry of value) {
      if (Array.isArray(entry) || ArrayBuffer.isView(entry)) array(entry);
      else write(typeof entry === 'number' ? entry : 'invalid');
    }
  }
  write('panel-fingerprint-1'); write(JSON.stringify(fields));
  for (const [label, values] of [
    ['source-corners', cell?.positions], ['fitted-corners', cell?.flatPositions],
    ['loops', cell?.loops], ['flat-triangles', cell?.triangles],
    ['solid-vertices', solid?.positions], ['solid-triangles', solid?.triangles],
  ]) { write(label); array(values); }
  return `pf1:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function cornerDrift(cell) {
  if (metric(cell?.maxReferenceDisplacement) !== null) return metric(cell.maxReferenceDisplacement);
  // Only shared fitting guarantees that source and fitted indices correspond.
  if (!cell?.fittedShared || !Array.isArray(cell.positions) || cell.positions.length !== cell.flatPositions?.length) return null;
  let maximum = 0;
  for (let i = 0; i < cell.positions.length; i++) {
    const a = cell.positions[i], b = cell.flatPositions[i];
    if (a?.length !== 3 || b?.length !== 3 || ![...a, ...b].every(Number.isFinite)) return null;
    maximum = Math.max(maximum, Math.hypot(...a.map((value, axis) => value - b[axis])));
  }
  return metric(maximum);
}

function countsFor(panels) {
  const counts = { panels: panels.length, flatValid: 0, flatInvalid: 0, flatUnknown: 0, solidValid: 0, solidInvalid: 0, solidUnknown: 0, failed: 0 };
  for (const panel of panels) {
    for (const stage of ['flat', 'solid']) counts[`${stage}${panel[`${stage}Valid`] === null ? 'Unknown' : panel[`${stage}Valid`] ? 'Valid' : 'Invalid'}`]++;
    if (panel.flatValid === false || panel.solidValid === false) counts.failed++;
  }
  return counts;
}

/** Summarize a completed worker result. Positions are hashed, never retained.
 * sourceCornerDriftMm is displacement of corresponding retained corner anchors,
 * not a Hausdorff distance over the complete source surface. */
export function summarizeCalculation(result, { maxPanels = MAX_PANELS } = {}) {
  if (!Array.isArray(result?.cells)) throw new Error('A calculation summary needs panel results.');
  if (!Number.isSafeInteger(maxPanels) || maxPanels < 1 || maxPanels > MAX_PANELS) throw new Error('Invalid calculation summary panel limit.');
  const cells = new Map(), solids = new Map(), ids = new Set();
  for (const [objects, map] of [[result.cells, cells], [result.solids || [], solids]]) {
    if (!Array.isArray(objects)) throw new Error('A calculation contains invalid panel results.');
    for (const object of objects) {
      if (!idOK(object?.id) || map.has(object.id)) throw new Error('A calculation contains duplicate or invalid panel IDs.');
      map.set(object.id, object); ids.add(object.id);
    }
  }
  for (const cell of result.surfaceCells || []) {
    if (!idOK(cell?.id)) throw new Error('A calculation contains an invalid source panel ID.');
    ids.add(cell.id);
  }
  const all = [...ids].sort((a, b) => a - b).map(id => ({ id, flatValid: valid(cells.get(id)?.valid), solidValid: valid(solids.get(id)?.valid) }));
  const panels = all.slice(0, maxPanels).map(base => {
    const cell = cells.get(base.id), solid = solids.get(base.id);
    const fields = { ...base, sourceCornerDriftMm: cornerDrift(cell), planarityMm: metric(cell?.maxPlanarityError ?? solid?.planarityError), issues: panelIssues(cell, solid) };
    return { ...fields, fingerprint: fingerprint(cell, solid, fields) };
  });
  return { version: CALCULATION_SUMMARY_VERSION, panelCount: all.length, complete: panels.length === all.length,
    counts: countsFor(all), panels, truncatedPanelCount: all.length - panels.length };
}

/** Strict metadata reader: whitelist fields and reconstruct public issue text. */
export function readCalculationSummary(input) {
  const fail = () => { throw new Error('The saved calculation summary is invalid.'); };
  if (!input || input.version !== CALCULATION_SUMMARY_VERSION || !idOK(input.panelCount) || input.panelCount > 100000 ||
    !Array.isArray(input.panels) || input.panels.length > MAX_PANELS || typeof input.complete !== 'boolean' ||
    !idOK(input.truncatedPanelCount) || input.panels.length + input.truncatedPanelCount !== input.panelCount || input.complete !== (input.truncatedPanelCount === 0)) fail();
  const seen = new Set();
  const panels = input.panels.map(panel => {
    if (!idOK(panel?.id) || seen.has(panel.id) || !/^pf1:[a-f0-9]{16}$/.test(panel.fingerprint) ||
      ![true, false, null].includes(panel.flatValid) || ![true, false, null].includes(panel.solidValid) ||
      ![panel.sourceCornerDriftMm, panel.planarityMm].every(value => value === null || Number.isFinite(value) && value >= 0) ||
      !Array.isArray(panel.issues) || panel.issues.length > MAX_ISSUES) fail();
    seen.add(panel.id);
    const issues = panel.issues.map(item => {
      if (!['flat', 'solid'].includes(item?.stage) || !issueText.has(item.code)) fail();
      return { stage: item.stage, code: item.code, text: issueText.get(item.code) };
    });
    return { id: panel.id, fingerprint: panel.fingerprint, flatValid: panel.flatValid, solidValid: panel.solidValid,
      sourceCornerDriftMm: metric(panel.sourceCornerDriftMm), planarityMm: metric(panel.planarityMm), issues };
  }).sort((a, b) => a.id - b.id);
  const measured = countsFor(panels), counts = {};
  for (const key of Object.keys(measured)) {
    const value = input.counts?.[key];
    if (!idOK(value) || value > input.panelCount || value < measured[key] || value > measured[key] + input.truncatedPanelCount || input.complete && value !== measured[key]) fail();
    counts[key] = value;
  }
  if (counts.panels !== input.panelCount || counts.flatValid + counts.flatInvalid + counts.flatUnknown !== input.panelCount ||
    counts.solidValid + counts.solidInvalid + counts.solidUnknown !== input.panelCount ||
    counts.failed < Math.max(counts.flatInvalid, counts.solidInvalid) || counts.failed > counts.flatInvalid + counts.solidInvalid) fail();
  return { version: CALCULATION_SUMMARY_VERSION, panelCount: input.panelCount, complete: input.complete, counts, panels, truncatedPanelCount: input.truncatedPanelCount };
}

function asSummary(input) { return Array.isArray(input?.cells) ? summarizeCalculation(input) : readCalculationSummary(input); }

/** Missing/partial baselines never claim resolution or disappearance. */
export function compareCalculations(previous, current) {
  const after = asSummary(current), before = previous ? asSummary(previous) : null;
  const output = { comparable: !!before?.complete && after.complete, reason: !before ? 'no-baseline' : !before.complete || !after.complete ? 'truncated-summary' : null,
    changedIds: [], resolvedIds: [], newFailedIds: [], addedIds: [], removedIds: [], counts: null };
  if (output.comparable) {
    const old = new Map(before.panels.map(panel => [panel.id, panel])), next = new Map(after.panels.map(panel => [panel.id, panel]));
    for (const panel of after.panels) {
      const prior = old.get(panel.id);
      if (!prior) { output.addedIds.push(panel.id); continue; }
      if (prior.fingerprint !== panel.fingerprint) output.changedIds.push(panel.id);
      const failed = panel.flatValid === false || panel.solidValid === false, wasFailed = prior.flatValid === false || prior.solidValid === false;
      if (wasFailed && panel.flatValid === true && panel.solidValid === true) output.resolvedIds.push(panel.id);
      if (failed && !wasFailed && prior.flatValid !== null && prior.solidValid !== null) output.newFailedIds.push(panel.id);
    }
    output.removedIds = before.panels.filter(panel => !next.has(panel.id)).map(panel => panel.id);
  }
  output.counts = Object.fromEntries(['changed', 'resolved', 'newFailed', 'added', 'removed'].map(key => [key, output[`${key}Ids`].length]));
  return output;
}

function boundedIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(idOK))].sort((a, b) => a - b).slice(0, MAX_PANELS);
}

const editTypes = new Set(['move-corner', 'move-cell', 'split-cell', 'merge-cells', 'delete-cell', 'remove-cell', 'add-cell', 'restore-cell', 'reset-corners', 'reset-layout', 'new-arrangement', 'settings', 'update-settings', 'units', 'orientation', 'import', 'open', 'undo', 'redo', 'edit', 'history', 'preference', 'reserve-panel-id']);
function eventSummary(event) {
  if (!event || typeof event !== 'object') return null;
  const result = { type: editTypes.has(event.type) ? event.type : 'other' };
  // Direct graph handles identify topology. Legacy corner IDs can encode source
  // coordinates, so only the explicit coordinate-free graph form is shareable.
  if (typeof event.cornerId === 'string' && event.cornerId.length <= 64 && /^vertex:v\d+$/.test(event.cornerId)) result.cornerId = event.cornerId;
  for (const key of ['cellId', 'newCellId', 'revision']) if (idOK(event[key])) result[key] = event[key];
  for (const key of ['cellIds', 'affectedCellIds']) if (Array.isArray(event[key])) result[key] = boundedIds(event[key]);
  if (event.code || event.message || event.error || event.text) result.issue = issue({ code: event.code, message: event.message ?? event.error ?? event.text }, 'source');
  return result;
}

function safeSettings(settings) {
  const result = {};
  for (const key of ['size', 'variation', 'randomSeed', 'straightness', 'thickness', 'roundover', 'minimumThickness']) {
    if (Number.isFinite(settings?.[key])) result[key] = settings[key];
  }
  for (const key of ['carve', 'flipOutside', 'allowCellRemoval']) if (typeof settings?.[key] === 'boolean') result[key] = settings[key];
  if (['mm', 'cm', 'm'].includes(settings?.units)) result.units = settings.units;
  if (['y', 'z'].includes(settings?.up)) result.up = settings.up;
  if (['organic', 'regularized', 'hexagonal', 'geodesic'].includes(settings?.pattern?.type)) {
    result.pattern = { type: settings.pattern.type };
    for (const key of ['angle', 'frequency', 'regularity']) if (Number.isFinite(settings.pattern[key])) result.pattern[key] = settings.pattern[key];
  }
  const policy = settings?.generatorPolicy;
  if (policy?.type === 'curvature' && policy.version === 1 && Number.isFinite(policy.minSizeMm) &&
      Number.isFinite(policy.maxSizeMm) && policy.minSizeMm >= 10 && policy.maxSizeMm >= policy.minSizeMm) {
    result.generatorPolicy = { type: 'curvature', version: 1, minSizeMm: policy.minSizeMm, maxSizeMm: policy.maxSizeMm };
  }
  return result;
}

/** JSON-ready shareable report. No arbitrary object spreading: names, source
 * geometry, coordinate arrays, paths and complete projects are never copied.
 * Attaching a project is a separate explicit action owned by the UI. */
export function createDiagnosticReport({ project, build, settings, result, previousSummary, selectedIds, latestAcceptedEdit, latestRejection } = {}) {
  const calculation = result ? asSummary(result) : null;
  const identity = { id: projectId(project?.id), revision: idOK(project?.revision) ? project.revision : null };
  const producer = typeof build === 'string' ? token(build) : null;
  return { format: 'panel-workbench-diagnostic', version: 1, project: identity, build: producer,
    privacy: { includesGeometry: false, includesCoordinates: false, includesProjectName: false, includesProjectFile: false },
    settings: safeSettings(settings), selectedIds: boundedIds(selectedIds), calculation,
    comparison: calculation && previousSummary ? compareCalculations(previousSummary, calculation) : null,
    latestAcceptedEdit: eventSummary(latestAcceptedEdit), latestRejection: eventSummary(latestRejection) };
}
