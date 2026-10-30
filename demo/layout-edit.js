import { ShapeUtils, Vector2 } from './vendor/three.core.js';
import { readLayout, restoreLayout, captureLayout } from './layout.js';
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

function finish(model, previous, builders, change, target=null, survivor=null, retiredVertex=null, expectedJunction=null) {
  const generation={requestedCellCount:builders.reduce((sum,cell)=>sum+cell.memberSeedIds.length,0),emptyCellCount:0,mergedCellCount:builders.reduce((sum,cell)=>sum+cell.memberSeedIds.length-1,0)};
  const source=rebuildSurfaceCells(model,builders,generation);source.corners=[];
  const layout=captureLayout(model,source,{previous,recipe:previous.recipe,authority:'graph'});
  if(target&&survivor) {
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

/** Atomic direct graph transaction: no seed-field regeneration or hidden radius. */
export function transactLayout(model, input, operation) {
  const layout=readLayout(input),source=restoreLayout(model,layout);
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
