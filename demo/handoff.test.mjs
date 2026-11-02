import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadRhino } from './rhino-runtime.js';
import { exportProduction3DM, exportRepair3DM } from './rhino-export.js';
import { createWorkerHandler } from './worker.js';
import { createStudy, readStudy, serializeStudy } from './study.js';
import { summarizeCalculation, createDiagnosticReport } from './project-feedback.js';
import { buildHandoffPackage, compareHandoffs, csvField } from './handoff.js';
import { buildFeedbackBundle } from './feedback-bundle.js';
import { readLastHandoff, HANDOFF_HISTORY_FEATURE } from './handoff-record.js';
import { createCheckpoint } from './checkpoints.js';
import { requiredStudyFeatures } from './project-document.js';

function unpack(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),files=new Map();let position=0;
  while(view.getUint32(position,true)===0x04034b50){
    assert.equal(view.getUint16(position+8,true),0);
    const size=view.getUint32(position+18,true),n=view.getUint16(position+26,true),extra=view.getUint16(position+28,true);
    const name=new TextDecoder().decode(bytes.subarray(position+30,position+30+n)),start=position+30+n+extra;
    files.set(name,bytes.slice(start,start+size));position=start+size;
  }
  assert.equal(view.getUint32(position,true),0x02014b50);return files;
}
const text=bytes=>new TextDecoder().decode(bytes),parse=bytes=>JSON.parse(text(bytes));
const project={id:'handoff-test',revision:3,createdAt:'2026-11-02T10:00:00.000Z',updatedAt:'2026-11-02T12:00:00.000Z'};
const date='2026-11-02T17:00:00.000Z';
function fixture({offset=0,revision=3,thickness=40}={}){
  const model={vertices:[[0,0,0],[1000,0,0],[1000,1000,0],[0,1000,0]],triangles:[[0,1,2],[0,2,3]]};
  const input={model,size:500,variation:.3,randomSeed:7,seeds:[[250,250,0],[750,250,0],[250,750,0],[750,750,0]].map((position,id)=>({id,position,weight:1})),mergeGroups:[],cornerEdits:[],layout:null,directBase:null,
    straightness:.7,thickness,roundover:2,carve:false,minimumThickness:12,flipOutside:false,panelOffsets:offset?[{id:0,offsetMm:offset}]:[]};
  let reply;createWorkerHandler(value=>{reply=value;})({data:{...input,id:1}});assert.equal(reply.error,undefined);
  const result=reply.result,summary=summarizeCalculation(result),build='handoff-test-build';
  const study=createStudy({...input,rawModel:model,name:'Private project name',seeds:reply.seeds,layout:reply.layout,view:'flat',project:{...project,revision},
    lastCalculation:{revision,build,summary}}, {units:'mm',up:'z',producer:{name:'Panel Workbench',build}});
  return {study,result};
}
const rhino=await loadRhino();
function rhinoBytes(study,result,kind='production'){
  const options={project:study.project,build:study.producer.build,up:study.up,carved:study.carve};
  return kind==='production'?exportProduction3DM(result.cells,result.solids,rhino,options):exportRepair3DM(result.cells,result.solids,result.surfaceCells,rhino,options);
}

test('Rhino handoff preserves exact model bytes, matching study, native block identity and hashes',async()=>{
  const {study,result}=fixture({offset:10}),bytes=rhinoBytes(study,result),before=serializeStudy(study);
  const output=await buildHandoffPackage({study,result,rhinoBytes:bytes,exportedAt:date}),files=unpack(output.bytes);
  assert.deepEqual([...files.keys()],['study.json','model.3dm','panel-schedule.csv','README.txt','manifest.json']);
  assert.deepEqual(files.get('model.3dm'),bytes);
  const saved=readStudy(parse(files.get('study.json'))),manifest=parse(files.get('manifest.json'));
  assert.equal(saved.project.revision,study.project.revision);assert.deepEqual(saved.panelOffsets,study.panelOffsets);
  assert.deepEqual(saved.lastHandoff,output.lastHandoff);assert.ok(saved.requiredFeatures.includes(HANDOFF_HISTORY_FEATURE));
  assert.deepEqual(saved.layout,study.layout);assert.equal(serializeStudy(study),before);
  assert.equal(manifest.comparison.reason,'first-handoff');assert.equal(manifest.panels.length,4);
  assert.ok(manifest.panels.every(panel=>panel.status==='resolved'&&panel.representation==='full-part'));
  assert.equal(manifest.panels[0].panelOffsetMm,10);
  assert.equal(text(files.get('panel-schedule.csv')).split('\r\n').filter(Boolean).length,5);
  for(const file of manifest.files){assert.equal(file.sha256,createHash('sha256').update(files.get(file.name)).digest('hex'));assert.equal(file.bytes,files.get(file.name).length);}
  const doc=rhino.File3dm.fromByteArray(files.get('model.3dm'));
  try {
    assert.equal(doc.archiveVersion,60);assert.equal(doc.instanceDefinitions().count,4);
    let references=0;for(let i=0;i<doc.objects().count;i++){const object=doc.objects().get(i),geometry=object.geometry();if(geometry instanceof rhino.InstanceReference)references++;geometry.delete();object.delete();}
    assert.equal(references,8);
    const strings=Object.fromEntries(Array.from({length:doc.strings().count},(_,i)=>doc.strings().get(i)));
    assert.equal(strings['panel-workbench-project-revision'],'3');
  }
  finally{doc.delete();}
});

test('later handoffs compare changed, added and removed identities without treating build changes as geometry edits',async()=>{
  const first=fixture(),last=readLastHandoff({version:1,projectId:project.id,revision:3,build:'old-build',exportedAt:date,kind:'production',panels:summarizeCalculation(first.result).panels});
  const same=fixture({revision:4}),a=await buildHandoffPackage({...same,rhinoBytes:rhinoBytes(same.study,same.result),previous:last,exportedAt:date});
  assert.deepEqual(a.manifest.comparison.changedIds,[]);assert.equal(a.manifest.comparison.unchangedIds.length,4);
  const moved=fixture({revision:4,offset:10}),b=await buildHandoffPackage({...moved,rhinoBytes:rhinoBytes(moved.study,moved.result),previous:last,exportedAt:date});
  assert.ok(b.manifest.comparison.changedIds.includes(0));
  const next={...last,revision:4,panels:[last.panels[0],{id:9,fingerprint:'pf1:0123456789abcdef'}]};
  const comparison=compareHandoffs(last,next);assert.deepEqual(comparison.addedIds,[9]);assert.deepEqual(comparison.removedIds,[1,2,3]);
  assert.equal(compareHandoffs({...last,kind:'repair'},next).reason,'different-export-kind');
  assert.equal(compareHandoffs({...last,projectId:'different'},next).comparable,false);
});

test('handoff rejects stale result, wrong revision, foreign panels and wrong Rhino archive before packaging',async()=>{
  const {study,result}=fixture(),bytes=rhinoBytes(study,result);
  const stale=structuredClone(result);stale.cells[0].flatPositions[0][0]+=1;
  await assert.rejects(buildHandoffPackage({study,result:stale,rhinoBytes:bytes}),/do not match/);
  await assert.rejects(buildHandoffPackage({study:{...study,project:{...study.project,revision:4}},result,rhinoBytes:bytes}),/do not match/);
  const wrong=bytes.slice();wrong.set(new TextEncoder().encode('      70'),24);
  await assert.rejects(buildHandoffPackage({study,result,rhinoBytes:wrong}),/instead of Rhino 6/);
  await assert.rejects(buildHandoffPackage({study,result,rhinoBytes:bytes,kind:'other'}),/production or repair/);
});

test('repair handoff preserves every unresolved candidate and explicit diagnostic status',async()=>{
  const {study,result}=fixture({offset:1000});assert.ok(result.cells.some(cell=>!cell.valid));
  const bytes=rhinoBytes(study,result,'repair');
  await assert.rejects(buildHandoffPackage({study,result,rhinoBytes:bytes}),/still need repair/);
  const output=await buildHandoffPackage({study,result,rhinoBytes:bytes,kind:'repair',exportedAt:date});
  assert.equal(output.manifest.panels.length,4);assert.ok(output.manifest.panels.some(panel=>panel.status==='unresolved'));
  assert.ok(output.manifest.panels.filter(panel=>panel.status==='unresolved').every(panel=>panel.issues.length));
  assert.match(text(unpack(output.bytes).get('README.txt')),/REPAIR GEOMETRY/);
});

test('handoff retains named checkpoints and reports practical limits without changing geometry validity',async()=>{
  const {study,result}=fixture();
  const named={...study,checkpoints:[createCheckpoint(study,'Approved arrangement',{id:'approved',now:date})],
    projectLimits:{stockWidthMm:100,stockHeightMm:100,minEdgeMm:600,maxDeviationMm:null}};
  named.requiredFeatures=requiredStudyFeatures(named);
  const current=readStudy(named),output=await buildHandoffPackage({study:current,result,rhinoBytes:rhinoBytes(current,result),exportedAt:date});
  const saved=readStudy(parse(unpack(output.bytes).get('study.json')));
  assert.equal(saved.checkpoints[0].name,'Approved arrangement');
  assert.equal(output.manifest.projectReview.warningPanelIds.length,4);
  assert.ok(output.manifest.panels.every(panel=>panel.status==='resolved'&&panel.projectWarnings.length&&panel.fitsChosenStock===false));
});

test('handoff history strips unknown fields and rejects corrupt identities, dates, fingerprints and future references',()=>{
  const valid={version:1,projectId:project.id,revision:3,build:'build',exportedAt:date,kind:'production',panels:[{id:1,fingerprint:'pf1:0123456789abcdef',privateName:'omit'}],privateSource:[1,2,3]};
  assert.equal(readLastHandoff(valid,project).privateSource,undefined);assert.equal(readLastHandoff(valid,project).panels[0].privateName,undefined);
  for(const change of [{version:2},{projectId:'other'},{revision:4},{exportedAt:'yesterday'},{panels:[{id:1,fingerprint:'bad'}]},{panels:[valid.panels[0],valid.panels[0]]}]) assert.throws(()=>readLastHandoff({...valid,...change},project),/history is invalid/);
  assert.equal(readLastHandoff(undefined),null);assert.throws(()=>compareHandoffs({...valid,revision:4},valid),/later project revision/);
  assert.equal(csvField('=IMPORTXML("secret")'),'"\'=IMPORTXML(""secret"")"');assert.equal(csvField(-10),'"-10"');assert.equal(csvField(' +SUM(A1:A2)'),'"\' +SUM(A1:A2)"');
});

test('feedback defaults exclude both attachments and arbitrary diagnostic fields',async()=>{
  const {study,result}=fixture(),report=createDiagnosticReport({project:study.project,build:study.producer.build,result,settings:study,selectedIds:[0]});
  report.privateName='secret';report.settings.privateMesh=study.rawModel;
  const output=await buildFeedbackBundle({report,expected:'Keep this exact wording.\nSecond line.',actual:'The edge moved.',screenshot:new Uint8Array([1]),study,createdAt:date});
  const files=unpack(output.bytes),feedback=parse(files.get('feedback.json'));
  assert.deepEqual([...files.keys()],['feedback.json','README.txt','manifest.json']);
  assert.equal(feedback.expected,'Keep this exact wording.\nSecond line.');assert.equal(feedback.actual,'The edge moved.');
  assert.doesNotMatch(text(files.get('feedback.json')),/secret|privateMesh|Private project name|rawModel/);
  assert.deepEqual(feedback.report.selectedIds,[0]);assert.deepEqual(feedback.attachments,{screenshot:false,study:false});
});

test('feedback attachments require explicit choices and matching captured study revision',async()=>{
  const {study,result}=fixture(),report=createDiagnosticReport({project:study.project,build:study.producer.build,result,settings:study});
  const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
  const output=await buildFeedbackBundle({report,expected:'test',actual:'test',screenshot:new Blob([png],{type:'image/png'}),includeScreenshot:true,study,includeStudy:true,createdAt:date}),files=unpack(output.bytes);
  assert.deepEqual(files.get('view.png'),png);assert.equal(parse(files.get('study.json')).project.revision,3);
  assert.equal(parse(files.get('feedback.json')).privacy.projectGeometryIncluded,true);
  await assert.rejects(buildFeedbackBundle({report,includeStudy:true,study:{...study,project:{...study.project,revision:4}}}),/does not match the captured/);
  await assert.rejects(buildFeedbackBundle({report,includeScreenshot:true,screenshot:new Uint8Array([1,2,3])}),/must be a PNG/);
  await assert.rejects(buildFeedbackBundle({report,expected:'x'.repeat(8001)}),/8,000/);
  for(const file of output.manifest.files) assert.equal(file.sha256,createHash('sha256').update(files.get(file.name)).digest('hex'));
});

test('feedback rebuilds saved/current comparison from bounded calculation evidence',async()=>{
  const before=fixture(),after=fixture({offset:10,revision:4}),previousSummary=summarizeCalculation(before.result);
  const report=createDiagnosticReport({project:after.study.project,build:after.study.producer.build,result:after.result,previousSummary});
  const output=await buildFeedbackBundle({report,previousSummary:{...previousSummary,privateName:'secret'},createdAt:date});
  const feedback=parse(unpack(output.bytes).get('feedback.json'));
  assert.deepEqual(feedback.report.comparison,report.comparison);assert.ok(feedback.report.comparison.changedIds.length);
  assert.equal(JSON.stringify(feedback).includes('secret'),false);
  await assert.rejects(buildFeedbackBundle({report,previousSummary:{...previousSummary,panels:[{id:0,fingerprint:'bad'}]}}),/summary is invalid/);
});
