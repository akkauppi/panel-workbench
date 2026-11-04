/** Browserless integration check: real app/worker/geometry, mocked rendering.
 * This does NOT verify WebGL output, browser layout, or real browser input.
 * Optional QA dependency: JSDOM_MODULE=/path/to/jsdom/lib/api.js node scripts/check-ui.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let jsdomPath = process.env.JSDOM_MODULE;
if (!jsdomPath) {
  try { jsdomPath = require.resolve('jsdom'); }
  catch { throw new Error('Install jsdom for this optional check, or set JSDOM_MODULE to its lib/api.js path.'); }
}
const { JSDOM, VirtualConsole } = require(jsdomPath);
const demo = new URL('../demo/', import.meta.url), errors = [], downloads = [], blobs = new Map(), fetchedURLs = [];
// Exercise optional local examples with public synthetic data. No private file
// is needed by this test or included in its fixtures.
const localExample = { id: 'qa-local-sheet', name: 'Local integration fixture', description: 'A synthetic local-only sheet.',
  units: 'mm', up: 'y', initialSize: 400, url: './local-examples/qa-local-sheet.obj' };
const localExampleOBJ = 'v -400 0 -300\nv 400 0 -300\nv 400 0 300\nv -400 0 300\nf 1 4 3\nf 1 3 2\n';
let localResponseMode = 'ready', releaseLocalResponse = null;
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(error));
const dom = new JSDOM(await readFile(new URL('index.html', demo), 'utf8'), {
  url: 'http://127.0.0.1:8787/', pretendToBeVisual: true, virtualConsole
});
const { window } = dom;
for (const name of ['window', 'document', 'Node', 'HTMLElement', 'HTMLCanvasElement', 'Event', 'MouseEvent']) globalThis[name] = name === 'window' ? window : window[name];
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true });
globalThis.devicePixelRatio = 1;
const animationFrames = [];
globalThis.requestAnimationFrame = callback => animationFrames.push(callback);
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; } observe() { queueMicrotask(() => this.callback()); } disconnect() {} };
Object.defineProperties(window.HTMLElement.prototype, {
  clientWidth: { get() { return 1024; }, configurable: true },
  clientHeight: { get() { return 720; }, configurable: true }
});
window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1024, bottom: 720, width: 1024, height: 720 });
window.HTMLElement.prototype.setPointerCapture = function (id) { this._capture = id; };
window.HTMLElement.prototype.releasePointerCapture = function () { this._capture = null; };
window.HTMLElement.prototype.hasPointerCapture = function (id) { return this._capture === id; };
const drawing = new Proxy({}, { get: (target, key) => key in target ? target[key] : () => {}, set: (target, key, value) => (target[key] = value, true) });
window.HTMLCanvasElement.prototype.getContext = () => drawing;
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
URL.createObjectURL = blob => { const url = `blob:check-${blobs.size}`; blobs.set(url, blob); return url; };
URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { downloads.push({ name: this.download, blob: blobs.get(this.href) }); };
globalThis.fetch = async input => {
  fetchedURLs.push(String(input));
  if (String(input).endsWith('/local-examples/qa-local-sheet.obj')) {
    if (localResponseMode === 'missing') return new Response('missing', { status: 404 });
    if (localResponseMode === 'hold') await new Promise(resolve => { releaseLocalResponse = resolve; });
    return new Response(localExampleOBJ);
  }
  const url = new URL(String(input), demo);
  try { return new Response(await readFile(url)); }
  catch { return new Response('missing', { status: 404 }); }
};

globalThis.__uiRenderers = [];
const mockModule = 'qa:three-renderer';
const localExamplesModule = 'qa:local-examples';
const recoveryModule = 'qa:project-recovery';
const actualRecovery = new URL('project-recovery.js', demo).href;
// Browserless tests use transactional in-memory storage. Chromium separately
// verifies the actual IndexedDB adapter and reload recovery.
const recoveryRecords = new Map(), recoveryTexts = new Map();
let recoveryQueue = Promise.resolve();
globalThis.__recoveryStorage = {
  async list() { await recoveryQueue; return structuredClone([...recoveryRecords.values()]); },
  async read(id) { await recoveryQueue; return recoveryTexts.get(id) ?? null; },
  commit(decide) {
    const task = recoveryQueue.then(() => {
      const plan = decide(structuredClone([...recoveryRecords.values()]));
      for (const id of plan.remove) { recoveryRecords.delete(id); recoveryTexts.delete(id); }
      recoveryRecords.set(plan.record.id, structuredClone(plan.record)); recoveryTexts.set(plan.record.id, plan.text);
      return structuredClone(plan.result);
    });
    recoveryQueue = task.catch(() => {}); return task;
  },
  async remove(id) { await recoveryQueue; recoveryRecords.delete(id); recoveryTexts.delete(id); }, close() {}
};
const actualThree = new URL('vendor/three.module.js', demo).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './local-examples.js' && context.parentURL === new URL('app.js', demo).href) return { url: localExamplesModule, shortCircuit: true };
    if (specifier === './project-recovery.js' && context.parentURL === new URL('project-ui.js', demo).href) return { url: recoveryModule, shortCircuit: true };
    if (specifier === 'three') return { url: mockModule, shortCircuit: true };
    if (specifier.startsWith('three/addons/')) return { url: new URL(`vendor/addons/${specifier.slice('three/addons/'.length)}`, demo).href, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === recoveryModule) return { format: 'module', shortCircuit: true, source: `import {createRecoveryStore as create} from ${JSON.stringify(actualRecovery)}; export function createRecoveryStore(options={}) {return create({...options,storageFactory:()=>globalThis.__recoveryStorage});}` };
    if (url === localExamplesModule) return { format: 'module', shortCircuit: true, source: `export const LOCAL_EXAMPLES = ${JSON.stringify([localExample])};` };
    if (url !== mockModule) return next(url, context);
    return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(actualThree)};
      export class WebGLRenderer {
        constructor() { this.domElement = document.createElement('canvas'); globalThis.__uiRenderers.push(this); }
        setPixelRatio() {} setSize(w,h) { this.domElement.width=w; this.domElement.height=h; }
        render(scene,camera) { this.scene=scene; this.camera=camera; scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); }
        dispose() {}
      }
    ` };
  }
});

const validationReplies = [], heldValidationReplies = [], heldFitReplies = [], rhinoExports = [];
let failNextFitReply = false;
let holdNextValidationReply = false, holdNextFitReply = false, alterNextFitReply = null, returnNextRhino7Header = false;
globalThis.Worker = class {
  constructor(path) {
    const owner = this;
    this.context = { postMessage(data) {
      if (data.bytes && returnNextRhino7Header) {
        // One stale worker response, without changing the current native writer
        // or later exports. Only the 32-byte archive header is replaced.
        returnNextRhino7Header = false;
        data = structuredClone(data);
        const header = new TextDecoder('ascii').decode(data.bytes.subarray(0, 32));
        assert.match(header, /^3D Geometry File Format\s+60$/);
        data.bytes.set(new TextEncoder().encode(`${header.slice(0, -2)}70`), 0);
      }
      if (data.result && alterNextFitReply) {
        data = structuredClone(data);
        const alter = alterNextFitReply; alterNextFitReply = null;
        alter(data.result);
      }
      if (data.result && failNextFitReply) { failNextFitReply = false; data = { id: data.id, error: 'Synthetic fitting worker failure' }; }
      const deliver = () => queueMicrotask(() => {
        owner.onmessage?.({ data: structuredClone(data) });
        if (data.validationId !== undefined) validationReplies.push(structuredClone(data));
      });
      if (data.validationId !== undefined && holdNextValidationReply) {
        holdNextValidationReply = false;
        heldValidationReplies.push({ data: structuredClone(data), deliver });
      } else if (data.id !== undefined && holdNextFitReply) {
        holdNextFitReply = false; heldFitReplies.push({ data: structuredClone(data), deliver });
      } else deliver();
    } };
    globalThis.self = this.context;
    this.ready = import(new URL(path, demo).href).then(module => { this.context.onmessage = module.createWorkerHandler(this.context.postMessage); });
  }
  postMessage(data) {
    const copy = structuredClone(data);
    if (data.operation === 'export' || data.operation === 'repair-export') rhinoExports.push(copy);
    this.ready.then(() => setTimeout(() => {
      try { this.context.onmessage({ data: copy }); }
      catch (error) { this.onerror?.(error); }
    }, 0)).catch(error => this.onerror?.(error));
  }
  terminate() {}
};

const $ = id => document.getElementById(id);
function flush() { for (const callback of animationFrames.splice(0)) callback(performance.now()); for (const r of globalThis.__uiRenderers) if (r.scene) r.render(r.scene, r.camera); }
async function until(predicate, label, timeout = 45000) {
  const started = Date.now();
  while (!predicate()) {
    if (errors.length) throw errors[0];
    if (Date.now() - started > timeout) throw new Error(`Timed out: ${label}. Status: ${$('status')?.textContent}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  flush();
}
function revealControl(element) {
  const panel = element.closest('[data-ribbon-panel]');
  if (panel?.hidden) document.querySelector(`[data-ribbon-tab="${panel.dataset.ribbonPanel}"]`).click();
  for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
}
function clickControl(id) { revealControl($(id)); $(id).click(); }
function input(id, value, type = 'input') { revealControl($(id)); $(id).value = value; $(id).dispatchEvent(new window.Event(type, { bubbles: true })); }
function pointer(canvas, type, x, y, { shiftKey = false, altKey = false } = {}) {
  const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, shiftKey, altKey, bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
  canvas.dispatchEvent(event);
  flush();
}
function loadFile(id, file) {
  revealControl($(id));
  Object.defineProperty($(id), 'files', { value: [file], configurable: true });
  $(id).dispatchEvent(new window.Event('change', { bubbles: true }));
}

await import(new URL('app.js', demo).href);
await until(() => window.cellStudy?.state.ready && window.cellStudy.state.solved, 'initial model');
const state = window.cellStudy.state;
const { EXAMPLES, DEFAULT_EXAMPLE_ID, createExample } = await import(new URL('examples.js', demo).href);
const defaultExample = createExample(DEFAULT_EXAMPLE_ID);
const expectedExampleCounts = { 'barrel-vault': 45, dome: 24, 'aperture-sheet': 132, saddle: 44, 'organic-vessel': 100 };
assert.equal(state.name, defaultExample.name);
assert.equal(state.size, EXAMPLES.find(example => example.id === DEFAULT_EXAMPLE_ID).initialSize);
assert.equal(state.cells.length, expectedExampleCounts[DEFAULT_EXAMPLE_ID]);
assert.deepEqual(state.rawModel.vertices, defaultExample.vertices);
assert.deepEqual(state.rawModel.triangles, defaultExample.triangles);
assert.deepEqual([...$('example-select').options].map(option => ({ id: option.value, name: option.textContent })),
  [...EXAMPLES, localExample].map(({ id, name }) => ({ id, name })), 'the selector exposes the public catalog and optional local entry');
assert.equal($('example-select').value, DEFAULT_EXAMPLE_ID);
assert.equal(fetchedURLs.filter(url => /\.obj(?:$|[?#])/i.test(url)).length, 0, 'startup generates its example without fetching a mesh asset');
function assertResolvedExample(label) {
  assert.ok(state.cells.length > 0, `${label} generates cells`);
  assert.deepEqual(state.cells.filter(cell => !cell.valid).map(({ id, issues }) => ({ id, issues })), [], `${label}: all fitted panels resolve`);
  assert.deepEqual(state.result.solids.filter(solid => !solid.valid).map(({ id, issues }) => ({ id, issues })), [], `${label}: all actual solids resolve`);
  assert.equal(state.result.solids.length, state.cells.length);
  assert.equal(state.result.stats.invalidCellCount, 0);
  assert.ok(state.result.stats.coverageError < 1e-8, `${label} covers the source completely`);
  assert.ok(state.result.stats.maxPlanarityError <= .25, `${label} respects the flatness tolerance`);
  assert.ok(state.result.stats.maxSeamGap <= 1e-6, `${label} keeps shared fitted edges matched`);
  assert.equal($('stock-check').textContent, `${state.cells.length}/${state.cells.length} solids resolved`);
  assert.doesNotMatch($('junction-note').textContent, /need reshaping/);
}
assert.deepEqual({ variation: state.variation, randomSeed: state.randomSeed,
  straightness: state.straightness, thickness: state.thickness, roundover: state.roundover, carve: state.carve },
{ variation: .3, randomSeed: 7, straightness: .7, thickness: 40, roundover: 2, carve: false },
'default quality is checked at the actual startup settings');
assertResolvedExample('default synthetic example');
assert.equal(state.layout?.format, 'panel-source-layout');
assert.equal(state.layout.version, 1);
assert.equal(state.layout.cells.length, state.cells.length);
console.log(`PASS synthetic ${state.name} initialization: ${state.cells.length}/${state.cells.length} fitted panels and solids resolved`);

const ribbonNames = ['file', 'modify', 'layout', 'view', 'export'];
function assertRibbon(active) {
  assert.deepEqual([...document.querySelectorAll('[data-ribbon-tab]')].map(tab => tab.dataset.ribbonTab), ribbonNames);
  for (const name of ribbonNames) {
    const tab = $(`ribbon-tab-${name}`), panel = $(`ribbon-panel-${name}`);
    assert.equal(tab.getAttribute('role'), 'tab');
    assert.equal(tab.getAttribute('aria-controls'), panel.id);
    assert.equal(tab.getAttribute('aria-selected'), String(name === active));
    assert.equal(tab.tabIndex, name === active ? 0 : -1, 'only the active ribbon tab is in the tab sequence');
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
    assert.equal(panel.hidden, name !== active, 'only the selected ribbon panel is shown');
  }
}
assertRibbon('modify');
const ribbonBefore = { revision: state.revision, history: state.history.length, layout: JSON.stringify(state.layout) };
for (const name of ribbonNames) { $(`ribbon-tab-${name}`).click(); assertRibbon(name); }
$('ribbon-tab-modify').click(); $('ribbon-tab-modify').focus();
for (const [key, expected] of [['ArrowRight', 'layout'], ['End', 'export'], ['Home', 'file'], ['ArrowLeft', 'export'], ['ArrowRight', 'file']]) {
  document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  assertRibbon(expected);
  assert.equal(document.activeElement, $(`ribbon-tab-${expected}`), 'ribbon keyboard navigation moves focus and selection together');
}
$('ribbon-tab-modify').click();
assert.deepEqual({ revision: state.revision, history: state.history.length, layout: JSON.stringify(state.layout) }, ribbonBefore,
  'ribbon navigation does not edit the document');
assert.ok($('document-name').textContent.includes(state.name));
assert.ok($('active-tool-name').textContent.trim());
const initialSelectionContext = $('ribbon-selection-context').textContent;
assert.ok(initialSelectionContext.trim());
console.log('PASS ribbon tabs, accessible keyboard navigation and document context');

function assertViewMirrors(view) {
  for (const button of document.querySelectorAll('[data-view], [data-browser-view]')) {
    assert.equal(button.getAttribute('aria-pressed'), String((button.dataset.view || button.dataset.browserView) === view),
      'the Study Browser and document tabs share one active view');
  }
  assert.ok($('view-name').textContent.trim());
}
const viewLabels = new Set();
for (const view of ['flat', 'solid', 'reference', 'surface']) {
  document.querySelector(`[data-browser-view="${view}"]`).click();
  assert.equal(state.view, view); assertViewMirrors(view);
  viewLabels.add($('view-name').textContent.trim());
}
assert.equal(viewLabels.size, 4, 'the viewport names each distinct view');
const cameraBefore = { revision: state.revision, history: state.history.length, layout: JSON.stringify(state.layout) };
$('ribbon-tab-view').click();
for (const view of ['top', 'front', 'right', 'iso']) {
  document.querySelector(`[data-camera-view="${view}"]`).click(); flush();
  const direction = window.cellStudy.camera.position.clone().sub(window.cellStudy.controls.target).normalize();
  if (view === 'top') assert.ok(direction.dot(window.cellStudy.camera.up) > .999);
  if (view === 'front') assert.ok(direction.z > .999);
  if (view === 'right') assert.ok(direction.x > .999);
  if (view === 'iso') assert.ok(Math.abs(direction.x) > .2 && Math.abs(direction.y) > .2 && Math.abs(direction.z) > .2);
  for (const button of document.querySelectorAll('[data-camera-view]')) assert.equal(button.getAttribute('aria-pressed'), String(button.dataset.cameraView === view));
}
assert.deepEqual({ revision: state.revision, history: state.history.length, layout: JSON.stringify(state.layout) }, cameraBefore,
  'camera orientation does not regenerate or edit source geometry');
$('ribbon-tab-modify').click();
console.log('PASS Study Browser view synchronization and real standard camera orientations');

for (const view of ['flat', 'solid', 'reference', 'surface']) {
  document.querySelector(`[data-view="${view}"]`).click();
  assert.equal(state.view, view);
  assertViewMirrors(view);
  assert.equal($('export-obj').disabled, view === 'reference', 'resolved examples allow source, fitted and solid export');
  assert.equal($('export-dxf').disabled, false);
  assert.equal($('export-stl').disabled, false);
  assert.equal($('save-study').disabled, false);
}
assert.equal($('stock-check').previousElementSibling.textContent, 'Solid panels');
console.log('PASS view controls and complete synthetic-example export availability');

const count = state.cells.length, revision = state.revision;
input('size', Number(state.size) * 1.25);
await new Promise(resolve => setTimeout(resolve, 220));
assert.equal(state.cells.length, count, 'draft cell size must preserve the current design');
assert.equal(state.revision, revision, 'draft cell size must wait for explicit generation');
clickControl('regenerate');
await until(() => state.revision > revision && state.solved, 'cell size');
assert.notEqual(state.cells.length, count);
console.log(`PASS cell-size control: ${count} → ${state.cells.length} cells`);

// Exercise real raycasting and the real pointer handlers against a DOM canvas.
const canvas = document.querySelector('#viewport canvas');
let selected = null, selectedScreen;
for (const seed of state.seeds) {
  const p = window.cellStudy.projectSeed(seed.id);
  if (!p || p.z < -1 || p.z > 1 || p.x < 30 || p.x > 994 || p.y < 30 || p.y > 690) continue;
  pointer(canvas, 'pointerdown', p.x, p.y);
  pointer(canvas, 'pointerup', p.x, p.y);
  if (state.selected !== null) { selected = state.selected; selectedScreen = p; break; }
}
assert.notEqual(selected, null, 'a front-facing cell must be selectable');
assert.equal($('selection-details').hidden, false);
assert.notEqual($('ribbon-selection-context').textContent, initialSelectionContext, 'ribbon context follows actual panel selection');
const oldArea = state.cells.find(c => c.id === selected).area, weightRevision = state.revision;
input('cell-weight', 140);
await until(() => state.revision > weightRevision && state.solved, 'cell influence');
assert.equal(state.seeds.find(s => s.id === selected).weight, 1.4);
assert.notEqual(state.cells.find(c => c.id === selected)?.area, oldArea);
console.log('PASS cell selection and local influence change actual geometry');

flush();
const p = window.cellStudy.projectSeed(selected), oldPosition = [...state.seeds.find(s => s.id === selected).position], dragRevision = state.revision;
pointer(canvas, 'pointerdown', p.x, p.y);
pointer(canvas, 'pointermove', p.x + 12, p.y + 6);
pointer(canvas, 'pointerup', p.x + 12, p.y + 6);
await until(() => state.revision > dragRevision && state.solved, 'manual center drag');
assert.notDeepEqual(state.seeds.find(s => s.id === selected).position, oldPosition);
console.log('PASS manual center drag regenerates real cells');

document.querySelector('[data-view="solid"]').click();
const saveSeeds = structuredClone(state.seeds), saveLayout = structuredClone(state.layout);
const saveSource = state.result.surfaceCells.map(cell => surfaceShape(cell));
clickControl('save-study');
const saved = downloads.at(-1);
assert.ok(saved?.name.endsWith('-study.json'));
const savedText = await saved.blob.text(), savedStudy = JSON.parse(savedText);
assert.equal(savedStudy.version, 6);
assert.deepEqual(savedStudy.seeds, saveSeeds);
assert.deepEqual(savedStudy.layout, saveLayout);
const reopenRevision = state.revision;
loadFile('study-file', { name: 'roundtrip.json', size: savedText.length, text: async () => savedText });
await until(() => state.revision > reopenRevision && state.solved, 'saved study reopen');
assert.deepEqual(state.seeds, saveSeeds);
assert.deepEqual(state.layout, saveLayout);
assert.deepEqual(state.result.surfaceCells.map(cell => surfaceShape(cell)), saveSource);
assert.equal(state.view, 'solid');
console.log('PASS saved-study model, edited centers and view round trip');

const exportable = state.result.solids.find(s => s.valid);
assert.ok(exportable);
// Diagnostics expose state deliberately; selectCell remains exercised above.
state.selected = exportable.id;
state.selectedIds = [exportable.id];
document.querySelector('[data-view="solid"]').click();
clickControl('export-selected-obj');
const exported = downloads.at(-1);
assert.ok(exported.name.endsWith('-solid.obj'));
assert.ok((await exported.blob.text()).includes('# Panel Workbench solid panels'));
assert.equal($('export-obj').disabled, state.result.solids.some(s => !s.valid));
console.log('PASS selected-solid export and incomplete full-export blocking');

const carveRevision = state.revision, layoutBeforeCarving = JSON.stringify(state.layout);
$('carve-inner').checked = true;
$('carve-inner').dispatchEvent(new Event('change', { bubbles: true }));
await until(() => state.revision > carveRevision && state.solved, 'inside carving');
assert.equal(state.carve, true);
assert.ok(state.result.carving.carvedCount > 0);
assert.ok(state.result.solids.some(s => s.carved && Number.isFinite(s.minRemainingThickness)));
assert.equal($('export-stl').disabled, state.result.solids.some(s => !s.valid));
assert.equal(JSON.stringify(state.layout), layoutBeforeCarving, 'carving preserves the authoritative source layout exactly');
console.log('PASS actual inside carving, stock checks and export gating');

// Choosing a catalog entry is a draft until Load explicitly starts a new document.
const alternate = EXAMPLES.find(example => example.id !== DEFAULT_EXAMPLE_ID);
assert.ok(alternate, 'the gallery includes more than one example');
const beforeExample = { revision: state.revision, layout: JSON.stringify(state.layout), modelRevision: state.modelRevision };
$('example-select').value = alternate.id;
$('example-select').dispatchEvent(new Event('change', { bubbles: true }));
assert.equal(state.revision, beforeExample.revision);
assert.equal(JSON.stringify(state.layout), beforeExample.layout);
clickControl('load-example');
await until(() => state.modelRevision > beforeExample.modelRevision && state.solved, 'load a different synthetic example');
const alternateModel = createExample(alternate.id);
assert.equal(state.name, alternate.name);
assert.equal(state.size, alternate.initialSize);
assert.equal(state.cells.length, expectedExampleCounts[alternate.id]);
assert.deepEqual(state.rawModel.vertices, alternateModel.vertices);
assert.deepEqual(state.rawModel.triangles, alternateModel.triangles);
assertResolvedExample(alternate.name);
assert.deepEqual(state.history, []); assert.deepEqual(state.future, []);
assert.deepEqual(state.mergeGroups, []); assert.deepEqual(state.cornerEdits, []); assert.equal(state.directBase, null);
assert.deepEqual(state.selectedIds, []);
assert.equal(state.view, 'surface'); assert.equal(state.edit, true); assert.equal(state.cornerMode, false);
assert.equal(state.explode, 0); assert.equal(state.carve, false);
assert.equal(state.thickness, 40); assert.equal(state.roundover, 2);
assert.equal($('model-units').value, 'mm'); assert.equal($('model-up').value, 'y');
assert.equal($('undo-move').disabled, true); assert.equal($('redo-edit').disabled, true);

const organicExample = EXAMPLES.find(example => example.id === 'organic-vessel');
assert.ok(organicExample, 'the public gallery includes an organic example');
await edit(() => { $('example-select').value = organicExample.id; clickControl('load-example'); }, 'load the organic vessel');
assert.equal(state.name, organicExample.name);
assert.ok($('document-name').textContent.includes(organicExample.name), 'document title updates when a different source opens');
assert.equal(state.size, organicExample.initialSize);
assert.equal(state.cells.length, expectedExampleCounts[organicExample.id]);
assert.equal(state.model.vertices.length, 1345);
assert.equal(state.model.triangles.length, 2640);
assertResolvedExample(organicExample.name);
for (const view of ['reference', 'flat', 'solid']) {
  document.querySelector(`[data-view="${view}"]`).click();
  assert.equal(state.view, view);
  assert.equal($('export-obj').disabled, view === 'reference');
  assert.equal($('export-dxf').disabled, false);
  assert.equal($('export-stl').disabled, false);
}
console.log('PASS organic vessel preset: 100/100 fitted panels and solids with honest export gates');

assert.equal(fetchedURLs.filter(url => url.endsWith('/local-examples/qa-local-sheet.obj')).length, 0,
  'discovering a local catalog entry must not fetch its model');
await edit(() => { $('example-select').value = localExample.id; clickControl('load-example'); }, 'load the optional local fixture');
assert.equal(state.name, localExample.name);
assert.equal(state.size, localExample.initialSize);
assert.equal(state.model.vertices.length, 4);
assert.equal(state.model.triangles.length, 2);
assertResolvedExample(localExample.name);
assert.deepEqual(state.history, []); assert.deepEqual(state.future, []);
assert.equal(fetchedURLs.filter(url => url.endsWith('/local-examples/qa-local-sheet.obj')).length, 1);
await edit(() => { input('thickness', 45); input('thickness', 45, 'change'); }, 'edit the local fixture');
const beforeLocalFailure = structuredClone({ design: currentDesign(), model: state.model, name: state.name,
  history: state.history, future: state.future, revision: state.revision, modelRevision: state.modelRevision });
localResponseMode = 'missing';
clickControl('load-example');
await until(() => $('status').textContent.startsWith('Could not load example:'), 'reject a missing optional local mesh');
assert.deepEqual({ design: currentDesign(), model: state.model, name: state.name, history: state.history,
  future: state.future, revision: state.revision, modelRevision: state.modelRevision }, beforeLocalFailure,
'a failed optional mesh fetch preserves the full accepted document and history');
assert.equal(state.solved, true); assert.equal($('save-study').disabled, false);

localResponseMode = 'hold';
clickControl('load-example');
await until(() => releaseLocalResponse !== null, 'hold an older local mesh request');
await edit(() => { $('example-select').value = DEFAULT_EXAMPLE_ID; clickControl('load-example'); }, 'replace a pending local request with a public example');
const afterReplacement = structuredClone({ design: currentDesign(), name: state.name,
  revision: state.revision, modelRevision: state.modelRevision });
localResponseMode = 'ready'; releaseLocalResponse(); releaseLocalResponse = null;
await new Promise(resolve => setTimeout(resolve, 100));
assert.deepEqual({ design: currentDesign(), name: state.name, revision: state.revision, modelRevision: state.modelRevision }, afterReplacement,
  'a stale optional mesh response cannot overwrite the replacement document');
assert.equal(state.name, defaultExample.name);
assert.deepEqual(state.history, []); assert.deepEqual(state.future, []);
console.log('PASS optional local examples fetch on demand; missing and stale responses preserve the accepted document');

const returnRevision = state.revision;
loadFile('study-file', { name: 'edited-example.json', size: savedText.length, text: async () => savedText });
await until(() => state.revision > returnRevision && state.solved, 'reopen an edited study after switching examples');
assert.deepEqual(state.layout, saveLayout);
assert.deepEqual(state.seeds, saveSeeds);
assert.equal(state.view, 'solid');
assert.deepEqual(state.history, []); assert.deepEqual(state.future, []);
console.log('PASS explicit example loading creates a fresh document; saved custom geometry reopens intact');

const obj = 'v 0 0 0\nv 1000 0 0\nv 1000 1000 0\nv 0 1000 0\nf 1 2 3 4\n';
const importRevision = state.revision;
loadFile('mesh-file', { name: 'test-sheet.obj', size: obj.length, text: async () => obj });
await until(() => state.revision > importRevision && state.solved, 'new OBJ import');
assert.equal(state.name, 'test-sheet'); assert.equal(state.model.triangles.length, 2);
$('model-up').value = 'z';
$('model-up').dispatchEvent(new Event('change', { bubbles: true }));
assert.deepEqual(window.cellStudy.camera.up.toArray(), [0, 0, 1]);
const mappedUp = window.cellStudy.camera.up.clone().applyQuaternion(window.cellStudy.controls._quat);
assert.ok(mappedUp.distanceTo(new (await import(actualThree)).Vector3(0, 1, 0)) < 1e-9);
for (const view of ['top', 'front', 'right', 'iso']) {
  document.querySelector(`[data-camera-view="${view}"]`).click(); flush();
  const direction = window.cellStudy.camera.position.clone().sub(window.cellStudy.controls.target).normalize();
  if (view === 'top') assert.ok(direction.z > .999, 'Z-up Top looks along the model up axis');
  if (view === 'front') assert.ok(direction.y < -.999, 'Z-up Front looks from negative Y');
  if (view === 'right') assert.ok(direction.x > .999);
  if (view === 'iso') assert.ok(direction.x > .2 && direction.y < -.2 && direction.z > .2);
  assert.equal(document.querySelector(`[data-camera-view="${view}"]`).getAttribute('aria-pressed'), 'true');
}
assert.equal(errors.length, 0, errors.map(e => e.message).join('\n'));
console.log('PASS new OBJ import, Z-up orbit orientation and matching standard camera views');

// A planar strip gives four predictable cells with a known non-adjacent pair.
// Test through actual clicks and saved-study loading, with no mutation of edit state.
const vertices = [], triangles = [];
for (let y = 0; y <= 4; y++) for (let x = 0; x <= 16; x++) vertices.push([x * 200, y * 200, 0]);
for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) {
  const a = y * 17 + x, b = a + 1, c = a + 17, d = c + 1;
  triangles.push([a, b, d], [a, d, c]);
}
const stripStudy = {
  format: 'sauna-cell-study', version: 2, name: 'manual-edit-strip',
  rawModel: { vertices, triangles }, units: 'mm', up: 'y',
  size: 800, variation: 0, randomSeed: 7, mergeGroups: [],
  seeds: [10, 20, 30, 40].map((id, index) => ({ id, position: [400 + index * 800, 400, 0], weight: 1 })),
  straightness: .7, thickness: 40, roundover: 0, carve: false, minimumThickness: 12, flipOutside: false,
  view: 'surface', camera: [1600, 400, 6500], target: [1600, 400, 0]
};
async function openStudy(study, label) {
  const text = typeof study === 'string' ? study : JSON.stringify(study), before = state.revision;
  loadFile('study-file', { name: 'editing-study.json', size: text.length, text: async () => text });
  await until(() => state.revision > before && state.solved, label);
}
async function edit(action, label) {
  const before = state.revision;
  action();
  await until(() => {
    if (!state.generating && $('status').textContent.startsWith('Arrangement not applied:')) throw new Error(`${label}: ${$('status').textContent}`);
    return state.revision > before && state.solved;
  }, label);
}
function clickSeed(id, options) {
  flush();
  const screen = window.cellStudy.projectSeed(id);
  assert.ok(screen && screen.x > 0 && screen.x < 1024 && screen.y > 0 && screen.y < 720, `cell ${id} must be visible`);
  pointer(canvas, 'pointerdown', screen.x, screen.y, options);
  pointer(canvas, 'pointerup', screen.x, screen.y, options);
}
function key(key, { shiftKey = false } = {}) {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey, bubbles: true, cancelable: true }));
}
function escape() {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}
function assertNeutralTools(label) {
  assert.equal(state.selected, null, `${label}: clears the selected panel`);
  assert.deepEqual(state.selectedIds, [], `${label}: clears multi-selection`);
  assert.equal(state.selectedCorner, null, `${label}: clears the selected corner`);
  for (const [id, field] of [['edit-toggle', 'edit'], ['corner-toggle', 'cornerMode'], ['multi-select', 'multiSelect'], ['split-cell', 'splitMode'], ['across-bend-toggle','acrossBendMode']]) {
    assert.equal(state[field], false, `${label}: resets ${field}`);
    assert.equal($(id).getAttribute('aria-pressed'), 'false', `${label}: ${id} reflects its inactive mode`);
  }
  assert.equal(window.cellStudy.controls.enabled, true, `${label}: restores camera controls`);
  assert.equal($('viewport').style.cursor, 'default', `${label}: restores the cursor`);
  assert.equal(canvas.hasPointerCapture(1), false, `${label}: releases pointer capture`);
}
function surfaceShape(cell) {
  return structuredClone({ positions: cell.positions, triangles: cell.triangles, loops: cell.loops, area: cell.area });
}
function currentDesign() {
  return structuredClone({ layout: state.layout, directBase: state.directBase, pattern: state.pattern, seeds: state.seeds, mergeGroups: state.mergeGroups, cornerEdits: state.cornerEdits, size: state.size, variation: state.variation,
    randomSeed: state.randomSeed, maxGeneratedCells: state.maxGeneratedCells, thickness: state.thickness, straightness: state.straightness,
    roundover: state.roundover, carve: state.carve, minimumThickness: state.minimumThickness, flipOutside: state.flipOutside });
}
function close(actual, expected, label, tolerance = 1e-5) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);
}
async function saveStudy() {
  assert.equal($('save-study').disabled, false);
  const before = downloads.length;
  clickControl('save-study');
  assert.equal(downloads.length, before + 1);
  const study = JSON.parse(await downloads.at(-1).blob.text());
  assert.equal(study.version, 6, 'new saves include the authored layout and its reset baseline');
  assert.equal(study.layout?.format, 'panel-source-layout');
  assert.deepEqual(study.layout, state.layout, 'saving preserves the accepted source layout exactly');
  assert.deepEqual(study.directBase, state.directBase);
  assert.deepEqual(study.pattern, state.pattern);
  assert.equal(study.allowCellRemoval, state.allowCellRemoval);
  return study;
}
// A narrow synthetic panel deterministically constrains its roundover. Keep this
// diagnostic independent of which public gallery example starts the app.
const narrowPanelStudy = { ...stripStudy, version: 3, name: 'narrow-roundover-panel', cornerEdits: [],
  rawModel: { vertices: [[0, 0, 0], [8, 0, 0], [8, 200, 0], [0, 200, 0]], triangles: [[0, 1, 2], [0, 2, 3]] },
  seeds: [{ id: 0, position: [4, 100, 0], weight: 1 }], size: 200, roundover: 2,
  camera: [4, 100, 700], target: [4, 100, 0] };
await openStudy(narrowPanelStudy, 'synthetic constrained-roundover fixture');
const clampedSolid = state.result.solids[0];
assert.equal(clampedSolid.valid, true);
assert.equal(clampedSolid.radiusClamped, true);
assert.ok(clampedSolid.actualRadius < clampedSolid.requestedRadius);
clickSeed(0);
document.querySelector('[data-view="solid"]').click();
assert.equal($('selected-roundover-row').hidden, false);
assert.match($('selected-roundover').textContent, /mm used.*mm requested/);
assert.ok($('selected-roundover').title.includes(`Used ${clampedSolid.actualRadius} mm`));
assert.ok($('selected-roundover').title.includes(`requested ${clampedSolid.requestedRadius} mm`));
document.querySelector('[data-view="surface"]').click();
assert.match($('selected-note').textContent, /^Fitted panel:/, 'Cells inspector identifies the downstream result being diagnosed');
await edit(() => { input('roundover', 0); input('roundover', 0, 'change'); }, 'remove rounding from narrow panel');
assert.equal(state.result.solids[0].radiusClamped, false);
assert.equal($('selected-roundover-row').hidden, true, 'a new result clears the previous rounding adjustment');
assert.equal($('selected-roundover').textContent, '—');
assert.equal($('selected-roundover').title, '');
console.log('PASS synthetic constrained-roundover fixture displays actual and requested radius');

// A real disconnected source region cannot become one fitted panel. Keep this
// negative case even when the default example has no unresolved geometry.
const disconnectedPanelStudy = { ...stripStudy, version: 3, name: 'disconnected-panel-diagnostics', cornerEdits: [],
  rawModel: { vertices: [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0], [200, 0, 0], [300, 0, 0], [300, 100, 0], [200, 100, 0]],
    triangles: [[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7]] },
  seeds: [{ id: 0, position: [50, 50, 0], weight: 1 }], size: 500,
  camera: [150, 50, 1000], target: [150, 50, 0] };
await openStudy(disconnectedPanelStudy, 'real invalid fitted-panel diagnostic fixture');
assert.equal(state.cells.length, 1);
assert.equal(state.cells[0].valid, false);
assert.equal(state.result.solids[0].valid, false);
assert.ok(state.result.stats.coverageError < 1e-8, 'a complete source partition can still fail to form one flat panel');
assert.match(state.cells[0].issues.join(' '), /separate/);
clickSeed(0);
assert.equal(state.selected, 0);
for (const view of ['surface', 'flat', 'solid']) {
  document.querySelector(`[data-view="${view}"]`).click();
  assert.match($('selected-note').textContent, /region contains separate pieces.*Divide the region/s, `${view} explains the actual fitted failure and a next edit`);
  assert.match($('selected-note').textContent, /design can still be saved.*Production export waits/s, `${view} explains saving and production status`);
  assert.doesNotMatch($('selected-note').textContent, /Reshape this cell before making a solid panel/, 'the generic inherited failure does not hide useful fitted diagnostics');
  assert.equal($('export-obj').disabled, view !== 'surface');
  assert.equal($('export-dxf').disabled, true);
  assert.equal($('export-stl').disabled, true);
  assert.equal($('save-study').disabled, false);
}
console.log('PASS genuine disconnected panels retain detailed fitted diagnostics and fabrication export gates');

await openStudy(stripStudy, 'four-cell editing fixture');
assert.equal(state.cells.length, 4);
assert.deepEqual(state.cornerEdits, [], 'version 2 study opens without corner edits');
assert.equal(state.layout?.format, 'panel-source-layout', 'version 2 gains a layout during its first solve');
assert.deepEqual(state.layout.recipe.seeds, state.seeds);
assert.equal(state.history.length, 0);
const stripSeeds = structuredClone(state.seeds);
const initialSurface = new Map(state.result.surfaceCells.map(cell => [cell.id, surfaceShape(cell)]));
close([...initialSurface.values()].reduce((sum, cell) => sum + cell.area, 0), 3200 * 800, 'initial source coverage');

clickControl('multi-select');
assert.equal($('multi-select').getAttribute('aria-pressed'), 'true');
assert.equal(state.multiSelect, true);
assert.equal(state.edit, false, 'multi-selection turns centre dragging off');
assert.equal($('edit-toggle').getAttribute('aria-pressed'), 'false');
clickSeed(10); clickSeed(30);
assert.deepEqual([...state.selectedIds].sort((a, b) => a - b), [10, 30]);
assert.equal($('merge-cells').disabled, true, 'disconnected selected cells cannot merge');
clickControl('merge-cells');
assert.equal(state.cells.length, 4);
assert.equal(state.history.length, 0);
clickControl('clear-selection');
assert.deepEqual(state.selectedIds, []);
clickControl('multi-select');
assert.equal(state.multiSelect, false);
assert.equal($('multi-select').getAttribute('aria-pressed'), 'false');
assert.equal(state.edit, false, 'leaving multi-selection does not enable centre dragging');
assert.equal($('edit-toggle').getAttribute('aria-pressed'), 'false');
clickControl('multi-select');
clickControl('edit-toggle');
assert.equal(state.edit, true);
assert.equal($('edit-toggle').getAttribute('aria-pressed'), 'true');
assert.equal(state.multiSelect, false, 'enabling centre dragging turns multi-selection off');
assert.equal($('multi-select').getAttribute('aria-pressed'), 'false');
clickSeed(10); clickSeed(20, { shiftKey: true });
assert.deepEqual([...state.selectedIds].sort((a, b) => a - b), [10, 20]);
assert.equal($('merge-cells').disabled, false);
await edit(() => {
  clickControl('merge-cells');
  assert.equal($('save-study').disabled, true, 'do not save a pending solve');
  const before = downloads.length;
  clickControl('save-study');
  assert.equal(downloads.length, before);
}, 'first adjacent merge');
assert.equal(state.cells.length, 3);
assert.deepEqual(state.seeds, stripSeeds, 'merge must retain all source seeds');
assert.equal(state.mergeGroups.length, 1);
assert.deepEqual([...state.mergeGroups[0].members].sort((a, b) => a - b), [10, 20]);
const mergedId = state.mergeGroups[0].id;
const mergedSurface = state.result.surfaceCells.find(cell => cell.id === mergedId);
assert.deepEqual([...mergedSurface.memberSeedIds].sort((a, b) => a - b), [10, 20]);
close(mergedSurface.area, initialSurface.get(10).area + initialSurface.get(20).area, 'merged source area');
for (const id of [30, 40]) assert.deepEqual(surfaceShape(state.result.surfaceCells.find(cell => cell.id === id)), initialSurface.get(id), `surface neighbour ${id} stays unchanged`);
close(state.result.surfaceCells.reduce((sum, cell) => sum + cell.area, 0), 3200 * 800, 'merged source coverage');
assert.equal($('cell-weight').disabled, true, 'merged cell influence is unavailable');
const visibleSeedIds = [];
globalThis.__uiRenderers[0].scene.traverse(object => { if (object.userData.seedId !== undefined) visibleSeedIds.push(object.userData.seedId); });
assert.ok(visibleSeedIds.includes(mergedId) && !visibleSeedIds.includes(20), 'a merged cell has one authored centre handle, without its retired member handles');
const firstMerge = currentDesign();
console.log('PASS real multi-selection, disconnected rejection, true merge coverage and member editing controls');

// Exported vertices must match the geometry selected by the rendered view.
const { parseOBJ } = await import(new URL('io.js', demo));
for (const view of ['surface', 'flat']) {
  document.querySelector(`[data-view="${view}"]`).click();
  assert.equal($('export-obj').disabled, false, `${view} fixture must be exportable`);
  const expectedCells = view === 'surface' ? state.result.surfaceCells : state.cells;
  const expected = expectedCells.flatMap(cell => view === 'surface' ? cell.positions : cell.flatPositions);
  clickControl('export-obj');
  const text = await downloads.at(-1).blob.text(), mesh = parseOBJ(text);
  assert.equal(text.split('\n').filter(line => line.startsWith('o ')).length, 3);
  assert.equal(mesh.vertices.length, expected.length);
  assert.equal(mesh.triangles.length, expectedCells.reduce((sum, cell) => sum + cell.triangles.length, 0));
  mesh.vertices.forEach((point, index) => point.forEach((value, axis) => close(value, expected[index][axis], `${view} exported coordinate`, 1e-6)));
}
document.querySelector('[data-view="surface"]').click();
console.log('PASS merged surface and flat OBJ exports match preview geometry');

await edit(() => clickControl('undo-move'), 'undo first merge');
assert.equal(state.cells.length, 4);
assert.deepEqual(state.mergeGroups, []);
assert.deepEqual([...state.selectedIds].sort((a, b) => a - b), [10, 20], 'undo restores pre-merge selection');
assert.equal($('redo-edit').disabled, false);
await edit(() => key('z', { shiftKey: true }), 'keyboard redo first merge');
assert.deepEqual(currentDesign(), firstMerge);
assert.deepEqual(state.selectedIds, [mergedId]);
clickSeed(30, { shiftKey: true });
assert.equal($('merge-cells').disabled, false);
await edit(() => clickControl('merge-cells'), 'merge existing group with next cell');
assert.equal(state.cells.length, 2);
assert.equal(state.mergeGroups.length, 1);
assert.deepEqual([...state.mergeGroups[0].members].sort((a, b) => a - b), [10, 20, 30]);
assert.deepEqual(state.seeds, stripSeeds);
const secondMerge = currentDesign();
await edit(() => key('z'), 'keyboard undo repeated merge');
assert.deepEqual(currentDesign(), firstMerge);
await edit(() => key('y'), 'Ctrl+Y redo repeated merge');
assert.deepEqual(currentDesign(), secondMerge);
console.log('PASS repeated merge and undo/redo restore complete design and selection');

const historyBeforeSlider = state.history.length, layoutBeforeStock = structuredClone(state.layout);
const surfaceBeforeStock = state.result.surfaceCells.map(cell => surfaceShape(cell));
pointer($('thickness'), 'pointerdown', 0, 0);
input('thickness', 60);
input('thickness', 75);
await edit(() => input('thickness', 75, 'change'), 'thickness gesture');
assert.equal(state.thickness, 75);
assert.equal(state.history.length, historyBeforeSlider + 1, 'one slider gesture creates one history step');
assert.deepEqual(state.layout, layoutBeforeStock, 'stock thickness must not regenerate the source layout');
assert.deepEqual(state.result.surfaceCells.map(cell => surfaceShape(cell)), surfaceBeforeStock);
await edit(() => clickControl('undo-move'), 'undo geometry setting');
assert.equal(state.thickness, 40);
assert.deepEqual(currentDesign(), secondMerge);
await edit(() => clickControl('redo-edit'), 'redo geometry setting');
assert.equal(state.thickness, 75);
const beforeReplacement = currentDesign(), beforeDraftRevision = state.revision;
input('size', 1000); input('variation', 25);
await new Promise(resolve => setTimeout(resolve, 220));
assert.equal(state.revision, beforeDraftRevision);
assert.deepEqual(currentDesign(), beforeReplacement, 'draft generation settings preserve manual work');
await edit(() => {
  clickControl('regenerate');
  assert.deepEqual(state.layout, beforeReplacement.layout, 'generation preflight retains the accepted layout until the candidate succeeds');
}, 'explicit replacement generation');
assert.deepEqual(state.mergeGroups, []);
assert.equal(state.size, 1000);
assert.equal(state.variation, .25);
assert.notDeepEqual(state.seeds, stripSeeds);
assert.ok(state.layout, 'generation captures its replacement source layout');
assert.notDeepEqual(state.layout, beforeReplacement.layout);
await edit(() => clickControl('undo-move'), 'undo generated replacement');
assert.deepEqual(currentDesign(), beforeReplacement);
assert.equal(state.cells.length, 2);
assert.equal($('redo-edit').disabled, false);
input('roundover', 1);
await edit(() => input('roundover', 1, 'change'), 'new edit after undo');
assert.equal($('redo-edit').disabled, true, 'new edit clears the redo branch');
assert.equal(state.future.length, 0);
assert.deepEqual(state.layout, beforeReplacement.layout, 'roundover preserves the restored source layout');
console.log('PASS geometry-setting history, explicit generation, replacement undo and redo invalidation');

const designBeforeFit = currentDesign(), surfaceBeforeFit = state.result.surfaceCells.map(cell => surfaceShape(cell));
await edit(() => { input('straightness', 35); input('straightness', 35, 'change'); }, 'refit the authoritative layout');
close(state.straightness, .35, 'fitting strength');
assert.deepEqual(state.layout, designBeforeFit.layout, 'boundary fitting reads the authored layout without replacing it');
assert.deepEqual(state.result.surfaceCells.map(cell => surfaceShape(cell)), surfaceBeforeFit);
await edit(() => clickControl('undo-move'), 'undo fitting setting while retaining layout');
assert.deepEqual(currentDesign(), designBeforeFit);
console.log('PASS fitting, stock and carving settings retain the exact authored source layout');

const completeDesign = currentDesign(), completeStudy = await saveStudy();
assert.equal(completeStudy.version, 6);
assert.deepEqual(completeStudy.mergeGroups, state.mergeGroups);
await openStudy(completeStudy, 'merged version 5 reopen');
assert.deepEqual(currentDesign(), completeDesign);
assert.equal(state.cells.length, 2);
assert.equal(state.history.length, 0);
assert.equal(state.future.length, 0);
document.querySelector('[data-view="surface"]').click();
clickSeed(10);
assert.notEqual(state.selected, null);
assert.equal($('export-selected-dxf').disabled, false);
assert.equal($('export-selected-obj').disabled, false);
clickControl('clear-selection');
assert.equal(state.selected, null);
assert.deepEqual(state.selectedIds, []);
assert.equal($('export-selected-dxf').disabled, true, 'clearing selection disables selected outline export');
assert.equal($('export-selected-obj').disabled, true, 'clearing selection disables selected panel export');

// Structurally valid membership still needs a geometric adjacency check before
// replacing the open document. IDs 10 and 30 have cell 20 between them.
const preservedDocument = () => structuredClone({ design: currentDesign(), model: state.model,
  rawModel: state.rawModel, name: state.name, cells: state.cells, result: state.result,
  history: state.history, future: state.future, selected: state.selected, selectedIds: state.selectedIds,
  selectedCorner: state.selectedCorner, revision: state.revision, solved: state.solved });
const withoutSelection = saved => ({ ...saved, selected: null, selectedIds: [], selectedCorner: null });
const beforeRejectedImport = preservedDocument();
const disconnectedStudy = { ...stripStudy, name: 'invalid-disconnected-merge', mergeGroups: [{ id: 10, members: [10, 30] }] };
const disconnectedText = JSON.stringify(disconnectedStudy);
loadFile('study-file', { name: 'disconnected-study.json', size: disconnectedText.length, text: async () => disconnectedText });
await until(() => $('status').textContent.startsWith('Could not open study:'), 'reject disconnected saved merge');
assert.deepEqual(preservedDocument(), beforeRejectedImport, 'failed merge import must preserve the complete solved document');
assert.equal(state.solved, true);
assert.equal($('save-study').disabled, false);
console.log('PASS cleared selection disables exports and rejected merge import preserves the open document');

async function rejectStudyWithoutMutation(study, label) {
  const before = preservedDocument(), text = JSON.stringify(study);
  loadFile('study-file', { name: `${label}.json`, size: text.length, text: async () => text });
  // Let the file-read continuation run, so a previous rejection message cannot
  // make this check finish before the newly imported document is validated.
  await new Promise(resolve => setTimeout(resolve, 0));
  await until(() => $('status').textContent.startsWith('Could not open study:'), label);
  assert.deepEqual(preservedDocument(), before, `${label} leaves the complete solved document untouched`);
  assert.equal($('save-study').disabled, false);
}
const missingLayoutStudy = structuredClone(completeStudy);
delete missingLayoutStudy.layout;
await rejectStudyWithoutMutation(missingLayoutStudy, 'reject version 5 without layout');
const mismatchedRecipeStudy = structuredClone(completeStudy);
mismatchedRecipeStudy.seeds[0].position[0] += 10;
await rejectStudyWithoutMutation(mismatchedRecipeStudy, 'reject source recipe mismatch');
const offSurfaceLayoutStudy = structuredClone(completeStudy);
offSurfaceLayoutStudy.layout.vertices[0].position[2] += 50;
await rejectStudyWithoutMutation(offSurfaceLayoutStudy, 'reject off-surface layout vertex');
const wrongOwnershipStudy = structuredClone(completeStudy);
const sharedLayoutEdge = wrongOwnershipStudy.layout.edges.find(edge => edge.cells.length === 2);
assert.ok(sharedLayoutEdge, 'fixture needs a shared authored edge');
sharedLayoutEdge.cells = sharedLayoutEdge.cells.slice(0, 1);
await rejectStudyWithoutMutation(wrongOwnershipStudy, 'reject inconsistent layout edge ownership');
const wrongSourcePatchStudy = structuredClone(completeStudy);
const sourcePatch = wrongSourcePatchStudy.layout.cells[0].triangles[0];
sourcePatch.sourceTriangle = (sourcePatch.sourceTriangle + Math.floor(wrongSourcePatchStudy.layout.source.triangleCount / 2)) % wrongSourcePatchStudy.layout.source.triangleCount;
await rejectStudyWithoutMutation(wrongSourcePatchStudy, 'reject a cell patch attached to the wrong source triangle');
console.log('PASS missing, inconsistent and geometrically corrupt layout imports are atomic');

const legacyStudy = { ...stripStudy, version: 1 };
delete legacyStudy.mergeGroups;
await openStudy(legacyStudy, 'legacy version 1 migration');
assert.equal(state.cells.length, 4);
assert.deepEqual(state.mergeGroups, []);
assert.deepEqual(state.seeds, stripSeeds);
assert.deepEqual(state.cornerEdits, [], 'version 1 study opens without corner edits');
assert.equal(state.layout?.format, 'panel-source-layout', 'version 1 gains its source layout on first solve');
assert.equal((await saveStudy()).version, 6);
assert.equal(errors.length, 0, errors.map(error => error.message).join('\n'));
console.log('PASS merged version 5 save/reopen and version 1/2 migration');

// Three cells on a planar grid give a shared interior junction and boundary
// seam endpoints. A direct corner drag must change the source partition itself.
const cornerVertices = [], cornerTriangles = [];
for (let y = 0; y <= 6; y++) for (let x = 0; x <= 6; x++) cornerVertices.push([x * 200, y * 200, 0]);
for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
  const a = y * 7 + x, b = a + 1, c = a + 7, d = c + 1;
  cornerTriangles.push([a, b, d], [a, d, c]);
}
const cornerStudy = { ...stripStudy, version: 3, name: 'corner-edit-grid',
  rawModel: { vertices: cornerVertices, triangles: cornerTriangles }, size: 600,
  seeds: [[250, 300, 0], [950, 300, 0], [600, 950, 0]].map((position, id) => ({ id, position, weight: 1 })),
  cornerEdits: [], camera: [600, 600, 3000], target: [600, 600, 0] };
const { Vector3 } = await import(actualThree);
function projectWorld(position) {
  flush();
  const projected = new Vector3(...position).project(window.cellStudy.camera);
  return { x: (projected.x + 1) * 512, y: (1 - projected.y) * 360 };
}
const stableCornerIds = new WeakMap();
function stableCornerId(corner) {
  if (stableCornerIds.has(corner)) return stableCornerIds.get(corner);
  const vertexId = corner.vertexId ?? state.layout.vertices.find(vertex =>
    new Vector3(...vertex.position).distanceTo(new Vector3(...corner.position)) < 1e-4)?.id;
  assert.ok(vertexId, 'each handle must refer to a source graph vertex');
  const id = `vertex:${vertexId}`;
  stableCornerIds.set(corner, id);
  return id;
}
function findCurrentCorner(corner) {
  const id = stableCornerId(corner);
  return state.result.corners.find(value => value.id === id || value.id === corner.id);
}
function beginCornerDrag(corner, target) {
  flush();
  stableCornerId(corner);
  const from = window.cellStudy.projectCorner(corner.id), to = projectWorld(target);
  assert.ok(from && from.x > 0 && from.x < 1024 && from.y > 0 && from.y < 720, 'corner handle must be visible');
  pointer(canvas, 'pointerdown', from.x, from.y);
  assert.equal(window.cellStudy.controls.enabled, false, 'corner dragging captures input from orbit controls');
  pointer(canvas, 'pointermove', to.x, to.y);
  return to;
}
function cornerSourceSnapshot() {
  return structuredClone(state.result.surfaceCells.map(cell => ({ id: cell.id, ...surfaceShape(cell) })));
}
await openStudy(cornerStudy, 'three-cell corner fixture');
assert.equal(state.cells.length, 3);
assert.deepEqual(state.cornerEdits, []);
assert.equal(state.layout?.format, 'panel-source-layout', 'version 3 gains its source layout on first solve');
const legacyCapturedStudy = { ...await saveStudy(), version: 4 };
delete legacyCapturedStudy.directBase;
delete legacyCapturedStudy.allowCellRemoval;
await openStudy(legacyCapturedStudy, 'existing version 4 snapshot before direct graph editing');
assert.deepEqual(state.layout, legacyCapturedStudy.layout, 'opening v4 retains its exact captured partition');
assert.equal(state.directBase, null);
assert.equal(state.allowCellRemoval, true, 'older studies use the default cell removal preference');
const beforePreference = currentDesign(), preferenceHistory = state.history.length;
$('allow-cell-removal').checked = false;
$('allow-cell-removal').dispatchEvent(new Event('change', { bubbles: true }));
assert.equal(state.allowCellRemoval, false);
assert.deepEqual(currentDesign(), beforePreference, 'cell removal permission does not change source geometry');
assert.equal(state.history.length, preferenceHistory, 'cell removal permission is outside geometry history');
$('allow-cell-removal').checked = true;
$('allow-cell-removal').dispatchEvent(new Event('change', { bubbles: true }));
assert.equal(state.allowCellRemoval, true);
const interiorCorner = state.result.corners.find(corner => !corner.boundary && corner.cells.length >= 3);
assert.ok(interiorCorner, 'fixture needs an interior shared junction');
assert.ok(state.result.corners.some(corner => corner.boundary && corner.cells.length >= 2), 'fixture needs a boundary seam endpoint');
assert.ok(state.result.corners.every(corner => corner.cells.length >= (corner.boundary ? 2 : 3)), 'single-cell outline points have no corner handles');
document.querySelector('[data-view="solid"]').click();
input('explode', 30);
clickControl('corner-toggle');
assert.equal($('corner-toggle').getAttribute('aria-pressed'), 'true');
assert.match($('active-tool-name').textContent, /corner/i, 'viewport context names the active corner tool');
assert.equal(state.view, 'solid', 'enabling corner edits keeps the selected model view');
assert.equal(state.explode, 0);
assert.equal(state.edit, false);
assert.equal(state.multiSelect, false);
assert.equal($('edit-toggle').getAttribute('aria-pressed'), 'false');
assert.equal($('multi-select').getAttribute('aria-pressed'), 'false');
document.querySelector('[data-view="surface"]').click();
const beforeCorner = currentDesign(), beforeCornerSurface = cornerSourceSnapshot();
const beforeCornerFit = structuredClone(state.cells.map(cell => cell.flatPositions));
const beforeCornerSolids = structuredClone(state.result.solids.map(solid => solid.positions));
const beforeCornerHistory = state.history.length;
const cornerTarget = interiorCorner.position.map((value, axis) => value + [24, 16, 0][axis]);
await edit(() => {
  const to = beginCornerDrag(interiorCorner, cornerTarget);
  assert.deepEqual(currentDesign(), beforeCorner, 'drag preview leaves the accepted design unchanged until release');
  assert.deepEqual(cornerSourceSnapshot(), beforeCornerSurface);
  pointer(canvas, 'pointerup', to.x, to.y);
  assert.equal($('save-study').disabled, true, 'corner validation blocks saving until the candidate is accepted');
  assert.equal($('export-obj').disabled, true);
}, 'interior shared corner drag');
assert.deepEqual(state.directBase, beforeCorner.layout);
assert.deepEqual(state.cornerEdits, [], 'direct graph edits do not add legacy field constraints');
assert.equal(state.layout.version, 2);
assert.equal(state.layout.authority, 'graph');
assert.ok(state.directBase, 'direct edits retain a reset baseline');
assert.equal(state.history.length, beforeCornerHistory + 1);
assert.deepEqual(state.seeds, beforeCorner.seeds);
assert.notDeepEqual(cornerSourceSnapshot(), beforeCornerSurface, 'corner drag changes source cell regions');
assert.notDeepEqual(state.cells.map(cell => cell.flatPositions), beforeCornerFit, 'corner drag refits the panels');
assert.notDeepEqual(state.result.solids.map(solid => solid.positions), beforeCornerSolids, 'corner drag rebuilds the solids');
close(state.result.surfaceCells.reduce((sum, cell) => sum + cell.area, 0), 1200 * 1200, 'corner-edit source coverage');
const movedCorner = findCurrentCorner(interiorCorner);
assert.ok(movedCorner, 'accepted edit retains the corner identity');
movedCorner.position.forEach((value, axis) => close(value, cornerTarget[axis], 'accepted source corner target', 1e-3));
assert.equal($('edit-toggle').disabled, false, 'centre movement remains available after corner edits');
clickSeed(0);
assert.equal($('cell-weight').disabled, true, 'corner edits prevent cell reweighting');
const oneCornerDesign = currentDesign(), oneCornerSurface = cornerSourceSnapshot();
clickControl('export-obj');
const cornerExport = parseOBJ(await downloads.at(-1).blob.text());
const cornerExportPositions = state.result.surfaceCells.flatMap(cell => cell.positions);
assert.equal(cornerExport.vertices.length, cornerExportPositions.length);
cornerExport.vertices.forEach((point, index) => point.forEach((value, axis) => close(value, cornerExportPositions[index][axis], 'corner-edited OBJ coordinate', 1e-6)));
console.log('PASS corner mode, real interior drag, source repartition, fit updates and editing guards');

// Hold derived results while accepting more source edits, exactly as a slower
// fitting worker would. Validation must remain independent of that worker.
const sequenceStart=currentDesign(), sequenceHistory=state.history.length;
const sketchObjects=()=>globalThis.__uiRenderers[0].scene.children.flatMap(group=>group.children||[]).filter(object=>object.userData.cornerSketch);
const firstSequenceCorner=findCurrentCorner(interiorCorner);
holdNextFitReply=true;
let seqTo=beginCornerDrag(firstSequenceCorner,firstSequenceCorner.position.map((x,k)=>x+[5,3,0][k]));
assert.ok(sketchObjects().some(object=>object.isMesh),'the live sketch includes translucent neighbouring cells');
const firstSketch=sketchObjects().filter(object=>object.isLineSegments).map(object=>Array.from(object.geometry.attributes.position.array));
assert.ok(firstSketch.some(points=>points.length>6),'the live sketch includes incident seams, not just a movement guide');
assert.deepEqual(currentDesign(),sequenceStart,'live preview does not author the layout');
pointer(canvas,'pointerup',seqTo.x,seqTo.y);
await until(()=>heldFitReplies.length===1&&!!state.sourceSurface,'accept source while first fit is held');
assert.equal(state.solved,false);assert.equal(state.busy,true);
assert.equal($('save-study').disabled, false, 'accepted authored source can be saved during a held fit');
const pendingFitSave = await saveStudy();
assert.deepEqual(pendingFitSave.layout, state.layout, 'pending-fit save contains current accepted graph');
assert.equal(pendingFitSave.project.revision, state.project.revision);
assert.ok(pendingFitSave.lastCalculation.revision < pendingFitSave.project.revision, 'older fit evidence remains explicitly older');
assert.equal($('corner-toggle').disabled,false,'manual arrangement remains enabled during fitting');
assert.equal($('export-dxf').disabled,true,'old fitted output cannot be exported');
const sourceOne=currentDesign();
const nextCorner=state.sourceSurface.corners.find(c=>c.vertexId===state.lastLayoutChange.movedVertexId);
seqTo=beginCornerDrag(nextCorner,nextCorner.position.map((x,k)=>x+[5,3,0][k]));
pointer(canvas,'pointerup',seqTo.x,seqTo.y);
await until(()=>state.history.length===sequenceHistory+2&&!!state.pending,'accept a second move before the first fit returns');
const sourceTwo=currentDesign();assert.notDeepEqual(sourceTwo,sourceOne);
holdNextFitReply=true;
heldFitReplies[0].deliver();
await until(()=>heldFitReplies.length===2,'dispatch only the latest queued fit');
assert.deepEqual(currentDesign(),sourceTwo,'an obsolete fit cannot overwrite the newer source');
assert.ok(state.sourceSurface,'the accepted Cells layout survives an obsolete fit');
assert.equal(state.solved,false);
const thirdCorner=state.sourceSurface.corners.find(c=>c.vertexId===state.lastLayoutChange.movedVertexId);
seqTo=beginCornerDrag(thirdCorner,thirdCorner.position.map((x,k)=>x+[5,3,0][k]));
const previewDuringFit=sketchObjects();
heldFitReplies[1].deliver();
await until(()=>state.solved,'finish the current fit during another gesture');
assert.equal(window.cellStudy.controls.enabled,false,'a fitting result does not end the active gesture');
assert.deepEqual(sketchObjects(),previewDuringFit,'a fitting result does not destroy preview objects or the grabbed handle');
document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
assert.equal(sketchObjects().length,0,'Escape clears preview geometry');
assertNeutralTools('Escape during a corner sketch');
assert.deepEqual(currentDesign(),sourceTwo,'Escape retains the last accepted arrangement');
assert.equal($('export-dxf').disabled,false,'completed current fitting restores valid export');
assert.notEqual($('stock-check').textContent,'Updating…','cancelling a gesture refreshes the completed fit diagnostics');
await edit(()=>key('z'),'undo second consecutive manual move');
assert.deepEqual(currentDesign(),sourceOne);
await edit(()=>key('z'),'undo first consecutive manual move');
assert.deepEqual(currentDesign(),sequenceStart);
console.log('PASS live shell sketch, consecutive edits during fitting, obsolete replies and in-gesture fitting completion');
clickControl('corner-toggle');
const altCorner=findCurrentCorner(interiorCorner),altNeighbour=state.result.corners.find(c=>c.boundary);
const nearNeighbour=altNeighbour.position.map((x,k)=>x+(altCorner.position[k]-x)*.005),altScreen=projectWorld(nearNeighbour);
const altTo=beginCornerDrag(altCorner,nearNeighbour);
assert.match($('corner-status').textContent,/Join corners/,'the proximity target normally snaps to the connected junction');
pointer(canvas,'pointermove',altScreen.x,altScreen.y,{altKey:true});
assert.doesNotMatch($('corner-status').textContent,/Join corners/,'Alt keeps a near-junction target free of proximity snapping');
document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
assertNeutralTools('Escape during an Alt corner gesture');
assert.deepEqual(currentDesign(),sequenceStart,'cancelled Alt gesture leaves the accepted layout unchanged');



await edit(() => key('z'), 'undo corner drag');
assert.deepEqual(currentDesign(), beforeCorner);
assert.deepEqual(cornerSourceSnapshot(), beforeCornerSurface);
assert.equal($('edit-toggle').disabled, false);
await edit(() => key('z', { shiftKey: true }), 'redo corner drag');
assert.deepEqual(currentDesign(), oneCornerDesign);
assert.deepEqual(cornerSourceSnapshot(), oneCornerSurface);
clickControl('corner-toggle');
const cancelHistory = state.history.length;
const cancelCorner = findCurrentCorner(interiorCorner);
const cancelledTarget = cancelCorner.position.map((value, axis) => value + [18, -12, 0][axis]);
const cancelledScreen = beginCornerDrag(cancelCorner, cancelledTarget);
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
pointer(canvas, 'pointerup', cancelledScreen.x, cancelledScreen.y);
assertNeutralTools('Escape followed by a late corner pointerup');
await until(() => state.solved && !state.busy && !state.pending, 'cancel corner drag');
assert.deepEqual(currentDesign(), oneCornerDesign);
assert.deepEqual(cornerSourceSnapshot(), oneCornerSurface);
assert.equal(state.history.length, cancelHistory, 'cancelled drag creates no history entry');
assert.equal(window.cellStudy.controls.enabled, true);
assert.match($('corner-status').textContent, /cancelled/i, 'corner inspector confirms drag cancellation');
clickControl('corner-toggle');
const pendingCancelScreen = beginCornerDrag(findCurrentCorner(interiorCorner), cancelledTarget);
const beforePendingCancel = preservedDocument(), beforeCancelReplies = validationReplies.length;
pointer(canvas, 'pointerup', pendingCancelScreen.x, pendingCancelScreen.y);
assert.equal($('save-study').disabled, true, 'released corner is awaiting validation');
assert.equal(validationReplies.length, beforeCancelReplies, 'validation has not replied before Escape');
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
assertNeutralTools('Escape during pending corner validation');
await until(() => validationReplies.length > beforeCancelReplies, 'reply after cancelling pending corner validation');
assert.equal(validationReplies.at(-1).error, undefined, 'the cancelled candidate was otherwise geometrically valid');
assert.deepEqual(preservedDocument(), withoutSelection(beforePendingCancel), 'late successful validation cannot commit a cancelled corner move or restore its selection');
assert.equal(state.history.length, cancelHistory);
assert.equal($('save-study').disabled, false);
assert.equal($('export-obj').disabled, false);
assert.match($('corner-status').textContent, /cancelled/i, 'late validation cannot leave a stale checking message');
console.log('PASS corner undo/redo and drag/pending Escape cancellation preserve accepted geometry');

clickControl('corner-toggle');
const boundaryCorner = state.result.corners.find(corner => corner.boundary
  && ((corner.position[1] < 1e-6 || corner.position[1] > 1200 - 1e-6) && corner.position[0] > 80 && corner.position[0] < 1120));
assert.ok(boundaryCorner, 'fixture needs a boundary endpoint away from outer corners');
const boundaryTarget = [boundaryCorner.position[0] + 20, boundaryCorner.position[1] < 1 ? 20 : 1180, 0];
await edit(() => {
  const to = beginCornerDrag(boundaryCorner, boundaryTarget);
  pointer(canvas, 'pointerup', to.x, to.y);
}, 'boundary corner drag');
assert.deepEqual(state.cornerEdits, [], 'successive graph edits preserve legacy provenance');
assert.deepEqual(state.directBase, beforeCorner.layout, 'successive edits retain the first reset baseline');
const movedBoundary = findCurrentCorner(boundaryCorner);
assert.ok(movedBoundary?.boundary);
close(movedBoundary.position[1], boundaryCorner.position[1], 'boundary drag remains on original edge', 1e-3);
assert.ok(Math.abs(movedBoundary.position[0] - boundaryCorner.position[0]) > 1, 'boundary handle moves along its loop');
close(state.result.surfaceCells.reduce((sum, cell) => sum + cell.area, 0), 1200 * 1200, 'boundary-edit source coverage');
const editedCornerDesign = currentDesign(), editedCornerSurface = cornerSourceSnapshot();
const cornersSaved = await saveStudy();
assert.equal(cornersSaved.version, 6);
assert.deepEqual(cornersSaved.cornerEdits, state.cornerEdits);
const beforeOffSurfaceImport = preservedDocument();
const offSurfaceStudy = structuredClone(cornersSaved);
offSurfaceStudy.name = 'invalid-off-surface-corner';
offSurfaceStudy.layout.vertices[0].position[2] += 50;
const offSurfaceText = JSON.stringify(offSurfaceStudy);
loadFile('study-file', { name: 'off-surface-study.json', size: offSurfaceText.length, text: async () => offSurfaceText });
await until(() => $('status').textContent.startsWith('Could not open study:'), 'reject off-surface authored graph vertex');
assert.deepEqual(preservedDocument(), beforeOffSurfaceImport, 'invalid corner import preserves the solved document and history');
assert.equal($('save-study').disabled, false);
await openStudy(cornersSaved, 'corner-edit version 5 reopen');
assert.deepEqual(currentDesign(), editedCornerDesign);
assert.deepEqual(cornerSourceSnapshot(), editedCornerSurface);
console.log('PASS boundary corner attachment, rejected graph corruption and version 5 corner-edit round trip');

const corruptBaselineStudy = structuredClone(cornersSaved);
corruptBaselineStudy.directBase.vertices[0].position[2] += 50;
await rejectStudyWithoutMutation(corruptBaselineStudy, 'reject a corrupt direct-edit reset baseline');
const reopenedCorner = findCurrentCorner(interiorCorner);
await edit(() => {
  const to = beginCornerDrag(reopenedCorner, reopenedCorner.position.map((value, axis) => value + [5, 6, 0][axis]));
  pointer(canvas, 'pointerup', to.x, to.y);
}, 'continue editing the reopened graph');
assert.deepEqual(state.directBase, beforeCorner.layout);
assert.notDeepEqual(state.layout, editedCornerDesign.layout);
await edit(() => key('z'), 'undo continued graph edit after reopen');
assert.deepEqual(currentDesign(), editedCornerDesign);
assert.deepEqual(cornerSourceSnapshot(), editedCornerSurface);

const graphMergeBefore = currentDesign();
clickSeed(0); clickSeed(1, { shiftKey: true });
assert.equal($('merge-cells').disabled, false);
await edit(() => clickControl('merge-cells'), 'merge cells in a directly authored graph');
assert.equal(state.cells.length, 2);
assert.equal(state.layout.authority, 'graph');
assert.deepEqual(state.seeds, graphMergeBefore.seeds);
assert.deepEqual(state.mergeGroups, graphMergeBefore.mergeGroups, 'graph merging preserves generator provenance');
assert.deepEqual(state.directBase, graphMergeBefore.directBase);
assert.ok(state.layout.vertices.some(vertex => new Vector3(...vertex.position).distanceTo(new Vector3(...movedCorner.position)) < 1e-4),
  'graph merge preserves the manually placed shared boundary vertex');
close(state.result.surfaceCells.reduce((sum, cell) => sum + cell.area, 0), 1200 * 1200, 'direct graph merge coverage');
await edit(() => key('z'), 'undo merge on a directly authored graph');
assert.deepEqual(currentDesign(), graphMergeBefore);
assert.deepEqual(cornerSourceSnapshot(), editedCornerSurface);
console.log('PASS existing v4 snapshots support graph edits, reopen, further edits and non-regenerating merges');

assert.equal($('reset-corners').disabled, false);
await edit(() => clickControl('reset-corners'), 'reset corner edits');
assert.deepEqual(state.cornerEdits, []);
assert.equal(state.directBase, null);
assert.deepEqual(state.layout, beforeCorner.layout);
assert.deepEqual(state.seeds, editedCornerDesign.seeds);
assert.deepEqual(state.mergeGroups, editedCornerDesign.mergeGroups);
assert.deepEqual(cornerSourceSnapshot(), beforeCornerSurface);
await edit(() => clickControl('undo-move'), 'undo reset corner edits');
assert.deepEqual(currentDesign(), editedCornerDesign);
assert.deepEqual(cornerSourceSnapshot(), editedCornerSurface);
const beforeCornerReplacement = currentDesign();
await edit(() => clickControl('regenerate'), 'replace corner-edited layout');
assert.deepEqual(state.cornerEdits, []);
await edit(() => clickControl('undo-move'), 'undo corner layout replacement');
assert.deepEqual(currentDesign(), beforeCornerReplacement);
assert.deepEqual(cornerSourceSnapshot(), editedCornerSurface);
assert.equal(errors.length, 0, errors.map(error => error.message).join('\n'));
console.log('PASS corner reset and generated replacement are undoable');

const staleCorner = findCurrentCorner(interiorCorner), heldBefore = heldValidationReplies.length;
holdNextValidationReply = true;
const staleTo = beginCornerDrag(staleCorner, staleCorner.position.map((value, axis) => value + [5, -4, 0][axis]));
pointer(canvas, 'pointerup', staleTo.x, staleTo.y);
await until(() => heldValidationReplies.length > heldBefore, 'hold a successful graph transaction reply');
const staleReply = heldValidationReplies.at(-1);
assert.equal(staleReply.data.error, undefined, 'stale candidate is valid in its original document');
await openStudy({ ...cornerStudy, name: 'replacement-during-graph-validation' }, 'open another document while graph validation is pending');
const replacementDocument = preservedDocument(), repliesBeforeStale = validationReplies.length;
staleReply.deliver();
await until(() => validationReplies.length > repliesBeforeStale, 'deliver graph validation from the previous document');
assert.deepEqual(preservedDocument(), replacementDocument, 'a stale graph reply cannot replace the current document');
assert.equal(state.name, 'replacement-during-graph-validation');
assert.equal($('save-study').disabled, false);
console.log('PASS late graph validation cannot mutate a replacement document');

const contractionStudy = { ...cornerStudy, name: 'shared-seam-contraction', size: 500,
  seeds: [[250, 300, 0], [950, 250, 0], [350, 950, 0], [1000, 1000, 0]]
    .map((position, id) => ({ id, position, weight: 1 })) };
await openStudy(contractionStudy, 'four-cell seam contraction fixture');
if (!state.cornerMode) clickControl('corner-toggle');
const contractionCorners = state.result.corners.filter(corner => !corner.boundary).sort((a, b) => b.position[0] - a.position[0]);
assert.equal(contractionCorners.length, 2, 'fixture has two adjacent triple junctions');
const [contractFrom, contractTo] = contractionCorners;
const beforeContraction = currentDesign(), surfaceBeforeContraction = cornerSourceSnapshot();
const crossingHistory = state.history.length;
const crossingScreen = beginCornerDrag(contractFrom, [400, 800, 0]);
pointer(canvas, 'pointerup', crossingScreen.x, crossingScreen.y);
await until(() => $('status').textContent.startsWith('Move not applied:'), 'reject crossing seams inside the source surface');
assert.match($('status').textContent, /cross|overlap/i);
assert.deepEqual(currentDesign(), beforeContraction);
assert.deepEqual(cornerSourceSnapshot(), surfaceBeforeContraction);
assert.equal(state.history.length, crossingHistory, 'crossing rejection creates no history entry');
assert.equal(state.solved, true);
assert.equal($('save-study').disabled, false);
$('allow-cell-removal').checked = false;
$('allow-cell-removal').dispatchEvent(new Event('change', { bubbles: true }));
await edit(() => {
  const to = beginCornerDrag(contractFrom, contractTo.position);
  pointer(canvas, 'pointerup', to.x, to.y);
}, 'contract a shared seam without removing a cell');
assert.equal(state.cells.length, 4);
assert.equal(state.result.corners.filter(corner => !corner.boundary).length, 1);
assert.equal(state.layout.authority, 'graph');
assert.deepEqual(state.directBase, beforeContraction.layout);
assert.deepEqual(state.seeds, beforeContraction.seeds);
assert.deepEqual(state.lastLayoutChange.removedCellIds, []);
assert.ok(state.lastLayoutChange.collapsedEdgeIds.length > 0);
assert.equal(state.selectedCorner, state.lastLayoutChange.survivingCornerId);
const contractedCorner = state.result.corners.find(corner => corner.id === state.selectedCorner);
assert.ok(contractedCorner && contractedCorner.cells.length === 4, 'contracted seam becomes a four-cell junction');
contractedCorner.position.forEach((value, axis) => close(value, contractTo.position[axis], 'contracted corner target', 1e-3));
close(state.result.surfaceCells.reduce((sum, cell) => sum + cell.area, 0), 1200 * 1200, 'contracted source coverage');
assert.equal(state.result.solids.length, 4, 'panels refit after valid seam contraction');
const contractedDesign = currentDesign(), contractedSurface = cornerSourceSnapshot();
$('allow-cell-removal').focus();
assert.equal(document.activeElement, $('allow-cell-removal'));
await edit(() => key('z'), 'undo shared seam contraction with the checkbox focused');
assert.deepEqual(currentDesign(), beforeContraction);
assert.deepEqual(cornerSourceSnapshot(), surfaceBeforeContraction);
assert.equal(state.allowCellRemoval, false, 'undo does not change the cell removal preference');
await edit(() => key('y'), 'redo shared seam contraction');
assert.deepEqual(currentDesign(), contractedDesign);
assert.deepEqual(cornerSourceSnapshot(), contractedSurface);
const contractedSaved = await saveStudy();
assert.equal(contractedSaved.allowCellRemoval, false);
await openStudy(contractedSaved, 'reopen a graph with a contracted seam');
assert.deepEqual(currentDesign(), contractedDesign);
assert.deepEqual(cornerSourceSnapshot(), contractedSurface);
assert.equal(state.allowCellRemoval, false);
assert.equal($('allow-cell-removal').checked, false);
await edit(() => clickControl('reset-corners'), 'reset a contracted graph to its baseline');
assert.deepEqual(currentDesign(), beforeContraction);
assert.deepEqual(cornerSourceSnapshot(), surfaceBeforeContraction);
await edit(() => key('z'), 'undo reset of a contracted graph');
assert.deepEqual(currentDesign(), contractedDesign);
console.log('PASS crossing rejection and seam contraction preserve source coverage and saved/undo/reset geometry');

const removalStudy = { ...cornerStudy, name: 'collapsed-boundary-cell', size: 500,
  seeds: [[100, 100, 0], [850, 850, 0]].map((position, id) => ({ id, position, weight: 1 })) };
await openStudy(removalStudy, 'two-cell boundary collapse fixture');
if (!state.cornerMode) clickControl('corner-toggle');
clickSeed(0);
const removalCorners = state.result.corners.filter(corner => corner.boundary).sort((a, b) => b.position[0] - a.position[0]);
assert.equal(removalCorners.length, 2);
const [removeFrom, removeTo] = removalCorners;
const beforeRemoval = currentDesign(), surfaceBeforeRemoval = cornerSourceSnapshot(), removalHistory = state.history.length;
$('allow-cell-removal').checked = false;
$('allow-cell-removal').dispatchEvent(new Event('change', { bubbles: true }));
const refusedTo = beginCornerDrag(removeFrom, removeTo.position);
pointer(canvas, 'pointerup', refusedTo.x, refusedTo.y);
await until(() => $('status').textContent.startsWith('Move not applied:'), 'reject cell collapse with removal disabled');
assert.match($('status').textContent, /remov|collaps/i);
assert.deepEqual(currentDesign(), beforeRemoval);
assert.deepEqual(cornerSourceSnapshot(), surfaceBeforeRemoval);
assert.equal(state.history.length, removalHistory);
assert.equal(state.cells.length, 2);
assert.equal(state.selected, 0);
assert.equal($('save-study').disabled, false);
$('allow-cell-removal').checked = true;
$('allow-cell-removal').dispatchEvent(new Event('change', { bubbles: true }));
clickSeed(0);
assert.deepEqual(state.selectedIds, [0], 'select the cell that will be removed before starting the accepted drag');
await edit(() => {
  const to = beginCornerDrag(removeFrom, removeTo.position);
  pointer(canvas, 'pointerup', to.x, to.y);
}, 'collapse a cell with removal enabled');
assert.deepEqual(state.cells.map(cell => cell.id), [1]);
assert.deepEqual(state.lastLayoutChange.removedCellIds, [0]);
assert.ok(state.lastLayoutChange.collapsedEdgeIds.length > 0);
assert.equal(state.lastLayoutChange.survivingCornerId, null);
assert.equal(state.selectedCorner, null, 'no stale junction selection remains after cell removal');
assert.equal(state.selected, 1, 'only the surviving incident cell remains selected');
assert.deepEqual(state.selectedIds, [1], 'removed cell IDs are cleared from the selection');
assert.equal(state.result.corners.length, 0);
assert.deepEqual(state.seeds, beforeRemoval.seeds, 'removed graph cell seeds remain historical provenance');
assert.deepEqual(state.directBase, beforeRemoval.layout);
assert.equal(state.history.length, removalHistory + 1);
close(state.result.surfaceCells.reduce((sum, cell) => sum + cell.area, 0), 1200 * 1200, 'cell removal preserves full source coverage');
assert.equal(state.result.solids.length, 1);
const removedDesign = currentDesign(), removedSurface = cornerSourceSnapshot();
await edit(() => key('z'), 'undo cell removal');
assert.deepEqual(currentDesign(), beforeRemoval);
assert.deepEqual(cornerSourceSnapshot(), surfaceBeforeRemoval);
assert.equal(state.selected, 0, 'undo restores the removed cell selection');
assert.equal(state.allowCellRemoval, true);
await edit(() => key('y'), 'redo cell removal');
assert.deepEqual(currentDesign(), removedDesign);
assert.deepEqual(cornerSourceSnapshot(), removedSurface);
const removedSaved = await saveStudy();
await openStudy(removedSaved, 'reopen graph with a retired cell');
assert.deepEqual(currentDesign(), removedDesign);
assert.deepEqual(cornerSourceSnapshot(), removedSurface);
await edit(() => { input('thickness', 55); input('thickness', 55, 'change'); }, 'refit after graph cell removal');
assert.deepEqual(state.layout, removedDesign.layout);
assert.deepEqual(state.cells.map(cell => cell.id), [1], 'stock changes do not regenerate the retired cell');
await edit(() => key('z'), 'undo stock change after cell removal');
assert.deepEqual(currentDesign(), removedDesign);
await edit(() => clickControl('reset-corners'), 'reset cell removal to the generated baseline');
assert.deepEqual(currentDesign(), beforeRemoval);
assert.deepEqual(cornerSourceSnapshot(), surfaceBeforeRemoval);
await edit(() => key('z'), 'undo reset after cell removal');
assert.deepEqual(currentDesign(), removedDesign);
console.log('PASS optional cell removal retires IDs, clears selection and survives save/refit/undo/reset');

// Flat and Solid handles use their displayed junction coordinates while edits
// remain attached to the source partition. A flat grid makes the expected
// source displacement exact, including the stock offset in Solid view.
function displayedCornerPosition(corner, view) {
  if (view === 'surface') return corner.position;
  if (view === 'flat') return corner.flatPosition;
  const candidates = corner.solidPositions || [];
  if (!candidates.length) return corner.flatPosition;
  const camera = window.cellStudy.camera.position;
  return [...candidates].sort((a, b) => new Vector3(...a.position).distanceToSquared(camera) - new Vector3(...b.position).distanceToSquared(camera))[0].position;
}
function checkDisplayedProjection(corner, view) {
  const displayed = displayedCornerPosition(corner, view);
  assert.ok(displayed?.length === 3, `${view} needs a displayed corner anchor`);
  const expected = projectWorld(displayed), actual = window.cellStudy.projectCorner(corner.id);
  close(actual.x, expected.x, `${view} handle projected x`, 1e-6);
  close(actual.y, expected.y, `${view} handle projected y`, 1e-6);
  return displayed;
}
function beginDisplayedCornerDrag(corner, view, delta, grabOffset = [0, 0]) {
  stableCornerId(corner);
  const displayed = checkDisplayedProjection(corner, view), from = window.cellStudy.projectCorner(corner.id);
  const to = projectWorld(displayed.map((value, axis) => value + delta[axis]));
  pointer(canvas, 'pointerdown', from.x + grabOffset[0], from.y + grabOffset[1]);
  assert.equal(state.selectedCorner, corner.id, `${view} picks the intended displayed handle`);
  assert.equal(window.cellStudy.controls.enabled, false);
  pointer(canvas, 'pointermove', to.x + grabOffset[0], to.y + grabOffset[1]);
  return { x: to.x + grabOffset[0], y: to.y + grabOffset[1] };
}
for (const view of ['flat', 'solid']) {
  await openStudy({ ...cornerStudy, view }, `${view} direct-corner fixture`);
  input('explode', 25);
  clickControl('corner-toggle');
  assert.equal(state.view, view, `${view} corner toggle preserves the view`);
  assert.equal(state.explode, 0, 'editing restores the assembled model');
  assert.equal(state.cornerMode, true);
  const corner = state.result.corners.find(value => !value.boundary && value.cells.length >= 3);
  assert.ok(corner);
  if (view === 'solid') assert.ok(corner.solidPositions?.length, 'fixture needs actual solid joint anchors');
  const before = currentDesign(), sourceBefore = cornerSourceSnapshot();
  const fitBefore = structuredClone(state.cells.map(cell => cell.flatPositions));
  const solidsBefore = structuredClone(state.result.solids.map(solid => solid.positions));
  const delta = [24, 16, 0];
  await edit(() => {
    const to = beginDisplayedCornerDrag(corner, view, delta);
    assert.deepEqual(currentDesign(), before, `${view} preview does not mutate saved inputs`);
    assert.deepEqual(cornerSourceSnapshot(), sourceBefore, `${view} preview leaves accepted source cells intact`);
    pointer(canvas, 'pointerup', to.x, to.y);
  }, `${view} direct displayed-corner drag`);
  assert.equal(state.view, view, 'accepting a corner edit keeps the active view');
  assert.deepEqual(state.cornerEdits, [], 'direct graph edits do not add legacy field constraints');
  assert.equal(state.layout.version, 2);
  assert.equal(state.layout.authority, 'graph');
  assert.ok(state.directBase, 'direct edits retain a reset baseline');
  assert.deepEqual(state.seeds, before.seeds);
  assert.notDeepEqual(cornerSourceSnapshot(), sourceBefore, `${view} editing changes the actual source partition`);
  assert.notDeepEqual(state.cells.map(cell => cell.flatPositions), fitBefore);
  assert.notDeepEqual(state.result.solids.map(solid => solid.positions), solidsBefore);
  const moved = findCurrentCorner(corner);
  moved.position.forEach((value, axis) => close(value, corner.position[axis] + delta[axis], `${view} source displacement`, 1e-3));
  checkDisplayedProjection(moved, view);
  const accepted = currentDesign(), sourceAccepted = cornerSourceSnapshot();
  await edit(() => clickControl('undo-move'), `${view} corner undo`);
  assert.equal(state.view, view);
  assert.deepEqual(currentDesign(), before);
  assert.deepEqual(cornerSourceSnapshot(), sourceBefore);
  await edit(() => clickControl('redo-edit'), `${view} corner redo`);
  assert.equal(state.view, view);
  assert.deepEqual(currentDesign(), accepted);
  assert.deepEqual(cornerSourceSnapshot(), sourceAccepted);
  const historyBeforeCancel = state.history.length;
  const cancelTo = beginDisplayedCornerDrag(findCurrentCorner(corner), view, [12, -8, 0]);
  if (view === 'flat') pointer(canvas, 'pointercancel', cancelTo.x, cancelTo.y);
  else {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    pointer(canvas, 'pointerup', cancelTo.x, cancelTo.y);
    assertNeutralTools('Escape from the solid corner view');
  }
  assert.deepEqual(currentDesign(), accepted);
  assert.deepEqual(cornerSourceSnapshot(), sourceAccepted);
  assert.equal(state.history.length, historyBeforeCancel);
  assert.equal(window.cellStudy.controls.enabled, true);
  const saved = await saveStudy();
  assert.equal(saved.view, view);
  await openStudy(saved, `${view} direct-corner study reopen`);
  assert.equal(state.view, view);
  assert.deepEqual(currentDesign(), accepted);
  assert.deepEqual(cornerSourceSnapshot(), sourceAccepted);
  checkDisplayedProjection(findCurrentCorner(corner), view);
  console.log(`PASS ${view} displayed handles, source/fit/solid updates, cancellation and history/save round trip`);
}

// A curved reference places the fitted junction away from its source anchor.
// Grabbing slightly off-centre and sending a zero-motion pointer event must not
// use that displacement or the handle grab offset as an unintended edit.
const curveHeight = (x, y) => .00008 * (x - 600) ** 2 + .00005 * (y - 600) ** 2;
const curvedStudy = { ...cornerStudy, name: 'curved-corner-grab',
  rawModel: { vertices: cornerVertices.map(([x, y]) => [x, y, curveHeight(x, y)]), triangles: cornerTriangles },
  seeds: [[200, 200], [1000, 200], [600, 1000]].map(([x, y], id) => ({ id, position: [x, y, curveHeight(x, y)], weight: 1 })),
  camera: [600, 600, 3000], target: [600, 600, 40] };
for (const view of ['flat', 'solid']) {
  await openStudy({ ...curvedStudy, view }, `${view} curved displaced-corner fixture`);
  if (!state.cornerMode) clickControl('corner-toggle');
  const corner = state.result.corners.find(value => !value.boundary && value.flatPosition
    && new Vector3(...value.position).distanceTo(new Vector3(...value.flatPosition)) > 1
    && (view !== 'solid' || value.solidPositions?.length));
  assert.ok(corner, 'curved fixture needs a source/fitted corner displacement and a usable displayed anchor');
  checkDisplayedProjection(corner, view);
  const before = currentDesign(), sourceBefore = cornerSourceSnapshot(), historyBefore = state.history.length;
  const revisionBefore = state.revision, repliesBefore = validationReplies.length;
  const from = window.cellStudy.projectCorner(corner.id), x = from.x + 1, y = from.y - 1;
  pointer(canvas, 'pointerdown', x, y);
  assert.equal(state.selectedCorner, corner.id);
  assert.equal(window.cellStudy.controls.enabled, false);
  pointer(canvas, 'pointermove', x, y);
  pointer(canvas, 'pointerup', x, y);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(validationReplies.length, repliesBefore, `${view} stationary grab must not request geometry validation`);
  assert.equal(state.revision, revisionBefore);
  assert.equal(state.history.length, historyBefore);
  assert.deepEqual(currentDesign(), before);
  assert.deepEqual(cornerSourceSnapshot(), sourceBefore);
  assert.equal($('save-study').disabled, false);
  const fitBefore = structuredClone(state.cells.map(cell => cell.flatPositions));
  await edit(() => {
    const to = beginDisplayedCornerDrag(corner, view, [6, 4, 0]);
    pointer(canvas, 'pointerup', to.x, to.y);
  }, `${view} curved displayed-corner drag`);
  const moved = findCurrentCorner(corner);
  const movedDistance = new Vector3(...moved.position).distanceTo(new Vector3(...corner.position));
  assert.ok(movedDistance > 1 && movedDistance < 20, `${view} small drag stays near the original source corner`);
  const sharedVertex = state.layout.vertices.find(vertex => vertex.id === moved.vertexId);
  assert.ok(sharedVertex);
  moved.position.forEach((value, axis) => close(value, sharedVertex.position[axis], `${view} curved shared graph vertex`, 1e-3));
  assert.deepEqual(state.cornerEdits, [], 'curved edits also author the graph directly');
  assert.notDeepEqual(cornerSourceSnapshot(), sourceBefore);
  assert.notDeepEqual(state.cells.map(cell => cell.flatPositions), fitBefore);
  assert.deepEqual(state.seeds, before.seeds);
  assert.equal(state.view, view);
  console.log(`PASS ${view} curved corner grab has no jump and small moves stay on the local source surface`);
}
// Pattern controls are drafts. Only a successful generation transaction may
// replace the authoritative layout, and structured results remain editable.
await edit(() => { $('example-select').value = 'aperture-sheet'; clickControl('load-example'); }, 'load the planar pattern reference');
const organicPatternDesign = currentDesign(), patternRevision = state.revision;
assert.deepEqual(state.pattern, { type: 'organic', angle: 0, frequency: 2 });
input('pattern-type', 'hexagonal'); input('pattern-angle', 0); input('size', 600);
assert.equal($('variation-control').hidden, true);
assert.equal($('pattern-angle-control').hidden, false);
assert.equal($('pattern-frequency-control').hidden, true);
assert.equal($('size-control').hidden, false);
assert.deepEqual(currentDesign(), organicPatternDesign, 'staging a pattern cannot alter the source layout');
assert.equal(state.revision, patternRevision);
await edit(() => clickControl('regenerate'), 'generate a clipped hexagonal lattice');
const firstHexDesign = currentDesign(), firstHexSource = cornerSourceSnapshot();
assert.deepEqual(state.pattern, { type: 'hexagonal', angle: 0, frequency: 2 });
assert.equal(state.layout.recipe.engine, 'structured-v1');
assert.deepEqual(state.layout.recipe.pattern, state.pattern);
assert.ok(state.cells.filter(cell => cell.neighbors.length === 6).length > 3, 'the planar lattice has multiple complete hexagonal interiors');
assert.ok(state.result.stats.coverageError < 1e-8);
assert.equal($('edit-toggle').disabled, false, 'structured cells support graph centre movement');
for (const cell of state.result.surfaceCells) for (const triangle of cell.triangles) {
  const center = [0, 2].map(axis => triangle.reduce((sum, id) => sum + cell.positions[id][axis], 0) / 3);
  assert.ok(!(center[0] > -400 && center[0] < 400 && center[1] > -300 && center[1] < 300), 'hexagonal clipping must retain the source opening');
}
await edit(() => clickControl('undo-move'), 'undo the organic-to-hexagonal replacement');
assert.deepEqual(currentDesign(), organicPatternDesign);
assert.equal($('pattern-type').value, 'organic');
await edit(() => clickControl('redo-edit'), 'redo the hexagonal replacement');
assert.deepEqual(currentDesign(), firstHexDesign);
assert.equal($('pattern-type').value, 'hexagonal');
input('pattern-angle', 30);
await edit(() => clickControl('regenerate'), 'rotate the hexagonal lattice');
assert.equal(state.pattern.angle, 30);
assert.notDeepEqual(cornerSourceSnapshot(), firstHexSource);
input('pattern-angle', 0);
await edit(() => clickControl('regenerate'), 'restore the original lattice orientation');
assert.deepEqual(cornerSourceSnapshot(), firstHexSource, 'the same structured settings reproduce exact source geometry');
assert.deepEqual(state.layout, firstHexDesign.layout);
const deterministicHistory = state.history.length;
await edit(() => clickControl('regenerate'), 'repeat identical structured generation');
assert.deepEqual(currentDesign(), firstHexDesign);
assert.equal(state.history.length, deterministicHistory, 'an identical deterministic layout is not another geometry edit');
console.log('PASS staged hexagonal pattern, exact coverage/openings, orientation, deterministic regeneration and cross-pattern history');

const hexStockLayout = structuredClone(state.layout), hexStockSource = cornerSourceSnapshot();
await edit(() => { input('thickness', 55); input('thickness', 55, 'change'); }, 'change stock on a structured layout');
assert.deepEqual(state.layout, hexStockLayout);
assert.deepEqual(cornerSourceSnapshot(), hexStockSource);
document.querySelector('[data-view="surface"]').click();
const hexInterior = state.result.corners.find(corner => !corner.boundary
  && Math.abs(corner.position[0]) < 1500 && Math.abs(corner.position[2]) > 500);
assert.ok(hexInterior, 'the hexagonal fixture needs an accessible shared corner');
if (!state.cornerMode) clickControl('corner-toggle');
const hexBeforeCorner = currentDesign();
await edit(() => {
  const target = hexInterior.position.map((value, axis) => value + [8, 0, 6][axis]);
  const to = beginCornerDrag(hexInterior, target);
  pointer(canvas, 'pointerup', to.x, to.y);
}, 'move a corner in the structured source graph');
assert.equal(state.layout.authority, 'graph');
assert.deepEqual(state.directBase, hexBeforeCorner.layout);
assert.deepEqual(state.pattern, firstHexDesign.pattern);
assert.deepEqual(state.seeds, firstHexDesign.seeds);
assert.notDeepEqual(cornerSourceSnapshot(), hexStockSource);
const editedHexDesign = currentDesign();
await edit(() => clickControl('undo-move'), 'undo a structured corner move');
assert.deepEqual(currentDesign(), hexBeforeCorner);
await edit(() => clickControl('redo-edit'), 'redo a structured corner move');
assert.deepEqual(currentDesign(), editedHexDesign);
if (!state.multiSelect) clickControl('multi-select');
clickControl('clear-selection');
const mergeFirst = state.cells.find(cell => cell.neighbors.length === 6
  && cell.neighbors.some(id => state.cells.find(other => other.id === id)?.neighbors.length === 6));
const mergeSecond = state.cells.find(cell => cell.id === mergeFirst.neighbors.find(id => state.cells.find(other => other.id === id)?.neighbors.length === 6));
clickSeed(mergeFirst.id); clickSeed(mergeSecond.id, { shiftKey: true });
assert.deepEqual(new Set(state.selectedIds), new Set([mergeFirst.id, mergeSecond.id]));
assert.equal($('cell-weight').disabled, true);
const beforeHexMerge = currentDesign(), hexCount = state.cells.length;
await edit(() => clickControl('merge-cells'), 'merge authored hexagonal cells');
assert.equal(state.cells.length, hexCount - 1);
assert.equal(state.layout.authority, 'graph');
assert.deepEqual(state.seeds, beforeHexMerge.seeds);
assert.deepEqual(state.pattern, beforeHexMerge.pattern);
const mergedHex = currentDesign(), savedHex = await saveStudy();
assert.deepEqual(savedHex.layout.recipe.pattern, state.pattern);
assert.deepEqual(savedHex.directBase.recipe.pattern, state.pattern);
await edit(() => clickControl('undo-move'), 'undo the structured merge');
assert.deepEqual(currentDesign(), beforeHexMerge);
await openStudy(savedHex, 'reopen a structured edited study');
assert.deepEqual(currentDesign(), mergedHex);
assert.equal($('pattern-type').value, 'hexagonal');
console.log('PASS structured stock changes preserve source; direct corner/merge edits, undo and saved provenance round trip');

async function rejectPattern(type, label) {
  const before = preservedDocument();
  input('pattern-type', type);
  clickControl('regenerate');
  await until(() => !state.generating && $('status').textContent.startsWith('Arrangement not applied:'), label);
  assert.deepEqual(preservedDocument(), before, 'unsupported pattern generation must retain the complete accepted document');
  assert.equal(state.ready, true); assert.equal(state.solved, true);
  assert.equal($('save-study').disabled, false);
  assert.equal($('regenerate').disabled, false);
}
await rejectPattern('geodesic', 'reject a spherical pattern on a flat sheet');
assert.ok(EXAMPLES.some(example => example.id === 'geodesic-sphere'));
await edit(() => { $('example-select').value = 'geodesic-sphere'; clickControl('load-example'); }, 'load the spherical pattern reference');
input('pattern-type', 'geodesic'); input('pattern-frequency', 2); input('pattern-angle', 0);
assert.equal($('variation-control').hidden, true);
assert.equal($('size-control').hidden, true);
assert.equal($('pattern-frequency-control').hidden, false);
await edit(() => clickControl('regenerate'), 'generate the geodesic dual');
assert.deepEqual(state.pattern, { type: 'geodesic', angle: 0, frequency: 2 });
assert.equal(state.cells.length, 42);
assert.equal(state.cells.filter(cell => cell.neighbors.length === 5).length, 12);
assert.equal(state.cells.filter(cell => cell.neighbors.length === 6).length, 30);
assert.ok(state.result.stats.coverageError < 1e-8);
assert.equal(state.layout.recipe.engine, 'structured-v1');
const geodesicSaved = await saveStudy(), geodesicDesign = currentDesign();
await openStudy(geodesicSaved, 'reopen the geodesic study');
assert.deepEqual(currentDesign(), geodesicDesign);
await rejectPattern('hexagonal', 'reject a planar lattice on a curved sphere');
console.log('PASS geodesic42-cell topology, saved frequency/orientation and atomic unsupported-surface rejection');

// A successful candidate may arrive after another edit has already changed
// the document. Its validation must not overwrite that newer accepted work.
input('pattern-type', 'geodesic'); input('pattern-angle', 17);
const heldGenerationCount = heldValidationReplies.length, beforeHeldGeneration = currentDesign();
holdNextValidationReply = true;
clickControl('regenerate');
await until(() => heldValidationReplies.length > heldGenerationCount, 'hold structured generation validation');
const heldGeneration = heldValidationReplies.at(-1);
assert.equal(heldGeneration.data.error, undefined);
assert.deepEqual(currentDesign(), beforeHeldGeneration);
await edit(() => { input('thickness', 50); input('thickness', 50, 'change'); }, 'edit stock while generation is validating');
const newerDocument = preservedDocument(), repliesBeforeGeneration = validationReplies.length;
heldGeneration.deliver();
await until(() => validationReplies.length > repliesBeforeGeneration && !state.generating, 'deliver stale structured generation validation');
assert.deepEqual(preservedDocument(), newerDocument);
assert.match($('status').textContent, /design changed while generating/i);
assert.equal($('save-study').disabled, false);
console.log('PASS late structured generation cannot overwrite a newer stock edit');

// Newer draft input is also an intent change even though it has not changed
// captureDesign yet. A cancelled preflight must not overwrite that new draft.
document.querySelector('[data-view="surface"]').click();
if (!state.cornerMode) clickControl('corner-toggle');
const guardedCorner = [...state.result.corners].filter(corner => {
  const point = window.cellStudy.projectCorner(corner.id);
  return point && point.z > -1 && point.z < 1 && point.x > 30 && point.x < 994 && point.y > 30 && point.y < 690;
}).sort((a, b) => new Vector3(...a.position).distanceToSquared(window.cellStudy.camera.position)
  - new Vector3(...b.position).distanceToSquared(window.cellStudy.camera.position))[0];
assert.ok(guardedCorner, 'the generation guard fixture needs a visible shared corner');
const guardedPoint = window.cellStudy.projectCorner(guardedCorner.id);
pointer(canvas, 'pointerdown', guardedPoint.x, guardedPoint.y);
assert.equal(window.cellStudy.controls.enabled, false, 'the selected handle is normally draggable');
pointer(canvas, 'pointerup', guardedPoint.x, guardedPoint.y);
assert.equal(window.cellStudy.controls.enabled, true);

async function holdArrangement(label) {
  const count = heldValidationReplies.length;
  holdNextValidationReply = true;
  clickControl('regenerate');
  await until(() => heldValidationReplies.length > count, label);
  const reply = heldValidationReplies.at(-1);
  assert.equal(reply.data.error, undefined, 'the held arrangement is geometrically acceptable');
  assert.equal(state.generating, true);
  return reply;
}
async function deliverCancelledArrangement(reply, before, label) {
  const replies = validationReplies.length;
  reply.deliver();
  await until(() => validationReplies.length > replies, label);
  assert.equal(state.generating, false);
  assert.deepEqual(preservedDocument(), before, 'a late cancelled arrangement cannot change layout, history, selection or readiness');
  assert.equal($('save-study').disabled, false);
  assert.equal($('regenerate').disabled, false);
}

input('pattern-angle', 23);
const beforeDraftCancellation = preservedDocument();
const draftReply = await holdArrangement('hold generation before newer draft input');
pointer(canvas, 'pointerdown', guardedPoint.x, guardedPoint.y);
assert.equal(window.cellStudy.controls.enabled, true, 'generation prevents a corner gesture from capturing orbit controls');
pointer(canvas, 'pointermove', guardedPoint.x + 8, guardedPoint.y + 6);
pointer(canvas, 'pointerup', guardedPoint.x + 8, guardedPoint.y + 6);
assert.deepEqual(preservedDocument(), beforeDraftCancellation, 'an attempted corner drag during generation cannot edit the accepted document');
input('pattern-angle', 41);
assert.equal(state.generating, false, 'new draft input cancels the older generation immediately');
const draftStatus = $('status').textContent;
await deliverCancelledArrangement(draftReply, beforeDraftCancellation, 'ignore generation superseded by a newer angle');
assert.equal($('pattern-angle').value, '41');
assert.equal($('status').textContent, draftStatus, 'the late reply does not replace the newer draft guidance');
console.log('PASS pending generation blocks corner editing and newer angle input survives its cancelled reply');

await edit(() => { $('example-select').value = 'aperture-sheet'; clickControl('load-example'); }, 'load a planar reference for preset cancellation');
input('pattern-type', 'hexagonal'); input('pattern-angle', 0); input('size', 600);
const beforePresetCancellation = preservedDocument();
const presetReply = await holdArrangement('hold generation before a new spacing preset');
const newerPreset = document.querySelector('[data-size]');
revealControl(newerPreset); newerPreset.click();
assert.equal(state.generating, false);
const stagedPreset = $('size').value;
assert.notEqual(Number(stagedPreset), 600);
await deliverCancelledArrangement(presetReply, beforePresetCancellation, 'ignore generation superseded by a spacing preset');
assert.equal($('size').value, stagedPreset, 'the spacing preset remains staged after the late result');
assert.equal($('pattern-type').value, 'hexagonal');

input('size', 600);
const beforeEscapeGeneration = preservedDocument();
const escapeReply = await holdArrangement('hold generation before Escape cancellation');
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
assert.equal(state.generating, false);
assertNeutralTools('Escape during arrangement generation');
assert.match($('status').textContent, /arrangement cancelled/i);
const escapeStatus = $('status').textContent;
await deliverCancelledArrangement(escapeReply, withoutSelection(beforeEscapeGeneration), 'ignore generation cancelled with Escape');
assert.equal($('status').textContent, escapeStatus);
console.log('PASS spacing presets and Escape cancel generation without losing accepted geometry or later drafts');

// Regularity is another staged generator setting. Its source snapshot stays
// authoritative through history, stock changes, save/open and direct edits.
const { inspectPolygon, measureLayoutQuality } = await import(new URL('quality.js', demo).href);
function assertQualityUI(label) {
  assert.deepEqual(state.result.quality, measureLayoutQuality(state.cells), `${label}: aggregate uses the fitted outlines`);
  for (const cell of state.cells) assert.deepEqual(cell.polygonQuality, inspectPolygon(cell.outline2d));
  const quality = state.result.quality;
  assert.equal($('convex-check').textContent, `${quality.convexCount}/${quality.totalCount}`);
  assert.equal(quality.convexCount + quality.concaveCount + quality.holedCount + quality.invalidCount, quality.totalCount);
}
await edit(() => { $('example-select').value = 'organic-vessel'; clickControl('load-example'); }, 'load an organic vessel for surface relaxation');
const organicVesselDesign = currentDesign(), organicVesselSource = cornerSourceSnapshot();
assert.equal(state.pattern.type, 'organic');
input('pattern-type', 'regularized'); input('pattern-regularity', 70);
assert.equal($('pattern-regularity-control').hidden, false);
assert.equal($('pattern-angle-control').hidden, true);
assert.equal($('pattern-frequency-control').hidden, true);
assert.equal($('variation-control').hidden, true);
assert.equal($('size-control').hidden, false);
assert.equal($('pattern-regularity-value').textContent, '70%');
assert.deepEqual(currentDesign(), organicVesselDesign);
await edit(() => clickControl('regenerate'), 'regularize the organic vessel at seventy percent');
const regularized70Design = currentDesign(), regularized70Source = cornerSourceSnapshot();
assert.deepEqual(state.pattern, { type: 'regularized', angle: 0, frequency: 2, regularity: .7 });
assert.equal(state.layout.recipe.engine, 'regularized-surface-v1');
assert.deepEqual(state.layout.recipe.pattern, state.pattern);
assert.equal(state.cells.length, organicVesselDesign.layout.cells.length, 'relaxation preserves the intended cell count');
assert.ok(state.result.stats.coverageError < 1e-8);
assert.notDeepEqual(cornerSourceSnapshot(), organicVesselSource, 'relaxation authors an actual source layout');
assert.equal($('edit-toggle').disabled, false, 'regularized layouts support graph centre movement');
assertQualityUI('regularized vessel');
await edit(() => clickControl('undo-move'), 'undo organic-to-regularized generation');
assert.deepEqual(currentDesign(), organicVesselDesign);
assert.equal($('pattern-regularity-control').hidden, true);
await edit(() => clickControl('redo-edit'), 'redo regularized generation');
assert.deepEqual(currentDesign(), regularized70Design);
assert.equal($('pattern-regularity').value, '70');

const beforeRegularityDraft = preservedDocument();
input('pattern-regularity', 20);
assert.deepEqual(preservedDocument(), beforeRegularityDraft);
input('pattern-regularity', 80);
assert.equal($('pattern-regularity-value').textContent, '80%');
assert.deepEqual(preservedDocument(), beforeRegularityDraft, 'regularity drafts cannot change accepted geometry, quality or history');
await edit(() => clickControl('regenerate'), 'apply eighty percent regularity');
assert.equal(state.pattern.regularity, .8);
assert.notDeepEqual(cornerSourceSnapshot(), regularized70Source, 'applying a new regularity changes the partition');
const regularized80Design = currentDesign();
await edit(() => clickControl('undo-move'), 'undo a regularity change');
assert.deepEqual(currentDesign(), regularized70Design);
assert.equal($('pattern-regularity').value, '70');
await edit(() => clickControl('redo-edit'), 'redo a regularity change');
assert.deepEqual(currentDesign(), regularized80Design);
input('pattern-regularity', 70);
await edit(() => clickControl('regenerate'), 'regenerate the same seventy percent surface');
assert.deepEqual(currentDesign(), regularized70Design, 'identical settings reproduce the source snapshot exactly');
const regularizedRepeatHistory = state.history.length;
await edit(() => clickControl('regenerate'), 'repeat the accepted regularized arrangement');
assert.deepEqual(currentDesign(), regularized70Design);
assert.equal(state.history.length, regularizedRepeatHistory, 'an identical surface is not an additional history edit');
console.log('PASS regularized vessel drafts, applied strength, deterministic generation and organic/regularized history');

const defaultBudgetStudy = await saveStudy(), beforeBudgetDraft = preservedDocument();
assert.equal(state.maxGeneratedCells, 240); assert.equal($('max-generated-cells').value, '240');
assert.equal($('generation-budget-control').hidden, false);
input('max-generated-cells', 300);
assert.deepEqual(preservedDocument(), beforeBudgetDraft, 'the generation maximum remains a draft until New arrangement');
assert.match($('generation-help').textContent, /More cells take longer/);
await edit(() => clickControl('regenerate'), 'apply a custom generation maximum to Regularized surface');
assert.equal(state.maxGeneratedCells, 300); assert.equal(state.layout.recipe.maxGeneratedCells, 300);
const budget300Design = currentDesign(), budget300Study = await saveStudy();
assert.equal(budget300Study.maxGeneratedCells, 300); assert.ok(budget300Study.requiredFeatures.includes('generation-budget-v1'));
await edit(() => clickControl('undo-move'), 'undo the custom generation maximum');
assert.deepEqual(currentDesign(), regularized70Design); assert.equal($('max-generated-cells').value, '240');
await edit(() => clickControl('redo-edit'), 'redo the custom generation maximum');
assert.deepEqual(currentDesign(), budget300Design); assert.equal($('max-generated-cells').value, '300');
await openStudy(budget300Study, 'reopen the custom generation maximum');
assert.deepEqual(currentDesign(), budget300Design); assert.equal($('max-generated-cells').value, '300');
clickControl('open-checkpoints'); input('checkpoint-name', 'Generation maximum 300'); clickControl('save-checkpoint');
const budgetCheckpoint = state.checkpoints.at(-1); clickControl('close-checkpoints');
input('max-generated-cells', 320);
await edit(() => clickControl('regenerate'), 'change the applied generation maximum after a checkpoint');
clickControl('open-checkpoints');
const budgetCheckpointRow = $('checkpoint-list').querySelector(`[data-checkpoint-id="${budgetCheckpoint.id}"]`);
[...budgetCheckpointRow.querySelectorAll('button')].find(button => button.textContent === 'Restore').click();
await until(() => state.maxGeneratedCells === 300 && state.solved && !state.busy && !state.pending, 'checkpoint restores the applied generation maximum');
assert.equal($('max-generated-cells').value, '300'); assert.deepEqual(currentDesign(), budget300Design);
await edit(() => clickControl('undo-move'), 'undo checkpoint restoration of the generation maximum');
assert.equal(state.maxGeneratedCells, 320); assert.equal($('max-generated-cells').value, '320');
for (const invalid of [11, 501, 300.5]) {
  const before = preservedDocument(); input('max-generated-cells', invalid); clickControl('regenerate');
  await until(() => /whole number from 12 to 500/.test($('status').textContent), 'invalid generation maximum is explained');
  assert.deepEqual(preservedDocument(), before, 'invalid generation maximum keeps accepted source and history');
}
input('max-generated-cells', 330);
const beforeBudgetCancellation = preservedDocument(), budgetReply = await holdArrangement('hold generation before a newer cell-limit draft');
input('max-generated-cells', 350);
await deliverCancelledArrangement(budgetReply, beforeBudgetCancellation, 'cancel generation superseded by another cell-limit draft');
assert.equal($('max-generated-cells').value, '350'); assert.equal(state.maxGeneratedCells, 320);
input('pattern-type', 'hexagonal');
assert.equal($('generation-budget-control').hidden, true); assert.equal($('max-generated-cells').disabled, true);
await openStudy(defaultBudgetStudy, 'restore the default generation maximum');
assert.deepEqual(currentDesign(), regularized70Design); assert.equal($('max-generated-cells').value, '240');
console.log('PASS generation maximum drafts, validation, apply, undo/redo, study/checkpoint restoration and stale-generation cancellation');

const uniformRegularizedStudy = await saveStudy(), beforeSizingDraft = preservedDocument();
clickControl('curvature-sizing');
input('curvature-min-size', Math.max(10, Math.round(state.size * .9)));
input('curvature-max-size', state.size);
assert.equal($('curvature-range').hidden, false);
assert.equal($('size-control').hidden, true);
assert.deepEqual(preservedDocument(), beforeSizingDraft, 'curvature range drafts do not change accepted work');
const requestedPolicy = { type: 'curvature', version: 1, minSizeMm: Number($('curvature-min-size').value), maxSizeMm: state.size };
await edit(() => clickControl('regenerate'), 'apply curvature-adaptive regularized layout');
assert.deepEqual(state.generatorPolicy, requestedPolicy);
assert.deepEqual(state.layout.recipe.generatorPolicy, requestedPolicy);
const adaptiveDesign = currentDesign();
await edit(() => clickControl('undo-move'), 'undo curvature sizing');
assert.equal(state.generatorPolicy, null);
assert.equal($('curvature-sizing').checked, false);
assert.deepEqual(currentDesign(), regularized70Design);
await edit(() => clickControl('redo-edit'), 'redo curvature sizing');
assert.deepEqual(currentDesign(), adaptiveDesign);
assert.equal($('curvature-sizing').checked, true);
const adaptiveStudy = await saveStudy();
assert.ok(adaptiveStudy.requiredFeatures.includes('curvature-sizing-v1'));
const beforeSizingCancel = preservedDocument();
input('curvature-min-size', requestedPolicy.minSizeMm + 1);
const sizingReply = await holdArrangement('hold a curvature sizing draft');
input('curvature-max-size', requestedPolicy.maxSizeMm + 20);
await deliverCancelledArrangement(sizingReply, beforeSizingCancel, 'discard generation superseded by a newer size range');
assert.equal($('curvature-max-size').value, String(requestedPolicy.maxSizeMm + 20));
await openStudy(adaptiveStudy, 'reopen adaptive regularized source');
assert.deepEqual(currentDesign(), adaptiveDesign);
assert.equal($('curvature-min-size').value, String(requestedPolicy.minSizeMm));
assert.equal($('curvature-max-size').value, String(requestedPolicy.maxSizeMm));
const adaptiveSource = structuredClone(state.layout);
await edit(() => { input('thickness', 45); input('thickness', 45, 'change'); }, 'change adaptive stock');
assert.deepEqual(state.layout, adaptiveSource, 'stock changes retain the exact adaptive source');
assert.deepEqual(state.generatorPolicy, requestedPolicy);
input('curvature-min-size', requestedPolicy.maxSizeMm + 1);
const beforeInvalidRange = currentDesign();
clickControl('regenerate');
await until(() => /Arrangement not applied/.test($('status').textContent), 'invalid size range rejected');
assert.deepEqual(currentDesign(), beforeInvalidRange);
await openStudy(uniformRegularizedStudy, 'restore uniform regularized fixture');
assert.deepEqual(currentDesign(), regularized70Design);
assert.equal(state.generatorPolicy, null);
assert.equal($('curvature-sizing').checked, false);
console.log('PASS staged curvature range, adaptive regularization, undo/redo, save/reopen, stock preservation and cancellation');

const qualityBeforeStock = structuredClone(state.result.quality);
await edit(() => { input('thickness', 50); input('thickness', 50, 'change'); }, 'change regularized panel stock');
assert.deepEqual(state.layout, regularized70Design.layout);
assert.deepEqual(cornerSourceSnapshot(), regularized70Source);
assert.deepEqual(state.result.quality, qualityBeforeStock, 'stock thickness does not change fitted polygon convexity');
assertQualityUI('regularized stock');
const regularizedStockDesign = currentDesign(), regularizedSaved = await saveStudy();
await openStudy(regularizedSaved, 'reopen a regularized study');
assert.deepEqual(currentDesign(), regularizedStockDesign);
assert.deepEqual(state.result.quality, qualityBeforeStock);
assert.equal($('pattern-type').value, 'regularized');
assert.equal($('pattern-regularity').value, '70');

input('pattern-regularity', 20);
const beforeRegularityCancellation = preservedDocument();
const regularityReply = await holdArrangement('hold regularized generation before a newer strength draft');
input('pattern-regularity', 80);
assert.equal(state.generating, false);
await deliverCancelledArrangement(regularityReply, beforeRegularityCancellation, 'discard a superseded regularized surface');
assert.equal($('pattern-regularity').value, '80');
assert.equal(state.pattern.regularity, .7);
console.log('PASS regularized source/quality persistence through stock/save and cancellation by a newer strength draft');

document.querySelector('[data-view="surface"]').click();
if (state.cornerMode) clickControl('corner-toggle');
if (state.multiSelect) clickControl('multi-select');
clickControl('clear-selection');
const visibleRegularizedIds = new Set();
let regularizedMergePair = null;
for (const seed of [...state.seeds].sort((a, b) => new Vector3(...a.position).distanceToSquared(window.cellStudy.camera.position)
  - new Vector3(...b.position).distanceToSquared(window.cellStudy.camera.position))) {
  const screen = window.cellStudy.projectSeed(seed.id);
  if (!screen || screen.x < 20 || screen.x > 1004 || screen.y < 20 || screen.y > 700) continue;
  clickSeed(seed.id);
  if (state.selected !== seed.id) continue;
  visibleRegularizedIds.add(seed.id);
  const neighbor = state.cells.find(cell => cell.id === seed.id).neighbors.find(id => visibleRegularizedIds.has(id));
  if (neighbor !== undefined) { regularizedMergePair = [neighbor, seed.id]; break; }
}
assert.ok(regularizedMergePair, 'the curved regularized vessel has two adjacent cells accessible to real picking');
clickControl('clear-selection'); clickControl('multi-select');
clickSeed(regularizedMergePair[0]); clickSeed(regularizedMergePair[1], { shiftKey: true });
assert.deepEqual(new Set(state.selectedIds), new Set(regularizedMergePair));
const beforeRegularizedMerge = currentDesign(), regularizedCellCount = state.cells.length;
await edit(() => clickControl('merge-cells'), 'merge two regularized surface cells');
assert.equal(state.cells.length, regularizedCellCount - 1);
assert.equal(state.layout.authority, 'graph');
assert.deepEqual(state.directBase, beforeRegularizedMerge.layout);
assert.deepEqual(state.seeds, beforeRegularizedMerge.seeds);
assert.deepEqual(state.pattern, beforeRegularizedMerge.pattern);
assertQualityUI('merged regularized cells');
const mergedRegularizedDesign = currentDesign(), mergedRegularizedQuality = structuredClone(state.result.quality);
await edit(() => clickControl('undo-move'), 'undo the regularized graph merge');
assert.deepEqual(currentDesign(), beforeRegularizedMerge);
await edit(() => clickControl('redo-edit'), 'redo the regularized graph merge');
assert.deepEqual(currentDesign(), mergedRegularizedDesign);
const mergedRegularizedSave = await saveStudy();
await openStudy(mergedRegularizedSave, 'reopen the regularized authored graph');
assert.deepEqual(currentDesign(), mergedRegularizedDesign);
assert.deepEqual(state.result.quality, mergedRegularizedQuality);
console.log('PASS regularized graph merging, baseline provenance, undo/redo and current save/open');

// Convexity is a geometric diagnostic, separate from panel validity. This
// deliberately concave L panel must remain a valid manufacturable export.
const { resolveSourceLayout } = await import(new URL('design.js', demo).href);
const { createStudy } = await import(new URL('study.js', demo).href);
const concaveRawModel = { vertices: [[0, 0, 0], [400, 0, 0], [400, 200, 0], [200, 200, 0], [200, 400, 0], [0, 400, 0]],
  triangles: [[0, 1, 3], [1, 2, 3], [0, 3, 5], [3, 4, 5]] };
const concaveInputs = { pattern: { type: 'organic', angle: 0, frequency: 2 },
  seeds: [{ id: 0, position: [100, 100, 0], weight: 1 }], size: 600, variation: 0, randomSeed: 7, mergeGroups: [], cornerEdits: [],
  thickness: 20, roundover: 0, straightness: .7, name: 'concave-exportable-panel', rawModel: concaveRawModel, view: 'flat' };
const concaveLayout = resolveSourceLayout(concaveRawModel, concaveInputs).layout;
const concaveStudy = createStudy({ ...concaveInputs, layout: concaveLayout }, {
  units: 'mm', up: 'y', camera: [200, 200, 1400], target: [200, 200, 0] });
await openStudy(concaveStudy, 'open a current-format concave panel fixture');
assert.equal(state.cells.length, 1);
assert.equal(state.cells[0].valid, true);
assert.equal(state.result.solids[0].valid, true);
assert.equal(state.cells[0].polygonQuality.classification, 'concave');
assertQualityUI('valid concave panel');
clickSeed(0);
assert.equal($('selected-convexity').textContent, 'Concave');
assert.equal($('convex-check').textContent, '0/1');
for (const id of ['export-obj', 'export-dxf', 'export-stl', 'export-selected-obj', 'export-selected-dxf']) {
  assert.equal($(id).disabled, false, `${id} accepts valid concave panels`);
  const count = downloads.length;
  clickControl(id);
  assert.equal(downloads.length, count + 1);
  assert.ok((await downloads.at(-1).blob.text()).length > 100);
}
console.log('PASS convexity labels match geometry and valid concave panels still export OBJ, DXF and STL');

// Native CAD uses a separate worker and binary downloads, preserving the selected geometry.
await openStudy(cornerStudy, 'Rhino production fixture');
const {loadRhino}=await import(new URL('rhino-runtime.js',demo).href),rhino=await loadRhino();
assert.equal($('export-rhino').disabled,false);
async function expectStaleRhinoExportBlocked(id) {
  const controls = ['export-rhino', 'export-rhino-repair', 'export-repair-shortcut'];
  const previousDisabled = controls.map(control => $(control).disabled);
  const downloadCount = downloads.length, exportCount = rhinoExports.length;
  assert.equal($(id).disabled, false);
  returnNextRhino7Header = true;
  clickControl(id);
  for (const control of controls) assert.equal($(control).disabled, true, `${control} waits for the delivered archive`);
  await until(() => !returnNextRhino7Header && !$(id).disabled, `reject stale Rhino 7 response from ${id}`);
  assert.equal(rhinoExports.length, exportCount + 1, 'the stale response came from one actual native export request');
  assert.equal(downloads.length, downloadCount, 'a Rhino 7 header cannot reach the browser download');
  assert.match($('status').textContent, /Rhino 7 format instead of Rhino 6\. Download stopped\./);
  assert.match($('status').textContent, /Save your study, reopen the updated site, and export again/);
  assert.deepEqual(controls.map(control => $(control).disabled), previousDisabled, 'export controls recover after a rejected archive');
}
for (const setting of ['carving', 'thickness']) {
  const revision = state.revision, exportCount = rhinoExports.length, downloadCount = downloads.length, fitReplyCount = heldFitReplies.length;
  holdNextFitReply = true;
  if (setting === 'carving') {
    $('carve-inner').checked = true;
    $('carve-inner').dispatchEvent(new Event('change', { bubbles: true }));
  } else input('thickness', state.thickness + 5);
  assert.equal(state.solved, false, `${setting} invalidates the current solid geometry immediately`);
  assert.equal($('export-rhino').disabled, true, `${setting} blocks Rhino export before the next solve`);
  // dispatchEvent reaches the handler even on a disabled button, checking its
  // own guard as well as the ordinary browser disabled-button behavior.
  $('export-rhino').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  if (setting === 'thickness') input('thickness', state.thickness, 'change');
  await until(() => heldFitReplies.length > fitReplyCount, `hold ${setting} geometry before Rhino export`);
  assert.equal(rhinoExports.length, exportCount, `${setting} cannot start an export with stale solids`);
  assert.equal(downloads.length, downloadCount, `${setting} cannot download stale solids`);
  assert.equal($('export-rhino').disabled, true, `${setting} stays blocked until the new result arrives`);
  heldFitReplies[fitReplyCount].deliver();
  await until(() => state.revision > revision && state.solved, `resolve ${setting} for Rhino export`);
  assert.equal($('export-rhino').disabled, false, `${setting} enables export of the newly resolved solids`);
}
await expectStaleRhinoExportBlocked('export-rhino');
const cadCount=downloads.length;
clickControl('export-rhino');
await until(()=>downloads.length>cadCount,'native 3DM production download');
assert.equal(downloads.at(-1).name, `${state.name}-r${state.project.revision}-production-rhino6.3dm`);
assert.equal(rhinoExports.at(-1).options.carved, true);
assert.deepEqual(rhinoExports.at(-1).solids, state.result.solids, 'native export receives the newly selected carved geometry');
const production=rhino.File3dm.fromByteArray(new Uint8Array(await downloads.at(-1).blob.arrayBuffer()));
assert.equal(production.instanceDefinitions().count,state.cells.length);
assert.equal(production.archiveVersion,60,'Rhino production supports Rhino 6, 7 and 8');
for (let i = 0; i < production.objects().count; i++) {
  const object = production.objects().get(i), geometry = object.geometry();
  if (geometry.objectType === rhino.ObjectType.Mesh) {
    assert.equal(object.attributes().getUserString('panel-workbench-carved'), 'true');
  }
}
production.delete();
assert.equal($('import-info').getAttribute('popover'),'');
assert.equal($('export-info').getAttribute('popover'),'');
assert.match($('export-info').textContent,/BlockEdit/);
assert.match($('import-info').textContent,/coplanar/);

// Synthetic worker diagnostics keep this regression independent of private
// source geometry while exercising the same completed-result UI and export path.
const outlineFailure = 'The fitted outline crosses itself. Move its centre or use smaller cells.';
const solidFailure = 'The thickness or edge rounding makes an outline cross itself.';
alterNextFitReply = result => {
  const outline = result.cells[0], solidOnly = result.cells[1];
  outline.valid = false; outline.issues = [outlineFailure];
  result.stats.invalidCellCount = 1;
  result.solids = result.solids.map(solid => solid.id === outline.id || solid.id === solidOnly.id
    ? { ...solid, valid: false, positions: [], triangles: [], issues: [solid.id === outline.id
      ? 'Reshape this cell before making a solid panel.' : solidFailure] }
    : solid);
};
await openStudy({ ...cornerStudy, name: 'repair-diagnostic-fixture' }, 'unresolved diagnostic fixture');
const outlineId = state.cells[0].id, solidOnlyId = state.cells[1].id;
const problemButton = id => $('panel-problem-list').querySelector(`[data-panel-id="${id}"]`);
assert.equal($('export-rhino').disabled, true, 'production export stays blocked by unresolved geometry');
assert.equal($('export-rhino-repair').disabled, false, 'explicit repair export accepts a completed unresolved result');
assert.equal($('export-repair-shortcut').disabled, false);
assert.match($('export-availability').textContent, /2 panels unresolved/);
assert.equal($('panel-problem-count').textContent, '2');
for (const view of ['surface', 'flat', 'solid', 'reference']) {
  document.querySelector(`[data-view="${view}"]`).click();
  assert.equal($('panel-problems').hidden, false, `${view} keeps panel diagnoses visible`);
  assert.equal($('panel-problem-list').querySelectorAll('[data-panel-id]').length, 2);
  assert.match($('panel-problem-list').textContent, /Two edges of the same panel cross.*Move a nearby corner/s);
  assert.match($('panel-problem-list').textContent, /Adding thickness or rounding.*Try less thickness/s);
}
problemButton(outlineId).click();
assert.equal(state.selected, outlineId); assert.equal(state.view, 'flat');
assert.equal(problemButton(outlineId).getAttribute('aria-pressed'), 'true');
assert.match($('selected-note').textContent, /Two edges of the same panel cross.*Move a nearby corner/s, 'outline selection explains its actual fitting failure and a next edit');
assert.ok(!$('selected-note').textContent.includes('Reshape this cell before making a solid panel.'), 'generic downstream rejection does not obscure the original reason');
problemButton(solidOnlyId).click();
assert.equal(state.selected, solidOnlyId); assert.equal(state.view, 'solid');
assert.equal(problemButton(solidOnlyId).getAttribute('aria-pressed'), 'true');
assert.match($('selected-note').textContent, /Adding thickness or rounding.*Try less thickness/s, 'solid selection explains its separate thickness failure and a next edit');

await expectStaleRhinoExportBlocked('export-rhino-repair');
const repairDownloadCount = downloads.length;
clickControl('export-rhino-repair');
await until(() => downloads.length > repairDownloadCount, 'explicit native repair download');
assert.equal(downloads.at(-1).name, `repair-diagnostic-fixture-r${state.project.revision}-repair-rhino6.3dm`);
assert.equal(rhinoExports.at(-1).operation, 'repair-export');
assert.deepEqual(rhinoExports.at(-1).sourceCells, state.result.surfaceCells, 'repair receives original source patches for missing solids');
const repairFile = rhino.File3dm.fromByteArray(new Uint8Array(await downloads.at(-1).blob.arrayBuffer()));
try {
  assert.equal(repairFile.archiveVersion, 60);
  assert.equal(repairFile.instanceDefinitions().count, state.cells.length, 'repair retains every panel');
  const references = [];
  for (let i = 0; i < repairFile.objects().count; i++) {
    const object = repairFile.objects().get(i), geometry = object.geometry();
    if (geometry.objectType === rhino.ObjectType.InstanceReference) references.push({ geometry, attributes: object.attributes() });
  }
  assert.equal(references.length, state.cells.length * 2, 'repair has assembly and inspection instances for every panel');
  for (let i = 0; i < repairFile.instanceDefinitions().count; i++) {
    const definition = repairFile.instanceDefinitions().get(i), pair = references.filter(ref => ref.geometry.parentIdefId === definition.id);
    assert.equal(pair.length, 2, `${definition.name} retains its shared block definition`);
    assert.deepEqual(pair.map(ref => ref.attributes.getUserString('panel-workbench-placement')).sort(), ['assembly', 'repair-layout']);
    const panel = state.cells[i], unresolved = panel.id === outlineId || panel.id === solidOnlyId;
    assert.ok(pair.every(ref => ref.attributes.getUserString('panel-workbench-status') === (unresolved ? 'unresolved' : 'resolved')));
    if (unresolved) {
      assert.ok(pair.every(ref => ref.attributes.getUserString('panel-workbench-representation') === 'source-patch'));
      const source = state.result.surfaceCells.find(cell => cell.id === panel.id);
      const members = definition.getObjectIds().map(id => repairFile.objects().findId(id));
      const mesh = members.map(object => object.geometry()).find(geometry => geometry.objectType === rhino.ObjectType.Mesh);
      assert.equal(mesh.vertices().count, source.positions.length, 'empty solid exports the available source patch without invented thickness');
      assert.equal(mesh.faces().count, source.triangles.length);
      const issueKey = panel.id === outlineId ? 'panel-workbench-flat-issues' : 'panel-workbench-solid-issues';
      assert.ok(pair.every(ref => JSON.parse(ref.attributes.getUserString(issueKey)).includes(panel.id === outlineId ? outlineFailure : solidFailure)));
    }
  }
} finally { repairFile.delete(); }
const shortcutDownloadCount = downloads.length;
clickControl('export-repair-shortcut');
await until(() => downloads.length > shortcutDownloadCount, 'diagnostic panel repair shortcut');
assert.equal(downloads.at(-1).name, `repair-diagnostic-fixture-r${state.project.revision}-repair-rhino6.3dm`);

const repairRevision = state.revision, repairExportCount = rhinoExports.length, pendingDownloads = downloads.length, repairFitCount = heldFitReplies.length;
holdNextFitReply = true;
input('thickness', state.thickness + 5);
for (const id of ['export-rhino-repair', 'export-repair-shortcut']) {
  assert.equal($(id).disabled, true, `${id} waits for the current calculation despite the validity override`);
  $(id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
assert.match($('export-availability').textContent, /Wait for the current panel calculation/);
input('thickness', state.thickness, 'change');
await until(() => heldFitReplies.length > repairFitCount, 'hold repair recalculation');
assert.equal(rhinoExports.length, repairExportCount, 'repair override cannot start an export of stale geometry');
assert.equal(downloads.length, pendingDownloads);
heldFitReplies[repairFitCount].deliver();
await until(() => state.revision > repairRevision && state.solved, 'resolve diagnostic fixture');
assert.equal($('panel-problems').hidden, true, 'resolved recalculation clears the problem list');
assert.equal($('panel-problem-list').children.length, 0);
assert.match($('export-availability').textContent, /All panels resolved/);
assert.equal($('export-rhino').disabled, false);
assert.equal($('export-rhino-repair').disabled, false);
console.log('PASS unresolved panel reasons, native repair blocks, stale Rhino version rejection and recovery, and pending-solve export guards');

const incoming=new rhino.File3dm();incoming.settings().modelUnitSystem=rhino.UnitSystem.Centimeters;
const curve=new rhino.PolylineCurve([[0,0,0],[120,0,0],[120,120,0],[0,120,0],[0,0,0]]),cadAttrs=new rhino.ObjectAttributes();
incoming.objects().add(curve,cadAttrs);
const cadBytes=incoming.toByteArray(),oldRevision=state.revision;
incoming.delete();curve.delete();cadAttrs.delete();
loadFile('mesh-file',{name:'rhino-source.3dm',size:cadBytes.length,arrayBuffer:async()=>cadBytes.buffer});
await until(()=>state.revision>oldRevision&&state.solved,'Rhino planar curve source import');
assert.equal($('model-units').value,'mm');assert.equal($('model-up').value,'z');
close(Math.max(...state.rawModel.vertices.map(p=>p[0])),1200,'Rhino centimetres normalize to mm');
assert.match($('import-note').textContent,/planar surface/);
console.log('PASS native Rhino production download, 3DM planar source import, units and format help');

// Escape is also a neutral-state command outside a drag. No design or history
// change should be needed simply to leave a selected editing tool.
await openStudy(cornerStudy, 'Escape tool reset fixture');
escape(); assertNeutralTools('initial neutral Escape');
for (const [tool, field] of [['edit-toggle', 'edit'], ['corner-toggle', 'cornerMode'], ['multi-select', 'multiSelect'], ['split-cell', 'splitMode']]) {
  const before = currentDesign(), history = structuredClone(state.history), future = structuredClone(state.future);
  if (field === 'splitMode') clickSeed(0);
  clickControl(tool); assert.equal(state[field], true);
  if (field === 'cornerMode') {
    const corner = state.result.corners.find(item => !item.boundary), point = window.cellStudy.projectCorner(corner.id);
    pointer(canvas, 'pointerdown', point.x, point.y); pointer(canvas, 'pointerup', point.x, point.y);
    assert.equal(state.selectedCorner, corner.id);
  } else {
    clickSeed(0);
    if (field === 'multiSelect') { clickSeed(1); assert.equal(state.selectedIds.length, 2); }
    assert.ok(state.selectedIds.length);
  }
  escape(); assertNeutralTools(`neutral Escape from ${field}`);
  assert.deepEqual(currentDesign(), before, 'leaving a tool preserves the accepted arrangement');
  assert.deepEqual(state.history, history); assert.deepEqual(state.future, future);
}
console.log('PASS Escape clears selection and all editing modes without changing the design or history');

// Centre previews currently edit seed positions while a debounced fit may be
// running. Cancellation must restore both the source intent and derived views.
const { summarizeCalculation: summarizeRestoredCalculation } = await import(new URL('project-feedback.js', demo).href);
for (const phase of ['before debounce', 'in flight', 'after preview']) {
  await openStudy(cornerStudy, `centre cancellation ${phase}`);
  input('limit-stock-width', 100); input('limit-stock-height', 100); clickControl('apply-project-limits');
  assert.equal($('project-limit-list').children.length, state.cells.length, 'the fixture has visible project warnings before dragging');
  if (!state.edit) clickControl('edit-toggle');
  flush();
  const before = currentDesign(), beforeCells = structuredClone(state.cells), beforeResult = structuredClone(state.result);
  const resultReference = state.result, beforeCalculation = structuredClone(state.lastCalculation), beforeComparison = structuredClone(state.comparison);
  const beforeCalculationText = $('calculation-comparison').textContent, beforeLimitText = $('project-limit-list').textContent;
  const history = structuredClone(state.history), future = structuredClone(state.future);
  const camera = window.cellStudy.camera.position.toArray(), target = window.cellStudy.controls.target.toArray();
  const seed = state.seeds[0], screen = window.cellStudy.projectSeed(seed.id), heldCount = heldFitReplies.length;
  if (phase === 'in flight') holdNextFitReply = true;
  pointer(canvas, 'pointerdown', screen.x, screen.y);
  assert.equal(window.cellStudy.controls.enabled, false); assert.equal(canvas.hasPointerCapture(1), true);
  pointer(canvas, 'pointermove', screen.x + 12, screen.y + 6);
  assert.notDeepEqual(currentDesign().seeds, before.seeds, 'the test must move a real centre before cancellation');
  if (phase === 'in flight') await until(() => heldFitReplies.length > heldCount, 'hold centre-drag fitting result');
  if (phase === 'after preview') await until(() => state.result !== resultReference && state.solved && !state.busy && !state.pending, 'centre preview calculation completes before Escape');
  escape(); assertNeutralTools(`centre Escape ${phase}`);
  assert.deepEqual(currentDesign(), before, 'Escape immediately restores the accepted centre arrangement');
  const cancelledRequest = state.requested;
  pointer(canvas, 'pointerup', screen.x + 12, screen.y + 6);
  assertNeutralTools(`late centre pointerup ${phase}`);
  if (phase === 'in flight') {
    heldFitReplies[heldCount].deliver();
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(currentDesign(), before, 'the obsolete fit cannot briefly replace the restored source');
  }
  await until(() => state.solved && !state.busy && !state.pending, `settle cancelled centre ${phase}`);
  if (phase === 'before debounce') {
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(state.requested, cancelledRequest, 'the cancelled debounce cannot start another solve');
  }
  assert.deepEqual(currentDesign(), before);
  assert.deepEqual(state.cells, beforeCells, 'cancelled centre restores the fitted panels');
  assert.deepEqual(state.result, beforeResult, 'cancelled centre restores the complete solid/carving result');
  assert.deepEqual(state.lastCalculation, beforeCalculation, 'cancelled centre restores the accepted calculation evidence');
  assert.deepEqual(state.lastCalculation.summary, summarizeRestoredCalculation(state.result), 'saved calculation evidence matches the restored geometry');
  assert.deepEqual(state.comparison, beforeComparison, 'cancelled centre restores the previous calculation comparison');
  assert.equal($('calculation-comparison').textContent, beforeCalculationText, 'cancelled centre restores the comparison explanation');
  assert.equal($('project-limit-list').textContent, beforeLimitText, 'cancelled centre restores the accepted project warnings');
  assert.deepEqual(state.history, history, 'cancelled centre movement creates no undo entry');
  assert.deepEqual(state.future, future, 'cancelled centre movement preserves redo history');
  assert.deepEqual(window.cellStudy.camera.position.toArray(), camera);
  assert.deepEqual(window.cellStudy.controls.target.toArray(), target);
  assertNeutralTools(`settled centre cancellation ${phase}`);
}
console.log('PASS centre Escape rolls back previews, cancels debounce, rejects stale fitting, and ignores late pointerup');

// A corner edit must not force the designer to discard authored seams before
// moving a cell centre. Graph centre previews commit once, on release.
await openStudy(cornerStudy, 'mixed corner and centre editing');
if (!state.cornerMode) clickControl('corner-toggle');
const mixedCorner = state.result.corners.find(corner => !corner.boundary);
await edit(() => {
  const to = beginCornerDrag(mixedCorner, mixedCorner.position.map((x, k) => x + [20, 10, 0][k]));
  pointer(canvas, 'pointerup', to.x, to.y);
}, 'author a corner before centre movement');
const beforeGraphCentre = currentDesign(), graphCentreHistory = state.history.length;
clickControl('edit-toggle'); flush();
assert.equal(state.edit, true); assert.equal(state.cornerMode, false);
const graphCentreId = state.layout.cells[0].id;
function beginGraphCentreMove(dx = 8, dy = 4) {
  flush();
  const from = window.cellStudy.projectCellCentre(graphCentreId);
  assert.ok(from, 'authored cells expose a centre handle');
  pointer(canvas, 'pointerdown', from.x, from.y);
  assert.equal(window.cellStudy.controls.enabled, false);
  pointer(canvas, 'pointermove', from.x + dx, from.y + dy);
  return { x: from.x + dx, y: from.y + dy };
}
await edit(() => {
  const to = beginGraphCentreMove();
  assert.deepEqual(currentDesign(), beforeGraphCentre, 'centre preview does not alter the accepted graph');
  assert.equal($('save-study').disabled, true);
  pointer(canvas, 'pointerup', to.x, to.y);
}, 'centre movement after a corner edit');
const afterGraphCentre = currentDesign();
assert.notDeepEqual(afterGraphCentre.layout, beforeGraphCentre.layout);
assert.deepEqual(afterGraphCentre.seeds, beforeGraphCentre.seeds, 'generated seeds remain provenance');
assert.deepEqual(afterGraphCentre.layout.recipe, beforeGraphCentre.layout.recipe);
assert.deepEqual(afterGraphCentre.directBase, beforeGraphCentre.directBase);
assert.equal(afterGraphCentre.layout.cells.length, beforeGraphCentre.layout.cells.length);
assert.equal(state.history.length, graphCentreHistory + 1);
close(state.result.surfaceCells.reduce((sum, cell) => sum + cell.area, 0), 1200 * 1200, 'centre edit preserves source coverage');
await edit(() => key('z'), 'undo graph centre movement');
assert.deepEqual(currentDesign(), beforeGraphCentre);
await edit(() => key('z', { shiftKey: true }), 'redo graph centre movement');
assert.deepEqual(currentDesign(), afterGraphCentre);
const mixedSaved = await saveStudy();
await openStudy(mixedSaved, 'reopen mixed corner and centre edits');
assert.deepEqual(currentDesign(), afterGraphCentre);
if (!state.edit) clickControl('edit-toggle');
let graphTo = beginGraphCentreMove();
escape(); pointer(canvas, 'pointerup', graphTo.x, graphTo.y);
assertNeutralTools('Escape from graph centre preview');
assert.deepEqual(currentDesign(), afterGraphCentre);
clickControl('edit-toggle');
const heldGraphValidation = heldValidationReplies.length;
holdNextValidationReply = true;
graphTo = beginGraphCentreMove(); pointer(canvas, 'pointerup', graphTo.x, graphTo.y);
await until(() => heldValidationReplies.length > heldGraphValidation, 'hold graph centre validation');
escape(); heldValidationReplies[heldGraphValidation].deliver();
await Promise.resolve(); await Promise.resolve();
assertNeutralTools('Escape from pending graph centre move');
assert.deepEqual(currentDesign(), afterGraphCentre, 'late validation cannot apply a cancelled graph move');
console.log('PASS centre movement after corners preserves authored layout, undo/redo/save/reopen and Escape rollback');

// Offsets attach to stable panel identities. Even a previously seed-driven
// organic layout must use checked graph movement after an offset is authored.
await openStudy(stripStudy, 'offset organic centre movement fixture');
clickSeed(20);
await edit(() => { input('panel-offset', '10'); clickControl('apply-offset'); }, 'offset before organic centre move');
assert.deepEqual(state.panelOffsets, [{ id: 20, offsetMm: 10 }]);
assert.equal($('cell-weight').disabled, true, 'offsets disable redistribution that could remove their panel');
assert.match($('cell-weight-help').textContent, /offset/i);
document.querySelector('[data-view="surface"]').click();
clickControl('edit-toggle'); flush();
const offsetCentreLayout = structuredClone(state.layout), offsetCentreSeeds = structuredClone(state.seeds);
const offsetCentreHandle = window.cellStudy.projectCellCentre(20);
assert.ok(offsetCentreHandle, 'offset organic panel exposes a graph centre handle');
await edit(() => {
  pointer(canvas, 'pointerdown', offsetCentreHandle.x, offsetCentreHandle.y);
  pointer(canvas, 'pointermove', offsetCentreHandle.x + 8, offsetCentreHandle.y + 4);
  pointer(canvas, 'pointerup', offsetCentreHandle.x + 8, offsetCentreHandle.y + 4);
}, 'checked graph centre move with offset');
assert.notDeepEqual(state.layout, offsetCentreLayout);
assert.deepEqual(state.seeds, offsetCentreSeeds, 'graph movement preserves generator seeds and panel identities');
assert.deepEqual(state.panelOffsets, [{ id: 20, offsetMm: 10 }]);
assert.deepEqual(state.layout.cells.map(cell => cell.id), offsetCentreLayout.cells.map(cell => cell.id));
assert.equal($('save-study').disabled, false);
await edit(() => key('z'), 'undo offset graph centre move');
assert.deepEqual(state.layout, offsetCentreLayout);
assert.deepEqual(state.panelOffsets, [{ id: 20, offsetMm: 10 }]);
console.log('PASS offsets preserve organic panel identities through checked centre moves and Undo');

// An ordinary organic merge predates direct graph edits. It must expose one
// movable merged centre before any corner has been edited.
await openStudy(stripStudy, 'ordinary organic merge before centre movement');
if (!state.edit) clickControl('edit-toggle');
clickSeed(10); clickSeed(20, { shiftKey: true });
await edit(() => clickControl('merge-cells'), 'ordinary organic merge for centre movement');
assert.equal(state.directBase, null); assert.deepEqual(state.cornerEdits, []);
assert.equal(state.mergeGroups.length, 1);
const legacyMergedId = state.mergeGroups[0].id, beforeMergedCentre = currentDesign(), mergedCentreHistory = state.history.length;
flush();
const mergedCentreScreen = window.cellStudy.projectCellCentre(legacyMergedId);
assert.ok(mergedCentreScreen, 'an ordinary merged cell exposes its authored centre');
await edit(() => {
  pointer(canvas, 'pointerdown', mergedCentreScreen.x, mergedCentreScreen.y);
  assert.equal(window.cellStudy.controls.enabled, false, 'grab the merged handle rather than orbiting');
  pointer(canvas, 'pointermove', mergedCentreScreen.x + 8, mergedCentreScreen.y + 4);
  assert.deepEqual(currentDesign(), beforeMergedCentre, 'merged centre preview retains the accepted layout');
  pointer(canvas, 'pointerup', mergedCentreScreen.x + 8, mergedCentreScreen.y + 4);
}, 'move a merged cell centre without prior corner edits');
const afterMergedCentre = currentDesign();
assert.notDeepEqual(afterMergedCentre.layout, beforeMergedCentre.layout);
assert.deepEqual(afterMergedCentre.directBase, beforeMergedCentre.layout);
assert.deepEqual(afterMergedCentre.mergeGroups, beforeMergedCentre.mergeGroups);
assert.deepEqual(afterMergedCentre.seeds, beforeMergedCentre.seeds);
assert.deepEqual(afterMergedCentre.layout.recipe, beforeMergedCentre.layout.recipe);
assert.deepEqual(state.layout.cells.find(cell => cell.id === legacyMergedId).memberSeedIds, [10, 20]);
assert.equal(state.layout.cells.length, 3); assert.equal(state.history.length, mergedCentreHistory + 1);
close(state.result.surfaceCells.reduce((sum, cell) => sum + cell.area, 0), 3200 * 800, 'merged centre move preserves source coverage');
await edit(() => key('z'), 'undo merged centre movement');
assert.deepEqual(currentDesign(), beforeMergedCentre);
await edit(() => key('z', { shiftKey: true }), 'redo merged centre movement');
assert.deepEqual(currentDesign(), afterMergedCentre);
const mergedCentreSave = await saveStudy();
await openStudy(mergedCentreSave, 'reopen merged centre movement');
assert.deepEqual(currentDesign(), afterMergedCentre);
console.log('PASS ordinary organic merge exposes an editable centre and preserves merged provenance, undo/redo and saved geometry');

// Dividing is an explicit source edit; dragging is only a preview until release.
await openStudy(cornerStudy, 'divider fixture');
escape();
assert.equal($('split-cell').disabled, true, 'division requires one selected cell');
let splitPoint = projectWorld([250,300,0]);
pointer(canvas,'pointerdown',splitPoint.x,splitPoint.y); pointer(canvas,'pointerup',splitPoint.x,splitPoint.y);
assert.equal(state.selected,0); assert.equal($('split-cell').disabled,false);
clickControl('split-cell');
assert.equal(state.splitMode,true); assert.equal(state.edit,false); assert.equal(state.cornerMode,false);
const beforeSplit = currentDesign(), beforeSplitHistory = state.history.length, reservedSplitId = state.nextCellId;
function beginSplit() {
  const from = projectWorld([250,200,0]), to = projectWorld([250,450,0]);
  pointer(canvas,'pointerdown',from.x,from.y);
  assert.equal(window.cellStudy.controls.enabled,false,'divider captures the selected source cell');
  pointer(canvas,'pointermove',to.x,to.y);
  return to;
}
let splitTo = beginSplit();
assert.deepEqual(currentDesign(),beforeSplit,'divider preview never changes source geometry');
escape(); pointer(canvas,'pointerup',splitTo.x,splitTo.y);
assertNeutralTools('divider preview cancellation'); assert.deepEqual(currentDesign(),beforeSplit);
pointer(canvas,'pointerdown',splitPoint.x,splitPoint.y); pointer(canvas,'pointerup',splitPoint.x,splitPoint.y);
clickControl('split-cell');
const splitFitIndex = heldFitReplies.length, splitFitRevision = state.revision;
holdNextFitReply = true;
splitTo=beginSplit();pointer(canvas,'pointerup',splitTo.x,splitTo.y);
await until(() => heldFitReplies.length > splitFitIndex && !!state.sourceSurface, 'accepted division before fitted reply');
assert.equal(state.cells.some(cell => cell.id === reservedSplitId), false, 'the new source child has no old fitted counterpart');
const sourceChild = state.sourceSurface.cells.find(cell => cell.id === reservedSplitId);
assert.ok(sourceChild, 'accepted source contains the new child while fitting waits');
clickControl('split-cell'); // Leave the drawing gesture before selecting parts.
clickControl('clear-selection');
const childTriangle = sourceChild.triangles[0];
const sourceChildPoint = projectWorld([0, 1, 2].map(axis => childTriangle.reduce((sum, id) => sum + sourceChild.positions[id][axis] / 3, 0)));
pointer(canvas, 'pointerdown', sourceChildPoint.x, sourceChildPoint.y);
pointer(canvas, 'pointerup', sourceChildPoint.x, sourceChildPoint.y);
assert.equal(state.selected, reservedSplitId, 'a newly divided source panel can be selected before fitting completes');
assert.match($('selected-note').textContent, /accepted.*updating/i);
heldFitReplies[splitFitIndex].deliver();
await until(() => state.revision > splitFitRevision && state.solved, 'fit divided cells after source selection');
assert.equal(state.cells.length,4); assert.equal(state.selected,reservedSplitId);
assert.equal(state.layout.version,3); assert.equal(state.layout.splitOrigins.length,1);
assert.deepEqual(state.seeds,beforeSplit.seeds); assert.deepEqual(state.layout.recipe,beforeSplit.layout.recipe);
assert.equal(state.history.length,beforeSplitHistory+1);
close(state.result.surfaceCells.reduce((sum,cell)=>sum+cell.area,0),1200*1200,'split preserves source coverage');
const afterSplit=currentDesign(), afterSplitNextId=state.nextCellId;
await edit(()=>key('z'),'undo division'); assert.deepEqual(currentDesign(),beforeSplit); assert.equal(state.nextCellId,afterSplitNextId,'undo cannot reuse a reserved panel ID');
await edit(()=>key('z',{shiftKey:true}),'redo division'); assert.deepEqual(currentDesign(),afterSplit);
const splitSaved=await saveStudy(); await openStudy(splitSaved,'reopen split graph');
assert.deepEqual(currentDesign(),afterSplit); assert.equal(state.nextCellId,afterSplitNextId);
// A reply arriving after Escape must not add the reserved child.
escape(); splitPoint=projectWorld([100,300,0]); pointer(canvas,'pointerdown',splitPoint.x,splitPoint.y); pointer(canvas,'pointerup',splitPoint.x,splitPoint.y);
// Split the other side horizontally to avoid drawing the existing seam again.
clickControl('split-cell');
const pendingBefore=currentDesign(), heldSplitIndex=heldValidationReplies.length;
holdNextValidationReply=true;
const pendingFrom=projectWorld([100,220,0]),pendingTo=projectWorld([200,220,0]);
pointer(canvas,'pointerdown',pendingFrom.x,pendingFrom.y);pointer(canvas,'pointermove',pendingTo.x,pendingTo.y);pointer(canvas,'pointerup',pendingTo.x,pendingTo.y);
await until(()=>heldValidationReplies.length>heldSplitIndex,'held divider validation');
escape();heldValidationReplies[heldSplitIndex].deliver();await Promise.resolve();await Promise.resolve();
assertNeutralTools('pending divider cancellation');assert.deepEqual(currentDesign(),pendingBefore);
assert.ok(state.nextCellId>afterSplitNextId,'cancelled validation retires the reserved ID');
console.log('PASS divider preview, source preservation, undo/redo, ID retirement, save/reopen and cancelled stale replies');

// Across bend uses actual worker validation for preview and Apply. Its draft
// must never mutate the accepted layout, reserve IDs or leave hidden faces.
const {rebuildSurfaceCells:rebuildBendSource}=await import(new URL('geometry.js',demo).href);
const {captureLayout:captureBendLayout,layoutRecipe:bendRecipe}=await import(new URL('layout.js',demo).href);
const bendVertices=[],bendTriangles=[],bendOwners=[],bendXs=[-400,-200,0,200,400];
for(let y=0;y<=4;y++)for(const x of bendXs)bendVertices.push([x,y*250,Math.abs(x)*.6]);
for(let y=0;y<4;y++)for(let x=0;x<4;x++){
  const a=y*5+x;bendTriangles.push([a,a+1,a+6],[a,a+6,a+5]);bendOwners.push(x<2?0:1,x<2?0:1);
}
const bendModel={vertices:bendVertices,triangles:bendTriangles};
const bendSeeds=[{id:0,position:[-200,500,120],weight:1},{id:1,position:[200,500,120],weight:1}];
const bendBuilders=bendSeeds.map(seed=>{
  const faces=bendTriangles.filter((_,i)=>bendOwners[i]===seed.id),indices=[...new Set(faces.flat())];
  return{id:seed.id,seed:seed.position,weight:1,memberSeedIds:[seed.id],positions:indices.map(index=>bendVertices[index]),triangles:faces.map(face=>face.map(index=>indices.indexOf(index)))};
});
const bendLayout=captureBendLayout(bendModel,rebuildBendSource(bendModel,bendBuilders),{recipe:bendRecipe({seeds:bendSeeds,size:500,randomSeed:7,variation:.3})});
const bendStudy=createStudy({rawModel:bendModel,seeds:bendSeeds,layout:bendLayout,size:500,randomSeed:7,variation:.3,thickness:10,roundover:0,
  panelOffsets:[{id:0,offsetMm:10},{id:1,offsetMm:-5}],name:'public-across-bend-fixture',view:'surface'},
  {units:'mm',up:'z',camera:[900,-1500,1800],target:[0,500,60]});
await openStudy(bendStudy,'Across bend fixture');escape();
const beforeBend=currentDesign(),beforeBendProject=structuredClone(state.project),beforeBendOffsets=structuredClone(state.panelOffsets),beforeBendId=state.nextCellId;
function chooseBend(){
  if(!state.acrossBendMode)clickControl('across-bend-toggle');
  const point=projectWorld([0,500,0]);pointer(canvas,'pointerdown',point.x,point.y);pointer(canvas,'pointerup',point.x,point.y);
  assert.deepEqual(state.acrossBendSelection?.cellIds,[0,1],'seam click selects its two source cells');
}
async function readyBend(width=100){chooseBend();input('across-bend-width',width);await until(()=>state.acrossBendPreview?.widthMm===width&&state.acrossBendPreview.fitState==='ready','source and fitted Across bend preview');}
await readyBend();
assert.deepEqual(currentDesign(),beforeBend);assert.deepEqual(state.project,beforeBendProject);assert.equal(state.nextCellId,beforeBendId);
assert.equal(state.acrossBendPreview.fittedCell.valid,true);assert.equal(state.acrossBendPreview.fittedTrimmedCells.length,2);
assert.equal($('apply-across-bend').disabled,false);assert.match($('across-bend-status').textContent,/Fitted preview ready/);
const hiddenBendFaces=()=>globalThis.__uiRenderers[0].scene.children.flatMap(group=>group.children||[]).filter(object=>object.userData.acrossBendHidden);
assert.ok(hiddenBendFaces().length>0,'preview replaces the original pair with candidate geometry');
input('across-bend-width',2000);await until(()=>!state.acrossBendPreviewBusy&&/Reduce|reduce|width/i.test($('across-bend-status').textContent),'excessive bridge width is explained');
assert.equal(state.acrossBendPreview,null);assert.equal($('apply-across-bend').disabled,true);assert.equal(hiddenBendFaces().length,0);
input('across-bend-width',0);assert.match($('across-bend-status').textContent,/positive total width/);
assert.deepEqual(currentDesign(),beforeBend);assert.equal(state.nextCellId,beforeBendId);

const previewFitIndex=heldFitReplies.length;holdNextFitReply=true;input('across-bend-width',100);
await until(()=>heldFitReplies.length>previewFitIndex,'hold fitted Across bend preview');
assert.equal(state.acrossBendPreview.fitState,'pending');assert.equal($('apply-across-bend').disabled,false,'a validated source remains applicable while fitting is pending');
escape();assertNeutralTools('Escape from Across bend fitted preview');heldFitReplies[previewFitIndex].deliver();await Promise.resolve();await Promise.resolve();
assert.equal(state.acrossBendPreview,null);assert.equal(hiddenBendFaces().length,0);assert.deepEqual(currentDesign(),beforeBend);

clickControl('across-bend-toggle');const previewSourceIndex=heldValidationReplies.length;holdNextValidationReply=true;chooseBend();
await until(()=>heldValidationReplies.length>previewSourceIndex,'hold source Across bend preview');
input('across-bend-width',120);heldValidationReplies[previewSourceIndex].deliver();
await until(()=>state.acrossBendPreview?.widthMm===120&&state.acrossBendPreview.fitState==='ready','newer bridge width supersedes a stale preview');
assert.deepEqual(currentDesign(),beforeBend);assert.equal(state.nextCellId,beforeBendId);
clickControl('cancel-across-bend');assert.equal(state.acrossBendMode,false);assert.equal(hiddenBendFaces().length,0);

escape();clickSeed(0);clickSeed(1,{shiftKey:true});clickControl('across-bend-toggle');
assert.deepEqual(state.acrossBendSelection.cellIds,[0,1],'two adjacent selected cells preselect their seam');
input('across-bend-width',100);await until(()=>state.acrossBendPreview?.fitState==='ready','preselected bridge preview');
const pendingBridgeIndex=heldValidationReplies.length,historyBeforeBridge=state.history.length;holdNextValidationReply=true;clickControl('apply-across-bend');
await until(()=>heldValidationReplies.length>pendingBridgeIndex,'hold Across bend Apply validation');
assert.equal(state.nextCellId,beforeBendId+1,'Apply reserves one new identity');
escape();heldValidationReplies[pendingBridgeIndex].deliver();await Promise.resolve();await Promise.resolve();
assertNeutralTools('Escape from Across bend Apply');assert.deepEqual(currentDesign(),beforeBend);assert.equal(state.history.length,historyBeforeBridge);
assert.equal(state.nextCellId,beforeBendId+1,'cancelled Apply never reuses its reserved identity');

await readyBend();const appliedBendId=state.nextCellId;
await edit(()=>clickControl('apply-across-bend'),'apply Across bend');
assert.equal(state.acrossBendMode,false);assert.equal(state.layout.cells.length,3);assert.deepEqual(state.layout.cells.map(cell=>cell.id),[0,1,appliedBendId]);
assert.equal(state.selected,appliedBendId);assert.deepEqual(state.rawModel,bendModel);assert.deepEqual(state.panelOffsets,[]);
assert.deepEqual(state.latestAcceptedEdit.cellIds,[0,1]);assert.equal(state.latestAcceptedEdit.newCellId,appliedBendId);
assert.ok(state.result.stats.coverageError<1e-10);assert.equal(state.cells.find(cell=>cell.id===appliedBendId).valid,true);
const acceptedBend=currentDesign(),acceptedBendId=state.nextCellId;
await edit(()=>key('z'),'undo Across bend');assert.deepEqual(currentDesign(),beforeBend);assert.deepEqual(state.panelOffsets,beforeBendOffsets);assert.equal(state.nextCellId,acceptedBendId);
await edit(()=>key('z',{shiftKey:true}),'redo Across bend');assert.deepEqual(currentDesign(),acceptedBend);assert.deepEqual(state.panelOffsets,[]);
const savedBend=await saveStudy();await openStudy(savedBend,'reopen Across bend source graph');assert.deepEqual(currentDesign(),acceptedBend);assert.equal(state.nextCellId,acceptedBendId);

const lockedBend=createStudy({...bendStudy,protectedCellIds:[0]},{units:'mm',up:'z'});
await openStudy(lockedBend,'locked Across bend fixture');const lockedBendBefore=currentDesign(),lockedBendCounter=state.nextCellId;
chooseBend();assert.match($('across-bend-status').textContent,/locked|Unlock/);assert.equal($('apply-across-bend').disabled,true);
assert.deepEqual(currentDesign(),lockedBendBefore);assert.equal(state.nextCellId,lockedBendCounter);clickControl('cancel-across-bend');
await openStudy(bendStudy,'Across bend replacement race');clickControl('across-bend-toggle');
const replacementPreviewIndex=heldValidationReplies.length;holdNextValidationReply=true;chooseBend();
await until(()=>heldValidationReplies.length>replacementPreviewIndex,'hold preview before document replacement');
await openStudy(splitSaved,'replace document during Across bend preview');const afterBendReplacement=preservedDocument();
heldValidationReplies[replacementPreviewIndex].deliver();await Promise.resolve();await Promise.resolve();
assert.equal(state.acrossBendMode,false);assert.equal(state.acrossBendPreview,null);assert.deepEqual(preservedDocument(),afterBendReplacement);
console.log('PASS Across bend source/fitted previews, rejected widths, stale replies, Cancel/Escape, reserved IDs, locks, offsets, Undo and study restoration');

// Laser preparation is asynchronous and invalidated by later design/settings edits.
clickControl('open-laser');assert.equal($('laser-dialog').open,true);
clickControl('laser-coupon');assert.equal($('laser-download').disabled,false);
let beforeLaserDownloads=downloads.length;
clickControl('laser-download');assert.equal(downloads.length,beforeLaserDownloads+1);
let laserSVG=await downloads.at(-1).blob.text();
assert.match(laserSVG,/width="400mm"/);assert.match(laserSVG,/GROOVE_BANDS/);assert.match(laserSVG,/data-label="50 MM"/);
clickControl('laser-build');await until(()=>!$('laser-download').disabled,'laser model sheet preparation');
assert.match($('laser-status').textContent,/4 panels/);
clickControl('laser-download');laserSVG=await downloads.at(-1).blob.text();
assert.match(laserSVG,/<svg/);assert.match(laserSVG,/CUT/);
assert.equal($('laser-side').querySelector('[value="back"]').disabled,true,'planar grid needs no back engraving');
$('laser-front-guides').checked=true;$('laser-front-guides').dispatchEvent(new Event('input',{bubbles:true}));
assert.equal($('laser-download').disabled,true,'front hinge option invalidates SVG');
clickControl('laser-build');await until(()=>!$('laser-download').disabled,'all hinge guides preparation');
clickControl('laser-download');laserSVG=await downloads.at(-1).blob.text();
const guideMetadata=JSON.parse(new window.DOMParser().parseFromString(laserSVG,'image/svg+xml').querySelector('metadata').textContent);
assert.equal(guideMetadata.frontFoldGuides,true,'download records the explicit front-guide setting');
input('laser-scale','12');assert.equal($('laser-download').disabled,true,'changed scale invalidates SVG');
clickControl('laser-build');await until(()=>!$('laser-download').disabled,'laser changed scale preparation');
clickControl('close-laser');assert.equal($('laser-dialog').open,false);
await edit(()=>{input('thickness','41');input('thickness','41','change');},'stock update after laser preview');
assert.equal($('laser-download').disabled,true,'changed source invalidates prepared sheets');
console.log('PASS laser coupon, model sheet preparation, front/back SVG download, settings and source invalidation');

// Durable document behavior is independent of downstream fitting success.
function leavingWarns() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
await openStudy(splitSaved, 'durable split fixture');
clickSeed(state.cells[0].id);
assert.equal(leavingWarns(), false, 'opened downloaded source needs no close warning');
const durableId = state.project.id, durableRevision = state.project.revision, durableLayout = structuredClone(state.layout);
failNextFitReply = true;
input('thickness', '47'); input('thickness', '47', 'change');
await until(() => !failNextFitReply && !state.busy && !state.pending, 'synthetic fitting failure');
assert.equal(state.solved, false);
assert.match($('offset-status').textContent, /calculation did not finish.*changing or resetting.*save this study/s);
assert.doesNotMatch($('offset-status').textContent, /Checking the panels/, 'terminal failure must not look like a running calculation');
assert.equal($('save-study').disabled, false, 'failed fitting cannot prevent source saving');
assert.equal($('export-rhino').disabled, true, 'failure still blocks production export');
const failedFitSave = await saveStudy();
assert.equal(failedFitSave.project.id, durableId);
assert.ok(failedFitSave.project.revision > durableRevision);
assert.equal(failedFitSave.thickness, 47);
assert.deepEqual(failedFitSave.layout, durableLayout);
assert.ok(failedFitSave.lastCalculation.revision < failedFitSave.project.revision);
await until(() => [...recoveryRecords.values()].some(record => record.projectId === durableId && record.revision === failedFitSave.project.revision), 'recovery stores source despite failed fit');

// A failed first fit has no selectable meshes. The global reset must still
// let a designer recover an opened offset project without editing its JSON.
const failedOpeningOffsetStudy = structuredClone(failedFitSave);
failedOpeningOffsetStudy.name = 'offset-opening-fit-failure';
failedOpeningOffsetStudy.panelOffsets = [{ id: failedOpeningOffsetStudy.layout.cells[0].id, offsetMm: 10 }];
failedOpeningOffsetStudy.requiredFeatures.push('panel-offsets-v1');
const failedOpeningText = JSON.stringify(failedOpeningOffsetStudy);
failNextFitReply = true;
loadFile('study-file', { name: 'offset-opening-fit-failure.json', size: failedOpeningText.length, text: async () => failedOpeningText });
await until(() => state.name === failedOpeningOffsetStudy.name && !failNextFitReply && !state.busy && !state.pending, 'offset study opens despite failed first fit');
assert.equal(state.solved, false); assert.equal(state.ready, false);
assert.equal(state.cells.length, 0); assert.equal(state.selected, null);
assert.equal($('save-study').disabled, false, 'accepted offset document can be saved with no fitted meshes');
assert.equal($('reset-all-offsets').hidden, false);
assert.equal($('reset-all-offsets').disabled, false);
assert.equal($('reset-all-offsets').closest('#selection-details'), null, 'global reset is outside selection-dependent content');
const reopenedFailedOffsets = await saveStudy();
assert.deepEqual(reopenedFailedOffsets.panelOffsets, failedOpeningOffsetStudy.panelOffsets);
await edit(() => clickControl('reset-all-offsets'), 'clear offsets without a fitted selection');
assert.deepEqual(state.panelOffsets, []);
assert.ok(state.cells.length > 0); assert.equal(state.ready, true);
assert.deepEqual(state.layout, durableLayout, 'reset keeps the accepted source layout');
console.log('PASS terminal fitting feedback and resetting an opened offset study without fitted panels');

// An imported mesh can fail before it has any source-cell layout to save.
// That terminal failure must not trap the designer in the failed document.
async function failInitialMeshImport(name) {
  failNextFitReply = true;
  loadFile('mesh-file', { name: `${name}.obj`, size: obj.length, text: async () => obj });
  await until(() => state.name === name && !failNextFitReply && !state.busy && !state.pending, 'initial mesh tessellation fails before producing a layout');
  assert.equal(state.layout, null); assert.equal(state.ready, false); assert.equal(state.solved, false);
  assert.equal(state.cells.length, 0); assert.equal($('save-study').disabled, true);
  assert.match($('status').textContent, /no cells could be created|no cell layout/i);
}
await failInitialMeshImport('untouched-initial-tessellation-failure');
const untouchedFailedProject = state.project.id;
$('example-select').value = DEFAULT_EXAMPLE_ID; clickControl('load-example');
await until(() => state.project.id !== untouchedFailedProject && state.solved, 'replace untouched failed import with another example');
assert.ok(state.cells.length > 0, 'the replacement example creates its panels');

await failInitialMeshImport('edited-initial-tessellation-failure');
failNextFitReply = true;
input('thickness', state.thickness + 5); input('thickness', state.thickness, 'change');
await until(() => !failNextFitReply && !state.busy && !state.pending, 'material edit also fails to create the first layout');
assert.equal(state.layout, null); assert.ok(state.history.length > 0); assert.ok(state.project.revision > 1);
const editedFailedDesign = currentDesign(), editedFailedProject = structuredClone(state.project), editedFailedHistory = structuredClone(state.history);
const originalConfirm = window.confirm, failureConfirmations = [];
try {
  window.confirm = message => { failureConfirmations.push(message); return false; };
  $('example-select').value = DEFAULT_EXAMPLE_ID; clickControl('load-example');
  await until(() => failureConfirmations.length === 1, 'ask before discarding settings on a failed initial import');
  await Promise.resolve(); await Promise.resolve();
  assert.match(failureConfirmations[0], /no cell layout.*discard.*settings/is);
  assert.deepEqual(currentDesign(), editedFailedDesign, 'cancelling replacement keeps every changed setting');
  assert.deepEqual(state.project, editedFailedProject); assert.deepEqual(state.history, editedFailedHistory);
  assert.equal(state.name, 'edited-initial-tessellation-failure');
  assert.match($('status').textContent, /kept/i);
  window.confirm = message => { failureConfirmations.push(message); return true; };
  clickControl('load-example');
  await until(() => state.project.id !== editedFailedProject.id && state.solved, 'confirmed replacement escapes failed initial import');
  assert.equal(failureConfirmations.length, 2); assert.ok(state.cells.length > 0);
} finally { window.confirm = originalConfirm; }
console.log('PASS terminal initial mesh failure permits replacement and protects edited settings with cancel/confirm');

await openStudy(failedFitSave, 'reopen source after fitting failure');
assert.equal(state.solved, true);
assert.deepEqual(state.layout, durableLayout);
assert.equal(state.project.id, durableId);
assert.match($('calculation-comparison').textContent, /Saved calculation r/);
const revisionBeforeStock = state.project.revision;
input('thickness', '49');
assert.equal(leavingWarns(), true, 'uncommitted settings warn before they become a new accepted revision');
await until(() => state.solved && !state.busy && !state.pending, 'fit completes before stock gesture ends');
await new Promise(resolve => setTimeout(resolve, 800));
assert.equal(state.project.revision, revisionBeforeStock, 'uncommitted settings do not advance the accepted revision');
assert.equal([...recoveryTexts.values()].map(text => JSON.parse(text)).some(study => study.project.id === durableId && study.project.revision === revisionBeforeStock && study.thickness === 49), false,
  'uncommitted settings cannot be recovered under the old revision');
input('thickness', '49', 'change');
assert.equal(state.project.revision, revisionBeforeStock + 1);
await until(() => [...recoveryTexts.values()].map(text => JSON.parse(text)).some(study => study.project.id === durableId && study.project.revision === state.project.revision && study.thickness === 49), 'committed settings receive current recovery revision');
assert.equal(leavingWarns(), true, 'successful local saving does not suppress the portable-backup warning');
assert.equal(state.lastCalculation.revision, state.project.revision);
const revisionBeforeUndo = state.project.revision;
await edit(() => key('z'), 'durable undo revision');
assert.equal(state.project.revision, revisionBeforeUndo + 1, 'undo advances identity rather than restoring older revision');
await edit(() => key('z', { shiftKey: true }), 'durable redo revision');
assert.equal(state.project.revision, revisionBeforeUndo + 2);
clickControl('download-feedback');
const feedback = JSON.parse(await downloads.at(-1).blob.text());
assert.equal(feedback.format, 'panel-workbench-diagnostic');
assert.equal(feedback.project.revision, state.project.revision);
assert.equal(feedback.settings.units, 'mm');
assert.equal(feedback.settings.up, state.documentUp);
assert.equal(JSON.stringify(feedback).includes(state.name), false);
assert.equal(feedback.privacy.includesGeometry, false);
assert.equal(feedback.calculation.panelCount, state.cells.length);
$('show-fitting').checked = true; $('show-fitting').dispatchEvent(new Event('change', { bubbles: true }));
flush();
const fitLines = globalThis.__uiRenderers[0].scene.children.flatMap(group => group.children || []).filter(object => object.renderOrder === 10);
assert.equal(fitLines.length, 3, 'source outline, fitted outline and displacement connectors are visible');
assert.ok(fitLines.every(line => line.geometry.attributes.position.count > 0));
const guardedProject = structuredClone(state.project);
await rejectStudyWithoutMutation({ ...failedFitSave, version: 7 }, 'reject unsupported future project');
assert.deepEqual(state.project, guardedProject, 'future format rejection preserves current project identity');
console.log('PASS durable revisions, saving/recovery through fitting failure, pending settings isolation, close warning, reopen comparison, fitting overlay and private diagnostic report');

// Recovery validation is asynchronous. A slider begun after that validation
// starts must get a protective checkpoint before the older copy replaces it.
await until(() => [...recoveryRecords.values()].some(record => record.projectId === state.project.id && record.revision === state.project.revision), 'latest source saved before manual recovery race');
const recoveryRows = [...recoveryRecords.values()].sort((a, b) => b.sequence - a.sequence);
const restoreRow = recoveryRows.findIndex(record => record.projectId === state.project.id);
const restoreDocument = JSON.parse(recoveryTexts.get(recoveryRows[restoreRow].id));
clickControl('recovery-open');
await until(() => $('recovery-list').querySelectorAll('.recovery-entry').length === recoveryRows.length, 'recovery list refreshed');
const heldRecoveryIndex = heldValidationReplies.length;
holdNextValidationReply = true;
$('recovery-list').querySelectorAll('.recovery-entry')[restoreRow].querySelector('button').click();
await until(() => heldValidationReplies.length > heldRecoveryIndex, 'manual recovery validation held');
clickControl('recovery-close');
const replacementRevision = state.project.revision;
input('thickness', '52');
heldValidationReplies[heldRecoveryIndex].deliver();
await until(() => state.project.revision === restoreDocument.project.revision && state.thickness === restoreDocument.thickness && state.solved && !state.busy && !state.pending, 'manual recovery installed after checkpoint');
assert.ok([...recoveryTexts.values()].map(text => JSON.parse(text)).some(study => study.project.id === restoreDocument.project.id && study.project.revision === replacementRevision + 1 && study.thickness === 52),
  'an edit begun during recovery validation remains in its protective recovery copy');
console.log('PASS manual recovery protects edits begun during asynchronous source validation');

// Named checkpoint Restore must abandon a stale validation when a material
// gesture begins after it starts. A gesture can also return to its initial
// value without ending: captureDesign then matches, but the draft is still live.
clickControl('open-checkpoints');
input('checkpoint-name', 'Before asynchronous material trial');
clickControl('save-checkpoint');
const materialCheckpoint = state.checkpoints.at(-1);
assert.equal(materialCheckpoint.name, 'Before asynchronous material trial');
clickControl('close-checkpoints');
const checkpointThickness = state.thickness;
await edit(() => { input('thickness', checkpointThickness + 1); input('thickness', checkpointThickness + 1, 'change'); }, 'material differs from named checkpoint');
for (const returnToInitialValue of [false, true]) {
  clickControl('open-checkpoints');
  const heldIndex = heldValidationReplies.length;
  holdNextValidationReply = true;
  const row = $('checkpoint-list').querySelector(`[data-checkpoint-id="${materialCheckpoint.id}"]`);
  [...row.querySelectorAll('button')].find(button => button.textContent === 'Restore').click();
  await until(() => heldValidationReplies.length > heldIndex, 'hold named checkpoint restore validation');
  clickControl('close-checkpoints');
  const beforeGesture = currentDesign(), projectBeforeGesture = structuredClone(state.project), historyBeforeGesture = state.history.length;
  const checkpointsBeforeGesture = structuredClone(state.checkpoints), counterBeforeGesture = state.nextCellId;
  input('thickness', beforeGesture.thickness + 6);
  if (returnToInitialValue) input('thickness', beforeGesture.thickness);
  const pendingDesign = currentDesign();
  assert.equal(state.project.revision, projectBeforeGesture.revision, 'the gesture is still an uncommitted draft');
  heldValidationReplies[heldIndex].deliver();
  await until(() => /current design changed while checking/i.test($('checkpoint-status').textContent), 'stale checkpoint restore explains why it was not applied');
  await until(() => state.solved && !state.busy && !state.pending, 'material preview fits after rejected checkpoint restore');
  assert.deepEqual(currentDesign(), pendingDesign, 'late restore cannot replace an in-progress material draft');
  assert.deepEqual(state.project, projectBeforeGesture, 'rejected restore does not create a revision');
  assert.equal(state.history.length, historyBeforeGesture, 'rejected restore does not create an Undo entry');
  assert.equal(Number($('thickness').value), pendingDesign.thickness, 'the material control keeps the newer draft');
  assert.deepEqual(state.checkpoints, checkpointsBeforeGesture, 'the named checkpoints remain available');
  assert.equal(state.nextCellId, counterBeforeGesture, 'rejected restore preserves the cell ID counter');
  input('thickness', pendingDesign.thickness, 'change');
  assert.equal(state.project.revision, projectBeforeGesture.revision + (returnToInitialValue ? 0 : 1), 'only a completed changed gesture creates a revision');
}
console.log('PASS checkpoint restore rejects newer material drafts, including unfinished gestures returned to their original value');

// A comparison can finish after the designer has started another interaction.
// Only the initial Compare action chooses Flat view and assembled placement.
// Its late worker response must leave later gestures and display choices alone.
await openStudy(cornerStudy, 'checkpoint comparison race fixture');
clickControl('open-checkpoints');
input('checkpoint-name', 'Before corner comparison'); clickControl('save-checkpoint');
const comparisonCheckpoint = state.checkpoints.at(-1);
clickControl('close-checkpoints');
async function heldCheckpointComparison() {
  clickControl('open-checkpoints');
  const index = heldFitReplies.length; holdNextFitReply = true;
  const row = $('checkpoint-list').querySelector(`[data-checkpoint-id="${comparisonCheckpoint.id}"]`);
  [...row.querySelectorAll('button')].find(button => button.textContent === 'Compare').click();
  await until(() => heldFitReplies.length > index, 'hold checkpoint comparison result');
  assert.equal(state.view, 'flat'); assert.equal(state.explode, 0);
  return heldFitReplies[index];
}
for (const phase of ['drag', 'validation']) {
  const reply = await heldCheckpointComparison();
  clickControl('corner-toggle'); document.querySelector('[data-view="surface"]').click();
  const before = currentDesign(), projectBefore = structuredClone(state.project), historyBefore = state.history.length;
  const corner = state.result.corners.find(corner => !corner.boundary && corner.cells.length >= 3);
  const point = beginCornerDrag(corner, corner.position.map((value, axis) => value + [18, 12, 0][axis]));
  let sourceReply;
  if (phase === 'validation') {
    const index = heldValidationReplies.length; holdNextValidationReply = true;
    pointer(canvas, 'pointerup', point.x, point.y);
    await until(() => heldValidationReplies.length > index, 'hold newer corner validation while comparing');
    sourceReply = heldValidationReplies[index];
  }
  const guidance = $('status').textContent;
  reply.deliver();
  await until(() => state.checkpointComparison?.id === comparisonCheckpoint.id, `comparison finishes during corner ${phase}`);
  assert.equal(state.view, 'surface', 'comparison completion keeps the newly chosen view');
  assert.equal(state.cornerMode, true, 'comparison completion keeps the current editing tool');
  assert.equal($('status').textContent, guidance, 'comparison completion preserves the active edit guidance');
  assert.deepEqual(currentDesign(), before, 'comparison completion cannot apply or discard the source candidate');
  assert.deepEqual(state.project, projectBefore); assert.equal(state.history.length, historyBefore);
  if (phase === 'drag') {
    assert.equal(window.cellStudy.controls.enabled, false, 'comparison keeps the active pointer capture');
    assert.equal(canvas.hasPointerCapture(1), true);
    pointer(canvas, 'pointerup', point.x, point.y);
  } else {
    assert.equal($('save-study').disabled, true, 'comparison keeps pending corner validation guarded');
    sourceReply.deliver();
  }
  await until(() => state.project.revision > projectBefore.revision && state.solved && !state.busy && !state.pending, `newer corner ${phase} still commits after comparison completion`);
  assert.notDeepEqual(state.layout, before.layout, 'the newer corner move was accepted');
  clickControl('end-checkpoint-comparison');
  await edit(() => key('z'), 'undo the comparison race corner move');
}
const viewReply = await heldCheckpointComparison(), viewRevision = state.project.revision;
document.querySelector('[data-view="solid"]').click(); input('explode', 35); input('explode', 35, 'change');
viewReply.deliver();
await until(() => state.checkpointComparison?.id === comparisonCheckpoint.id, 'comparison finishes after newer presentation choices');
assert.equal(state.view, 'solid', 'comparison completion does not choose Flat view a second time');
assert.equal(state.explode, 35, 'comparison completion does not reset a later exploded view');
assert.equal(state.project.revision, viewRevision, 'comparison and presentation leave the design revision unchanged');
input('explode', 0); input('explode', 0, 'change'); clickControl('end-checkpoint-comparison');
console.log('PASS late checkpoint comparison preserves active corner drags, pending source validation, later views and exploded placement');

// Exploded placement is a presentation transform shared by render and exports.
escape();
document.querySelector('[data-view="flat"]').click();
const { computeExplodedOffsets } = await import(new URL('explode.js', demo).href);
const beforeExplosion = currentDesign(), explosionProject = structuredClone(state.project), explosionHistory = state.history.length;
const expectedOffsets = computeExplodedOffsets({ cells: state.cells, solids: state.result.solids, amount: 1, center: state.analysis.center });
input('explode', 100); input('explode', 100, 'change');
$('show-assembly-guides').checked = true; $('show-assembly-guides').dispatchEvent(new Event('change', { bubbles: true }));
flush();
const displayedMeshes = () => globalThis.__uiRenderers[0].scene.children.flatMap(group => group.children || []).filter(object => object.isMesh && Number.isSafeInteger(object.userData.cellId));
const assemblyGuides = () => globalThis.__uiRenderers[0].scene.children.flatMap(group => group.children || []).filter(object => object.userData.assemblyGuide);
for (const mesh of displayedMeshes()) assert.deepEqual(mesh.position.toArray(), expectedOffsets.get(mesh.userData.cellId));
assert.equal(new Set([...expectedOffsets.values()].map(offset => JSON.stringify(offset))).size, state.cells.length, 'coplanar split panels receive distinct translations');
const ghost = assemblyGuides().filter(object => object.userData.assemblyGuide === 'assembled');
assert.equal(ghost.length, state.cells.length);
assert.ok(ghost.every(object => object.material.isLineDashedMaterial), 'assembled outline uses dashed lines');
assert.ok(assemblyGuides().every(object => object.material.depthTest && !object.material.depthWrite), 'all assembly outlines, connectors and markers respect opaque panel depth without hiding other guides');
for (const line of assemblyGuides().filter(object => object.userData.assemblyGuide === 'corners')) {
  const values = line.geometry.attributes.position.array, offset = expectedOffsets.get(line.userData.cellId);
  assert.ok(values.length >= 6);
  for (let i = 0; i < values.length; i += 6) for (let axis = 0; axis < 3; axis++) close(values[i + 3 + axis] - values[i + axis], offset[axis], 'guide connects assembled corner to same displaced corner', 1e-3);
}
for (const mesh of displayedMeshes()) {
  const positions = mesh.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const point = new Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).project(window.cellStudy.camera);
    assert.ok(Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && Math.abs(point.z) <= 1, 'Fit includes the complete exploded arrangement');
  }
}
clickControl('export-obj');
const explodedOBJ = parseOBJ(await downloads.at(-1).blob.text());
const explodedExpected = state.cells.flatMap(cell => cell.flatPositions.map(point => point.map((value, axis) => value + expectedOffsets.get(cell.id)[axis])));
assert.equal(explodedOBJ.vertices.length, explodedExpected.length);
explodedOBJ.vertices.forEach((point, i) => point.forEach((value, axis) => close(value, explodedExpected[i][axis], 'OBJ matches exploded rendering', 1e-5)));
// Select a displaced face, not its old assembled position.
const explodedCell = state.cells[0], firstTriangle = explodedCell.triangles[0];
const clickPosition = [0, 1, 2].map(axis => firstTriangle.reduce((sum, index) => sum + explodedCell.flatPositions[index][axis] / 3, 0) + expectedOffsets.get(explodedCell.id)[axis]);
const clickPoint = projectWorld(clickPosition);
pointer(canvas, 'pointerdown', clickPoint.x, clickPoint.y); pointer(canvas, 'pointerup', clickPoint.x, clickPoint.y);
assert.equal(state.selected, explodedCell.id);
assert.ok(assemblyGuides().filter(object => object.userData.assemblyGuide === 'corners').every(object => object.userData.cellId === state.selected), 'selection limits corner connectors');
assert.equal(assemblyGuides().filter(object => object.userData.assemblyGuide === 'assembled').length, state.cells.length, 'assembled context stays visible');
const selectedFlatGuideCount = assemblyGuides().filter(object => object.userData.assemblyGuide === 'corners').reduce((sum, line) => sum + line.geometry.attributes.position.count / 2, 0);
const flatOffsets = displayedMeshes().map(mesh => [mesh.userData.cellId, mesh.position.toArray()]);
document.querySelector('[data-view="solid"]').click();
assert.deepEqual(displayedMeshes().map(mesh => [mesh.userData.cellId, mesh.position.toArray()]), flatOffsets, 'view changes preserve placement');
assert.ok(assemblyGuides().some(object => object.userData.assemblyGuide === 'corners'), 'solid guides follow nominal joint corners');
assert.equal(assemblyGuides().filter(object => object.userData.assemblyGuide === 'corners').reduce((sum, line) => sum + line.geometry.attributes.position.count / 2, 0), selectedFlatGuideCount, 'solid guides use one anchor per logical corner, without doubling the cap vertices');
input('explode', 0); input('explode', 0, 'change');
assert.deepEqual(currentDesign(), beforeExplosion);
assert.deepEqual(state.project, explosionProject, 'presentation controls never advance the project revision');
assert.equal(state.history.length, explosionHistory);
assert.ok(displayedMeshes().every(mesh => mesh.position.lengthSq() === 0));
assert.equal(assemblyGuides().length, 0, 'guides disappear in the assembled position');
console.log('PASS size-aware exploded rendering, dashed assembly guides, corner correspondence, selected connectors, camera framing and matching exports');

assert.equal(errors.length, 0, errors.map(error => error.message).join('\n'));
console.log('Browserless integration PASSED. WebGL rendering and browser layout were not tested.');
dom.window.close();
