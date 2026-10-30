import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCellLayout } from './geometry.js';
import { captureLayout, restoreLayout, layoutRecipe, readLayout, nextLayoutCellId } from './layout.js';
import { transactLayout, previewCellSplit, layoutCellHandle } from './layout-edit.js';
import { captureDesign, createStudy, readStudy } from './study.js';
import { resolveSourceLayout } from './design.js';

function fixture({n=6,step=200,hole=false,u=false,curved=false,points=[[600,600,0]]}={}) {
  const vertices=[],triangles=[];
  for(let y=0;y<=n;y++)for(let x=0;x<=n;x++)vertices.push([x*step,y*step,curved?12*(x-3)**2+8*(y-3)**2:0]);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    if(hole&&x===2&&y===2||u&&x===1&&y>0)continue;
    const a=y*(n+1)+x;triangles.push([a,a+1,a+n+2],[a,a+n+2,a+n+1]);
  }
  const model={vertices,triangles},seeds=points.map((position,id)=>({id,position,weight:1}));
  const source=generateCellLayout(model,seeds,{size:500}),layout=captureLayout(model,source,{recipe:layoutRecipe({seeds,size:500})});
  return {model,seeds,source,layout};
}
function split(f,cellId,start,end,extra={}) {return transactLayout(f.model,f.layout,{type:'split-cell',cellId,start,end,...extra});}
const distance=(a,b)=>Math.hypot(...a.map((x,k)=>x-b[k]));
function coverage(f,result) {
  assert.equal(result.surface.cells.length,f.layout.cells.length+1);
  assert.ok(result.surface.stats.coverageError<1e-10);
  assert.ok(result.surface.cells.every(cell=>cell.sourceComponentCount===1));
  assert.deepEqual(restoreLayout(f.model,JSON.parse(JSON.stringify(result.layout))),result.surface);
}

test('a divider creates two source parts and refines shared neighbour edges without repartitioning them',()=>{
  const points=Array.from({length:25},(_,i)=>[120+(i%5)*240,120+Math.floor(i/5)*240,0]),f=fixture({points}),before=structuredClone(f.layout);
  const result=split(f,12,[613,-100,0],[613,1300,0]);coverage(f,result);
  assert.equal(result.change.newCellId,25);assert.equal(result.change.survivingCellId,12);
  assert.equal(result.layout.version,3);assert.deepEqual(result.layout.recipe,f.layout.recipe);
  assert.deepEqual(result.layout.splitOrigins,[{id:25,parentCellId:12,sourceSeedIds:[12]}]);
  assert.deepEqual(result.surface.cells.find(cell=>cell.id===25).memberSeedIds,[25]);
  assert.deepEqual(result.surface.cells.find(cell=>cell.id===12).memberSeedIds,[12]);
  const originalArea=f.source.cells.find(cell=>cell.id===12).area;
  assert.ok(Math.abs(result.surface.cells.filter(cell=>[12,25].includes(cell.id)).reduce((sum,cell)=>sum+cell.area,0)-originalArea)<1e-6);
  assert.ok(result.change.affectedCellIds.some(id=>![12,25].includes(id)), 'the cut ends on shared boundaries');
  assert.ok(f.layout.cells.some(cell=>cell.id!==12&&result.layout.cells.find(other=>other.id===cell.id).positions.length>cell.positions.length), 'a neighbour acquires the cut endpoint in its source triangulation');
  for(const cell of f.layout.cells.filter(cell=>cell.id!==12)){
    const after=result.layout.cells.find(other=>other.id===cell.id);
    assert.ok(Math.abs(result.surface.cells.find(other=>other.id===cell.id).area-f.source.cells.find(other=>other.id===cell.id).area)<1e-6);
    if(!result.change.affectedCellIds.includes(cell.id)){assert.deepEqual(after.positions,cell.positions);assert.deepEqual(after.triangles,cell.triangles);}
  }
  assert.ok(result.layout.corners.some(corner=>corner.cells.includes(12)&&corner.cells.includes(25)&&corner.cells.length===3));
  assert.deepEqual(f.layout,before);
});

test('single-cell rim cuts, exact source diagonals and curved shells preserve their source',()=>{
  for(const curved of [false,true]){
    const f=fixture({curved}),handle=layoutCellHandle(f.layout,0);
    const result=split(f,0,handle.position.map((x,k)=>x+[-1000,0,0][k]),handle.position.map((x,k)=>x+[1000,0,0][k]));
    coverage(f,result);
    assert.equal(result.layout.corners.filter(corner=>corner.boundary).length,2);
  }
  const f=fixture(),diagonal=split(f,0,[0,0,0],[1200,1200,0]);coverage(f,diagonal);
  assert.ok(diagonal.surface.cells.every(cell=>Math.abs(cell.area-720000)<1e-6));
});

test('divider previews extend to cell edges and leave holes empty on either side',()=>{
  const f=fixture({hole:true}),before=structuredClone(f.layout);
  const operation={cellId:0,start:[500,300,0],end:[500,700,0]},preview=previewCellSplit(f.model,f.layout,operation);
  assert.equal(preview.issue,null);assert.ok(preview.segments.length>=4);
  for(let i=0;i<preview.segments.length;i+=2){const mid=preview.segments[i].map((x,k)=>(x+preview.segments[i+1][k])/2);assert.ok(!(mid[0]>400&&mid[0]<600&&mid[1]>400&&mid[1]<600));}
  for(const x of [500,800]){
    const result=split(f,0,[x,-100,0],[x,1300,0]);coverage(f,result);
    assert.ok(Math.abs(result.surface.stats.totalArea-1400000)<1e-6);
    if(x===800)assert.equal(result.surface.cells.reduce((sum,cell)=>sum+cell.holeCount,0),1);
    for(const cell of result.surface.cells)for(const tri of cell.triangles){const p=[0,1].map(k=>tri.reduce((sum,id)=>sum+cell.positions[id][k],0)/3);assert.ok(!(p[0]>400&&p[0]<600&&p[1]>400&&p[1]<600));}
  }
  const long=split(f,0,[800,-100,0],[800,1300,0]),short=split(f,0,[800,490,0],[800,510,0]);
  assert.deepEqual(long.surface.cells.map(cell=>cell.area),short.surface.cells.map(cell=>cell.area));
  assert.deepEqual(f.layout,before);
});

test('invalid dividers and disconnected sides reject atomically with a useful preview reason',()=>{
  const f=fixture(),before=structuredClone(f.layout);
  for(const [start,end,reason] of [
    [[0,0,0],[0,0,0],/longer divider/],
    [[-10,0,0],[-10,1000,0],/both sides/],
    [[1e-9,0,0],[1e-9,1000,0],/both sides|sliver/],
    [[NaN,0,0],[100,100,0],/finite/],
  ]){
    assert.throws(()=>split(f,0,start,end),reason);
    assert.match(previewCellSplit(f.model,f.layout,{cellId:0,start,end}).issue,reason);
  }
  assert.throws(()=>split(f,999,[0,500,0],[1200,500,0]),/no longer present/);
  assert.deepEqual(f.layout,before);
  const u=fixture({n:3,u:true,points:[[300,100,0]]}),saved=structuredClone(u.layout);
  assert.throws(()=>split(u,0,[0,350,0],[600,350,0]),/disconnected pieces/);
  assert.deepEqual(u.layout,saved);
});

test('split identities and ancestry survive merging, further division, and later graph editing',()=>{
  const f=fixture(),first=split(f,0,[600,0,0],[600,1200,0],{nextCellId:40});
  assert.equal(nextLayoutCellId(first.layout),41);
  const merged=transactLayout(f.model,first.layout,{type:'merge-cells',cellIds:[0,40]});
  assert.equal(merged.surface.cells.length,1);assert.equal(nextLayoutCellId(merged.layout),41);
  assert.deepEqual(merged.layout.splitOrigins,first.layout.splitOrigins);
  const second=split({...f,layout:merged.layout},0,[0,500,0],[1200,500,0]);
  assert.equal(second.change.newCellId,41);assert.deepEqual(second.layout.splitOrigins[1],{id:41,parentCellId:0,sourceSeedIds:[0]});
  assert.deepEqual(second.layout.recipe,f.layout.recipe);
  assert.throws(()=>split({...f,layout:merged.layout},0,[0,500,0],[1200,500,0],{nextCellId:40}),/stale/);
  const boundary=second.surface.corners.find(corner=>corner.boundary&&Math.abs(corner.position[0])<1e-5);
  const moved=transactLayout(f.model,second.layout,{type:'move-corner',cornerId:boundary.id,target:boundary.position.map((x,k)=>x+[0,5,0][k])});
  const handle=layoutCellHandle(moved.layout,41),centred=transactLayout(f.model,moved.layout,{type:'move-cell',cellId:41,target:handle.position.map((x,k)=>x+[1,2,0][k])});
  assert.deepEqual(centred.layout.splitOrigins,second.layout.splitOrigins);assert.ok(centred.surface.stats.coverageError<1e-10);
  assert.deepEqual(restoreLayout(f.model,JSON.parse(JSON.stringify(centred.layout))),centred.surface);
});

test('saved split studies retain the original recipe and a monotonic counter outside undo snapshots',()=>{
  const f=fixture(),result=split(f,0,[600,0,0],[600,1200,0],{nextCellId:20});
  const state={seeds:f.seeds,layout:result.layout,directBase:f.layout,nextCellId:100,size:500,variation:.3,randomSeed:7,
    rawModel:f.model,name:'Split fixture',view:'surface'};
  const saved=createStudy(state,{units:'mm',up:'z'}),reopened=readStudy(JSON.stringify(saved));
  assert.equal(saved.version,6);assert.equal(reopened.nextCellId,100);
  assert.deepEqual(reopened.seeds,f.seeds);assert.deepEqual(reopened.layout.recipe,f.layout.recipe);
  assert.deepEqual(reopened.directBase,f.layout);
  assert.equal('nextCellId' in captureDesign(state),false,'undo snapshots must not rewind the reserved panel IDs');
  const resolved=resolveSourceLayout(f.model,reopened,{strict:true});
  assert.equal(resolved.source,'stored');assert.deepEqual(resolved.seeds,f.seeds);
  assert.deepEqual(resolved.surface,result.surface);
  for(const nextCellId of [20,-1,1.5])assert.throws(()=>readStudy({...saved,nextCellId}),/next panel ID/);
  const reset=createStudy({...state,layout:f.layout,directBase:null},{units:'mm',up:'z'});
  assert.equal(reset.nextCellId,100,'resetting source geometry retains reserved IDs');
  for(const mutate of [origin=>{origin.id=0;},origin=>{origin.parentCellId=999;},origin=>{origin.sourceSeedIds=[999];}]){
    const corrupt=structuredClone(result.layout);mutate(corrupt.splitOrigins[0]);assert.throws(()=>readLayout(corrupt),/split ancestry/);
  }
});
