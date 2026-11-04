import { ShapeUtils, Triangle, Vector2, Vector3 } from './vendor/three.core.js';
import { readLayout, restoreLayout, captureLayout, nextLayoutCellId } from './layout.js';
import { rebuildSurfaceCells, mergeSurfaceCells } from './geometry.js';

const EPS = 1e-5;
const key = p => p.map(x => Math.round(x / EPS)).join(',');
const pairKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const length = p => Math.hypot(...p);
const distance = (a, b) => length(sub(a, b));
const unit = p => p.map(x => x / length(p));
const side = (a, b, c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const area = ring => ring.reduce((s,p,i) => {const q=ring[(i+1)%ring.length];return s+p[0]*q[1]-p[1]*q[0];},0)/2;
const fail = message => { throw new Error(message); };
const previewCache = new WeakMap();
const cellHandleCache = new WeakMap();
const splitPreviewCache = new WeakMap();

function network(layout) {
  const points = new Map(layout.vertices.map(v => [v.id,v.position])), nodes = new Map(), directed = new Map();
  for (const cell of layout.cells) for (const loop of cell.loops) for (let i=0;i<loop.length;i++) {
    const a=cell.vertexIds[loop[i]],b=cell.vertexIds[loop[(i+1)%loop.length]];
    directed.set(`${cell.id}:${a}|${b}`,true);
  }
  for (const edge of layout.edges) for (const id of edge.vertices) {
    if (!nodes.has(id)) nodes.set(id,[]);
    nodes.get(id).push(edge);
  }
  const anchors = new Set([...nodes].filter(([,edges]) => edges.length!==2 || edges[0].cells.slice().sort().join(',')!==edges[1].cells.slice().sort().join(',')).map(([id])=>id));
  const visited=new Set(),arcs=[];
  function trace(start, first) {
    const ids=[start],edges=[];let current=start,edge=first;
    while (!visited.has(edge.id)) {
      visited.add(edge.id);edges.push(edge.id);
      const next=edge.vertices.find(id=>id!==current);ids.push(next);
      if(anchors.has(next)||next===start)break;
      edge=nodes.get(next).find(candidate=>candidate.id!==edge.id);current=next;
    }
    const owners=new Map(first.cells.map(cell=>[cell,directed.has(`${cell}:${ids[0]}|${ids[1]}`)?1:-1]));
    arcs.push({id:first.id,a:ids[0],b:ids.at(-1),ids,edges,owners,points:ids.map(id=>points.get(id)),boundary:first.cells.length===1,changed:false});
  }
  for(const start of anchors)for(const edge of nodes.get(start))if(!visited.has(edge.id))trace(start,edge);
  for(const [start,edges] of nodes)for(const edge of edges)if(!visited.has(edge.id)){anchors.add(start);trace(start,edge);}
  return {points,nodes,arcs};
}

function cornerVertex(layout, cornerId) {
  const corner=layout.corners.find(c=>c.id===cornerId);
  if(!corner)fail('This corner is no longer present in the authored layout.');
  const vertex=corner.vertexId || layout.vertices.find(v=>key(v.position)===key(corner.position))?.id;
  if(!vertex)fail('This corner has no source graph vertex.');
  return {corner,vertex};
}

/** A cell handle belongs to its current authored patch, not its old seed field. */
export function layoutCellHandle(layout, cellId) {
  let cached=cellHandleCache.get(layout);
  if(!cached){cached={handles:new Map()};cellHandleCache.set(layout,cached);}
  if(cached.handles.has(cellId)){const handle=cached.handles.get(cellId);return {...handle,position:[...handle.position],cornerIds:[...handle.cornerIds]};}
  const cell=layout.cells.find(item=>item.id===cellId);
  if(!cell)fail('This cell is no longer present in the authored layout.');
  const center=new Vector3(),triangles=[];let total=0;
  for(const face of cell.triangles){
    const triangle=new Triangle(...face.vertices.map(index=>new Vector3(...cell.positions[index]))),area=triangle.getArea();
    if(area<=1e-9)continue;
    center.addScaledVector(triangle.getMidpoint(new Vector3()),area);total+=area;triangles.push(triangle);
  }
  if(!total)fail('This cell has no usable source patch for a movement handle.');
  center.multiplyScalar(1/total);
  const nearest=new Vector3();let point=null,best=Infinity;
  for(const triangle of triangles){triangle.closestPointToPoint(center,nearest);const d=nearest.distanceToSquared(center);if(d<best){best=d;point=nearest.clone();}}
  const corners=layout.corners.filter(corner=>corner.cells.includes(cellId));
  const position=point.toArray(),handle={cellId,position,cornerIds:corners.map(corner=>corner.id),
    radius:Math.max(EPS,...cell.positions.map(point=>distance(point,position)))*1.1};
  cached.handles.set(cellId,handle);
  return {...handle,position:[...handle.position],cornerIds:[...handle.cornerIds]};
}

/** Candidates follow complete logical seams, never proximity across sheets. */
export function layoutCornerCandidates(layout, cornerId) {
  let cached=previewCache.get(layout);
  if(!cached) {
    const vertices=new Map(layout.vertices.map(v=>[key(v.position),v.id]));
    cached={graph:network(layout),candidates:new Map(),corners:new Map(layout.corners.map(c=>[c.vertexId||vertices.get(key(c.position)),c.id]))};previewCache.set(layout,cached);
  }
  if(cached.candidates.has(cornerId))return cached.candidates.get(cornerId).map(candidate=>({...candidate,position:[...candidate.position]}));
  const {vertex,corner}=cornerVertex(layout,cornerId),graph=cached.graph,ids=new Set();
  for(const arc of graph.arcs)if(arc.a===vertex||arc.b===vertex)ids.add(arc.a===vertex?arc.b:arc.a);
  ids.delete(vertex);
  const result=[...ids].filter(id=>!corner.boundary||graph.nodes.get(id).some(edge=>edge.cells.length===1)).map(vertexId=>({vertexId,position:[...graph.points.get(vertexId)]}));
  cached.candidates.set(cornerId,result);
  return result.map(candidate=>({...candidate,position:[...candidate.position]}));
}

export function previewCornerMove(layout, {cornerId,target,snapDistance=0}) {
  if(!Array.isArray(target)||target.length!==3||target.some(x=>!Number.isFinite(x))||!Number.isFinite(snapDistance)||snapDistance<0)fail('The corner target and snapping distance must be finite.');
  const snap=layoutCornerCandidates(layout,cornerId).filter(candidate=>distance(candidate.position,target)<=Math.max(EPS,snapDistance)).sort((a,b)=>distance(a.position,target)-distance(b.position,target))[0];
  return {target:[...(snap?.position||target)],snapCornerId:snap?previewCache.get(layout).corners.get(snap.vertexId)??null:null,snapVertexId:snap?.vertexId??null};
}

function clip(subject, triangle) {
  let result=subject;
  for(let edge=0;edge<3;edge++) {
    const a=triangle[edge],b=triangle[(edge+1)%3],next=[];
    for(let i=0;i<result.length;i++) {
      const p=result[i],q=result[(i+1)%result.length],dp=side(a,b,p),dq=side(a,b,q),inside=dp>=-1e-9,other=dq>=-1e-9;
      if(inside)next.push(p);
      if(inside!==other) {const t=dp/(dp-dq);next.push(p.map((x,k)=>x+(q[k]-x)*t));}
    }
    result=next;if(result.length<3)return [];
  }
  return result;
}

function chart(model, layout, affected, origin, checkOverlap = true) {
  const indices=new Set(layout.cells.filter(c=>affected.has(c.id)).flatMap(c=>c.triangles.map(t=>t.sourceTriangle)));
  const normals=[...indices].map(index=>{const p=model.triangles[index].map(i=>model.vertices[i]);return cross(sub(p[1],p[0]),sub(p[2],p[0]));});
  const total=normals.reduce((sum,n)=>sum.map((x,k)=>x+n[k]),[0,0,0]);
  if(length(total)<1e-9)fail('This surface patch cannot be edited in one local chart. Use a smaller connected region.');
  const normal=unit(total),axis=Math.abs(normal[2])<.8?[0,0,1]:[0,1,0],u=unit(cross(axis,normal)),v=cross(normal,u);
  const project=p=>{const d=sub(p,origin);return [dot(d,u),dot(d,v)];};
  const faces=[...indices].map(index=>{
    const points=model.triangles[index].map(i=>model.vertices[i]),xy=points.map(project),signed=side(...xy);
    if(signed<=length(cross(sub(points[1],points[0]),sub(points[2],points[0])))*1e-6)fail('This surface patch folds over itself in the editing chart. The move was not applied.');
    return {index,points,xy,min:[0,1].map(k=>Math.min(...xy.map(p=>p[k]))),max:[0,1].map(k=>Math.max(...xy.map(p=>p[k])))};
  });
  if (checkOverlap) for(let i=0;i<faces.length;i++)for(let j=i+1;j<faces.length;j++) {
    const a=faces[i],b=faces[j];
    if(a.max[0]<=b.min[0]+EPS||b.max[0]<=a.min[0]+EPS||a.max[1]<=b.min[1]+EPS||b.max[1]<=a.min[1]+EPS)continue;
    const overlap=clip(a.xy,b.xy);
    if(overlap.length&&Math.abs(area(overlap))>Math.max(1e-6,Math.min(area(a.xy),area(b.xy))*1e-8))fail('This surface patch overlaps in the editing chart. The move was not applied.');
  }
  function lift(p,face) {
    const [a,b,c]=face.xy,denom=side(a,b,c),weights=[side(p,b,c)/denom,side(a,p,c)/denom,side(a,b,p)/denom];
    return [0,1,2].map(k=>face.points.reduce((sum,q,i)=>sum+q[k]*weights[i],0));
  }
  function address(p) {
    const xy=project(p),face=faces.find(face=>face.xy.every((a,i)=>side(a,face.xy[(i+1)%3],xy)>=-1e-6)&&distance(lift(xy,face),p)<1e-4);
    if(!face)fail('Keep the corner on the connected source surface of its incident cells.');
    return xy;
  }
  return {project,faces,lift,address};
}

function pathLength(path) {let result=0;for(let i=1;i<path.length;i++)result+=distance(path[i-1],path[i]);return result;}
function oriented(arc, start) {return arc.a===start?arc.points:arc.points.slice().reverse();}

function removeNumericalBends(points) {
  const keep=new Set([0,points.length-1]),pending=[[0,points.length-1]];
  while(pending.length){
    const [first,last]=pending.pop(),a=points[first],d=sub(points[last],a);let farthest=-1,error=1e-4;
    for(let i=first+1;i<last;i++){
      const t=Math.max(0,Math.min(1,dot(sub(points[i],a),d)/(dot(d,d)||1)));
      const gap=distance(points[i],a.map((x,k)=>x+t*d[k]));
      if(gap>error){error=gap;farthest=i;}
    }
    if(farthest>=0){keep.add(farthest);pending.push([first,farthest],[farthest,last]);}
  }
  return points.filter((_,i)=>keep.has(i));
}

function slideBoundary(arcs, vertex, target, targetId) {
  const boundary=arcs.filter(arc=>arc.boundary&&(arc.a===vertex||arc.b===vertex));
  if(!boundary.length)return;
  if(boundary.length!==2)fail('This boundary junction cannot slide through a branching source perimeter.');
  const first=oriented(boundary[0],vertex).slice().reverse(),second=oriented(boundary[1],vertex);
  const path=[...first,...second.slice(1)],oldDistance=pathLength(first),matches=[];let travelled=0;
  for(let i=1;i<path.length;i++) {
    const a=path[i-1],b=path[i],d=sub(b,a),squared=dot(d,d),t=dot(sub(target,a),d)/(squared||1),p=a.map((x,k)=>x+d[k]*t),segment=length(d);
    if(t>=-1e-7&&t<=1+1e-7&&distance(p,target)<1e-4)matches.push({i,t:Math.max(0,Math.min(1,t)),distance:Math.abs(travelled+segment*t-oldDistance)});
    travelled+=segment;
  }
  if(!matches.length)fail('The boundary corner would pass another junction or leave its source perimeter. Snap to the neighbouring junction first.');
  const match=matches.sort((a,b)=>a.distance-b.distance)[0];
  const before=[...path.slice(0,match.i),target],after=[target,...path.slice(match.i)];
  for(const [arc,points] of [[boundary[0],before.slice().reverse()],[boundary[1],after]]) {
    arc.points=arc.a===vertex?points:points.slice().reverse();arc.changed=true;
    if(arc.a===vertex)arc.a=targetId;if(arc.b===vertex)arc.b=targetId;
    arc.points=arc.points.filter((p,i,a)=>!i||distance(p,a[i-1])>EPS);
  }
}

function contractFaces(arcs, candidates, allowRemoval) {
  const removed=[];
  for(let pass=0;pass<500;pass++) {
    let changed=false;
    for(const cell of candidates) {
      if(removed.includes(cell))continue;
      const owned=arcs.filter(arc=>!arc.deleted&&arc.owners.has(cell));
      if(owned.length>2)continue;
      if(owned.length===1&&owned[0].a===owned[0].b&&owned[0].points.length>=3)continue;
      if(owned.length===2&&(pairKey(owned[0].a,owned[0].b)!==pairKey(owned[1].a,owned[1].b)||owned.some(a=>a.a===a.b)))continue;
      if(!allowRemoval)fail('This contraction removes a cell. Enable cell removal to apply it.');
      if(owned.length===1)fail('The contraction would leave an open cell.');
      if(owned.length===2) {
        const sorted=owned.slice().sort((a,b)=>Number(b.boundary)-Number(a.boundary)||Number(a.changed)-Number(b.changed)||a.id.localeCompare(b.id));
        const [keep,drop]=sorted,keepDirection=keep.owners.get(cell),dropDirection=drop.owners.get(cell);
        const others=[...drop.owners].filter(([id])=>id!==cell);
        if(keep.boundary&&drop.boundary)fail('The last cell on this source boundary cannot be removed.');
        keep.owners.delete(cell);
        for(const [owner,direction] of others) {
          if(keep.owners.has(owner))fail('This contraction would split a neighbouring cell into separate pieces.');
          keep.owners.set(owner,-keepDirection*direction/dropDirection);candidates.add(owner);
        }
        keep.boundary=keep.owners.size===1;keep.changed=true;drop.deleted=true;
      }
      removed.push(cell);changed=true;
    }
    if(!changed)return removed;
  }
  fail('The contraction could not resolve its incident cells.');
}

function intersections(arcs, affected) {
  const segments=[];
  for(const arc of arcs)if(!arc.deleted&&[...arc.owners.keys()].some(id=>affected.has(id)))for(let i=1;i<arc.xy.length;i++) {
    const a=arc.xy[i-1],b=arc.xy[i];if(distance(a,b)<EPS)continue;
    segments.push({a,b,arc:arc.id,i,start:i===1?arc.a:null,end:i===arc.xy.length-1?arc.b:null});
  }
  for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++) {
    const a=segments[i],b=segments[j];
    if(a.arc===b.arc&&Math.abs(a.i-b.i)<=1)continue;
    if(Math.max(a.a[0],a.b[0])<Math.min(b.a[0],b.b[0])-EPS||Math.max(b.a[0],b.b[0])<Math.min(a.a[0],a.b[0])-EPS||Math.max(a.a[1],a.b[1])<Math.min(b.a[1],b.b[1])-EPS||Math.max(b.a[1],b.b[1])<Math.min(a.a[1],a.b[1])-EPS)continue;
    const ab=side(a.a,a.b,b.a),ac=side(a.a,a.b,b.b),ba=side(b.a,b.b,a.a),bc=side(b.a,b.b,a.b);
    if((ab>EPS&&ac>EPS)||(ab<-EPS&&ac<-EPS)||(ba>EPS&&bc>EPS)||(ba<-EPS&&bc<-EPS))continue;
    const shared=[[a.start,a.a],[a.end,a.b]].some(([id,p])=>id&&[[b.start,b.a],[b.end,b.b]].some(([other,q])=>id===other&&distance(p,q)<EPS));
    if(shared) {
      const collinear=Math.max(Math.abs(ab),Math.abs(ac),Math.abs(ba),Math.abs(bc))<EPS;
      if(!collinear)continue;
      const axis=Math.abs(a.b[0]-a.a[0])>Math.abs(a.b[1]-a.a[1])?0:1;
      const overlap=Math.min(Math.max(a.a[axis],a.b[axis]),Math.max(b.a[axis],b.b[axis]))-Math.max(Math.min(a.a[axis],a.b[axis]),Math.min(b.a[axis],b.b[axis]));
      if(overlap<=EPS)continue;
    }
    fail('The moved seam would cross or overlap another seam. The source layout was not changed.');
  }
}

function loopsFor(arcs, cellId) {
  const links=arcs.filter(arc=>!arc.deleted&&arc.owners.has(cellId)).map(arc=>arc.owners.get(cellId)===1?{arc,a:arc.a,b:arc.b,xy:arc.xy}:{arc,a:arc.b,b:arc.a,xy:arc.xy.slice().reverse()});
  const outgoing=new Map();for(const link of links){if(outgoing.has(link.a))fail('The move would disconnect or pinch a cell boundary.');outgoing.set(link.a,link);}
  const visited=new Set(),loops=[];
  for(const start of links) {
    if(visited.has(start))continue;
    const ring=[];let link=start;
    while(link&&!visited.has(link)) {visited.add(link);ring.push(...link.xy.slice(0,-1));link=outgoing.get(link.b);}
    if(link!==start)fail('The move would leave an open cell boundary.');
    const clean=ring.filter((p,i)=>!i||distance(p,ring[i-1])>EPS);
    if(clean.length<3||Math.abs(area(clean))<1e-8)fail('The move leaves a degenerate cell. Snap to its neighbouring corner to contract it.');
    loops.push(clean);
  }
  const outer=loops.filter(loop=>area(loop)>0),holes=loops.filter(loop=>area(loop)<0);
  if(outer.length!==1)fail('The move would disconnect a cell or reverse its boundary.');
  return [...outer,...holes];
}

function retessellate(layout, affected, removed, arcs, local) {
  const canonical=new Map(layout.vertices.map(vertex=>[key(vertex.position),vertex.position])),builders=[];
  const proximity=new Map(),bucket=p=>p.map(x=>Math.floor(x/1e-4));
  function remember(p) {const k=bucket(p).join(',');if(!proximity.has(k))proximity.set(k,[]);proximity.get(k).push(p);}
  for(const point of canonical.values())remember(point);
  function nearby(point,face) {
    const base=bucket(point);let result=null,best=1e-4;
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)for(const p of proximity.get(`${base[0]+x},${base[1]+y},${base[2]+z}`)||[]) {
      const d=distance(point,p);if(d>=best)continue;
      const xy=local.project(p);
      if(face.xy.some((a,i)=>side(a,face.xy[(i+1)%3],xy)<-1e-6)||distance(local.lift(xy,face),p)>1e-6)continue;
      best=d;result=p;
    }
    return result;
  }
  for(const cell of layout.cells) {
    if(removed.includes(cell.id))continue;
    if(!affected.has(cell.id)) {builders.push({id:cell.id,seed:cell.seed,weight:cell.weight,memberSeedIds:cell.memberSeedIds,positions:cell.positions,triangles:cell.triangles.map(t=>t.vertices),loops:cell.loops});continue;}
    const loops=loopsFor(arcs,cell.id),points=loops.flat(),vectors=loops.map(loop=>loop.map(p=>new Vector2(...p)));
    const triangles=ShapeUtils.triangulateShape(vectors[0],vectors.slice(1));
    const builder={id:cell.id,seed:cell.seed,weight:cell.weight,memberSeedIds:cell.memberSeedIds,positions:[],triangles:[],map:new Map()};
    function vertex(p){const k=key(p);if(!canonical.has(k)){canonical.set(k,p);remember(p);}if(!builder.map.has(k)){builder.map.set(k,builder.positions.length);builder.positions.push([...canonical.get(k)]);}return builder.map.get(k);}
    for(const ids of triangles) {
      const polygon=ids.map(i=>points[i]);if(area(polygon)<0)polygon.reverse();
      for(const face of local.faces) {
        const clipped=clip(polygon,face.xy);if(clipped.length<3||Math.abs(area(clipped))<1e-10)continue;
        const refs=clipped.map(p=>{
          let lifted=local.lift(p,face);
          // Intersecting a tessellation diagonal almost through a source
          // vertex must not create micron-sized sliver fans. Existing authored
          // boundary samples win; only new numerical subdivisions are snapped.
          if(!canonical.has(key(lifted)))lifted=nearby(lifted,face)||face.points.find(q=>distance(q,lifted)<1e-4)||lifted;
          return vertex(lifted);
        }).filter((id,i,a)=>!i||id!==a[i-1]);if(refs[0]===refs.at(-1))refs.pop();
        for(let i=1;i<refs.length-1;i++) {const tri=[refs[0],refs[i],refs[i+1]],p=tri.map(i=>builder.positions[i]);if(length(cross(sub(p[1],p[0]),sub(p[2],p[0])))>2e-9)builder.triangles.push(tri);}
      }
    }
    builders.push(builder);
  }
  // Ear clipping can omit a collinear junction. Reinsert shared boundary
  // samples into affected triangles so no neighbour acquires a T junction.
  const all=[...new Map(builders.flatMap(builder=>builder.positions).map(p=>[key(p),p])).values()];
  for(const builder of builders)if(affected.has(builder.id)) {
    const positions=builder.positions,map=new Map(positions.map((p,i)=>[key(p),i])),result=[];
    const vertex=p=>{const k=key(p);if(!map.has(k)){map.set(k,positions.length);positions.push([...p]);}return map.get(k);};
    for(const tri of builder.triangles) {
      const ring=[];let split=false;
      for(let j=0;j<3;j++) {
        const a=positions[tri[j]],b=positions[tri[(j+1)%3]],d=sub(b,a),denom=dot(d,d),inner=[];
        const min=a.map((x,k)=>Math.min(x,b[k])-EPS),max=a.map((x,k)=>Math.max(x,b[k])+EPS);
        for(const p of all) {
          if(p[0]<min[0]||p[0]>max[0]||p[1]<min[1]||p[1]>max[1]||p[2]<min[2]||p[2]>max[2])continue;
          const t=((p[0]-a[0])*d[0]+(p[1]-a[1])*d[1]+(p[2]-a[2])*d[2])/denom;if(t<=1e-8||t>=1-1e-8)continue;
          if((p[0]-a[0]-t*d[0])**2+(p[1]-a[1]-t*d[1])**2+(p[2]-a[2]-t*d[2])**2<(EPS*.5)**2)inner.push({p,t});
        }
        ring.push(tri[j],...inner.sort((a,b)=>a.t-b.t).map(item=>vertex(item.p)));if(inner.length)split=true;
      }
      if(!split){result.push(tri);continue;}
      const center=vertex([0,1,2].map(k=>tri.reduce((sum,id)=>sum+positions[id][k],0)/3));
      for(let j=0;j<ring.length;j++)if(ring[j]!==ring[(j+1)%ring.length])result.push([center,ring[j],ring[(j+1)%ring.length]]);
    }
    builder.triangles=result;delete builder.map;
  }
  return builders;
}

function remapVertex(layout, from, to) {
  if(from===to)return;
  const existing=layout.vertices.find(vertex=>vertex.id===to);
  if(existing)remapVertex(layout,to,`v${layout.nextIds.vertex++}`);
  layout.vertices.find(vertex=>vertex.id===from).id=to;
  for(const cell of layout.cells)cell.vertexIds=cell.vertexIds.map(id=>id===from?to:id);
  for(const edge of layout.edges)edge.vertices=edge.vertices.map(id=>id===from?to:id);
}

function sourceBoundaryPaths(model) {
  const half=[],edges=new Map();
  for(const tri of model.triangles) {
    const points=tri.map(id=>model.vertices[id]);
    if(length(cross(sub(points[1],points[0]),sub(points[2],points[0])))<2e-9)continue;
    const start=half.length;
    for(let i=0;i<3;i++) {
      const a=model.vertices[tri[i]],b=model.vertices[tri[(i+1)%3]],index=half.length,edge={a,b,next:start+(i+1)%3,opposite:-1};half.push(edge);
      const k=pairKey(key(a),key(b)),other=edges.get(k);
      if(other===undefined)edges.set(k,index);else if(half[other].opposite<0){half[other].opposite=index;edge.opposite=other;}
    }
  }
  const visited=new Set(),paths=[];
  for(let start=0;start<half.length;start++) {
    if(half[start].opposite>=0||visited.has(start))continue;
    const path=[];let current=start,safe=0;
    while(!visited.has(current)&&safe++<half.length) {
      visited.add(current);path.push(half[current].a);let next=half[current].next,around=0;
      while(half[next].opposite>=0&&around++<half.length)next=half[half[next].opposite].next;
      current=next;
    }
    if(current===start&&path.length>=3)paths.push([...path,path[0]]);
  }
  return paths;
}

function graphCorners(layout,model) {
  const graph=network(layout),byCell=new Map(layout.cells.map(c=>[c.id,c])),boundary=new Map();
  for(const edge of layout.edges)if(edge.cells.length===1)for(let i=0;i<2;i++){const id=edge.vertices[i];if(!boundary.has(id))boundary.set(id,[]);boundary.get(id).push(edge.vertices[1-i]);}
  const sourcePaths=sourceBoundaryPaths(model);
  return [...graph.nodes].flatMap(([vertexId,edges])=>{
    const cells=[...new Set(edges.flatMap(edge=>edge.cells))].sort((a,b)=>a-b),isBoundary=boundary.has(vertexId);
    if(cells.length<(isBoundary?2:3))return [];
    const position=[...graph.points.get(vertexId)];
    let radius=EPS;
    for(const id of cells)for(const point of byCell.get(id).positions)radius=Math.max(radius,distance(position,point)*1.1);
    const boundaryPath=isBoundary?sourcePaths.find(path=>path.slice(1).some((b,i)=>{const a=path[i],d=sub(b,a),t=dot(sub(position,a),d)/(dot(d,d)||1);return t>=-1e-7&&t<=1+1e-7&&distance(position,a.map((x,k)=>x+t*d[k]))<EPS*4;})):null;
    if(isBoundary&&!boundaryPath)fail('The edited junction is not attached to a source perimeter loop.');
    return [{id:`vertex:${vertexId}`,vertexId,anchor:[...position],position,owners:cells.map(id=>[...byCell.get(id).memberSeedIds]),cells,radius,boundary:isBoundary,...(isBoundary?{boundaryPath}:{})}];
  });
}

function finish(model, previous, builders, change, target=null, survivor=null, retiredVertex=null, expectedJunction=null, movedVertices=[]) {
  const generation={requestedCellCount:builders.reduce((sum,cell)=>sum+cell.memberSeedIds.length,0),emptyCellCount:0,mergedCellCount:builders.reduce((sum,cell)=>sum+cell.memberSeedIds.length-1,0)};
  const source=rebuildSurfaceCells(model,builders,generation);source.corners=[];
  const splitOrigins=change.splitOrigin?[...(previous.splitOrigins||[]),change.splitOrigin]:previous.splitOrigins;
  const layout=captureLayout(model,source,{previous,recipe:previous.recipe,authority:'graph',splitOrigins});
  const restorations=[...movedVertices];
  if(target&&survivor)restorations.push({target,survivor,expectedJunction});
  for(const move of restorations) {
    const {target,survivor,expectedJunction}=move;
    const incident=new Map();
    for(const edge of layout.edges)for(const vertex of edge.vertices) {
      if(!incident.has(vertex))incident.set(vertex,{cells:new Set(),boundary:false});
      const entry=incident.get(vertex);edge.cells.forEach(id=>entry.cells.add(id));entry.boundary ||= edge.cells.length===1;
    }
    // Source clipping can canonicalize a target onto an existing point within
    // 0.0001 mm. Resolve the actual junction by incidence as well as position;
    // a nearby tessellation vertex must never steal the moved corner's ID.
    const candidates=expectedJunction?layout.vertices.filter(vertex=>{
      const entry=incident.get(vertex.id);
      return distance(vertex.position,target)<=1.1e-4&&entry&&entry.boundary===expectedJunction.boundary&&
        entry.cells.size===expectedJunction.cells.length&&expectedJunction.cells.every(id=>entry.cells.has(id));
    }):layout.vertices.filter(vertex=>key(vertex.position)===key(target));
    const needsCorner=expectedJunction&&expectedJunction.cells.length>=(expectedJunction.boundary?2:3);
    if(candidates.length>1||(needsCorner&&candidates.length!==1))fail('The moved corner could not be resolved uniquely on the edited source graph. The move was not applied.');
    const moved=candidates[0];
    if(moved)remapVertex(layout,moved.id,survivor);
  }
  if(retiredVertex&&layout.vertices.some(vertex=>vertex.id===retiredVertex))remapVertex(layout,retiredVertex,`v${layout.nextIds.vertex++}`);
  layout.corners=graphCorners(layout,model);
  const surface=restoreLayout(model,layout),corner=survivor?layout.corners.find(c=>c.vertexId===survivor):null;
  return {layout,surface,change:{...change,survivingCornerId:corner?.id??null,movedVertexId:survivor}};
}

function moveCell(model, input, layout, source, operation) {
  if(!Array.isArray(operation.target)||operation.target.length!==3||operation.target.some(x=>!Number.isFinite(x)))fail('The cell target must be a finite source-surface point.');
  const handle=layoutCellHandle(layout,operation.cellId),target=[...operation.target];
  if(distance(handle.position,target)<EPS)return {layout:input,surface:source,change:{removedCellIds:[],collapsedEdgeIds:[],affectedCellIds:[],movedCellId:operation.cellId,movedVertexIds:[],handlePosition:handle.position}};
  const corners=layout.corners.filter(corner=>handle.cornerIds.includes(corner.id));
  if(!corners.length)fail('This cell has no shared corners to move. Its source perimeter stays fixed.');
  const graph=network(layout),vertices=new Map(corners.map(corner=>[cornerVertex(layout,corner.id).vertex,corner]));
  const affected=new Set(graph.arcs.filter(arc=>vertices.has(arc.a)||vertices.has(arc.b)).flatMap(arc=>[...arc.owners.keys()]));
  const local=chart(model,layout,affected,handle.position),delta=sub(local.address(target),local.project(handle.position)),moves=[];
  function onSource(xy) {
    const face=local.faces.find(face=>face.xy.every((a,i)=>side(a,face.xy[(i+1)%3],xy)>=-1e-6));
    if(!face)fail('The cell move would leave the connected source patch. Move it a shorter distance.');
    return local.lift(xy,face);
  }
  for(const [vertex,corner] of vertices){
    const wanted=local.project(corner.position).map((value,axis)=>value+delta[axis]);let moved;
    if(corner.boundary){
      let best=Infinity;
      for(const arc of graph.arcs.filter(arc=>arc.boundary&&(arc.a===vertex||arc.b===vertex)))for(let i=1;i<arc.points.length;i++){
        const a=local.project(arc.points[i-1]),b=local.project(arc.points[i]),d=sub(b,a),t=Math.max(0,Math.min(1,dot(sub(wanted,a),d)/(dot(d,d)||1)));
        const projected=a.map((value,axis)=>value+t*d[axis]),error=distance(projected,wanted);
        if(error<best){best=error;moved=arc.points[i-1].map((value,axis)=>value+t*(arc.points[i][axis]-value));}
      }
      if(!moved)fail('A boundary cell corner has no connected source perimeter.');
      for(const arc of graph.arcs.filter(arc=>arc.boundary&&(arc.a===vertex||arc.b===vertex))){
        const other=arc.a===vertex?arc.b:arc.a;
        if(distance(moved,graph.points.get(other))<EPS)fail('The cell move would collapse a boundary seam. Move it a shorter distance or edit the corner explicitly.');
      }
    }else moved=onSource(wanted);
    if(distance(moved,corner.position)>EPS)moves.push({target:moved,survivor:vertex,expectedJunction:{cells:[...corner.cells],boundary:corner.boundary}});
  }
  if(!moves.length)fail('The source perimeter prevents this cell movement. Move along the boundary or edit its corners.');
  const targets=new Map(moves.map(move=>[move.survivor,move.target]));
  // Update shared boundary arcs in the temporary graph. The original perimeter
  // samples, including sharp outer corners and openings, remain on their path.
  for(const move of moves)if(move.expectedJunction.boundary)slideBoundary(graph.arcs,move.survivor,move.target,move.survivor);
  for(const arc of graph.arcs)if(!arc.boundary&&(targets.has(arc.a)||targets.has(arc.b))){
    // Transport the authored seam, including its bends. Moving a centre must
    // not silently replace an irregular arrangement with straight edges.
    const before=arc.points.map(local.project),total=pathLength(before),a=targets.get(arc.a)||graph.points.get(arc.a),b=targets.get(arc.b)||graph.points.get(arc.b);
    const da=sub(local.project(a),before[0]),db=sub(local.project(b),before.at(-1));let travelled=0;
    arc.points=before.map((point,i)=>{
      if(i===0)return a;
      if(i===before.length-1)return b;
      travelled+=distance(before[i-1],point);const t=travelled/(total||1);
      return onSource(point.map((value,axis)=>value+da[axis]*(1-t)+db[axis]*t));
    });arc.changed=true;
    if(pathLength(arc.points)<EPS)fail('The cell move would collapse a shared seam. Move it a shorter distance or merge explicitly.');
  }
  for(const arc of graph.arcs){
    arc.xy=arc.points.map(local.project);
    // Transported source-edge subdivisions can contain numerical kinks that
    // create nearly zero-width clipping fans. Preserve junctions and true
    // bends; every discarded sample stays within 0.0001 mm in this chart.
    if(arc.changed&&!arc.boundary)arc.xy=removeNumericalBends(arc.xy);
  }
  intersections(graph.arcs,affected);
  const builders=retessellate(layout,affected,[],graph.arcs,local);
  const result=finish(model,layout,builders,{removedCellIds:[],collapsedEdgeIds:[],affectedCellIds:[...affected].sort((a,b)=>a-b),
    movedCellId:operation.cellId,movedVertexIds:moves.map(move=>move.survivor),requestedTarget:target},null,null,null,null,moves);
  result.change.handlePosition=layoutCellHandle(result.layout,operation.cellId).position;
  return result;
}

function splitContext(model,layout,cellId) {
  let cached=splitPreviewCache.get(layout);
  if(!cached||cached.model!==model){cached={model,cells:new Map()};splitPreviewCache.set(layout,cached);}
  if(cached.cells.has(cellId))return cached.cells.get(cellId);
  const cell=layout.cells.find(cell=>cell.id===cellId);
  if(!cell)fail('The selected cell is no longer present in the authored layout.');
  const local=chart(model,layout,new Set([cellId]),layoutCellHandle(layout,cellId).position);
  const context={cell,local};cached.cells.set(cellId,context);return context;
}

function splitGeometry(model,layout,{cellId,start,end},newCellId) {
  if([start,end].some(point=>!Array.isArray(point)||point.length!==3||point.some(x=>!Number.isFinite(x))))fail('Draw the divider using two finite points.');
  const {cell,local}=splitContext(model,layout,cellId),a=local.project(start),b=local.project(end),span=distance(a,b);
  if(span<EPS)fail('Draw a longer divider across the selected cell.');
  const signed=cell.positions.map(point=>{const d=side(a,b,local.project(point))/span;return Math.abs(d)<1e-7?0:d;});
  if(!signed.some(d=>d>0)||!signed.some(d=>d<0))fail('The divider must cross the selected cell and leave a part on both sides.');
  const intersections=new Map(),canonical=new Map(cell.positions.map(point=>[key(point),point]));
  function crossing(i,j){
    if(signed[i]===0)return cell.positions[i];if(signed[j]===0)return cell.positions[j];
    const edge=pairKey(i,j);if(intersections.has(edge))return intersections.get(edge);
    const t=signed[i]/(signed[i]-signed[j]),p=cell.positions[i].map((x,k)=>x+t*(cell.positions[j][k]-x));
    let point=distance(p,cell.positions[i])<EPS?cell.positions[i]:distance(p,cell.positions[j])<EPS?cell.positions[j]:p;
    point=canonical.get(key(point))||point;canonical.set(key(point),point);intersections.set(edge,point);return point;
  }
  const parts=[{id:cell.id,seed:cell.seed,weight:cell.weight,memberSeedIds:cell.memberSeedIds},
    {id:newCellId,seed:cell.seed,weight:cell.weight,memberSeedIds:[newCellId]}].map(part=>({...part,positions:[],triangles:[],map:new Map()}));
  const segments=[],segmentKeys=new Set();
  for(const face of cell.triangles){
    const ids=face.vertices;
    for(let half=0;half<2;half++){
      const sign=half===0?1:-1,polygon=[];
      for(let i=0;i<3;i++){
        const p=ids[i],q=ids[(i+1)%3],inside=signed[p]*sign>=0,nextInside=signed[q]*sign>=0;
        if(inside)polygon.push(cell.positions[p]);
        if(inside!==nextInside)polygon.push(crossing(p,q));
      }
      const part=parts[half],refs=polygon.map(point=>{const k=key(point);if(!part.map.has(k)){part.map.set(k,part.positions.length);part.positions.push([...point]);}return part.map.get(k);})
        .filter((id,i,refs)=>!i||id!==refs[i-1]);
      if(refs[0]===refs.at(-1))refs.pop();
      for(let i=1;i<refs.length-1;i++){
        const tri=[refs[0],refs[i],refs[i+1]],p=tri.map(id=>part.positions[id]);
        if(length(cross(sub(p[1],p[0]),sub(p[2],p[0])))>2e-9)part.triangles.push(tri);
      }
    }
    const cut=[];
    for(let i=0;i<3;i++){
      const p=ids[i],q=ids[(i+1)%3];
      if(signed[p]===0)cut.push(cell.positions[p]);
      if(signed[p]*signed[q]<0)cut.push(crossing(p,q));
    }
    const unique=[...new Map(cut.map(point=>[key(point),point])).values()];
    if(unique.length===2&&distance(...unique)>EPS){const k=pairKey(...unique.map(key));if(!segmentKeys.has(k)){segmentKeys.add(k);segments.push(...unique);}}
  }
  if(parts.some(part=>!part.triangles.length))fail('The divider leaves only a negligible sliver. Draw it farther through the cell.');
  const children=rebuildSurfaceCells(model,parts).cells,total=children.reduce((sum,child)=>sum+child.area,0);
  if(children.some(child=>child.area<Math.max(1e-6,total*1e-8)))fail('The divider leaves only a negligible sliver. Draw it farther through the cell.');
  if(children.some(child=>child.sourceComponentCount!==1))fail('This divider makes disconnected pieces. Draw it where each side stays in one connected part.');
  const boundaryCuts=[];
  for(const loop of cell.loops)for(let i=0;i<loop.length;i++){
    const p=loop[i],q=loop[(i+1)%loop.length];
    if(signed[p]*signed[q]<0){const point=crossing(p,q);if(distance(point,cell.positions[p])>EPS&&distance(point,cell.positions[q])>EPS)boundaryCuts.push({vertices:[cell.vertexIds[p],cell.vertexIds[q]],point});}
  }
  return {parts,segments:segments.map(point=>[...point]),boundaryCuts,areas:children.map(child=>child.area)};
}

/** Preview is clipped to the selected cell and follows its actual source faces. */
export function previewCellSplit(model,layout,operation) {
  try{const result=splitGeometry(model,layout,operation,nextLayoutCellId(layout));return {segments:result.segments,areas:result.areas,issue:null};}
  catch(error){return {segments:[],issue:error.message};}
}

/** Complete logical seams, excluding perimeter edges. A seam may contain many
 * source-triangle samples; the first stable edge ID identifies the whole path. */
export function enumerateBendSeams(layout) {
  return network(layout).arcs.filter(arc=>!arc.boundary&&arc.owners.size===2).map(arc=>({
    edgeId:arc.id,edgeIds:[...arc.edges],cellIds:[...arc.owners.keys()].sort((a,b)=>a-b),points:arc.points.map(p=>[...p]),
  }));
}

// A new boundary point must also subdivide the neighbouring source triangle.
// Its shape and ownership do not change, and untouched neighbours stay exact.
function bridgeNeighbours(layout,selected,boundaryCuts,affected) {
  const edges=new Map(layout.edges.map(edge=>[pairKey(...edge.vertices),edge])),cutsByCell=new Map();
  for(const cut of boundaryCuts)for(const owner of edges.get(pairKey(...cut.vertices))?.cells||[]){
    if(selected.has(owner))continue;
    if(!cutsByCell.has(owner))cutsByCell.set(owner,[]);
    const cuts=cutsByCell.get(owner);
    if(!cuts.some(other=>pairKey(...other.vertices)===pairKey(...cut.vertices)&&key(other.point)===key(cut.point)))cuts.push(cut);
    affected.add(owner);
  }
  return layout.cells.filter(cell=>!selected.has(cell.id)).map(cell=>{
    const builder={id:cell.id,seed:cell.seed,weight:cell.weight,memberSeedIds:cell.memberSeedIds,positions:cell.positions,triangles:cell.triangles.map(face=>face.vertices),loops:cell.loops};
    const cuts=cutsByCell.get(cell.id);if(!cuts)return builder;
    builder.positions=cell.positions.map(point=>[...point]);builder.triangles=[];delete builder.loops;
    const map=new Map(builder.positions.map((point,i)=>[key(point),i]));
    const vertex=point=>{const k=key(point);if(!map.has(k)){map.set(k,builder.positions.length);builder.positions.push([...point]);}return map.get(k);};
    for(const face of cell.triangles){
      const ring=[];let changed=false;
      for(let i=0;i<3;i++){
        const p=face.vertices[i],q=face.vertices[(i+1)%3],edge=pairKey(cell.vertexIds[p],cell.vertexIds[q]);
        const samples=cuts.filter(cut=>pairKey(...cut.vertices)===edge).sort((x,y)=>distance(x.point,cell.positions[p])-distance(y.point,cell.positions[p]));
        ring.push(p,...samples.map(cut=>vertex(cut.point)));changed ||= samples.length>0;
      }
      if(!changed){builder.triangles.push(face.vertices);continue;}
      const center=vertex([0,1,2].map(k=>face.vertices.reduce((sum,id)=>sum+cell.positions[id][k],0)/3));
      for(let i=0;i<ring.length;i++)builder.triangles.push([center,ring[i],ring[(i+1)%ring.length]]);
    }
    return builder;
  });
}

function bridgeBend(model,layout,operation) {
  if(layout.cells.length>=500)fail('This study already has 500 cells. Merge cells before adding an across-bend cell.');
  const minimum=nextLayoutCellId(layout),newCellId=operation.nextCellId??minimum;
  if(!Number.isSafeInteger(newCellId)||newCellId<minimum||newCellId>=Number.MAX_SAFE_INTEGER)fail('The new panel ID is stale or invalid. Preview the across-bend cell again.');
  const width=operation.widthMm;
  if(!Number.isFinite(width)||width<=EPS*4)fail('Enter a positive across-bend width in millimetres; a nearly zero-width cell cannot be made.');
  const seams=enumerateBendSeams(layout),seam=seams.find(item=>item.edgeIds.includes(operation.edgeId));
  if(!seam)fail('Choose an existing shared edge between two cells, away from the shell perimeter.');
  const selected=new Set(seam.cellIds),samePair=seams.filter(item=>item.cellIds.every(id=>selected.has(id)));
  if(samePair.length!==1||distance(seam.points[0],seam.points.at(-1))<=EPS)fail('These cells do not meet along one open, unbranched seam. Choose a straighter shared edge, or reshape/divide these cells first.');
  const parts=[],cuts=[],previewSegments=[];
  for(const cellId of seam.cellIds){
    let context;
    try{context=splitContext(model,layout,cellId);}
    catch(error){
      if(/editing chart|local chart/.test(error.message))fail(`Panel P${String(cellId+1).padStart(3,'0')} curves too far to make a reliable cut in one projected view. Choose a smaller region, or divide/reshape this cell first.`);
      throw error;
    }
    const {cell,local}=context;
    let a=local.project(seam.points[0]),b=local.project(seam.points.at(-1));
    const span=distance(a,b);
    if(span<=EPS)fail('This shared seam has no usable end-to-end direction. Choose a straighter shared edge, or reshape/divide these cells first.');
    // Source loops follow the positively oriented triangles in this validated
    // chart. Their direction gives the inward side even if a seam bows across
    // its endpoint chord; using all cell vertices would reject ordinary curves.
    const first=key(seam.points[0]),second=key(seam.points[1]);
    const forward=cell.loops.some(loop=>loop.some((id,i)=>key(cell.positions[id])===first&&key(cell.positions[loop[(i+1)%loop.length]])===second));
    if(!forward)[a,b]=[b,a];
    // Every seam segment must remain strictly within the joined strip. Signed
    // distance is linear on each segment, so checking its endpoints suffices.
    // Width is measured from the endpoint chord and varies along bowed seams.
    if(seam.points.some(p=>side(a,b,local.project(p))/span>=width/2-EPS*4))fail('This seam curves beyond the proposed strip. Increase the width, choose a straighter shared edge, or reshape/divide these cells first.');
    const inward=[-(b[1]-a[1])/span,(b[0]-a[0])/span],offset=p=>p.map((value,axis)=>value+inward[axis]*width/2);
    // The validated chart determines a projected target width. Intersections
    // are lifted on each original source triangle by splitGeometry, so curved
    // shells retain their exact surface rather than being flattened here.
    let divided;
    try{divided=splitGeometry(model,layout,{cellId,start:local.lift(offset(a),local.faces[0]),end:local.lift(offset(b),local.faces[0])},newCellId);}
    catch(error){
      if(/both sides|negligible sliver/.test(error.message))fail('This width would use up a neighbouring cell or leave a sliver. Reduce the across-bend width.');
      if(/disconnected pieces/.test(error.message))fail('This width would break a neighbouring cell into separate pieces. Reduce the width, or reshape/divide the cells first.');
      throw error;
    }
    parts.push(divided);cuts.push(...divided.boundaryCuts);previewSegments.push(...divided.segments);
  }
  const strip={id:newCellId,seed:[...seam.points[Math.floor(seam.points.length/2)]],weight:1,memberSeedIds:[newCellId],positions:[],triangles:[]},vertices=new Map();
  for(const divided of parts){
    const half=divided.parts[1],remap=half.positions.map(p=>{const k=key(p);if(!vertices.has(k)){vertices.set(k,strip.positions.length);strip.positions.push([...p]);}return vertices.get(k);});
    strip.triangles.push(...half.triangles.map(triangle=>triangle.map(id=>remap[id])));
  }
  const measured=rebuildSurfaceCells(model,[strip]).cells[0];
  if(!measured||measured.sourceComponentCount!==1)fail('This width makes separate across-bend pieces. Reduce the width, or reshape/divide the two cells first.');
  if(measured.holeCount)fail('This strip includes an opening in the source. Reduce the width or divide the cells beside the opening first.');
  const affected=new Set([...selected,newCellId]),builders=bridgeNeighbours(layout,selected,cuts,affected);
  builders.push(...parts.map(divided=>divided.parts[0]),strip);builders.sort((a,b)=>a.id-b.id);
  const origins=new Map((layout.splitOrigins||[]).map(origin=>[origin.id,origin.sourceSeedIds]));
  const sourceSeedIds=[...new Set(layout.cells.filter(cell=>selected.has(cell.id)).flatMap(cell=>cell.memberSeedIds.flatMap(id=>origins.get(id)||[id])))].sort((a,b)=>a-b);
  // Existing v3 ancestry permits a primary parent plus a superset of its source
  // seeds. Preserve both originals here; exact graph geometry remains authority.
  const splitOrigin={id:newCellId,parentCellId:seam.cellIds[0],sourceSeedIds};
  const result=finish(model,layout,builders,{removedCellIds:[],collapsedEdgeIds:[],newCellId,trimmedCellIds:[...seam.cellIds],
    affectedCellIds:[...affected].sort((a,b)=>a-b),splitOrigin,widthMm:width,seamEdgeId:seam.edgeId});
  result.change.previewSegments=previewSegments.map(p=>[...p]);
  return result;
}

/** Complete source validation runs without changing the authored layout or
 * reserving an ID. The returned mesh is the on-shell strip, not its fitted part. */
export function previewBendBridge(model,layout,operation) {
  try{
    const result=transactLayout(model,layout,{...operation,type:'bridge-bend'}),cell=result.surface.cells.find(cell=>cell.id===result.change.newCellId);
    return {positions:cell.positions.map(p=>[...p]),triangles:cell.triangles.map(t=>[...t]),segments:result.change.previewSegments,
      cellIds:result.change.trimmedCellIds,affectedCellIds:result.change.affectedCellIds,area:cell.area,issue:null};
  }catch(error){return {positions:[],triangles:[],segments:[],issue:error.message};}
}

function splitCell(model,layout,operation) {
  if(layout.cells.length>=500)fail('This study already has 500 cells. Merge cells before adding another.');
  const minimum=nextLayoutCellId(layout),newCellId=operation.nextCellId??minimum;
  if(!Number.isSafeInteger(newCellId)||newCellId<minimum||newCellId>=Number.MAX_SAFE_INTEGER)fail('The new panel ID is stale or invalid. Draw the divider again.');
  const divided=splitGeometry(model,layout,operation,newCellId),selected=layout.cells.find(cell=>cell.id===operation.cellId);
  const cutsByCell=new Map(),affected=new Set([operation.cellId,newCellId]);
  const edges=new Map(layout.edges.map(edge=>[pairKey(...edge.vertices),edge]));
  for(const edge of layout.edges)if(edge.cells.includes(operation.cellId))edge.cells.forEach(id=>affected.add(id));
  for(const cut of divided.boundaryCuts)for(const owner of edges.get(pairKey(...cut.vertices))?.cells||[]){
    if(owner===operation.cellId)continue;
    if(!cutsByCell.has(owner))cutsByCell.set(owner,[]);cutsByCell.get(owner).push(cut);affected.add(owner);
  }
  const builders=layout.cells.filter(cell=>cell.id!==operation.cellId).map(cell=>{
    const builder={id:cell.id,seed:cell.seed,weight:cell.weight,memberSeedIds:cell.memberSeedIds,positions:cell.positions,triangles:cell.triangles.map(face=>face.vertices),loops:cell.loops};
    const cuts=cutsByCell.get(cell.id);if(!cuts)return builder;
    builder.positions=cell.positions.map(point=>[...point]);builder.triangles=[];delete builder.loops;
    const map=new Map(builder.positions.map((point,i)=>[key(point),i]));
    const vertex=point=>{const k=key(point);if(!map.has(k)){map.set(k,builder.positions.length);builder.positions.push([...point]);}return map.get(k);};
    for(const face of cell.triangles){
      const ring=[];let changed=false;
      for(let i=0;i<3;i++){
        const p=face.vertices[i],q=face.vertices[(i+1)%3],edge=pairKey(cell.vertexIds[p],cell.vertexIds[q]);
        const samples=cuts.filter(cut=>pairKey(...cut.vertices)===edge).sort((x,y)=>distance(x.point,cell.positions[p])-distance(y.point,cell.positions[p]));
        ring.push(p,...samples.map(cut=>vertex(cut.point)));changed ||= samples.length>0;
      }
      if(!changed){builder.triangles.push(face.vertices);continue;}
      const center=vertex([0,1,2].map(k=>face.vertices.reduce((sum,id)=>sum+cell.positions[id][k],0)/3));
      for(let i=0;i<ring.length;i++)builder.triangles.push([center,ring[i],ring[(i+1)%ring.length]]);
    }
    return builder;
  });
  builders.push(...divided.parts);builders.sort((a,b)=>a.id-b.id);
  const origins=new Map((layout.splitOrigins||[]).map(origin=>[origin.id,origin.sourceSeedIds]));
  const sourceSeedIds=[...new Set(selected.memberSeedIds.flatMap(id=>origins.get(id)||[id]))].sort((a,b)=>a-b);
  const splitOrigin={id:newCellId,parentCellId:selected.id,sourceSeedIds};
  const result=finish(model,layout,builders,{removedCellIds:[],collapsedEdgeIds:[],newCellId,survivingCellId:selected.id,affectedCellIds:[...affected].sort((a,b)=>a-b),splitOrigin});
  return result;
}

/** Atomic direct graph transaction: no seed-field regeneration or hidden radius. */
export function transactLayout(model, input, operation) {
  const layout=readLayout(input),source=restoreLayout(model,layout);
  if(operation?.type==='bridge-bend')return bridgeBend(model,layout,operation);
  if(operation?.type==='split-cell')return splitCell(model,layout,operation);
  if(operation?.type==='move-cell')return moveCell(model,input,layout,source,operation);
  if(operation?.type==='merge-cells') {
    const selected=operation.cellIds;
    if(!Array.isArray(selected)||selected.length<2||new Set(selected).size!==selected.length)fail('Select at least two different adjacent cells to merge.');
    const survivor=Math.min(...selected),members=selected.flatMap(id=>source.cells.find(cell=>cell.id===id)?.memberSeedIds||[]);
    const merged=mergeSurfaceCells(source,[{id:survivor,members:selected}]);
    for(const cell of merged.cells)cell.memberSeedIds=cell.id===survivor?members:source.cells.find(previous=>previous.id===cell.id).memberSeedIds;
    return finish(model,layout,merged.cells,{removedCellIds:selected.filter(id=>id!==survivor),collapsedEdgeIds:layout.edges.filter(edge=>edge.cells.length===2&&edge.cells.every(id=>selected.includes(id))).map(edge=>edge.id)});
  }
  if(operation?.type!=='move-corner')fail('Unsupported source layout transaction.');
  if(!Array.isArray(operation.target)||operation.target.length!==3||operation.target.some(x=>!Number.isFinite(x)))fail('The corner target must be a finite source-surface point.');
  const {corner,vertex}=cornerVertex(layout,operation.cornerId),graph=network(layout),target=[...operation.target];
  if(distance(corner.position,target)<EPS)return {layout:input,surface:source,change:{removedCellIds:[],collapsedEdgeIds:[],survivingCornerId:corner.id,movedVertexId:vertex}};
  const preview=previewCornerMove(layout,{cornerId:operation.cornerId,target,snapDistance:operation.snapDistance??0}),snap=preview.snapVertexId;
  target.splice(0,3,...preview.target);
  const survivor=snap??vertex,affected=new Set(graph.arcs.filter(arc=>[arc.a,arc.b].some(id=>id===vertex||id===survivor)).flatMap(arc=>[...arc.owners.keys()]));
  let local=chart(model,layout,affected,corner.position);local.address(target);
  slideBoundary(graph.arcs,vertex,target,survivor);
  const collapsedEdgeIds=[];
  for(const arc of graph.arcs)if(!arc.boundary&&(arc.a===vertex||arc.b===vertex)) {
    if(arc.a===vertex)arc.a=survivor;if(arc.b===vertex)arc.b=survivor;
    arc.points=[arc.a===survivor?target:graph.points.get(arc.a),arc.b===survivor?target:graph.points.get(arc.b)];arc.changed=true;
  }
  for(const arc of graph.arcs)if(arc.changed&&(arc.points.length<2||pathLength(arc.points)<EPS)) {arc.deleted=true;collapsedEdgeIds.push(...arc.edges);}
  const changedOwners=new Set(affected),removedCellIds=snap?contractFaces(graph.arcs,changedOwners,operation.allowCellRemoval!==false):[];
  for(const arc of graph.arcs)if(arc.deleted)for(const id of arc.edges)if(!collapsedEdgeIds.includes(id))collapsedEdgeIds.push(id);
  if([...changedOwners].some(id=>!affected.has(id))) {
    for(const id of changedOwners)affected.add(id);
    local=chart(model,layout,affected,corner.position);local.address(target);
  }
  for(const arc of graph.arcs)arc.xy=arc.points.map(local.project);
  intersections(graph.arcs,affected);
  const builders=retessellate(layout,affected,removedCellIds,graph.arcs,local);
  if(!builders.length)fail('The last cell cannot be removed from the source surface.');
  const incident=graph.arcs.filter(arc=>!arc.deleted&&(arc.a===survivor||arc.b===survivor));
  const expectedJunction={cells:[...new Set(incident.flatMap(arc=>[...arc.owners.keys()]))],boundary:incident.some(arc=>arc.boundary)};
  return finish(model,layout,builders,{removedCellIds,collapsedEdgeIds},target,survivor,snap?vertex:null,expectedJunction);
}

/** Disposable, local sketch. No source capture, global validation or panel fitting.
 * It uses the same seam construction as a transaction, but never authorizes it.
 */
export function createCornerSketch(model, layout, cornerId) {
  const {corner, vertex} = cornerVertex(layout, cornerId), base = network(layout);
  const affected = new Set(base.arcs.filter(a => a.a === vertex || a.b === vertex).flatMap(a => [...a.owners.keys()]));
  const local = chart(model, layout, affected, corner.position, false);
  const overlaps = (min, max, face) => min.every((x,k) => x <= face.max[k] + EPS && max[k] >= face.min[k] - EPS);
  const bounds = points => ({min:[0,1].map(k=>Math.min(...points.map(p=>p[k]))),max:[0,1].map(k=>Math.max(...points.map(p=>p[k])))});
  function seam(points) {
    const segments=[];
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i],box=bounds([a,b]);
      for(const face of local.faces) {
        if(!overlaps(box.min,box.max,face))continue;
        let lo=0,hi=1;
        for(let e=0;e<3;e++) {
          const p=face.xy[e],q=face.xy[(e+1)%3],da=side(p,q,a),db=side(p,q,b);
          if(da<0&&db<0){hi=-1;break;}
          if(da<0)lo=Math.max(lo,da/(da-db));
          if(db<0)hi=Math.min(hi,da/(da-db));
        }
        if(hi-lo>1e-8)segments.push(...[lo,hi].map(t=>local.lift(a.map((x,k)=>x+(b[k]-x)*t),face)));
      }
    }
    return segments;
  }
  return target => {
    const arcs=base.arcs.map(a=>({...a, points:a.points, changed:false}));
    let issue=null;
    try { local.address(target); slideBoundary(arcs,vertex,target,vertex); }
    catch(error){issue=error.message;}
    for(const arc of arcs) {
      if(!arc.boundary&&(arc.a===vertex||arc.b===vertex)) {
        arc.points=[arc.a===vertex?target:base.points.get(arc.a),arc.b===vertex?target:base.points.get(arc.b)];
      }
      arc.xy=arc.points.map(local.project);
    }
    try { intersections(arcs,affected); } catch(error){issue ??= error.message;}
    const cells=[];
    for(const id of affected) {
      try {
        const loops=loopsFor(arcs,id),points=loops.flat();
        const triangles=ShapeUtils.triangulateShape(loops[0].map(p=>new Vector2(...p)),loops.slice(1).map(r=>r.map(p=>new Vector2(...p))));
        const positions=[];
        for(const tri of triangles) {
          const polygon=tri.map(i=>points[i]);if(area(polygon)<0)polygon.reverse();
          const box=bounds(polygon);
          for(const face of local.faces) {
            if(!overlaps(box.min,box.max,face))continue;
            const ring=clip(polygon,face.xy);if(ring.length<3)continue;
            for(let i=1;i<ring.length-1;i++)positions.push(...[ring[0],ring[i],ring[i+1]].map(p=>local.lift(p,face)));
          }
        }
        cells.push({id,positions});
      } catch(error){issue ??= error.message;}
    }
    return {cells,segments:arcs.filter(a=>[...a.owners.keys()].some(id=>affected.has(id))).flatMap(a=>seam(a.xy)),issue};
  };
}
