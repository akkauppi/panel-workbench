import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryStore, RecoveryStorageError } from './project-recovery.js';

// Models an atomic transactional backend, including failure after staged deletes
// and inserts. Browser tests exercise the real IndexedDB adapter separately.
class MemoryStorage {
  records = new Map(); texts = new Map(); failure = null; closed = false;
  pending = Promise.resolve(); gate = null;
  async list() { await this.pending; return structuredClone([...this.records.values()]); }
  async read(id) { await this.pending; return this.texts.get(id) ?? null; }
  commit(decide) {
    const task = this.pending.then(async () => {
      if (this.gate) await this.gate;
      const plan = decide(structuredClone([...this.records.values()]));
      const records = new Map(this.records), texts = new Map(this.texts);
      for (const id of plan.remove) { records.delete(id); texts.delete(id); }
      if (records.has(plan.record.id)) throw new DOMException('Duplicate snapshot.', 'ConstraintError');
      records.set(plan.record.id, structuredClone(plan.record)); texts.set(plan.record.id, plan.text);
      if (this.failure) { const error = this.failure; this.failure = null; throw error; }
      this.records = records; this.texts = texts;
      return structuredClone(plan.result);
    });
    this.pending = task.catch(() => {});
    return task;
  }
  async remove(id) { await this.pending; this.records.delete(id); this.texts.delete(id); }
  close() { this.closed = true; }
}

function study(revision = 1, id = 'shell-a', note = '') {
  return { format: 'sauna-cell-study', version: 6, name: 'Tuomas shell',
    project: { id, revision, createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z' },
    layout: { cells: [{ id: 24, points: [[1, 2, 3]] }] }, note };
}
function fixture(options = {}) {
  const storage = new MemoryStorage(); let next = 0;
  const store = createRecoveryStore({ storageFactory: () => storage, now: () => 1793354400000,
    makeId: () => `snapshot-${++next}`, ...options });
  return { store, storage };
}

test('recovery opens lazily and never saves a startup gallery or writes on list', async () => {
  let opened = 0;
  const storage = new MemoryStorage();
  const store = createRecoveryStore({ storageFactory: () => { opened++; return storage; } });
  assert.equal(opened, 0);
  assert.deepEqual(await store.list(), []);
  assert.equal(opened, 1);
  assert.equal(storage.records.size, 0);
});

test('recovery retains user activity time independently of delayed write order', async () => {
  const { store } = fixture();
  const newer = await store.save({ study: study(3), activeAt: 2000 });
  const late = await store.save({ study: study(2), activeAt: 1000 });
  const records = await store.list();
  assert.equal(records[0].id, late.id, 'catalogue still records physical write order');
  assert.equal(records.find(record => record.id === newer.id).activeAt, 2000);
  assert.equal(records.find(record => record.id === late.id).activeAt, 1000);
  assert.equal((await store.read(newer.id)).activeAt, undefined, 'browser metadata does not alter v6 project files');
  const before = await store.list();
  await assert.rejects(store.save({ study: study(4), activeAt: NaN }), /activity time/);
  assert.deepEqual(await store.list(), before);
});

test('snapshot captures invocation-time design and read returns independent copies', async () => {
  const { store, storage } = fixture();
  let release;
  storage.gate = new Promise(resolve => { release = resolve; });
  const original = study(), expected = structuredClone(original);
  const saving = store.save({ study: original, label: 'Before doorway edit' });
  original.layout.cells[0].points[0][0] = 900;
  original.project.revision = 20;
  release();
  const descriptor = await saving;
  assert.equal(descriptor.revision, 1);
  assert.equal(descriptor.label, 'Before doorway edit');
  assert.equal(descriptor.byteLength, new Blob([JSON.stringify(expected)]).size);
  assert.deepEqual(await store.read(descriptor.id), expected);
  const read = await store.read(descriptor.id); read.layout.cells.length = 0;
  assert.deepEqual(await store.read(descriptor.id), expected);
  assert.deepEqual((await store.list()).map(row => row.id), [descriptor.id]);
});

test('concurrent saves preserve invocation order, even with backward clocks and older revisions', async () => {
  let clock = 1793354400000;
  const { store, storage } = fixture({ now: () => clock-- });
  let release;
  storage.gate = new Promise(resolve => { release = resolve; });
  const first = store.save({ study: study(8) });
  const second = store.save({ study: study(3, 'shell-a', 'Reopened older file') });
  const third = store.save({ study: study(3, 'shell-a', 'An independent variant') });
  release();
  const snapshots = await Promise.all([first, second, third]);
  assert.equal(new Set(snapshots.map(row => row.id)).size, 3);
  assert.deepEqual((await store.list()).map(row => row.id), snapshots.map(row => row.id).reverse());
  assert.deepEqual((await store.list()).map(row => row.revision), [3, 3, 8]);
  assert.equal((await store.read(snapshots[1].id)).note, 'Reopened older file');
  assert.equal((await store.read(snapshots[2].id)).note, 'An independent variant');
});

test('independent tab stores retain distinct content at the same project revision', async () => {
  const storage = new MemoryStorage();
  const a = createRecoveryStore({ storageFactory: () => storage, makeId: () => 'tab-a' });
  const b = createRecoveryStore({ storageFactory: () => storage, makeId: () => 'tab-b' });
  await Promise.all([a.save({ study: study(2, 'shell-a', 'Corner changed') }), b.save({ study: study(2, 'shell-a', 'Centre changed') })]);
  assert.equal((await a.list()).length, 2);
  assert.notEqual((await a.read('tab-a')).note, (await b.read('tab-b')).note);
  assert.deepEqual((await a.list()).map(row => row.sequence), [2, 1]);
});

test('per-project retention keeps recent snapshots plus the last before-replacement checkpoint', async () => {
  const { store } = fixture({ maxPerProject: 2 });
  const oldCheckpoint = await store.save({ study: study(1), reason: 'before-replacement' });
  await store.save({ study: study(2) });
  await store.save({ study: study(3) });
  const latest = await store.save({ study: study(4) });
  assert.equal(latest.prunedCount, 1);
  assert.deepEqual((await store.list()).map(row => row.revision), [4, 3, 1]);
  assert.ok(await store.read(oldCheckpoint.id));
  const replacement = await store.save({ study: study(4), reason: 'before-replacement' });
  assert.equal(replacement.prunedCount, 1);
  assert.deepEqual((await store.list()).map(row => row.revision), [4, 4, 3]);
  assert.equal(await store.read(oldCheckpoint.id), null);
});

test('global count bounds age out old projects and report removed copies', async () => {
  const { store } = fixture({ maxRecords: 3 });
  const first = await store.save({ study: study(1, 'project-1'), reason: 'before-replacement' });
  await store.save({ study: study(1, 'project-2') });
  await store.save({ study: study(1, 'project-3') });
  const last = await store.save({ study: study(1, 'project-4') });
  assert.deepEqual((await store.list()).map(row => row.projectId), ['project-4', 'project-3', 'project-2']);
  assert.equal(last.prunedCount, 1);
  assert.equal(last.prunedBytes, first.byteLength);
  assert.equal(await store.read(first.id), null);
});

test('byte budget bounds large documents without reading their payloads to list', async () => {
  const document = study(1, 'a', '木'.repeat(100)), size = new Blob([JSON.stringify(document)]).size;
  const { store, storage } = fixture({ maxBytes: size * 2, maxStudyBytes: size });
  const first = await store.save({ study: document });
  await store.save({ study: { ...document, project: { ...document.project, id: 'b' } } });
  const third = await store.save({ study: { ...document, project: { ...document.project, id: 'c' } } });
  assert.equal(third.prunedCount, 1);
  storage.read = () => { throw new Error('List must not load large payloads.'); };
  assert.deepEqual((await store.list()).map(row => row.projectId), ['c', 'b']);
  assert.equal(storage.texts.has(first.id), false);
});

test('quota failure atomically preserves older snapshots even when retention would delete them', async () => {
  const { store, storage } = fixture({ maxRecords: 1 });
  const first = await store.save({ study: study(1), reason: 'before-replacement' });
  storage.failure = new DOMException('Quota exceeded.', 'QuotaExceededError');
  await assert.rejects(store.save({ study: study(2) }), error => error instanceof RecoveryStorageError && error.code === 'quota' && /Earlier recovery copies were kept/.test(error.message));
  assert.deepEqual((await store.list()).map(row => row.id), [first.id]);
  assert.equal((await store.read(first.id)).project.revision, 1);
  const retried = await store.save({ study: study(2) });
  assert.equal(retried.prunedCount, 1);
  assert.deepEqual((await store.list()).map(row => row.revision), [2]);
});

test('failed writes do not poison later queued saves', async () => {
  const { store, storage } = fixture();
  storage.failure = new DOMException('Transaction aborted.', 'AbortError');
  const rejected = assert.rejects(store.save({ study: study(1) }), error => error.code === 'storage-failed');
  const saved = store.save({ study: study(2) });
  await rejected;
  assert.equal((await saved).revision, 2);
  assert.deepEqual((await store.list()).map(row => row.revision), [2]);
});

test('storage unavailable or forbidden is actionable and can be retried', async () => {
  const unavailable = createRecoveryStore({ indexedDB: null });
  await assert.rejects(unavailable.save({ study: study() }), error => error.code === 'unavailable' && /Download a study file/.test(error.message));
  let attempts = 0; const storage = new MemoryStorage();
  const retryable = createRecoveryStore({ storageFactory: () => {
    if (!attempts++) throw new DOMException('Access denied.', 'SecurityError');
    return storage;
  } });
  await assert.rejects(retryable.list(), error => error.code === 'unavailable');
  assert.deepEqual(await retryable.list(), []);
});

test('oversize UTF-8 and invalid metadata are rejected before opening storage', async () => {
  const document = study(1, 'a', '木');
  const byteLength = new Blob([JSON.stringify(document)]).size;
  let opened = 0;
  const store = createRecoveryStore({ maxStudyBytes: byteLength, maxBytes: byteLength * 2,
    storageFactory: () => { opened++; return new MemoryStorage(); } });
  await assert.rejects(store.save({ study: { ...document, note: '木木' } }), error => error.code === 'too-large');
  await assert.rejects(store.save({ study: { ...document, project: { id: 'a', revision: 0 } } }), error => error.code === 'invalid-study');
  const circular = study(); circular.self = circular;
  await assert.rejects(store.save({ study: circular }), error => error.code === 'invalid-study');
  assert.equal(opened, 0);
  await store.save({ study: document });
  assert.equal(opened, 1);
});

test('remove deletes the payload and catalogue; missing and corrupt copies are distinguished', async () => {
  const { store, storage } = fixture();
  const saved = await store.save({ study: study() });
  storage.texts.set(saved.id, '{corrupt');
  await assert.rejects(store.read(saved.id), error => error.code === 'corrupt');
  await store.remove(saved.id);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.read(saved.id), null);
  assert.equal(storage.texts.size, 0);
});

test('close drains queued snapshots and rejects new operations', async () => {
  const { store, storage } = fixture();
  let release;
  storage.gate = new Promise(resolve => { release = resolve; });
  const saving = store.save({ study: study() }), closing = store.close();
  await assert.rejects(store.list(), error => error.code === 'closed');
  release();
  await saving; await closing;
  assert.equal(storage.closed, true);
  assert.equal(storage.records.size, 1);
});
