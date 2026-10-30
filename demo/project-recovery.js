// Recovery is local to this browser/profile and can be removed by the browser.
// Downloaded study files remain the durable, portable copy. Callers supply an
// accepted study (createStudy/readStudy); no gallery or startup write happens here.
import { MAX_STUDY_BYTES } from './project-document.js';
const DEFAULT_BYTES = 256 * 1024 * 1024;
const META = 'snapshots', DATA = 'studies';
let fallbackId = 0;

export class RecoveryStorageError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RecoveryStorageError'; this.code = code;
  }
}

function storageError(error) {
  if (error instanceof RecoveryStorageError) return error;
  if (error?.name === 'QuotaExceededError') return new RecoveryStorageError('quota',
    'Local recovery storage is full. Earlier recovery copies were kept. Download a study file, then remove old recovery copies or free browser storage.', error);
  if (['SecurityError', 'NotAllowedError', 'InvalidStateError'].includes(error?.name)) return new RecoveryStorageError('unavailable',
    'Local recovery is unavailable in this browser. Check browser storage permissions or reopen the tool, and download a study file to keep your work.', error);
  return new RecoveryStorageError('storage-failed',
    'Local recovery could not be completed. Earlier recovery copies were kept. Download a study file to keep your work and try again.', error);
}

function unavailable() {
  return new RecoveryStorageError('unavailable', 'Local recovery is unavailable in this browser. Download a study file to keep your work.');
}
function newestFirst(a, b) { return b.sequence - a.sequence || b.savedAt.localeCompare(a.savedAt) || b.id.localeCompare(a.id); }
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

// One transaction covers the lightweight catalogue and large JSON payloads.
// In particular, quota failure during put() rolls back every preceding delete.
function openIndexedDB(indexedDB, databaseName) {
  if (!indexedDB?.open) return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    let request, settled = false;
    try { request = indexedDB.open(databaseName, 1); }
    catch (error) { reject(error); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'id' });
    };
    request.onerror = () => { if (!settled) { settled = true; reject(request.error); } };
    request.onblocked = () => {
      if (!settled) { settled = true; reject(new RecoveryStorageError('blocked',
        'Local recovery is blocked by another open version of this tool. Close older tabs and try again. Download a study file to keep your work.')); }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      db.onversionchange = () => db.close();
      function transaction(mode, run) {
        return new Promise((done, fail) => {
          let tx, result, failure;
          try { tx = db.transaction([META, DATA], mode); }
          catch (error) { fail(error); return; }
          tx.oncomplete = () => done(result);
          tx.onerror = event => { failure ??= event.target?.error || tx.error; };
          tx.onabort = () => fail(failure || tx.error || new Error('Recovery transaction was aborted.'));
          const guard = callback => event => {
            try { callback(event); }
            catch (error) { failure = error; tx.abort(); }
          };
          try { run(tx, value => { result = value; }, guard); }
          catch (error) { failure = error; tx.abort(); }
        });
      }
      resolve({
        list: () => transaction('readonly', (tx, result, guard) => {
          tx.objectStore(META).getAll().onsuccess = guard(event => result(event.target.result));
        }),
        read: id => transaction('readonly', (tx, result, guard) => {
          tx.objectStore(DATA).get(id).onsuccess = guard(event => result(event.target.result?.text ?? null));
        }),
        commit: decide => transaction('readwrite', (tx, result, guard) => {
          tx.objectStore(META).getAll().onsuccess = guard(event => {
            const plan = decide(event.target.result);
            for (const id of plan.remove) { tx.objectStore(META).delete(id); tx.objectStore(DATA).delete(id); }
            tx.objectStore(META).add(plan.record);
            tx.objectStore(DATA).add({ id: plan.record.id, text: plan.text });
            result(plan.result);
          });
        }),
        remove: id => transaction('readwrite', tx => {
          tx.objectStore(META).delete(id); tx.objectStore(DATA).delete(id);
        }),
        close: () => db.close(),
      });
    };
  });
}

function snapshotInput({ study, label, reason = 'automatic' }, maximumBytes) {
  if (!study || typeof study !== 'object' || !study.project || typeof study.project.id !== 'string' || !study.project.id.trim() ||
      !Number.isSafeInteger(study.project.revision) || study.project.revision < 1) {
    throw new RecoveryStorageError('invalid-study', 'Recovery needs a study with a project ID and revision. Download the current study file and try again.');
  }
  if (!['automatic', 'before-replacement'].includes(reason)) throw new TypeError('Unknown recovery reason.');
  let text;
  try { text = JSON.stringify(study); }
  catch (error) { throw new RecoveryStorageError('invalid-study', 'This study could not be serialized for local recovery.', error); }
  // Blob measures UTF-8 without allocating an additional full encoded array.
  const byteLength = new Blob([text]).size;
  if (byteLength > maximumBytes) throw new RecoveryStorageError('too-large',
    `This study exceeds the ${Math.floor(maximumBytes / 1024 / 1024)} MiB local recovery limit. Earlier recovery copies were kept. Download a study file to keep your work.`);
  return { text, metadata: { projectId: study.project.id, revision: study.project.revision,
    label: String(label ?? study.name ?? 'Untitled study').slice(0, 250), reason, byteLength } };
}

function retention(records, added, limits) {
  const groups = new Map();
  for (const record of [...records, added]) {
    if (!groups.has(record.projectId)) groups.set(record.projectId, []);
    groups.get(record.projectId).push(record);
  }
  const eligible = [];
  for (const group of groups.values()) {
    group.sort(newestFirst);
    const checkpoint = group.find(record => record.reason === 'before-replacement');
    eligible.push(...group.filter(record => record !== checkpoint).slice(0, limits.maxPerProject));
    if (checkpoint) eligible.push(checkpoint);
  }
  // A checkpoint survives the project's rolling window. The global count/byte
  // limits still age out old projects and checkpoints, newest successful writes first.
  eligible.sort(newestFirst);
  const keep = new Set(); let bytes = 0;
  for (const record of eligible) {
    if (keep.size < limits.maxRecords && bytes + record.byteLength <= limits.maxBytes) {
      keep.add(record.id); bytes += record.byteLength;
    }
  }
  return records.filter(record => !keep.has(record.id));
}

/**
 * Local rolling recovery: default five recent snapshots plus one latest
 * before-replacement checkpoint per project, within 12 total / 256 MiB.
 * Global limits can remove old projects; failed writes remove nothing.
 * Revisions are descriptive, not storage keys: older files and independent tabs
 * may legitimately save the same project/revision with different contents.
 *
 * storageFactory is an optional test adapter returning list/read/commit/remove/
 * close. commit(decide) must atomically apply decide(currentMetadata)'s plan.
 */
export function createRecoveryStore(options = {}) {
  const limits = {
    maxPerProject: positiveInteger(options.maxPerProject ?? 5, 'maxPerProject'),
    maxRecords: positiveInteger(options.maxRecords ?? 12, 'maxRecords'),
    maxBytes: positiveInteger(options.maxBytes ?? DEFAULT_BYTES, 'maxBytes'),
    maxStudyBytes: positiveInteger(options.maxStudyBytes ?? MAX_STUDY_BYTES, 'maxStudyBytes'),
  };
  if (limits.maxBytes < limits.maxStudyBytes) throw new TypeError('maxBytes must allow at least one maximum-size study.');
  const now = options.now ?? Date.now;
  const makeId = options.makeId ?? (() => globalThis.crypto?.randomUUID?.() ?? `recovery-${Date.now().toString(36)}-${++fallbackId}-${Math.random().toString(36).slice(2)}`);
  let opening, queue = Promise.resolve(), closed = false;
  function storage() {
    if (!opening) opening = Promise.resolve().then(() => options.storageFactory ? options.storageFactory()
      : openIndexedDB('indexedDB' in options ? options.indexedDB : globalThis.indexedDB,
        options.databaseName ?? 'panel-workbench-recovery-v1')).catch(error => { opening = null; throw error; });
    return opening;
  }
  function enqueue(operation) {
    if (closed) return Promise.reject(new RecoveryStorageError('closed', 'Local recovery was closed. Reopen the tool or download a study file to keep your work.'));
    const task = queue.then(async () => operation(await storage())).catch(error => { throw storageError(error); });
    queue = task.catch(() => {});
    return task;
  }
  return {
    save(input) {
      let snapshot;
      // Capture at invocation, before waiting behind another large write.
      try { snapshot = snapshotInput(input, limits.maxStudyBytes); }
      catch (error) { return Promise.reject(error); }
      return enqueue(storage => storage.commit(records => {
        const sequence = Math.max(0, ...records.map(record => record.sequence)) + 1;
        const record = { id: makeId(), ...snapshot.metadata, savedAt: new Date(now()).toISOString(), sequence };
        const pruned = retention(records, record, limits);
        return { record, text: snapshot.text, remove: pruned.map(record => record.id),
          result: { ...record, prunedCount: pruned.length, prunedBytes: pruned.reduce((sum, item) => sum + item.byteLength, 0) } };
      }));
    },
    list: () => enqueue(async storage => (await storage.list()).sort(newestFirst)),
    read: id => enqueue(async storage => {
      const text = await storage.read(id);
      if (text === null || text === undefined) return null;
      try { return JSON.parse(text); }
      catch (error) { throw new RecoveryStorageError('corrupt', 'This recovery copy could not be read. Try another recovery copy or open a downloaded study file.', error); }
    }),
    remove: id => enqueue(storage => storage.remove(id)),
    close() {
      closed = true;
      return queue.then(async () => { if (opening) { try { (await opening).close(); } catch {} } });
    },
  };
}
