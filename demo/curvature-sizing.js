import { readGeneratorPolicy, readMaxGeneratedCells, MAX_GENERATED_CELLS } from './generator-policy.js';

/** Version 1 uses a 20 degree normal-turn target, not a fabrication tolerance.
 * Curvature is a robust quadratic fit to a physical neighbourhood on the source
 * graph. Area weights prevent dense triangulation from acquiring extra influence;
 * geodesic neighbourhoods do not join nearby disconnected/folded sheets.
 */
export const CURVATURE_TURN_RADIANS = Math.PI / 9;
const MAX_VISITS = 12_000_000;
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const sub = (a, b) => a.map((x, k) => x - b[k]);
const distance = (a, b) => Math.hypot(...sub(a, b));

class Heap {
  constructor() { this.items = []; }
  push(id, value) {
    const items = this.items; let i = items.length; items.push([id, value]);
    while (i && items[(i-1)>>1][1] > value) { items[i] = items[(i-1)>>1]; i = (i-1)>>1; }
    items[i] = [id, value];
  }
  pop() {
    const a = this.items, first = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      while (i*2+1 < a.length) {
        let child = i*2+1;
        if (child+1 < a.length && a[child+1][1] < a[child][1]) child++;
        if (a[child][1] >= last[1]) break;
        a[i] = a[child]; i = child;
      }
      a[i] = last;
    }
    return first;
  }
}

function eigenvectors(matrix) {
  const a = matrix.map(row => [...row]), v = [[1,0,0],[0,1,0],[0,0,1]];
  for (let sweep = 0; sweep < 18; sweep++) {
    let p = 0, q = 1;
    for (const [i,j] of [[0,2],[1,2]]) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j; }
    if (Math.abs(a[p][q]) < 1e-14) break;
    const angle = .5*Math.atan2(2*a[p][q], a[q][q]-a[p][p]), c = Math.cos(angle), s = Math.sin(angle);
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    a[p][p] = c*c*app - 2*s*c*apq + s*s*aqq;
    a[q][q] = s*s*app + 2*s*c*apq + c*c*aqq; a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      if (k !== p && k !== q) {
        const kp = a[k][p], kq = a[k][q]; a[k][p] = a[p][k] = c*kp-s*kq; a[k][q] = a[q][k] = s*kp+c*kq;
      }
      const vp = v[k][p], vq = v[k][q]; v[k][p] = c*vp-s*vq; v[k][q] = s*vp+c*vq;
    }
  }
  return [0,1,2].sort((i,j) => a[i][i]-a[j][j]).map(i => ({ value: a[i][i], axis: v.map(row => row[i]) }));
}

function solve(rows, weights) {
  const a = Array.from({length:6}, () => new Float64Array(7));
  for (let i = 0; i < rows.length; i++) {
    const {basis, z} = rows[i], w = weights[i];
    for (let j = 0; j < 6; j++) {
      for (let k = 0; k < 6; k++) a[j][k] += w*basis[j]*basis[k];
      a[j][6] += w*basis[j]*z;
    }
  }
  const scale = Math.max(...a.map(row => Math.max(...row.slice(0,6))));
  for (let j = 0; j < 6; j++) {
    let pivot = j;
    for (let k = j+1; k < 6; k++) if (Math.abs(a[k][j]) > Math.abs(a[pivot][j])) pivot = k;
    if (Math.abs(a[pivot][j]) < scale*1e-11) return null;
    [a[pivot],a[j]] = [a[j],a[pivot]];
    const denominator = a[j][j]; for (let k = j; k < 7; k++) a[j][k] /= denominator;
    for (let i = 0; i < 6; i++) if (i !== j) {
      const f = a[i][j]; for (let k = j; k < 7; k++) a[i][k] -= f*a[j][k];
    }
  }
  return a.map(row => row[6]);
}

function localCurvature(points, members, areas, origin, radius) {
  const weights = members.map(([id,d]) => areas[id]*Math.exp(-2*(d/radius)**2));
  const total = weights.reduce((a,b) => a+b,0), mean = [0,0,0];
  members.forEach(([id],i) => { for (let k = 0; k < 3; k++) mean[k] += weights[i]*(points[id][k]-origin[k])/radius/total; });
  const covariance = Array.from({length:3}, () => [0,0,0]);
  members.forEach(([id],i) => {
    const d = points[id].map((x,k) => (x-origin[k])/radius-mean[k]);
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) covariance[j][k] += weights[i]*d[j]*d[k]/total;
  });
  const eigen = eigenvectors(covariance), n = eigen[0].axis, u = eigen[2].axis, v = eigen[1].axis;
  // A genuinely planar, possibly very coarse patch needs no quadratic fit.
  if (eigen[0].value < 1e-15) return { curvature: 0, uncertain: false };
  const rows = members.map(([id]) => {
    const d = sub(points[id],origin).map(x => x/radius), x = dot(d,u), y = dot(d,v);
    return { basis:[1,x,y,x*x,x*y,y*y], z:dot(d,n) };
  });
  let coefficients = solve(rows,weights);
  if (!coefficients) return { curvature: Infinity, uncertain: true };
  const residual = (row,c) => row.z-row.basis.reduce((sum,x,k) => sum+x*c[k],0);
  const residuals = rows.map(row => Math.abs(residual(row,coefficients))).sort((a,b)=>a-b);
  const noise = Math.max(1e-9,residuals[residuals.length>>1]*1.4826);
  const robustWeights = weights.map((w,i) => w*Math.min(1,2.5*noise/Math.max(noise,Math.abs(residual(rows[i],coefficients)))));
  coefficients = solve(rows,robustWeights) || coefficients;
  const [,p,q,xx,xy,yy] = coefficients, a = 2*xx/radius, b = xy/radius, c = 2*yy/radius, g = 1+p*p+q*q;
  const trace = ((1+q*q)*a-2*p*q*b+(1+p*p)*c)/g**1.5, det = (a*c-b*b)/g**2;
  const discriminant = Math.sqrt(Math.max(0,trace*trace-4*det));
  let curvature = Math.max(Math.abs((trace+discriminant)*.5),Math.abs((trace-discriminant)*.5));
  // Sub-support mesh noise must not turn an otherwise planar region into the
  // minimum-size field. Curvature below fit residual uncertainty is unresolved.
  const rms = Math.sqrt(rows.reduce((sum,row,i) => sum+robustWeights[i]*residual(row,coefficients)**2,0)/robustWeights.reduce((a,b)=>a+b,0));
  if (curvature < 3*rms/radius) curvature = 0;
  return { curvature, uncertain: false };
}

export function buildCurvatureSizing(prepared, input, maxGeneratedCells) {
  const limit = readMaxGeneratedCells(maxGeneratedCells);
  const policy = readGeneratorPolicy(input);
  if (!policy) throw new Error('Curvature sizing needs a minimum and maximum cell size.');
  const {minSizeMm:minSize,maxSizeMm:maxSize} = policy, {graph,graphPoints:points,triangles} = prepared;
  const supportRadius = Math.max(minSize,Math.min(maxSize*.5,minSize*2));
  const areas = new Float64Array(points.length);
  for (const t of triangles) for (const id of t.graphIds) areas[id] += t.area/3;
  const covered = new Uint8Array(points.length), sums = new Float64Array(points.length), weights = new Float64Array(points.length);
  const distances = new Float64Array(points.length).fill(Infinity), touched = [];
  let visits = 0, probeCount = 0, uncertainProbeCount = 0;
  for (let anchor = 0; anchor < points.length; anchor++) {
    if (covered[anchor]) continue;
    probeCount++;
    // Coarse input still needs enough adjacent vertices for a quadratic fit.
    let radius = supportRadius;
    for (const [,length] of graph[anchor]) radius = Math.max(radius,length*2.1);
    const heap = new Heap(), members = []; distances[anchor] = 0; touched.push(anchor); heap.push(anchor,0);
    while (heap.items.length) {
      const [id,d] = heap.pop(); if (d !== distances[id]) continue;
      if (++visits > MAX_VISITS) throw new Error('Curvature sizing exceeded its source-mesh work budget. Simplify the mesh or increase the minimum cell size.');
      members.push([id,d]); if (d <= supportRadius*.45) covered[id] = 1;
      for (const [next,length] of graph[id]) if (d+length <= radius && d+length < distances[next]) {
        if (distances[next] === Infinity) touched.push(next);
        distances[next] = d+length; heap.push(next,d+length);
      }
    }
    const fit = localCurvature(points,members,areas,points[anchor],radius);
    if (fit.uncertain) uncertainProbeCount++;
    const curvature = Math.min(CURVATURE_TURN_RADIANS/minSize,fit.curvature);
    for (const [id,d] of members) { const w = Math.exp(-4*(d/radius)**2); sums[id] += w*curvature; weights[id] += w; }
    for (const id of touched) distances[id] = Infinity; touched.length = 0;
  }
  const vertexSizes = Float64Array.from(sums,(sum,id) => Math.max(minSize,Math.min(maxSize,CURVATURE_TURN_RADIANS/(sum/weights[id] || 0))));
  // Bound growth to half a millimetre of target spacing per millimetre travelled.
  // This only reduces large targets; min/max remain respected and sharp changes
  // cannot create an isolated island of tiny cells beside very large neighbours.
  const heap = new Heap(); vertexSizes.forEach((h,id) => heap.push(id,h));
  while (heap.items.length) {
    const [id,h] = heap.pop(); if (h !== vertexSizes[id]) continue;
    for (const [next,length] of graph[id]) if (h+.5*length < vertexSizes[next]) { vertexSizes[next] = h+.5*length; heap.push(next,vertexSizes[next]); }
  }
  const triangleSizes = Float64Array.from(triangles,t => t.graphIds.reduce((sum,id) => sum+vertexSizes[id],0)/3);
  const triangleDensities = Float64Array.from(triangleSizes,h => (minSize/h)**4);
  if (triangleDensities.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('The cell-size range is too wide for stable curvature density. Use a narrower minimum/maximum size range.');
  }
  let requested = 0, minTargetSize = Infinity, maxTargetSize = 0;
  for (let i = 0; i < triangles.length; i++) {
    requested += triangles[i].area / triangleSizes[i]**2 / (Math.sqrt(3)*.5);
    minTargetSize = Math.min(minTargetSize,triangleSizes[i]); maxTargetSize = Math.max(maxTargetSize,triangleSizes[i]);
  }
  const componentIds = new Int32Array(points.length).fill(-1), components = [];
  for (let id = 0; id < points.length; id++) if (componentIds[id] < 0) {
    const component = components.length, nodes = [id]; componentIds[id] = component;
    for (let i = 0; i < nodes.length; i++) for (const [next] of graph[nodes[i]]) if (componentIds[next] < 0) { componentIds[next] = component; nodes.push(next); }
    components.push(nodes);
  }
  const requestedCount = Math.max(12,components.length,Math.round(requested));
  if (requestedCount > limit) throw new Error(`Curvature sizing requests ${requestedCount} cells, above the selected ${limit}-cell limit. Increase ${limit < MAX_GENERATED_CELLS ? `Maximum generated cells (up to ${MAX_GENERATED_CELLS}), increase ` : ''}the minimum/maximum cell sizes or use a smaller source region.`);
  return { policy, vertexSizes, componentIds, components,
    targetAtTriangle:index => triangleSizes[index], triangleDensity:index => triangleDensities[index],
    diagnostics:{ minTargetSize,maxTargetSize,requestedCount,count:requestedCount,probeCount,uncertainProbeCount,neighbourVisits:visits,supportRadius,componentCount:components.length },
  };
}

/** Deterministic area/h² sampling followed by farthest-point selection measured
 * in h-normalised source-graph distance. Seed weights stay 1: the separate cell
 * weight control is an additive ownership bias, not a curvature/radius field.
 */
export function sampleAdaptiveSeeds(prepared,sizing,variation,random) {
  const {triangles,graph,graphPoints:points} = prepared, count = sizing.diagnostics.requestedCount;
  const cumulative = [], components = Array.from({length:sizing.components.length},()=>[]);
  let total = 0;
  triangles.forEach((t,i) => { total += t.area/sizing.targetAtTriangle(i)**2; cumulative.push(total); components[sizing.componentIds[t.graphIds[0]]].push(i); });
  function candidate(index) {
    const t = triangles[index], s = Math.sqrt(random()), v = random(), bary = [1-s,s*(1-v),s*v];
    return { triangle:index, position:[0,1,2].map(k => t.points.reduce((sum,p,j)=>sum+p[k]*bary[j],0)), h:sizing.targetAtTriangle(index) };
  }
  const candidates = components.map(indices => candidate(indices[Math.floor(random()*indices.length)]));
  const poolSize = Math.min(9000,Math.max(1500,count*35));
  while (candidates.length < poolSize) {
    const value = random()*total; let lo = 0, hi = triangles.length-1;
    while (lo < hi) { const mid = (lo+hi)>>1; if (cumulative[mid] < value) lo=mid+1; else hi=mid; }
    candidates.push(candidate(lo));
  }
  const jitter = candidates.map(()=>1+Math.max(0,Math.min(1,Number(variation)||0))*1.2*(random()-.5));
  const nearest = new Float64Array(candidates.length).fill(Infinity), selected = new Uint8Array(candidates.length), seeds = [];
  let chosen = 0, visits = 0;
  for (let i = 0; i < count; i++) {
    const current = candidates[chosen], t = triangles[current.triangle]; selected[chosen] = 1;
    seeds.push({id:i,position:[...current.position],weight:1});
    const distances = new Float64Array(points.length).fill(Infinity), heap = new Heap();
    for (const id of t.graphIds) { const d = distance(current.position,points[id])*.5*(1/current.h+1/sizing.vertexSizes[id]); distances[id]=d; heap.push(id,d); }
    while (heap.items.length) {
      const [id,d] = heap.pop(); if (d !== distances[id]) continue;
      if (++visits > 30_000_000) throw new Error('Adaptive seed spacing exceeded its source-mesh work budget. Simplify the source mesh or increase the cell sizes.');
      for (const [next,length] of graph[id]) {
        const nd = d+length*.5*(1/sizing.vertexSizes[id]+1/sizing.vertexSizes[next]);
        if (nd < distances[next]) { distances[next]=nd; heap.push(next,nd); }
      }
    }
    let best = -1;
    for (let j = 0; j < candidates.length; j++) {
      if (selected[j]) continue;
      const c = candidates[j], ct = triangles[c.triangle];
      let d = c.triangle === current.triangle ? distance(c.position,current.position)*.5*(1/c.h+1/current.h) : Infinity;
      for (const id of ct.graphIds) d = Math.min(d,distances[id]+distance(c.position,points[id])*.5*(1/c.h+1/sizing.vertexSizes[id]));
      nearest[j] = Math.min(nearest[j],d);
      const score = nearest[j]**2*jitter[j];
      if (score > best) { best = score; chosen = j; }
    }
  }
  sizing.diagnostics.seedGraphVisits = visits;
  return seeds;
}
