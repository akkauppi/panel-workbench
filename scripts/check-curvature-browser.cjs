// Real Chromium/WebGL check using only a public synthetic flat-and-bent shell.
// Serve the demo or packaged Pages build, then run:
// PANEL_BROWSER_URL=http://127.0.0.1:8798/ node scripts/check-curvature-browser.cjs
// Optional external tools: PLAYWRIGHT_MODULE=/path/to/playwright,
// CHROMIUM_EXECUTABLE_PATH=/path/to/chromium. Artifacts default to /tmp;
// override with PANEL_CURVATURE_REPORT and PANEL_CURVATURE_SCREENSHOT.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const url = process.argv[2] || process.env.PANEL_BROWSER_URL || 'http://127.0.0.1:8798/';
const reportPath = process.env.PANEL_CURVATURE_REPORT || path.join(os.tmpdir(), 'panel-curvature-browser.json');
const screenshotPath = process.env.PANEL_CURVATURE_SCREENSHOT || path.join(os.tmpdir(), 'panel-curvature-browser.png');
const policy = { type: 'curvature', version: 1, minSizeMm: 100, maxSizeMm: 260 };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourceKeys = ['rawModel', 'layout', 'directBase', 'seeds', 'nextCellId'];

// Same public geometry as adaptive-regularized.test.mjs: equal-area halves,
// equal source-triangle spacing, and a continuous tangent at the transition.
function flatAndBend() {
  const vertices = [], triangles = [], nx = 30, ny = 20, radius = 300;
  for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
    const s = -600 + x * 40;
    vertices.push(s <= 0 ? [s, y * 40, 0] : [radius * Math.sin(s / radius), y * 40, radius * (1 - Math.cos(s / radius))]);
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const a = y * (nx + 1) + x; triangles.push([a, a + 1, a + nx + 2], [a, a + nx + 2, a + nx + 1]);
  }
  return { vertices, triangles };
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
        await pause(100);
      }
      throw new Error(`Timed out waiting for ${label}: ${await page.locator('#status').innerText()}`);
    }
    const solved = () => until(() => page.evaluate(() => window.cellStudy?.state.solved && !cellStudy.state.busy && !cellStudy.state.pending && !cellStudy.state.generating), 'settled source and panel calculation');
    const snapshot = () => page.evaluate(keys => {
      const s = cellStudy.state;
      return { ...Object.fromEntries(keys.map(key => [key, s[key]])), project: s.project, generatorPolicy: s.generatorPolicy ?? null,
        pattern: s.pattern, size: s.size, randomSeed: s.randomSeed, thickness: s.thickness,
        units: s.documentUnits, up: s.documentUp, view: s.view, history: s.history.length, future: s.future.length, modelRevision: s.modelRevision };
    }, sourceKeys);
    function sameSource(actual, expected, checkCounter = true) { for (const key of sourceKeys) if (checkCounter || key !== 'nextCellId') assert.deepEqual(actual[key], expected[key], key); }
    function sameArrangement(actual, expected, checkCounter = true) {
      sameSource(actual, expected, checkCounter);
      for (const key of ['pattern', 'size', 'randomSeed']) assert.deepEqual(actual[key], expected[key], key);
      assert.deepEqual(actual.generatorPolicy ?? null, expected.generatorPolicy ?? null);
    }
    async function waitForRevision(revision) {
      await until(() => page.evaluate(before => cellStudy.state.project.revision > before, revision), 'accepted project revision');
      await solved();
    }
    const regionMetrics = () => page.evaluate(() => {
      const s = cellStudy.state, cells = new Map((s.result.surfaceCells || s.result.cells).map(cell => [cell.id, cell]));
      const flat = s.seeds.filter(seed => seed.position[0] < -180).map(seed => cells.get(seed.id).area);
      const bend = s.seeds.filter(seed => seed.position[2] > 100).map(seed => cells.get(seed.id).area);
      const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      return { panels: cells.size, flatSamples: flat.length, bendSamples: bend.length,
        flatMedianAreaMm2: median(flat), bendMedianAreaMm2: median(bend), bendFlatAreaRatio: median(bend) / median(flat),
        coverageError: s.result.stats.coverageError, invalidFlat: s.cells.filter(cell => !cell.valid).length,
        invalidSolid: s.result.solids.filter(solid => !solid.valid).length };
    });
    const localSnapshot = current => page.evaluate(({ projectId, revision }) => new Promise((resolve, reject) => {
      const request = indexedDB.open('panel-workbench-recovery-v1', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('snapshots')) { db.close(); resolve(null); return; }
        const tx = db.transaction(['snapshots', 'studies'], 'readonly'); let result = null;
        tx.objectStore('snapshots').getAll().onsuccess = event => {
          const record = event.target.result.filter(item => item.projectId === projectId && item.revision === revision).sort((a, b) => b.sequence - a.sequence)[0];
          if (record) tx.objectStore('studies').get(record.id).onsuccess = event => { result = JSON.parse(event.target.result.text); };
        };
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }), { projectId: current.project.id, revision: current.project.revision });
    async function checkRibbonGeometry() {
      const geometry = await page.evaluate(() => {
        const rect = element => element.getBoundingClientRect().toJSON();
        const group = document.querySelector('#curvature-sizing-control');
        const guidance = document.querySelector('#pattern-help').closest('.ribbon-group');
        return { viewportWidth: innerWidth, group: rect(group),
          content: rect(group.querySelector('.ribbon-group-content')), caption: rect(group.querySelector('.ribbon-group-caption')),
          inputs: ['curvature-min-size', 'curvature-max-size'].map(id => ({ id, ...rect(document.getElementById(id)) })),
          guidanceContent: rect(guidance.querySelector('.ribbon-group-content')),
          guidanceCaption: rect(guidance.querySelector('.ribbon-group-caption')),
          guidance: ['pattern-help', 'size-help', 'generation-help'].map(id => {
            const element = document.getElementById(id), range = document.createRange(); range.selectNodeContents(element);
            return { id, text: element.textContent, ...range.getBoundingClientRect().toJSON() };
          }) };
      });
      const tolerance = 1;
      assert.ok(geometry.group.left >= -tolerance && geometry.group.right <= geometry.viewportWidth + tolerance,
        'the complete curvature-controls group must fit in the viewport');
      for (const input of geometry.inputs) {
        assert.ok(input.bottom <= geometry.caption.top + tolerance, `${input.id} overlaps its group caption`);
        assert.ok(input.top >= geometry.content.top - tolerance && input.bottom <= geometry.content.bottom + tolerance,
          `${input.id} must remain inside the group content`);
      }
      for (const text of geometry.guidance) {
        assert.ok(text.top >= geometry.guidanceContent.top - tolerance && text.bottom <= geometry.guidanceContent.bottom + tolerance,
          `${text.id} must fit vertically inside the guidance content`);
        assert.ok(text.left >= geometry.guidanceContent.left - tolerance && text.right <= geometry.guidanceContent.right + tolerance,
          `${text.id} must fit horizontally inside the guidance content`);
        assert.ok(text.bottom <= geometry.guidanceCaption.top + tolerance, `${text.id} overlaps the guidance caption`);
      }
      return { ...geometry, inputChecks: geometry.inputs.length, guidanceChecks: geometry.guidance.length, viewportChecks: 1 };
    }

    await page.goto(url); await solved();
    report.build = await page.locator('#build-version').getAttribute('data-build') || 'Local development';
    let uniform, adaptive, edited, savedFile, uniformMetrics, adaptiveMetrics;
    await check('public synthetic OBJ imports in millimetres with Z up', async () => {
      const model = flatAndBend();
      const obj = [...model.vertices.map(point => `v ${point.join(' ')}`), ...model.triangles.map(face => `f ${face.map(index => index + 1).join(' ')}`)].join('\n');
      await page.locator('#mesh-file').setInputFiles({ name: 'Synthetic-flat-and-bend.obj', mimeType: 'text/plain', buffer: Buffer.from(obj) });
      await until(() => page.evaluate(() => cellStudy.state.name === 'Synthetic-flat-and-bend'), 'OBJ import'); await solved();
      await page.getByRole('tab', { name: 'File', exact: true }).click();
      const details = page.locator('.model-settings');
      if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
      await page.locator('#model-up').selectOption('z');
      const imported = await snapshot();
      assert.deepEqual(imported.rawModel.vertices, model.vertices); assert.deepEqual(imported.rawModel.triangles, model.triangles);
      assert.equal(imported.units, 'mm'); assert.equal(imported.up, 'z');
      return { vertices: model.vertices.length, triangles: model.triangles.length };
    });
    await check('a uniform Regularized baseline uses 260 mm and regularity 0.7', async () => {
      // The import's automatically bounded size slider can be narrower than
      // this comparison's 260 mm target. Prepare a synthetic document with the
      // served public generator/writer and open it through the normal file UI.
      // No app state or DOM constraints are modified by the browser test.
      const baseline = await page.evaluate(() => (async () => {
        const appURL = document.querySelector('script[type="module"][src]').src;
        const [{ resolveSourceLayout }, { createStudy }] = await Promise.all([
          import(new URL('./design.js', appURL).href), import(new URL('./study.js', appURL).href),
        ]);
        const rawModel = structuredClone(cellStudy.state.rawModel);
        const input = { size: 260, variation: .3, randomSeed: 7, pattern: { type: 'regularized', angle: 0, frequency: 2, regularity: .7 },
          generatorPolicy: null, seeds: [], mergeGroups: [], cornerEdits: [], layout: null, directBase: null };
        const generated = resolveSourceLayout(rawModel, input);
        return createStudy({ ...input, rawModel, name: 'Synthetic curvature browser fixture', view: 'surface',
          seeds: generated.seeds, layout: generated.layout }, { units: 'mm', up: 'z',
          camera: cellStudy.camera.position.toArray(), target: cellStudy.controls.target.toArray() });
      })());
      await page.locator('#study-file').setInputFiles({ name: 'synthetic-uniform260-study.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(baseline)) });
      await until(() => page.evaluate(id => cellStudy.state.project.id === id, baseline.project.id), 'uniform baseline open'); await solved();
      uniform = await snapshot();
      assert.equal(uniform.size, 260); assert.equal(uniform.generatorPolicy, null); assert.equal(uniform.pattern.regularity, .7);
      assert.equal(uniform.pattern.type, 'regularized'); uniformMetrics = await regionMetrics();
      assert.ok(uniformMetrics.coverageError < 1e-8);
      await page.getByRole('tab', { name: 'Layout', exact: true }).click();
      return { ...uniformMetrics, sourceHash: digest(uniform.layout), setup: 'public generator + normal study file import' };
    });
    await check('adaptive controls stay staged until New arrangement is chosen', async () => {
      await page.locator('#curvature-sizing').check();
      await page.locator('#curvature-min-size').fill('100'); await page.locator('#curvature-max-size').fill('260');
      const staged = await snapshot(); sameArrangement(staged, uniform); assert.deepEqual(staged.project, uniform.project);
      assert.equal(staged.history, uniform.history);
      const event = page.waitForEvent('download'); await page.locator('#save-study').click();
      const file = await event, study = JSON.parse(await fs.readFile(await file.path(), 'utf8'));
      sameArrangement(study, uniform);
      assert.equal('generatorPolicy' in study, false); assert.equal(study.requiredFeatures.includes('curvature-sizing-v1'), false);
      return { acceptedPolicyUnchanged: true, stagedMin: 100, stagedMax: 260 };
    });
    await check('New arrangement applies gradual curvature density through the real worker', async () => {
      await page.locator('#regenerate').click(); await waitForRevision(uniform.project.revision);
      adaptive = await snapshot(); adaptiveMetrics = await regionMetrics();
      assert.deepEqual(adaptive.generatorPolicy, policy); assert.deepEqual(adaptive.layout.recipe.generatorPolicy, policy);
      assert.equal(adaptive.pattern.type, 'regularized'); assert.equal(adaptive.pattern.regularity, .7);
      assert.notDeepEqual(adaptive.layout, uniform.layout);
      assert.ok(adaptiveMetrics.flatSamples >= 3 && adaptiveMetrics.bendSamples >= 8);
      assert.ok(adaptiveMetrics.bendFlatAreaRatio < .55, 'cells well inside the bend must have a smaller median area than cells on the flat half');
      assert.ok(adaptiveMetrics.coverageError < 1e-8);
      assert.ok(adaptiveMetrics.panels <= 240);
      return { ...adaptiveMetrics, sourceHash: digest(adaptive.layout), policy };
    });
    await check('Undo and Redo restore exact uniform and adaptive layouts and controls', async () => {
      await page.locator('#undo-move').click(); await waitForRevision(adaptive.project.revision);
      const undone = await snapshot(); sameArrangement(undone, uniform, false);
      assert.equal(undone.nextCellId, adaptive.nextCellId, 'Undo must retain reserved panel IDs outside geometry history');
      assert.equal(await page.locator('#curvature-sizing').isChecked(), false);
      await page.locator('#redo-edit').click(); await waitForRevision(undone.project.revision);
      const redone = await snapshot(); sameArrangement(redone, adaptive);
      assert.equal(await page.locator('#curvature-sizing').isChecked(), true);
      assert.equal(Number(await page.locator('#curvature-min-size').inputValue()), 100);
      assert.equal(Number(await page.locator('#curvature-max-size').inputValue()), 260);
      adaptive = redone;
      return { uniformSourceHash: digest(uniform.layout), adaptiveSourceHash: digest(adaptive.layout) };
    });
    await check('stock editing preserves adaptive source and saves its required feature', async () => {
      const details = page.locator('.panel-shape-section');
      if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
      await page.locator('#thickness').focus(); await page.locator('#thickness').press('ArrowRight'); await page.locator('#thickness').press('Tab');
      await waitForRevision(adaptive.project.revision); edited = await snapshot();
      sameArrangement(edited, adaptive); assert.ok(edited.thickness > adaptive.thickness);
      const event = page.waitForEvent('download'); await page.locator('#save-study').click();
      const file = await event, text = await fs.readFile(await file.path(), 'utf8');
      savedFile = { text, filename: file.suggestedFilename(), study: JSON.parse(text) };
      assert.equal(savedFile.study.version, 6); assert.ok(savedFile.study.requiredFeatures.includes('curvature-sizing-v1'));
      sameArrangement(savedFile.study, edited); assert.deepEqual(savedFile.study.project, edited.project);
      assert.equal(savedFile.study.thickness, edited.thickness);
      const local = await until(() => localSnapshot(edited), 'adaptive revision in real IndexedDB');
      sameArrangement(local, edited); assert.ok(local.requiredFeatures.includes('curvature-sizing-v1'));
      return { filename: savedFile.filename, revision: edited.project.revision, thicknessMm: edited.thickness };
    });
    await check('saved-file reopening and automatic resume retain exact policy, source and IDs', async () => {
      const modelRevision = edited.modelRevision;
      await page.locator('#study-file').setInputFiles({ name: savedFile.filename, mimeType: 'application/json', buffer: Buffer.from(savedFile.text) });
      await until(() => page.evaluate(revision => cellStudy.state.modelRevision > revision, modelRevision), 'manual adaptive study open'); await solved();
      let current = await snapshot(); sameArrangement(current, edited); assert.deepEqual(current.project, edited.project);
      assert.equal(current.thickness, edited.thickness);
      await until(() => localSnapshot(current), 'reopened adaptive project recovery copy');
      await page.reload();
      await until(() => page.evaluate(id => window.cellStudy?.state.project?.id === id, edited.project.id), 'automatic adaptive resume'); await solved();
      current = await snapshot(); sameArrangement(current, edited); assert.deepEqual(current.project, edited.project);
      assert.equal(current.thickness, edited.thickness); assert.equal(current.up, 'z');
      return { resumedProjectId: current.project.id, revision: current.project.revision, sourceHash: digest(current.layout) };
    });
    await check('invalid ranges and over-budget requests leave the accepted project intact', async () => {
      await page.getByRole('tab', { name: 'Layout', exact: true }).click();
      const before = await snapshot(), failures = [];
      for (const [minimum, maximum, expected] of [[300, 260, /maximum.*at least the minimum/i], [10, 10, /240.cell limit/i]]) {
        await page.locator('#curvature-min-size').fill(String(minimum)); await page.locator('#curvature-max-size').fill(String(maximum));
        await page.locator('#regenerate').click();
        const message = await until(async () => {
          const text = await page.locator('#status').innerText(); return /Arrangement not applied:/.test(text) && expected.test(text) ? text : false;
        }, 'safe generation rejection');
        await solved(); const after = await snapshot();
        sameArrangement(after, before); assert.deepEqual(after.project, before.project); assert.equal(after.history, before.history);
        failures.push(message);
      }
      await page.locator('#curvature-min-size').fill('100'); await page.locator('#curvature-max-size').fill('260');
      return { failures, retainedSourceHash: digest(before.layout) };
    });
    await check('Cells view renders in real WebGL with the adaptive controls visible', async () => {
      await page.locator('[data-view="surface"]').click();
      await page.getByRole('tab', { name: 'Layout', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.locator('#fit-view').click();
      assert.equal(await page.locator('#curvature-range').isVisible(), true);
      const graphics = await page.locator('#viewport canvas').evaluate(canvas => {
        const gl = canvas.getContext('webgl2');
        return { width: canvas.width, height: canvas.height, version: gl?.getParameter(gl.VERSION), lost: gl?.isContextLost() };
      });
      assert.ok(graphics.width > 500 && graphics.height > 300); assert.match(graphics.version, /WebGL 2/); assert.equal(graphics.lost, false);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const ribbon = await checkRibbonGeometry();
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const screenshotSha256 = createHash('sha256').update(await fs.readFile(screenshotPath)).digest('hex');
      return { ...graphics, ribbon, screenshot: screenshotPath, screenshotSha256, ...adaptiveMetrics };
    });
    await check('adaptive controls and guidance remain clear at 1024 pixels', async () => {
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.locator('#fit-view').click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const ribbon = await checkRibbonGeometry(), narrowScreenshot = screenshotPath.replace(/\.png$/i, '-1024.png');
      await page.screenshot({ path: narrowScreenshot, fullPage: true });
      const screenshotSha256 = createHash('sha256').update(await fs.readFile(narrowScreenshot)).digest('hex');
      return { ribbon, screenshot: narrowScreenshot, screenshotSha256 };
    });
    assert.deepEqual(report.errors, []); report.completedAt = new Date().toISOString();
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Curvature browser checks passed. Report: ${reportPath}`);
  } catch (error) {
    report.failure = error.stack || error.message;
    if (page) {
      report.browserState = await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent,
        projectStatus: document.querySelector('#project-status')?.textContent,
        solved: window.cellStudy?.state.solved, busy: window.cellStudy?.state.busy, generating: window.cellStudy?.state.generating,
        revision: window.cellStudy?.state.project?.revision, policy: window.cellStudy?.state.generatorPolicy })).catch(() => null);
      await page.screenshot({ path: screenshotPath.replace(/\.png$/i, '-failure.png'), fullPage: true }).catch(() => {});
    }
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); throw error;
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
