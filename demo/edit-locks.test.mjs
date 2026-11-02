import test from 'node:test';
import assert from 'node:assert/strict';
import { readProtectedCellIds, changedProtectedCellIds, assertProtectedLayoutUnchanged, protectedCellsTouchedByCorner } from './edit-locks.js';
import { generateCellLayout } from './geometry.js';
import { captureLayout, layoutRecipe } from './layout.js';
import { transactLayout } from './layout-edit.js';

function fixture() {
  const model={vertices:[[0,0,0],[1200,0,0],[1200,1200,0],[0,1200,0]],triangles:[[0,1,2],[0,2,3]]};
  const seeds=[[250,300,0],[950,250,0],[350,950,0],[1000,1000,0]].map((position,id)=>({id,position,weight:1}));
  const settings={seeds,size:500,mergeGroups:[],cornerEdits:[]};
  const surface=generateCellLayout(model,seeds,settings),layout=captureLayout(model,surface,{recipe:layoutRecipe(settings)});
  return {model,layout};
}

test('protected IDs are canonical, validated and independent of the caller',()=>{
  const ids=[3,1], cells=[{id:1},{id:3}];
  assert.deepEqual(readProtectedCellIds(ids,cells),[1,3]);assert.deepEqual(ids,[3,1]);
  assert.deepEqual(readProtectedCellIds(),[]);
  for(const input of [[1,1],[-1],[1.1],['1'],{},[2]])assert.throws(()=>readProtectedCellIds(input,cells),/panel/i);
});

test('a shared-corner move cannot alter a protected neighbour indirectly',()=>{
  const {model,layout}=fixture(),corner=layout.corners.find(corner=>!corner.boundary),protectedId=corner.cells[0];
  const moved=transactLayout(model,layout,{type:'move-corner',cornerId:corner.id,target:corner.position.map((value,axis)=>value+[10,5,0][axis])});
  assert.deepEqual(protectedCellsTouchedByCorner(layout,corner.id,[protectedId]),[protectedId]);
  assert.deepEqual(changedProtectedCellIds(layout,moved.layout,[protectedId]),[protectedId]);
  assert.throws(()=>assertProtectedLayoutUnchanged(layout,moved.layout,[protectedId]),/protected panel P00\d.*Unlock.*shared/s);
  assert.equal(assertProtectedLayoutUnchanged(layout,moved.layout,[]),true);
});

test('source moves outside a protected panel remain available',()=>{
  const {model,layout}=fixture();
  const corner=layout.corners.find(corner=>!corner.boundary&&corner.cells.length===3);
  const protectedId=layout.cells.find(cell=>!corner.cells.includes(cell.id)).id;
  const moved=transactLayout(model,layout,{type:'move-corner',cornerId:corner.id,target:corner.position.map((value,axis)=>value+[5,3,0][axis])});
  assert.equal(assertProtectedLayoutUnchanged(layout,moved.layout,[protectedId]),true);
});

test('splitting, merging, removal and source replacement cannot silently discard protection',()=>{
  const {model,layout}=fixture(),id=0;
  const merged=transactLayout(model,layout,{type:'merge-cells',cellIds:[0,1]});
  assert.throws(()=>assertProtectedLayoutUnchanged(layout,merged.layout,[id]),/protected panel P001/);
  assert.throws(()=>assertProtectedLayoutUnchanged(layout,{...layout,cells:layout.cells.filter(cell=>cell.id!==id)},[id]),/protected panel P001/);
  const sourceChanged=structuredClone(layout);sourceChanged.source.signature='0000000000000000';
  assert.deepEqual(changedProtectedCellIds(layout,sourceChanged,[0,1]),[0,1]);
  const split=transactLayout(model,layout,{type:'split-cell',cellId:0,start:[100,-50,0],end:[100,1250,0],nextCellId:4});
  assert.throws(()=>assertProtectedLayoutUnchanged(layout,split.layout,[id]),/protected panel P001/);
});

test('harmless loop ordering and interior triangulation do not trigger a false lock conflict',()=>{
  const {layout}=fixture(),copy=structuredClone(layout);
  for(const cell of copy.cells){cell.loops=cell.loops.map(ring=>[...ring.slice(1),ring[0]].reverse());cell.triangles.reverse();cell.memberSeedIds.reverse();}
  assert.equal(assertProtectedLayoutUnchanged(layout,copy,[0,1,2,3]),true);
  const before=JSON.stringify(layout);changedProtectedCellIds(layout,copy,[0]);assert.equal(JSON.stringify(layout),before);
});
