import { readStudy, serializeStudy } from './study.js';
import { requiredStudyFeatures } from './project-document.js';
import { summarizeCalculation, readCalculationSummary, createDiagnosticReport } from './project-feedback.js';
import { verifyRhino6Export } from './rhino-format.js';
import { buildProductionLayout, buildRepairLayout } from './rhino-export.js';
import { readLastHandoff } from './handoff-record.js';
import { evaluateProjectLimits } from './project-limits.js';
import { createDownloadPackage, packageBytes, sha256 } from './download-package.js';

const number = value => Number.isFinite(value) ? Number(value.toFixed(6)) : null;
const json = value => JSON.stringify(value, null, 2) + '\n';
const panelName = id => `P${String(id + 1).padStart(3, '0')}`;

/** Quote every field and neutralize spreadsheet formula prefixes. */
export function csvField(value) {
  let text = value == null ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(text) && !(typeof value === 'number' && Number.isFinite(value))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function compareHandoffs(previous, current) {
  const after = readLastHandoff(current), before = readLastHandoff(previous);
  if (!after) throw new Error('A handoff comparison needs its current export record.');
  if (before?.projectId===after.projectId && before.revision>after.revision) throw new Error('The previous handoff belongs to a later project revision. Keep the original files and check the chosen study.');
  const comparable = !!before && before.projectId === after.projectId && before.kind === after.kind;
  const output = { comparable, reason: !before ? 'first-handoff' : before.projectId !== after.projectId ? 'different-project' : before.kind !== after.kind ? 'different-export-kind' : null,
    previousRevision: comparable ? before.revision : null, changedIds: [], addedIds: [], removedIds: [], unchangedIds: [] };
  if (comparable) {
    const prior = new Map(before.panels.map(panel => [panel.id, panel.fingerprint])), next = new Map(after.panels.map(panel => [panel.id, panel.fingerprint]));
    for (const panel of after.panels) {
      if (!prior.has(panel.id)) output.addedIds.push(panel.id);
      else if (prior.get(panel.id) !== panel.fingerprint) output.changedIds.push(panel.id);
      else output.unchangedIds.push(panel.id);
    }
    output.removedIds = before.panels.filter(panel => !next.has(panel.id)).map(panel => panel.id);
  }
  return output;
}

function stableSummary(summary) {
  const parsed = readCalculationSummary(summary);
  return json({ ...parsed, panels: [...parsed.panels].sort((a,b) => a.id - b.id) });
}

/** The caller must generate rhinoBytes from this same captured study/result,
 * never from mutable UI state after the export worker returns. This function
 * checks revision, saved calculation evidence, panel identity and file version. */
export async function buildHandoffPackage({ study: input, result, rhinoBytes, kind = 'production', previous,
  exportedAt = new Date().toISOString(), layoutOptions = {} } = {}) {
  const study = readStudy(input), summary = summarizeCalculation(result);
  if (!['production','repair'].includes(kind)) throw new Error('Choose a production or repair handoff.');
  if (!study.project || !study.lastCalculation || study.lastCalculation.revision !== study.project.revision ||
      study.lastCalculation.build !== study.producer.build || stableSummary(study.lastCalculation.summary) !== stableSummary(summary)) {
    throw new Error('The panels do not match this saved revision. Wait for the current calculation, then download the handoff again.');
  }
  if (!summary.complete) throw new Error('The handoff package supports at most 2,000 panels. Download the study and Rhino file separately.');
  const expectedIds = [...study.layout.cells.map(cell => cell.id)].sort((a,b) => a-b), resultIds = [...result.cells.map(cell => cell.id)].sort((a,b) => a-b);
  if (json(expectedIds) !== json(resultIds) || summary.panelCount !== resultIds.length) throw new Error('The calculated panel list does not match this study. Recalculate before downloading the handoff.');
  if (kind === 'production' && (summary.counts.flatValid !== summary.panelCount || summary.counts.solidValid !== summary.panelCount)) {
    throw new Error('Some panels still need repair. Resolve them, or download the study and use Rhino repair; the current study is kept.');
  }
  const options = { up: study.up, carved: study.carve, rowWidth: Number(layoutOptions.rowWidth ?? 2440), spacing: Number(layoutOptions.spacing ?? 60) };
  const placement = kind === 'production' ? buildProductionLayout(result.cells, result.solids, options)
    : buildRepairLayout(result.cells, result.solids, result.surfaceCells, options);
  const current = readLastHandoff({ version: 1, projectId: study.project.id, revision: study.project.revision,
    build: study.producer.build, exportedAt, kind, panels: summary.panels.map(({id,fingerprint}) => ({id,fingerprint})) }, study.project);
  const comparison = compareHandoffs(previous === undefined ? study.lastHandoff : previous, current);
  const bundled = { ...study, lastHandoff: current }; bundled.requiredFeatures = requiredStudyFeatures(bundled);
  const saved = readStudy(bundled), studyText = serializeStudy(saved);
  const modelBytes = await packageBytes(rhinoBytes); verifyRhino6Export(modelBytes);
  const solids = new Map((result.solids || []).map(solid => [solid.id, solid])), parts = new Map(placement.parts.map(part => [part.id,part]));
  const metrics = new Map(summary.panels.map(panel => [panel.id,panel]));
  const projectReview = evaluateProjectLimits(result,study.projectLimits);
  const reviews = new Map(projectReview.panels.map(panel => [panel.id,panel]));
  const changed = new Set(comparison.changedIds), added = new Set(comparison.addedIds);
  const panels = [...result.cells].sort((a,b) => a.id-b.id).map(cell => {
    const solid = solids.get(cell.id), part = parts.get(cell.id), metric = metrics.get(cell.id);
    return { id: cell.id, name: panelName(cell.id), fingerprint: metric.fingerprint,
      status: cell.valid && solid?.valid ? 'resolved' : 'unresolved',
      representation: part.representation ?? 'full-part', change: !comparison.comparable ? 'not-compared' : added.has(cell.id) ? 'added' : changed.has(cell.id) ? 'changed' : 'unchanged',
      nominalWidthMm: number(cell.width), nominalHeightMm: number(cell.height), nominalAreaMm2: number(cell.area),
      placedWidthMm: number(part.bounds.max[0]-part.bounds.min[0]), placedHeightMm: number(part.bounds.max[1]-part.bounds.min[1]),
      placedDepthMm: number(part.bounds.max[2]-part.bounds.min[2]), stockThicknessMm: study.thickness,
      panelOffsetMm: study.panelOffsets?.find(entry => entry.id === cell.id)?.offsetMm ?? 0,
      maxSourceDeviationMm: number(cell.maxDeviation), maxCornerShiftMm: metric.sourceCornerDriftMm,
      minRemainingThicknessMm: number(solid?.minRemainingThickness), actualRoundoverMm: number(solid?.actualRadius),
      carved: !!(solid?.carved && part.representation !== 'source-patch'), issues: metric.issues,
      projectWarnings:reviews.get(cell.id)?.warnings ?? [], shortestEdgeMm:reviews.get(cell.id)?.measurements.shortestEdgeMm ?? null,
      fitsChosenStock:reviews.get(cell.id)?.measurements.fitsStock ?? null };
  });
  const columns = ['name','status','representation','change','nominalWidthMm','nominalHeightMm','nominalAreaMm2','placedWidthMm','placedHeightMm','placedDepthMm',
    'stockThicknessMm','panelOffsetMm','maxSourceDeviationMm','maxCornerShiftMm','minRemainingThicknessMm','actualRoundoverMm','carved','shortestEdgeMm','fitsChosenStock','projectWarnings','fingerprint'];
  const csv = [columns.map(csvField).join(','), ...panels.map(panel => columns.map(key => csvField(key==='projectWarnings' ? panel.projectWarnings.map(warning=>warning.message).join(' ') : panel[key])).join(','))].join('\r\n') + '\r\n';
  const settings = createDiagnosticReport({ settings: { ...study, units: study.units, up: study.up } }).settings;
  const readme = `PANEL WORKBENCH — ${kind.toUpperCase()} HANDOFF\n\nProject ${study.project.id}\nRevision ${study.project.revision}\nBuild ${study.producer.build}\nExported ${exportedAt}\n\n` +
    `study.json is the editable design, including named checkpoints and this handoff history. model.3dm is the exact Rhino 6 export produced for this revision. Keep both together.\n\n` +
    `The 3DM contains shared named blocks with an assembled instance and a ${kind === 'production' ? 'flat full-part' : 'repair inspection'} instance. Block editing updates both instances; editing an outline does not rebuild its mesh. Re-exporting does not patch an already edited Rhino file.\n\n` +
    `panel-schedule.csv lists nominal panel sizes and the axis-aligned extents of each placed exported part. These are millimetres and square millimetres, not a nesting or cutter-clearance calculation.\n\n` +
    (kind === 'repair' ? `REPAIR GEOMETRY: unresolved candidates and source patches are explicitly identified. They are not approved solids or cutting outlines.\n\n` : `All included panels passed the current flat and solid checks. Review stock, joints, tool access, allowances and CAM before fabrication.\n\n`) +
    `manifest.json records the build, settings, calculation checks, panel fingerprints, file SHA-256 hashes and comparison with the previous matching handoff. Geometry fingerprints detect changes; they are not a proof of geometric equivalence. A change of export kind starts a separate comparison baseline.\n\n` +
    `These files include project geometry. Nothing was uploaded by creating this package. Share the package deliberately.\n`;
  const entries = [{name:'study.json',data:studyText},{name:'model.3dm',data:modelBytes},{name:'panel-schedule.csv',data:csv},{name:'README.txt',data:readme}];
  const files = [];
  for (const entry of entries) { const bytes = await packageBytes(entry.data); files.push({name:entry.name,bytes:bytes.length,sha256:await sha256(bytes)}); }
  const manifest = { format:'panel-workbench-handoff',version:1,project:study.project,producer:study.producer,engines:study.engines,
    exportedAt,kind,units:'mm',sourceUnits:study.units,sourceUp:study.up,rhinoArchiveVersion:60,settings,
    projectLimits:projectReview.limits,projectReview,layout:{rowWidthMm:placement.rowWidth,spacingMm:placement.spacing},
    calculation:summary,comparison,panels,files,
    notes:['Original Rhino bytes are preserved. File hashes identify this package, not fabrication approval.',
      'Named checkpoint designs may recalculate differently in a future solver; model.3dm preserves this exact exported geometry.'] };
  entries.push({name:'manifest.json',data:json(manifest)});
  return {bytes:await createDownloadPackage(entries,{createdAt:exportedAt}),filename:`panel-workbench-r${study.project.revision}-${kind}-handoff.zip`,manifest,lastHandoff:current};
}
