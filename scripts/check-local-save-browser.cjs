// Real Chromium smoke check for local resume, opt-out and beforeunload warnings.
// Serve the demo or Pages build, then run:
// PANEL_BROWSER_URL=http://127.0.0.1:8797/ node scripts/check-local-save-browser.cjs
// Optional: PLAYWRIGHT_MODULE=/path/to/playwright,
// CHROMIUM_EXECUTABLE_PATH=/path/to/chromium, PANEL_LOCAL_SAVE_REPORT,
// PANEL_LOCAL_SAVE_SCREENSHOT. Each run uses a fresh browser profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const url = process.argv[2] || process.env.PANEL_BROWSER_URL || 'http://127.0.0.1:8797/';
const reportPath = process.env.PANEL_LOCAL_SAVE_REPORT || path.join(os.tmpdir(), 'panel-local-save-browser.json');
const screenshotPath = process.env.PANEL_LOCAL_SAVE_SCREENSHOT || path.join(os.tmpdir(), 'panel-local-save-browser.png');
const preferenceKey = 'panel-workbench:local-save:v1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourceKeys = ['rawModel', 'layout', 'directBase', 'seeds', 'nextCellId'];
const settingKeys = ['size', 'variation', 'randomSeed', 'straightness', 'thickness', 'roundover', 'carve', 'minimumThickness', 'flipOutside', 'pattern'];

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = { startedAt: new Date().toISOString(), url, browser: browser.version(), checks: [], errors: [], dialogs: [] };
  let page, dialogPolicy = 'accept';
  async function check(name, run) { const detail = await run(); report.checks.push({ name, ...detail }); console.log(`PASS ${name}`); }
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    page.on('dialog', dialog => {
      report.dialogs.push({ type: dialog.type(), action: dialogPolicy });
      const action = dialog.type() === 'beforeunload' && dialogPolicy === 'dismiss' ? dialog.dismiss() : dialog.accept();
      action.catch(error => report.errors.push(error.stack || error.message));
    });
    async function until(predicate, label, timeout = 30000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (report.errors.length) throw new Error(report.errors.at(-1));
        const result = await predicate();
        if (result) return result;
        await pause(100);
      }
      throw new Error(`Timed out waiting for ${label}: ${await page.locator('#project-status').innerText()}`);
    }
    const solved = () => until(() => page.evaluate(() => window.cellStudy?.state.solved && !cellStudy.state.busy && !cellStudy.state.pending), 'settled geometry', 90000);
    const snapshot = () => page.evaluate(({ sourceKeys, settingKeys }) => {
      const state = cellStudy.state;
      return { ...Object.fromEntries([...sourceKeys, ...settingKeys].map(key => [key, state[key]])),
        project: state.project, units: state.documentUnits, up: state.documentUp, name: state.name,
        view: state.view, camera: cellStudy.camera.position.toArray(), target: cellStudy.controls.target.toArray(),
        recoveryEnabled: state.recoveryEnabled, downloadedRevision: state.downloadedRevision };
    }, { sourceKeys, settingKeys });
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
        tx.oncomplete = () => {
          db.close();
          resolve(records.sort((a, b) => b.sequence - a.sequence).map(record => ({ ...record,
            study: JSON.parse(data.find(item => item.id === record.id).text) })));
        };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }));
    const recordIds = records => records.map(record => record.id).sort();
    const saved = current => until(async () => (await recovery()).find(record => record.projectId === current.project.id && record.revision === current.project.revision
      && record.study.thickness === current.thickness && record.study.view === current.view), 'current revision in real IndexedDB');
    async function unchangedStorage(ids) {
      // A negative assertion needs a quiet interval longer than the 700 ms
      // debounce; poll the database rather than infer success from UI text.
      const deadline = Date.now() + 1600;
      do { assert.deepEqual(recordIds(await recovery()), ids, 'disabled local saving must not add or replace snapshots'); await pause(100); } while (Date.now() < deadline);
    }
    function sameSource(actual, expected) {
      for (const key of sourceKeys) assert.deepEqual(actual[key], expected[key], key);
    }
    function sameProject(actual, expected) {
      sameSource(actual, expected); assert.deepEqual(actual.project, expected.project);
      for (const key of [...settingKeys, 'units', 'up', 'view', 'name']) assert.deepEqual(actual[key], expected[key], key);
      for (const key of ['camera', 'target']) for (let axis = 0; axis < 3; axis++) {
        assert.ok(Math.abs(actual[key][axis] - expected[key][axis]) < 1e-7, `${key}[${axis}] must survive resume`);
      }
    }
    async function changeThickness({ wait = true } = {}) {
      const before = await snapshot();
      const section = page.locator('.panel-shape-section');
      if (!await section.evaluate(element => element.open)) await section.locator(':scope > summary').click();
      const slider = page.locator('#thickness');
      await slider.focus(); await slider.press('ArrowRight'); await slider.press('Tab');
      await page.waitForFunction(revision => cellStudy.state.project.revision > revision, before.project.revision);
      if (wait) await solved();
      const after = await snapshot();
      assert.equal(after.project.id, before.project.id); assert.ok(after.thickness > before.thickness);
      sameSource(after, before);
      return after;
    }
    async function downloadStudy() {
      const download = page.waitForEvent('download'); await page.locator('#save-study').click();
      const file = await download, text = await fs.readFile(await file.path(), 'utf8');
      return { filename: file.suggestedFilename(), study: JSON.parse(text) };
    }

    await page.goto(url); await solved();
    let initial, edited, latest;
    await check('local saving defaults on without reviving an unrelated document', async () => {
      assert.equal(await page.locator('#local-save-enabled').isChecked(), true);
      initial = await snapshot(); assert.equal(initial.recoveryEnabled, false);
      assert.deepEqual(await recovery(), []);
      report.build = await page.locator('#build-version').getAttribute('data-build') || 'Local development';
      return { revision: initial.project.revision, panelCount: initial.layout.cells.length };
    });
    await check('accepted edits persist exact source, settings, view and camera in IndexedDB', async () => {
      // A real right-button pan changes the saved camera without moving cells.
      const box = await page.locator('#viewport canvas').boundingBox();
      await page.mouse.move(box.x + box.width * .65, box.y + box.height * .5);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(box.x + box.width * .65 + 35, box.y + box.height * .5 + 20, { steps: 6 });
      await page.mouse.up({ button: 'right' });
      let previous = await snapshot(), stable = 0;
      await until(async () => {
        const current = await snapshot();
        stable = ['camera', 'target'].every(key => current[key].every((value, i) => Math.abs(value - previous[key][i]) < 1e-9)) ? stable + 1 : 0;
        previous = current; return stable >= 3;
      }, 'camera motion to settle');
      edited = await changeThickness();
      assert.notDeepEqual(edited.camera, initial.camera, 'the camera restoration assertion must exercise a changed camera');
      latest = await saved(edited); sameProject(latest.study, edited);
      assert.equal(latest.study.version, 6);
      await until(async () => /saved/i.test(await page.locator('#project-status').innerText()), 'saved status');
      return { projectId: edited.project.id, revision: edited.project.revision, sourceHash: digest(edited.layout), view: edited.view, bytes: latest.byteLength };
    });
    await check('unsaved portable revision still warns before leaving after a local autosave', async () => {
      await page.locator('#local-save-enabled').focus();
      const count = report.dialogs.length; dialogPolicy = 'dismiss';
      const navigation = page.reload({ timeout: 20000 }).then(() => null, error => error);
      await until(() => report.dialogs.length > count, 'real beforeunload dialog');
      assert.equal(report.dialogs.at(-1).type, 'beforeunload');
      assert.equal(report.dialogs.at(-1).action, 'dismiss');
      assert.ok(await navigation, 'dismissed beforeunload must abort navigation');
      sameProject(await snapshot(), edited);
      dialogPolicy = 'accept';
      return { dismissed: true, keptRevision: edited.project.revision };
    });
    await check('a downloaded revision reloads without warning and automatically resumes', async () => {
      const file = await downloadStudy(); sameProject(file.study, edited);
      assert.equal((await snapshot()).downloadedRevision, edited.project.revision);
      const count = report.dialogs.length;
      await page.reload(); await solved();
      await until(() => page.evaluate(id => cellStudy.state.project.id === id, edited.project.id), 'automatic project resume');
      await solved();
      sameProject(await snapshot(), edited);
      assert.equal(report.dialogs.length, count, 'a downloaded, unchanged revision should not warn before reload');
      assert.equal(await page.locator('#local-save-enabled').isChecked(), true);
      return { filename: file.filename, resumedProjectId: edited.project.id, resumedRevision: edited.project.revision };
    });
    await check('opting out cancels a pending save and suppresses subsequent accepted edits', async () => {
      // Let any resume-time derived summary settle before recording the baseline.
      await saved(await snapshot());
      const ids = recordIds(await recovery());
      await changeThickness({ wait: false });
      await page.locator('#local-save-enabled').uncheck();
      await until(async () => /off|disabled/i.test(await page.locator('#project-status').innerText()), 'local-saving off status');
      await solved(); await unchangedStorage(ids);
      await changeThickness(); await unchangedStorage(ids);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), preferenceKey), 'false');
      return { retainedCopies: ids.length, unsavedRevision: (await snapshot()).project.revision };
    });
    await check('turning local saving back on persists the current accepted project', async () => {
      const current = await snapshot();
      await page.locator('#local-save-enabled').check();
      latest = await saved(current); sameProject(latest.study, current);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), preferenceKey), 'true');
      return { projectId: current.project.id, revision: current.project.revision };
    });
    await check('a persisted opt-out starts the gallery and keeps old copies without auto-opening them', async () => {
      const previous = await snapshot();
      await page.locator('#local-save-enabled').uncheck();
      const ids = recordIds(await recovery());
      await page.reload(); await solved();
      const current = await snapshot();
      assert.notEqual(current.project.id, previous.project.id);
      assert.equal(current.recoveryEnabled, false);
      assert.equal(current.thickness, initial.thickness);
      assert.equal(await page.locator('#local-save-enabled').isChecked(), false);
      await unchangedStorage(ids);
      return { retainedCopies: ids.length, oldProjectWasNotResumed: true };
    });
    await check('a malformed saved preference warns and resumes using the default-on setting', async () => {
      await page.evaluate(key => localStorage.setItem(key, 'not-a-boolean'), preferenceKey);
      await page.reload(); await solved();
      await until(() => page.evaluate(id => cellStudy.state.project.id === id, latest.projectId), 'default-on resume after malformed preference');
      await solved();
      const current = await snapshot();
      sameProject(current, latest.study);
      assert.equal(current.recoveryEnabled, true);
      assert.equal(await page.locator('#local-save-enabled').isChecked(), true, 'invalid preference uses the documented on default');
      const note = await page.locator('#local-save-note').innerText();
      assert.match(note, /invalid|could not.*read|unrecognized/i);
      assert.equal(await page.locator('#local-save-note').isVisible(), true);
      await page.screenshot({ path: screenshotPath });
      return { warning: note, resumedProjectId: current.project.id, resumedRevision: current.project.revision, screenshot: screenshotPath };
    });
    await check('changing the source up-axis persists the resulting camera and resumes it exactly', async () => {
      const before = await snapshot(), up = before.up === 'y' ? 'z' : 'y';
      await page.getByRole('tab', { name: 'File', exact: true }).click();
      const settings = page.locator('.model-settings');
      if (!await settings.evaluate(element => element.open)) await settings.locator(':scope > summary').click();
      await page.locator('#model-up').selectOption(up);
      await page.waitForFunction(revision => cellStudy.state.project.revision > revision, before.project.revision);
      const changed = await snapshot();
      assert.equal(changed.up, up); sameSource(changed, before);
      latest = await saved(changed); sameProject(latest.study, changed);
      await page.reload();
      await until(() => page.evaluate(id => window.cellStudy?.state.project?.id === id, changed.project.id), 'orientation revision resume');
      await solved(); sameProject(await snapshot(), changed);
      return { up, revision: changed.project.revision, camera: changed.camera };
    });
    await check('a corrupt latest layout falls back to the gallery and keeps earlier copies for manual recovery', async () => {
      const goodStudy = latest.study;
      await context.close();
      const isolated = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
      page = await isolated.newPage(); page.setDefaultTimeout(20000);
      page.on('pageerror', error => report.errors.push(error.stack || error.message));
      page.on('dialog', dialog => dialog.accept().catch(error => report.errors.push(error.message)));
      await page.goto(url); await solved();
      const gallery = await snapshot();
      const inserted = await page.evaluate(async good => {
        const appURL = document.querySelector('script[type="module"][src]').src;
        const { createRecoveryStore } = await import(new URL('./project-recovery.js', appURL).href);
        const { readStudy } = await import(new URL('./study.js', appURL).href);
        const bad = structuredClone(good);
        bad.project.revision++;
        bad.project.updatedAt = new Date().toISOString();
        // Structurally valid v6 document: this changes no reference or schema.
        // Only the host's asynchronous source-geometry validator detects that
        // the saved layout signature no longer matches its embedded model.
        const signature = bad.layout.source.signature;
        bad.layout.source.signature = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
        const parsed = readStudy(bad);
        const store = createRecoveryStore(), now = Date.now();
        try {
          const earlier = await store.save({ study: good, reason: 'automatic', activeAt: now });
          const latest = await store.save({ study: parsed, reason: 'automatic', activeAt: now + 1 });
          return { goodId: earlier.id, badId: latest.id, badRevision: parsed.project.revision, parsedVersion: parsed.version };
        } finally { await store.close(); }
      }, goodStudy);
      assert.equal(inserted.parsedVersion, 6);
      await page.reload(); await solved();
      const fallback = await snapshot();
      assert.notEqual(fallback.project.id, goodStudy.project.id);
      assert.equal(fallback.recoveryEnabled, false);
      sameSource(fallback, gallery);
      const note = await page.locator('#local-save-note').innerText();
      assert.match(note, /could not be resumed/i); assert.match(note, /different source model/i);
      assert.equal(await page.locator('#local-save-note').isVisible(), true);
      assert.deepEqual(recordIds(await recovery()), [inserted.goodId, inserted.badId].sort());
      await page.locator('#recovery-open').click();
      await until(() => page.locator('#recovery-list .recovery-entry').count().then(count => count === 2), 'both retained recovery copies');
      await page.locator('#recovery-list .recovery-entry').nth(1).getByRole('button', { name: 'Restore', exact: true }).click();
      await until(() => page.evaluate(id => cellStudy.state.project.id === id, goodStudy.project.id), 'manual recovery of the earlier valid copy');
      await solved(); sameProject(await snapshot(), goodStudy);
      return { rejectedRevision: inserted.badRevision, retainedCopies: 2, earlierRevisionRestored: goodStudy.project.revision, warning: note };
    });
    assert.deepEqual(report.errors, []);
    report.completedAt = new Date().toISOString();
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Local-save browser checks passed. Report: ${reportPath}`);
  } catch (error) {
    report.failure = error.stack || error.message;
    if (page) {
      report.browserState = await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent,
        projectStatus: document.querySelector('#project-status')?.textContent, note: document.querySelector('#local-save-note')?.textContent,
        enabled: document.querySelector('#local-save-enabled')?.checked, solved: window.cellStudy?.state.solved,
        busy: window.cellStudy?.state.busy, pending: !!window.cellStudy?.state.pending,
        projectId: window.cellStudy?.state.project?.id, revision: window.cellStudy?.state.project?.revision })).catch(() => null);
      await page.screenshot({ path: screenshotPath.replace(/\.png$/i, '-failure.png') }).catch(() => {});
    }
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    throw error;
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
