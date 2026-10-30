import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRhino } from './rhino-runtime.js';
import { buildProductionLayout, exportProduction3DM, buildRepairLayout, exportRepair3DM } from './rhino-export.js';
import { buildPanelSolids } from './solids.js';
import { buildCarvedPanels } from './carving.js';

const rhino = await loadRhino();
const close = (a, b, label, tolerance = 1e-7) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} != ${b}`);
const closePoint = (a, b, label, tolerance) => a.forEach((x, i) => close(x, b[i], `${label} axis ${i}`, tolerance));
const apply = (m, p) => [0, 1, 2].map(r => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);
const matrix = t => Array.from({ length: 16 }, (_, i) => t[`m${Math.floor(i / 4)}${i % 4}`]);
const box = points => ({ min: [0, 1, 2].map(i => Math.min(...points.map(p => p[i]))), max: [0, 1, 2].map(i => Math.max(...points.map(p => p[i]))) });
const toRhino = (p, up) => up === 'y' ? [p[0], -p[2], p[1]] : p;
function cell(id, points, loops = [points.map((_, i) => i)], plane = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] }) {
  const local = p => [plane.u, plane.v].map(axis => axis.reduce((sum, x, i) => sum + x * (p[i] - plane.origin[i]), 0));
  return { id, flatPositions: points, loops, plane, outline2d: loops.map(ring => ring.map(i => local(points[i]))), valid: true };
}
function folded() {
  const angle = Math.PI / 3, c = Math.cos(angle), s = Math.sin(angle);
  const cells = [
    cell(3, [[-100, 0, 0], [0, 0, 0], [0, 100, 0], [-100, 100, 0]]),
    cell(17, [[0, 0, 0], [100 * c, 0, 100 * s], [100 * c, 100, 100 * s], [0, 100, 0]], undefined,
      { origin: [0, 0, 0], u: [c, 0, s], v: [0, 1, 0], normal: [-s, 0, c] }),
  ];
  const solids = buildPanelSolids(cells, { thickness: 20, radius: 2 });
  solids.forEach(solid => assert.equal(solid.valid, true, solid.issues.join('; ')));
  return { cells, solids };
}
function references(file) {
  const objects = [];
  for (let i = 0; i < file.objects().count; i++) {
    const object = file.objects().get(i), geometry = object.geometry();
    if (geometry.objectType === rhino.ObjectType.InstanceReference) objects.push({ geometry, attributes: object.attributes() });
  }
  return objects;
}
function definitionGeometry(file, definition) {
  return definition.getObjectIds().map(id => file.objects().findId(id)).map(object => ({ geometry: object.geometry(), attributes: object.attributes() }));
}

test('production layout uses rigid transforms and retains complete stock geometry, spacing, and stable panel names', () => {
  const { cells, solids } = folded();
  const before = structuredClone({ cells, solids });
  for (const up of ['z', 'y']) {
    const layout = buildProductionLayout(cells, solids, { up, spacing: 60, rowWidth: 145 });
    assert.equal(layout.units, 'mm');
    assert.deepEqual(layout.parts.map(part => part.name), ['P004', 'P018']);
    const assembly = box(solids.flatMap(solid => solid.positions.map(p => toRhino(p, up))));
    const flatBoxes = [];
    for (let i = 0; i < layout.parts.length; i++) {
      const part = layout.parts[i], solid = solids[i];
      assert.deepEqual(part.triangles, solid.triangles);
      assert.equal(part.positions.length, solid.positions.length);
      part.positions.forEach((p, index) => closePoint(apply(part.assembly, p), toRhino(solid.positions[index], up), 'assembled part'));
      const flat = box(part.positions.map(p => apply(part.flat, p)));
      close(flat.min[2], 0, 'flat stock rests at z=0');
      assert.ok(flat.max[2] - flat.min[2] > 19.9, 'laying flat retains thickness');
      assert.ok(flat.min[0] >= assembly.max[0] + 60 - 1e-6, 'layout sits beside the entire assembly');
      flatBoxes.push(flat);
      for (const ring of part.loops) for (const p of ring) close(p[2], 0, 'cutting outlines use local XY');
    }
    const [a, b] = flatBoxes;
    const separation = Math.max(b.min[0] - a.max[0], a.min[0] - b.max[0], b.min[1] - a.max[1], a.min[1] - b.max[1]);
    assert.ok(separation >= 60 - 1e-6, 'spacing accounts for mitred solid footprint, not only nominal outlines');
  }
  assert.deepEqual({ cells, solids }, before, 'export planning never mutates the workbench geometry');
});

test('native 3dm has one definition and two named references per part with shared geometry and millimetre units', () => {
  const { cells, solids } = folded();
  const planned = buildProductionLayout(cells, solids, { up: 'y' });
  const bytes = exportProduction3DM(cells, solids, rhino, { up: 'y', name: 'Linked panels' });
  assert.ok(bytes instanceof Uint8Array && bytes.length > 1000);
  const file = rhino.File3dm.fromByteArray(bytes);
  try {
    assert.equal(file.archiveVersion, 60, 'production geometry and shared blocks are written for Rhino 6');
    assert.equal(file.settings().modelUnitSystem, rhino.UnitSystem.Millimeters);
    assert.equal(file.instanceDefinitions().count, cells.length);
    const refs = references(file);
    assert.equal(refs.length, cells.length * 2);
    for (let i = 0; i < cells.length; i++) {
      const definition = file.instanceDefinitions().get(i), part = planned.parts[i];
      assert.equal(definition.name, part.name);
      const pair = refs.filter(ref => ref.geometry.parentIdefId === definition.id);
      assert.equal(pair.length, 2, 'both placements share the same native block definition ID');
      assert.ok(pair.every(ref => ref.attributes.name === part.name), 'both placements retain the panel name');
      assert.deepEqual(pair.map(ref => ref.attributes.getUserString('panel-workbench-placement')).sort(), ['assembly', 'flat']);
      const members = definitionGeometry(file, definition);
      const meshes = members.filter(member => member.geometry.objectType === rhino.ObjectType.Mesh);
      const curves = members.filter(member => member.geometry.objectType === rhino.ObjectType.Curve);
      assert.equal(meshes.length, 1); assert.equal(curves.length, cells[i].loops.length);
      const mesh = meshes[0].geometry;
      assert.equal(mesh.vertices().count, solids[i].positions.length);
      assert.equal(mesh.faces().count, solids[i].triangles.length);
      const assembly = pair.find(ref => ref.attributes.getUserString('panel-workbench-placement') === 'assembly');
      for (let vertex = 0; vertex < mesh.vertices().count; vertex++) {
        closePoint(apply(matrix(assembly.geometry.xform), mesh.vertices().point3dAt(vertex)), toRhino(solids[i].positions[vertex], 'y'), 'native assembled vertex', 1e-4);
      }
      for (const curve of curves) {
        assert.equal(curve.geometry.isClosed, true);
        for (let point = 0; point < curve.geometry.pointCount; point++) close(curve.geometry.point(point)[2], 0, 'native planar outline');
      }
      assert.equal(file.layers().get(meshes[0].attributes.layerIndex).name, 'Part geometry');
      assert.ok(curves.every(curve => file.layers().get(curve.attributes.layerIndex).name === 'Cutting outlines'));
    }
    assert.deepEqual(new Set(refs.map(ref => file.layers().get(ref.attributes.layerIndex).name)), new Set(['Assembly', 'Flat layout']));
  } finally { file.delete(); }
});

function repairFixture() {
  const {cells,solids}=folded();
  const failedCell=cell(42,[[200,0,3],[300,100,7],[200,100,-2],[300,0,9]]);
  failedCell.valid=false;failedCell.issues=['Fitted outline crosses itself.','Panel exceeds planarity tolerance.'];
  const source={id:42,positions:[[200,0,0],[300,0,8],[300,100,16],[200,100,3],[250,50,30]],triangles:[[0,1,4],[1,2,4],[2,3,4],[3,0,4]]};
  return {cells:[cells[0],{...cells[1],issues:[]},failedCell],
    solids:[solids[0],{...solids[1],valid:false,carved:true,issues:['Carved mesh exceeds available stock.']},
      {id:42,valid:false,positions:[],triangles:[],issues:['Could not build solid from crossing outline.']}],sourceCells:[source]};
}

test('repair layout preserves every panel and its original candidate or source geometry with rigid inspection placements',()=>{
  const input=repairFixture(),before=structuredClone(input);
  for(const up of ['y','z']) {
    const layout=buildRepairLayout(input.cells,input.solids,input.sourceCells,{up,spacing:37,rowWidth:110});
    assert.deepEqual(layout.parts.map(p=>p.name),['P004','P018','P043']);
    assert.deepEqual(layout.parts.map(p=>p.status),['resolved','unresolved','unresolved']);
    assert.deepEqual(layout.parts.map(p=>p.representation),['full-part','solid-candidate','source-patch']);
    const originals=[input.solids[0],input.solids[1],input.sourceCells[0]];
    layout.parts.forEach((part,i)=>{
      assert.deepEqual(part.triangles,originals[i].triangles);
      part.positions.forEach((p,j)=>closePoint(apply(part.assembly,p),toRhino(originals[i].positions[j],up),'repair preserves assembled geometry',1e-9));
      const inspection=box([...part.positions,...part.outlines.flatMap(outline=>outline.points)].map(p=>apply(part.repairLayout,p)));
      close(inspection.min[2],0,'inspection geometry is rigidly placed above bed');
      assert.ok(inspection.min[0]>=layout.assemblyBounds.max[0]+37-1e-7);
    });
    const fallback=layout.parts[2];
    assert.ok(fallback.bounds.max[2]>20,'curved source patch remains curved in inspection layout');
    fallback.outlines[0].points.forEach((p,j)=>closePoint(apply(fallback.assembly,p),toRhino(input.cells[2].flatPositions[j],up),'invalid candidate curve retains 3D coordinates',1e-9));
    assert.deepEqual(fallback.flatIssues,input.cells[2].issues);
    assert.deepEqual(fallback.solidIssues,input.solids[2].issues);
    assert.ok(fallback.notes.some(note=>/without invented thickness or carving/.test(note)));
  }
  assert.deepEqual(input,before,'repair export cannot alter the active model');
  assert.throws(()=>exportProduction3DM(input.cells,input.solids,rhino),/resolved/,'production remains strict');
});

test('Rhino 6 repair file roundtrips all definitions, shared references, diagnostics, original meshes and crossing candidate curves',()=>{
  const input=repairFixture(),planned=buildRepairLayout(input.cells,input.solids,input.sourceCells,{up:'y'});
  const file=rhino.File3dm.fromByteArray(exportRepair3DM(input.cells,input.solids,input.sourceCells,rhino,{up:'y',carved:true}));
  try {
    assert.equal(file.archiveVersion,60);assert.equal(file.settings().modelUnitSystem,rhino.UnitSystem.Millimeters);
    assert.equal(file.instanceDefinitions().count,3);
    const refs=references(file);assert.equal(refs.length,6);
    for(let i=0;i<3;i++) {
      const definition=file.instanceDefinitions().get(i),part=planned.parts[i];
      assert.equal(definition.name,part.name);
      assert.equal(definition.getUserString('panel-workbench-status'),part.status);
      assert.equal(definition.getUserString('panel-workbench-representation'),part.representation);
      assert.deepEqual(JSON.parse(definition.getUserString('panel-workbench-flat-issues')),part.flatIssues);
      assert.deepEqual(JSON.parse(definition.getUserString('panel-workbench-solid-issues')),part.solidIssues);
      const pair=refs.filter(ref=>ref.geometry.parentIdefId===definition.id);
      assert.deepEqual(pair.map(ref=>ref.attributes.getUserString('panel-workbench-placement')).sort(),['assembly','repair-layout']);
      for(const ref of pair) {
        assert.equal(ref.attributes.name,part.name);
        assert.equal(ref.attributes.getUserString('panel-workbench-export'),'repair');
        assert.equal(ref.attributes.getUserString('panel-workbench-status'),part.status);
      }
      const members=definitionGeometry(file,definition);
      for(const member of members) {
        for(const target of [member.geometry,member.attributes]) {
          assert.equal(target.getUserString('panel-workbench-representation'),part.representation);
          assert.deepEqual(JSON.parse(target.getUserString('panel-workbench-solid-issues')),part.solidIssues);
          assert.deepEqual(JSON.parse(target.getUserString('panel-workbench-flat-issues')),part.flatIssues);
        }
      }
      const mesh=members.find(member=>member.geometry.objectType===rhino.ObjectType.Mesh);
      assert.equal(file.layers().get(mesh.attributes.layerIndex).name,part.status==='resolved'?'Resolved parts':'Unresolved parts');
      const instance=pair.find(ref=>ref.attributes.getUserString('panel-workbench-placement')==='assembly');
      const original=i===2?input.sourceCells[0]:input.solids[i];
      assert.equal(mesh.geometry.faces().count,original.triangles.length);
      for(let j=0;j<mesh.geometry.vertices().count;j++)closePoint(apply(matrix(instance.geometry.xform),mesh.geometry.vertices().point3dAt(j)),toRhino(original.positions[j],'y'),'native repair vertex',1e-9);
      if(i===2) {
        const curve=members.find(member=>member.geometry.objectType===rhino.ObjectType.Curve);
        assert.equal(curve.geometry.isClosed,true);
        assert.match(curve.attributes.getUserString('purpose'),/may cross/);
        assert.equal(mesh.attributes.getUserString('panel-workbench-carved'),'false','source fallback is not labelled as carved');
        assert.equal(mesh.attributes.getUserString('panel-workbench-carving-requested'),'true');
        for(let j=0;j<4;j++)closePoint(apply(matrix(instance.geometry.xform),curve.geometry.point(j)),toRhino(input.cells[2].flatPositions[j],'y'),'native candidate curve',1e-9);
      }
    }
  } finally {file.delete();}
});

test('repair can derive a frame from a source triangle and reports unusable outline loops without dropping the panel',()=>{
  const source={id:9,positions:[[10,20,30],[20,20,32],[20,30,36]],triangles:[[0,1,2]]};
  const cells=[{id:9,valid:false,issues:['No fitted plane.'],plane:{origin:[NaN,0,0]},flatPositions:[[NaN,0,0]],loops:[[0,1,2]]}];
  const layout=buildRepairLayout(cells,[],[source],{up:'z'});
  assert.equal(layout.parts.length,1);assert.equal(layout.parts[0].outlines.length,0);
  assert.ok(layout.parts[0].notes.some(note=>/outline 1/.test(note)));
  layout.parts[0].positions.forEach((p,i)=>closePoint(apply(layout.parts[0].assembly,p),source.positions[i],'derived source frame',1e-9));
  const file=rhino.File3dm.fromByteArray(exportRepair3DM(cells,[],[source],rhino));
  assert.equal(file.instanceDefinitions().count,1);file.delete();
});

test('repair never silently drops missing or malformed panels and diagnoses a malformed candidate before source fallback',()=>{
  const input=repairFixture();
  assert.throws(()=>buildRepairLayout(input.cells,input.solids,[]),/P043.*No panel was silently omitted/);
  assert.throws(()=>buildRepairLayout(input.cells,input.solids,[{...input.sourceCells[0],triangles:[[0,1,99]]}]),/Source patch.*invalid triangle/);
  assert.throws(()=>buildRepairLayout([...input.cells,input.cells[0]],input.solids,input.sourceCells),/unique/);
  assert.throws(()=>buildRepairLayout(input.cells,input.solids,input.sourceCells,{up:'x'}),/vertical axis/);
  const source={id:3,positions:[[0,0,0],[1,0,0],[0,1,0]],triangles:[[0,1,2]]};
  const malformed={...input.solids[0],positions:[[NaN,0,0]],triangles:[[0,0,0]]};
  const layout=buildRepairLayout([input.cells[0]],[malformed],[source]);
  assert.equal(layout.parts[0].representation,'source-patch');
  assert.equal(layout.parts[0].status,'unresolved');
  assert.ok(layout.parts[0].notes.some(note=>/non-finite/.test(note)));
});

test('closed cutting curves preserve inner openings in the shared panel definition', () => {
  const points = [[0, 0, 0], [200, 0, 0], [200, 200, 0], [0, 200, 0], [50, 50, 0], [50, 150, 0], [150, 150, 0], [150, 50, 0]];
  const cells = [cell(0, points, [[0, 1, 2, 3], [4, 5, 6, 7]])];
  const solids = buildPanelSolids(cells, { thickness: 20, radius: 0 });
  assert.equal(solids[0].valid, true);
  const file = rhino.File3dm.fromByteArray(exportProduction3DM(cells, solids, rhino, { up: 'z' }));
  try {
    const curves = definitionGeometry(file, file.instanceDefinitions().get(0)).filter(member => member.geometry.objectType === rhino.ObjectType.Curve);
    assert.equal(curves.length, 2, 'the hole must remain a separate cutting curve');
    assert.ok(curves.every(curve => curve.geometry.isClosed));
    const areas = curves.map(({ geometry: curve }) => {
      const p = Array.from({ length: curve.pointCount }, (_, i) => curve.point(i));
      return Math.abs(p.slice(1).reduce((sum, q, i) => sum + p[i][0] * q[1] - p[i][1] * q[0], 0) / 2);
    }).sort((a, b) => a - b);
    close(areas[0], 10000, 'inner opening area'); close(areas[1], 40000, 'outer outline area');
  } finally { file.delete(); }
});

test('production export preserves exactly whichever carved or uncarved geometry is supplied', () => {
  const cells = [cell(0, [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]])];
  const solids = buildPanelSolids(cells, { thickness: 60, radius: 0 });
  const vertices = [], triangles = [];
  for (let y = 0; y <= 8; y++) for (let x = 0; x <= 8; x++) {
    const u = x * 25 - 50, v = y * 25 - 50; vertices.push([u, v, -5 + (u - 50) ** 2 / 500]);
  }
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const a = y * 9 + x; triangles.push([a, a + 1, a + 10], [a, a + 10, a + 9]); }
  const carved = buildCarvedPanels(solids, cells, { vertices, triangles }, { minimumThickness: 12 });
  assert.equal(carved[0].valid, true, carved[0].issues.join('; '));
  assert.notDeepEqual(carved[0].positions, solids[0].positions);
  for (const [geometry, enabled] of [[solids, false], [carved, true]]) {
    const file = rhino.File3dm.fromByteArray(exportProduction3DM(cells, geometry, rhino, { up: 'z', carved: enabled }));
    try {
      const definition = file.instanceDefinitions().get(0);
      const mesh = definitionGeometry(file, definition).find(member => member.geometry.objectType === rhino.ObjectType.Mesh).geometry;
      const assembly = references(file).find(ref => ref.attributes.getUserString('panel-workbench-placement') === 'assembly');
      assert.equal(mesh.vertices().count, geometry[0].positions.length);
      assert.equal(mesh.faces().count, geometry[0].triangles.length);
      for (let i = 0; i < mesh.vertices().count; i++) closePoint(apply(matrix(assembly.geometry.xform), mesh.vertices().point3dAt(i)), geometry[0].positions[i], 'selected part geometry', 1e-4);
    } finally { file.delete(); }
  }
});

test('unresolved or incomplete part sets cannot produce a production file', () => {
  const { cells, solids } = folded();
  assert.throws(() => exportProduction3DM(cells, [{ ...solids[0], valid: false }, solids[1]], rhino), /valid|resolve|panel|part/i);
  assert.throws(() => exportProduction3DM([{ ...cells[0], valid: false }, cells[1]], solids, rhino), /valid|resolve|panel|part/i);
  assert.throws(() => exportProduction3DM(cells, solids.slice(0, 1), rhino), /missing|match|panel|part|solid/i);
  assert.throws(() => exportProduction3DM([], [], rhino), /panel|part|empty|export/i);
  assert.throws(() => buildProductionLayout(cells, solids, { spacing: -1 }), /spacing|layout|dimension/i);
});

test('editing shared definition geometry survives serialization and is reached through both placements', () => {
  const { cells, solids } = folded();
  const file = rhino.File3dm.fromByteArray(exportProduction3DM(cells, solids, rhino, { up: 'z' }));
  let reopened;
  try {
    const definition = file.instanceDefinitions().get(0);
    const meshId = definition.getObjectIds().find(id => file.objects().findId(id).geometry().objectType === rhino.ObjectType.Mesh);
    const mesh = file.objects().findId(meshId).geometry();
    const old = mesh.vertices().point3dAt(0), replacement = old.map((value, i) => value + [2, -3, .75][i]);
    assert.equal(mesh.vertices().setPoint3dAt(0, replacement), true);
    reopened = rhino.File3dm.fromByteArray(file.toByteArray());
    const pair = references(reopened).filter(ref => ref.geometry.parentIdefId === definition.id);
    assert.equal(pair.length, 2);
    for (const ref of pair) {
      const shared = reopened.instanceDefinitions().findId(ref.geometry.parentIdefId);
      const updated = definitionGeometry(reopened, shared).find(member => member.geometry.objectType === rhino.ObjectType.Mesh).geometry;
      closePoint(updated.vertices().point3dAt(0), replacement, 'updated shared local vertex');
      const delta = apply(matrix(ref.geometry.xform), replacement).map((value, i) => value - apply(matrix(ref.geometry.xform), old)[i]);
      close(Math.hypot(...delta), Math.hypot(2, -3, .75), 'both placements receive the definition edit');
    }
  } finally { reopened?.delete(); file.delete(); }
});

test('native full-part vertices retain double precision rather than passing through single-precision mesh coordinates', () => {
  const width = 1234.56789123;
  const cells = [cell(0, [[0, 0, 0], [width, 0, 0], [width, 100, 0], [0, 100, 0]])];
  const solids = buildPanelSolids(cells, { thickness: 21.23456789, radius: 0 });
  const file = rhino.File3dm.fromByteArray(exportProduction3DM(cells, solids, rhino, { up: 'z' }));
  try {
    const definition = file.instanceDefinitions().get(0);
    const mesh = definitionGeometry(file, definition).find(member => member.geometry.objectType === rhino.ObjectType.Mesh).geometry;
    const assembly = references(file).find(ref => ref.attributes.getUserString('panel-workbench-placement') === 'assembly');
    for (let i = 0; i < mesh.vertices().count; i++) closePoint(apply(matrix(assembly.geometry.xform), mesh.vertices().point3dAt(i)), solids[0].positions[i], 'double-precision part vertex', 1e-9);
  } finally { file.delete(); }
});
