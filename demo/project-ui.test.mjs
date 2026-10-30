import test from 'node:test';
import assert from 'node:assert/strict';
import { initProjectUI } from './project-ui.js';
import { createStudy, readStudy } from './study.js';
import { generateCellLayout } from './geometry.js';
import { captureLayout, layoutRecipe } from './layout.js';
import { LOCAL_SAVE_PREFERENCE_KEY } from './local-save-preference.js';

class Element {
  textContent = ''; children = []; disabled = false; open = false; events = new Map(); attrs = new Map();
  classList = { toggle() {} };
  addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); }
  removeEventListener(name, fn) { this.events.get(name)?.delete(fn); }
  setAttribute(name, value) { this.attrs.set(name, value); }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...elements) { this.children = elements; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  async click() { if (!this.disabled) await Promise.all([...this.events.get('click') || []].map(fn => fn())); }
  async change(checked) { this.checked = checked; await Promise.all([...this.events.get('change') || []].map(fn => fn())); }
  async emit(name, event) { await Promise.all([...this.events.get(name) || []].map(fn => fn(event))); }
}
function fakeDocument() {
  const nodes = new Map(['project-status', 'recovery-open', 'recovery-dialog', 'recovery-list', 'recovery-close', 'local-save-enabled', 'local-save-note'].map(id => [id, new Element()]));
  const defaultView = new Element(); defaultView.localStorage = {};
  return { getElementById: id => nodes.get(id), createElement: () => new Element(), defaultView };
}
function fakeTimers() {
  let id = 0; const pending = new Map();
  return { setTimeout(fn) { pending.set(++id, fn); return id; }, clearTimeout(id) { pending.delete(id); },
    run() { const work = [...pending.values()]; pending.clear(); for (const fn of work) fn(); }, get count() { return pending.size; } };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function project(revision = 1, name = 'Shell study') {
  const state = { name, rawModel: { vertices: [[0,0,0],[1000,0,0],[1000,1000,0],[0,1000,0]], triangles: [[0,1,2],[0,2,3]] },
    seeds: [{ id: 0, position: [500,500,0], weight: 1 }], mergeGroups: [], cornerEdits: [], directBase: null,
    pattern: { type: 'organic', angle: 0, frequency: 2 }, size: 400, variation: .25, randomSeed: 7,
    straightness: .7, thickness: 40, roundover: 2, carve: false, minimumThickness: 12, flipOutside: false, view: 'surface',
    project: { id: 'project-shell', revision, createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z' } };
  state.layout = captureLayout(state.rawModel, generateCellLayout(state.rawModel, state.seeds, state), { recipe: layoutRecipe(state) });
  return createStudy(state, { units: 'mm', up: 'z', camera: [0,0,2000], target: [500,500,0] });
}
const base = project();
function revision(n, name = 'Shell study') { return { ...structuredClone(base), name, project: { ...base.project, revision: n } }; }

function fixture({ current = null, stored = [], failList = false, enabled = true, preferenceFailure = null } = {}) {
  const doc = fakeDocument(), timers = fakeTimers(), messages = [], downloads = [], opened = [], events = [];
  const payloads = new Map(stored.map((study, i) => [`stored-${i}`, structuredClone(study)]));
  const rows = stored.map((study, i) => ({ id: `stored-${i}`, label: study.name, revision: study.project.revision,
    savedAt: '2026-10-30T10:00:00.000Z', reason: 'automatic' }));
  let next = 0, clock = 10000, captureCount = 0;
  const store = { calls: [], gate: null, failure: null, closed: false,
    async list() { if (failList) throw new Error('Browser storage unavailable.'); return structuredClone(rows); },
    async save(input) {
      this.calls.push(structuredClone(input)); events.push('checkpoint');
      if (this.gate) await this.gate;
      if (this.failure) throw this.failure;
      const record = { id: `saved-${++next}`, label: input.label, revision: input.study.project.revision,
        savedAt: '2026-10-30T11:00:00.000Z', reason: input.reason, prunedCount: 0, activeAt: input.activeAt, sequence: next };
      payloads.set(record.id, structuredClone(input.study)); rows.unshift(record); return record;
    },
    async read(id) { return structuredClone(payloads.get(id) ?? null); },
    async remove(id) { payloads.delete(id); const index = rows.findIndex(row => row.id === id); if (index >= 0) rows.splice(index, 1); },
    async close() { this.closed = true; },
  };
  const preference = { get: () => ({ enabled, persisted: !preferenceFailure, error: preferenceFailure }),
    set(value) { enabled = value; return this.get(); } };
  const state = { current };
  const ui = initProjectUI({ getStudy: () => { captureCount++; return state.current; }, openStudy: async (study, options) => {
    if (state.onOpen) return state.onOpen(study, options);
    events.push('open'); opened.push(study); state.current = study;
    if (options?.automatic) ui.documentChanged({ activeAt: options.activeAt });
    return true;
  }, download: (...args) => downloads.push(args), setStatus: (...args) => messages.push(args), store, document: doc, timers, preference, now: () => clock++ });
  return { ui, doc, timers, store, state, messages, downloads, opened, events, rows, payloads, captures: () => captureCount,
    status: () => doc.getElementById('project-status').textContent,
    action: (row, label) => doc.getElementById('recovery-list').children[row].children[2].children.find(button => button.textContent === label) };
}

test('initial recovery discovery performs no write and opens/closes the list', async () => {
  const f = fixture({ stored: [revision(3)] }); await settle();
  assert.equal(f.store.calls.length, 0); assert.match(f.status(), /1 local recovery copy available/);
  await f.doc.getElementById('recovery-open').click(); await settle();
  assert.equal(f.doc.getElementById('recovery-dialog').open, true);
  assert.match(f.doc.getElementById('recovery-list').children[0].children[1].textContent, /Revision 3/);
  await f.doc.getElementById('recovery-close').click();
  assert.equal(f.doc.getElementById('recovery-dialog').open, false);
  assert.deepEqual(f.messages, []);
});

test('changed debounces and captures the accepted document at invocation', async () => {
  const f = fixture({ current: revision(2) }); await settle();
  f.ui.changed(); f.state.current = revision(3); f.ui.changed();
  f.state.current.name = 'Mutated after notification';
  assert.equal(f.timers.count, 1); assert.equal(f.store.calls.length, 0);
  f.timers.run(); await settle();
  assert.equal(f.store.calls.length, 1); assert.equal(f.store.calls[0].study.project.revision, 3);
  assert.equal(f.store.calls[0].study.name, 'Shell study'); assert.equal(f.store.calls[0].reason, 'automatic');
  assert.match(f.status(), /Revision 3.*saved in this browser/); assert.deepEqual(f.messages, []);
});

test('stale save completion cannot replace status for a newer accepted revision', async () => {
  const f = fixture({ current: revision(1) }); await settle();
  const gate = deferred(); f.store.gate = gate.promise;
  f.ui.changed(); f.timers.run();
  f.state.current = revision(2); f.ui.changed();
  gate.resolve(); await settle();
  assert.match(f.status(), /Revision 2.*pending/); assert.equal(f.store.calls.length, 1); assert.deepEqual(f.messages, []);
});

test('checkpoint cancels pending autosave and immediately saves before replacement', async () => {
  const f = fixture({ current: revision(4) }); await settle();
  f.ui.changed(); const saving = f.ui.checkpoint();
  assert.equal(f.timers.count, 0); assert.equal(f.store.calls.length, 1);
  assert.equal(f.store.calls[0].reason, 'before-replacement'); assert.equal(await saving, true);
  f.state.current = null; assert.equal(await f.ui.checkpoint(), true); assert.equal(f.store.calls.length, 1);
});

test('checkpoint failure is actionable and returns false without replacing the project', async () => {
  const f = fixture({ current: revision(5) }); await settle();
  f.store.failure = new Error('Browser storage is full.');
  assert.equal(await f.ui.checkpoint(), false); assert.equal(f.state.current.project.revision, 5);
  assert.match(f.status(), /storage is full.*Download a study file/); assert.equal(f.messages.at(-1)[1], true);
});

test('a newer edit while a checkpoint is in flight prevents replacement', async () => {
  const f = fixture({ current: revision(5) }); await settle();
  const gate = deferred(); f.store.gate = gate.promise;
  const saving = f.ui.checkpoint(); f.state.current = revision(6); f.ui.changed();
  gate.resolve(); assert.equal(await saving, false); assert.match(f.status(), /Revision 6.*pending/);
});

test('Restore checkpoints the current accepted project before opening the recovery copy', async () => {
  const f = fixture({ current: revision(5), stored: [revision(2, 'Earlier shell')] }); await settle();
  await f.doc.getElementById('recovery-open').click(); await settle();
  await f.action(0, 'Restore').click();
  assert.deepEqual(f.events, ['checkpoint', 'open']);
  assert.equal(f.store.calls[0].study.project.revision, 5); assert.equal(f.store.calls[0].reason, 'before-replacement');
  assert.equal(f.opened[0].project.revision, 2); assert.equal(f.doc.getElementById('recovery-dialog').open, false);
  assert.match(f.status(), /Recovered Earlier shell.*Revision 2/);
});

test('Restore leaves current work and dialog intact when its protective checkpoint fails', async () => {
  const f = fixture({ current: revision(5), stored: [revision(2)] }); await settle();
  f.store.failure = new Error('Storage denied.');
  await f.doc.getElementById('recovery-open').click(); await settle();
  await f.action(0, 'Restore').click();
  assert.equal(f.opened.length, 0); assert.equal(f.state.current.project.revision, 5);
  assert.equal(f.doc.getElementById('recovery-dialog').open, true);
  assert.equal(f.action(0, 'Restore').disabled, false);
});

test('recovery Download produces a readable study without claiming download completion', async () => {
  const original = revision(7, 'Door <west>');
  const f = fixture({ stored: [original] }); await settle();
  await f.action(0, 'Download').click();
  assert.equal(f.downloads.length, 1); assert.match(f.downloads[0][0], /r7-recovery-study\.json$/);
  assert.deepEqual(readStudy(f.downloads[0][1]), original); assert.equal(f.downloads[0][2], 'application/json');
  assert.match(f.status(), /Check your browser's downloads/); assert.deepEqual(f.messages, []); assert.equal(f.store.calls.length, 0);
});

test('Delete removes only the chosen recovery copy and refreshes the list', async () => {
  const f = fixture({ stored: [revision(2), revision(1)] }); await settle();
  await f.action(0, 'Delete').click();
  assert.equal(f.doc.getElementById('recovery-open').textContent, 'Recovery copies (1)');
  assert.match(f.doc.getElementById('recovery-list').children[0].children[1].textContent, /Revision 1/);
  assert.equal(f.store.calls.length, 0);
});

test('serialization and storage availability errors are reported without an unhandled task', async () => {
  const f = fixture({ current: revision(1) }); await settle();
  f.state.current.loop = f.state.current; f.ui.changed();
  assert.equal(f.timers.count, 0); assert.equal(f.store.calls.length, 0); assert.match(f.status(), /Download a study file/);
  const blocked = fixture({ failList: true }); await settle();
  assert.match(blocked.status(), /Browser storage unavailable/); assert.equal(blocked.messages.at(-1)[1], true);
});

test('dispose cancels queued debounce and prevents late status or event changes', async () => {
  const f = fixture({ current: revision(1) }); await settle();
  f.ui.changed(); const before = f.status(); await f.ui.dispose();
  f.timers.run(); f.ui.changed(); await settle();
  assert.equal(f.store.calls.length, 0); assert.equal(f.store.closed, true); assert.equal(f.status(), before);
  await f.doc.getElementById('recovery-open').click(); assert.equal(f.doc.getElementById('recovery-dialog').open, false);
});

test('local saving defaults on and automatic resume uses accepted activity instead of late fit order', async () => {
  const f = fixture({ stored: [revision(9, 'Older tab fit'), revision(3, 'Latest user activity')] }); await settle();
  Object.assign(f.rows[0], { activeAt: 100, sequence: 50 });
  Object.assign(f.rows[1], { activeAt: 200, sequence: 2 });
  assert.equal(f.doc.getElementById('local-save-enabled').checked, true);
  assert.equal(await f.ui.restoreLatest(), true, 'Host installation intentionally changes controller generation.');
  assert.equal(f.state.current.name, 'Latest user activity'); assert.equal(f.store.calls.length, 0, 'Startup restore does not checkpoint the gallery.');
  f.ui.changed({ activity: false }); f.timers.run(); await settle();
  assert.equal(f.store.calls[0].activeAt, 200, 'A recalculation keeps the restored activity time.');
  f.ui.changed(); f.timers.run(); await settle();
  assert.ok(f.store.calls[1].activeAt > 200, 'Accepted user activity advances recency.');
});

test('legacy resume uses savedAt, with sequence resolving equal activity times', async () => {
  const f = fixture({ stored: [revision(2), revision(1)] }); await settle();
  Object.assign(f.rows[0], { savedAt: '2026-10-30T09:00:00.000Z', sequence: 30 });
  Object.assign(f.rows[1], { savedAt: '2026-10-30T10:00:00.000Z', sequence: 1 });
  assert.equal(await f.ui.restoreLatest(), true); assert.equal(f.opened[0].project.revision, 1);
  const g = fixture({ stored: [revision(2), revision(1)] }); await settle();
  Object.assign(g.rows[0], { activeAt: 100, sequence: 3 }); Object.assign(g.rows[1], { activeAt: 100, sequence: 4 });
  assert.equal(await g.ui.restoreLatest(), true); assert.equal(g.opened[0].project.revision, 1);
});

test('disabled local saving suppresses automatic writes, checkpoints and resume but retains manual restore', async () => {
  const f = fixture({ current: revision(5), stored: [revision(2)], enabled: false }); await settle();
  assert.equal(f.ui.isEnabled(), false); assert.equal(await f.ui.restoreLatest(), false);
  f.ui.changed(); f.ui.viewChanged(); f.timers.run(); await settle();
  assert.equal(await f.ui.checkpoint(), true); assert.equal(f.store.calls.length, 0);
  await f.action(0, 'Restore').click();
  assert.equal(f.opened[0].project.revision, 2); assert.equal(f.store.calls.length, 0);
  assert.equal(f.rows.length, 1, 'Opting out keeps existing copies.');
});

test('disabling cancels a pending save and suppresses stale in-flight completion status', async () => {
  const f = fixture({ current: revision(4) }); await settle();
  f.ui.changed(); await f.doc.getElementById('local-save-enabled').change(false);
  assert.equal(f.timers.count, 0); f.timers.run(); assert.equal(f.store.calls.length, 0);
  await f.doc.getElementById('local-save-enabled').change(true);
  const gate = deferred(); f.store.gate = gate.promise; f.timers.run();
  assert.equal(f.store.calls.length, 1);
  await f.doc.getElementById('local-save-enabled').change(false);
  gate.resolve(); await settle();
  assert.match(f.status(), /saving and automatic resume are off/);
  assert.equal(f.doc.getElementById('local-save-enabled').checked, false);
  f.state.current = revision(5); f.ui.changed(); f.timers.run(); await settle();
  assert.equal(f.store.calls.length, 1, 'An already-started write may finish; no later writes start.');
});

test('reenabling saves the current accepted project without requiring a further edit', async () => {
  const f = fixture({ current: revision(6), enabled: false }); await settle();
  await f.doc.getElementById('local-save-enabled').change(true);
  assert.equal(f.ui.isEnabled(), true); assert.equal(f.timers.count, 1);
  assert.equal(await f.ui.flush(), true);
  assert.equal(f.store.calls[0].study.project.revision, 6);
});

test('preference persistence failures do not reverse the session choice and remain visible separately', async () => {
  const failure = new Error('The browser could not remember this preference; it may change after reload.');
  const f = fixture({ current: revision(1), preferenceFailure: failure }); await settle();
  assert.equal(f.ui.isEnabled(), true);
  assert.equal(f.doc.getElementById('local-save-note').hidden, false);
  f.ui.changed(); await f.ui.flush(); await f.ui.refresh();
  assert.match(f.doc.getElementById('local-save-note').textContent, /could not remember/);
  await f.doc.getElementById('local-save-enabled').change(false);
  assert.equal(f.ui.isEnabled(), false); assert.equal(await f.ui.restoreLatest(), false);
  assert.match(f.doc.getElementById('local-save-note').textContent, /could not remember/);
});

test('a delayed startup resume cannot replace a newly installed or edited document', async () => {
  const f = fixture({ stored: [revision(2)] }); await settle();
  const gate = deferred(), read = f.store.read.bind(f.store);
  f.store.read = async id => { await gate.promise; return read(id); };
  const restoring = f.ui.restoreLatest(); await settle();
  f.state.current = revision(8); f.ui.documentChanged();
  gate.resolve(); assert.equal(await restoring, false); assert.equal(f.opened.length, 0);
  const g = fixture({ stored: [revision(2)] }); await settle();
  assert.equal(await g.ui.restoreLatest({ isCurrent: () => false }), false); assert.equal(g.opened.length, 0);
});

test('opting out while startup reads a saved project prevents automatic opening', async () => {
  const f = fixture({ stored: [revision(2)] }); await settle();
  const gate = deferred(), read = f.store.read.bind(f.store);
  f.store.read = async id => { await gate.promise; return read(id); };
  const restoring = f.ui.restoreLatest(); await settle();
  await f.doc.getElementById('local-save-enabled').change(false);
  gate.resolve(); assert.equal(await restoring, false); assert.equal(f.opened.length, 0);
});

test('an unreadable latest copy leaves older copies for manual recovery and a persistent warning', async () => {
  const f = fixture({ stored: [revision(3), revision(2)] }); await settle();
  Object.assign(f.rows[0], { activeAt: 200, sequence: 2 }); Object.assign(f.rows[1], { activeAt: 100, sequence: 1 });
  const read = f.store.read.bind(f.store);
  f.store.read = async id => { if (id === 'stored-0') throw new Error('Unreadable recovery JSON.'); return read(id); };
  assert.equal(await f.ui.restoreLatest(), false); assert.equal(f.opened.length, 0); assert.equal(f.rows.length, 2);
  f.ui.documentChanged(); await f.ui.refresh();
  assert.match(f.doc.getElementById('local-save-note').textContent, /choose one manually/);
  await f.action(1, 'Restore').click();
  assert.equal(f.opened[0].project.revision, 2); assert.equal(f.doc.getElementById('local-save-note').hidden, true);
});

test('failed host validation is reported even though starting import advances the host startup token', async () => {
  const f = fixture({ stored: [revision(3)] }); await settle();
  let startupCurrent = true;
  f.state.onOpen = async () => { startupCurrent = false; throw new Error('Saved source layout is invalid.'); };
  assert.equal(await f.ui.restoreLatest({ isCurrent: () => startupCurrent }), false);
  assert.match(f.doc.getElementById('local-save-note').textContent, /source layout is invalid/);
  f.ui.documentChanged(); await f.ui.refresh();
  assert.match(f.doc.getElementById('local-save-note').textContent, /choose one manually/);
});

test('a temporarily unavailable capture does not drop the last queued accepted snapshot', async () => {
  const f = fixture({ current: revision(4) }); await settle();
  f.ui.changed(); f.state.current = null; f.ui.changed({ activity: false });
  assert.equal(f.timers.count, 1);
  assert.equal(await f.ui.flush(), true);
  assert.equal(f.store.calls[0].study.project.revision, 4);
  assert.match(f.status(), /Revision 4.*saved in this browser/);
});

test('document replacement invalidates queued old data and background fits keep its activity time', async () => {
  const f = fixture({ current: revision(4) }); await settle();
  f.ui.changed(); f.ui.documentChanged({ activeAt: 321 }); f.state.current = revision(2, 'Different project');
  assert.equal(f.timers.count, 0);
  f.ui.changed({ activity: false }); await f.ui.flush();
  assert.equal(f.store.calls.length, 1); assert.equal(f.store.calls[0].study.name, 'Different project'); assert.equal(f.store.calls[0].activeAt, 321);
});

test('view changes capture once at debounce expiry and hidden flush captures the final camera', async () => {
  const f = fixture({ current: revision(4) }); await settle();
  f.ui.documentChanged({ activeAt: 100 });
  const before = f.captures();
  for (let i = 0; i < 25; i++) { f.state.current.camera[0] = i; f.ui.viewChanged(); }
  assert.equal(f.captures(), before, 'Orbit events must not serialize the mesh each frame.');
  f.timers.run(); await settle();
  assert.equal(f.captures(), before + 1); assert.equal(f.store.calls.length, 1); assert.equal(f.store.calls[0].study.camera[0], 24);
  f.state.current.camera[0] = 42; f.ui.viewChanged();
  assert.equal(await f.ui.flush(), true); assert.equal(f.store.calls[1].study.camera[0], 42);
});

test('browser-wide opt-out cancels other tabs while external reenable does not promote their older projects', async () => {
  const f = fixture({ current: revision(4) }); await settle();
  f.ui.documentChanged({ activeAt: 150 }); f.ui.changed({ activity: false });
  const event = { key: LOCAL_SAVE_PREFERENCE_KEY, storageArea: f.doc.defaultView.localStorage };
  await f.doc.defaultView.emit('storage', { ...event, newValue: 'false' });
  assert.equal(f.ui.isEnabled(), false); assert.equal(f.timers.count, 0);
  f.timers.run(); await settle(); assert.equal(f.store.calls.length, 0);
  await f.doc.defaultView.emit('storage', { ...event, newValue: 'true' });
  assert.equal(f.ui.isEnabled(), true); assert.equal(f.timers.count, 0); assert.equal(f.store.calls.length, 0);
  f.ui.changed({ activity: false }); await f.ui.flush();
  assert.equal(f.store.calls[0].activeAt, 150);
  await f.doc.defaultView.emit('storage', { ...event, storageArea: {}, newValue: 'false' });
  assert.equal(f.ui.isEnabled(), true, 'Ignore unrelated storage areas.');
  await f.doc.defaultView.emit('storage', { ...event, key: 'unrelated-key', newValue: 'false' });
  assert.equal(f.ui.isEnabled(), true);
});
