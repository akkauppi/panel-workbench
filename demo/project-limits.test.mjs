import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectLimits, hasProjectLimits, measureStockFootprint, evaluateProjectLimits } from './project-limits.js';

const plane = { origin: [0,0,0], normal: [0,0,1], u: [1,0,0], v: [0,1,0] };
function fixture(width = 100, height = 60, spread = 0) {
  const flatPositions = [[0,0,0],[width,0,0],[width,height,0],[0,height,0]];
  const cell = { id: 4, valid: true, plane, flatPositions, loops: [[0,1,2,3]], maxDeviation: 3 };
  const corners = [[-spread,-spread],[width+spread,-spread],[width+spread,height+spread],[-spread,height+spread]];
  const solid = { id: 4, valid: true, plane, positions: [-20,20].flatMap(z => corners.map(([x,y]) => [x,y,z])) };
  return { cells: [cell], solids: [solid] };
}

test('project limits retain explicit millimetres and reject partial or invalid stock dimensions', () => {
  assert.deepEqual(readProjectLimits(), { stockWidthMm:null,stockHeightMm:null,minEdgeMm:null,maxDeviationMm:null });
  assert.equal(hasProjectLimits(), false); assert.equal(hasProjectLimits({maxDeviationMm:0}), true);
  assert.deepEqual(readProjectLimits({stockWidthMm:1220,stockHeightMm:2440,minEdgeMm:20,maxDeviationMm:5,privateNote:'drop'}), {stockWidthMm:1220,stockHeightMm:2440,minEdgeMm:20,maxDeviationMm:5});
  for (const input of [{stockWidthMm:100}, {stockHeightMm:100}, {stockWidthMm:0,stockHeightMm:100}, {minEdgeMm:-1}, {maxDeviationMm:Infinity}, {maxDeviationMm:'2'}, [], 'bad']) assert.throws(() => readProjectLimits(input), /stock|millimetres|limit/i);
});

test('sheet fitting permits rotation beyond a minimum-area rectangle and either orientation', () => {
  const points = [[0,0],[150,0],[150,20],[0,20]];
  const diagonal = measureStockFootprint(points,125,125);
  assert.equal(diagonal.fitsStock,true);
  assert.ok(diagonal.widthMm<=125&&diagonal.heightMm<=125);
  assert.equal(diagonal.minimumRectangleWidthMm,150);
  assert.equal(diagonal.minimumRectangleHeightMm,20);
  const rotate = angle => points.map(([x,y]) => [x*Math.cos(angle)-y*Math.sin(angle),x*Math.sin(angle)+y*Math.cos(angle)]);
  for (const angle of [.03,.31,.72,1.19,2.3]) {
    assert.equal(measureStockFootprint(rotate(angle),20,150).fitsStock,true,`90-degree stock orientation at rotation ${angle}`);
    assert.equal(measureStockFootprint(rotate(angle),125,125).fitsStock,true);
    assert.equal(measureStockFootprint(rotate(angle),110,110).fitsStock,false);
  }
  assert.equal(measureStockFootprint([[0,0],[100,0],[100,100],[0,100]],99,99).fitsStock,false);
});

test('full-part mitre footprint drives the stock warning rather than the nominal cutting outline', () => {
  const result = fixture(100,60,10), before = structuredClone(result);
  const review = evaluateProjectLimits(result,{stockWidthMm:110,stockHeightMm:80});
  assert.deepEqual(review.warningPanelIds,[4]);
  const panel = review.panels[0];
  assert.equal(panel.measurements.footprint,'full-part');
  assert.equal(panel.measurements.fitsStock,false);
  assert.equal(panel.warnings[0].code,'stock-size');
  assert.match(panel.warnings[0].message,/does not fit.*any in-plane rotation/);
  assert.deepEqual(result,before,'review must not change geometry or validity');
});

test('edge and shell-distance preferences give separate actionable warnings and include intentional offsets', () => {
  const result = fixture(100,10); result.cells[0].offsetMm=3;
  const review = evaluateProjectLimits(result,{minEdgeMm:12,maxDeviationMm:2});
  assert.deepEqual(review.panels[0].warnings.map(warning=>warning.code),['short-edge','shell-deviation']);
  assert.equal(review.panels[0].measurements.shortestEdgeMm,10);
  assert.equal(review.panels[0].measurements.sourceDeviationMm,3);
  assert.match(review.panels[0].warnings[1].message,/Intentional panel offsets count/);
  assert.equal(review.warningCount,2); assert.equal(result.cells[0].valid,true);
  assert.equal(evaluateProjectLimits(result,{minEdgeMm:10,maxDeviationMm:3}).warningCount,0);
});

test('missing or invalid solids do not claim a completed physical stock check', () => {
  const result=fixture(); result.solids=[];
  const review=evaluateProjectLimits(result,{stockWidthMm:120,stockHeightMm:80});
  assert.equal(review.panels[0].measurements.footprint,'outline-only');
  assert.equal(review.panels[0].measurements.fitsStock,null,'an outline-only fit cannot imply a checked physical part');
  assert.deepEqual(review.panels[0].warnings.map(warning=>warning.code),['stock-unchecked']);
  result.solids=[{...fixture().solids[0],valid:false}];
  assert.equal(evaluateProjectLimits(result,{stockWidthMm:120,stockHeightMm:80}).panels[0].measurements.footprint,'solid-candidate');
  assert.equal(evaluateProjectLimits(result,{stockWidthMm:120,stockHeightMm:80}).panels[0].measurements.fitsStock,null);
  result.solids=fixture().solids;result.cells[0].valid=false;
  assert.equal(evaluateProjectLimits(result,{stockWidthMm:120,stockHeightMm:80}).panels[0].measurements.fitsStock,null,'the fitted outline must also be resolved');
  assert.equal(evaluateProjectLimits(result,{stockWidthMm:120,stockHeightMm:80}).panels[0].warnings[0].code,'stock-unchecked');
  assert.equal(evaluateProjectLimits(result,{}).warningCount,0,'unconfigured preferences should add no warnings');
});

test('stock measurement follows the part frame in 3D and handles holes and repeated vertices', () => {
  const result=fixture(100,60), transform=([x,y,z])=>[z+90,x-20,y+300];
  for(const object of [...result.cells,...result.solids]) {
    object.plane={origin:transform([0,0,0]),normal:[1,0,0],u:[0,1,0],v:[0,0,1]};
    if(object.flatPositions)object.flatPositions=object.flatPositions.map(transform);
    if(object.positions)object.positions=object.positions.map(transform);
  }
  const review=evaluateProjectLimits(result,{stockWidthMm:100,stockHeightMm:60});
  assert.equal(review.warningCount,0);
  assert.equal(review.panels[0].measurements.fitsStock,true);
  const footprint=measureStockFootprint([[0,0],[100,0],[100,60],[0,60],[0,0],[50,30],[10,10]],100,60);
  assert.equal(footprint.fitsStock,true);
  assert.equal(measureStockFootprint([[0,0],[1,0],[2,0]]),null);
});
