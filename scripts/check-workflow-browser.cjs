// Real Chromium/WebGL regression for the production workflow. Uses a public,
// synthetic four-panel sheet, real controls, file imports and ZIP downloads.
// Run against the demo or packaged site with PANEL_BROWSER_URL. PLAYWRIGHT_MODULE
// and CHROMIUM_EXECUTABLE_PATH may point to tools installed outside the repo.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const url = process.argv[2] || process.env.PANEL_BROWSER_URL || 'http://127.0.0.1:8799/';
const reportPath = process.env.PANEL_WORKFLOW_REPORT || path.join(os.tmpdir(), 'panel-workflow-browser.json');
const screenshotPath = process.env.PANEL_WORKFLOW_SCREENSHOT || path.join(os.tmpdir(), 'panel-workflow-browser.png');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha256(Buffer.from(JSON.stringify(value)));

function unpack(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, 'download uses uncompressed ZIP entries');
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    assert.ok(!files.has(name), 'ZIP filenames are unique');
    assert.ok(start + size <= bytes.length, 'ZIP entry remains within the download');
    files.set(name, bytes.subarray(start, start + size)); offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50, 'ZIP contains a central directory');
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50, 'ZIP contains an end record');
  assert.equal(bytes.readUInt16LE(bytes.length - 12), files.size, 'ZIP directory lists every attachment');
  const manifest = JSON.parse(files.get('manifest.json'));
  for (const entry of manifest.files) {
    assert.ok(files.has(entry.name), `manifest attachment ${entry.name} exists`);
    assert.equal(files.get(entry.name).length, entry.bytes);
    assert.equal(sha256(files.get(entry.name)), entry.sha256, `hash identifies exact ${entry.name} bytes`);
  }
  assert.equal(manifest.files.length + 1, files.size, 'every attachment is hashed except the manifest itself');
  return { files, manifest };
}

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = { startedAt: new Date().toISOString(), url, browser: browser.version(), checks: [], errors: [] };
  let page;
  async function check(name, run) { const detail = await run(); report.checks.push({ name, ...detail }); console.log(`PASS ${name}`); }
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
    page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    page.on('dialog', dialog => dialog.accept().catch(error => report.errors.push(error.message)));
    async function until(predicate, label, timeout = 90000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (report.errors.length) throw new Error(report.errors.at(-1));
        const value = await predicate(); if (value) return value;
        await pause(60);
      }
      throw new Error(`Timed out waiting for ${label}: ${await page.locator('#status').innerText()}`);
    }
    const solved = () => until(() => page.evaluate(() => window.cellStudy?.state.solved && !cellStudy.state.busy && !cellStudy.state.pending && !cellStudy.state.generating), 'settled panels');
    const state = () => page.evaluate(() => {
      const s = cellStudy.state;
      return { rawModel: s.rawModel, layout: s.layout, directBase: s.directBase, seeds: s.seeds, nextCellId: s.nextCellId,
        project: s.project, projectLimits: s.projectLimits, protectedCellIds: s.protectedCellIds, panelOffsets: s.panelOffsets,
        checkpoints: s.checkpoints, lastHandoff: s.lastHandoff, lastCalculation: s.lastCalculation,
        history: s.history.length, future: s.future.length, cells: s.cells, solids: s.result?.solids,
        inspection: s.inspection, comparison: s.checkpointComparison && { id: s.checkpointComparison.id, name: s.checkpointComparison.name } };
    });
    const source = s => ({ rawModel: s.rawModel, layout: s.layout, directBase: s.directBase, seeds: s.seeds });
    const fitted = s => ({ cells: s.cells, solids: s.solids });
    async function tab(name) { await page.getByRole('tab', { name, exact: true }).click(); }
    async function select(id, shift = false) {
      const point = await page.evaluate(id => cellStudy.projectSeed(id), id); assert.ok(point, `panel ${id} has a projected position`);
      if (shift) await page.keyboard.down('Shift');
      await page.mouse.click(point.x, point.y);
      if (shift) await page.keyboard.up('Shift');
      await until(() => page.evaluate(id => cellStudy.state.selectedIds.includes(id), id), `selected panel ${id}`);
    }
    async function open(study) {
      await page.keyboard.press('Escape');
      const before = await page.evaluate(() => cellStudy.state.modelRevision);
      await page.locator('#study-file').setInputFiles({ name: 'public-workflow-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(study)) });
      await until(() => page.evaluate(before => cellStudy.state.modelRevision > before, before), 'study opened'); await solved(); await tab('Modify');
    }
    async function downloaded(button) {
      const event = page.waitForEvent('download', { timeout: 90000 }); await button.click();
      const file = await event; return { name: file.suggestedFilename(), bytes: await fs.readFile(await file.path()) };
    }
    async function saveStudy() { return JSON.parse((await downloaded(page.locator('#save-study'))).bytes); }
    async function offset(id, value) {
      await page.keyboard.press('Escape'); await tab('Modify');
      await page.locator('#offset-toggle').click(); await select(id);
      const before = await state(); await page.locator('#panel-offset').fill(String(value)); await page.locator('#panel-offset').press('Enter');
      await until(() => page.evaluate(revision => cellStudy.state.project.revision > revision, before.project.revision), 'offset accepted'); await solved();
    }
    async function checkpoints() { await tab('File'); await page.locator('#open-checkpoints').click(); await page.locator('#checkpoints-dialog').waitFor({ state: 'visible' }); }
    async function closeCheckpoints() { if (await page.locator('#checkpoints-dialog').isVisible()) await page.locator('#close-checkpoints').click(); }
    async function projectPoint(point) {
      return page.evaluate(point => {
        const p = new cellStudy.camera.position.constructor(...point).project(cellStudy.camera), r = document.querySelector('#viewport canvas').getBoundingClientRect();
        return { x: r.x + (p.x + 1) * r.width / 2, y: r.y + (1 - p.y) * r.height / 2 };
      }, point);
    }
    async function splitFirst() {
      await page.keyboard.press('Escape'); await tab('Modify'); await page.locator('[data-view="surface"]').click(); await select(0);
      await page.locator('#split-cell').click();
      const a = await projectPoint([250, 100, 0]), b = await projectPoint([250, 400, 0]);
      await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
      await until(() => page.evaluate(() => cellStudy.state.layout.cells.length === 5), 'split cell'); await solved();
    }
    async function limits(values) {
      const section = page.locator('#project-limits-section');
      if (!await section.evaluate(element => element.open)) await section.locator('summary').click();
      for (const [id, value] of Object.entries(values)) await page.locator(`#limit-${id}`).fill(String(value));
      const before = await state(); await page.locator('#apply-project-limits').click();
      await until(() => page.evaluate(revision => cellStudy.state.project.revision > revision, before.project.revision), 'limits accepted');
    }
    await page.goto(url); await solved();
    report.build = await page.locator('#build-version').evaluate(element => ({ content: element.dataset.build, builtAt: element.dataset.builtAt, label: element.textContent }));
    if (process.env.PANEL_EXPECTED_BUILD) assert.equal(report.build.content, process.env.PANEL_EXPECTED_BUILD);
    const fixture = await page.evaluate(() => (async () => {
      const appURL = document.querySelector('script[type="module"][src]').src;
      const [{ resolveSourceLayout }, { createStudy }] = await Promise.all([import(new URL('./design.js', appURL).href), import(new URL('./study.js', appURL).href)]);
      const rawModel = { vertices: [[0,0,0],[1000,0,0],[1000,1000,0],[0,1000,0]], triangles: [[0,1,2],[0,2,3]] };
      const input = { size: 500, variation: .3, randomSeed: 7, seeds: [[250,250,0],[750,250,0],[250,750,0],[750,750,0]].map((position,id) => ({id,position,weight:1})),
        mergeGroups: [], cornerEdits: [], panelOffsets: [], layout: null, directBase: null, thickness: 40, roundover: 2 };
      const generated = resolveSourceLayout(rawModel, input);
      return createStudy({ ...input, rawModel, name: 'PRIVATE_NAME_CANARY_PUBLIC_FIXTURE', view: 'flat', seeds: generated.seeds, layout: generated.layout },
        { units: 'mm', up: 'z', camera: [1600,-1700,2200], target: [500,500,0] });
    })());

    await check('project limits warn without changing geometry or blocking valid production', async () => {
      await open(fixture); const before = await state();
      await limits({ 'stock-width': 300, 'stock-height': 300, 'min-edge': 600, 'max-deviation': 0 });
      const after = await state(); assert.deepEqual(source(after), source(before)); assert.equal(digest(fitted(after)), digest(fitted(before)));
      assert.equal(await page.locator('#project-limit-list > li').count(), 4);
      assert.match(await page.locator('#project-limits-note').innerText(), /warning|validity/i);
      await tab('Export'); assert.equal(await page.locator('#export-rhino').isEnabled(), true); assert.equal(await page.locator('#export-handoff').isEnabled(), true);
      const saved = await saveStudy(); assert.deepEqual(saved.projectLimits, after.projectLimits); assert.ok(saved.requiredFeatures.includes('project-limits-v1'));
      await tab('Modify'); await page.locator('#undo-move').click(); await solved();
      assert.equal(await page.locator('#project-limit-list > li').count(), 0);
      assert.deepEqual(source(await state()), source(before));
      return { warningPanels: 4, productionEnabled: true, undoClearsLimits: true, retainedFeature: 'project-limits-v1' };
    });

    await check('source edit locks protect direct and neighbouring edits while leaving derived geometry unchanged', async () => {
      await open(fixture); await page.keyboard.press('Escape'); await select(0); const before = await state();
      await page.locator('#lock-selected').click(); const locked = await state();
      assert.deepEqual(locked.protectedCellIds, [0]); assert.deepEqual(source(locked), source(before)); assert.equal(digest(fitted(locked)), digest(fitted(before)));
      assert.match(await page.locator('#lock-selected').innerText(), /Unlock/);
      await page.locator('#offset-toggle').click(); assert.equal(await page.locator('#panel-offset').isDisabled(), true);
      await page.keyboard.press('Escape'); await page.locator('#edit-toggle').click(); await page.locator('[data-view="surface"]').click();
      const centre = await page.evaluate(() => cellStudy.projectCellCentre(1)); assert.ok(centre);
      await page.mouse.move(centre.x, centre.y); await page.mouse.down(); await page.mouse.move(centre.x + 35, centre.y - 12, { steps: 6 }); await page.mouse.up();
      await until(async () => /protected|locked|Unlock/i.test(await page.locator('#status').innerText()), 'neighbour edit rejection'); await solved();
      const rejected = await state(); assert.deepEqual(source(rejected), source(locked)); assert.equal(rejected.project.revision, locked.project.revision); assert.equal(rejected.history, locked.history);
      const saved = await saveStudy(); assert.deepEqual(saved.protectedCellIds, [0]); assert.ok(saved.requiredFeatures.includes('source-edit-locks-v1'));
      await page.locator('#unlock-all').click(); assert.deepEqual((await state()).protectedCellIds, []);
      await page.locator('#undo-move').click(); await solved(); assert.deepEqual((await state()).protectedCellIds, [0]);
      return { protectedIds: [0], neighbourEditRejected: true, noRejectedRevision: true, undoRestoresProtection: true };
    });

    await check('joint inspection and section controls leave the saved design untouched', async () => {
      await open(fixture); await page.keyboard.press('Escape'); await select(0); const before = await state();
      await tab('View'); await page.locator('#inspect-joint').click(); await page.locator('#inspection-tools').waitFor({ state: 'visible' });
      assert.ok((await state()).inspection.panelIds.includes(0)); assert.match(await page.locator('#inspection-measurements').innerText(), /Shortest edge.*Flatness.*joint mismatch/);
      await page.locator('#section-enabled').check();
      await page.locator('#section-position').focus(); await page.locator('#section-position').press('ArrowRight');
      assert.notEqual(Number(await page.locator('#section-position').inputValue()), 0, 'section slider responds to keyboard input');
      await page.locator('#section-camera').click(); await page.locator('#section-flip').click();
      await page.screenshot({ path: screenshotPath.replace(/\.png$/i, '-inspection.png'), fullPage: true });
      const during = await state(); assert.deepEqual(source(during), source(before)); assert.equal(digest(fitted(during)), digest(fitted(before))); assert.equal(during.project.revision, before.project.revision);
      await page.locator('#close-inspection').click(); assert.equal((await state()).inspection, null);
      return { isolatedPanelIds: during.inspection.panelIds, sectionChecked: true, unchangedRevision: before.project.revision };
    });

    let portable;
    await check('named checkpoints compare, restore and Undo without rewinding identity or retired IDs', async () => {
      await open(fixture); const baseline = await state(); await checkpoints();
      await page.locator('#checkpoint-name').fill('Approved baseline'); await page.locator('#save-checkpoint').click();
      await until(() => page.evaluate(() => cellStudy.state.checkpoints.length === 1), 'named checkpoint saved');
      await closeCheckpoints(); await splitFirst(); await offset(2, 10); const modified = await state();
      assert.ok(modified.nextCellId > baseline.nextCellId);
      await checkpoints(); const exported = await downloaded(page.locator('#checkpoint-list').getByRole('button', { name: 'Download', exact: true }));
      const checkpointFile = JSON.parse(exported.bytes); assert.deepEqual(checkpointFile.layout, baseline.layout); assert.deepEqual(checkpointFile.rawModel, baseline.rawModel); assert.ok(!checkpointFile.checkpoints?.length);
      await page.locator('#checkpoint-list').getByRole('button', { name: 'Compare', exact: true }).click();
      await page.locator('#checkpoints-dialog').waitFor({ state: 'hidden' });
      await until(() => page.evaluate(() => !!cellStudy.state.checkpointComparison), 'calculated checkpoint comparison');
      await until(async () => /recalculated|changed/i.test(await page.locator('#checkpoint-comparison-note').innerText()), 'comparison counts');
      assert.deepEqual(source(await state()), source(modified));
      const comparisonNote = await page.locator('#checkpoint-comparison-note').innerText();
      await page.locator('#end-checkpoint-comparison').click(); assert.equal((await state()).comparison, null);
      await checkpoints(); await page.locator('#checkpoint-list').getByRole('button', { name: 'Restore', exact: true }).click();
      await page.locator('#checkpoints-dialog').waitFor({ state: 'hidden' });
      await until(() => page.evaluate(() => cellStudy.state.layout.cells.length === 4), 'checkpoint restored'); await solved();
      const restored = await state(); assert.deepEqual(source(restored), source(baseline)); assert.deepEqual(restored.panelOffsets, []);
      assert.equal(restored.project.id, baseline.project.id); assert.ok(restored.project.revision > modified.project.revision); assert.equal(restored.nextCellId, modified.nextCellId); assert.equal(restored.checkpoints.length, 1);
      await tab('Modify'); await page.locator('#undo-move').click(); await solved();
      const undone = await state(); assert.deepEqual(source(undone), source(modified)); assert.deepEqual(undone.panelOffsets, modified.panelOffsets); assert.equal(undone.nextCellId, modified.nextCellId); assert.equal(undone.checkpoints.length, 1);
      portable = await saveStudy(); assert.ok(portable.requiredFeatures.includes('named-checkpoints-v1'));
      assert.equal((JSON.stringify(portable).match(/"rawModel":/g) || []).length, 1, 'one shared source mesh in portable study');
      await open(portable); const reopened = await state(); assert.equal(reopened.checkpoints.length, 1); assert.deepEqual(source(reopened), source(undone));
      await checkpoints(); await page.locator('#checkpoint-list').getByRole('button', { name: 'Delete', exact: true }).click();
      await until(() => page.evaluate(() => cellStudy.state.checkpoints.length === 0), 'explicit checkpoint deletion'); await closeCheckpoints();
      assert.deepEqual(source(await state()), source(undone));
      return { comparisonNote, checkpointDownloadBytes: exported.bytes.length, portableBytes: Buffer.byteLength(JSON.stringify(portable)), nextCellId: restored.nextCellId, restoredRevision: restored.project.revision, reopened: true };
    });

    await check('handoff ZIP preserves Rhino 6 bytes, study, hashes and changes since the previous export', async () => {
      await open(fixture); await limits({ 'stock-width': 300, 'stock-height': 300, 'min-edge': '', 'max-deviation': '' });
      await tab('Export'); const firstDownload = await downloaded(page.locator('#export-handoff')); const first = unpack(firstDownload.bytes);
      assert.deepEqual([...first.files.keys()].sort(), ['README.txt','manifest.json','model.3dm','panel-schedule.csv','study.json'].sort());
      assert.match(first.files.get('model.3dm').subarray(0,32).toString('ascii'), /3D Geometry File Format\s+60/);
      assert.equal(first.manifest.kind, 'production'); assert.equal(first.manifest.panels.length, 4); assert.equal(first.manifest.comparison.comparable, false);
      assert.equal(first.manifest.projectReview.warningPanelIds.length, 4);
      const bundled = JSON.parse(first.files.get('study.json')); assert.equal(bundled.lastHandoff.revision, first.manifest.project.revision); assert.equal(bundled.project.id, first.manifest.project.id);
      await until(() => page.evaluate(() => !!cellStudy.state.lastHandoff), 'handoff history saved');
      assert.deepEqual((await state()).lastHandoff, bundled.lastHandoff);
      await offset(2, 10); await tab('Export'); const secondDownload = await downloaded(page.locator('#export-handoff')); const second = unpack(secondDownload.bytes);
      assert.equal(second.manifest.comparison.comparable, true); assert.ok(second.manifest.comparison.changedIds.includes(2)); assert.equal(second.manifest.comparison.previousRevision, first.manifest.project.revision);
      const saved = await saveStudy(); assert.ok(saved.requiredFeatures.includes('handoff-history-v1'));
      await open(saved); await tab('Export'); const third = unpack((await downloaded(page.locator('#export-handoff'))).bytes);
      assert.equal(third.manifest.comparison.comparable, true); assert.deepEqual(third.manifest.comparison.changedIds, []); assert.equal(third.manifest.comparison.unchangedIds.length, 4);
      return { archiveVersion: 60, firstBytes: firstDownload.bytes.length, secondBytes: secondDownload.bytes.length, changedIds: second.manifest.comparison.changedIds, allFileHashesVerified: true, reopenedHistory: true };
    });

    await check('feedback downloads exclude geometry by default and add only explicitly chosen attachments', async () => {
      await open(portable); await page.keyboard.press('Escape'); await select(2); const captured = await state();
      await page.locator('#report-issue').click(); await page.locator('#feedback-dialog').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#feedback-screenshot').isChecked(), false); assert.equal(await page.locator('#feedback-study').isChecked(), false);
      await page.locator('#feedback-expected').fill('I expected the selected panel to stay easy to identify.');
      await page.locator('#feedback-actual').fill('The selected outline was difficult to see.');
      const privateDownload = await downloaded(page.locator('#download-issue')); const minimal = unpack(privateDownload.bytes);
      assert.deepEqual([...minimal.files.keys()].sort(), ['README.txt','feedback.json','manifest.json'].sort());
      const feedback = JSON.parse(minimal.files.get('feedback.json'));
      assert.deepEqual(feedback.attachments, { screenshot: false, study: false }); assert.equal(feedback.privacy.diagnosticGeometryIncluded, false);
      assert.equal(feedback.report.project.revision, captured.project.revision); assert.deepEqual(feedback.report.selectedIds, [2]);
      assert.ok(!privateDownload.bytes.includes(Buffer.from('PRIVATE_NAME_CANARY_PUBLIC_FIXTURE')));
      for (const key of ['rawModel','vertices','positions','layout','checkpoints']) assert.ok(!JSON.stringify(feedback.report).includes(`"${key}":`), `diagnostic excludes ${key}`);
      if (!await page.locator('#feedback-dialog').isVisible()) await page.locator('#report-issue').click();
      await page.locator('#feedback-screenshot').check(); await page.locator('#feedback-study').check();
      await page.locator('#feedback-preview').waitFor({ state: 'visible' });
      const optInDownload = await downloaded(page.locator('#download-issue')); const optIn = unpack(optInDownload.bytes);
      assert.deepEqual([...optIn.files.keys()].sort(), ['README.txt','feedback.json','manifest.json','study.json','view.png'].sort());
      assert.deepEqual([...optIn.files.get('view.png').subarray(0, 8)], [137,80,78,71,13,10,26,10]); assert.ok(optIn.files.get('view.png').length > 1000);
      const attached = JSON.parse(optIn.files.get('study.json')); const attachedFeedback = JSON.parse(optIn.files.get('feedback.json'));
      assert.equal(attached.project.id, attachedFeedback.report.project.id); assert.equal(attached.project.revision, attachedFeedback.report.project.revision);
      assert.deepEqual(attached.rawModel, captured.rawModel); assert.equal(attached.checkpoints.length, 1);
      if (await page.locator('#feedback-dialog').isVisible()) await page.locator('#close-feedback').click();
      await page.locator('#report-issue').click(); assert.equal(await page.locator('#feedback-screenshot').isChecked(), false); assert.equal(await page.locator('#feedback-study').isChecked(), false);
      await page.locator('#close-feedback').click();
      return { defaultFiles: [...minimal.files.keys()], optInFiles: [...optIn.files.keys()], screenshotBytes: optIn.files.get('view.png').length, capturedRevision: captured.project.revision, choicesResetOnReopen: true };
    });

    await check('workflow dialogs fit 1024 pixels and retain a working WebGL viewport', async () => {
      const layouts = [];
      for (const width of [1600,1024]) {
        await page.setViewportSize({ width, height: 1000 }); await checkpoints();
        const boxes = await page.evaluate(() => ['checkpoints-dialog','checkpoint-name','save-checkpoint','close-checkpoints'].map(id => {
          const r = document.getElementById(id).getBoundingClientRect(); return { id, left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height };
        }));
        for (const box of boxes) assert.ok(box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= 1000, `${box.id} fits ${width}px viewport`);
        if (width === 1024) await page.screenshot({ path: screenshotPath.replace(/\.png$/i, '-checkpoints-1024.png'), fullPage: true });
        await closeCheckpoints(); await page.locator('#report-issue').click();
        const feedback = await page.locator('#feedback-dialog').boundingBox(); assert.ok(feedback.x >= 0 && feedback.x + feedback.width <= width && feedback.y >= 0 && feedback.y + feedback.height <= 1000);
        if (width === 1024) await page.screenshot({ path: screenshotPath.replace(/\.png$/i, '-feedback-1024.png'), fullPage: true });
        await page.locator('#close-feedback').click();
        const output = width === 1600 ? screenshotPath : screenshotPath.replace(/\.png$/i, '-1024.png'); await page.screenshot({ path: output, fullPage: true }); layouts.push({ width, boxes, screenshot: output });
      }
      const gl = await page.locator('#viewport canvas').evaluate(canvas => { const gl = canvas.getContext('webgl2'); return { version: gl?.getParameter(gl.VERSION), lost: gl?.isContextLost() }; });
      assert.match(gl.version, /WebGL 2/); assert.equal(gl.lost, false);
      return { layouts, ...gl };
    });
    assert.deepEqual(report.errors, []); report.completedAt = new Date().toISOString();
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); console.log(`Workflow browser checks passed. Report: ${reportPath}`);
  } catch (error) {
    report.failure = error.stack || error.message;
    if (page) {
      report.state = await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent, checkpointStatus: document.querySelector('#checkpoint-status')?.textContent,
        feedbackStatus: document.querySelector('#feedback-status')?.textContent, selected: window.cellStudy?.state.selected, revision: window.cellStudy?.state.project?.revision, solved: window.cellStudy?.state.solved })).catch(() => null);
      await page.screenshot({ path: screenshotPath.replace(/\.png$/i, '-failure.png'), fullPage: true }).catch(() => {});
    }
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
