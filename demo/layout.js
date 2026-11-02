import { rebuildSurfaceCells } from './geometry.js';
import { readPattern } from './pattern.js';
import { readGeneratorPolicy } from './generator-policy.js';

// Authored source geometry. Generator inputs are provenance; fitted planes and
// stock meshes are deliberately absent. Local mesh coordinates retain their
// exact ordering while independent IDs identify the shared surface graph.
const WELD = 1e-5, EPS = 4e-5, MAX = 1000000;
const pointKey = p => p.map(x => Math.round(x / WELD)).join(',');
const edgeKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
const sub = (a, b) => a.map((x, k) => x - b[k]);
const dot = (a, b) => a.reduce((s, x, k) => s + x * b[k], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const distance = (a, b) => Math.hypot(...sub(a, b));
const fail = message => { throw new Error(`The source layout ${message}.`); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`has an invalid ${label}`); return value; }
function list(value, label, min = 0, max = MAX) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`has an invalid ${label}`);
  return value;
}
function point(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(x => !Number.isFinite(x))) fail(`has an invalid ${label}`);
  return [...value];
}
function number(value, label, min = 0) { if (!Number.isFinite(value) || value < min) fail(`has an invalid ${label}`); return value; }
function id(value, label) { if (!integer(value)) fail(`has an invalid ${label}`); return value; }
function ids(value, label, min = 1) {
  const result = list(value, label, min).map(x => id(x, label));
  if (new Set(result).size !== result.length) fail(`has duplicate ${label}`);
  return result;
}
function textId(value, prefix) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}(0|[1-9][0-9]*)$`).test(value) || !integer(Number(value.slice(1)))) fail(`has an invalid ${prefix === 'v' ? 'vertex' : 'edge'} ID`);
  return value;
}
function owners(value) {
  const groups = list(value, 'corner owners', 2, 500).map(group => ids(group, 'corner member IDs'));
  if (new Set(groups.flat()).size !== groups.flat().length) fail('has overlapping corner owners');
  return groups;
}
function readEdit(edit) {
  object(edit, 'corner edit');
  if (typeof edit.id !== 'string' || !edit.id.length || edit.id.length > 512) fail('has an invalid corner ID');
  return { id: edit.id, anchor: point(edit.anchor, 'corner anchor'), owners: owners(edit.owners),
    target: point(edit.target, 'corner target'), radius: number(edit.radius, 'corner radius', Number.MIN_VALUE) };
}

/** Canonical field order makes recipe equality independent of JSON key order. */
export function layoutRecipe(inputs) {
  object(inputs, 'recipe');
  let pattern, generatorPolicy;
  try { pattern = readPattern(inputs.pattern); generatorPolicy = readGeneratorPolicy(inputs.generatorPolicy, pattern); }
  catch (error) { fail(`has invalid generation settings: ${error.message}`); }
  const engine = pattern.type === 'organic' ? 'seed-fields-v1' : pattern.type === 'regularized' ? 'regularized-surface-v1' : 'structured-v1';
  if (inputs.engine !== undefined && inputs.engine !== engine) fail('uses an unsupported or inconsistent recipe engine');
  const seeds = list(inputs.seeds, 'recipe seeds', 1, 500).map(seed => ({
    id: id(seed?.id, 'recipe seed ID'), position: point(seed?.position, 'recipe seed position'),
    weight: number(seed?.weight ?? 1, 'recipe seed weight', .1),
  }));
  const known = new Set(seeds.map(seed => seed.id));
  if (known.size !== seeds.length || seeds.some(seed => seed.weight > 3)) fail('has invalid recipe seeds');
  const used = new Set();
  const mergeGroups = list(inputs.mergeGroups ?? [], 'recipe merge groups', 0, 250).map(group => {
    object(group, 'recipe merge group');
    const survivor = id(group.id, 'merge survivor ID'), members = ids(group.members, 'merge members', 2);
    if (!members.includes(survivor)) fail('has a merge without its survivor');
    for (const member of members) {
      if (!known.has(member) || used.has(member)) fail('has unknown or repeated merge members');
      used.add(member);
    }
    return { id: survivor, members };
  });
  const cornerEdits = list(inputs.cornerEdits ?? [], 'recipe corner edits', 0, 128).map(readEdit);
  if (new Set(cornerEdits.map(edit => edit.id)).size !== cornerEdits.length || cornerEdits.some(edit => edit.owners.flat().some(member => !known.has(member)))) fail('has invalid recipe corner references');
  if (engine !== 'seed-fields-v1' && cornerEdits.length) fail('cannot apply legacy corner targets to this pattern');
  return { engine, ...(engine !== 'seed-fields-v1' ? { pattern } : {}), seeds,
    size: number(inputs.size, 'recipe cell size', Number.MIN_VALUE), mergeGroups, cornerEdits,
    ...(generatorPolicy ? { generatorPolicy } : {}) };
}

function readCorner(corner) {
  object(corner, 'corner');
  if (typeof corner.id !== 'string' || !corner.id.length || corner.id.length > 512 || typeof corner.boundary !== 'boolean') fail('has invalid corner metadata');
  const result = { id: corner.id, anchor: point(corner.anchor, 'corner anchor'), position: point(corner.position, 'corner position'),
    owners: owners(corner.owners), cells: ids(corner.cells, 'corner cells', corner.boundary ? 2 : 3),
    radius: number(corner.radius, 'corner radius', Number.MIN_VALUE), boundary: corner.boundary };
  if (corner.vertexId !== undefined) result.vertexId = textId(corner.vertexId, 'v');
  if (corner.boundary) result.boundaryPath = list(corner.boundaryPath, 'corner boundary path', 4).map(p => point(p, 'boundary point'));
  return result;
}

/** Parse and clone the document, rejecting references before geometric work. */
export function readLayout(input) {
  object(input, 'document');
  if (input.format !== 'panel-source-layout' || ![1, 2, 3].includes(input.version)) fail('uses an unsupported document format');
  const authority = input.version === 1 ? 'recipe' : input.authority;
  if (!['recipe', 'graph'].includes(authority)) fail('has an invalid editing authority');
  object(input.source, 'source description'); object(input.nextIds, 'ID counters'); object(input.generation, 'generation metadata');
  const source = { vertexCount: id(input.source.vertexCount, 'source vertex count'), triangleCount: id(input.source.triangleCount, 'source triangle count'), signature: input.source.signature };
  if (typeof source.signature !== 'string' || !/^[0-9a-f]{16}$/.test(source.signature)) fail('has an invalid source signature');
  const nextIds = { vertex: id(input.nextIds.vertex, 'vertex counter'), edge: id(input.nextIds.edge, 'edge counter') };
  const vertices = list(input.vertices, 'vertices', 3).map(vertex => {
    object(vertex, 'vertex'); object(vertex.attachment, 'surface attachment');
    const attachment = { triangle: id(vertex.attachment.triangle, 'attachment triangle'), barycentric: point(vertex.attachment.barycentric, 'barycentric attachment') };
    if (attachment.triangle >= source.triangleCount || Math.abs(attachment.barycentric.reduce((a, b) => a + b, 0) - 1) > 1e-8 || attachment.barycentric.some(x => x < -1e-6 || x > 1 + 1e-6)) fail('has an invalid surface attachment');
    return { id: textId(vertex.id, 'v'), position: point(vertex.position, 'vertex position'), attachment };
  });
  const vertexIds = new Set(vertices.map(vertex => vertex.id));
  if (vertexIds.size !== vertices.length || new Set(vertices.map(vertex => pointKey(vertex.position))).size !== vertices.length) fail('has duplicate vertices');
  if (vertices.some(vertex => Number(vertex.id.slice(1)) >= nextIds.vertex)) fail('has a stale vertex ID counter');
  const usedVertices = new Set(), members = new Set();
  let triangleCount = 0;
  const cells = list(input.cells, 'cells', 1, 500).map(cell => {
    object(cell, 'cell');
    const positions = list(cell.positions, 'cell positions', 3).map(p => point(p, 'cell position'));
    const refs = list(cell.vertexIds, 'cell vertex references', positions.length, positions.length).map(ref => {
      if (!vertexIds.has(ref)) fail('refers to a missing vertex'); usedVertices.add(ref); return ref;
    });
    if (new Set(refs).size !== refs.length) fail('has duplicate vertex references in a cell');
    const cellId = id(cell.id, 'cell ID'), memberSeedIds = ids(cell.memberSeedIds, 'cell member IDs');
    if (!memberSeedIds.includes(cellId) || memberSeedIds.some(member => members.has(member))) fail('has inconsistent cell ownership');
    memberSeedIds.forEach(member => members.add(member));
    const index = value => { if (!integer(value) || value >= positions.length) fail('has an invalid cell vertex index'); return value; };
    const triangles = list(cell.triangles, 'cell triangles', 1).map(triangle => {
      object(triangle, 'cell triangle');
      const vertices = list(triangle.vertices, 'triangle vertices', 3, 3).map(index);
      if (new Set(vertices).size !== 3 || !integer(triangle.sourceTriangle) || triangle.sourceTriangle >= source.triangleCount) fail('has an invalid source triangle reference');
      return { vertices, sourceTriangle: triangle.sourceTriangle };
    });
    triangleCount += triangles.length;
    const loops = list(cell.loops, 'cell loops', 1).map(loop => list(loop, 'cell boundary loop', 3).map(index));
    // A clipped fan can leave a welded position unused after its tiny triangle
    // is discarded. Preserve that source ordering; it is still attached below.
    const weight = number(cell.weight, 'cell weight', .1);
    if (weight > 3) fail('has an invalid cell weight');
    return { id: cellId, seed: point(cell.seed, 'cell seed'), weight, memberSeedIds,
      vertexIds: refs, positions, loops, triangles };
  });
  if (triangleCount > MAX * 2 || usedVertices.size !== vertices.length) fail('has too many triangles or unused vertices');
  const cellIds = new Set(cells.map(cell => cell.id));
  if (cellIds.size !== cells.length) fail('has duplicate cell IDs');
  const edges = list(input.edges, 'edges', 3).map(edge => {
    object(edge, 'edge');
    const refs = list(edge.vertices, 'edge endpoints', 2, 2);
    if (refs[0] === refs[1] || refs.some(ref => !vertexIds.has(ref))) fail('has an invalid edge endpoint');
    const owners = ids(edge.cells, 'edge cell IDs');
    if (owners.length > 2 || owners.some(owner => !cellIds.has(owner))) fail('has invalid shared edge incidence');
    return { id: textId(edge.id, 'e'), vertices: [...refs], cells: owners };
  });
  if (new Set(edges.map(edge => edge.id)).size !== edges.length || new Set(edges.map(edge => edgeKey(...edge.vertices))).size !== edges.length) fail('has duplicate edges');
  if (edges.some(edge => Number(edge.id.slice(1)) >= nextIds.edge)) fail('has a stale edge ID counter');
  const corners = list(input.corners, 'corners', 0, MAX).map(readCorner);
  if (new Set(corners.map(corner => corner.id)).size !== corners.length || corners.some(corner => corner.cells.some(cell => !cellIds.has(cell)))) fail('has invalid corner references');
  if (corners.some(corner => corner.vertexId !== undefined && !vertexIds.has(corner.vertexId))) fail('has a corner referring to a missing vertex');
  if (authority === 'graph' && corners.some(corner => !corner.vertexId || corner.id !== `vertex:${corner.vertexId}`)) fail('has a corner without its graph identity');
  const generation = { requestedCellCount: id(input.generation.requestedCellCount, 'requested cell count'),
    emptyCellCount: id(input.generation.emptyCellCount, 'empty cell count'), mergedCellCount: id(input.generation.mergedCellCount, 'merged cell count') };
  if (generation.requestedCellCount > (authority==='graph'?MAX:500) || generation.requestedCellCount !== cells.length + generation.emptyCellCount + generation.mergedCellCount ||
    generation.mergedCellCount !== cells.reduce((sum, cell) => sum + cell.memberSeedIds.length - 1, 0)) fail('has inconsistent generation counts');
  const recipe = input.recipe === null ? null : layoutRecipe(input.recipe);
  let splitOrigins;
  if(input.version===3){
    if(authority!=='graph')fail('has split ancestry without graph authority');
    const entries=list(input.splitOrigins,'split ancestry',1),aliases=new Set(entries.map(entry=>entry?.id));
    const original=new Set(recipe?recipe.seeds.map(seed=>seed.id):[...cells.flatMap(cell=>cell.memberSeedIds).filter(id=>!aliases.has(id)),...entries.flatMap(entry=>entry?.sourceSeedIds||[])]);
    const known=new Map([...original].map(id=>[id,[id]]));
    let highest=Math.max(-1,...original);
    splitOrigins=entries.map(entry=>{
      object(entry,'split ancestry');
      const child=id(entry.id,'split part ID'),parentCellId=id(entry.parentCellId,'split parent ID'),sourceSeedIds=ids(entry.sourceSeedIds,'split source ancestry');
      if(child<=highest||known.has(child)||!known.has(parentCellId)||sourceSeedIds.some(id=>!original.has(id))||known.get(parentCellId).some(id=>!sourceSeedIds.includes(id)))fail('has inconsistent split ancestry');
      highest=child;known.set(child,sourceSeedIds);
      return {id:child,parentCellId,sourceSeedIds};
    });
  }
  if (recipe) {
    if (authority === 'recipe' && generation.requestedCellCount !== recipe.seeds.length) fail('has a recipe inconsistent with its cell count');
    const groups = new Map(recipe.mergeGroups.map(group => [group.id, group.members]));
    const known = new Set([...recipe.seeds.map(seed => seed.id),...(splitOrigins||[]).map(origin=>origin.id)]);
    const removed = new Set(recipe.mergeGroups.flatMap(group => group.members.filter(member => member !== group.id)));
    for (const cell of cells) {
      if (cell.memberSeedIds.some(member => !known.has(member))) fail('has a cell with unknown source ancestry');
      if (authority === 'recipe' && (!known.has(cell.id) || removed.has(cell.id) || cell.memberSeedIds.length !== (groups.get(cell.id) || [cell.id]).length || cell.memberSeedIds.some(member => !(groups.get(cell.id) || [cell.id]).includes(member)))) fail('has cell ownership that differs from its recipe');
    }
  }
  return { format: 'panel-source-layout', version: input.version, ...(input.version >= 2 ? { authority } : {}), source, nextIds, vertices, edges, cells, corners, generation, recipe,
    ...(splitOrigins?{splitOrigins}:{}) };
}

/** Includes retired generated and split IDs, not just currently visible cells. */
export function nextLayoutCellId(layout) {
  return Math.max(-1,...(layout?.recipe?.seeds||[]).map(seed=>seed.id),...(layout?.cells||[]).flatMap(cell=>[cell.id,...cell.memberSeedIds]),...(layout?.splitOrigins||[]).map(origin=>origin.id))+1;
}

// A small BVH locates source faces without testing every patch against every
// triangle on a detailed imported mesh. Raw face indices remain persistent.
function bounds(points) {
  return { min: [0,1,2].map(k => Math.min(...points.map(p => p[k]))), max: [0,1,2].map(k => Math.max(...points.map(p => p[k]))) };
}
function contains(box, other) { return [0,1,2].every(k => box.min[k] <= other.min[k] + EPS && box.max[k] >= other.max[k] - EPS); }
function tree(faces) {
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const face of faces) for (let k = 0; k < 3; k++) {
    box.min[k] = Math.min(box.min[k], face.bounds.min[k]);
    box.max[k] = Math.max(box.max[k], face.bounds.max[k]);
  }
  if (faces.length <= 12) return { ...box, faces };
  const axis = [0,1,2].sort((a,b) => (box.max[b]-box.min[b]) - (box.max[a]-box.min[a]))[0];
  faces.sort((a,b) => a.bounds.min[axis]+a.bounds.max[axis]-b.bounds.min[axis]-b.bounds.max[axis]);
  const middle = Math.floor(faces.length / 2);
  return { ...box, children: [tree(faces.slice(0,middle)), tree(faces.slice(middle))] };
}
function candidates(node, box, output = []) {
  if (!contains(node, box)) return output;
  if (node.faces) { for (const face of node.faces) if (contains(face.bounds, box)) output.push(face); }
  else for (const child of node.children) candidates(child, box, output);
  return output;
}
function barycentric(face, p) {
  // Cross products avoid subtracting almost-equal squared edge lengths on
  // very thin imported triangles (some example faces have aspect > 50,000).
  const d = sub(p, face.points[0]);
  const b = dot(cross(d, face.ac), face.cross) / face.denom;
  const c = dot(cross(face.ab, d), face.cross) / face.denom;
  return [1-b-c, b, c];
}
function attached(face, p) {
  const bary = barycentric(face, p);
  return Math.abs(dot(sub(p, face.points[0]), face.normal)) <= EPS && bary.every(x => x >= -1e-7 && x <= 1+1e-7) ? bary : null;
}
function sourceDescription(model) {
  // Signature catches a changed source even when its index counts are equal.
  // Attachments and oriented per-face coverage below provide geometric checks.
  let a = 2166136261, b = 0x9e3779b9;
  const feed = text => { for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 2246822519); } };
  feed(JSON.stringify(model.vertices)); feed(JSON.stringify(model.triangles));
  return { vertexCount: model.vertices.length, triangleCount: model.triangles.length, signature: (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0') };
}
function prepareSource(model) {
  object(model, 'model');
  const vertices = list(model.vertices, 'model vertices', 3, 200000).map(p => point(p, 'model vertex'));
  const raw = list(model.triangles, 'model triangles', 1, 150000), faces = [], byIndex = new Map(), sourceEdges = new Map();
  for (let index = 0; index < raw.length; index++) {
    const indices = list(raw[index], 'model triangle', 3, 3);
    if (indices.some(i => !integer(i) || i >= vertices.length)) fail('has an invalid model triangle');
    const points = indices.map(i => vertices[i]), ab = sub(points[1],points[0]), ac = sub(points[2],points[0]), n = cross(ab,ac), magnitude = Math.hypot(...n);
    if (magnitude < 2e-9) continue;
    const face = { index, points, ab, ac, cross: n, normal: n.map(x=>x/magnitude), area: magnitude/2, bounds: bounds(points) };
    face.denom = dot(n,n);
    faces.push(face); byIndex.set(index,face);
    for (let j=0;j<3;j++) {
      const p=points[j],q=points[(j+1)%3],key=edgeKey(pointKey(p),pointKey(q));
      if (!sourceEdges.has(key)) sourceEdges.set(key,{points:[p,q],count:0});
      sourceEdges.get(key).count++;
    }
  }
  if (!faces.length) fail('has no usable source surface');
  return { faces, byIndex, tree: tree([...faces]), description: sourceDescription(model), boundary: [...sourceEdges.values()].filter(edge=>edge.count===1).map(edge=>edge.points) };
}
function locate(prepared, points) {
  const found = candidates(prepared.tree,bounds(points)).find(face=>points.every(p=>attached(face,p)));
  if (!found) fail('contains a patch or point outside its source triangles');
  return found;
}
function onSegment(p, a, b, tolerance = EPS) {
  const d=sub(b,a), length2=dot(d,d), t=dot(sub(p,a),d)/length2;
  return t >= -1e-7 && t <= 1+1e-7 && distance(p,a.map((x,k)=>x+t*d[k])) <= tolerance;
}

function graphEdges(cells) {
  const result = new Map();
  for (const cell of cells) for (const loop of cell.loops) for(let i=0;i<loop.length;i++) {
    const a=cell.vertexIds[loop[i]],b=cell.vertexIds[loop[(i+1)%loop.length]],key=edgeKey(a,b);
    if (a===b) fail('has a collapsed boundary edge');
    if (!result.has(key)) result.set(key,{vertices:[a,b],cells:[],directions:[]});
    const edge=result.get(key); edge.cells.push(cell.id); edge.directions.push(a<b?1:-1);
  }
  for (const edge of result.values()) {
    if (edge.cells.length>2 || new Set(edge.cells).size!==edge.cells.length || (edge.cells.length===2&&edge.directions[0]===edge.directions[1])) fail('has inconsistent shared edge incidence');
  }
  return result;
}

/** Materialize a source partition once; future fitting reads this document. */
export function captureLayout(model, surfaceResult, { previous = null, recipe = null, authority = 'recipe', splitOrigins = authority==='graph'?previous?.splitOrigins:undefined } = {}) {
  const sourceCells = surfaceResult.surfaceCells || surfaceResult.cells;
  if (!surfaceResult.surfaceCells && sourceCells.some(cell => cell.fittedShared)) fail('must be captured from source surface cells');
  const prepared=prepareSource(model), old=previous ? readLayout(previous) : null;
  const previousVertices=new Map((old?.vertices||[]).map(vertex=>[pointKey(vertex.position),vertex.id]));
  const previousEdges=new Map((old?.edges||[]).map(edge=>[edgeKey(...edge.vertices),edge.id]));
  const nextIds={vertex:old?.nextIds.vertex||0,edge:old?.nextIds.edge||0},vertices=[],vertexMap=new Map();
  const cells=sourceCells.map(cell=>{
    const triangles=cell.triangles.map(indices=>({vertices:[...indices],sourceTriangle:locate(prepared,indices.map(i=>cell.positions[i])).index}));
    const vertexIds=cell.positions.map(position=>{
      const key=pointKey(position);
      if (!vertexMap.has(key)) {
        const face=locate(prepared,[position]),id=previousVertices.get(key)??`v${nextIds.vertex++}`;
        vertexMap.set(key,id); vertices.push({id,position:[...position],attachment:{triangle:face.index,barycentric:barycentric(face,position)}});
      }
      return vertexMap.get(key);
    });
    return {id:cell.id,seed:[...cell.seed],weight:cell.weight,memberSeedIds:[...(cell.memberSeedIds||[cell.id])],vertexIds,
      positions:cell.positions.map(p=>[...p]),loops:cell.loops.map(loop=>[...loop]),triangles};
  });
  const edges=[...graphEdges(cells).entries()].map(([key,edge])=>({id:previousEdges.get(key)??`e${nextIds.edge++}`,vertices:edge.vertices,cells:edge.cells}));
  const stats=surfaceResult.stats;
  const layout=readLayout({format:'panel-source-layout',version:splitOrigins?.length?3:authority==='graph'?2:1,...(authority==='graph'?{authority}:{}),source:prepared.description,nextIds,vertices,edges,cells,
    corners:surfaceResult.corners||[],generation:{requestedCellCount:stats.requestedCellCount??cells.length,emptyCellCount:stats.emptyCellCount??0,mergedCellCount:stats.mergedCellCount??0},recipe,
    ...(splitOrigins?.length?{splitOrigins}:{})});
  validateGeometry(model,layout,prepared);
  return layout;
}

// Validate an oriented subdivision separately on every source triangle. Positive
// contained patches with the exact outer boundary and cancelled interior edges
// cover that triangle once; area alone could miss a hole plus an overlap.
function validateCoverage(face, patches) {
  if (!patches?.length) fail('does not completely cover its source surface');
  let area=0;
  const points=new Map(),segments=[];
  for (const patch of patches) {
    const normal=cross(sub(patch[1],patch[0]),sub(patch[2],patch[0])),signed=dot(normal,face.normal)/2;
    if (signed<=1e-9) fail('contains a degenerate or reversed source patch');
    area+=signed;
    const bary=patch.map(p=>attached(face,p));
    if(bary.some(p=>!p)) fail('contains a patch attached to the wrong source triangle');
    for(let i=0;i<3;i++) {
      const p=patch[i],q=patch[(i+1)%3],a=pointKey(p),b=pointKey(q);
      if(a===b) fail('contains a collapsed source patch edge');
      if(!points.has(a)) points.set(a,p);
      if(!points.has(b)) points.set(b,q);
      segments.push([p,q]);
    }
  }
  if(Math.abs(area-face.area)>Math.max(1e-6,face.area*1e-8)) fail('does not completely cover its source triangle, or contains overlapping patches');
  const incidence=new Map();
  for(const [a,b] of segments) {
    const ab=sub(b,a),denom=dot(ab,ab);
    // Coverage subdivision needs an arithmetic residual tolerance, not the
    // larger source-attachment tolerance. Otherwise a valid skinny triangle's
    // opposite vertex is mistaken for an edge sample and counted repeatedly.
    const split=[...points.entries()].filter(([,p])=>onSegment(p,a,b,1e-7)).map(([key,p])=>({key,t:dot(sub(p,a),ab)/denom})).sort((a,b)=>a.t-b.t);
    for(let i=1;i<split.length;i++) {
      const first=split[i-1].key,last=split[i].key;if(first===last)continue;
      const key=edgeKey(first,last),entry=incidence.get(key)||{a:first,b:last,count:0,balance:0};
      entry.count++;entry.balance+=first<last?1:-1;incidence.set(key,entry);
    }
  }
  const intervals=[[],[],[]];
  for(const segment of incidence.values()) {
    if(segment.count===2&&segment.balance===0)continue;
    if(segment.count!==1) fail('contains overlapping or inconsistently joined source patches');
    const a=points.get(segment.a),b=points.get(segment.b),side=[0,1,2].find(i=>onSegment(a,face.points[i],face.points[(i+1)%3])&&onSegment(b,face.points[i],face.points[(i+1)%3]));
    if(side===undefined) fail('has a hole or an open edge inside a source triangle');
    const p=face.points[side],d=sub(face.points[(side+1)%3],p),denom=dot(d,d),ta=dot(sub(a,p),d)/denom,tb=dot(sub(b,p),d)/denom;
    if(tb<=ta) fail('has reversed source boundary orientation');
    intervals[side].push([ta,tb]);
  }
  for(const side of intervals) {
    side.sort((a,b)=>a[0]-b[0]);let end=0;
    for(const [a,b] of side) {if(Math.abs(a-end)>1e-7)fail('has a gap or overlap on a source triangle boundary');end=b;}
    if(Math.abs(end-1)>1e-7)fail('does not preserve the complete source boundary');
  }
}

function validateGeometry(model, layout, prepared=prepareSource(model)) {
  if(JSON.stringify(layout.source)!==JSON.stringify(prepared.description))fail('belongs to a different source model');
  const vertices=new Map(layout.vertices.map(vertex=>[vertex.id,vertex]));
  for(const vertex of layout.vertices) {
    const face=prepared.byIndex.get(vertex.attachment.triangle);
    if(!face)fail('attaches a vertex to an unusable source triangle');
    const reconstructed=[0,1,2].map(k=>face.points.reduce((sum,p,j)=>sum+p[k]*vertex.attachment.barycentric[j],0));
    if(distance(reconstructed,vertex.position)>EPS || !attached(face,vertex.position))fail('has a vertex outside its source attachment');
  }
  const patches=new Map(),builders=[];
  for(const cell of layout.cells) {
    cell.vertexIds.forEach((id,i)=>{if(pointKey(vertices.get(id).position)!==pointKey(cell.positions[i]) || distance(vertices.get(id).position,cell.positions[i])>EPS)fail('has cell coordinates inconsistent with their shared vertices');});
    const rawEdges=new Map();
    for(const triangle of cell.triangles) {
      if(!prepared.byIndex.has(triangle.sourceTriangle))fail('attaches a patch to an unusable source triangle');
      if(!patches.has(triangle.sourceTriangle))patches.set(triangle.sourceTriangle,[]);
      patches.get(triangle.sourceTriangle).push(triangle.vertices.map(i=>cell.positions[i]));
      for(let j=0;j<3;j++) {
        const a=triangle.vertices[j],b=triangle.vertices[(j+1)%3],key=edgeKey(a,b);
        if(!rawEdges.has(key))rawEdges.set(key,[]);rawEdges.get(key).push([a,b]);
      }
    }
    const boundary=new Map();
    for(const [key,edges] of rawEdges) {
      if(edges.length===1)boundary.set(key,edges[0]);
      else if(edges.length!==2||edges[0][0]!==edges[1][1]||edges[0][1]!==edges[1][0])fail('has non-manifold or inconsistently oriented cell patches');
    }
    for(const loop of cell.loops)for(let i=0;i<loop.length;i++) {
      const a=loop[i],b=loop[(i+1)%loop.length],key=edgeKey(a,b),edge=boundary.get(key);
      if(!edge||edge[0]!==a||edge[1]!==b)fail('has a boundary loop inconsistent with its source patches');boundary.delete(key);
    }
    if(boundary.size)fail('has missing cell boundary loops');
    builders.push({id:cell.id,seed:[...cell.seed],weight:cell.weight,memberSeedIds:[...cell.memberSeedIds],positions:cell.positions.map(p=>[...p]),triangles:cell.triangles.map(triangle=>[...triangle.vertices]),loops:cell.loops.map(loop=>[...loop])});
  }
  for(const face of prepared.faces)validateCoverage(face,patches.get(face.index));
  const expectedEdges=graphEdges(layout.cells),incident=new Map(),boundaryVertices=new Set();
  for(const edge of layout.edges) {
    const key=edgeKey(...edge.vertices),expected=expectedEdges.get(key);
    if(!expected||edge.cells.length!==expected.cells.length||edge.cells.some(cell=>!expected.cells.includes(cell)))fail('has shared edge ownership inconsistent with its cells');
    expectedEdges.delete(key);
    for(const vertex of edge.vertices) {if(!incident.has(vertex))incident.set(vertex,new Set());edge.cells.forEach(cell=>incident.get(vertex).add(cell));}
    if(edge.cells.length===1) {
      const [a,b]=edge.vertices.map(id=>vertices.get(id).position);
      if(!prepared.boundary.some(([p,q])=>onSegment(a,p,q)&&onSegment(b,p,q)))fail('has an open edge away from the source boundary');
      edge.vertices.forEach(vertex=>boundaryVertices.add(vertex));
    }
  }
  if(expectedEdges.size)fail('is missing shared graph edges');
  const positionIds=new Map(layout.vertices.map(vertex=>[pointKey(vertex.position),vertex.id])),byCell=new Map(layout.cells.map(cell=>[cell.id,cell])),checkedPaths=new Set();
  for(const corner of layout.corners) {
    const vertexId=corner.vertexId??positionIds.get(pointKey(corner.position)),actual=incident.get(vertexId);
    if (!vertices.has(vertexId) || pointKey(vertices.get(vertexId).position)!==pointKey(corner.position)) fail('has a corner away from its graph vertex');
    if(!actual||actual.size!==corner.cells.length||corner.cells.some(cell=>!actual.has(cell))||boundaryVertices.has(vertexId)!==corner.boundary)fail('has a corner inconsistent with the source graph');
    if(corner.owners.length!==corner.cells.length||corner.owners.some(group=>!corner.cells.some(id=>{const members=byCell.get(id).memberSeedIds;return members.length===group.length&&group.every(member=>members.includes(member));})))fail('has corner owners inconsistent with its cells');
    locate(prepared,[corner.anchor]);
    if(corner.boundary) {
      const path=corner.boundaryPath,key=JSON.stringify(path);
      if(!checkedPaths.has(key)) {
        if(distance(path[0],path.at(-1))>EPS)fail('has an open corner boundary path');
        for(let i=1;i<path.length;i++)if(!prepared.boundary.some(([a,b])=>onSegment(path[i-1],a,b)&&onSegment(path[i],a,b)))fail('has a corner path outside the source boundary');
        checkedPaths.add(key);
      }
      if(!path.slice(1).some((p,i)=>onSegment(corner.position,path[i],p)))fail('has a corner away from its boundary path');
    }
  }
  return builders;
}

/** Restore authoritative source triangles, then derive fit diagnostics anew. */
export function restoreLayout(model, input) {
  const layout=readLayout(input),builders=validateGeometry(model,layout);
  const result=rebuildSurfaceCells(model,builders,layout.generation);
  result.corners=layout.corners;
  return result;
}
