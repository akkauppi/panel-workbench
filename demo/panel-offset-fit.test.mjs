import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCellLayout, generateSeeds, rebuildSurfaceCells } from './geometry.js';
import { fitSharedPanels } from './fitted.js';
import { buildPanelSolids } from './solids.js';
import { createWorkerHandler } from './worker.js';
import { createExample } from './examples.js';
import { wavyGrid } from './test-fixtures.mjs';

const dot = (a,b) => a.reduce((sum,x,i)=>sum+x*b[i],0);
const distance = (a,b) => Math.hypot(...a.map((x,i)=>x-b[i]));
const options = {iterations:700,thickness:40};
function sheet() {
  const vertices=[],triangles=[],cells=[];
  for(let y=0;y<=3;y++)for(let x=0;x<=3;x++)vertices.push([x*300,y*300,0]);
  for(let y=0;y<3;y++)for(let x=0;x<3;x++) {
    const i=y*4+x, ids=[i,i+1,i+5,i+4]; triangles.push([i,i+1,i+5],[i,i+5,i+4]);
    cells.push({id:cells.length,seed:[(x+.5)*300,(y+.5)*300,0],positions:ids.map(i=>vertices[i]),triangles:[[0,1,2],[0,2,3]]});
  }
  return rebuildSurfaceCells({vertices,triangles},cells);
}
function sharedAndFlat(fitted) {
  const points=new Map(); let shared=0;
  for(const cell of fitted.cells) for(let i=0;i<cell.sharedVertexIds.length;i++) {
    const id=cell.sharedVertexIds[i], point=cell.flatPositions[i];
    if(points.has(id)) {assert.deepEqual(point,points.get(id));shared++;} else points.set(id,point);
    if(cell.valid) assert.ok(Math.abs(dot(cell.plane.normal,point)-cell.plane.d)<=.25);
  }
  assert.ok(shared>0);
}
function assertedOffset(fitted,id,value) {
  const cell=fitted.cells.find(c=>c.id===id), reference=cell.offsetReference;
  assert.equal(cell.offsetMm,value);
  assert.deepEqual(cell.plane.normal,reference.normal);
  assert.ok(Math.abs(cell.plane.d-dot(reference.normal,reference.origin)-value)<1e-8);
  return cell;
}

test('positive and negative offsets keep the authored plane exact, shared corners joined and neighbours planar',()=>{
  const source=sheet(), unchanged=JSON.stringify(source), baseline=fitSharedPanels(source,options);
  for(const offsetMm of [10,-10,.1]) {
    const fitted=fitSharedPanels(source,{...options,panelOffsets:[{id:4,offsetMm}]});
    const cell=assertedOffset(fitted,4,offsetMm);
    assert.equal(fitted.stats.invalidCellCount,0);
    sharedAndFlat(fitted);
    assert.ok(buildPanelSolids(fitted.cells,{thickness:40,radius:2}).every(s=>s.valid));
    assert.deepEqual(cell.offsetReference.origin,baseline.cells[4].plane.origin);
    assert.ok(fitted.cells.some((c,i)=>c.id!==4 && distance(c.plane.normal,baseline.cells[i].plane.normal)>1e-5),'neighbours can tilt');
  }
  assert.equal(JSON.stringify(source),unchanged);
});

test('offsets are absolute and reset exactly restores the unoffset calculation',()=>{
  const source=sheet(), baseline=fitSharedPanels(source,options);
  const once=fitSharedPanels(source,{...options,panelOffsets:[{id:4,offsetMm:10}]});
  const twice=fitSharedPanels(once,{...options,panelOffsets:[{id:4,offsetMm:10}],previousResult:once});
  assert.deepEqual(twice.sharedVertices,once.sharedVertices);
  const reset=fitSharedPanels(once,{...options,panelOffsets:[]});
  assert.deepEqual(reset.sharedVertices,baseline.sharedVertices);
  assert.deepEqual(reset.cells.map(c=>c.plane),baseline.cells.map(c=>c.plane));
  assert.ok(reset.cells.every(c=>c.offsetMm===0));
});

test('conflicting adjacent parallel authored planes are not averaged into an exportable panel',()=>{
  const fitted=fitSharedPanels(sheet(),{...options,panelOffsets:[{id:4,offsetMm:10},{id:5,offsetMm:10.1}]});
  for(const [id,value] of [[4,10],[5,10.1]]) {
    const cell=assertedOffset(fitted,id,value);
    assert.equal(cell.valid,false);
    assert.ok(cell.offsetIssueCodes.includes('offset-junction'));
    assert.ok(cell.issues.some(issue=>/Reduce or reset nearby offsets/.test(issue)));
  }
  assert.equal(fitted.offsetFeedback,undefined,'incompatible requests cannot trigger rigid fallback');
  assert.ok(buildPanelSolids(fitted.cells,{thickness:40,radius:2}).some(s=>!s.valid));
  sharedAndFlat(fitted);
});

test('a large unresolved offset stays finite and bounded, retaining the requested distance for correction',()=>{
  const source=sheet(), fitted=fitSharedPanels(source,{...options,panelOffsets:[{id:4,offsetMm:1000}]});
  assert.ok(fitted.stats.invalidCellCount>0);
  assertedOffset(fitted,4,1000);
  assert.ok(fitted.cells.some(c=>c.offsetIssueCodes?.includes('offset-distance')));
  assert.ok(fitted.sharedVertices.every(p=>p.every(Number.isFinite)));
  assert.ok(fitted.stats.maxReferenceDisplacement<=225+1e-5);
  assert.equal(fitted.offsetFeedback,undefined);
  sharedAndFlat(fitted);
  const reset=fitSharedPanels(source,{...options,panelOffsets:[]});
  assert.equal(reset.stats.invalidCellCount,0);
});

test('bounded candidates also hold when the relaxation budget is zero',()=>{
  const fitted=fitSharedPanels(sheet(),{iterations:0,panelOffsets:[{id:4,offsetMm:10000}]});
  assert.ok(fitted.stats.maxReferenceDisplacement<=225+1e-5);
  assert.ok(fitted.stats.invalidCellCount>0);
});

test('curved local offsets resolve both directions without translating the whole shell',()=>{
  const model=wavyGrid({amplitude:180}), source=generateCellLayout(model,generateSeeds(model,250,.3,1),{size:250});
  const original=JSON.stringify(source);
  for(const offsetMm of [10,-10,40]) {
    const fitted=fitSharedPanels(source,{...options,panelOffsets:[{id:4,offsetMm}]});
    assertedOffset(fitted,4,offsetMm);
    assert.equal(fitted.stats.invalidCellCount,0);
    assert.ok(buildPanelSolids(fitted.cells,{thickness:40,radius:2}).every(s=>s.valid));
    assert.equal(fitted.offsetFeedback,undefined);
    sharedAndFlat(fitted);
  }
  assert.equal(JSON.stringify(source),original);
});

test('a coplanar component fallback is explicit and validated, never used across a curved shell',()=>{
  const model=wavyGrid({amplitude:0}), source=generateCellLayout(model,generateSeeds(model,250,.3,1),{size:250});
  const fitted=fitSharedPanels(source,{...options,panelOffsets:[{id:4,offsetMm:.1}]});
  assert.equal(fitted.stats.invalidCellCount,0);
  assert.equal(fitted.stats.offsetCoupledPanelIds.length,source.cells.length);
  assert.match(fitted.offsetFeedback[0],/panels on the same flat surface together.*Undo/);
  assert.ok(fitted.sharedVertices.every(point=>Math.abs(point[2]-.1)<1e-8));
  assert.ok(buildPanelSolids(fitted.cells,{thickness:40,radius:2}).every(s=>s.valid));
  assertedOffset(fitted,4,.1);
});

test('offsets beside a planar opening keep every corner on the trim plane and stock within its support',()=>{
  const model=createExample('dome'), source=generateCellLayout(model,generateSeeds(model,624,.3,7),{size:624});
  const baseline=fitSharedPanels(source,options), cell=baseline.cells.find(c=>c.boundaryPlanes.some(Boolean));
  assert.ok(cell);
  for(const offsetMm of [10,-10]) {
    const fitted=fitSharedPanels(source,{...options,panelOffsets:[{id:cell.id,offsetMm}]});
    assert.equal(fitted.stats.invalidCellCount,0);
    assertedOffset(fitted,cell.id,offsetMm);
    assert.ok(fitted.stats.maxBoundaryDisplacement <= fitted.stats.boundaryDisplacementLimit + 1e-5);
    for(const panel of fitted.cells) for(let i=0;i<panel.flatPositions.length;i++) {
      const point=panel.flatPositions[i], rim=panel.boundaryPlanes[i];
      if(rim) assert.ok(Math.abs(dot(rim.normal,point)-rim.d)<1e-7);
      for(const support of panel.supportPlanes) assert.ok((dot(support.normal,point)-support.d)*support.support>=-1e-7);
    }
    assert.ok(buildPanelSolids(fitted.cells,{thickness:40,radius:2}).every(s=>s.valid));
  }
});

test('worker carries authored offsets through fitting, stock generation and diagnostics',()=>{
  const model=wavyGrid({amplitude:180}), seeds=generateSeeds(model,250,.3,1);
  let response;
  createWorkerHandler(message=>{response=message;})({data:{id:7,model,seeds,size:250,thickness:40,panelOffsets:[{id:4,offsetMm:10}]}});
  assert.equal(response.id,7);
  assert.equal(response.error,undefined);
  assertedOffset(response.result,4,10);
  assert.equal(response.result.stats.invalidCellCount,0);
  assert.ok(response.result.solids.every(s=>s.valid));
});

test('an offset does not deform a nearby disconnected sheet',()=>{
  const first=sheet(), a=first.cells[4];
  const positions=a.positions.map(p=>[p[0],p[1],p[2]+20]);
  const source=rebuildSurfaceCells({vertices:[...a.positions,...positions],triangles:[...a.triangles,...a.triangles.map(t=>t.map(i=>i+a.positions.length))]},[
    {id:0,seed:a.seed,positions:a.positions,triangles:a.triangles},
    {id:1,seed:a.seed.map((x,i)=>x+(i===2?20:0)),positions,triangles:a.triangles},
  ]);
  const base=fitSharedPanels(source,options), fitted=fitSharedPanels(source,{...options,panelOffsets:[{id:0,offsetMm:10}]});
  assert.deepEqual(fitted.cells[1].flatPositions,base.cells[1].flatPositions);
  assert.deepEqual(fitted.cells[1].plane,base.cells[1].plane);
  assert.equal(fitted.stats.invalidCellCount,0);
});

test('reset clears broad-propagation feedback from a previously fitted result',()=>{
  const model=wavyGrid({amplitude:0}), source=generateCellLayout(model,generateSeeds(model,250,.3,1),{size:250});
  const fitted=fitSharedPanels(source,{...options,panelOffsets:[{id:4,offsetMm:.1}]});
  assert.ok(fitted.offsetFeedback);
  const reset=fitSharedPanels(fitted,options);
  assert.equal(reset.offsetFeedback,undefined);
  assert.equal(reset.stats.offsetPanelCount,undefined);
  assert.equal(reset.stats.offsetCoupledPanelIds,undefined);
});
