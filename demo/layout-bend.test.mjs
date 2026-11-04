import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildSurfaceCells } from './geometry.js';
import { captureLayout, layoutRecipe, restoreLayout, nextLayoutCellId } from './layout.js';
import { enumerateBendSeams, previewBendBridge, transactLayout } from './layout-edit.js';
import { assertProtectedLayoutUnchanged } from './edit-locks.js';
import { fitSharedPanels } from './fitted.js';
import { buildPanelSolids } from './solids.js';
import { createStudy, readStudy, captureDesign } from './study.js';
import { resolveSourceLayout } from './design.js';
import { createWorkerHandler } from './worker.js';

function fixture({left=.6,right=.6,curved=false,folded=false,neighbours=false,oblique=false,rotate=false,bentSeam=false,bowedSeam=false,closedSeam=false,multipleSeams=false,hole=false,u=false}={}){
  const xs=[-400,-300,-200,-100,0,100,200,300,400],ys=neighbours?[-600,-300,0,250,500,750,1000,1300]:[0,200,400,600,800,1000];
  const transform=p=>(rotate?[.8*p[0]+.6*p[2]+8500,p[1]-6200,-.6*p[0]+.8*p[2]+2100]:p).map(value=>value===0?0:value);
  const vertices=ys.flatMap(y=>xs.map(x=>transform(folded&&x<0?[-100*Math.sin(-x/80),y,100*(1-Math.cos(-x/80))]:[x+(bowedSeam?20*Math.sin(y*Math.PI/1000):0),y+(oblique?.3*x:0),curved?.0005*x*x:x<0?-x*left:x*right]))),triangles=[],owners=[];
  for(let y=0;y<ys.length-1;y++)for(let x=0;x<xs.length-1;x++){
    if(u&&xs[x]<-200&&ys[y]>0&&ys[y+1]<1000)continue;
    if(hole&&xs[x]===-200&&ys[y]===400)continue;
    const a=y*xs.length+x;
    triangles.push([a,a+1,a+xs.length+1],[a,a+xs.length+1,a+xs.length]);
    const owner=closedSeam?(xs[x]>=-100&&xs[x]<100&&ys[y]===400?1:0):multipleSeams&&ys[y]===400?2:neighbours&&ys[y]<-300?4:neighbours&&ys[y]<0?2:neighbours&&ys[y]>=1000?3:xs[x]<(bentSeam&&ys[y]>=600?100:0)?0:1;
    owners.push(owner,owner);
  }
  const model={vertices,triangles},ids=[...new Set(owners)].sort((a,b)=>a-b),seeds=[],builders=ids.map(id=>{
    const faces=triangles.filter((_,i)=>owners[i]===id),indices=[...new Set(faces.flat())],position=vertices[faces[0][0]];
    seeds.push({id,position,weight:1});
    return{id,seed:position,weight:1,memberSeedIds:[id],positions:indices.map(index=>vertices[index]),triangles:faces.map(face=>face.map(index=>indices.indexOf(index)))};
  });
  const source=rebuildSurfaceCells(model,builders),layout=captureLayout(model,source,{recipe:layoutRecipe({seeds,size:500})});
  return{model,seeds,source,layout,transform};
}
function seam(f){return enumerateBendSeams(f.layout).find(item=>item.cellIds.join(',')==='0,1');}
function bridge(f,widthMm=100,extra={}){return transactLayout(f.model,f.layout,{type:'bridge-bend',edgeId:seam(f).edgeId,widthMm,...extra});}
const distance=(a,b)=>Math.hypot(...a.map((value,i)=>value-b[i]));
function checkCoverage(f,result){
  assert.equal(result.layout.cells.length,f.layout.cells.length+1);
  assert.ok(result.surface.stats.coverageError<1e-10);
  assert.ok(result.surface.cells.every(cell=>cell.sourceComponentCount===1));
  assert.deepEqual(restoreLayout(f.model,JSON.parse(JSON.stringify(result.layout))),result.surface);
  assert.ok(Math.abs(result.surface.stats.totalArea-f.source.stats.totalArea)<1e-5);
  assert.deepEqual(result.change.removedCellIds,[]);
  const strip=result.layout.cells.find(cell=>cell.id===result.change.newCellId);
  const stripBoundary=new Set(strip.loops.flat().map(index=>strip.vertexIds[index]));
  const boundaryPoints=strip.loops.flat().map(index=>strip.positions[index]);
  for(const point of seam(f).points.slice(1,-1))assert.ok(!boundaryPoints.some(candidate=>distance(candidate,point)<1e-5),'the old shared seam is inside the new cell, not one of its boundaries');
  assert.ok(stripBoundary.size>=4);
}

test('whole logical seam selection ignores source tessellation and returns independent data',()=>{
  const f=fixture(),before=structuredClone(f.layout),selected=seam(f);
  assert.ok(selected.edgeIds.length>1);assert.equal(selected.points.length,selected.edgeIds.length+1);
  assert.deepEqual(selected.cellIds,[0,1]);
  selected.points[0][0]=999;selected.cellIds[0]=999;
  assert.deepEqual(f.layout,before);
  const repeated=bridge(f,100,{edgeId:seam(f).edgeIds.at(-1)});
  assert.equal(repeated.change.seamEdgeId,seam(f).edgeId);
});

for(const [left,right] of [[.6,.6],[-.6,-.6],[.2,1.2]])test(`a ${left<0?'convex':'concave'} crease with side slopes ${left}, ${right} receives one balanced source strip`,()=>{
  const f=fixture({left,right}),before=structuredClone(f.layout),result=bridge(f,100,{nextCellId:20});checkCoverage(f,result);
  assert.equal(result.change.newCellId,20);assert.deepEqual(result.change.trimmedCellIds,[0,1]);
  assert.deepEqual(result.layout.cells.map(cell=>cell.id),[0,1,20]);
  const strip=result.surface.cells.find(cell=>cell.id===20);
  assert.ok(Math.abs(strip.area-100000)<1e-5,'each planar side contributes half the width along the shell');
  for(const id of [0,1])assert.ok(Math.abs(f.source.cells.find(cell=>cell.id===id).area-result.surface.cells.find(cell=>cell.id===id).area-50000)<1e-5);
  assert.deepEqual(result.layout.recipe,f.layout.recipe);assert.deepEqual(result.layout.splitOrigins,[{id:20,parentCellId:0,sourceSeedIds:[0,1]}]);
  assert.deepEqual(f.layout,before);
  const fitted=fitSharedPanels(result.surface,{thickness:10}),solids=buildPanelSolids(fitted.cells,{thickness:10,radius:0});
  assert.equal(fitted.cells.find(cell=>cell.id===20).valid,true);
  assert.equal(solids.find(cell=>cell.id===20).valid,true);
});

test('oblique end caps, unequal slopes and world orientation preserve the shell and nominal half-widths',()=>{
  const f=fixture({left:.25,right:1.1,oblique:true,rotate:true}),result=bridge(f);checkCoverage(f,result);
  assert.ok(Math.abs(result.surface.cells.find(cell=>cell.id===result.change.newCellId).area-100000)<1e-4);
  assert.ok(result.surface.cells.filter(cell=>[0,1].includes(cell.id)).every(cell=>cell.area>0));
});

test('a coarse curved source retains its actual triangles and previews the projected-width strip',()=>{
  const f=fixture({curved:true}),before=structuredClone(f.layout),preview=previewBendBridge(f.model,f.layout,{edgeId:seam(f).edgeId,widthMm:100});
  assert.equal(preview.issue,null);assert.ok(preview.positions.length>4);assert.ok(preview.segments.length>4);
  assert.ok(preview.positions.some(p=>p[2]>0)&&preview.positions.some(p=>Math.abs(p[0])<1e-8&&Math.abs(p[2])<1e-8));
  const result=bridge(f);checkCoverage(f,result);
  const strip=result.surface.cells.find(cell=>cell.id===result.change.newCellId);
  assert.deepEqual(preview.positions,strip.positions);assert.deepEqual(preview.triangles,strip.triangles);
  assert.ok(strip.area>100000,'projected width is not misrepresented as an exact curved-surface width');
  assert.deepEqual(f.layout,before);assert.equal(nextLayoutCellId(f.layout),2,'preview reserves no IDs');
});

test('a bowed seam is captured only when the proposed strip contains its whole path',()=>{
  const f=fixture({bowedSeam:true}),result=bridge(f,100);checkCoverage(f,result);
  assert.ok(result.surface.cells.find(cell=>cell.id===result.change.newCellId).area>0);
  assert.throws(()=>bridge(f,20),/curves beyond.*Increase.*straighter/);
});

test('endpoints refine third-party cells without changing their regions or bypassing source locks',()=>{
  const f=fixture({neighbours:true}),before=structuredClone(f.layout),result=bridge(f,100,{nextCellId:12});checkCoverage(f,result);
  assert.deepEqual(result.change.affectedCellIds,[0,1,2,3,12]);
  for(const id of [2,3]){
    const old=f.layout.cells.find(cell=>cell.id===id),next=result.layout.cells.find(cell=>cell.id===id);
    assert.ok(next.positions.length>old.positions.length,'the new strip boundary endpoint is also represented in the neighbouring mesh');
    assert.ok(Math.abs(f.source.cells.find(cell=>cell.id===id).area-result.surface.cells.find(cell=>cell.id===id).area)<1e-6);
  }
  assert.deepEqual(result.layout.cells.find(cell=>cell.id===4),f.layout.cells.find(cell=>cell.id===4));
  assert.equal(assertProtectedLayoutUnchanged(f.layout,result.layout,[2,3,4]),true);
  for(const id of [0,1])assert.throws(()=>assertProtectedLayoutUnchanged(f.layout,result.layout,[id]),/protected panel/);
  assert.deepEqual(f.layout,before);
});

test('unusable widths, missing edges, uncovered seams and disconnected remnants reject atomically',()=>{
  const f=fixture(),before=structuredClone(f.layout);
  for(const [extra,reason] of [[{widthMm:0},/positive.*width/],[{widthMm:Infinity},/positive.*width/],[{widthMm:1e-8},/positive.*width/],
    [{widthMm:2000},/use up.*cell.*Reduce/],[{nextCellId:1},/stale/],[{edgeId:'missing'},/existing shared edge/],
    [{edgeId:f.layout.edges.find(edge=>edge.cells.length===1).id},/existing shared edge/]]){
    const operation={edgeId:seam(f).edgeId,widthMm:100,...extra};
    assert.throws(()=>transactLayout(f.model,f.layout,{...operation,type:'bridge-bend'}),reason);
    assert.match(previewBendBridge(f.model,f.layout,operation).issue,reason);
  }
  assert.deepEqual(f.layout,before);
  const bent=fixture({bentSeam:true});assert.throws(()=>bridge(bent,20),/curves beyond.*straighter shared edge/);
  const shaped=fixture({u:true,left:0,right:0});assert.throws(()=>bridge(shaped,500),/break.*cell into separate pieces/);
  const holed=fixture({hole:true});assert.throws(()=>bridge(holed,600),/strip includes an opening/);
  const folded=fixture({folded:true});assert.throws(()=>bridge(folded),/Panel P001 curves too far.*projected view.*divide\/reshape/);
  for(const option of ['closedSeam','multipleSeams']){
    const unsupported=fixture({[option]:true}),original=structuredClone(unsupported.layout);
    assert.throws(()=>bridge(unsupported),/one open, unbranched seam/);assert.deepEqual(unsupported.layout,original);
  }
});

test('the worker returns the validated strip or one clear rejection without changing its input',()=>{
  const f=fixture({bowedSeam:true}),before=structuredClone(f.layout),responses=[],worker=createWorkerHandler(message=>responses.push(message));
  worker({data:{validationId:1,model:f.model,layout:f.layout,transaction:{type:'bridge-bend',edgeId:seam(f).edgeId,widthMm:100,nextCellId:30}}});
  assert.equal(responses[0].validationId,1);assert.equal(responses[0].error,undefined);assert.equal(responses[0].change.newCellId,30);
  assert.ok(responses[0].surface.cells.some(cell=>cell.id===30));
  worker({data:{validationId:2,model:f.model,layout:f.layout,transaction:{type:'bridge-bend',edgeId:seam(f).edgeId,widthMm:20,nextCellId:30}}});
  assert.equal(responses[1].validationId,2);assert.match(responses[1].error,/curves beyond/);assert.equal(responses[1].layout,undefined);
  assert.deepEqual(f.layout,before);
});

test('adding a bridge honours the independent 500-cell document cap',()=>{
  const vertices=[],triangles=[],builders=[],seeds=[],nx=20,ny=25;
  for(let y=0;y<=ny;y++)for(let x=0;x<=nx;x++)vertices.push([x*100,y*100,0]);
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){
    const id=y*nx+x,a=y*(nx+1)+x,indices=[a,a+1,a+nx+2,a+nx+1],positions=indices.map(index=>vertices[index]),seed=[x*100+50,y*100+50,0];
    triangles.push([indices[0],indices[1],indices[2]],[indices[0],indices[2],indices[3]]);
    seeds.push({id,position:seed,weight:1});builders.push({id,seed,weight:1,memberSeedIds:[id],positions,triangles:[[0,1,2],[0,2,3]]});
  }
  const model={vertices,triangles},surface=rebuildSurfaceCells(model,builders),layout=captureLayout(model,surface,{recipe:layoutRecipe({seeds,size:100})}),before=structuredClone(layout);
  assert.equal(layout.cells.length,500);
  assert.throws(()=>transactLayout(model,layout,{type:'bridge-bend',edgeId:enumerateBendSeams(layout)[0].edgeId,widthMm:20}),/already has 500 cells.*Merge/);
  assert.deepEqual(layout,before);
});

test('the new identity survives save/reopen, further edits, merging and Undo-compatible snapshots',()=>{
  const f=fixture(),result=bridge(f,100,{nextCellId:40});
  const state={rawModel:f.model,name:'Across bend synthetic',seeds:f.seeds,size:500,variation:.3,randomSeed:7,layout:result.layout,directBase:f.layout,nextCellId:100,view:'surface'};
  const saved=createStudy(state,{units:'mm',up:'z'}),reopened=readStudy(JSON.stringify(saved));
  assert.deepEqual(reopened.layout,result.layout);assert.equal(reopened.nextCellId,100);
  assert.equal(resolveSourceLayout(f.model,reopened,{strict:true}).source,'stored');
  assert.equal('nextCellId' in captureDesign(state),false);
  const merged=transactLayout(f.model,result.layout,{type:'merge-cells',cellIds:[0,40]});
  assert.equal(merged.layout.cells.length,2);assert.equal(nextLayoutCellId(merged.layout),41);
  assert.deepEqual(merged.layout.splitOrigins,result.layout.splitOrigins);
  const next=transactLayout(f.model,merged.layout,{type:'bridge-bend',edgeId:enumerateBendSeams(merged.layout)[0].edgeId,widthMm:50,nextCellId:100});
  assert.equal(next.change.newCellId,100);assert.deepEqual(next.layout.splitOrigins.at(-1).sourceSeedIds,[0,1]);
});
