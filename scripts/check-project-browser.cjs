// Integrated Chromium smoke check: real WebGL, workers, downloads and IndexedDB.
// Run from the repository with `node scripts/check-project-browser.cjs`.
// PANEL_BROWSER_URL may point at a served Pages build instead of starting the
// local demo server. Each run uses a fresh, isolated browser context.
// Optional external installation:
// PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_EXECUTABLE_PATH=/path/to/chromium node scripts/check-project-browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const reportPath = process.env.PANEL_BROWSER_REPORT || path.join(os.tmpdir(), 'panel-project-browser.json');
const screenshotPath = process.env.PANEL_BROWSER_SCREENSHOT || path.join(os.tmpdir(), 'panel-project-fitting.png');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  let server, browser, page;
  const errors = [], checks = [];
  const report = { startedAt: new Date().toISOString(), checks, errors };
  async function check(name, run) { const detail = await run(); checks.push({ name, ...detail }); console.log(`PASS ${name}`); }
  try {
    let url = process.env.PANEL_BROWSER_URL;
    if (!url) {
      const { createServer } = await import(pathToFileURL(path.join(root, 'server.mjs')).href);
      server = createServer({ demoRoot: path.join(root, 'demo'), privateRoot: await fs.mkdtemp(path.join(os.tmpdir(), 'panel-browser-empty-')) });
      const port = Number(process.env.PANEL_BROWSER_PORT || 8795);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      url = `http://127.0.0.1:${server.address().port}/`;
    }
    report.url = url;
    const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE;
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    page = await context.newPage();
    page.on('pageerror', error => { errors.push(error.stack || error.message); console.error(error.stack || error.message); });
    page.on('dialog', dialog => dialog.accept());
    page.setDefaultTimeout(20000);
    async function solved() {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        if (errors.length) throw new Error(`Browser error while calculating: ${errors.at(-1)}`);
        if (await page.evaluate(() => window.cellStudy?.state.solved && !window.cellStudy.state.busy && !window.cellStudy.state.pending)) return;
        await pause(100);
      }
      throw new Error(`Calculation did not finish: ${await page.locator('#status').innerText()}`);
    }
    const snapshot = () => page.evaluate(() => {
      const s = window.cellStudy.state;
      return { project: s.project, rawModel: s.rawModel, layout: s.layout, directBase: s.directBase, seeds: s.seeds,
        nextCellId: s.nextCellId, thickness: s.thickness, units: s.documentUnits, name: s.name, recoveryEnabled: s.recoveryEnabled };
    });
    // Read actual IDB stores directly: no recovery-module test adapter or mock.
    const recovery = () => page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('panel-workbench-recovery-v1', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('snapshots')) { db.close(); resolve([]); return; }
        const tx = db.transaction(['snapshots', 'studies'], 'readonly');
        let records = [], data = [];
        tx.objectStore('snapshots').getAll().onsuccess = event => { records = event.target.result; };
        tx.objectStore('studies').getAll().onsuccess = event => { data = event.target.result; };
        tx.oncomplete = () => { db.close(); resolve(records.sort((a, b) => b.sequence - a.sequence).map(record => ({ ...record, study: JSON.parse(data.find(item => item.id === record.id).text) }))); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }));
    async function waitForRecovery(predicate, label) {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const records = await recovery(), found = records.find(predicate);
        if (found) return found;
        await pause(100);
      }
      throw new Error(`Timed out waiting for ${label}: ${await page.locator('#project-status').innerText()}`);
    }
    async function download(control) {
      const event = page.waitForEvent('download');
      await page.locator(control).click();
      const file = await event, text = await fs.readFile(await file.path(), 'utf8');
      return { filename: file.suggestedFilename(), text, value: JSON.parse(text) };
    }
    function sameSource(actual, expected) {
      for (const key of ['rawModel', 'layout', 'directBase', 'seeds', 'nextCellId']) assert.deepEqual(actual[key], expected[key], key);
    }

    await page.goto(url);
    await solved();
    let initial, edited, saved;
    await check('startup leaves recovery storage empty', async () => {
      await pause(1100); // Longer than the real autosave debounce.
      initial = await snapshot();
      assert.equal(initial.recoveryEnabled, false);
      assert.deepEqual(await recovery(), []);
      return { projectRevision: initial.project.revision, panelCount: initial.layout.cells.length };
    });
    await check('stock edit advances the project and autosaves through real IndexedDB', async () => {
      await page.locator('.panel-shape-section > summary').click();
      await page.locator('#thickness').focus();
      await page.locator('#thickness').press('ArrowRight');
      await page.locator('#thickness').press('Tab');
      await page.waitForFunction(revision => window.cellStudy.state.project.revision > revision, initial.project.revision);
      await solved(); edited = await snapshot();
      assert.equal(edited.project.id, initial.project.id);
      assert.equal(edited.project.revision, initial.project.revision + 1);
      assert.equal(edited.thickness, initial.thickness + 5);
      sameSource(edited, initial);
      const record = await waitForRecovery(record => record.projectId === edited.project.id && record.revision === edited.project.revision && record.study.lastCalculation?.revision === edited.project.revision, 'completed edit autosave');
      sameSource(record.study, edited);
      assert.deepEqual(record.study.project, edited.project);
      return { projectId: edited.project.id, revision: edited.project.revision, bytes: record.byteLength };
    });
    await check('download contains the v6 identity, build and exact accepted source', async () => {
      await page.getByRole('tab', { name: 'File', exact: true }).click();
      saved = await download('#save-study');
      assert.equal(saved.value.version, 6);
      assert.deepEqual(saved.value.project, edited.project);
      sameSource(saved.value, edited);
      const build = await page.locator('#build-version').getAttribute('data-build') || 'Local development';
      assert.equal(saved.value.producer.build, build);
      assert.match(saved.filename, new RegExp(`-r${edited.project.revision}-study\\.json$`));
      report.build = build;
      return { filename: saved.filename, bytes: Buffer.byteLength(saved.text), sourceHash: digest(saved.value.layout) };
    });
    await check('reload automatically resumes the saved accepted project', async () => {
      const before = (await recovery()).map(record => record.id);
      await page.reload();
      await page.waitForFunction(id => window.cellStudy?.state.project?.id === id, edited.project.id);
      await solved();
      const current = await snapshot();
      assert.deepEqual(current.project, edited.project);
      sameSource(current, edited);
      assert.equal(current.thickness, edited.thickness);
      assert.equal(current.recoveryEnabled, true);
      assert.ok((await recovery()).some(record => before.includes(record.id)), 'the original recovery copy remains available');
      return { retainedCopies: before.length, resumedRevision: current.project.revision };
    });
    await check('explicit recovery restores project identity and source exactly', async () => {
      await page.locator('#recovery-open').click();
      await page.locator('#recovery-list .recovery-entry').first().getByRole('button', { name: 'Restore', exact: true }).click();
      await page.waitForFunction(id => window.cellStudy.state.project.id === id, edited.project.id);
      await solved();
      const restored = await snapshot();
      assert.deepEqual(restored.project, edited.project);
      sameSource(restored, edited);
      assert.equal(restored.thickness, edited.thickness);
      assert.equal(await page.locator('#recovery-dialog').evaluate(dialog => dialog.open), false);
      return { revision: restored.project.revision, sourceHash: digest(restored.layout) };
    });
    await check('feedback download excludes project names and raw geometry', async () => {
      const feedback = await download('#download-feedback');
      assert.ok(!feedback.text.includes(edited.name), 'project name must not enter a shareable report');
      const forbidden = new Set(['name', 'projectName', 'rawModel', 'vertices', 'positions', 'flatPositions', 'triangles', 'layout', 'directBase', 'seeds']);
      function inspect(value) {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) { assert.ok(!forbidden.has(key), `feedback contains ${key}`); inspect(child); }
      }
      inspect(feedback.value);
      assert.match(feedback.filename, /^panel-feedback-r\d+\.json$/);
      return { filename: feedback.filename, bytes: Buffer.byteLength(feedback.text) };
    });
    await check('fitting overlay displays in a real WebGL viewport', async () => {
      await page.getByRole('tab', { name: 'View', exact: true }).click();
      await page.locator('[data-view="flat"]').click();
      await page.locator('#show-fitting').check();
      await pause(300);
      const graphics = await page.locator('#viewport canvas').evaluate(canvas => {
        const gl = canvas.getContext('webgl2');
        return { width: canvas.width, height: canvas.height, version: gl?.getParameter(gl.VERSION), lost: gl?.isContextLost() };
      });
      assert.ok(graphics.width > 500 && graphics.height > 300);
      assert.match(graphics.version, /WebGL 2/);
      assert.equal(graphics.lost, false);
      assert.equal(await page.locator('#show-fitting').isChecked(), true);
      await page.screenshot({ path: screenshotPath });
      return { ...graphics, screenshot: screenshotPath };
    });
    await check('a future-format file cannot replace the open project', async () => {
      const before = await snapshot(), future = { ...saved.value, version: 999, name: 'Future project must not replace current work' };
      await page.locator('#study-file').setInputFiles({ name: 'future-project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(future)) });
      await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Could not open study:'));
      assert.match(await page.locator('#status').innerText(), /newer compatible Panel Workbench/);
      const after = await snapshot();
      assert.deepEqual(after.project, before.project); sameSource(after, before);
      return { retainedRevision: after.project.revision };
    });
    await check('changing source units checkpoints the old document before creating a new identity', async () => {
      const before = await snapshot();
      await page.getByRole('tab', { name: 'File', exact: true }).click();
      await page.locator('.model-settings > summary').click();
      await page.locator('#model-units').selectOption('cm');
      await page.waitForFunction(id => window.cellStudy.state.project.id !== id, before.project.id);
      await solved();
      const current = await snapshot();
      assert.equal(current.units, 'cm');
      assert.notEqual(current.project.id, before.project.id);
      const checkpoint = await waitForRecovery(record => record.projectId === before.project.id && record.reason === 'before-replacement', 'old source-unit checkpoint');
      assert.equal(checkpoint.study.units, before.units);
      assert.deepEqual(checkpoint.study.project, before.project);
      sameSource(checkpoint.study, before);
      assert.ok(Date.parse(checkpoint.savedAt) <= Date.parse(current.project.createdAt), 'old document must be saved before the new identity is created');
      const latest = await waitForRecovery(record => record.projectId === current.project.id && record.study.units === 'cm', 'new source-unit project autosave');
      assert.notEqual(latest.study.layout.source.signature, checkpoint.study.layout.source.signature);
      return { oldProjectId: before.project.id, newProjectId: current.project.id, checkpointUnits: checkpoint.study.units, newUnits: latest.study.units };
    });
    assert.deepEqual(errors, []);
    report.completedAt = new Date().toISOString();
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Browser durability checks passed. Report: ${reportPath}`);
  } catch (error) {
    report.failure = error.stack || error.message;
    if (page) {
      report.browserState = await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent,
        recovery: document.querySelector('#project-status')?.textContent, solved: window.cellStudy?.state.solved,
        busy: window.cellStudy?.state.busy, pending: !!window.cellStudy?.state.pending,
        revision: window.cellStudy?.state.project?.revision })).catch(() => null);
      await page.screenshot({ path: screenshotPath.replace(/\.png$/, '-failure.png') }).catch(() => {});
    }
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    throw error;
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
