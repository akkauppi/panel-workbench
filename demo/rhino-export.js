const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const add = (a, b) => a.map((x, i) => x + b[i]);
const scale = (a, s) => a.map(x => x * s);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = a => { const n = Math.hypot(...a); if (!(n > 1e-10)) throw new Error('A panel has no usable local frame.'); return scale(a, 1/n); };
const bounds = points => {
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const p of points) for(let k=0;k<3;k++) {min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k]);}
  return {min,max};
};
const point = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

// Trace an exported artifact to an authored project without copying its name,
// private paths, source data or mutable project object into the Rhino document.
function exportProvenance(options, kind) {
  const entries = [['panel-workbench-export', kind]];
  if (options.project !== undefined) {
    const project = options.project;
    if (!project || typeof project !== 'object' || Array.isArray(project) ||
      typeof project.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(project.id) ||
      !Number.isSafeInteger(project.revision) || project.revision < 1) {
      throw new Error('Rhino export needs a valid project ID and positive revision.');
    }
    entries.push(['panel-workbench-project-id', project.id], ['panel-workbench-project-revision', String(project.revision)]);
  }
  if (options.build !== undefined) {
    if (typeof options.build !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._:+()@-]{0,255}$/.test(options.build)) {
      throw new Error('Rhino export needs a bounded build identifier without paths or control characters.');
    }
    entries.push(['panel-workbench-build', options.build]);
  }
  return {
    document(doc) { for (const [key, value] of entries) doc.strings().set(key, value); },
    tag(object) { for (const [key, value] of entries) object.setUserString(key, value); return object; },
  };
}

/** One physical part per definition. Placement changes are rigid transforms;
 * thickness, mitres and the actual selected carving geometry are preserved. */
export function buildProductionLayout(cells, solids, options = {}) {
  if (!cells?.length || !solids?.length) throw new Error('Calculate valid solid panels before exporting Rhino blocks.');
  const spacing = Number(options.spacing ?? 60), rowWidth = Number(options.rowWidth ?? 2440), up = options.up ?? 'y';
  if (!(spacing > 0 && rowWidth > 0) || !Number.isFinite(spacing + rowWidth) || !['y','z'].includes(up)) throw new Error('Invalid Rhino layout dimensions or vertical axis.');
  const toRhino = p => up === 'z' ? [...p] : [p[0], -p[2], p[1]];
  const byId = new Map(solids.map(s => [s.id, s]));
  if (new Set(cells.map(c => c.id)).size !== cells.length) throw new Error('Panel IDs must be unique.');
  const parts = cells.map(cell => {
    const solid = byId.get(cell.id), name = `P${String(cell.id + 1).padStart(3, '0')}`;
    if (!Number.isInteger(cell.id) || cell.id < 0 || !cell.valid || !solid?.valid || !solid.positions?.length || !solid.triangles?.length) throw new Error(`${name} needs resolved flat and solid geometry before Rhino export.`);
    if (!solid.positions.every(point) || !cell.flatPositions?.every(point)) throw new Error(`${name} contains invalid coordinates.`);
    const plane = solid.plane || cell.plane;
    if (![plane.origin,plane.u,plane.normal].every(point)) throw new Error(`${name} has an invalid frame.`);
    const n = unit(plane.normal), u = unit(sub(plane.u, scale(n, dot(n,plane.u)))), v = unit(cross(n,u));
    const local = p => { const d = sub(p, plane.origin); return [dot(d,u),dot(d,v),dot(d,n)]; };
    const localPositions = solid.positions.map(local), low = localPositions.reduce((min,p)=>Math.min(min,p[2]),Infinity);
    const origin = toRhino(add(plane.origin,scale(n,low))), ru=toRhino(u), rv=toRhino(v), rn=toRhino(n);
    const positions = localPositions.map(p => [p[0],p[1],p[2]-low]);
    const loops = cell.loops.map(loop => {
      if (loop.length < 3 || loop.some(i => !Number.isInteger(i) || !cell.flatPositions[i])) throw new Error(`${name} has an invalid outline.`);
      return loop.map(i => { const p=local(cell.flatPositions[i]); return [p[0],p[1],0]; });
    });
    const triangles = solid.triangles.map(t => {
      if(t.length !== 3 || t.some(i => !Number.isInteger(i) || i < 0 || i >= positions.length)) throw new Error(`${name} has an invalid mesh face.`);
      return [...t];
    });
    return { id:cell.id, name, positions, triangles, loops, bounds:bounds([...positions,...loops.flat()]),
      assembly:[ru[0],rv[0],rn[0],origin[0], ru[1],rv[1],rn[1],origin[1], ru[2],rv[2],rn[2],origin[2], 0,0,0,1] };
  });
  const assemblyBounds = bounds(solids.filter(s => byId.has(s.id) && cells.some(c => c.id===s.id)).flatMap(s => s.positions.map(toRhino)));
  const startX = assemblyBounds.max[0] + spacing, startY = assemblyBounds.min[1];
  let x=0,y=0,rowHeight=0;
  for(const part of parts) {
    const {min,max}=part.bounds, width=max[0]-min[0],height=max[1]-min[1];
    if(x>0 && x+width>rowWidth) {x=0;y+=rowHeight+spacing;rowHeight=0;}
    part.flat=[1,0,0,startX+x-min[0], 0,1,0,startY+y-min[1], 0,0,1,0, 0,0,0,1];
    x+=width+spacing;rowHeight=Math.max(rowHeight,height);
  }
  return { parts, units:'mm', assemblyBounds, spacing, rowWidth };
}

export function exportProduction3DM(cells, solids, rhino, options = {}) {
  const provenance = exportProvenance(options, 'production');
  const layout = buildProductionLayout(cells, solids, options), doc = new rhino.File3dm();
  const disposable = [];
  const own = object => { disposable.push(object); return object; };
  try {
    provenance.document(doc);
    doc.settings().modelUnitSystem = rhino.UnitSystem.Millimeters;
    doc.settings().modelAbsoluteTolerance = 0.01;
    const layer = name => { const value=own(new rhino.Layer());value.name=name;return doc.layers().add(value); };
    const layers = { assembly:layer('Assembly'), flat:layer('Flat layout'), part:layer('Part geometry'), outline:layer('Cutting outlines') };
    const attrs = (name, layerIndex) => {const a=own(new rhino.ObjectAttributes());a.name=name;a.layerIndex=layerIndex;return provenance.tag(a);};
    for(const part of layout.parts) {
      const mesh=own(new rhino.Mesh());mesh.vertices().useDoublePrecisionVertices=true;
      part.positions.forEach(p=>mesh.vertices().addPoint3d(...p));
      part.triangles.forEach(t=>mesh.faces().addTriFace(...t));
      mesh.normals().computeNormals();
      provenance.tag(mesh);
      const meshAttrs=attrs(`${part.name} full part`,layers.part);
      meshAttrs.setUserString('panel-workbench-carved',String(!!options.carved));
      const geometry=[mesh],attributes=[meshAttrs];
      part.loops.forEach((loop,index)=>{
        const curve=own(new rhino.PolylineCurve([...loop,loop[0]]));
        provenance.tag(curve);
        const a=attrs(`${part.name} ${index ? `opening ${index}` : 'outer outline'}`,layers.outline);
        a.setUserString('purpose','Nominal fitted-panel boundary projected to the bed plane; not a compensated cutter path or bevel envelope.');
        geometry.push(curve);attributes.push(a);
      });
      const index=doc.instanceDefinitions().add(part.name,'Full panel and nominal outlines. Shared by assembly and flat placement.','','',[0,0,0],geometry,attributes);
      if(index < 0) throw new Error(`Could not create block ${part.name}.`);
      const definition=own(doc.instanceDefinitions().get(index));provenance.tag(definition);
      for(const placement of ['assembly','flat']) {
        const matrix=own(new rhino.Transform(1));
        part[placement].forEach((value,i)=>{matrix[`m${Math.floor(i/4)}${i%4}`]=value;});
        const instance=own(new rhino.InstanceReference(definition.id,matrix)),a=attrs(part.name,layers[placement]);
        provenance.tag(instance);
        a.setUserString('panel-workbench-placement',placement);
        a.setUserString('panel-workbench-panel',part.name);
        if(!doc.objects().add(instance,a)) throw new Error(`Could not place block ${part.name}.`);
      }
    }
    // These entities need no newer features; retain Rhino 6 compatibility.
    const writeOptions=own(new rhino.File3dmWriteOptions());writeOptions.version=6;
    const bytes=doc.toByteArrayOptions(writeOptions);
    if(!bytes?.length) throw new Error('Rhino file serialization failed.');
    return bytes;
  } finally { for(const object of disposable.reverse()) object.delete();doc.delete(); }
}

function repairMeshProblem(mesh) {
  if (!mesh?.positions?.length || !mesh?.triangles?.length) return 'No triangle mesh was produced.';
  if (!mesh.positions.every(point)) return 'The candidate mesh contains non-finite coordinates.';
  if (!mesh.triangles.every(t => Array.isArray(t) && t.length === 3 && new Set(t).size === 3 && t.every(i => Number.isInteger(i) && i >= 0 && i < mesh.positions.length))) return 'The candidate mesh contains invalid triangle indices.';
  if (!mesh.triangles.some(t => {
    const [a,b,c]=t.map(i=>mesh.positions[i]);return Math.hypot(...cross(sub(b,a),sub(c,a))) > 1e-12;
  })) return 'The candidate mesh has no non-degenerate triangle.';
  return null;
}

function repairFrame(mesh, candidates) {
  for (const plane of candidates) {
    if (![plane?.origin,plane?.u,plane?.normal].every(point)) continue;
    try {
      const n=unit(plane.normal),u=unit(sub(plane.u,scale(n,dot(n,plane.u))));
      return {origin:[...plane.origin],n,u,v:unit(cross(n,u))};
    } catch { /* A failed fitted plane may be unusable; use a source triangle. */ }
  }
  for(const triangle of mesh.triangles) {
    const [a,b,c]=triangle.map(i=>mesh.positions[i]);
    try { const u=unit(sub(b,a)),n=unit(cross(sub(b,a),sub(c,a)));return {origin:[...a],u,n,v:unit(cross(n,u))}; }
    catch { /* Find a non-degenerate source triangle. */ }
  }
  throw new Error('The repair mesh has no usable inspection frame.');
}

const issueList = value => Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];

/** Explicit diagnostic export. All panels remain represented, but a repair
 * mesh may be curved, open or zero-thickness. Inspection copies stay rigid. */
export function buildRepairLayout(cells, solids, sourceCells, options = {}) {
  if (!Array.isArray(cells) || !cells.length) throw new Error('There are no panels to export for Rhino repair.');
  const spacing=Number(options.spacing ?? 60),rowWidth=Number(options.rowWidth ?? 2440),up=options.up ?? 'y';
  if (!(spacing > 0 && rowWidth > 0) || !Number.isFinite(spacing+rowWidth) || !['y','z'].includes(up)) throw new Error('Invalid Rhino repair layout dimensions or vertical axis.');
  if (cells.some(c=>!Number.isInteger(c.id)||c.id<0) || new Set(cells.map(c=>c.id)).size!==cells.length) throw new Error('Repair panel IDs must be unique nonnegative integers.');
  const byId = (values,label) => {
    const map=new Map();
    for(const value of values || []) {if(map.has(value.id))throw new Error(`Duplicate ${label} panel ID ${value.id}.`);map.set(value.id,value);}
    return map;
  };
  const solidById=byId(solids,'solid'),sourceById=byId(sourceCells,'source');
  const toRhino=p=>up==='z'?[...p]:[p[0],-p[2],p[1]];
  const parts=cells.map(cell=>{
    const name=`P${String(cell.id+1).padStart(3,'0')}`,solid=solidById.get(cell.id),source=sourceById.get(cell.id);
    const flatIssues=issueList(cell.issues),solidIssues=issueList(solid?.issues),notes=[];
    if (!cell.valid && !flatIssues.length) flatIssues.push('The fitted panel is unresolved.');
    if (!solid?.valid && !solidIssues.length) solidIssues.push(solid?'The solid panel is unresolved.':'No solid result is available.');
    const candidateProblem=repairMeshProblem(solid);
    let mesh=solid,representation=cell.valid&&solid?.valid?'full-part':'solid-candidate';
    if (candidateProblem) {
      const sourceProblem=repairMeshProblem(source);
      if(sourceProblem)throw new Error(`${name} cannot be included in the repair file: ${candidateProblem} Source patch: ${sourceProblem} No panel was silently omitted.`);
      mesh=source;representation='source-patch';
      notes.push(`${candidateProblem} The original source patch is included without invented thickness or carving.`);
    }
    const status=cell.valid&&solid?.valid&&!candidateProblem?'resolved':'unresolved';
    if(status==='unresolved')notes.push('Inspection geometry only; repair and verify this panel in Rhino before fabrication.');
    const loops=[];
    if (!Array.isArray(cell.loops) || !cell.loops.length) notes.push('No fitted candidate outline is available.');
    else cell.loops.forEach((loop,index)=>{
      if(!Array.isArray(loop)||loop.length<3||!loop.every(i=>Number.isInteger(i)&&i>=0&&point(cell.flatPositions?.[i]))) {
        notes.push(`Fitted candidate outline ${index+1} has unusable coordinates or indices and is not included.`);return;
      }
      const ring=loop.map(i=>[...cell.flatPositions[i]]);
      if(new Set(ring.map(p=>p.join(','))).size<3) {notes.push(`Fitted candidate outline ${index+1} is collapsed and is not included.`);return;}
      loops.push({points:ring,index});
    });
    const frame=repairFrame(mesh,[solid?.plane,cell.plane,source?.plane]);
    const local=p=>{const d=sub(p,frame.origin);return [dot(d,frame.u),dot(d,frame.v),dot(d,frame.n)];};
    const localMesh=mesh.positions.map(local),localLoops=loops.map(loop=>({...loop,points:loop.points.map(local)}));
    const allLocal=[...localMesh,...localLoops.flatMap(loop=>loop.points)],low=allLocal.reduce((min,p)=>Math.min(min,p[2]),Infinity);
    const origin=toRhino(add(frame.origin,scale(frame.n,low))),u=toRhino(frame.u),v=toRhino(frame.v),n=toRhino(frame.n);
    const positions=localMesh.map(p=>[p[0],p[1],p[2]-low]);
    const outlines=localLoops.map(loop=>({...loop,points:loop.points.map(p=>[p[0],p[1],p[2]-low])}));
    const worldPoints=[...mesh.positions,...loops.flatMap(loop=>loop.points)].map(toRhino);
    return {id:cell.id,name,status,representation,flatIssues,solidIssues,notes,
      carved:representation!=='source-patch'&&!!solid?.carved,
      positions,triangles:mesh.triangles.map(t=>[...t]),outlines,
      bounds:bounds([...positions,...outlines.flatMap(loop=>loop.points)]),worldBounds:bounds(worldPoints),
      assembly:[u[0],v[0],n[0],origin[0],u[1],v[1],n[1],origin[1],u[2],v[2],n[2],origin[2],0,0,0,1]};
  });
  const assemblyBounds=bounds(parts.flatMap(p=>[p.worldBounds.min,p.worldBounds.max]));
  const startX=assemblyBounds.max[0]+spacing,startY=assemblyBounds.min[1];
  let x=0,y=0,rowHeight=0;
  for(const part of parts) {
    const {min,max}=part.bounds,width=max[0]-min[0],height=max[1]-min[1];
    if(x>0&&x+width>rowWidth){x=0;y+=rowHeight+spacing;rowHeight=0;}
    part.repairLayout=[1,0,0,startX+x-min[0],0,1,0,startY+y-min[1],0,0,1,0,0,0,0,1];
    x+=width+spacing;rowHeight=Math.max(rowHeight,height);
  }
  return {parts,units:'mm',assemblyBounds,spacing,rowWidth};
}

export function exportRepair3DM(cells, solids, sourceCells, rhino, options = {}) {
  const provenance=exportProvenance(options,'repair');
  const layout=buildRepairLayout(cells,solids,sourceCells,options),doc=new rhino.File3dm(),disposable=[];
  const own=value=>{disposable.push(value);return value;};
  const tag=(target,part)=>{
    provenance.tag(target);
    target.setUserString('panel-workbench-export','repair');
    target.setUserString('panel-workbench-panel',part.name);
    target.setUserString('panel-workbench-status',part.status);
    target.setUserString('panel-workbench-representation',part.representation);
    target.setUserString('panel-workbench-flat-issues',JSON.stringify(part.flatIssues));
    target.setUserString('panel-workbench-solid-issues',JSON.stringify(part.solidIssues));
    target.setUserString('panel-workbench-repair-notes',JSON.stringify(part.notes));
    target.setUserString('panel-workbench-carved',String(part.carved));
    target.setUserString('panel-workbench-carving-requested',String(!!options.carved));
    return target;
  };
  try {
    provenance.document(doc);
    doc.settings().modelUnitSystem=rhino.UnitSystem.Millimeters;doc.settings().modelAbsoluteTolerance=0.01;
    const layer=(name,color)=>{const value=own(new rhino.Layer());value.name=name;if(color)value.color=color;return doc.layers().add(value);};
    const layers={assembly:layer('Assembly'),inspection:layer('Repair layout'),resolved:layer('Resolved parts'),
      unresolved:layer('Unresolved parts',{r:219,g:127,b:40,a:255}),outline:layer('Repair outlines',{r:183,g:86,b:42,a:255})};
    const attrs=(name,index,part)=>{const a=own(new rhino.ObjectAttributes());a.name=name;a.layerIndex=index;return tag(a,part);};
    for(const part of layout.parts) {
      const mesh=own(new rhino.Mesh());mesh.vertices().useDoublePrecisionVertices=true;
      part.positions.forEach(p=>mesh.vertices().addPoint3d(...p));part.triangles.forEach(t=>mesh.faces().addTriFace(...t));mesh.normals().computeNormals();
      tag(mesh,part);
      const geometry=[mesh],attributes=[attrs(`${part.name} ${part.representation}`,layers[part.status],part)];
      for(const outline of part.outlines) {
        const points=outline.points,closed=points[0].every((v,i)=>v===points.at(-1)[i])?points:[...points,points[0]];
        const curve=own(new rhino.PolylineCurve(closed));tag(curve,part);
        const a=attrs(`${part.name} fitted candidate outline ${outline.index+1}`,layers.outline,part);
        a.setUserString('purpose','Fitted candidate in its original 3D position. It may cross, fold or be non-planar; not a cutting outline.');
        geometry.push(curve);attributes.push(a);
      }
      const description=`REPAIR: ${part.status}; ${part.representation}. ${[...part.flatIssues,...part.solidIssues,...part.notes].join(' ')}`;
      const index=doc.instanceDefinitions().add(part.name,description,'','',[0,0,0],geometry,attributes);
      if(index<0)throw new Error(`Could not create repair block ${part.name}.`);
      const definition=own(doc.instanceDefinitions().get(index));tag(definition,part);
      for(const [placement,transform,layerIndex] of [['assembly',part.assembly,layers.assembly],['repair-layout',part.repairLayout,layers.inspection]]) {
        const matrix=own(new rhino.Transform(1));transform.forEach((value,i)=>{matrix[`m${Math.floor(i/4)}${i%4}`]=value;});
        const instance=own(new rhino.InstanceReference(definition.id,matrix));tag(instance,part);
        const a=attrs(part.name,layerIndex,part);a.setUserString('panel-workbench-placement',placement);
        if(!doc.objects().add(instance,a))throw new Error(`Could not place repair block ${part.name}.`);
      }
    }
    const writeOptions=own(new rhino.File3dmWriteOptions());writeOptions.version=6;
    const bytes=doc.toByteArrayOptions(writeOptions);if(!bytes?.length)throw new Error('Rhino repair file serialization failed.');return bytes;
  } finally {for(const object of disposable.reverse())object.delete();doc.delete();}
}
