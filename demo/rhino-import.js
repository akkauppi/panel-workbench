import { ShapeUtils, Vector2 } from './vendor/three.core.js';

const MAX_VERTICES = 200000, MAX_TRIANGLES = 150000, MAX_OBJECTS = 200000;
const MAX_CURVE_POINTS = 4096, CURVE_TOLERANCE_MM = 0.1, PLANE_TOLERANCE_MM = 0.01;
const EMPTY_ID = '00000000-0000-0000-0000-000000000000';
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// Some table classes shadow Embind's destructor with delete(id).
function release(value) {
  for (let prototype = value && Object.getPrototypeOf(value); prototype; prototype = Object.getPrototypeOf(prototype)) {
    const method = Object.getOwnPropertyDescriptor(prototype, 'delete')?.value;
    if (typeof method === 'function' && method.argCount === undefined && !method.overloadTable) { method.call(value); return; }
  }
}
const valueOf = value => value?.value ?? value;
const sameEnum = (a, b) => valueOf(a) === valueOf(b);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const distance = (a, b) => Math.hypot(...sub(a, b));

function unitsInMillimetres(unit, rhino) {
  const factors = {
    Angstroms: 1e-7, Nanometers: 1e-6, Microns: 0.001, Millimeters: 1,
    Centimeters: 10, Decimeters: 100, Meters: 1000, Dekameters: 1e4,
    Hectometers: 1e5, Kilometers: 1e6, Megameters: 1e9, Gigameters: 1e12,
    Microinches: 0.0000254, Mils: 0.0254, Inches: 25.4, Feet: 304.8,
    Yards: 914.4, Miles: 1609344, PrinterPoints: 25.4 / 72,
    PrinterPicas: 25.4 / 6, NauticalMiles: 1852000,
    AstronomicalUnits: 149597870700000, LightYears: 9.4607304725808e18,
    Parsecs: 3.0856775814913673e19,
  };
  for (const [name, scale] of Object.entries(factors)) {
    if (rhino.UnitSystem[name] !== undefined && sameEnum(unit, rhino.UnitSystem[name])) return { name, scale };
  }
  throw new Error('The Rhino file has unspecified or custom units. Set its model units to millimetres in Rhino and save again.');
}

function matrixFromRhino(transform) {
  const matrix = Array.from({ length: 16 }, (_, i) => transform[`m${Math.floor(i / 4)}${i % 4}`]);
  if (!matrix.every(Number.isFinite) || matrix.slice(12, 15).some(v => Math.abs(v) > 1e-12) || Math.abs(matrix[15] - 1) > 1e-12) {
    throw new Error('A Rhino block has an invalid or projective transform.');
  }
  return matrix;
}

function multiply(a, b) {
  return Array.from({ length: 16 }, (_, i) => {
    const row = Math.floor(i / 4), column = i % 4;
    return a[row * 4] * b[column] + a[row * 4 + 1] * b[4 + column]
      + a[row * 4 + 2] * b[8 + column] + a[row * 4 + 3] * b[12 + column];
  });
}

function determinant(m) {
  return m[0] * (m[5] * m[10] - m[6] * m[9])
    - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
}

function worldPoint(point, transform, scale) {
  if (!point || point.length < 3 || !point.slice(0, 3).every(Number.isFinite)) throw new Error('The Rhino geometry contains an invalid coordinate.');
  const result = [0, 1, 2].map(row => scale * (transform[row * 4] * point[0]
    + transform[row * 4 + 1] * point[1] + transform[row * 4 + 2] * point[2] + transform[row * 4 + 3]));
  if (!result.every(Number.isFinite)) throw new Error('A Rhino coordinate or block transform exceeds the supported range.');
  return result;
}

function pointSegmentDistance(p, a, b) {
  const ab = sub(b, a), denominator = dot(ab, ab);
  const t = denominator ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / denominator)) : 0;
  return distance(p, a.map((v, i) => v + t * ab[i]));
}

// Positive rational Bezier curves stay inside the Euclidean control hull.
// Subdivision of homogeneous control points therefore bounds chord deviation,
// including after non-uniform block scaling, without merely sampling the curve.
function tessellateBezier(control, transform, scale, output, depth = 0) {
  const points = control.map(p => {
    if (p.length !== 4 || !p.every(Number.isFinite) || p[3] <= 0) throw new Error('A Rhino curve has unsupported non-positive rational weights. Convert it to a polyline in Rhino.');
    return worldPoint(p.slice(0, 3).map(v => v / p[3]), transform, scale);
  });
  if (points.every(p => pointSegmentDistance(p, points[0], points.at(-1)) <= CURVE_TOLERANCE_MM)) {
    output.push(points.at(-1));
    if (output.length > MAX_CURVE_POINTS) throw new Error('The Rhino curves need more than 4,096 outline points. Simplify the curves before importing.');
    return;
  }
  if (depth >= 24) throw new Error('A Rhino curve could not be approximated within 0.1 mm. Convert it to a polyline in Rhino.');
  let row = control.map(p => p.slice());
  const left = [row[0]], right = [row.at(-1)];
  while (row.length > 1) {
    row = row.slice(0, -1).map((p, i) => p.map((v, j) => (v + row[i + 1][j]) / 2));
    left.push(row[0]); right.unshift(row.at(-1));
  }
  tessellateBezier(left, transform, scale, output, depth + 1);
  tessellateBezier(right, transform, scale, output, depth + 1);
}

function curvePoints(curve, transform, scale) {
  if (!curve.isClosed) throw new Error('Curve-only Rhino import requires closed outlines. Join and close the curves in Rhino, or import a mesh.');
  if (!curve.isPlanar()) throw new Error('Curve-only Rhino import requires planar outlines. Non-planar curves do not define an unambiguous shell; create and mesh the surface in Rhino.');
  const polyline = curve.tryGetPolyline();
  if (polyline) {
    try {
      if (polyline.count > MAX_CURVE_POINTS + 1) throw new Error('The Rhino curves have more than 4,096 outline points. Simplify them before importing.');
      return { points: Array.from({ length: polyline.count }, (_, i) => worldPoint(polyline.get(i), transform, scale)), approximated: false };
    } finally { release(polyline); }
  }
  const nurbs = curve.toNurbsCurve();
  if (!nurbs) throw new Error('A Rhino curve could not be converted to a planar outline. Convert it to a polyline in Rhino.');
  let controls;
  const output = [], planarityPoints = [];
  try {
    controls = nurbs.points();
    if (controls.count > MAX_CURVE_POINTS || nurbs.order > 32) throw new Error('A Rhino curve is too complex. Simplify it before importing.');
    for (let span = 0; span <= controls.count - nurbs.order; span++) {
      const bezier = nurbs.convertSpanToBezier(span);
      if (!bezier) continue; // Repeated knots produce empty spans.
      let segment, points;
      try {
        segment = bezier.toNurbsCurve(); points = segment.points();
        const control = Array.from({ length: points.count }, (_, i) => points.get(i));
        for (const p of control) {
          if (p.length !== 4 || !p.every(Number.isFinite) || p[3] <= 0) throw new Error('A Rhino curve has unsupported non-positive rational weights. Convert it to a polyline in Rhino.');
          planarityPoints.push(worldPoint(p.slice(0, 3).map(v => v / p[3]), transform, scale));
        }
        const start = worldPoint(bezier.pointAt(0), transform, scale);
        if (!output.length) output.push(start);
        else if (distance(start, output.at(-1)) > 1e-6) throw new Error('A Rhino outline contains a discontinuity. Join the curve before importing.');
        tessellateBezier(control, transform, scale, output);
      } finally { release(points); release(segment); release(bezier); }
    }
  } finally { release(controls); release(nurbs); }
  if (!output.length) throw new Error('A Rhino curve has no usable spans.');
  return { points: output, planarityPoints, approximated: true };
}

function planarSurface(curves) {
  const rings = curves.map(({ points }) => {
    const clean = points.filter((p, i) => i === 0 || distance(p, points[i - 1]) > 1e-8);
    if (clean.length > 1 && distance(clean[0], clean.at(-1)) < 1e-6) clean.pop();
    if (clean.length < 3) throw new Error('A Rhino curve has no usable closed area.');
    return clean;
  });
  if (rings.reduce((sum, ring) => sum + ring.length, 0) > MAX_CURVE_POINTS) throw new Error('The Rhino curves have more than 4,096 outline points. Simplify them before importing.');
  const origin = rings[0][0];
  let axis, normal;
  for (const p of rings[0]) if (!axis && distance(p, origin) > 1e-8) axis = sub(p, origin);
  for (const p of rings[0]) {
    const candidate = cross(axis, sub(p, origin));
    if (Math.hypot(...candidate) > 1e-8) { normal = candidate.map(v => v / Math.hypot(...candidate)); break; }
  }
  if (!normal) throw new Error('A Rhino curve has no usable closed area.');
  for (const curve of curves) for (const p of curve.planarityPoints || curve.points) {
    if (Math.abs(dot(sub(p, origin), normal)) > PLANE_TOLERANCE_MM) throw new Error('Rhino outlines must lie in one common plane (within 0.01 mm). Create and mesh a surface for non-planar outlines.');
  }
  const u = axis.map(v => v / Math.hypot(...axis)), v = cross(normal, u);
  const projected = rings.map(ring => ring.map(p => {
    const delta = sub(p, origin);
    if (Math.abs(dot(delta, normal)) > PLANE_TOLERANCE_MM) throw new Error('Rhino outlines must lie in one common plane (within 0.01 mm). Create and mesh a surface for outlines on different planes.');
    return [dot(delta, u), dot(delta, v)];
  }));
  const area = ring => ring.reduce((sum, a, i) => { const b = ring[(i + 1) % ring.length]; return sum + a[0] * b[1] - a[1] * b[0]; }, 0) / 2;
  const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const onSegment = (p, a, b) => Math.abs(cross2(a, b, p)) < 1e-8 && p[0] >= Math.min(a[0], b[0]) - 1e-8 && p[0] <= Math.max(a[0], b[0]) + 1e-8 && p[1] >= Math.min(a[1], b[1]) - 1e-8 && p[1] <= Math.max(a[1], b[1]) + 1e-8;
  const intersect = (a, b, c, d) => (cross2(a, b, c) * cross2(a, b, d) < 0 && cross2(c, d, a) * cross2(c, d, b) < 0)
    || onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b);
  const edges = projected.flatMap((ring, r) => ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length], r, i })));
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i], b = edges[j];
    if (a.r === b.r && (Math.abs(a.i - b.i) === 1 || Math.abs(a.i - b.i) === projected[a.r].length - 1)) continue;
    if (intersect(a.a, a.b, b.a, b.b)) throw new Error('Rhino outlines intersect or touch. Use one simple outer boundary with separate, non-touching holes.');
  }
  const inside = (p, ring) => {
    let result = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
    }
    return result;
  };
  const order = projected.map((ring, i) => ({ i, area: Math.abs(area(ring)) })).sort((a, b) => b.area - a.area);
  if (order.some(item => item.area < 1e-8)) throw new Error('A Rhino curve has no usable closed area.');
  const ordered = order.map(({ i }) => projected[i]), world = order.map(({ i }) => rings[i]);
  for (let i = 1; i < ordered.length; i++) {
    if (!inside(ordered[i][0], ordered[0])) throw new Error('Curve-only Rhino import requires one outer outline with holes. Separate outer outlines must be imported as meshed surfaces.');
    for (let j = 1; j < i; j++) if (inside(ordered[i][0], ordered[j]) || inside(ordered[j][0], ordered[i])) throw new Error('Nested islands inside Rhino holes are ambiguous. Create and mesh the surface in Rhino.');
  }
  const vectors = ordered.map(ring => ring.map(p => new Vector2(...p)));
  const triangles = ShapeUtils.triangulateShape(vectors[0], vectors.slice(1));
  const flat = ordered.flat(), expectedArea = order[0].area - order.slice(1).reduce((sum, item) => sum + item.area, 0);
  const triangleArea = triangles.reduce((sum, ids) => sum + Math.abs(cross2(...ids.map(i => flat[i]))) / 2, 0);
  if (!triangles.length || Math.abs(triangleArea - expectedArea) > Math.max(1e-6, expectedArea * 1e-8)) throw new Error('The Rhino outlines could not be triangulated reliably. Create and mesh the surface in Rhino.');
  const vertices = world.flat();
  const result = { vertices, triangles, outlinePointCount: vertices.length };
  refinePlanarSurface(result);
  return result;
}

// Partitioning needs surface samples inside a large outline. Refine every face
// at the same depth and share edge midpoints, preserving holes without T-joints.
function refinePlanarSurface(surface) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const point of surface.vertices) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]);
  }
  const target = distance(min, max) / 20;
  const longestEdge = () => surface.triangles.reduce((longest, face) => Math.max(longest,
    ...face.map((a, i) => distance(surface.vertices[a], surface.vertices[face[(i + 1) % 3]]))), 0);
  while (longestEdge() > target) {
    if (surface.triangles.length * 4 > 50000) { surface.refinementLimited = true; break; }
    const midpoints = new Map(), refined = [];
    const middle = (a, b) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!midpoints.has(key)) {
        midpoints.set(key, surface.vertices.length);
        surface.vertices.push(surface.vertices[a].map((value, axis) => (value + surface.vertices[b][axis]) / 2));
      }
      return midpoints.get(key);
    };
    for (const [a, b, c] of surface.triangles) {
      const ab = middle(a, b), bc = middle(b, c), ca = middle(c, a);
      refined.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    surface.triangles = refined;
  }
}

/** Import all visible model-space surfaces, or closed coplanar outlines when
 * there are no surfaces. Coordinates are normalized to millimetres; Rhino's
 * coordinate axes are retained. No shell is inferred from open/3D curves.
 */
export function parse3DM(bytes, rhino) {
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new Error('The Rhino file must contain binary 3dm data.');
  let doc;
  try { doc = rhino.File3dm.fromByteArray(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
  catch { throw new Error('The Rhino file could not be read. Choose a valid .3dm file.'); }
  if (!doc) throw new Error('The Rhino file could not be read. Choose a valid .3dm file.');
  let objects, definitions, layers, settings;
  try {
    settings = doc.settings();
    const units = unitsInMillimetres(settings.modelUnitSystem, rhino);
    objects = doc.objects(); definitions = doc.instanceDefinitions(); layers = doc.layers();
    if (objects.count > MAX_OBJECTS) throw new Error('The Rhino file contains too many objects. Export only the shell objects from Rhino.');
    const members = new Set(), blocks = new Map(), objectIndices = new Map(), layerById = new Map(), layerByIndex = new Map();
    for (let i = 0; i < definitions.count; i++) {
      const definition = definitions.get(i);
      try { const ids = definition.getObjectIds(); blocks.set(definition.id, ids); for (const id of ids) members.add(id); }
      finally { release(definition); }
    }
    for (let i = 0; i < layers.count; i++) {
      const layer = layers.get(i);
      try { const info = { visible: layer.visible, parent: layer.parentLayerId, id: layer.id }; layerById.set(layer.id, info); layerByIndex.set(layer.index, info); }
      finally { release(layer); }
    }
    const layerVisible = index => {
      let layer = layerByIndex.get(index);
      const seen = new Set();
      while (layer) {
        if (!layer.visible) return false;
        if (seen.has(layer.id)) throw new Error('The Rhino file has a cyclic layer hierarchy.');
        seen.add(layer.id);
        layer = layer.parent === EMPTY_ID ? null : layerById.get(layer.parent);
      }
      return true;
    };
    const roots = [];
    for (let i = 0; i < objects.count; i++) {
      const object = objects.get(i), attributes = object.attributes();
      try { objectIndices.set(attributes.id, i); if (!members.has(attributes.id) && !attributes.isInstanceDefinitionObject) roots.push(i); }
      finally { release(attributes); release(object); }
    }
    const vertices = [], triangles = [], curves = [], warnings = [];
    let visits = 0, ignored = 0, skippedFlat = 0, faces = 0, skippedFaces = 0, surfaceObjects = 0, name = 'Imported Rhino surface';
    function addMesh(mesh, transform, label) {
      if (!mesh) throw new Error(`${label} has no saved render mesh. Run Mesh in Rhino, or save the file after displaying it in Shaded mode, then import again.`);
      const points = mesh.vertices(), meshFaces = mesh.faces();
      try {
        if (!points.count || !meshFaces.count) throw new Error(`${label} has an empty mesh. Export a mesh containing surface faces from Rhino.`);
        if (vertices.length + points.count > MAX_VERTICES) throw new Error('This mesh is too large. Export a lighter Rhino mesh with at most 200,000 vertices.');
        if (triangles.length + meshFaces.triangleCount + 2 * meshFaces.quadCount > MAX_TRIANGLES) throw new Error('This mesh is too large. Export a lighter Rhino mesh with at most 150,000 triangles.');
        const offset = vertices.length, reverse = determinant(transform) < 0;
        for (let i = 0; i < points.count; i++) vertices.push(worldPoint(points.point3dAt(i), transform, units.scale));
        for (let i = 0; i < meshFaces.count; i++) {
          const face = meshFaces.get(i);
          if (face.length !== 4 || face.some(index => !Number.isInteger(index) || index < 0 || index >= points.count)) throw new Error(`${label} has a face that refers to a missing vertex.`);
          const parts = face[2] === face[3] ? [[face[0], face[1], face[2]]] : [[face[0], face[1], face[2]], [face[0], face[2], face[3]]];
          faces++;
          for (const indices of parts) {
            const triangle = indices.map(index => offset + index), [a, b, c] = triangle.map(index => vertices[index]);
            const area = Math.hypot(...cross(sub(b, a), sub(c, a)));
            if (!Number.isFinite(area)) throw new Error(`${label} has coordinates too large for reliable surface calculations.`);
            if (area <= 1e-12) { skippedFaces++; continue; }
            if (reverse) triangle.reverse();
            triangles.push(triangle);
            if (triangles.length > MAX_TRIANGLES) throw new Error('This mesh is too large. Export a lighter Rhino mesh with at most 150,000 triangles.');
          }
        }
      } finally { release(points); release(meshFaces); }
    }
    function visit(index, transform, chain) {
      if (++visits > MAX_OBJECTS) throw new Error('The Rhino block hierarchy expands to too many objects. Export only the shell objects from Rhino.');
      const object = objects.get(index), attributes = object.attributes();
      let geometry;
      try {
        if (!attributes.visible || !layerVisible(attributes.layerIndex) || sameEnum(attributes.activeSpace, rhino.ActiveSpace.PageSpace)) return;
        if (['flat', 'repair-layout'].includes(attributes.getUserString('panel-workbench-placement'))) { skippedFlat++; return; }
        geometry = object.geometry();
        if (!geometry) throw new Error('The Rhino file contains an unreadable object.');
        const type = geometry.objectType, label = attributes.name || 'A Rhino surface';
        if (sameEnum(type, rhino.ObjectType.InstanceReference)) {
          const id = geometry.parentIdefId;
          if (chain.has(id) || chain.size >= 64) throw new Error('The Rhino file contains cyclic or excessively nested blocks.');
          const ids = blocks.get(id);
          if (!ids) throw new Error('A Rhino block references a missing definition. Embed linked blocks in Rhino and save again.');
          const xform = geometry.xform;
          let combined;
          try { combined = multiply(transform, matrixFromRhino(xform)); } finally { release(xform); }
          const det = determinant(combined);
          if (!Number.isFinite(det) || det === 0) throw new Error('A Rhino block has a singular or invalid transform.');
          const next = new Set(chain); next.add(id);
          for (const member of ids) {
            const child = objectIndices.get(member);
            if (child === undefined) throw new Error('A Rhino block references a missing object. Repair the block in Rhino.');
            visit(child, combined, next);
          }
        } else if (sameEnum(type, rhino.ObjectType.Mesh)) {
          surfaceObjects++;
          if (name === 'Imported Rhino surface' && attributes.name) name = attributes.name;
          addMesh(geometry, transform, label);
        } else if (sameEnum(type, rhino.ObjectType.Brep)) {
          surfaceObjects++;
          const brepFaces = geometry.faces();
          try {
            if (!brepFaces.count) throw new Error(`${label} has no surface faces.`);
            for (let i = 0; i < brepFaces.count; i++) {
              const face = brepFaces.get(i); let mesh;
              try { mesh = face.getMesh(rhino.MeshType.Render); addMesh(mesh, transform, `${label}, face ${i + 1}`); }
              finally { release(mesh); release(face); }
            }
          } finally { release(brepFaces); }
          if (name === 'Imported Rhino surface' && attributes.name) name = attributes.name;
        } else if (sameEnum(type, rhino.ObjectType.Extrusion)) {
          surfaceObjects++;
          const mesh = geometry.getMesh(rhino.MeshType.Render);
          try { addMesh(mesh, transform, label); } finally { release(mesh); }
          if (name === 'Imported Rhino surface' && attributes.name) name = attributes.name;
        } else if (sameEnum(type, rhino.ObjectType.Curve)) curves.push({ index, transform, name: attributes.name });
        else if (sameEnum(type, rhino.ObjectType.Surface) || sameEnum(type, rhino.ObjectType.SubD)) {
          throw new Error(`${label} is an unsupported surface type. Run Mesh on it in Rhino and export the resulting mesh as .3dm.`);
        } else ignored++;
      } finally { release(geometry); release(attributes); release(object); }
    }
    for (const index of roots) visit(index, IDENTITY, new Set());
    let result = { vertices, triangles };
    let curveToleranceMm;
    if (!surfaceObjects && curves.length) {
      const outlines = [];
      let pointCount = 0;
      for (const record of curves) {
        const object = objects.get(record.index), geometry = object.geometry();
        try {
          const outline = curvePoints(geometry, record.transform, units.scale);
          pointCount += outline.points.length - 1;
          if (pointCount > MAX_CURVE_POINTS) throw new Error('The Rhino curves have more than 4,096 outline points. Simplify them before importing.');
          outlines.push(outline);
        }
        finally { release(geometry); release(object); }
      }
      result = planarSurface(outlines);
      name = curves.find(record => record.name)?.name || 'Imported Rhino outlines';
      if (outlines.some(outline => outline.approximated)) {
        curveToleranceMm = CURVE_TOLERANCE_MM;
        warnings.push('Curved outlines were approximated by polylines with a maximum chord deviation of 0.1 mm.');
      }
      warnings.push('Closed coplanar curves were filled as one planar surface, preserving enclosed holes.');
      if (result.refinementLimited) warnings.push('Outline surface refinement reached the 50,000-triangle budget; small panel arrangements may need a denser mesh exported from Rhino.');
    } else if (curves.length) warnings.push(`Ignored ${curves.length} curve object(s); imported the visible surfaces.`);
    if (!result.triangles.length) throw new Error('The Rhino file contains no usable visible surfaces or closed planar outlines. Export the shell mesh or closed outlines from Rhino.');
    if (ignored) warnings.push(`Ignored ${ignored} non-surface object(s), such as points, annotations or lights.`);
    if (skippedFlat) warnings.push(`Skipped ${skippedFlat} flat or repair-layout placement(s); imported the assembled model.`);
    if (skippedFaces) warnings.push(`Skipped ${skippedFaces} degenerate mesh triangle(s).`);
    return { ...result, name, warnings, units: 'mm', sourceUnits: units.name, originalFaceCount: faces || result.triangles.length, skippedFaces, ...(curveToleranceMm ? { curveToleranceMm } : {}) };
  } finally { release(settings); release(objects); release(definitions); release(layers); release(doc); }
}
