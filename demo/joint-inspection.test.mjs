import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPanelJoint } from './joint-inspection.js';

const plane={origin:[0,0,0],u:[1,0,0],v:[0,1,0],normal:[0,0,1]};
function cell(id,points,ids,issues=[]){return {id,flatPositions:points,positions:points,sharedVertexIds:ids,loops:[points.map((_,i)=>i)],plane,issues,valid:!issues.length};}
function pair(){return {cells:[cell(0,[[0,0,0],[10,0,0],[10,10,0],[0,10,0]],[0,1,2,3]),cell(1,[[10,0,0],[20,0,0],[20,10,0],[10,10,0]],[1,4,5,2])],solids:[{id:0,valid:true},{id:1,valid:true}]};}

test('crossing inspection identifies the actual two edges and includes only connected neighbours',()=>{
  const a=cell(0,[[0,0,0],[10,10,0],[0,10,0],[10,0,0]],[0,1,2,3],['The fitted outline crosses itself.']);
  const b=cell(1,[[0,10,0],[10,10,0],[10,20,0],[0,20,0]],[2,1,4,5]);
  const distant=cell(2,[[30,30,0],[40,30,0],[40,40,0],[30,40,0]],[6,7,8,9]);
  const input={cells:[a,b,distant]},before=structuredClone(input),inspection=inspectPanelJoint(input,0);
  assert.equal(inspection.kind,'crossing');assert.equal(inspection.precision,'exact');
  assert.deepEqual(inspection.panelIds,[0,1]);assert.deepEqual(inspection.focus,[5,5,0]);
  assert.equal(inspection.segments.length,2);assert.match(inspection.explanation,/highlighted edges cross/);
  inspection.segments[0][0][0]=999;assert.deepEqual(input,before);
});

test('nonplanarity highlights the actual worst corner and its required plane projection',()=>{
  const input=pair();input.cells[0].flatPositions[2]=[10,10,2];input.cells[0].valid=false;input.cells[0].issues=['This panel is not flat enough (2.00 mm).'];
  const inspection=inspectPanelJoint(input,0);
  assert.equal(inspection.kind,'planarity');assert.equal(inspection.precision,'exact');
  assert.equal(inspection.measurements.maxPlanarityMm,2);assert.deepEqual(inspection.points,[[10,10,2]]);
  assert.deepEqual(inspection.segments,[[[10,10,2],[10,10,0]]]);
});

test('stock-joint mismatch compares unrounded matched corner IDs and localizes the real gap',()=>{
  const input=pair();input.solids[0]={id:0,valid:false,issues:['A joint corner differs by 0.50 mm at this thickness.'],cornerAnchors:[{sharedVertexId:1,positive:[10,0,5],negative:[10,0,-5]}]};
  input.solids[1]={id:1,valid:false,cornerAnchors:[{sharedVertexId:1,positive:[10.5,0,5],negative:[10,0,-5]}]};
  const inspection=inspectPanelJoint(input,0);
  assert.equal(inspection.kind,'stock-joint');assert.equal(inspection.precision,'exact');assert.equal(inspection.measurements.maxSharedCornerMismatchMm,.5);
  assert.deepEqual(inspection.focus,[10.25,0,5]);assert.match(inspection.explanation,/unrounded.*0.5 mm/);
  assert.equal(inspection.bounds.max[2],5,'framing must include a highlighted stock corner beyond the nominal flat face');
});

test('unlocalized stock or carving errors give an honest regional view without claiming the shortest edge caused them',()=>{
  const input=pair();input.solids[0]={id:0,valid:false,issues:['The carved face folds or collapses.']};
  const inspection=inspectPanelJoint(input,0);
  assert.equal(inspection.precision,'panel');assert.equal(inspection.kind,'panel');assert.deepEqual(inspection.panelIds,[0,1]);
  assert.deepEqual(inspection.segments,[[[10,0,0],[10,10,0]]]);
  assert.match(inspection.explanation,/does not locate one exact failed joint.*shortest outline edge is marked/);
  assert.equal(inspection.measurements.shortestEdgeMm,10);
});

test('valid inspection and missing current panel have distinct understandable outcomes',()=>{
  const inspection=inspectPanelJoint(pair(),0);assert.equal(inspection.precision,'panel');assert.match(inspection.explanation,/passes the current geometry checks/);
  assert.throws(()=>inspectPanelJoint(pair(),42),/no longer.*current calculation.*select it again/);
});

test('nonadjacent touching edges are identified without mistaking ordinary outline corners for overlaps',()=>{
  const touching=cell(0,[[0,0,0],[10,0,0],[10,10,0],[5,0,0],[0,10,0]],[0,1,2,3,4],['The fitted outline touches or overlaps itself.']);
  const inspection=inspectPanelJoint({cells:[touching]},0);assert.equal(inspection.kind,'overlap');assert.equal(inspection.precision,'exact');
  assert.deepEqual(inspection.focus,[5,0,0]);assert.equal(inspectPanelJoint(pair(),0).kind,'panel');
});
