#!/usr/bin/env node
/*
 * Real Chromium storage checks, separate from the app's interaction/UI suite.
 * Requires an existing Playwright installation; adds no package dependency.
 *
 * Terminal 1: PORT=8794 HOST=127.0.0.1 node server.mjs
 * Terminal 2: node scripts/check-recovery-browser.cjs http://127.0.0.1:8794/
 *
 * Optional environment variables:
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright
 * CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chrome
 * RECOVERY_PAYLOAD_MIB=32 (integer 1–120; default 32)
 *
 * Pass a deployed demo directory URL to check its served modules instead.
 * A blank same-origin harness avoids loading the application or local examples.
 * All records are synthetic. Unique test databases are removed in finally.
 * This verifies actual IndexedDB persistence/transactions, not physical disk
 * durability, browser-eviction resistance, app restore UX or backup downloads.
 */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { homedir } = require('node:os');

const usage = 'Usage: node scripts/check-recovery-browser.cjs [http://127.0.0.1:8794/]\nSee this script header for Playwright, Chromium and payload-size options.';
if (process.argv.includes('--help')) { console.log(usage); process.exit(0); }
if (process.argv.length > 3) { console.error(usage); process.exit(1); }
let base;
try {
  base = new URL(process.argv[2] || 'http://127.0.0.1:8787/');
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Use an HTTP(S) demo URL.');
  if (base.pathname.endsWith('.html')) base = new URL('./', base);
  else if (!base.pathname.endsWith('/')) base.pathname += '/';
  base.search = ''; base.hash = '';
} catch (error) { console.error(`${error.message}\n${usage}`); process.exit(1); }
const payloadMiB = Number(process.env.RECOVERY_PAYLOAD_MIB || 32);
if (!Number.isInteger(payloadMiB) || payloadMiB < 1 || payloadMiB > 120) {
  console.error('RECOVERY_PAYLOAD_MIB must be an integer from 1 to 120.'); process.exit(1);
}
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || require.resolve('playwright', { paths: [process.cwd(), homedir()] })));
} catch {
  console.error('Playwright was not found. Set PLAYWRIGHT_MODULE to an existing Playwright installation. No repository dependency is required.'); process.exit(1);
}

async function main() {
  const moduleURL = new URL('project-recovery.js', base).href;
  const harnessURL = new URL('__recovery-browser-check__.html', base).href;
  const prefix = `panel-workbench-recovery-check-${randomUUID()}`;
  const databases = ['reload', 'tabs', 'retention', 'abort'].map(suffix => `${prefix}-${suffix}`);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext();
  await context.route(harnessURL, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>Synthetic recovery storage check</title>' }));
  const page = await context.newPage();
  const checks = [];
  const passed = (name, details) => { checks.push({ name, ...details }); console.log(`PASS ${name}${details ? ` ${JSON.stringify(details)}` : ''}`); };
  try {
    await page.goto(harnessURL);
    const before = await page.evaluate(async ({ moduleURL, databaseName, payloadMiB }) => {
      const { createRecoveryStore } = await import(moduleURL);
      const store = createRecoveryStore({ databaseName });
      const empty = await store.list();
      // The store accepts JSON source documents. This deliberately synthetic
      // transport payload stresses large storage; app schema tests are separate.
      const study = { format: 'sauna-cell-study', version: 6, name: 'Synthetic storage transport',
        project: { id: 'synthetic-shell', revision: 4, createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z' },
        rawModel: { vertices: [[0,0,0],[100,0,0],[0,100,0]], triangles: [[0,1,2]] },
        acceptedCorners: [[12,34,0],[56,78,0]], storageTestPayload: '0123abcd'.repeat(payloadMiB * 1024 * 1024 / 8) };
      const bytes = new TextEncoder().encode(JSON.stringify(study));
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
      const saved = await store.save({ study, label: 'Before test reload' });
      study.acceptedCorners[0][0] = 999;
      // Leave this connection open: navigation must close it and the following
      // page must discover the committed record through a new connection.
      globalThis.checkStore = store;
      return { emptyCount: empty.length, id: saved.id, byteLength: saved.byteLength, digest };
    }, { moduleURL, databaseName: databases[0], payloadMiB });
    assert.equal(before.emptyCount, 0);
    assert.ok(before.byteLength > payloadMiB * 1024 * 1024);
    await page.reload();
    const after = await page.evaluate(async ({ moduleURL, databaseName, id }) => {
      const { createRecoveryStore } = await import(moduleURL);
      const store = createRecoveryStore({ databaseName });
      const list = await store.list(), study = await store.read(id);
      const bytes = new TextEncoder().encode(JSON.stringify(study));
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
      await store.close();
      return { count: list.length, revision: study.project.revision, corner: study.acceptedCorners[0][0], digest };
    }, { moduleURL, databaseName: databases[0], id: before.id });
    assert.equal(after.count, 1); assert.equal(after.revision, 4); assert.equal(after.corner, 12); assert.equal(after.digest, before.digest);
    passed('write, reload and read preserve the full synthetic document', { payloadMiB, storedBytes: before.byteLength });

    const second = await context.newPage(); await second.goto(harnessURL);
    for (const tab of [page, second]) await tab.evaluate(async ({ moduleURL, databaseName }) => {
      const { createRecoveryStore } = await import(moduleURL);
      globalThis.checkStore = createRecoveryStore({ databaseName });
    }, { moduleURL, databaseName: databases[1] });
    const writes = await Promise.all([page, second].map((tab, index) => tab.evaluate(async index => {
      const study = { project: { id: 'same-project', revision: 7 }, name: `Synthetic tab ${index}`,
        source: { corner: index ? [5,6,7] : [1,2,3] } };
      return checkStore.save({ study });
    }, index)));
    assert.notEqual(writes[0].id, writes[1].id);
    const concurrent = await page.evaluate(async () => {
      const rows = await checkStore.list();
      return { rows, studies: await Promise.all(rows.map(row => checkStore.read(row.id))) };
    });
    assert.equal(concurrent.rows.length, 2);
    assert.deepEqual(concurrent.rows.map(row => row.sequence), [2,1]);
    assert.deepEqual(concurrent.studies.map(study => study.project.revision), [7,7]);
    assert.deepEqual(concurrent.studies.map(study => study.source.corner).sort((a,b) => a[0] - b[0]), [[1,2,3],[5,6,7]]);
    for (const tab of [page, second]) await tab.evaluate(() => checkStore.close());
    await second.close();
    passed('two tabs retain distinct snapshots at the same project revision');

    const retained = await page.evaluate(async ({ moduleURL, databaseName }) => {
      const { createRecoveryStore } = await import(moduleURL);
      const store = createRecoveryStore({ databaseName, maxPerProject: 2, maxRecords: 4 });
      const study = (revision, id = 'shell') => ({ project: { id, revision }, name: `Synthetic ${id}`, shape: [[revision,0,0]] });
      const first = await store.save({ study: study(1), reason: 'before-replacement' });
      for (const revision of [2,3,4]) await store.save({ study: study(revision) });
      const checkpointWindow = (await store.list()).map(row => row.revision);
      const checkpointReadable = (await store.read(first.id)).project.revision;
      await store.save({ study: study(4), reason: 'before-replacement' });
      const newWindow = (await store.list()).map(row => row.revision), oldRemoved = await store.read(first.id) === null;
      const oldFile = await store.save({ study: study(1) });
      const reopenedRevision = (await store.read(oldFile.id)).project.revision;
      await store.save({ study: study(1, 'another-shell') });
      await store.save({ study: study(1, 'third-shell') });
      const final = await store.list(); await store.close();
      return { checkpointWindow, checkpointReadable, newWindow, oldRemoved, reopenedRevision, count: final.length, projects: final.map(row => row.projectId) };
    }, { moduleURL, databaseName: databases[2] });
    assert.deepEqual(retained.checkpointWindow, [4,3,1]); assert.equal(retained.checkpointReadable, 1);
    assert.deepEqual(retained.newWindow, [4,4,3]); assert.equal(retained.oldRemoved, true);
    assert.equal(retained.reopenedRevision, 1); assert.equal(retained.count, 4);
    assert.deepEqual(retained.projects.slice(0,2), ['third-shell', 'another-shell']);
    passed('rolling retention preserves the latest replacement checkpoint and accepts reopened old revisions');

    const rollback = await page.evaluate(async ({ moduleURL, databaseName }) => {
      const { createRecoveryStore } = await import(moduleURL);
      const store = createRecoveryStore({ databaseName, maxRecords: 1 });
      const make = revision => ({ project: { id: 'rollback-shell', revision }, name: 'Synthetic rollback', source: [revision] });
      const first = await store.save({ study: make(1) });
      const original = IDBObjectStore.prototype.add;
      let code;
      // Inject a quota-like request failure after pruning has queued deletes;
      // transaction abort/rollback itself runs in real Chromium IndexedDB.
      IDBObjectStore.prototype.add = function(value, ...args) {
        if (this.name === 'studies') throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
        return original.call(this, value, ...args);
      };
      try { await store.save({ study: make(2) }); }
      catch (error) { code = error.code; }
      finally { IDBObjectStore.prototype.add = original; }
      const rows = await store.list(), recovered = await store.read(first.id);
      const retry = await store.save({ study: make(2) });
      const final = await store.list(); await store.close();
      return { code, oldCount: rows.length, oldId: rows[0]?.id, expectedId: first.id,
        oldRevision: recovered?.project.revision, retriedRevision: retry.revision, finalCount: final.length };
    }, { moduleURL, databaseName: databases[3] });
    assert.equal(rollback.code, 'quota'); assert.equal(rollback.oldCount, 1); assert.equal(rollback.oldId, rollback.expectedId);
    assert.equal(rollback.oldRevision, 1); assert.equal(rollback.retriedRevision, 2); assert.equal(rollback.finalCount, 1);
    passed('real IndexedDB transaction rollback preserves old copies under an injected quota failure');
    console.log(JSON.stringify({ passed: checks.length, browser: browser.version(), baseURL: base.href,
      payloadMiB, limitations: 'Storage-only check; injected quota error, not real disk exhaustion. App UX and backup-file durability are separate.' }, null, 2));
  } finally {
    try {
      for (const tab of context.pages()) await tab.close();
      const cleanup = await context.newPage(); await cleanup.goto(harnessURL);
      await cleanup.evaluate(async names => {
        for (const name of names) await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = resolve; request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error(`Cleanup blocked for ${name}`));
        });
      }, databases);
    } catch (error) { console.error(`Test database cleanup: ${error.message}`); }
    await browser.close();
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
