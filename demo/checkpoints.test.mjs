import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { generateCellLayout } from './geometry.js';
import { captureLayout, layoutRecipe } from './layout.js';
import { createStudy, readStudy, serializeStudy, captureDesign } from './study.js';
import { createCheckpoint, checkpointStudy, MAX_CHECKPOINTS, CHECKPOINTS_FEATURE } from './checkpoints.js';
import { PROJECT_LIMITS_FEATURE, readProjectLimits } from './project-limits.js';
import { EDIT_LOCKS_FEATURE } from './edit-locks.js';
import { HANDOFF_HISTORY_FEATURE } from './handoff-record.js';
import { readRequiredFeatures as releasedFeatures } from './fixtures/studies/6e4cee2/project-document.js';

function fixture() {
  const state = { name: 'Checkpoint fixture',
    rawModel: { vertices: [[0,0,0],[1200,0,0],[1200,1200,0],[0,1200,0]], triangles: [[0,1,2],[0,2,3]] },
    seeds: [[300,300,0],[900,300,0],[300,900,0],[900,900,0]].map((position,id)=>({ id,position,weight:1 })),
    mergeGroups: [], cornerEdits: [], layout: null, directBase: null, size: 400, variation: .3, randomSeed: 7,
    straightness: .7, thickness: 40, roundover: 2, carve: false, minimumThickness: 12, flipOutside: false,
    nextCellId: 10, view: 'flat', project: { id:'checkpoint-test',revision:10,createdAt:'2026-11-02T10:00:00.000Z',updatedAt:'2026-11-02T10:10:00.000Z' },
  };
  state.layout = captureLayout(state.rawModel, generateCellLayout(state.rawModel,state.seeds,state), { recipe:layoutRecipe(state) });
  return createStudy(state,{ units:'mm',up:'z',camera:[0,-1000,2500],target:[600,600,0],producer:{name:'Panel Workbench',build:'test-build'} });
}
const checkpointOptions = { id:'checkpoint-a',now:'2026-11-02T10:11:00.000Z' };
function store(study, additions) {
  const state = { ...study, ...additions };
  return createStudy(state,{units:study.units,up:study.up,camera:study.camera,target:study.target,producer:study.producer});
}

test('default workflow fields leave older study transport unchanged and Undo can clear settings',()=>{
  const plain=fixture(), snapshot=captureDesign(plain);
  for(const key of ['projectLimits','protectedCellIds','checkpoints','lastHandoff']) assert.equal(key in plain,false,key);
  assert.deepEqual(snapshot.projectLimits,readProjectLimits());
  assert.deepEqual(snapshot.protectedCellIds,[]);
  assert.equal('checkpoints' in snapshot,false); assert.equal('lastHandoff' in snapshot,false);
  assert.deepEqual(releasedFeatures(plain.requiredFeatures,plain),plain.requiredFeatures);
  assert.deepEqual(readStudy(serializeStudy(plain)),plain);
});

test('project limits and source edit locks persist with explicit feature declarations',()=>{
  const plain=fixture(), settings={ projectLimits:{stockWidthMm:1220,stockHeightMm:2440,minEdgeMm:8,maxDeviationMm:25},protectedCellIds:[3,0] };
  const saved=store(plain,settings), reopened=readStudy(serializeStudy(saved));
  assert.deepEqual(reopened.projectLimits,settings.projectLimits);
  assert.deepEqual(reopened.protectedCellIds,[0,3]);
  assert.ok(saved.requiredFeatures.includes(PROJECT_LIMITS_FEATURE));assert.ok(saved.requiredFeatures.includes(EDIT_LOCKS_FEATURE));
  assert.throws(()=>releasedFeatures(saved.requiredFeatures,saved),/unsupported features/);
  const state={ ...saved,checkpoints:[{id:'keep-me'}],lastHandoff:{id:'keep-me'} };
  Object.assign(state,captureDesign(plain));
  assert.deepEqual(state.projectLimits,readProjectLimits());assert.deepEqual(state.protectedCellIds,[]);
  assert.deepEqual(state.checkpoints,[{id:'keep-me'}]);assert.deepEqual(state.lastHandoff,{id:'keep-me'});
  for(const update of [
    {protectedCellIds:[99]}, {protectedCellIds:[0,0]},
    {projectLimits:{...settings.projectLimits,stockWidthMm:-10}},
    {projectLimits:{...settings.projectLimits,maxDeviationMm:Infinity}},
  ]) assert.throws(()=>store(plain,update));
});

test('a named checkpoint stores a portable independent design while sharing the parent mesh once',()=>{
  const plain=fixture(), withSettings=store(plain,{panelOffsets:[{id:0,offsetMm:10}],protectedCellIds:[0],projectLimits:{stockWidthMm:1200,stockHeightMm:2400,minEdgeMm:8,maxDeviationMm:25}});
  const original=structuredClone(withSettings), checkpoint=createCheckpoint(withSettings,'  Approved layout  ',checkpointOptions);
  assert.equal(checkpoint.name,'Approved layout');
  for(const key of ['rawModel','checkpoints','lastHandoff']) assert.equal(key in checkpoint.study,false,key);
  const saved=store(withSettings,{checkpoints:[checkpoint]}), reopened=readStudy(serializeStudy(saved));
  assert.ok(reopened.requiredFeatures.includes(CHECKPOINTS_FEATURE));
  assert.deepEqual(reopened.checkpoints,saved.checkpoints);
  assert.equal((serializeStudy(saved).match(/"rawModel"/g)||[]).length,1);
  const child=readStudy(checkpointStudy(reopened.checkpoints[0],reopened));
  assert.deepEqual(child,withSettings);
  withSettings.panelOffsets[0].offsetMm=90;
  withSettings.layout.vertices[0].position[0]+=1;
  assert.deepEqual(child,original,'later working edits must not rewrite the checkpoint');
  assert.equal('checkpoints' in captureDesign(saved),false,'Undo must not recursively copy named alternatives');
});

test('checkpoint restoration keeps document-level history and does not require rewinding panel IDs',()=>{
  const plain=fixture(), checkpoint=createCheckpoint(plain,'Original',checkpointOptions);
  const current=store(plain,{checkpoints:[checkpoint],thickness:60,nextCellId:100,project:{...plain.project,revision:12,updatedAt:'2026-11-02T10:12:00.000Z'}});
  const restored=readStudy(checkpointStudy(checkpoint,current));
  const design=captureDesign(restored), state={...current};
  Object.assign(state,design);
  state.nextCellId=Math.max(current.nextCellId,restored.nextCellId);
  assert.equal(state.thickness,40);assert.equal(state.nextCellId,100);
  assert.deepEqual(state.project,current.project);assert.deepEqual(state.checkpoints,current.checkpoints);
  assert.equal(restored.project.revision,10,'historical calculation evidence retains its original revision');
});

test('handoff history remains a top-level document record and does not inflate checkpoint snapshots',()=>{
  const plain=fixture(), lastHandoff={version:1,projectId:plain.project.id,revision:9,build:'test-build',exportedAt:'2026-11-02T10:09:00.000Z',kind:'production',panels:[{id:0,fingerprint:'pf1:0123456789abcdef'}]};
  const exported=store(plain,{lastHandoff}), checkpoint=createCheckpoint(exported,'Issued',checkpointOptions);
  assert.ok(exported.requiredFeatures.includes(HANDOFF_HISTORY_FEATURE));
  assert.deepEqual(readStudy(serializeStudy(exported)).lastHandoff,lastHandoff);
  assert.equal(checkpoint.study.lastHandoff,undefined);
  assert.equal(checkpoint.study.requiredFeatures.includes(HANDOFF_HISTORY_FEATURE),false);
  const state={...exported,checkpoints:[checkpoint]};Object.assign(state,captureDesign(fixture()));
  assert.deepEqual(state.lastHandoff,lastHandoff);assert.equal(state.checkpoints.length,1);
  assert.throws(()=>store(plain,{lastHandoff:{...lastHandoff,revision:99}}),/handoff history is invalid/);
  assert.throws(()=>store(plain,{lastHandoff:{...lastHandoff,projectId:'foreign'}}),/handoff history is invalid/);
});

test('eight deliberate checkpoints are retained and the next attempt never silently evicts one',()=>{
  let study=fixture();
  for(let index=0;index<MAX_CHECKPOINTS;index++) {
    const checkpoint=createCheckpoint(study,`Alternative ${index+1}`,{...checkpointOptions,id:`checkpoint-${index}`});
    study=store(study,{checkpoints:[...(study.checkpoints||[]),checkpoint]});
  }
  const before=JSON.stringify(study);
  assert.throws(()=>createCheckpoint(study,'Ninth',{...checkpointOptions,id:'checkpoint-ninth'}),/8 named checkpoints.*No checkpoint was removed/);
  assert.equal(JSON.stringify(study),before);
  assert.equal(study.checkpoints.length,8);
  assert.ok(study.checkpoints.every(checkpoint=>!checkpoint.study.checkpoints));
});

test('malformed, nested, foreign and unsupported checkpoint contents fail before installation',()=>{
  const plain=fixture(), checkpoint=createCheckpoint(plain,'Approved',checkpointOptions), saved=store(plain,{checkpoints:[checkpoint]});
  for(const [mutate,expression] of [
    [study=>study.checkpoints.push(structuredClone(checkpoint)),/repeated/],
    [study=>study.checkpoints[0].study.checkpoints=[],/nested/],
    [study=>study.checkpoints[0].study.rawModel=study.rawModel,/source meshes/],
    [study=>study.checkpoints[0].study.lastHandoff={},/handoff history/],
    [study=>study.checkpoints[0].study.project.id='another-project',/another project/],
    [study=>study.checkpoints[0].study.project.revision=99,/future revision/],
    [study=>study.checkpoints[0].study.nextCellId=999,/beyond the current project counter/],
    [study=>study.checkpoints[0].study.version=5,/version 6 checkpoint/],
    [study=>study.checkpoints[0].study.units='cm',/different source shell or units/],
    [study=>study.checkpoints[0].study.layout.source.signature='0000000000000000',/different source shell/],
    [study=>study.checkpoints[0].createdAt='not-a-date',/saved date/],
    [study=>study.checkpoints[0].createdAt='2020-01-01T00:00:00.000Z',/before the project/],
    [study=>study.checkpoints[0].study.requiredFeatures.push('future-checkpoint-semantics'),/unsupported features/],
    [study=>study.requiredFeatures=study.requiredFeatures.filter(feature=>feature!==CHECKPOINTS_FEATURE),/missing.*named-checkpoints/],
  ]) {
    const damaged=structuredClone(saved);mutate(damaged);const before=structuredClone(damaged);
    assert.throws(()=>readStudy(damaged),expression);assert.deepEqual(damaged,before);
  }
  const cyclic=structuredClone(saved);cyclic.checkpoints[0].study.checkpoints=cyclic.checkpoints;
  assert.throws(()=>readStudy(cyclic),/nested/,'nesting guard must run before recursive parsing');
  assert.throws(()=>createCheckpoint(saved,'approved',{...checkpointOptions,id:'new'}),/name is already used/);
  assert.throws(()=>createCheckpoint(plain,'   ',checkpointOptions),/name between/);
  assert.throws(()=>createCheckpoint(plain,'x'.repeat(81),checkpointOptions),/name between/);
});

test('the released offset-capable reader refuses new workflow semantics before dropping them',async()=>{
  for(const [file,hash] of [
    ['project-document.js','07a6c0ebcaf9ad03f17be116a6b807290eef2d976eb24e11a07c985af86921a2'],
    ['generator-policy.js','69ecd35ae92e743fcbbacc6e85193dbdbcbd55578279d5ab11b0cf49c836bb92'],
    ['panel-offsets.js','45ac7fd31e98a9df92cb122982a2ba1e4f18510c948e667a5985a732ed196c9c'],
  ]) assert.equal(createHash('sha256').update(await readFile(new URL(`./fixtures/studies/6e4cee2/${file}`,import.meta.url))).digest('hex'),hash,`Freeze released ${file}`);
  const plain=fixture(), saved=store(plain,{checkpoints:[createCheckpoint(plain,'Approved',checkpointOptions)]});
  assert.throws(()=>releasedFeatures(saved.requiredFeatures,saved),/unsupported features: named-checkpoints-v1/);
});
