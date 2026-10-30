import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseOBJ, exportCellsOBJ, exportCellsDXF } from './io.js';
import { analyzeModel, createMergeGroups } from './geometry.js';
import { exportSolidsOBJ, exportSolidsSTL } from './solids.js';
import { captureDesign, createStudy, readStudy, immutableLayout } from './study.js';
import { cornerDisplayPosition, cornerProjectionPatch, projectCornerDisplacement } from './corner-drag.js';
import { previewCornerMove, createCornerSketch, layoutCellHandle, previewCellSplit } from './layout-edit.js';
import { initLaserUI } from './laser-ui.js';
import { nextLayoutCellId } from './layout.js';
import { EXAMPLES, DEFAULT_EXAMPLE_ID, createExample } from './examples.js';
import { LOCAL_EXAMPLES } from './local-examples.js';
import { createSolidGeometry } from './rendering.js';
import { readPattern } from './pattern.js';
import { verifyRhino6Export } from './rhino-format.js';

const exampleCatalog = [...EXAMPLES, ...LOCAL_EXAMPLES];

const $ = id => document.getElementById(id);
const state = {
  rawModel: null, model: null, analysis: null, seeds: [], cells: [], result: null, layout: null, sourceSurface: null,
  name: 'Synthetic example', view: 'surface', color: 'timber', selected: null, selectedIds: [], multiSelect: false, mergeGroups: [],
  cornerEdits: [], cornerMode: false, splitMode: false, nextCellId: 0, selectedCorner: null, directBase: null, allowCellRemoval: true, lastLayoutChange: null,
  size: Number($('size').value), variation: Number($('variation').value) / 100,
  pattern: readPattern(), generating: false,
  randomSeed: 7, edit: true, explode: 0, history: [], future: [], ready: false,
  straightness: 0.7, thickness: 40, roundover: 2, carve: false, minimumThickness: 12, flipOutside: false,
  revision: 0, requested: 0, busy: false, pending: null, modelRevision: 0, solved: false
};
const laserUI = initLaserUI({ download });
const viewport = $('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e5e9ee');
let renderer;
try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); }
catch (error) { $('loading').hidden = true; $('status').textContent = '3D viewing needs WebGL. Enable hardware acceleration in your browser, then reload.'; throw error; }
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.domElement.setAttribute('aria-label', 'Panel workspace: drag handles to edit cells and corners, drag empty space to orbit');
renderer.domElement.tabIndex = 0;
renderer.domElement.style.touchAction = 'none';
viewport.append(renderer.domElement);
const camera = new THREE.PerspectiveCamera(36, 1, 1, 100000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.screenSpacePanning = true;
controls.maxPolarAngle = Math.PI * 0.97;
scene.add(new THREE.HemisphereLight(0xffffff, 0x95a1b0, 2.1));
const sunlight = new THREE.DirectionalLight(0xffffff, 2.5);
scene.add(sunlight);
const fill = new THREE.DirectionalLight(0xe1edff, 1.0);
scene.add(fill);
const cellGroup = new THREE.Group(), seedGroup = new THREE.Group(), referenceGroup = new THREE.Group();
const junctionGroup = new THREE.Group(), cornerGroup = new THREE.Group(), cornerGuide = new THREE.Group();
const cornerSketchGroup = new THREE.Group();
scene.add(cellGroup, seedGroup, referenceGroup, junctionGroup, cornerGroup, cornerGuide, cornerSketchGroup);
let sourceMesh, grid, seedGeometry, seedMaterial;
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
const worker = new Worker('./worker.js', { type: 'module' });
const validationWorker = new Worker('./worker.js', { type: 'module' });
let rhinoWorker = null;
const rhinoRequests = new Map();
let rhinoSequence = 0, exportingRhino = false;
let diagnosticResult = null, diagnosticWaiting = null;
function rhinoOperation(inputs) {
  if (!rhinoWorker) {
    rhinoWorker = new Worker('./rhino-worker.js', { type: 'module' });
    rhinoWorker.onmessage = ({data}) => {
      const pending=rhinoRequests.get(data.id);rhinoRequests.delete(data.id);
      if(data.error)pending?.reject(new Error(data.error));else pending?.resolve(data);
    };
    rhinoWorker.onerror = error => {
      for(const pending of rhinoRequests.values())pending.reject(new Error(error.message));
      rhinoRequests.clear();rhinoWorker.terminate();rhinoWorker=null;
    };
  }
  const id=++rhinoSequence;
  return new Promise((resolve,reject)=>{rhinoRequests.set(id,{resolve,reject});rhinoWorker.postMessage({id,...inputs});});
}
const studyValidations = new Map();
let validationSequence = 0, studyOpenRevision = 0, generationSequence = 0;
let cornerPending = null, cornerSequence = 0;
const vectors = a => new THREE.Vector3(...a);
const mm = value => Number.isFinite(value) ? `${value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString()} mm` : '—';
const panelId = id => `P${String(Number(id) + 1).padStart(3, '0')}`;
const viewNames = { surface: 'Cells', flat: 'Flat panels', solid: 'Solid panels', reference: 'Original surface' };

function updateWorkspaceChrome() {
  $('document-name').textContent = state.name;
  document.title = `${state.name} — Panel Workbench`;
  $('view-name').textContent = viewNames[state.view];
  $('active-tool-name').textContent = state.view === 'reference' ? 'Inspect source' : state.splitMode ? 'Divide cell' : state.cornerMode ? 'Drag corners' : state.multiSelect ? 'Select cells' : state.edit ? 'Move cells' : 'Inspect cells';
  $('ribbon-selection-context').textContent = state.selectedIds.length > 1 ? `${state.selectedIds.length} cells selected`
    : state.selected != null ? `Cell ${panelId(state.selected)}` : 'No selection';
  for (const button of document.querySelectorAll('[data-browser-view]')) {
    const active = button.dataset.browserView === state.view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function activateRibbon(name, focus = false) {
  const tabs = [...document.querySelectorAll('[data-ribbon-tab]')];
  const selected = tabs.find(tab => tab.dataset.ribbonTab === name);
  if (!selected) return;
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    tab.classList.toggle('is-active', active);
  }
  for (const panel of document.querySelectorAll('[data-ribbon-panel]')) panel.hidden = panel.dataset.ribbonPanel !== name;
  if (focus) selected.focus();
}

for (const tab of document.querySelectorAll('[data-ribbon-tab]')) {
  tab.addEventListener('click', () => activateRibbon(tab.dataset.ribbonTab, true));
  tab.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('[data-ribbon-tab]')], index = tabs.indexOf(tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    activateRibbon(tabs[next].dataset.ribbonTab, true);
  });
}
activateRibbon('modify');

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').style.color = error ? '#9d462b' : '';
}
function setBusy(busy) {
  $('loading').hidden = !busy || state.ready;
  $('stage').classList.toggle('is-calculating', busy);
  for (const id of ['export-obj', 'export-dxf', 'export-stl', 'export-selected-dxf', 'export-selected-obj', 'save-study']) $(id).disabled = busy || !state.cells.length;
  updateExportAvailability();
  updateEditAvailability();
}
function requestLayout({ fresh = false, newModel = false, preserveSource = false } = {}) {
  if (!state.model) return;
  cancelCornerDrag();
  cancelCornerPending();
  if (fresh) { state.seeds = []; state.mergeGroups = []; state.cornerEdits = []; state.layout = null; state.directBase = null; state.lastLayoutChange = null; state.selectedCorner = null; state.selected = null; state.selectedIds = []; }
  if (!preserveSource) state.sourceSurface = null;
  state.requested++;
  state.solved = false;
  state.pending = { id: state.requested, model: newModel ? state.model : undefined,
    size: state.size, variation: state.variation, randomSeed: state.randomSeed, pattern: state.pattern,
    straightness: state.straightness, thickness: state.thickness, roundover: state.roundover,
    carve: state.carve, minimumThickness: state.minimumThickness, flipOutside: state.flipOutside,
    seeds: state.seeds.length ? state.seeds.map(s => ({ ...s, position: [...s.position] })) : null,
    mergeGroups: structuredClone(state.mergeGroups),
    cornerEdits: structuredClone(state.cornerEdits),
    layout: state.layout,
    modelRevision: state.modelRevision };
  // Always carry a new model forward if a user edits while its first solve is pending.
  if (newModel) state.workerNeedsModel = true;
  setBusy(true);
  setStatus(preserveSource ? 'Layout accepted · Fitting panels in the background…' : 'Updating the cells…');
  dispatch();
}
function dispatch() {
  if (state.busy || !state.pending) return;
  const request = state.pending;
  state.pending = null;
  if (state.workerNeedsModel) { request.model = state.model; state.workerNeedsModel = false; }
  state.busy = true;
  worker.postMessage(request);
}
worker.onmessage = ({ data }) => {
  if (data.validationId !== undefined) {
    const pending = studyValidations.get(data.validationId);
    studyValidations.delete(data.validationId);
    if (data.error) pending?.reject(new Error(data.error)); else pending?.resolve({ layout: data.layout, change: data.change, surface: data.surface });
    return;
  }
  state.busy = false;
  if (data.id === state.requested) {
    if (data.error) { state.solved = false; setStatus(data.error, true); $('loading').hidden = true; }
    else {
      if (!drag) state.seeds = data.seeds;
      state.layout = immutableLayout(data.layout);
      state.nextCellId = Math.max(state.nextCellId, nextLayoutCellId(state.layout));
      state.sourceSurface = null;
      state.result = data.result;
      state.cells = data.result.cells;
      if (!data.result.corners?.some(corner => corner.id === state.selectedCorner)) state.selectedCorner = null;
      state.selectedIds = state.selectedIds.filter(id => state.cells.some(c => c.id === id));
      state.selected = state.selectedIds.includes(state.selected) ? state.selected : state.selectedIds.at(-1) ?? null;
      state.analysis = data.analysis;
      state.ready = true;
      state.solved = true;
      state.revision++;
      if (!directDrag() && !cornerPending) {
        buildCells();
        if (!drag) buildSeeds();
        buildCorners();
        updateInspector(); updateStats();
        setStatus(`${state.cells.length} cells · ${state.splitMode ? 'Drag inside the selected cell to divide it · Escape cancels' : state.cornerMode ? 'Drag a shared corner · Release to apply · Escape cancels' : state.multiSelect ? 'Click cells to add or remove them from the selection' : state.edit ? 'Drag a dot to reshape · Shift-click cells to merge' : 'Click a panel to inspect · Drag the model to orbit'}`);
      }
    }
  }
  if (state.pending) dispatch();
  else { setBusy(false); updateExportAvailability(); }
};
validationWorker.onmessage = worker.onmessage;
validationWorker.onerror = error => {
  for (const pending of studyValidations.values()) pending.reject(new Error(error.message));
  studyValidations.clear();
};
worker.onerror = error => {
  for (const pending of studyValidations.values()) pending.reject(new Error(error.message));
  studyValidations.clear();
  state.busy = false; state.pending = null; state.solved = false;
  $('loading').hidden = true; setBusy(false); updateExportAvailability();
  setStatus(`Could not calculate cells: ${error.message}`, true);
};

function geometry(positions, triangles) {
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions.flat(), 3));
  result.setIndex(triangles.flat());
  result.computeVertexNormals();
  return result;
}
function disposeGroup(group) {
  while (group.children.length) {
    const object = group.children[0];
    group.remove(object);
    if (object.geometry !== seedGeometry) object.geometry?.dispose();
    if (object.material !== seedMaterial) {
      if (Array.isArray(object.material)) object.material.forEach(m => m.dispose());
      else object.material?.dispose();
    }
  }
}
function panelColor(id) {
  const colors = ['#bac5d0', '#d4dce4', '#aebac7', '#c9d2dc', '#b8c3cf', '#dde3e9', '#c4ced8', '#b1bdcb'];
  return new THREE.Color(colors[((Number(id) * 13) % colors.length + colors.length) % colors.length]);
}
function cellColor(cell) {
  if (state.selectedIds.includes(cell.id)) return new THREE.Color('#8eb3e5');
  if (state.color === 'fit') {
    const color = new THREE.Color('#5d9781');
    const t = Math.min(1, cell.maxDeviation / 80);
    return t < 0.5 ? color.lerp(new THREE.Color('#e3c477'), t * 2) : new THREE.Color('#e3c477').lerp(new THREE.Color('#b95e48'), (t - 0.5) * 2);
  }
  return panelColor(cell.id);
}
function explodeDistance() { return state.explode / 100 * state.size * 0.9; }
function arrangementCells() { return state.view === 'surface' && state.sourceSurface ? state.sourceSurface.cells : state.cells; }
function arrangementCorners() { return state.view === 'surface' && state.sourceSurface ? state.sourceSurface.corners : state.result?.corners || []; }
function canArrange() {
  const sourceReady = state.view === 'surface' && !!state.sourceSurface;
  return !state.generating && !cornerPending && (sourceReady || state.solved && !state.busy && !state.pending);
}
function graphCentreMode() { return !!state.directBase || !!state.cornerEdits.length || !!state.mergeGroups.length || state.pattern.type !== 'organic'; }
function directDrag() { return drag?.kind === 'corner' || drag?.kind === 'cell' || drag?.kind === 'split'; }
function buildCells() {
  disposeGroup(cellGroup);
  for (const cell of arrangementCells()) {
    const surface = state.sourceSurface?.cells.find(c => c.id === cell.id) || state.result?.surfaceCells?.find(c => c.id === cell.id) || cell;
    const solid = state.result?.solids?.find(s => s.id === cell.id);
    const displayed = state.view === 'surface' ? surface : state.view === 'solid' && solid?.positions?.length ? solid : cell;
    const positions = state.view === 'surface' ? displayed.positions : state.view === 'solid' && displayed === solid ? solid.positions : cell.flatPositions;
    const unresolved = state.view === 'solid' ? !solid?.valid : state.view === 'flat' ? !cell.valid : false;
    const mesh = new THREE.Mesh(state.view === 'solid' && displayed === solid ? createSolidGeometry(solid) : geometry(positions, displayed.triangles), new THREE.MeshStandardMaterial({
      color: unresolved && !state.selectedIds.includes(cell.id) ? '#ce8c74' : cellColor(cell), roughness: 0.91, metalness: 0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }));
    mesh.userData.cellId = cell.id;
    mesh.userData.unresolved = unresolved;
    const offset = vectors(state.view === 'solid' && solid?.plane ? solid.plane.normal : cell.plane.normal).multiplyScalar(explodeDistance());
    mesh.position.copy(offset);
    cellGroup.add(mesh);
    const edges = [];
    const edgeCell = state.view === 'surface' ? surface : cell;
    const edgePositions = state.view === 'surface' ? surface.positions : cell.flatPositions;
    if (state.view !== 'solid') for (const loop of edgeCell.loops) for (let i = 0; i < loop.length; i++) edges.push(...edgePositions[loop[i]], ...edgePositions[loop[(i + 1) % loop.length]]);
    const outline = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(edges, 3)), new THREE.LineBasicMaterial({ color: state.selectedIds.includes(cell.id) ? '#245db4' : '#657484', transparent: true, opacity: state.selectedIds.includes(cell.id) ? 1 : 0.69 }));
    outline.position.copy(offset);
    outline.userData.outline = true;
    outline.userData.cellId = cell.id;
    cellGroup.add(outline);
  }
  cellGroup.visible = state.view !== 'reference';
  disposeGroup(junctionGroup);
  if (state.result && state.view !== 'reference' && state.explode === 0) {
    const junctions = state.view === 'surface' ? state.result.surfaceJunctions || [] : state.result.junctions || [];
    for (const junction of junctions.filter(j => j.kind === 'T')) {
      const size = Math.max(...state.analysis.dimensions) * .008;
      const marker = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial({ color: '#a36a21' }));
      marker.position.fromArray(junction.position); junctionGroup.add(marker);
    }
  }
  junctionGroup.visible = !state.cornerMode;
  updateReference();
}
function buildSeeds() {
  disposeGroup(seedGroup);
  if (!state.analysis) { seedGroup.visible = false; return; }
  const radius = state.analysis.dimensions.reduce((a, b) => Math.max(a, b), 1) * 0.0045;
  seedGeometry?.dispose(); seedMaterial?.dispose();
  seedGeometry = new THREE.BoxGeometry(radius * 1.7, radius * 1.7, radius * 1.7);
  seedMaterial = new THREE.MeshBasicMaterial({ color: '#245db4' });
  const mergedMembers = new Set(state.mergeGroups.flatMap(group => group.members));
  const graph = graphCentreMode();
  const handles = graph ? (state.layout?.cells || []).flatMap(cell => {
    try { return [{ id: cell.id, ...layoutCellHandle(state.layout, cell.id) }]; } catch { return []; }
  }) : state.seeds;
  for (const seed of handles) {
    if (!graph && mergedMembers.has(seed.id)) continue;
    const dot = new THREE.Mesh(seedGeometry, seedMaterial);
    dot.position.fromArray(seed.position);
    if (state.view === 'flat' || state.view === 'solid') {
      const cell = state.cells.find(c => c.id === seed.id);
      if (cell) {
        const plane = state.view === 'solid' ? state.result?.solids?.find(s => s.id === seed.id)?.plane || cell.plane : cell.plane;
        const n = vectors(plane.normal);
        const distance = n.dot(dot.position.clone().sub(vectors(plane.origin)));
        dot.position.addScaledVector(n, -distance + (state.view === 'solid' ? state.thickness / 2 : 0));
      }
    }
    dot.userData.seedId = seed.id;
    if (graph) dot.userData.cellHandle = seed;
    seedGroup.add(dot);
  }
  seedGroup.visible = $('show-seeds').checked && !state.cornerMode && state.view !== 'reference' && state.explode === 0;
}
function buildCorners() {
  disposeGroup(cornerGroup);
  if (!state.analysis) return;
  const radius = Math.max(...state.analysis.dimensions) * .006;
  for (const corner of arrangementCorners()) {
    const position = cornerDisplayPosition(corner, state.view, camera.position.toArray());
    if (!position) continue;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(radius * 1.7, radius * 1.7, radius * 1.7), new THREE.MeshBasicMaterial({ color: corner.id === state.selectedCorner ? '#19498e' : corner.boundary ? '#a36a21' : '#245db4' }));
    handle.position.fromArray(position);
    handle.userData.cornerId = corner.id;
    handle.userData.corner = corner;
    cornerGroup.add(handle);
  }
  cornerGroup.visible = state.cornerMode && state.view !== 'reference' && state.explode === 0;
  cornerGroup.updateMatrixWorld(true);
}
function updateCornerPositions() {
  if (!cornerGroup.visible || state.view !== 'solid' || directDrag() || cornerPending) return;
  const cameraPosition = camera.position.toArray();
  for (const handle of cornerGroup.children) {
    const position = cornerDisplayPosition(handle.userData.corner, state.view, cameraPosition);
    if (position) handle.position.fromArray(position);
  }
  cornerGroup.updateMatrixWorld(true);
}
function drawCornerGuide(from, to) {
  disposeGroup(cornerGuide);
  const geometry = new THREE.BufferGeometry().setFromPoints([vectors(from), vectors(to)]);
  const line = new THREE.Line(geometry, new THREE.LineDashedMaterial({ color: '#3976b5', dashSize: state.size * .03, gapSize: state.size * .02, depthTest: false }));
  line.computeLineDistances(); cornerGuide.add(line);
}

let sketchHidden = [];
function clearCornerSketch() {
  for (const object of sketchHidden) object.visible = true;
  sketchHidden = [];
  disposeGroup(cornerSketchGroup);
}
function paintCornerSketch() {
  if (drag?.kind !== 'corner' || !drag.sketchDirty || !drag.sketch) return;
  drag.sketchDirty = false;
  clearCornerSketch();
  const sketch = drag.sketch(drag.target);
  const affected = new Set(sketch.cells.map(cell => cell.id));
  for (const object of cellGroup.children) if (affected.has(object.userData.cellId)) {
    object.visible = false; sketchHidden.push(object);
  }
  const issue = drag.snapCornerId ? null : sketch.issue;
  const color = issue ? '#b44732' : '#3976b5';
  for (const cell of sketch.cells) {
    const buffer = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(cell.positions.flat(),3));
    const mesh = new THREE.Mesh(buffer, new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide,transparent:true,opacity:.48,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));
    mesh.userData.cellId = cell.id; mesh.userData.cornerSketch = true;
    cornerSketchGroup.add(mesh);
  }
  const line = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(sketch.segments.flat(),3)),new THREE.LineBasicMaterial({color,depthTest:false}));
  line.renderOrder = 2; line.userData.cornerSketch = true; cornerSketchGroup.add(line);
  if (issue) $('corner-status').textContent = `Move needs checking: ${issue} Escape cancels.`;
}

function updateReference() {
  referenceGroup.visible = state.view === 'reference' || $('show-original').checked;
  for (const mesh of referenceGroup.children) {
    mesh.material.opacity = state.view === 'reference' ? 1 : 0.16;
    mesh.material.depthWrite = state.view === 'reference';
    mesh.material.wireframe = state.view !== 'reference';
  }
}
function cameraDirections() {
  return $('model-up').value === 'z'
    ? { iso: [1.1, -1.6, .8], top: [0, -1e-6, 1], front: [0, -1, 0], right: [1, 0, 0] }
    : { iso: [1.2, .65, 1.7], top: [0, 1, 1e-6], front: [0, 0, 1], right: [1, 0, 0] };
}
function updateCameraButtons() {
  const direction = camera.position.clone().sub(controls.target).normalize(), directions = cameraDirections();
  for (const button of document.querySelectorAll('[data-camera-view]')) {
    const expected = directions[button.dataset.cameraView];
    const active = expected && direction.dot(vectors(expected).normalize()) > 1 - 1e-8;
    button.classList.toggle('is-active', !!active);
    button.setAttribute('aria-pressed', String(!!active));
  }
}
controls.addEventListener('change', updateCameraButtons);
function fitView(preset = 'iso') {
  if (!state.analysis) return;
  // Finish damping before applying a named view so an old orbit/pan cannot
  // pull the camera away from the requested direction on the next frame.
  const damping = controls.enableDamping;
  controls.enableDamping = false; controls.update(); controls.enableDamping = damping;
  const previousDirection = camera.position.clone().sub(controls.target).normalize();
  const { center, dimensions } = state.analysis;
  const diagonal = Math.hypot(...dimensions), zUp = $('model-up').value === 'z';
  camera.up.set(0, zUp ? 0 : 1, zUp ? 1 : 0);
  controls._quat.setFromUnitVectors(camera.up, new THREE.Vector3(0, 1, 0));
  controls._quatInverse.copy(controls._quat).invert();
  controls.target.fromArray(center);
  const rect = viewport.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) camera.aspect = rect.width / rect.height;
  const direction = preset ? vectors(cameraDirections()[preset] || cameraDirections().iso).normalize() : previousDirection;
  const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
  const screenUp = new THREE.Vector3().crossVectors(direction, right).normalize();
  const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * .84, horizontal = vertical * camera.aspect;
  let distance = diagonal * .5;
  // Account for perspective depth and both field-of-view limits. A diagonal
  // multiplier alone crops wide, shallow examples and narrow viewports.
  for (const position of state.model.vertices) {
    const point = vectors(position).sub(vectors(center)), depth = point.dot(direction);
    distance = Math.max(distance, depth + Math.abs(point.dot(right)) / horizontal, depth + Math.abs(point.dot(screenUp)) / vertical);
  }
  camera.position.copy(vectors(center)).addScaledVector(direction, distance);
  camera.near = Math.max(0.01, diagonal / 3000);
  camera.far = diagonal * 100;
  camera.updateProjectionMatrix();
  controls.minDistance = diagonal * 0.08;
  controls.maxDistance = diagonal * 15;
  controls.update();
  updateCameraButtons();
}
function buildReference() {
  disposeGroup(referenceGroup);
  sourceMesh?.geometry.dispose(); sourceMesh?.material.dispose();
  const buffer = geometry(state.model.vertices, state.model.triangles);
  sourceMesh = new THREE.Mesh(buffer, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  sourceMesh.updateMatrixWorld();
  referenceGroup.add(new THREE.Mesh(buffer.clone(), new THREE.MeshStandardMaterial({ color: '#c0c7d0', side: THREE.DoubleSide, roughness: 0.9, transparent: true })));
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  const { center, bounds, dimensions } = state.analysis;
  const diagonal = Math.hypot(...dimensions), zUp = $('model-up').value === 'z';
  grid = new THREE.GridHelper(diagonal * 1.5, 24, '#adb8c5', '#cbd3de');
  grid.material.transparent = true; grid.material.opacity = 0.38;
  grid.position.fromArray(center);
  if (zUp) { grid.rotation.x = Math.PI / 2; grid.position.z = bounds.min[2] - 10; }
  else grid.position.y = bounds.min[1] - 10;
  scene.add(grid);
  sunlight.position.copy(vectors(center)).add(new THREE.Vector3(diagonal, diagonal * 2, diagonal));
  fill.position.copy(vectors(center)).add(new THREE.Vector3(-diagonal, diagonal, -diagonal));
  sunlight.target.position.fromArray(center); fill.target.position.fromArray(center);
  scene.add(sunlight.target, fill.target);
  document.querySelector('.compass-mark').firstChild.textContent = zUp ? 'Z' : 'Y';
  updateReference();
}
function loadModel(rawModel, name, { seeds = null, mergeGroups = [], cornerEdits = [], layout = null, directBase = null, nextCellId = 0, preserveSettings = false, initialSize = null, pattern } = {}) {
  const factor = { mm: 1, cm: 10, m: 1000 }[$('model-units').value];
  const model = { vertices: rawModel.vertices.map(p => p.map(x => x * factor)), triangles: rawModel.triangles.map(t => [...t]) };
  if (model.vertices.some(p => p.length !== 3) || model.triangles.some(t => t.length !== 3 || t.some(i => !Number.isInteger(i) || i < 0 || i >= model.vertices.length))) throw new Error('The model contains invalid face indices or coordinates.');
  const analysis = analyzeModel(model);
  cancelCornerDrag(); cancelCentreDrag(); cancelCornerPending();
  $('import-note').textContent = ''; $('import-note').hidden = true;
  state.rawModel = rawModel; state.name = name; state.model = model; state.analysis = analysis;
  cancelPendingEdit();
  generationSequence++; state.generating = false;
  state.sourceSurface = null;
  state.modelRevision++; state.selected = null; state.selectedIds = []; state.history = []; state.future = []; state.ready = false; state.cells = []; state.result = null;
  state.mergeGroups = structuredClone(mergeGroups);
  state.cornerEdits = structuredClone(cornerEdits); state.selectedCorner = null;
  state.seeds = seeds || [];
  state.layout = immutableLayout(layout);
  state.nextCellId = Math.max(nextCellId, nextLayoutCellId(layout), nextLayoutCellId(directBase), ...state.seeds.map(seed => seed.id + 1));
  state.splitMode = false; $('split-cell').setAttribute('aria-pressed', 'false');
  state.directBase = immutableLayout(directBase); state.lastLayoutChange = null;
  if ((directBase || cornerEdits.length) && state.edit) {
    state.edit = false; state.cornerMode = true; state.multiSelect = false;
    $('edit-toggle').setAttribute('aria-pressed', 'false');
    $('corner-toggle').setAttribute('aria-pressed', 'true');
    $('multi-select').setAttribute('aria-pressed', 'false');
  }
  disposeGroup(cellGroup); disposeGroup(seedGroup); disposeGroup(cornerGroup);
  if (!preserveSettings) {
    state.pattern = readPattern(pattern);
    const ideal = initialSize ?? Math.sqrt(state.analysis.area / 130 / 0.866);
    const step = initialSize === null ? Math.max(1, Math.round(ideal / 50)) : 1;
    const low = Math.max(step, Math.floor(ideal * .4 / step) * step), high = Math.max(low + step, Math.ceil(ideal * 2.3 / step) * step);
    $('size').min = low; $('size').max = high; $('size').step = step;
    state.size = initialSize ?? Math.round(ideal / step) * step;
    $('size').value = state.size;
    document.querySelectorAll('[data-size]').forEach((button, i) => { button.dataset.size = Math.round(ideal * [0.68, 1, 1.5][i]); });
  }
  $('model-name').textContent = name;
  $('mesh-note').textContent = `${state.model.triangles.length.toLocaleString()} triangles · ${state.analysis.dimensions.map(v => (v / 1000).toFixed(2)).join(' × ')} m`;
  document.querySelector('.app-footer span').textContent = `${name} · All study dimensions in mm`;
  buildReference(); fitView(); updateInspector(); syncDesignControls();
  requestLayout({ fresh: !seeds, newModel: true });
}
function updateControlLabels() {
  $('size-value').textContent = mm(Number($('size').value));
  $('variation-value').textContent = `${Math.round(Number($('variation').value))}%`;
  $('pattern-regularity-value').textContent = `${Math.round(Number($('pattern-regularity').value))}%`;
  $('explode-value').textContent = `${state.explode}%`;
  $('straightness-value').textContent = `${Math.round(state.straightness * 100)}%`;
  $('thickness-value').textContent = mm(state.thickness);
  $('roundover-value').textContent = mm(state.roundover);
  document.querySelectorAll('[data-size]').forEach(b => b.classList.toggle('is-active', Math.abs(Number(b.dataset.size) - Number($('size').value)) < 15));
}
function updateStats() {
  const s = state.result?.stats;
  if (!s) return;
  $('cell-count').textContent = arrangementCells().length;
  $('fit-max').textContent = mm(s.maxDeviation);
  $('seam-gap').textContent = mm(s.maxSeamGap);
  $('planarity-error').textContent = mm(s.maxPlanarityError);
  const solids = state.result.solids || [];
  $('stock-check').textContent = state.sourceSurface ? 'Updating…' : `${solids.filter(s => s.valid).length}/${solids.length} ${state.carve ? 'carved panels fit' : 'solids resolved'}`;
  const repair = s.repair;
  $('fit-repair-note').hidden = !!state.sourceSurface || !repair?.applied;
  $('fit-repair-note').textContent = repair?.applied
    ? `Automatic fitting recovered ${repair.recoveredPanels} stock panels. Largest repair adjustment: ${mm(repair.maxVertexMove)}. Source seams stay as drawn.` : '';
  const quality = state.result.quality;
  $('convex-check').textContent = quality ? `${quality.convexCount}/${quality.totalCount}` : '—';
  if (state.sourceSurface) for (const id of ['fit-max', 'seam-gap', 'planarity-error', 'convex-check']) $(id).textContent = '—';
  $('convex-check').title = quality ? `${quality.convexCount} convex, ${quality.concaveCount} concave, ${quality.holedCount} with openings; ${quality.invalidCount} invalid outlines. Convexity is measured in the fitted panel plane. Solid validity is checked separately.` : '';
  let junctionNote = $('junction-note');
  if (!junctionNote) { junctionNote = document.createElement('p'); junctionNote.id = 'junction-note'; junctionNote.className = 'control-hint'; $('boundary-note').after(junctionNote); }
  junctionNote.textContent = `${state.cornerMode && state.view !== 'reference' ? 'Blue: shared corners · Amber: boundary endpoints' : `${s.tJunctionCount || 0} T-junctions, marked amber`}${s.invalidCellCount ? ` · ${s.invalidCellCount} cells need reshaping before flat export` : ''}`;
  const note = document.querySelector('.fit-explanation');
  note.textContent = state.color === 'fit' ? 'Surface-fit colours: green 0 mm → amber 40 mm → red 80+ mm from the reference surface.' : 'Surface deviation measures the fitted panels against the reference mesh.';
}
function updateInspector() {
  updateEditAvailability();
  updateExportAvailability();
  const cell = arrangementCells().find(c => c.id === state.selected);
  $('selection-empty').hidden = !!cell;
  $('selection-details').hidden = !cell;
  if (!cell) return;
  $('selected-id').textContent = state.selectedIds.length > 1 ? `${state.selectedIds.length} selected · ${panelId(cell.id)}` : panelId(cell.id);
  $('selected-size').textContent = `${Math.round(cell.width)} × ${Math.round(cell.height)} mm`;
  $('selected-area').textContent = `${(cell.area / 1e6).toFixed(2)} m²`;
  const polygon = cell.polygonQuality;
  $('selected-convexity').textContent = ({ convex: 'Convex', concave: 'Concave', holed: 'Has openings', disconnected: 'Separate pieces', degenerate: 'Degenerate', 'self-crossing': 'Crossing outline' })[polygon?.classification] ?? '—';
  $('selected-convexity').title = polygon?.classification === 'concave'
    ? `${polygon.concaveVertexCount} inward corners in the fitted outline. Concave panels remain allowed.`
    : 'Convexity of the fitted cutting outline; fabrication validity is checked separately.';
  $('selected-fit').textContent = mm(cell.maxDeviation);
  $('selected-gap').textContent = mm(cell.maxSeamGap);
  const seed = state.seeds.find(s => s.id === cell.id);
  $('cell-weight').value = Math.round((seed?.weight ?? 1) * 100);
  $('cell-weight-value').textContent = `${Math.round((seed?.weight ?? 1) * 100)}%`;
  $('cell-weight').disabled = state.pattern.type !== 'organic' || !!state.directBase || !!state.cornerEdits.length || state.selectedIds.length > 1 || (cell.memberSeedIds?.length ?? 1) > 1;
  $('cell-weight-help').textContent = state.pattern.type !== 'organic' ? 'Use corner editing and merges to reshape this layout.' : state.directBase ? 'Reset direct edits to change generated cell influence.' : state.cornerEdits.length ? 'Reset corners to change cell influence while keeping merged groups.' : (cell.memberSeedIds?.length ?? 1) > 1 ? 'This merged cell keeps its original regions. Undo the merge to edit their centres or influence.' : state.selectedIds.length > 1 ? 'Select one cell to adjust its influence.' : 'Give this cell more area. Its neighbours adjust.';
  const solid = state.result?.solids?.find(s => s.id === cell.id);
  const fittedIssues = cell.issues || [], notes = [];
  if (state.view === 'solid' || !cell.valid || (solid && !solid.valid)) {
    if (!cell.valid && fittedIssues.length) notes.push(`Fitted panel: ${fittedIssues.join(' ')}`);
    const solidIssues = (solid?.issues || []).filter(issue => !(!cell.valid && fittedIssues.length && issue === 'Reshape this cell before making a solid panel.'));
    if (solidIssues.length) notes.push(`Solid panel: ${solidIssues.join(' ')}`);
    if (!notes.length) notes.push(state.carve ? `Carved inside face. Sampled surface error: ${mm(solid?.maxSurfaceError)}.` : 'Solid panel with shared matching edges.');
  } else {
    notes.push(`Fitted panel: ${fittedIssues.length ? fittedIssues.join(' ') : 'Shared edges match.'}`);
  }
  $('selected-note').textContent = state.sourceSurface ? 'Surface layout accepted. Flat panels and stock checks are updating.' : notes.join(' ');
  $('selected-stock').textContent = solid?.minRemainingThickness != null ? mm(solid.minRemainingThickness) : mm(state.thickness);
  $('selected-roundover-row').hidden = !solid?.radiusClamped;
  $('selected-roundover').textContent = solid?.radiusClamped ? `${mm(solid.actualRadius)} used · ${mm(solid.requestedRadius)} requested` : '—';
  $('selected-roundover').title = solid?.radiusClamped ? `Used ${solid.actualRadius} mm; requested ${solid.requestedRadius} mm.` : '';
  drawOutline(cell);
  updateExportAvailability();
}
function drawOutline(cell) {
  const canvas = $('panel-preview'), ctx = canvas.getContext('2d');
  const points = cell.outline2d.flat();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!points.length) return;
  const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
  const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  const scale = Math.min((canvas.width - 80) / (maxX - minX || 1), (canvas.height - 70) / (maxY - minY || 1));
  const x = p => canvas.width / 2 + (p[0] - (minX + maxX) / 2) * scale;
  const y = p => canvas.height / 2 - (p[1] - (minY + maxY) / 2) * scale;
  ctx.beginPath();
  for (const ring of cell.outline2d) { ring.forEach((p, i) => i ? ctx.lineTo(x(p), y(p)) : ctx.moveTo(x(p), y(p))); ctx.closePath(); }
  ctx.fillStyle = '#d8e1ed'; ctx.fill('evenodd');
  ctx.strokeStyle = '#245db4'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#5a6675'; ctx.font = '18px ui-monospace, monospace'; ctx.textAlign = 'center';
  ctx.fillText(`${Math.round(cell.width)} mm`, canvas.width / 2, canvas.height - 12);
}
function selectCell(id, additive = false) {
  if (additive) state.selectedIds = state.selectedIds.includes(id) ? state.selectedIds.filter(value => value !== id) : [...state.selectedIds, id];
  else state.selectedIds = id == null ? [] : [id];
  state.selected = state.selectedIds.includes(id) ? id : state.selectedIds.at(-1) ?? null;
  for (const object of cellGroup.children) {
    const selected = state.selectedIds.includes(object.userData.cellId);
    if (object.isMesh) object.material.color.copy(object.userData.unresolved && !selected ? new THREE.Color('#ce8c74') : cellColor(state.cells.find(c => c.id === object.userData.cellId)));
    else { object.material.color.set(selected ? '#245db4' : '#657484'); object.material.opacity = selected ? 1 : .69; }
  }
  updateInspector();
}

function snapshot() { return { design: captureDesign(state), selectedIds: [...state.selectedIds], selectedCorner: state.selectedCorner }; }
function recordEdit(before) {
  if (JSON.stringify(before.design) === JSON.stringify(captureDesign(state))) return;
  state.history.push(before);
  if (state.history.length > 30) state.history.shift();
  state.future = [];
  updateEditAvailability();
}
let pendingEdit = null, editTimer = null;
function cancelPendingEdit() { clearTimeout(editTimer); editTimer = null; pendingEdit = null; }
function finishPendingEdit() {
  const before = pendingEdit?.before, needsSolve = editTimer !== null;
  cancelPendingEdit();
  if (before) recordEdit(before);
  if (needsSolve) requestLayout();
}
function beginEdit(key) {
  cancelCornerPending();
  if (pendingEdit?.key !== key) { finishPendingEdit(); pendingEdit = { key, before: snapshot() }; }
}
function scheduleEdit() {
  // Invalidate an in-flight result immediately, including the debounce window.
  state.requested++; state.solved = false;
  clearTimeout(editTimer);
  editTimer = setTimeout(() => { editTimer = null; requestLayout(); }, 180);
  updateExportAvailability(); updateEditAvailability();
}
function syncDesignControls() {
  for (const [id, key, factor] of [['size', 'size', 1], ['variation', 'variation', 100], ['straightness', 'straightness', 100], ['thickness', 'thickness', 1], ['roundover', 'roundover', 1], ['minimum-thickness', 'minimumThickness', 1]]) $(id).value = state[key] * factor;
  $('pattern-type').value = state.pattern.type;
  $('pattern-angle').value = state.pattern.angle;
  $('pattern-frequency').value = state.pattern.frequency;
  $('pattern-regularity').value = (state.pattern.regularity ?? .7) * 100;
  $('carve-inner').checked = state.carve;
  $('flip-outside').checked = state.flipOutside;
  if (state.pattern.type !== 'organic' && state.edit) {
    state.edit = false; state.cornerMode = true; state.multiSelect = false;
    $('edit-toggle').setAttribute('aria-pressed', 'false');
    $('corner-toggle').setAttribute('aria-pressed', 'true');
    $('multi-select').setAttribute('aria-pressed', 'false');
  }
  updatePatternControls(); updateControlLabels();
}
function updatePatternControls() {
  const type = $('pattern-type').value;
  $('variation-control').hidden = type !== 'organic';
  $('pattern-angle-control').hidden = !['hexagonal', 'geodesic'].includes(type);
  $('pattern-frequency-control').hidden = type !== 'geodesic';
  $('pattern-regularity-control').hidden = type !== 'regularized';
  $('size-control').hidden = type === 'geodesic';
  $('size').disabled = type === 'geodesic';
  $('variation').disabled = type !== 'organic';
  $('pattern-help').textContent = type === 'hexagonal' ? 'Flat surfaces; edges and openings clip the lattice.'
    : type === 'geodesic' ? 'Spherical surfaces; boundary cells are clipped.'
    : type === 'regularized' ? 'Surface relaxation towards more even cells.' : 'Randomized surface layout.';
  $('size-help').hidden = type !== 'organic';
  $('generation-help').textContent = 'Replaces edits. Undo restores them.';
}
function restoreSnapshot(entry) {
  cancelPendingEdit();
  generationSequence++; state.generating = false;
  $('corner-status').textContent = '';
  Object.assign(state, captureDesign(entry.design));
  state.selectedIds = [...entry.selectedIds]; state.selected = state.selectedIds.at(-1) ?? null;
  state.selectedCorner = entry.selectedCorner ?? null;
  state.lastLayoutChange = null;
  syncDesignControls(); requestLayout();
}
function undoEdit() {
  if (cornerPending) { cancelCornerPending(); setStatus('Corner move cancelled.'); return; }
  if (drag) return;
  finishPendingEdit();
  if (!state.history.length) return;
  state.future.push(snapshot()); restoreSnapshot(state.history.pop());
}
function redoEdit() {
  if (cornerPending) { cancelCornerPending(); setStatus('Corner move cancelled.'); return; }
  if (drag) return;
  finishPendingEdit();
  if (!state.future.length) return;
  state.history.push(snapshot()); restoreSnapshot(state.future.pop());
}
function updateEditAvailability() {
  updateWorkspaceChrome();
  $('stage').classList.toggle('is-calculating', state.generating || state.busy || !!state.pending);
  const waiting = state.generating || state.busy || !!state.pending || !state.solved || !!cornerPending || directDrag();
  $('undo-move').disabled = !state.history.length && !pendingEdit && !cornerPending;
  $('redo-edit').disabled = !state.future.length || !!pendingEdit;
  $('regenerate').disabled = !state.ready || waiting;
  $('reset-layout').disabled = !state.ready || waiting;
  $('clear-selection').disabled = !state.selectedIds.length;
  $('split-cell').disabled = !state.ready || !canArrange() || !!drag || !state.splitMode && state.selectedIds.length !== 1;
  $('split-cell').title = state.selectedIds.length !== 1 ? 'Select one cell to divide.' : 'Drag a divider across this cell in the Cells view.';
  $('corner-toggle').disabled = !state.ready || !canArrange() || !!drag;
  $('reset-corners').disabled = (!state.cornerEdits.length && !state.directBase) || waiting;
  $('reset-corners').textContent = state.directBase ? 'Reset direct edits' : 'Reset corners';
  $('reset-corners').title = state.directBase ? 'Restore the layout before the first direct edit, including its earlier corner edits and merges.' : 'Clear legacy corner targets while keeping merged cells.';
  $('allow-cell-removal').disabled = !canArrange() || !!drag;
  $('edit-toggle').disabled = !state.ready || !!drag || !!cornerPending || state.generating;
  $('move-cells-help').textContent = graphCentreMode()
    ? 'Drag a centre to move its adjoining corners together on the shell. Earlier edits are preserved. Release checks for crossed seams; Escape cancels.'
    : 'Drag a centre on the surface to stretch the surrounding cells. After corner edits, centres move the authored corners together.';
  $('merge-cells').disabled = true;
  if (state.selectedIds.length < 2) {
    $('merge-status').textContent = state.selectedIds.length ? '1 cell selected. Divide it, or add a neighbour to merge.' : 'Select adjoining cells to remove their shared seam.';
  } else if (waiting) {
    $('merge-status').textContent = 'Updating the selected cells…';
  } else {
    try {
      validateMergeSelection();
      $('merge-cells').disabled = waiting || state.view === 'reference';
      $('merge-status').textContent = `${state.selectedIds.length} adjoining cells selected. Merge keeps their combined surface boundary.`;
    } catch (error) { $('merge-status').textContent = error.message; }
  }
}
function validateMergeSelection() {
  if (!state.directBase) return createMergeGroups(state.result?.surfaceCells || [], state.mergeGroups, state.selectedIds);
  const selected = new Set(state.selectedIds), cells = new Map(state.cells.map(cell => [cell.id, cell]));
  if (selected.size < 2 || [...selected].some(id => !cells.has(id))) throw new Error('Select at least two cells to merge.');
  const queue = [state.selectedIds[0]], reached = new Set(queue);
  for (let i = 0; i < queue.length; i++) for (const id of cells.get(queue[i]).neighbors) {
    if (selected.has(id) && !reached.has(id)) { reached.add(id); queue.push(id); }
  }
  if (reached.size !== selected.size) throw new Error('Select cells connected by shared edges.');
}
$('multi-select').addEventListener('click', () => {
  cancelCornerPending();
  state.multiSelect = !state.multiSelect;
  if (state.multiSelect) { state.edit = false; state.cornerMode = false; state.splitMode = false; }
  $('split-cell').setAttribute('aria-pressed', String(state.splitMode));
  $('multi-select').setAttribute('aria-pressed', String(state.multiSelect));
  $('edit-toggle').setAttribute('aria-pressed', String(state.edit));
  $('corner-toggle').setAttribute('aria-pressed', String(state.cornerMode));
  buildSeeds(); buildCorners(); updateViewportHint(); updateStats();
});
$('clear-selection').addEventListener('click', () => selectCell(null));
$('merge-cells').addEventListener('click', () => {
  if (state.busy || !state.solved || cornerPending || drag || state.view === 'reference') return;
  finishPendingEdit();
  try {
    if (state.directBase || state.pattern.type !== 'organic') {
      validateMergeSelection();
      commitDirectEdit({ type: 'merge-cells', cellIds: [...state.selectedIds] }, snapshot());
      return;
    }
    const groups = createMergeGroups(state.result.surfaceCells, state.mergeGroups, state.selectedIds);
    const before = snapshot(), survivor = Math.min(...state.selectedIds);
    state.mergeGroups = groups; state.selectedIds = [survivor]; state.selected = survivor;
    recordEdit(before); requestLayout();
  } catch (error) { setStatus(error.message, true); }
});
$('undo-move').addEventListener('click', undoEdit);
$('redo-edit').addEventListener('click', redoEdit);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    // Keep native Escape dismissal available for idle popovers and controls.
    if (drag || cornerPending || state.generating) event.preventDefault();
    resetInteraction(); return;
  }
  const active = document.activeElement;
  if (!(event.ctrlKey || event.metaKey) || active?.isContentEditable || active?.tagName === 'TEXTAREA' ||
    (active?.tagName === 'INPUT' && !['range', 'checkbox', 'radio'].includes(active.type))) return;
  const key = event.key.toLowerCase();
  if (key === 'z' || key === 'y') { event.preventDefault(); if (key === 'y' || event.shiftKey) redoEdit(); else undoEdit(); }
});

function updateViewportHint() {
  updateWorkspaceChrome();
  junctionGroup.visible = !state.cornerMode;
  $('viewport-hint').textContent = state.view === 'reference' ? 'Drag to orbit · Scroll to zoom'
    : state.splitMode ? 'Drag within the selected cell to draw a divider · Release to apply · Esc cancels'
    : state.cornerMode ? 'Drag a corner · Alt suppresses snapping · Release to apply · Esc cancels'
    : state.multiSelect ? 'Click cells to add or remove them · Drag to orbit · Scroll to zoom'
    : state.edit ? 'Drag a handle to edit · Drag the model to orbit · Scroll to zoom'
    : 'Click a panel to inspect · Drag to orbit · Scroll to zoom';
  $('corner-help').textContent = 'Cells previews adjoining seams while you drag. Release to accept the layout and fit panels in the background. Hold Alt to suppress joining. Amber endpoints follow their boundary; Esc cancels.';
}
function cancelCornerPending() {
  if (!cornerPending) return;
  cornerSequence++; cornerPending = null;
  $('corner-status').textContent = 'Edit cancelled. The accepted layout is kept.';
  clearCornerSketch(); disposeGroup(cornerGuide); buildCells(); buildSeeds(); buildCorners(); updateInspector(); updateStats(); updateEditAvailability(); updateExportAvailability();
}
function cancelCornerDrag() {
  if (!directDrag()) return;
  const pointerId = drag.pointerId;
  drag = null; down = null; controls.enabled = true; viewport.style.cursor = 'default';
  $('corner-status').textContent = 'Move cancelled. The accepted layout is kept.';
  if (renderer.domElement.hasPointerCapture(pointerId)) renderer.domElement.releasePointerCapture(pointerId);
  clearCornerSketch(); disposeGroup(cornerGuide); buildCells(); buildSeeds(); buildCorners(); updateInspector(); updateStats(); updateEditAvailability(); updateExportAvailability();
}
function cancelCentreDrag() {
  if (!drag || directDrag()) return;
  const moved = drag;
  drag = null; down = null;
  clearTimeout(dragTimer); dragTimer = null;
  controls.enabled = true; viewport.style.cursor = 'default';
  if (renderer.domElement.hasPointerCapture(moved.pointerId)) renderer.domElement.releasePointerCapture(moved.pointerId);
  if (moved.changed && moved.modelRevision === state.modelRevision) {
    const restored = captureDesign(state);
    const seed = restored.seeds.find(seed => seed.id === moved.seed.id);
    const original = moved.before.design.seeds.find(seed => seed.id === moved.seed.id);
    seed.position = [...original.position];
    restored.layout = moved.before.design.layout;
    Object.assign(state, restored);
    state.selectedIds = [...moved.before.selectedIds]; state.selected = state.selectedIds.at(-1) ?? null;
    state.selectedCorner = moved.before.selectedCorner;
    // A debounced or already-running drag solve must never replace the
    // restored design. Let an in-flight reply drain through the normal queue.
    state.requested++; state.pending = null;
    if (JSON.stringify(restored) === JSON.stringify(moved.before.design)) {
      Object.assign(state, moved.derivedBefore); state.solved = true;
      setBusy(state.busy);
    } else requestLayout(); // Preserve any separately entered setting.
  }
  buildCells(); buildSeeds(); buildCorners(); updateInspector(); updateStats(); updateEditAvailability(); updateExportAvailability();
}
function resetInteraction() {
  const generating = state.generating, moving = !!drag || !!cornerPending;
  cancelGeneration(); cancelCornerDrag(); cancelCentreDrag(); cancelCornerPending();
  // Escape ends the editing tool, but retains an entered slider value.
  finishPendingEdit();
  state.edit = false; state.cornerMode = false; state.multiSelect = false; state.splitMode = false;
  state.selectedCorner = null; down = null; hoverId = null;
  for (const id of ['edit-toggle', 'corner-toggle', 'multi-select', 'split-cell']) $(id).setAttribute('aria-pressed', 'false');
  controls.enabled = true; viewport.style.cursor = 'default';
  clearCornerSketch(); disposeGroup(cornerGuide);
  for (const object of cellGroup.children) if (object.isMesh) object.material.emissive.set('#000000');
  selectCell(null); buildSeeds(); buildCorners(); updateViewportHint(); updateStats(); updateEditAvailability(); updateExportAvailability();
  $('corner-status').textContent = moving ? 'Move cancelled. The accepted layout is kept.' : '';
  setStatus(`${generating ? 'Arrangement cancelled. ' : moving ? 'Move cancelled. ' : ''}Selection cleared · ${state.view === 'reference' ? 'Inspect source' : 'Inspect cells'}`);
}
function onBoundary(point, path) {
  let best = null, distance = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = vectors(path[i - 1]), b = vectors(path[i]), edge = b.sub(a);
    const t = THREE.MathUtils.clamp(point.clone().sub(a).dot(edge) / (edge.lengthSq() || 1), 0, 1);
    const candidate = a.addScaledVector(edge, t), d = candidate.distanceToSquared(point);
    if (d < distance) { best = candidate; distance = d; }
  }
  return best;
}
async function commitCornerMove(moved) {
  return commitDirectEdit({ type: 'move-corner', cornerId: moved.corner.id, target: [...moved.target],
    snapDistance: moved.snapSuppressed ? 0 : moved.snapDistance, allowCellRemoval: moved.allowCellRemoval }, moved.before);
}
async function commitDirectEdit(transaction, before) {
  const sequence = ++cornerSequence, modelRevision = state.modelRevision;
  const merging = transaction.type === 'merge-cells', movingCell = transaction.type === 'move-cell', splitting = transaction.type === 'split-cell';
  cornerPending = { sequence, before, kind: splitting ? 'split' : merging ? 'merge' : movingCell ? 'cell' : 'corner' };
  $('corner-status').textContent = splitting ? 'Checking the divider…' : merging ? 'Checking the cell merge…' : movingCell ? 'Checking the centre move…' : 'Checking the corner move…';
  setStatus($('corner-status').textContent); updateEditAvailability(); updateExportAvailability();
  try {
    const { layout, change, surface } = await validateDesignGeometry({ model: state.model, layout: state.layout, transaction });
    if (sequence !== cornerSequence || modelRevision !== state.modelRevision || JSON.stringify(captureDesign(state)) !== JSON.stringify(before.design)) return;
    cornerPending = null;
    if (JSON.stringify(layout) === JSON.stringify(state.layout)) {
      $('corner-status').textContent = 'The layout is unchanged.';
      setStatus($('corner-status').textContent); return;
    }
    state.directBase ??= state.layout;
    state.layout = immutableLayout(layout); state.sourceSurface = surface; state.lastLayoutChange = change ?? null;
    const survivors = new Set(layout.cells.map(cell => cell.id));
    state.selectedIds = state.selectedIds.filter(id => survivors.has(id));
    if (merging) state.selectedIds = [change?.survivingCellId ?? Math.min(...transaction.cellIds)].filter(id => survivors.has(id));
    if (splitting) state.selectedIds = [change.newCellId];
    state.selected = state.selectedIds.at(-1) ?? null;
    state.selectedCorner = change?.survivingCornerId ?? null;
    recordEdit(before);
    const removed = change?.removedCellIds ?? [];
    $('corner-status').textContent = splitting ? `Cell divided. ${panelId(change.newCellId)} added; Undo restores the original.` : merging ? 'Cells merged. The edited layout is preserved.' : movingCell ? 'Centre moved. Earlier edits are preserved; panels are refitting.' : removed.length
      ? `Corner applied · Removed ${removed.map(panelId).join(', ')}. Undo restores them.`
      : change?.collapsedEdgeIds?.length ? 'Corners joined. Panels refit the edited layout.' : 'Corner applied. Panels refit the edited layout.';
    clearCornerSketch();
    requestLayout({ preserveSource: true });
  } catch (error) {
    if (sequence !== cornerSequence) return;
    $('corner-status').textContent = `${splitting ? 'Divider' : merging ? 'Merge' : 'Move'} not applied: ${error.message}`;
    setStatus($('corner-status').textContent, true);
  } finally {
    if (sequence === cornerSequence) {
      cornerPending = null; clearCornerSketch(); disposeGroup(cornerGuide);
      if (!drag) { buildCells(); buildSeeds(); buildCorners(); updateInspector(); updateStats(); }
      updateEditAvailability(); updateExportAvailability();
    }
  }
}
$('corner-toggle').addEventListener('click', () => {
  finishPendingEdit(); cancelCornerPending();
  state.cornerMode = !state.cornerMode || state.view === 'reference' || state.explode !== 0;
  if (state.cornerMode) {
    state.edit = false; state.multiSelect = false; state.splitMode = false; state.explode = 0;
    $('split-cell').setAttribute('aria-pressed', 'false');
    $('explode').value = 0; updateControlLabels();
    if (state.view === 'reference') showView('surface');
    else buildCells();
  }
  $('corner-toggle').setAttribute('aria-pressed', String(state.cornerMode));
  $('edit-toggle').setAttribute('aria-pressed', String(state.edit));
  $('multi-select').setAttribute('aria-pressed', String(state.multiSelect));
  buildSeeds(); buildCorners(); updateViewportHint(); updateStats();
});
$('split-cell').addEventListener('click', () => {
  if ($('split-cell').disabled) return;
  finishPendingEdit(); cancelCornerPending();
  state.splitMode = !state.splitMode;
  if (state.splitMode) {
    state.edit = false; state.cornerMode = false; state.multiSelect = false; state.explode = 0;
    $('explode').value = 0; updateControlLabels(); showView('surface');
  }
  for (const [id, active] of [['split-cell',state.splitMode],['edit-toggle',state.edit],['corner-toggle',state.cornerMode],['multi-select',state.multiSelect]]) $(id).setAttribute('aria-pressed', String(active));
  buildSeeds(); buildCorners(); updateViewportHint(); updateStats();
  setStatus(state.splitMode ? 'Drag a line inside the selected cell. It extends to the cell edges; release to divide.' : 'Divider tool off.');
});
function paintSplitPreview() {
  if (drag?.kind !== 'split' || !drag.previewDirty) return;
  drag.previewDirty = false;
  const preview = previewCellSplit(state.model, state.layout, { cellId: drag.cellId, start: drag.start, end: drag.end });
  disposeGroup(cornerGuide);
  const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(preview.segments.map(vectors)),
    new THREE.LineBasicMaterial({ color: preview.issue ? '#b44732' : '#1957b4', depthTest: false }));
  line.renderOrder = 3; cornerGuide.add(line);
  setStatus(preview.issue ? `Divider: ${preview.issue}` : 'Divider preview · Release to create two cells · Escape cancels.', !!preview.issue);
}
$('reset-corners').addEventListener('click', () => {
  finishPendingEdit(); cancelCornerPending();
  if (state.directBase) {
    const before = snapshot(); state.layout = state.directBase; state.directBase = null; state.lastLayoutChange = null;
    state.selectedCorner = null;
    recordEdit(before); requestLayout();
    $('corner-status').textContent = 'Direct edits reset. Earlier corner edits and merges are restored.';
    return;
  }
  if (!state.cornerEdits.length) return;
  const before = snapshot(); state.cornerEdits = []; state.selectedCorner = null;
  recordEdit(before); requestLayout();
  $('corner-status').textContent = 'Corners reset. Merged cells are kept.';
});
$('allow-cell-removal').addEventListener('change', () => { state.allowCellRemoval = $('allow-cell-removal').checked; });

// Pointer capture lets a centre be moved without also orbiting the camera.
let drag = null, down = null, hoverId = null;
function cast(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  updateCornerPositions();
}
renderer.domElement.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  cast(event); down = { x: event.clientX, y: event.clientY };
  if (state.generating) return;
  if (state.splitMode && state.view === 'surface' && canArrange()) {
    const hit = raycaster.intersectObjects(cellGroup.children.filter(object => object.isMesh))[0];
    if (hit && hit.object.userData.cellId === state.selected && state.selectedIds.length === 1) {
      finishPendingEdit();
      drag = { kind: 'split', cellId: state.selected, start: hit.point.toArray(), end: hit.point.toArray(),
        before: snapshot(), changed: false, pointerId: event.pointerId,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), hit.point) };
      controls.enabled = false; renderer.domElement.focus({ preventScroll: true });
      renderer.domElement.setPointerCapture(event.pointerId); viewport.style.cursor = 'crosshair';
      updateExportAvailability(); updateEditAvailability();
      event.stopImmediatePropagation(); event.preventDefault(); return;
    }
  }
  if (state.cornerMode && cornerGroup.visible && canArrange()) {
    const hit = raycaster.intersectObjects(cornerGroup.children)[0];
    const surfaceHit = state.view === 'surface' ? sourceMesh && raycaster.intersectObject(sourceMesh)[0]
      : raycaster.intersectObjects(cellGroup.children.filter(object => object.isMesh))[0];
    const radius = Math.max(...state.analysis.dimensions) * .006;
    if (hit && (!surfaceHit || hit.distance <= surfaceHit.distance + radius * 2)) {
      const corner = arrangementCorners().find(value => value.id === hit.object.userData.cornerId);
      finishPendingEdit();
      const displayStart = hit.object.position.clone();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), displayStart);
      const pointerStart = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (!pointerStart) return;
      let patch = null;
      try { if (!corner.boundary) patch = cornerProjectionPatch(state.model, corner); }
      catch (error) { setStatus(error.message, true); return; }
      drag = { kind: 'corner', corner, dot: hit.object, before: snapshot(), target: [...corner.position], changed: false, pointerId: event.pointerId,
        plane, pointerStart, displayStart, sourceStart: vectors(corner.position), patch, view: state.view,
        snapDistance: Math.max(...state.analysis.dimensions) * .008, allowCellRemoval: state.allowCellRemoval,
        pointerScreen: { x: event.clientX, y: event.clientY } };
      if (state.view === 'surface') {
        try { drag.sketch = createCornerSketch(state.model, state.layout, corner.id); }
        catch (error) { drag.sketchIssue = error.message; }
      }
      state.selectedCorner = corner.id; state.selectedIds = [...corner.cells]; state.selected = corner.cells[0] ?? null;
      renderer.domElement.focus({ preventScroll: true });
      $('corner-status').textContent = 'Drag a corner · Release to apply · Escape cancels.';
      setStatus($('corner-status').textContent);
      hit.object.material.color.set('#19498e');
      buildCells(); updateInspector();
      controls.enabled = false; renderer.domElement.setPointerCapture(event.pointerId); viewport.style.cursor = 'grabbing';
      updateExportAvailability(); updateEditAvailability();
      event.stopImmediatePropagation(); event.preventDefault(); return;
    }
  }
  if (!state.edit || !seedGroup.visible || state.multiSelect || event.shiftKey || !canArrange()) return;
  const hit = raycaster.intersectObjects(seedGroup.children)[0];
  const surfaceHit = sourceMesh && raycaster.intersectObject(sourceMesh)[0];
  if (!hit || (state.view === 'surface' && surfaceHit && hit.distance > surfaceHit.distance + state.size * 0.1)) return;
  if (hit.object.userData.cellHandle) {
    const handle = hit.object.userData.cellHandle;
    const sourceStart = vectors(handle.position), displayStart = hit.object.position.clone();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), displayStart);
    const pointerStart = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!pointerStart) return;
    let patch;
    try { patch = cornerProjectionPatch(state.model, { position: handle.position, radius: handle.radius ?? state.size * 2 }); }
    catch (error) { setStatus(error.message, true); return; }
    finishPendingEdit();
    drag = { kind: 'cell', handle, dot: hit.object, before: snapshot(), target: [...handle.position], changed: false,
      pointerId: event.pointerId, plane, pointerStart, sourceStart, displayStart, patch };
    selectCell(handle.cellId); controls.enabled = false;
    renderer.domElement.focus({ preventScroll: true }); renderer.domElement.setPointerCapture(event.pointerId);
    viewport.style.cursor = 'grabbing';
    $('corner-status').textContent = 'Move the centre · Release to move adjoining corners · Escape cancels.';
    setStatus($('corner-status').textContent); updateExportAvailability(); updateEditAvailability();
    event.stopImmediatePropagation(); event.preventDefault(); return;
  }
  const seed = state.seeds.find(s => s.id === hit.object.userData.seedId);
  finishPendingEdit();
  drag = { seed, dot: hit.object, before: snapshot(), changed: false, pointerId: event.pointerId, modelRevision: state.modelRevision,
    derivedBefore: { result: state.result, cells: state.cells, analysis: state.analysis, sourceSurface: state.sourceSurface, lastLayoutChange: state.lastLayoutChange } };
  selectCell(seed.id); controls.enabled = false;
  renderer.domElement.setPointerCapture(event.pointerId);
  viewport.style.cursor = 'grabbing';
  event.stopImmediatePropagation(); event.preventDefault();
}, true);
let dragTimer;
renderer.domElement.addEventListener('pointermove', event => {
  cast(event);
  if (drag?.kind === 'split') {
    const hit = raycaster.intersectObjects(cellGroup.children.filter(object => object.isMesh))[0];
    const point = hit?.object.userData.cellId === drag.cellId ? hit.point : raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (point) {
      drag.end = point.toArray(); drag.changed = point.distanceTo(vectors(drag.start)) > 1e-4; drag.previewDirty = true;
    }
    event.stopImmediatePropagation(); event.preventDefault(); return;
  }
  if (drag?.kind === 'cell') {
    const hit = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (hit) {
      const point = projectCornerDisplacement({ position: drag.handle.position }, hit.sub(drag.pointerStart), drag.patch);
      drag.target = point.toArray(); drag.changed = point.distanceTo(drag.sourceStart) > 1e-4;
      const displayed = drag.displayStart.clone().add(point.clone().sub(drag.sourceStart));
      drag.dot.position.copy(displayed); drawCornerGuide(drag.displayStart.toArray(), displayed.toArray());
      $('corner-status').textContent = `${mm(point.distanceTo(drag.sourceStart))} centre move · Release to check adjoining seams · Escape cancels.`;
    }
    event.stopImmediatePropagation(); event.preventDefault(); return;
  }
  if (drag?.kind === 'corner') {
    let point;
    if (Math.hypot(event.clientX - drag.pointerScreen.x, event.clientY - drag.pointerScreen.y) < .5) {
      point = drag.sourceStart.clone();
    } else {
      // Work relative to the displayed handle, including its fitted/stock
      // offset. A grabbed edge of the handle must not jump to its centre.
      const hit = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
      if (hit) {
        const displacement = hit.sub(drag.pointerStart);
        point = drag.corner.boundary ? onBoundary(drag.sourceStart.clone().add(displacement), drag.corner.boundaryPath || [])
          : projectCornerDisplacement(drag.corner, displacement, drag.patch);
      }
    }
    if (point) {
      let preview = { target: point.toArray(), snapCornerId: null };
      if (!event.altKey && point.distanceTo(drag.sourceStart) > 1e-4) {
        const hovered = raycaster.intersectObjects(cornerGroup.children).find(hit => hit.object.userData.cornerId !== drag.corner.id)?.object.userData.corner;
        if (hovered) {
          const candidate = previewCornerMove(state.layout, { cornerId: drag.corner.id, target: hovered.position, snapDistance: drag.snapDistance });
          if (candidate.snapCornerId === hovered.id) preview = candidate;
        }
        if (!preview.snapCornerId) preview = previewCornerMove(state.layout, { cornerId: drag.corner.id, target: point.toArray(), snapDistance: drag.snapDistance });
      }
      point = vectors(preview.target);
      const snapped = preview.snapCornerId && arrangementCorners().find(corner => corner.id === preview.snapCornerId);
      const displayed = snapped ? vectors(cornerDisplayPosition(snapped, state.view, camera.position.toArray()))
        : drag.displayStart.clone().add(point.clone().sub(drag.sourceStart));
      drag.target = point.toArray(); drag.snapCornerId = preview.snapCornerId; drag.snapSuppressed = event.altKey; drag.dot.position.copy(displayed);
      drag.sketchDirty = true;
      drag.changed = point.distanceTo(vectors(drag.corner.position)) > 1e-4;
      drawCornerGuide(drag.displayStart.toArray(), displayed.toArray());
      for (const handle of cornerGroup.children) if (handle !== drag.dot) {
        const corner = handle.userData.corner;
        handle.material.color.set(corner.id === preview.snapCornerId ? '#19498e' : corner.boundary ? '#a36a21' : '#245db4');
      }
      $('corner-status').textContent = preview.snapCornerId
        ? `Join corners · Release to check${drag.allowCellRemoval ? ' cell removal' : ''}; Escape cancels.`
        : drag.sketchIssue ? `Seam preview unavailable: ${drag.sketchIssue} Release to check; Escape cancels.`
        : `${mm(point.distanceTo(vectors(drag.corner.position)))} move · Release to apply; Escape cancels.`;
    }
    event.stopImmediatePropagation(); event.preventDefault(); return;
  }
  if (drag) {
    const hit = raycaster.intersectObject(sourceMesh)[0];
    if (hit) {
      drag.seed.position = hit.point.toArray(); drag.dot.position.copy(hit.point); drag.changed = true;
      state.requested++; state.solved = false; updateExportAvailability(); updateEditAvailability();
      clearTimeout(dragTimer); dragTimer = setTimeout(() => requestLayout(), 180);
    }
    event.stopImmediatePropagation(); event.preventDefault();
    return;
  }
  const dot = !state.generating && (state.cornerMode && cornerGroup.visible && !cornerPending && raycaster.intersectObjects(cornerGroup.children)[0]
    || state.edit && !state.multiSelect && !event.shiftKey && canArrange() && seedGroup.visible && raycaster.intersectObjects(seedGroup.children)[0]);
  viewport.style.cursor = state.splitMode && state.view === 'surface' ? 'crosshair' : dot ? 'grab' : 'default';
  const hovered = raycaster.intersectObjects(cellGroup.children.filter(o => o.isMesh))[0]?.object.userData.cellId ?? null;
  if (hovered !== hoverId) {
    hoverId = hovered;
    for (const object of cellGroup.children) if (object.isMesh) object.material.emissive.set(object.userData.cellId === hoverId ? '#17170e' : '#000000');
  }
}, true);
function endDrag(event) {
  if (directDrag()) {
    if (event.type === 'pointercancel') { cancelCornerDrag(); setStatus('Move cancelled.'); return; }
    const moved = drag;
    drag = null; down = null; controls.enabled = true; viewport.style.cursor = 'default';
    if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
    if (moved.changed) {
      if (moved.kind === 'split') {
        const nextCellId = state.nextCellId++;
        commitDirectEdit({ type: 'split-cell', cellId: moved.cellId, start: moved.start, end: moved.end, nextCellId }, moved.before);
      } else if (moved.kind === 'cell') commitDirectEdit({ type: 'move-cell', cellId: moved.handle.cellId, target: moved.target }, moved.before);
      else commitCornerMove(moved);
    } else { clearCornerSketch(); disposeGroup(cornerGuide); buildCells(); buildSeeds(); buildCorners(); updateInspector(); updateStats(); updateExportAvailability(); updateEditAvailability(); }
    event.stopImmediatePropagation(); event.preventDefault(); return;
  } else if (drag) {
    if (event.type === 'pointercancel') {
      cancelCentreDrag(); setStatus('Centre move cancelled. The accepted layout is kept.');
      event.stopImmediatePropagation(); event.preventDefault(); return;
    }
    clearTimeout(dragTimer);
    if (drag.changed) { recordEdit(drag.before); requestLayout(); }
    drag = null; controls.enabled = true; viewport.style.cursor = 'default';
    if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
    event.stopImmediatePropagation(); event.preventDefault();
  } else if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5 && state.view !== 'reference') {
    cast(event); const hit = raycaster.intersectObjects(cellGroup.children.filter(o => o.isMesh))[0];
    if (hit) selectCell(hit.object.userData.cellId, event.shiftKey || state.multiSelect);
  }
  down = null;
}
renderer.domElement.addEventListener('pointerup', endDrag, true);
renderer.domElement.addEventListener('pointercancel', endDrag, true);
function cancelGeneration() {
  if (!state.generating) return;
  generationSequence++; state.generating = false;
  updateEditAvailability();
}
async function freshLayout({ applySettings = false } = {}) {
  if (state.generating || !state.ready || state.busy || !state.solved || drag || cornerPending) return;
  finishPendingEdit();
  const before = snapshot(), modelRevision = state.modelRevision, sequence = ++generationSequence;
  const candidate = captureDesign(state);
  try {
    if (applySettings) {
      candidate.pattern = readPattern({ type: $('pattern-type').value, angle: Number($('pattern-angle').value), frequency: Number($('pattern-frequency').value), regularity: Number($('pattern-regularity').value) / 100 });
      candidate.size = Number($('size').value); candidate.variation = Number($('variation').value) / 100;
      if (candidate.pattern.type === 'organic') candidate.randomSeed++;
    }
    Object.assign(candidate, { seeds: [], mergeGroups: [], cornerEdits: [], layout: null, directBase: null });
    state.generating = true; updateEditAvailability();
    setStatus(candidate.pattern.type === 'regularized' ? 'Regularizing cells on the surface… Escape cancels.' : 'Checking the new arrangement…');
    const { layout } = await validateDesignGeometry({ ...candidate, model: state.model });
    if (sequence !== generationSequence || modelRevision !== state.modelRevision) return;
    if (JSON.stringify(captureDesign(state)) !== JSON.stringify(before.design)) {
      setStatus('The design changed while generating. Choose New arrangement to try again.'); return;
    }
    Object.assign(state, candidate, { seeds: structuredClone(layout.recipe.seeds), layout: immutableLayout(layout),
      lastLayoutChange: null, selectedCorner: null, selected: null, selectedIds: [] });
    recordEdit(before); syncDesignControls(); updateViewportHint(); requestLayout();
  } catch (error) {
    if (sequence === generationSequence) setStatus(`Arrangement not applied: ${error.message}`, true);
  } finally {
    if (sequence === generationSequence) { state.generating = false; updateEditAvailability(); }
  }
}
function showView(view) { document.querySelector(`[data-view="${view}"]`)?.click(); }
for (const [id, key, factor] of [['straightness', 'straightness', 0.01], ['thickness', 'thickness', 1], ['roundover', 'roundover', 1]]) {
  $(id).addEventListener('pointerdown', finishPendingEdit);
  $(id).addEventListener('input', () => {
    beginEdit(id);
    state[key] = Number($(id).value) * factor;
    scheduleEdit();
    updateControlLabels();
    showView(id === 'straightness' ? 'flat' : 'solid');
  });
  $(id).addEventListener('change', finishPendingEdit);
}
$('carve-inner').addEventListener('change', () => { finishPendingEdit(); const before = snapshot(); state.carve = $('carve-inner').checked; recordEdit(before); showView('solid'); requestLayout(); });
$('minimum-thickness').addEventListener('change', () => {
  finishPendingEdit(); const before = snapshot();
  const value = Number($('minimum-thickness').value);
  state.minimumThickness = Math.min(100, Math.max(3, Number.isFinite(value) ? value : 12));
  $('minimum-thickness').value = state.minimumThickness;
  recordEdit(before);
  if (state.carve) requestLayout();
});
$('cell-weight').addEventListener('pointerdown', finishPendingEdit);
$('cell-weight').addEventListener('input', () => {
  if ($('cell-weight').disabled) return;
  const seed = state.seeds.find(s => s.id === state.selected); if (!seed) return;
  beginEdit(`weight-${seed.id}`);
  seed.weight = Number($('cell-weight').value) / 100;
  scheduleEdit();
  $('cell-weight-value').textContent = `${Math.round(seed.weight * 100)}%`;
});
$('cell-weight').addEventListener('change', finishPendingEdit);
for (const id of ['size', 'variation', 'pattern-type', 'pattern-angle', 'pattern-frequency', 'pattern-regularity']) $(id).addEventListener('input', () => {
  cancelGeneration();
  updatePatternControls(); updateControlLabels();
  setStatus('Layout settings are ready. Choose New arrangement to replace the layout; Undo restores your edits.');
});
document.querySelectorAll('[data-size]').forEach(button => button.addEventListener('click', () => {
  cancelGeneration();
  $('size').value = button.dataset.size; updateControlLabels();
  setStatus('Choose New arrangement to apply this size. Undo restores your previous layout.');
}));
$('regenerate').addEventListener('click', () => freshLayout({ applySettings: true }));
$('reset-layout').addEventListener('click', () => freshLayout());
$('edit-toggle').addEventListener('click', () => {
  cancelCornerPending();
  state.edit = !state.edit;
  if (state.edit) { state.multiSelect = false; state.cornerMode = false; state.splitMode = false; }
  $('split-cell').setAttribute('aria-pressed', String(state.splitMode));
  $('edit-toggle').setAttribute('aria-pressed', String(state.edit));
  $('multi-select').setAttribute('aria-pressed', String(state.multiSelect));
  $('corner-toggle').setAttribute('aria-pressed', String(state.cornerMode));
  buildSeeds(); buildCorners(); updateViewportHint(); updateStats();
});
$('show-seeds').addEventListener('change', buildSeeds);
$('show-original').addEventListener('change', updateReference);
$('fit-view').addEventListener('click', () => { cancelCornerDrag(); cancelCornerPending(); fitView(null); });
document.querySelectorAll('[data-camera-view]').forEach(button => button.addEventListener('click', () => {
  cancelCornerDrag(); cancelCornerPending(); fitView(button.dataset.cameraView);
}));
document.querySelectorAll('[data-browser-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.browserView)));
$('explode').addEventListener('input', () => { cancelCornerDrag(); cancelCornerPending(); state.explode = Number($('explode').value); updateControlLabels(); buildCells(); buildSeeds(); buildCorners(); });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  cancelCornerDrag(); cancelCornerPending();
  state.view = button.dataset.view;
  if (state.view !== 'surface') { state.splitMode = false; $('split-cell').setAttribute('aria-pressed', 'false'); }
  document.querySelectorAll('[data-view]').forEach(b => { const active = b.dataset.view === state.view; b.classList.toggle('is-active', active); b.setAttribute('aria-pressed', String(active)); });
  buildCells(); buildSeeds(); buildCorners(); updateInspector(); updateExportAvailability(); updateViewportHint(); updateStats();
  setStatus(state.sourceSurface ? 'Layout accepted · Fitted views and stock checks are updating…' : state.view === 'reference' ? 'Reference mesh · Boundary openings preserved' : state.cornerMode ? 'Slide a shared corner · Release to refit · Esc cancels' : state.view === 'flat' ? 'Fitted panels · Shared edges matched · Highlighted problem panels need adjustment' : state.view === 'solid' ? 'Panel solids · Select a panel to inspect or export' : state.pattern.type !== 'organic' ? 'Structured cells · Select a panel to inspect or merge' : 'Drag a handle to reshape cells · Click a panel to inspect');
}));
document.querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => {
  state.color = button.dataset.color;
  document.querySelectorAll('[data-color]').forEach(b => { const active = b.dataset.color === state.color; b.classList.toggle('is-active', active); b.setAttribute('aria-pressed', String(active)); });
  buildCells(); updateStats();
}));
$('model-units').addEventListener('change', () => { if (state.rawModel) loadModel(state.rawModel, state.name); });
$('model-up').addEventListener('change', () => { if (state.model) { buildReference(); fitView(); } });
const flipLabel = document.createElement('label'); flipLabel.className = 'checkbox-row';
const flipInput = document.createElement('input'); flipInput.type = 'checkbox'; flipInput.id = 'flip-outside';
const flipText = document.createElement('span'); flipText.textContent = 'Flip inside / outside';
flipLabel.append(flipInput, flipText); document.querySelector('.model-settings').append(flipLabel);
flipInput.addEventListener('change', () => { finishPendingEdit(); const before = snapshot(); state.flipOutside = flipInput.checked; recordEdit(before); requestLayout(); });

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function panelProblems() {
  const solids = new Map((state.result?.solids || []).map(solid => [solid.id, solid]));
  return state.cells.flatMap(cell => {
    const solid = solids.get(cell.id);
    if (cell.valid && solid?.valid) return [];
    const flatIssues = cell.valid ? [] : cell.issues || [];
    const solidIssues = (solid?.issues || []).filter(issue => !(!cell.valid && flatIssues.length && issue === 'Reshape this cell before making a solid panel.'));
    return [{ id: cell.id, stage: !cell.valid ? 'Outline' : 'Solid',
      issues: [...flatIssues.map(issue => `Outline: ${issue}`), ...solidIssues.map(issue => `Solid: ${issue}`),
        ...(!solid ? ['Solid: no solid geometry was produced.'] : [])] }];
  });
}
function updatePanelDiagnostics(waiting) {
  if (diagnosticResult === state.result && diagnosticWaiting === waiting) {
    for (const button of $('panel-problem-list').querySelectorAll('[data-panel-id]')) button.setAttribute('aria-pressed', String(Number(button.dataset.panelId) === state.selected));
    return;
  }
  diagnosticResult = state.result; diagnosticWaiting = waiting;
  const problems = panelProblems();
  $('panel-problems').hidden = !problems.length;
  $('panel-problem-count').textContent = String(problems.length);
  $('panel-problem-summary').textContent = waiting ? 'Updating panel checks. Export waits for the current calculation.' : `${problems.length} of ${state.cells.length} panels need review. Select a panel below to locate it and inspect its geometry.`;
  $('panel-problem-list').replaceChildren();
  if (waiting) return;
  for (const problem of problems) {
    const item = document.createElement('li'), button = document.createElement('button'), note = document.createElement('p');
    button.type = 'button'; button.className = 'problem-select'; button.dataset.panelId = problem.id;
    button.textContent = `${panelId(problem.id)} · ${problem.stage}`;
    button.setAttribute('aria-pressed', String(problem.id === state.selected));
    button.addEventListener('click', () => { showView(problem.stage === 'Outline' ? 'flat' : 'solid'); selectCell(problem.id); });
    note.textContent = problem.issues.join(' ') || 'No usable geometry was produced.';
    item.append(button, note); $('panel-problem-list').append(item);
  }
}
function updateExportAvailability() {
  laserUI.update({ result: state.result, name: state.name, center: state.analysis?.center, flipDirection: state.flipOutside,
    ready: !!state.cells.length && state.solved && !state.busy && !state.pending && !state.generating && !cornerPending && !directDrag() });
  const waiting = state.busy || !!state.pending || !state.cells.length || !state.solved || !!cornerPending || directDrag();
  const waitingReason = !state.cells.length ? 'Load a model and calculate panels first.' : cornerPending || directDrag()
    ? 'Finish the corner edit and wait for validation.' : 'Wait for the current panel calculation.';
  const invalid = state.cells.some(c => !c.valid);
  const solids = state.result?.solids || [], solidInvalid = solids.some(s => !s.valid);
  const problems = panelProblems(), problemReason = `${problems.length} panels need repair. Select a panel under Panels to resolve, or use Rhino repair export.`;
  const selected = state.cells.find(c => c.id === state.selected), selectedSolid = solids.find(s => s.id === state.selected);
  $('export-obj').disabled = waiting || state.view === 'reference' || (state.view === 'flat' && invalid) || (state.view === 'solid' && solidInvalid);
  $('save-study').disabled = waiting;
  $('export-dxf').disabled = waiting || invalid;
  $('export-dxf').title = waiting ? waitingReason : invalid ? 'Some fitted outlines cross, collapse or cannot be flattened. See Panels to resolve.' : 'Export flat outlines in millimetres';
  $('export-stl').disabled = waiting || !solids.length || solidInvalid;
  $('export-rhino').disabled = waiting || exportingRhino || invalid || solidInvalid || solids.length !== state.cells.length;
  $('export-rhino').title = waiting ? waitingReason : exportingRhino ? 'Preparing the Rhino file.' : problems.length ? problemReason : 'Rhino 6-compatible shared blocks: assembled parts and flat full-thickness copies. Uses current carving settings.';
  $('export-rhino-repair').disabled = waiting || exportingRhino;
  $('export-rhino-repair').title = waiting ? waitingReason : 'Override panel validity for Rhino editing. Includes every panel, available geometry and diagnostic notes. Review and repair before fabrication.';
  $('export-repair-shortcut').disabled = $('export-rhino-repair').disabled;
  $('export-repair-shortcut').title = $('export-rhino-repair').title;
  $('export-availability').textContent = waiting ? waitingReason : exportingRhino ? 'Preparing the Rhino file…' : problems.length ? `${problems.length} panels unresolved. Production export needs valid parts. Rhino repair includes candidates and reasons.` : 'All panels resolved. Rhino 6 / 7 / 8 exports are available.';
  $('export-stl').title = waiting ? waitingReason : solidInvalid ? problemReason : 'Export the solid panel meshes';
  $('export-selected-dxf').disabled = waiting || !selected?.valid;
  $('export-selected-obj').disabled = waiting || (state.view === 'solid' ? !selectedSolid?.valid : !selected?.valid);
  $('export-obj').title = waiting ? waitingReason : state.view === 'reference' ? 'Choose Cells, Flat or Solid to export panels.' : $('export-obj').disabled ? problemReason : state.view === 'surface' ? 'Export the current cells on the reference surface' : 'Export fitted flat panel candidates';
  $('export-selected-dxf').title = waiting ? waitingReason : !selected ? 'Select a panel first.' : !selected.valid ? 'This panel has an unresolved outline. See its diagnostic note or use Rhino repair.' : 'Export the selected flat outline.';
  $('export-selected-obj').title = waiting ? waitingReason : !selected ? 'Select a panel first.' : $('export-selected-obj').disabled ? 'This panel is unresolved. See its diagnostic note or use Rhino repair.' : 'Export the selected panel.';
  $('export-obj').childNodes.forEach(n => { if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) n.textContent = state.view === 'surface' ? '3D cell layout ' : state.view === 'solid' ? '3D solid panels ' : '3D flat panels '; });
  updatePanelDiagnostics(waiting);
}
async function exportRhino(repair = false) {
  updateExportAvailability();
  if ($(repair ? 'export-rhino-repair' : 'export-rhino').disabled) return;
  const name=state.name;
  exportingRhino=true;updateExportAvailability();setStatus(repair ? 'Preparing all panels and diagnostic notes for Rhino repair…' : 'Preparing linked Rhino panel blocks…');
  try {
    const {bytes}=await rhinoOperation({operation:repair ? 'repair-export' : 'export',cells:state.cells,solids:state.result.solids,sourceCells:repair ? state.result.surfaceCells : undefined,
      options:{name,up:$('model-up').value,carved:state.carve,rowWidth:Number($('export-row-width').value),spacing:Number($('export-spacing').value)}});
    verifyRhino6Export(bytes);
    download(`${name}-${repair ? 'repair' : 'production'}-rhino6.3dm`,bytes,'application/octet-stream');
    setStatus(repair ? 'Rhino 6 repair file exported · File version verified · Every panel included with geometry type and diagnostic notes · Repair candidates before fabrication' : 'Rhino 6 blocks exported · File version verified · Assembly and flat parts share definitions · Nominal outlines; prepare toolpaths in CAM');
  } catch(error) {setStatus(`Could not export Rhino: ${error.message}`,true);}
  finally {exportingRhino=false;updateExportAvailability();}
}
$('export-rhino').addEventListener('click', () => exportRhino(false));
$('export-rhino-repair').addEventListener('click', () => exportRhino(true));
$('export-repair-shortcut').addEventListener('click', () => exportRhino(true));
$('export-obj').addEventListener('click', () => {
  try {
    const flat = state.view !== 'surface';
    if (flat && state.cells.some(c => !c.valid)) { setStatus('Some cells cannot form a single flat panel yet. Try smaller cells or export the cell layout.', true); return; }
    const content = state.view === 'solid' ? exportSolidsOBJ(state.result.solids, { explode: explodeDistance() }) : exportCellsOBJ(flat ? state.cells : state.result.surfaceCells || state.cells, { flat, explode: explodeDistance() });
    download(`${state.name}-${state.view === 'solid' ? 'solid-panels' : flat ? 'flat-panels' : 'cell-layout'}.obj`, content, 'text/plain');
    setStatus(`Exported ${flat ? 'flat candidates' : 'surface cells'} matching this view${state.explode ? ' · Includes the exploded positions' : ''}`);
  } catch (error) { setStatus(error.message, true); }
});
$('export-dxf').addEventListener('click', () => {
  try { download(`${state.name}-flat-outlines.dxf`, exportCellsDXF(state.cells), 'application/dxf'); setStatus('Exported flat outline study · Joint allowances and sheet nesting are not included'); }
  catch (error) { setStatus(error.message, true); }
});
$('export-stl').addEventListener('click', () => {
  try { download(`${state.name}-solid-panels.stl`, exportSolidsSTL(state.result.solids, { explode: explodeDistance() }), 'model/stl'); setStatus('Exported the solid geometry shown in the preview · Units: mm'); }
  catch (error) { setStatus(error.message, true); }
});
$('export-selected-dxf').addEventListener('click', () => {
  try {
    const cell = state.cells.find(c => c.id === state.selected); if (!cell?.valid) return;
    download(`${state.name}-${panelId(cell.id)}.dxf`, exportCellsDXF([cell]), 'application/dxf');
    setStatus(`Exported ${panelId(cell.id)} flat outline · Units: mm`);
  } catch (error) { setStatus(error.message, true); }
});
$('export-selected-obj').addEventListener('click', () => {
  try {
    const cell = state.cells.find(c => c.id === state.selected); if (!cell) return;
    const solid = state.result.solids.find(s => s.id === cell.id);
    const content = state.view === 'solid' ? exportSolidsOBJ([solid], { explode: explodeDistance() }) : exportCellsOBJ([cell], { flat: true, explode: explodeDistance() });
    download(`${state.name}-${panelId(cell.id)}${state.view === 'solid' ? '-solid' : '-flat'}.obj`, content, 'text/plain');
    setStatus(`Exported ${panelId(cell.id)} ${state.view === 'solid' ? 'solid' : 'flat panel'}`);
  } catch (error) { setStatus(error.message, true); }
});
$('save-study').addEventListener('click', () => {
  if (!state.solved || state.busy || state.pending || cornerPending || directDrag()) return;
  finishPendingEdit();
  try {
    const study = createStudy(state, { units: $('model-units').value, up: $('model-up').value,
      camera: camera.position.toArray(), target: controls.target.toArray() });
    download(`${state.name}-study.json`, JSON.stringify(study), 'application/json');
    setStatus('Saved the model, surface layout and editing settings');
  } catch (error) { setStatus(`Could not save study: ${error.message}`, true); }
});
$('load-study').addEventListener('click', () => $('study-file').click());
function validateDesignGeometry(inputs) {
  const validationId = ++validationSequence;
  return new Promise((resolve, reject) => {
    studyValidations.set(validationId, { resolve, reject });
    validationWorker.postMessage({ validationId, ...inputs });
  });
}
function validateStudyGeometry(study) {
  const factor = { mm: 1, cm: 10, m: 1000 }[study.units];
  return validateDesignGeometry({
    model: { vertices: study.rawModel.vertices.map(point => point.map(value => value * factor)), triangles: study.rawModel.triangles },
    seeds: study.seeds, size: study.size, pattern: study.pattern, mergeGroups: study.mergeGroups, cornerEdits: study.cornerEdits, layout: study.layout, directBase: study.directBase });
}
$('study-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  const opening = ++studyOpenRevision;
  try {
    if (file.size > 30e6) throw new Error('Choose a study smaller than 30 MB.');
    const study = readStudy(await file.text());
    if (opening !== studyOpenRevision) return;
    setStatus('Checking the saved surface layout…');
    const { layout } = await validateStudyGeometry(study);
    if (opening !== studyOpenRevision) return;
    cancelPendingEdit();
    $('model-units').value = study.units; $('model-up').value = study.up;
    Object.assign(state, captureDesign(study));
    state.allowCellRemoval = study.allowCellRemoval; $('allow-cell-removal').checked = study.allowCellRemoval;
    $('size').min = Math.max(1, study.size / 3); $('size').max = study.size * 3;
    syncDesignControls();
    loadModel(study.rawModel, study.name, { seeds: study.seeds, mergeGroups: study.mergeGroups, cornerEdits: study.cornerEdits, layout, directBase: study.directBase, nextCellId: study.nextCellId, preserveSettings: true });
    document.querySelector(`[data-view="${study.view}"]`)?.click();
    if (study.camera && study.target) { camera.position.fromArray(study.camera); controls.target.fromArray(study.target); controls.update(); }
  } catch (error) { if (opening === studyOpenRevision) setStatus(`Could not open study: ${error.message}`, true); }
  event.target.value = '';
});
async function openMesh(file) {
  if (!file) return;
  const opening = ++studyOpenRevision;
  try {
    const rhino = /\.3dm$/i.test(file.name);
    if (!rhino && !/\.obj$/i.test(file.name)) throw new Error('Choose a Rhino 3DM or OBJ source file.');
    if (file.size > (rhino ? 60e6 : 20e6)) throw new Error(`Choose a ${rhino ? '3DM smaller than 60 MB' : 'OBJ smaller than 20 MB'}.`);
    setStatus(rhino ? 'Reading Rhino source geometry…' : 'Reading OBJ mesh…');
    const parsed = rhino ? (await rhinoOperation({operation:'import',bytes:await file.arrayBuffer()})).model : parseOBJ(await file.text());
    if (opening !== studyOpenRevision) return;
    $('model-units').value = 'mm';
    if (rhino) $('model-up').value = 'z';
    loadModel(parsed, file.name.replace(/\.(obj|3dm)$/i, ''));
    $('import-note').hidden = false;
    $('import-note').textContent = rhino ? `Rhino source converted to mm. ${(parsed.warnings || []).join(' ')}` : 'OBJ has no reliable units. Check Model settings.';
    document.querySelector('.model-settings').open = true;
  } catch (error) { if(opening === studyOpenRevision) setStatus(`Could not open mesh: ${error.message}`, true); }
}
$('import-model').addEventListener('click', () => $('mesh-file').click());
$('mesh-file').addEventListener('change', event => { openMesh(event.target.files[0]); event.target.value = ''; });
for (const example of exampleCatalog) {
  const option = document.createElement('option'); option.value = example.id; option.textContent = example.name;
  $('example-select').append(option);
}
$('example-select').value = DEFAULT_EXAMPLE_ID;
function describeExample() { $('example-select').title = exampleCatalog.find(example => example.id === $('example-select').value)?.description ?? ''; }
$('example-select').addEventListener('change', describeExample);
$('load-example').title = 'Load the selected example as a new study';
async function loadExample(id) {
  const opening = ++studyOpenRevision;
  try {
    const example = exampleCatalog.find(value => value.id === id);
    if (!example) throw new Error('Unknown example.');
    let model;
    if (example.url) {
      setStatus(`Loading ${example.name}…`);
      const response = await fetch(example.url);
      if (!response.ok) throw new Error('The local reference is unavailable.');
      const source = await response.text();
      if (opening !== studyOpenRevision) return;
      model = parseOBJ(source);
    } else model = createExample(id);
    if (opening !== studyOpenRevision) return;
    // Loading an example is an explicit document replacement, like opening a
    // mesh. Invalidate older asynchronous imports before installing this model.
    cancelPendingEdit(); cancelCornerDrag(); cancelCentreDrag(); cancelCornerPending();
    Object.assign(state, { variation: .3, randomSeed: 7, straightness: .7, thickness: 40, roundover: 2,
      carve: false, minimumThickness: 12, flipOutside: false, explode: 0, allowCellRemoval: true,
      edit: true, cornerMode: false, multiSelect: false, splitMode: false, view: 'surface' });
    $('model-units').value = example.units; $('model-up').value = example.up;
    $('explode').value = 0; $('allow-cell-removal').checked = true; $('corner-status').textContent = '';
    $('edit-toggle').setAttribute('aria-pressed', 'true'); $('corner-toggle').setAttribute('aria-pressed', 'false'); $('multi-select').setAttribute('aria-pressed', 'false');
    document.querySelectorAll('[data-view]').forEach(button => {
      const active = button.dataset.view === state.view;
      button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active));
    });
    $('example-select').value = id; describeExample();
    loadModel(model, example.name, { initialSize: example.initialSize, pattern: example.pattern });
    syncDesignControls(); updateViewportHint();
  } catch (error) {
    if (opening !== studyOpenRevision) return;
    if (!state.model) $('loading').hidden = true;
    setStatus(`Could not load example: ${error.message}`, true);
  }
}
$('load-example').addEventListener('click', () => loadExample($('example-select').value));
let dropDepth = 0;
document.addEventListener('dragenter', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dropDepth++; $('mesh-drop').hidden = false; } });
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
document.addEventListener('dragleave', () => { if (--dropDepth <= 0) { dropDepth = 0; $('mesh-drop').hidden = true; } });
document.addEventListener('drop', event => { event.preventDefault(); dropDepth = 0; $('mesh-drop').hidden = true; openMesh(event.dataTransfer?.files[0]); });

new ResizeObserver(() => {
  const width = viewport.clientWidth, height = viewport.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
}).observe(viewport);
function animate() { paintSplitPreview(); paintCornerSketch(); controls.update(); updateCornerPositions(); renderer.render(scene, camera); requestAnimationFrame(animate); }
animate();
// Read-only diagnostics for geometry and interaction verification.
window.cellStudy = { get state() { return state; }, get camera() { return camera; }, get controls() { return controls; },
  projectCellCentre(id) { const handle = seedGroup.children.find(child => child.userData.seedId === id); if (!handle) return null; const p = handle.position.clone().project(camera), r = renderer.domElement.getBoundingClientRect(); return { x: r.x + (p.x + 1) * r.width / 2, y: r.y + (1 - p.y) * r.height / 2, z: p.z }; },
  projectCorner(id) { const corner = arrangementCorners().find(c => c.id === id); if (!corner) return null; const position = cornerDisplayPosition(corner, state.view, camera.position.toArray()); if (!position) return null; const p = vectors(position).project(camera), r = renderer.domElement.getBoundingClientRect(); return { x: r.x + (p.x + 1) * r.width / 2, y: r.y + (1 - p.y) * r.height / 2, z: p.z }; },
  projectSeed(id) { const seed = state.seeds.find(s => s.id === id); if (!seed) return null; const p = vectors(seed.position).project(camera), r = renderer.domElement.getBoundingClientRect(); return { x: r.x + (p.x + 1) * r.width / 2, y: r.y + (1 - p.y) * r.height / 2, z: p.z }; } };
loadExample(DEFAULT_EXAMPLE_ID);
