import { createDiagnosticReport, readCalculationSummary } from './project-feedback.js';
import { readStudy, serializeStudy } from './study.js';
import { createDownloadPackage, packageBytes, sha256 } from './download-package.js';

const json = value => JSON.stringify(value,null,2) + '\n';
function note(value,label) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 8000 || value.includes('\0')) throw new Error(`${label} must be text of at most 8,000 characters.`);
  return value;
}
function safeEvent(event) { return event ? { ...event, code:event.issue?.code ?? event.code } : null; }

/** Opt-in attachments are explicit arguments. The diagnostic portion is
 * rebuilt from its allowlist; arbitrary caller properties never enter it. */
export async function buildFeedbackBundle({report:input,expected='',actual='',screenshot,study,previousSummary,
  includeScreenshot=false,includeStudy=false,createdAt=new Date().toISOString()} = {}) {
  if (!input || input.format !== 'panel-workbench-diagnostic' || input.version !== 1) throw new Error('Create a diagnostic report before preparing feedback.');
  if (typeof includeScreenshot !== 'boolean' || typeof includeStudy !== 'boolean') throw new Error('Choose which feedback attachments to include.');
  const report = createDiagnosticReport({project:input.project,build:input.build,settings:input.settings,result:input.calculation,
    previousSummary:previousSummary == null ? undefined : readCalculationSummary(previousSummary),
    selectedIds:input.selectedIds,latestAcceptedEdit:safeEvent(input.latestAcceptedEdit),latestRejection:safeEvent(input.latestRejection)});
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) throw new Error('The feedback snapshot needs a valid date.');
  const feedback = {format:'panel-workbench-feedback',version:1,createdAt,expected:note(expected,'What you expected'),actual:note(actual,'What happened'),report,
    attachments:{screenshot:includeScreenshot,study:includeStudy},
    privacy:{diagnosticGeometryIncluded:false,userNotesMayContainPrivateInformation:true,screenshotShowsVisibleGeometry:includeScreenshot,projectGeometryIncluded:includeStudy}};
  const entries = [{name:'feedback.json',data:json(feedback)}];
  if (includeScreenshot) {
    const bytes = await packageBytes(screenshot);
    if (bytes.length < 8 || bytes.length > 20*1024*1024 || [137,80,78,71,13,10,26,10].some((value,index)=>bytes[index]!==value)) throw new Error('The feedback screenshot must be a PNG smaller than 20 MiB. Capture the view again, or turn off the screenshot attachment.');
    entries.push({name:'view.png',data:bytes});
  }
  if (includeStudy) {
    const parsed=readStudy(study);
    if (parsed.project.id!==report.project.id || parsed.project.revision!==report.project.revision) throw new Error('The attached study does not match the captured feedback revision. Reopen feedback to capture the current work.');
    entries.push({name:'study.json',data:serializeStudy(parsed)});
  }
  const readme=`PANEL WORKBENCH FEEDBACK\n\nCaptured ${createdAt}\nRevision ${report.project.revision ?? 'unknown'}\nBuild ${report.build ?? 'unknown'}\n\n`+
    `feedback.json contains the user's expected and actual behaviour, selected panel IDs and a bounded diagnostic report. The diagnostic section excludes project names, source meshes, coordinates and paths. User-written notes may include private details.\n\n`+
    (includeScreenshot?'view.png shows the explicitly included viewport screenshot. It can reveal project geometry.\n':'No screenshot is included.\n')+
    (includeStudy?'study.json is the explicitly included editable project and contains source geometry and named checkpoints. Share it privately when needed.\n':'No study or source geometry file is included.\n')+
    `\nThe screenshot and notes describe the captured view; they do not certify geometry or fabrication readiness. Nothing is uploaded by preparing this download. Review the attachments before sharing.\n`;
  entries.push({name:'README.txt',data:readme});
  const files=[];
  for (const entry of entries) {const bytes=await packageBytes(entry.data);files.push({name:entry.name,bytes:bytes.length,sha256:await sha256(bytes)});}
  const manifest={format:'panel-workbench-feedback-package',version:1,createdAt,project:report.project,build:report.build,attachments:feedback.attachments,files};
  entries.push({name:'manifest.json',data:json(manifest)});
  return {bytes:await createDownloadPackage(entries,{createdAt}),filename:`panel-feedback-r${report.project.revision??'unknown'}.zip`,manifest};
}
