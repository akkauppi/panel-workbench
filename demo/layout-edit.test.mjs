import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCellLayout, generateSeeds, rebuildSurfaceCells } from './geometry.js';
import { captureLayout, restoreLayout, layoutRecipe } from './layout.js';
import { transactLayout, previewCornerMove, layoutCornerCandidates, createCornerSketch } from './layout-edit.js';
import { fitSharedPanels } from './fitted.js';
import { wavyGrid } from './test-fixtures.mjs';

function grid({curved=false,hole=false}={}) {
  const vertices=[],triangles=[];
  for(let y=0;y<=6;y++)for(let x=0;x<=6;x++)vertices.push([x*200,y*200,curved?(x-3)**2*12+(y-3)**2*8:0]);
  for(let y=0;y<6;y++)for(let x=0;x<6;x++) {
    if(hole&&x===2&&y===2)continue;
    const a=y*7+x;triangles.push([a,a+1,a+8],[a,a+8,a+7]);
  }
  return {vertices,triangles};
}
const three=[[250,300,0],[950,300,0],[600,950,0]];
const four=[[250,300,0],[950,250,0],[350,950,0],[1000,1000,0]];
function fixture(points=three,options={}) {
  const model=grid(options),seeds=points.map((position,id)=>({id,position,weight:1}));
  const surface=generateCellLayout(model,seeds,{size:500});
  return {model,seeds,surface,layout:captureLayout(model,surface,{recipe:layoutRecipe({seeds,size:500})})};
}
const distance=(a,b)=>Math.hypot(...a.map((x,k)=>x-b[k]));
function targetWithinFace(model,layout,corner,fraction=.05) {
  const vertex=layout.vertices.find(v=>distance(v.position,corner.position)<1e-5),points=model.triangles[vertex.attachment.triangle].map(i=>model.vertices[i]);
  return corner.position.map((x,k)=>x*(1-fraction)+points.reduce((sum,p)=>sum+p[k],0)/3*fraction);
}
function move(fixture,corner,target,options={}) {return transactLayout(fixture.model,fixture.layout,{type:'move-corner',cornerId:corner.id,target,...options});}

test('direct moves author source geometry, preserve unrelated cells, and keep identity through repeated moves',()=>{
  const f=fixture(four),corner=f.surface.corners.find(c=>!c.boundary),before=structuredClone(f.layout);
  const vertex=f.layout.vertices.find(v=>distance(v.position,corner.position)<1e-5).id;
  const target=corner.position.map((x,k)=>x+[20,10,0][k]),first=move(f,corner,target);
  assert.equal(first.layout.authority,'graph');assert.equal(first.change.survivingCornerId,`vertex:${vertex}`);
  assert.ok(distance(first.surface.corners.find(c=>c.vertexId===vertex).position,target)<1e-5);
  assert.deepEqual(first.surface.cells.find(c=>c.id===2).positions,f.surface.cells.find(c=>c.id===2).positions);
  assert.deepEqual(first.surface.cells.find(c=>c.id===2).triangles,f.surface.cells.find(c=>c.id===2).triangles);
  assert.deepEqual(f.layout,before);
  const reopened=JSON.parse(JSON.stringify(first.layout)),nextTarget=target.map((x,k)=>x+[10,-5,0][k]);
  const second=transactLayout(f.model,reopened,{type:'move-corner',cornerId:first.change.survivingCornerId,target:nextTarget});
  assert.equal(second.change.movedVertexId,vertex);
  assert.ok(distance(second.surface.corners.find(c=>c.vertexId===vertex).position,nextTarget)<1e-5);
  assert.deepEqual(restoreLayout(f.model,second.layout),second.surface);
});

test('no-op is exact and formerly radius-limited valid moves are accepted',()=>{
  const f=fixture(),corner=f.surface.corners.find(c=>!c.boundary);
  const none=move(f,corner,corner.position);
  assert.strictEqual(none.layout,f.layout);
  const moved=move(f,corner,[20,20,0]);
  assert.equal(moved.surface.cells.length,3);assert.ok(moved.surface.stats.coverageError<1e-10);
  assert.ok(distance(moved.surface.corners.find(c=>c.id===moved.change.survivingCornerId).position,[20,20,0])<1e-5);
});

test('boundary slides preserve the perimeter and snap only to eligible connected boundary corners',()=>{
  const f=fixture(),corner=f.surface.corners.find(c=>c.boundary&&c.position[1]===0),target=[corner.position[0]+20,0,0];
  const moved=move(f,corner,target);
  assert.ok(moved.surface.stats.coverageError<1e-10);
  const handle=moved.surface.corners.find(c=>c.id===moved.change.survivingCornerId);
  assert.equal(handle.boundary,true);assert.ok(distance(handle.position,target)<1e-5);
  assert.ok(layoutCornerCandidates(f.layout,corner.id).every(candidate=>f.surface.corners.find(c=>distance(c.position,candidate.position)<1e-5)?.boundary));
  assert.throws(()=>move(f,corner,[target[0],10,0]),/perimeter/);
});

test('snapping contracts a logical seam without forcing cell removal and retires its source edge IDs',()=>{
  const f=fixture(four),corners=f.surface.corners.filter(c=>!c.boundary),[from,to]=corners;
  const preview=previewCornerMove(f.layout,{cornerId:from.id,target:to.position.map((x,k)=>x+[2,1,0][k]),snapDistance:5});
  assert.deepEqual(preview.target,to.position);assert.equal(preview.snapCornerId,to.id);
  const result=move(f,from,preview.target,{allowCellRemoval:false});
  assert.equal(result.surface.cells.length,4);assert.deepEqual(result.change.removedCellIds,[]);assert.ok(result.change.collapsedEdgeIds.length>0);
  assert.equal(result.surface.corners.filter(c=>!c.boundary).length,1);
  assert.ok(result.surface.stats.coverageError<1e-10);
  const ids=new Set(result.layout.edges.map(edge=>edge.id));assert.ok(result.change.collapsedEdgeIds.every(id=>!ids.has(id)));
});

test('a controlled boundary contraction removes a cell and leaves complete source coverage',()=>{
  const f=fixture([[100,100,0],[850,850,0]]),[from,to]=f.surface.corners,before=structuredClone(f.layout);
  assert.throws(()=>move(f,from,to.position,{allowCellRemoval:false}),/removes a cell/);
  assert.deepEqual(f.layout,before);
  const result=move(f,from,to.position,{allowCellRemoval:true});
  assert.deepEqual(result.change.removedCellIds,[0]);assert.deepEqual(result.surface.cells.map(c=>c.id),[1]);
  assert.equal(result.change.survivingCornerId,null);assert.equal(result.surface.corners.length,0);
  assert.ok(Math.abs(result.surface.stats.totalArea-1440000)<1e-6);
  assert.deepEqual(restoreLayout(f.model,JSON.parse(JSON.stringify(result.layout))),result.surface);
});

test('real seam crossings and malformed targets reject atomically',()=>{
  const f=fixture(four),corner=f.surface.corners.find(c=>!c.boundary),before=structuredClone(f.layout);
  assert.throws(()=>move(f,corner,[400,800,0]),/cross or overlap/);
  assert.throws(()=>move(f,corner,[700,1000,0]),/cross or overlap/);
  assert.throws(()=>move(f,corner,[700,500,100]),/connected source/);
  assert.throws(()=>move(f,corner,[NaN,0,0]),/finite/);
  assert.throws(()=>move(f,{id:'missing'},[0,0,0]),/no longer present/);
  assert.deepEqual(f.layout,before);
});

test('curved source clipping preserves exact targets, source openings, and shared fitted joints',()=>{
  for(const options of [{curved:true},{hole:true}]) {
    const f=fixture(three,options),corner=f.surface.corners.find(c=>!c.boundary),target=targetWithinFace(f.model,f.layout,corner);
    const result=move(f,corner,target);
    assert.ok(distance(result.surface.corners.find(c=>c.id===result.change.survivingCornerId).position,target)<1e-5);
    assert.ok(result.surface.stats.coverageError<1e-10);
    const fitted=fitSharedPanels(result.surface),shared=new Map();
    for(const cell of fitted.cells)cell.sharedVertexIds.forEach((id,i)=>{if(shared.has(id))assert.deepEqual(cell.flatPositions[i],shared.get(id));else shared.set(id,cell.flatPositions[i]);});
    if(options.hole)for(const cell of result.surface.cells)for(const tri of cell.triangles){const p=[0,1].map(k=>tri.reduce((sum,id)=>sum+cell.positions[id][k],0)/3);assert.ok(!(p[0]>400&&p[0]<600&&p[1]>400&&p[1]<600));}
  }
});

test('direct merging after a graph move unions authored faces without regenerating seeds',()=>{
  const f=fixture(four),corner=f.surface.corners.find(c=>!c.boundary),moved=move(f,corner,corner.position.map((x,k)=>x+[20,10,0][k]));
  const area=moved.surface.cells.filter(c=>[0,1].includes(c.id)).reduce((sum,c)=>sum+c.area,0);
  const merged=transactLayout(f.model,moved.layout,{type:'merge-cells',cellIds:[0,1]});
  assert.equal(merged.surface.cells.length,3);assert.deepEqual(merged.change.removedCellIds,[1]);
  assert.ok(Math.abs(merged.surface.cells.find(c=>c.id===0).area-area)<1e-6);
  assert.deepEqual(merged.surface.cells.find(c=>c.id===2).positions,moved.surface.cells.find(c=>c.id===2).positions);
  assert.deepEqual(merged.surface.cells.find(c=>c.id===0).memberSeedIds,[0,1]);
  assert.throws(()=>transactLayout(f.model,moved.layout,{type:'merge-cells',cellIds:[1,2]}),/connected|adjacent/);
});

test('moving a corner off a source mesh vertex preserves its logical ID without aliasing the old position',()=>{
  const model=grid(),builders=Array.from({length:4},(_,id)=>({id,seed:[300+(id%2)*600,300+Math.floor(id/2)*600,0],weight:1,memberSeedIds:[id],positions:[],triangles:[],map:new Map()}));
  for(const tri of model.triangles){const p=tri.map(i=>model.vertices[i]),x=p.reduce((s,p)=>s+p[0],0)/3,y=p.reduce((s,p)=>s+p[1],0)/3,b=builders[(x>=600?1:0)+(y>=600?2:0)];b.triangles.push(tri.map(id=>{if(!b.map.has(id)){b.map.set(id,b.positions.length);b.positions.push(model.vertices[id]);}return b.map.get(id);}));}
  const source=rebuildSurfaceCells(model,builders);source.corners=[];
  const layout=captureLayout(model,source),vertex=layout.vertices.find(v=>distance(v.position,[600,600,0])<1e-5);
  layout.corners=[{id:'test-junction',anchor:[600,600,0],position:[600,600,0],owners:[[0],[1],[2],[3]],cells:[0,1,2,3],radius:1000,boundary:false}];
  const result=transactLayout(model,layout,{type:'move-corner',cornerId:'test-junction',target:[620,610,0]});
  assert.equal(result.change.movedVertexId,vertex.id);
  assert.deepEqual(result.layout.vertices.find(v=>v.id===vertex.id).position,[620,610,0]);
  assert.notEqual(result.layout.vertices.find(v=>distance(v.position,[600,600,0])<1e-5)?.id,vertex.id);
  assert.deepEqual(restoreLayout(model,result.layout),result.surface);
});

test('a target canonicalized near a source vertex keeps the moved junction identity and remains editable',()=>{
  const f=fixture(),corner=f.surface.corners.find(c=>!c.boundary);
  const vertex=f.layout.vertices.find(v=>distance(v.position,corner.position)<1e-5).id;
  const target=[600.00002,600.00002,0],result=move(f,corner,target);
  assert.equal(result.change.movedVertexId,vertex);
  assert.equal(result.change.survivingCornerId,`vertex:${vertex}`);
  const handle=result.surface.corners.find(c=>c.vertexId===vertex);
  assert.ok(handle);assert.ok(distance(handle.position,target)<1e-4);
  const next=transactLayout(f.model,result.layout,{type:'move-corner',cornerId:handle.id,target:[620,610,0]});
  assert.equal(next.change.survivingCornerId,handle.id);
  assert.deepEqual(restoreLayout(f.model,next.layout),next.surface);
});

test('a procedural wavy surface supports interior and perimeter transactions',()=>{
  const model=wavyGrid({amplitude:80});
  const seeds=generateSeeds(model,250,.3,1),surface=generateCellLayout(model,seeds,{size:250}),layout=captureLayout(model,surface,{recipe:layoutRecipe({seeds,size:250})});
  const inside=surface.corners.filter(c=>!c.boundary);
  const corners=[inside[0],inside[1],inside[4],surface.corners.find(c=>c.boundary)];
  for(const corner of corners) {
    let target=targetWithinFace(model,layout,corner);
    if(corner.boundary){const i=corner.boundaryPath.findIndex(p=>distance(p,corner.position)<1e-5),next=corner.boundaryPath[(i+1)%(corner.boundaryPath.length-1)];target=corner.position.map((x,k)=>x*.95+next[k]*.05);}
    const result=transactLayout(model,layout,{type:'move-corner',cornerId:corner.id,target});
    assert.ok(distance(result.surface.corners.find(c=>c.id===result.change.survivingCornerId).position,target)<1e-4);
    assert.ok(result.surface.stats.coverageError<1e-9);assert.equal(result.surface.cells.length,surface.cells.length);
  }
});


test('live sketches follow shared seams on the shell without changing the accepted layout', () => {
  for (const options of [{}, {curved:true}, {hole:true}]) {
    const f=fixture(four,options),corner=f.surface.corners.find(c=>!c.boundary);
    const before=structuredClone(f.layout),target=targetWithinFace(f.model,f.layout,corner,.1);
    const preview=createCornerSketch(f.model,f.layout,corner.id)(target);
    assert.equal(preview.issue,null);
    assert.equal(preview.cells.length,corner.cells.length);
    assert.ok(preview.segments.some(p=>distance(p,target)<1e-4));
    const moved=move(f,corner,target);
    for(const cell of preview.cells) {
      let area=0;
      for(let i=0;i<cell.positions.length;i+=3) {
        const [a,b,c]=cell.positions.slice(i,i+3),u=b.map((x,k)=>x-a[k]),v=c.map((x,k)=>x-a[k]);
        area+=Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])/2;
      }
      assert.ok(Math.abs(area-moved.surface.cells.find(c=>c.id===cell.id).area)<1e-4);
    }
    assert.deepEqual(f.layout,before);
  }
});

test('sketches identify a crossing before commit and boundary previews follow the perimeter', () => {
  const f=fixture(four),corner=f.surface.corners.find(c=>!c.boundary);
  const sketch=createCornerSketch(f.model,f.layout,corner.id);
  assert.match(sketch([400,800,0]).issue,/cross|overlap/);
  const boundary=f.surface.corners.find(c=>c.boundary&&c.position[1]===0);
  const target=[boundary.position[0]+20,0,0],preview=createCornerSketch(f.model,f.layout,boundary.id)(target);
  assert.equal(preview.issue,null);
  assert.ok(preview.segments.some(p=>distance(p,target)<1e-5));
});
