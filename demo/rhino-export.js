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
  const layout = buildProductionLayout(cells, solids, options), doc = new rhino.File3dm();
  const disposable = [];
  const own = object => { disposable.push(object); return object; };
  try {
    doc.settings().modelUnitSystem = rhino.UnitSystem.Millimeters;
    doc.settings().modelAbsoluteTolerance = 0.01;
    const layer = name => { const value=own(new rhino.Layer());value.name=name;return doc.layers().add(value); };
    const layers = { assembly:layer('Assembly'), flat:layer('Flat layout'), part:layer('Part geometry'), outline:layer('Cutting outlines') };
    const attrs = (name, layerIndex) => {const a=own(new rhino.ObjectAttributes());a.name=name;a.layerIndex=layerIndex;return a;};
    for(const part of layout.parts) {
      const mesh=own(new rhino.Mesh());mesh.vertices().useDoublePrecisionVertices=true;
      part.positions.forEach(p=>mesh.vertices().addPoint3d(...p));
      part.triangles.forEach(t=>mesh.faces().addTriFace(...t));
      mesh.normals().computeNormals();
      const meshAttrs=attrs(`${part.name} full part`,layers.part);
      meshAttrs.setUserString('panel-workbench-carved',String(!!options.carved));
      const geometry=[mesh],attributes=[meshAttrs];
      part.loops.forEach((loop,index)=>{
        const curve=own(new rhino.PolylineCurve([...loop,loop[0]]));
        const a=attrs(`${part.name} ${index ? `opening ${index}` : 'outer outline'}`,layers.outline);
        a.setUserString('purpose','Nominal fitted-panel boundary projected to the bed plane; not a compensated cutter path or bevel envelope.');
        geometry.push(curve);attributes.push(a);
      });
      const index=doc.instanceDefinitions().add(part.name,'Full panel and nominal outlines. Shared by assembly and flat placement.','','',[0,0,0],geometry,attributes);
      if(index < 0) throw new Error(`Could not create block ${part.name}.`);
      const definition=doc.instanceDefinitions().get(index);
      for(const placement of ['assembly','flat']) {
        const matrix=own(new rhino.Transform(1));
        part[placement].forEach((value,i)=>{matrix[`m${Math.floor(i/4)}${i%4}`]=value;});
        const instance=own(new rhino.InstanceReference(definition.id,matrix)),a=attrs(part.name,layers[placement]);
        a.setUserString('panel-workbench-placement',placement);
        a.setUserString('panel-workbench-panel',part.name);
        if(!doc.objects().add(instance,a)) throw new Error(`Could not place block ${part.name}.`);
      }
    }
    // These entities need no Rhino 8-only features; retain Rhino 7 compatibility.
    const writeOptions=own(new rhino.File3dmWriteOptions());writeOptions.version=7;
    const bytes=doc.toByteArrayOptions(writeOptions);
    if(!bytes?.length) throw new Error('Rhino file serialization failed.');
    return bytes;
  } finally { for(const object of disposable.reverse()) object.delete();doc.delete(); }
}
