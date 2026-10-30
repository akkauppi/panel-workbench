import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalSavePreference, LOCAL_SAVE_PREFERENCE_KEY } from './local-save-preference.js';

function storage(value = null) {
  return { value, reads: [], writes: [], failRead: false, failWrite: false, ignoreWrite: false,
    getItem(key) { this.reads.push(key); if (this.failRead) throw new Error('private implementation details'); return this.value; },
    setItem(key, value) { this.writes.push([key, value]); if (this.failWrite) throw new Error('private implementation details'); if (!this.ignoreWrite) this.value = value; },
  };
}

test('absent preference defaults on without writing or probing browser storage', () => {
  const target = storage(), preference = createLocalSavePreference({ storage: target });
  assert.deepEqual(preference.get(), { enabled: true, persisted: true, error: null });
  assert.deepEqual(target.reads, [LOCAL_SAVE_PREFERENCE_KEY]);
  assert.deepEqual(target.writes, []);
  preference.get(); preference.get();
  assert.equal(target.reads.length, 1, 'session reads do not overwrite a choice by rereading storage');
  assert.match(LOCAL_SAVE_PREFERENCE_KEY, /^panel-workbench:.*:v\d+$/);
});

test('saved on and off choices survive a new preference instance', () => {
  for (const enabled of [false, true]) {
    const target = storage(), preference = createLocalSavePreference({ storage: target });
    assert.deepEqual(preference.set(enabled), { enabled, persisted: true, error: null });
    assert.deepEqual(target.writes, [[LOCAL_SAVE_PREFERENCE_KEY, String(enabled)]]);
    assert.deepEqual(createLocalSavePreference({ storage: target }).get(), { enabled, persisted: true, error: null });
  }
});

test('malformed values default on with an explicit error and are not rewritten on startup', () => {
  for (const value of ['', '0', '1', 'FALSE', 'false ', '{"enabled":false}', 'null', undefined]) {
    const target = storage(); target.value = value;
    const preference = createLocalSavePreference({ storage: target }), current = preference.get();
    assert.equal(current.enabled, true); assert.equal(current.persisted, false);
    assert.equal(current.error.code, 'invalid-value'); assert.match(current.error.message, /invalid/);
    assert.deepEqual(target.writes, []);
    assert.deepEqual(preference.set(false), { enabled: false, persisted: true, error: null });
  }
});

test('a blocked storage getter or read never prevents this session from switching off', () => {
  const blocked = storage(); blocked.failRead = true;
  const inputs = [{ storage: null }, { storage: blocked }, { get storage() { throw new Error('SecurityError'); } }];
  for (const options of inputs) {
    const preference = createLocalSavePreference(options);
    assert.equal(preference.get().enabled, true);
    assert.equal(preference.get().persisted, false);
    assert.equal(preference.get().error.code, 'unavailable');
    const disabled = preference.set(false);
    assert.equal(disabled.enabled, false); assert.equal(disabled.persisted, false);
    assert.equal(disabled.error.code, 'write-failed'); assert.match(disabled.error.message, /off for this session.*reload/);
    assert.equal(preference.get().enabled, false);
    assert.doesNotMatch(disabled.error.message, /private implementation details|SecurityError/);
  }
});

test('failed and silently ignored writes preserve session control and report non-persistence', () => {
  for (const fail of ['failWrite', 'ignoreWrite']) {
    const target = storage('true'), preference = createLocalSavePreference({ storage: target });
    target[fail] = true;
    assert.equal(preference.set(false).enabled, false);
    assert.equal(preference.get().persisted, false);
    assert.equal(preference.get().error.code, 'write-failed');
    assert.equal(target.value, 'true');
    assert.equal(createLocalSavePreference({ storage: target }).get().enabled, true, 'a failed preference change is not claimed to survive reload');
    target[fail] = false;
    assert.deepEqual(preference.set(false), { enabled: false, persisted: true, error: null });
    assert.deepEqual(preference.set(true), { enabled: true, persisted: true, error: null });
  }
});

test('a later permission change can recover persistence without replacing the controller', () => {
  let target = null;
  const preference = createLocalSavePreference({ get storage() { return target; } });
  assert.equal(preference.set(false).persisted, false);
  target = storage();
  assert.deepEqual(preference.set(false), { enabled: false, persisted: true, error: null });
  assert.equal(target.value, 'false');
});

test('invalid setter inputs neither change the current choice nor write any data', () => {
  const target = storage('false'), preference = createLocalSavePreference({ storage: target });
  for (const value of [null, undefined, 0, 1, 'true', 'false', {}, { vertices: [[0, 0, 0]] }]) assert.throws(() => preference.set(value), TypeError);
  assert.deepEqual(preference.get(), { enabled: false, persisted: true, error: null });
  assert.deepEqual(target.writes, []);
});

test('default browser storage is accessed inside the error boundary with its proper receiver', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    assert.equal(createLocalSavePreference().get().error.code, 'unavailable');
    const target = storage('false');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: target });
    const preference = createLocalSavePreference();
    assert.equal(preference.get().enabled, false);
    assert.deepEqual(preference.set(true), { enabled: true, persisted: true, error: null });
    assert.deepEqual(target.writes, [[LOCAL_SAVE_PREFERENCE_KEY, 'true']]);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});
