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
const actualThree = new URL('vendor/three.module.js', demo).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './local-examples.js' && context.parentURL === new URL('app.js', demo).href) return { url: localExamplesModule, shortCircuit: true };
    if (specifier === 'three') return { url: mockModule, shortCircuit: true };
    if (specifier.startsWith('three/addons/')) return { url: new URL(`vendor/addons/${specifier.slice('three/addons/'.length)}`, demo).href, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
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

const validationReplies = [], heldValidationReplies = [], heldFitReplies = [];
let holdNextValidationReply = false, holdNextFitReply = false;
globalThis.Worker = class {
  constructor(path) {
    const owner = this;
    this.context = { postMessage(data) {
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
assert.equal(savedStudy.version, 5);
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
function surfaceShape(cell) {
  return structuredClone({ positions: cell.positions, triangles: cell.triangles, loops: cell.loops, area: cell.area });
}
function currentDesign() {
  return structuredClone({ layout: state.layout, directBase: state.directBase, pattern: state.pattern, seeds: state.seeds, mergeGroups: state.mergeGroups, cornerEdits: state.cornerEdits, size: state.size, variation: state.variation,
    randomSeed: state.randomSeed, thickness: state.thickness, straightness: state.straightness,
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
  assert.equal(study.version, 5, 'new saves include the authored layout and its reset baseline');
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
  assert.match($('selected-note').textContent, /^Fitted panel:/);
  for (const issue of state.cells[0].issues) assert.ok($('selected-note').textContent.includes(issue), `${view} retains the actual fitted failure`);
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
assert.ok(!visibleSeedIds.includes(10) && !visibleSeedIds.includes(20), 'merged members have no draggable centre handles');
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
assert.equal(completeStudy.version, 5);
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
assert.equal((await saveStudy()).version, 5);
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
assert.equal($('edit-toggle').disabled, true, 'corner edits prevent seed moves');
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
assert.deepEqual(currentDesign(),sourceTwo,'Escape retains the last accepted arrangement');
assert.equal($('export-dxf').disabled,false,'completed current fitting restores valid export');
assert.notEqual($('stock-check').textContent,'Updating…','cancelling a gesture refreshes the completed fit diagnostics');
await edit(()=>key('z'),'undo second consecutive manual move');
assert.deepEqual(currentDesign(),sourceOne);
await edit(()=>key('z'),'undo first consecutive manual move');
assert.deepEqual(currentDesign(),sequenceStart);
console.log('PASS live shell sketch, consecutive edits during fitting, obsolete replies and in-gesture fitting completion');
const altCorner=findCurrentCorner(interiorCorner),altNeighbour=state.result.corners.find(c=>c.boundary);
const nearNeighbour=altNeighbour.position.map((x,k)=>x+(altCorner.position[k]-x)*.005),altScreen=projectWorld(nearNeighbour);
const altTo=beginCornerDrag(altCorner,nearNeighbour);
assert.match($('corner-status').textContent,/Join corners/,'the proximity target normally snaps to the connected junction');
pointer(canvas,'pointermove',altScreen.x,altScreen.y,{altKey:true});
assert.doesNotMatch($('corner-status').textContent,/Join corners/,'Alt keeps a near-junction target free of proximity snapping');
document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
assert.deepEqual(currentDesign(),sequenceStart,'cancelled Alt gesture leaves the accepted layout unchanged');



await edit(() => key('z'), 'undo corner drag');
assert.deepEqual(currentDesign(), beforeCorner);
assert.deepEqual(cornerSourceSnapshot(), beforeCornerSurface);
assert.equal($('edit-toggle').disabled, false);
await edit(() => key('z', { shiftKey: true }), 'redo corner drag');
assert.deepEqual(currentDesign(), oneCornerDesign);
assert.deepEqual(cornerSourceSnapshot(), oneCornerSurface);
const cancelHistory = state.history.length;
const cancelCorner = findCurrentCorner(interiorCorner);
const cancelledTarget = cancelCorner.position.map((value, axis) => value + [18, -12, 0][axis]);
const cancelledScreen = beginCornerDrag(cancelCorner, cancelledTarget);
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
pointer(canvas, 'pointerup', cancelledScreen.x, cancelledScreen.y);
await until(() => state.solved && !state.busy && !state.pending, 'cancel corner drag');
assert.deepEqual(currentDesign(), oneCornerDesign);
assert.deepEqual(cornerSourceSnapshot(), oneCornerSurface);
assert.equal(state.history.length, cancelHistory, 'cancelled drag creates no history entry');
assert.equal(window.cellStudy.controls.enabled, true);
assert.match($('corner-status').textContent, /cancelled/i, 'corner inspector confirms drag cancellation');
const pendingCancelScreen = beginCornerDrag(findCurrentCorner(interiorCorner), cancelledTarget);
const beforePendingCancel = preservedDocument(), beforeCancelReplies = validationReplies.length;
pointer(canvas, 'pointerup', pendingCancelScreen.x, pendingCancelScreen.y);
assert.equal($('save-study').disabled, true, 'released corner is awaiting validation');
assert.equal(validationReplies.length, beforeCancelReplies, 'validation has not replied before Escape');
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
await until(() => validationReplies.length > beforeCancelReplies, 'reply after cancelling pending corner validation');
assert.equal(validationReplies.at(-1).error, undefined, 'the cancelled candidate was otherwise geometrically valid');
assert.deepEqual(preservedDocument(), beforePendingCancel, 'late successful validation cannot commit a cancelled corner move');
assert.equal(state.history.length, cancelHistory);
assert.equal($('save-study').disabled, false);
assert.equal($('export-obj').disabled, false);
assert.match($('corner-status').textContent, /cancelled/i, 'late validation cannot leave a stale checking message');
console.log('PASS corner undo/redo and drag/pending Escape cancellation preserve accepted geometry');

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
assert.equal(cornersSaved.version, 5);
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
assert.equal($('edit-toggle').disabled, true, 'structured cells are edited through graph corners rather than random centers');
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
assert.match($('status').textContent, /arrangement cancelled/i);
const escapeStatus = $('status').textContent;
await deliverCancelledArrangement(escapeReply, beforeEscapeGeneration, 'ignore generation cancelled with Escape');
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
assert.equal($('edit-toggle').disabled, true, 'regularized layouts use direct graph editing');
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

assert.equal(errors.length, 0, errors.map(error => error.message).join('\n'));
console.log('Browserless integration PASSED. WebGL rendering and browser layout were not tested.');
dom.window.close();
