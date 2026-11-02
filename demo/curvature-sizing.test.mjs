import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAdaptiveSeeds, generateSeeds, generateCells, generateCellLayout, mergeSurfaceCells } from './geometry.js';
import { CURVATURE_TURN_RADIANS } from './curvature-sizing.js';

const policy = (minSizeMm=60,maxSizeMm=200) => ({type:'curvature',version:1,minSizeMm,maxSizeMm});
function grid(nx,ny,position,{alternate=false,hole=false}={}) {
  const vertices=[],triangles=[];
  for(let y=0;y<=ny;y++) for(let x=0;x<=nx;x++) vertices.push(position(x/nx,y/ny));
  for(let y=0;y<ny;y++) for(let x=0;x<nx;x++) {
    if(hole && x>=nx*.35 && x<nx*.65 && y>=ny*.35 && y<ny*.65) continue;
    const a=y*(nx+1)+x,b=a+1,c=a+nx+1,d=c+1;
    triangles.push(...(alternate && (x+y)%2 ? [[a,b,c],[b,d,c]] : [[a,b,d],[a,d,c]]));
  }
  return {vertices,triangles};
}
const flat = (u,v) => [(u-.5)*600,(v-.5)*600,0];
const cylinder = (u,v) => [300*Math.sin((u-.5)*2),(v-.5)*600,300*(1-Math.cos((u-.5)*2))];
const average = values => Array.from(values).reduce((a,b)=>a+b,0)/values.length;
function targets(result,model) { return model.triangles.map((_,i)=>result.sizing.targetAtTriangle(i)); }
function area(model,triangle) {
  const [a,b,c]=triangle.map(i=>model.vertices[i]), u=b.map((x,k)=>x-a[k]),v=c.map((x,k)=>x-a[k]);
  return Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])*.5;
}

test('flat surface including an opening stays at the largest size',()=>{
  const model=grid(20,20,flat,{hole:true}), result=generateAdaptiveSeeds(model,policy());
  assert.ok(targets(result,model).every(h=>h===200));
  assert.ok(result.seeds.every(s=>Math.abs(s.position[2])<1e-12));
  assert.ok(result.seeds.every(s=>Math.abs(s.position[0])>=90-1e-8 || Math.abs(s.position[1])>=90-1e-8));
  assert.equal(result.sizing.diagnostics.uncertainProbeCount,0);
});

test('cylinder estimates physical curvature independently of refinement and diagonal direction',()=>{
  const values=[];
  for(const [n,alternate,nonuniform] of [[12,false,false],[24,true,false],[48,false,false],[32,true,true]]) {
    const model=grid(n,n,(u,v)=>cylinder(nonuniform?u*u:u,v),{alternate});
    const result=generateAdaptiveSeeds(model,policy());
    const mean=average(targets(result,model)); values.push(mean);
    assert.ok(Math.abs(mean-CURVATURE_TURN_RADIANS*300)<5,`target ${mean} should follow cylinder radius, not triangles`);
    assert.equal(result.sizing.diagnostics.uncertainProbeCount,0);
  }
  assert.ok(Math.max(...values)/Math.min(...values)<1.04);
});

test('saddle curvature does not cancel where principal signs differ',()=>{
  const model=grid(24,24,(u,v)=>{const [x,y]=flat(u,v);return[x,y,(x*x-y*y)/600];});
  const result=generateAdaptiveSeeds(model,policy());
  const nearOrigin=model.triangles.map((t,i)=>({r:Math.hypot(...t.map(id=>model.vertices[id]).reduce((sum,p)=>[sum[0]+p[0]/3,sum[1]+p[1]/3],[0,0])),h:result.sizing.targetAtTriangle(i)})).filter(t=>t.r<80);
  assert.ok(average(nearOrigin.map(t=>t.h))<125);
  assert.ok(result.sizing.diagnostics.minTargetSize>=60 && result.sizing.diagnostics.maxTargetSize<=200);
});

test('sub-millimetre mesh noise does not request tiny cells on a flat sheet',()=>{
  for(const n of [24,48]) {
    const model=grid(n,n,(u,v)=>{const p=flat(u,v);p[2]=.2*Math.sin(u*123)*Math.cos(v*96);return p;});
    const result=generateAdaptiveSeeds(model,policy());
    assert.ok(average(targets(result,model))>195);
    assert.equal(result.seeds.length,12);
  }
});

test('sizing scales with the physical model and is invariant under rigid rotation',()=>{
  const model=grid(20,16,cylinder), original=generateAdaptiveSeeds(model,policy());
  const transformed={vertices:model.vertices.map(([x,y,z])=>[2*z+100,2*x-70,2*y+1000]),triangles:model.triangles};
  const changed=generateAdaptiveSeeds(transformed,policy(120,400));
  assert.equal(changed.seeds.length,original.seeds.length);
  model.triangles.forEach((_,i)=>assert.ok(Math.abs(changed.sizing.targetAtTriangle(i)/2-original.sizing.targetAtTriangle(i))<1e-7));
});

test('adaptive seeds are deterministic, allocate more sites to the bend, and preserve weight semantics',()=>{
  const model=grid(24,24,(u,v)=>u<.5?flat(u,v):[300*Math.sin((u-.5)*2),(v-.5)*600,300*(1-Math.cos((u-.5)*2))]);
  const first=generateAdaptiveSeeds(model,policy(),.35,9), again=generateAdaptiveSeeds(model,policy(),.35,9);
  assert.deepEqual(first.seeds,again.seeds);
  const bent=first.seeds.filter(s=>s.position[0]>0).length, planar=first.seeds.length-bent;
  assert.ok(bent>planar*1.5,`${bent} bent versus ${planar} flat`);
  assert.ok(first.seeds.every(s=>s.weight===1));
  assert.notDeepEqual(first.seeds,generateAdaptiveSeeds(model,policy(),.35,10).seeds);
});

test('nearby disconnected sheets each receive a seed without cross-sheet curvature mixing',()=>{
  const a=grid(12,12,flat), b=grid(2,2,(u,v)=>[u*20,v*20,1]);
  const model={vertices:[...a.vertices,...b.vertices],triangles:[...a.triangles,...b.triangles.map(t=>t.map(id=>id+a.vertices.length))]};
  const result=generateAdaptiveSeeds(model,policy());
  assert.equal(result.sizing.diagnostics.componentCount,2);
  assert.ok(result.seeds.some(s=>Math.abs(s.position[2]-1)<1e-10));
  assert.ok(result.seeds.some(s=>Math.abs(s.position[2])<1e-10));
  assert.ok(targets(result,model).every(h=>h===200));
});

test('abrupt folds remain bounded and spacing changes gradually along the source graph',()=>{
  const model=grid(20,20,(u,v)=>u<.5?[(u-.5)*600,(v-.5)*600,0]:[0,(v-.5)*600,(u-.5)*600]);
  const result=generateAdaptiveSeeds(model,policy());
  assert.ok(targets(result,model).every(h=>Number.isFinite(h)&&h>=60&&h<=200));
  assert.ok(result.sizing.diagnostics.minTargetSize<120);
  assert.equal(result.sizing.diagnostics.componentCount,1);
  generateCells(model,[result.seeds[0]],{distanceField:(position,prepared)=>{
    for(let id=0;id<prepared.graph.length;id++) for(const [next,length] of prepared.graph[id]) {
      assert.ok(Math.abs(result.sizing.vertexSizes[id]-result.sizing.vertexSizes[next])<=.5*length+1e-9);
    }
    return Float64Array.from(prepared.graphPoints,p=>Math.hypot(...p.map((x,k)=>x-position[k])));
  }});
});

test('too many required cells reports the limit instead of silently changing the requested range',()=>{
  const model=grid(5,5,(u,v)=>[u*1000,v*1000,0]);
  assert.throws(()=>generateAdaptiveSeeds(model,policy(10,10)),/requests .*240-cell limit.*Increase/);
  assert.throws(()=>generateAdaptiveSeeds(model,policy(10,1e100)),/range is too wide.*narrower/);
});

test('density is carried once per clipped triangle and conserves the weighted source area',()=>{
  const model=grid(8,8,flat), seeds=generateSeeds(model,200,.3,7), density=i=>.01+(i%7)*.07;
  const result=generateCellLayout(model,seeds,{size:200,triangleDensity:density});
  let weighted=0;
  for(const cell of result.cells) {
    assert.equal(cell.triangleDensities.length,cell.triangles.length);
    cell.triangles.forEach((t,i)=>weighted+=area({vertices:cell.positions},t)*cell.triangleDensities[i]);
  }
  const expected=model.triangles.reduce((sum,t,i)=>sum+area(model,t)*density(i),0);
  assert.ok(Math.abs(weighted-expected)<expected*1e-10);
  const first=result.cells[0], members=[first.id,first.neighbors[0]];
  const merged=mergeSurfaceCells(result,[{id:first.id,members}]);
  const mergedWeighted=merged.cells.reduce((sum,cell)=>sum+cell.triangles.reduce((value,t,i)=>value+area({vertices:cell.positions},t)*cell.triangleDensities[i],0),0);
  assert.ok(Math.abs(mergedWeighted-expected)<expected*1e-10);
  const uniform=generateCells(model,seeds,{size:200});
  assert.ok(uniform.cells.every(c=>!('triangleDensities' in c)));
  assert.throws(()=>generateCells(model,seeds,{triangleDensity:()=>NaN}),/density.*positive and finite/);
});
