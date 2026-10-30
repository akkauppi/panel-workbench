/** OBJ import and study exports. Coordinates are kept in the supplied model units. */

const MAX_TRIANGLES = 150000;
const EPS = 1e-12;

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function cross2(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

// Ear clipping preserves concave face outlines. A triangle fan would cut across them.
function triangulateFace(indices, vertices, line) {
  const clean = [];
  for (const index of indices) {
    if (!clean.length || !samePoint(vertices[index], vertices[clean.at(-1)])) clean.push(index);
  }
  if (clean.length > 1 && samePoint(vertices[clean[0]], vertices[clean.at(-1)])) clean.pop();
  if (clean.length < 3) return [];

  const normal = [0, 0, 0];
  for (let i = 0; i < clean.length; i++) {
    const a = vertices[clean[i]], b = vertices[clean[(i + 1) % clean.length]];
    normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
    normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
    normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const drop = Math.abs(normal[0]) > Math.abs(normal[1])
    ? (Math.abs(normal[0]) > Math.abs(normal[2]) ? 0 : 2)
    : (Math.abs(normal[1]) > Math.abs(normal[2]) ? 1 : 2);
  const axes = [0, 1, 2].filter(axis => axis !== drop);
  const points = clean.map(index => [vertices[index][axes[0]], vertices[index][axes[1]]]);
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  for (const p of points) for (let d = 0; d < 2; d++) {
    min[d] = Math.min(min[d], p[d]); max[d] = Math.max(max[d], p[d]);
  }
  const tolerance = Math.max(EPS, (max[0] - min[0]) * (max[1] - min[1]) * EPS);
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    twiceArea += (a[0] - min[0]) * (b[1] - min[1]) - (b[0] - min[0]) * (a[1] - min[1]);
  }
  if (Math.abs(twiceArea) <= tolerance) return [];
  const orientation = Math.sign(twiceArea);
  const remaining = points.map((_, i) => i);
  const triangles = [];
  let attempts = 0;
  while (remaining.length > 3) {
    let clipped = false;
    for (let j = 0; j < remaining.length; j++) {
      const ia = remaining[(j + remaining.length - 1) % remaining.length];
      const ib = remaining[j];
      const ic = remaining[(j + 1) % remaining.length];
      const a = points[ia], b = points[ib], c = points[ic];
      const turn = orientation * cross2(a, b, c);
      if (Math.abs(turn) <= tolerance) {
        remaining.splice(j, 1);
        clipped = true;
        break;
      }
      if (turn < 0) continue;
      const contains = remaining.some(k => {
        if (k === ia || k === ib || k === ic) return false;
        const p = points[k];
        return orientation * cross2(a, b, p) >= -tolerance
          && orientation * cross2(b, c, p) >= -tolerance
          && orientation * cross2(c, a, p) >= -tolerance;
      });
      if (contains) continue;
      triangles.push([clean[ia], clean[ib], clean[ic]]);
      remaining.splice(j, 1);
      clipped = true;
      break;
    }
    if (!clipped || ++attempts > clean.length * 2) {
      throw new Error(`Face on line ${line} has an intersecting or unsupported outline. Export a triangulated OBJ.`);
    }
  }
  if (remaining.length === 3 && Math.abs(cross2(...remaining.map(i => points[i]))) > tolerance) {
    triangles.push(remaining.map(i => clean[i]));
  }
  return triangles;
}

/** Read an OBJ surface without closing its open boundaries or welding touching parts. */
export function parseOBJ(text) {
  if (typeof text !== 'string') throw new Error('The OBJ file must contain text.');
  const vertices = [], faces = [];
  let name = 'Imported surface';
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].split('#', 1)[0].trim();
    if (!raw) continue;
    const fields = raw.split(/\s+/), command = fields.shift();
    if (command === 'v') {
      if (fields.length < 3) throw new Error(`Vertex on line ${i + 1} needs three coordinates.`);
      const point = fields.slice(0, 3).map(Number);
      if (!point.every(Number.isFinite)) throw new Error(`Vertex on line ${i + 1} has an invalid coordinate.`);
      vertices.push(point);
      if (vertices.length > 200000) throw new Error('This mesh is too large for the demo. Export a lighter mesh with fewer than 200,000 vertices.');
    } else if (command === 'f') {
      if (fields.length < 3) throw new Error(`Face on line ${i + 1} needs at least three vertices.`);
      if (fields.length > 4096) throw new Error(`Face on line ${i + 1} has too many corners. Export a triangulated OBJ.`);
      const indices = fields.map(field => {
        const token = field.split('/')[0];
        if (!/^[+-]?\d+$/.test(token)) throw new Error(`Invalid face index on line ${i + 1}.`);
        const value = Number(token);
        if (!Number.isSafeInteger(value) || value === 0) throw new Error(`Invalid face index on line ${i + 1}.`);
        return value < 0 ? vertices.length + value : value - 1;
      });
      faces.push({ indices, line: i + 1 });
    } else if ((command === 'o' || command === 'g') && name === 'Imported surface' && fields.length) {
      name = fields.join(' ');
    }
  }
  if (!vertices.length || !faces.length) throw new Error('The OBJ file contains no surface faces. Export a mesh that includes faces.');
  const triangles = [];
  let skippedFaces = 0;
  for (const face of faces) {
    if (face.indices.some(index => index < 0 || index >= vertices.length)) throw new Error(`Face on line ${face.line} refers to a missing vertex.`);
    const result = triangulateFace(face.indices, vertices, face.line);
    if (!result.length) skippedFaces++;
    triangles.push(...result);
    if (triangles.length > MAX_TRIANGLES) throw new Error('This mesh is too large for the demo. Export a lighter mesh with fewer than 150,000 triangles.');
  }
  if (!triangles.length) throw new Error('The OBJ contains no usable surface area.');
  return { vertices, triangles, name, originalFaceCount: faces.length, skippedFaces };
}

function number(value) {
  if (!Number.isFinite(value)) throw new Error('The geometry contains a non-finite coordinate.');
  return String(Number(value.toFixed(6)));
}

function labelFor(cell, index) {
  if (Number.isInteger(cell.id) && cell.id >= 0) return `P${String(cell.id + 1).padStart(3, '0')}`;
  return `P${String(index + 1).padStart(3, '0')}`;
}

/** Export the same fitted panel geometry shown in the flat-panel preview. */
export function exportCellsOBJ(cells, options = {}) {
  if (!Array.isArray(cells) || !cells.length) throw new Error('There are no cells to export yet.');
  const flat = options.flat !== false;
  const explode = Number(options.explode || 0);
  if (!Number.isFinite(explode)) throw new Error('Invalid explode distance.');
  const lines = [
    '# Panel Workbench cell layout', '# Units: millimetres',
    '# Panel study; review geometry and joint detailing before fabrication.',
    `# Geometry: ${flat ? (cells.every(c => c.fittedShared) ? 'jointly fitted panels with shared borders' : 'flat panel candidates') : 'cells on the original surface'}`,
    '# Surface layouts and flat outlines are design geometry, not CNC toolpaths.'
  ];
  let offset = 1;
  for (let ci = 0; ci < cells.length; ci++) {
    const cell = cells[ci], positions = flat ? cell.flatPositions : cell.positions;
    if (!positions?.length || !cell.triangles?.length) throw new Error(`Cell ${ci + 1} has no geometry to export.`);
    const normal = cell.plane?.normal || [0, 0, 0];
    lines.push(`o ${labelFor(cell, ci)}`, `g ${labelFor(cell, ci)}`);
    for (const p of positions) lines.push(`v ${p.map((v, axis) => number(v + normal[axis] * explode)).join(' ')}`);
    for (const triangle of cell.triangles) {
      if (triangle.length !== 3 || triangle.some(v => !Number.isInteger(v) || v < 0 || v >= positions.length)) {
        throw new Error(`Cell ${ci + 1} has an invalid face.`);
      }
      lines.push(`f ${triangle.map(v => v + offset).join(' ')}`);
    }
    offset += positions.length;
  }
  return `${lines.join('\n')}\n`;
}

/** Arrange 2D outline studies in rows. This is not sheet nesting or a toolpath. */
export function exportCellsDXF(cells, options = {}) {
  if (!Array.isArray(cells) || !cells.length) throw new Error('There are no cells to export yet.');
  const spacing = Number(options.spacing ?? 60), sheetWidth = Number(options.sheetWidth ?? 2440);
  if (!(spacing > 0) || !(sheetWidth > 0) || !Number.isFinite(spacing + sheetWidth)) throw new Error('Invalid outline layout dimensions.');
  const lines = [];
  const add = (code, value) => lines.push(String(code), String(value));
  add(999, 'Panel outline study; joint detailing and tool allowances not included.');
  add(999, 'Outline arrangement is indicative, not optimized sheet nesting or a CNC toolpath.');
  add(0, 'SECTION'); add(2, 'HEADER');
  add(9, '$ACADVER'); add(1, 'AC1015');
  add(9, '$INSUNITS'); add(70, 4);
  add(9, '$MEASUREMENT'); add(70, 1);
  add(9, '$LUNITS'); add(70, 2);
  add(9, '$LUPREC'); add(70, 3);
  add(0, 'ENDSEC');
  add(0, 'SECTION'); add(2, 'TABLES');
  add(0, 'TABLE'); add(2, 'LAYER'); add(70, cells.length);
  cells.forEach((cell, index) => {
    add(0, 'LAYER'); add(100, 'AcDbSymbolTableRecord'); add(100, 'AcDbLayerTableRecord');
    add(2, labelFor(cell, index)); add(70, 0); add(62, 7); add(6, 'CONTINUOUS');
  });
  add(0, 'ENDTAB'); add(0, 'ENDSEC');
  add(0, 'SECTION'); add(2, 'ENTITIES');
  let x = 0, y = 0, rowHeight = 0;
  cells.forEach((cell, index) => {
    if (!cell.outline2d?.length) throw new Error(`Cell ${index + 1} has no closed outline to export.`);
    const rings = cell.outline2d.map(ring => {
      const copy = ring.slice();
      if (copy.length > 1 && copy[0][0] === copy.at(-1)[0] && copy[0][1] === copy.at(-1)[1]) copy.pop();
      if (copy.length < 3 || copy.some(p => p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
        throw new Error(`Cell ${index + 1} has an invalid outline.`);
      }
      return copy;
    });
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) for (const [u, v] of ring) {
      minX = Math.min(minX, u); minY = Math.min(minY, v);
      maxX = Math.max(maxX, u); maxY = Math.max(maxY, v);
    }
    const width = maxX - minX, height = maxY - minY;
    if (x > 0 && x + width > sheetWidth) { x = 0; y += rowHeight + spacing; rowHeight = 0; }
    const label = labelFor(cell, index);
    for (const ring of rings) {
      add(0, 'LWPOLYLINE'); add(100, 'AcDbEntity'); add(8, label); add(100, 'AcDbPolyline');
      add(90, ring.length); add(70, 1); add(38, 0);
      for (const [u, v] of ring) { add(10, number(x + u - minX)); add(20, number(y + v - minY)); }
    }
    add(0, 'TEXT'); add(100, 'AcDbEntity'); add(8, label); add(100, 'AcDbText');
    add(10, number(x)); add(20, number(y + height + spacing * 0.25)); add(30, 0);
    add(40, number(Math.min(14, spacing * 0.3))); add(1, label);
    x += width + spacing;
    rowHeight = Math.max(rowHeight, height);
  });
  add(0, 'ENDSEC'); add(0, 'EOF');
  return `${lines.join('\r\n')}\r\n`;
}
