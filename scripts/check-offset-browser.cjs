// Real Chromium/WebGL workflow checks using a public four-panel planar sheet.
// Serve the demo, then run with PANEL_BROWSER_URL, PLAYWRIGHT_MODULE and
// CHROMIUM_EXECUTABLE_PATH when tools are installed outside this repository.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const url = process.argv[2] || process.env.PANEL_BROWSER_URL || 'http://127.0.0.1:8799/';
const reportPath = process.env.PANEL_OFFSET_REPORT || path.join(os.tmpdir(), 'panel-offset-browser.json');
const screenshotPath = process.env.PANEL_OFFSET_SCREENSHOT || path.join(os.tmpdir(), 'panel-offset-browser.png');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceKeys = ['rawModel', 'layout', 'directBase', 'seeds', 'nextCellId'];

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
        const result = await predicate(); if (result) return result;
        await pause(60);
      }
      throw new Error(`Timed out waiting for ${label}: ${await page.locator('#status').innerText()}`);
    }
    const solved = () => until(() => page.evaluate(() => window.cellStudy?.state.solved && !cellStudy.state.busy && !cellStudy.state.pending && !cellStudy.state.generating), 'settled panels');
    const snapshot = () => page.evaluate(keys => {
      const s = cellStudy.state;
      return { ...Object.fromEntries(keys.map(key => [key, s[key]])), panelOffsets: s.panelOffsets, project: s.project,
        history: s.history.length, future: s.future.length, selected: s.selected, selectedIds: s.selectedIds,
        view: s.view, modelRevision: s.modelRevision, modes: { offset: s.offsetMode, corner: s.cornerMode, split: s.splitMode, move: s.edit },
        cells: s.cells.map(c => ({ id: c.id, plane: c.plane, flatPositions: c.flatPositions, offsetReference: c.offsetReference, offsetMm: c.offsetMm, valid: c.valid, issues: c.issues })),
        solidInvalid: s.result?.solids?.filter(c => !c.valid).length };
    }, sourceKeys);
    function sameSource(actual, expected, counter = true) { for (const key of sourceKeys) if (counter || key !== 'nextCellId') assert.deepEqual(actual[key], expected[key], key); }
    function exactOffset(state, id, amount) {
      const c = state.cells.find(c => c.id === id), n = c.offsetReference.normal, o = c.offsetReference.origin;
      const shift = c.plane.origin.reduce((sum, value, axis) => sum + (value - o[axis]) * n[axis], 0);
      assert.ok(Math.abs(shift - amount) < 1e-6, `authored plane ${shift} must equal ${amount} mm`);
      assert.ok(c.plane.normal.reduce((sum, value, axis) => sum + value * n[axis], 0) > 1 - 1e-10);
      assert.equal(c.offsetMm, amount);
      return shift;
    }
    async function projectPoint(point) {
      return page.evaluate(point => {
        const p = new cellStudy.camera.position.constructor(...point).project(cellStudy.camera), r = document.querySelector('#viewport canvas').getBoundingClientRect();
        return { x: r.x + (p.x + 1) * r.width / 2, y: r.y + (1 - p.y) * r.height / 2 };
      }, point);
    }
    async function select(id, { shift = false } = {}) {
      const p = await page.evaluate(id => cellStudy.projectSeed(id), id);
      if (!p) throw new Error(`No projected panel ${id}`);
      if (shift) await page.keyboard.down('Shift');
      await page.mouse.click(p.x, p.y);
      if (shift) await page.keyboard.up('Shift');
      await until(() => page.evaluate(id => cellStudy.state.selectedIds.includes(id), id), `selected panel ${id}`);
    }
    async function apply(value, { wait = true } = {}) {
      const before = await snapshot();
      await page.locator('#panel-offset').fill(String(value)); await page.locator('#panel-offset').press('Enter');
      await until(() => page.evaluate(revision => cellStudy.state.project.revision > revision, before.project.revision), 'accepted offset');
      if (wait) await solved();
      return snapshot();
    }
    async function open(study) {
      const before = await page.evaluate(() => window.cellStudy?.state.modelRevision ?? 0);
      await page.locator('#study-file').setInputFiles({ name: 'public-offset-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(study)) });
      await until(() => page.evaluate(revision => cellStudy.state.modelRevision > revision, before), 'study open'); await solved();
      await page.getByRole('tab', { name: 'Modify', exact: true }).click();
    }
    async function activate(id = 0) {
      await page.getByRole('tab', { name: 'Modify', exact: true }).click();
      if (!await page.evaluate(() => cellStudy.state.offsetMode)) await page.locator('#offset-toggle').click();
      await select(id);
      await until(() => page.evaluate(() => !!cellStudy.projectOffsetHandle()), 'normal handle');
    }
    async function localCopy(current) {
      return page.evaluate(({ id, revision }) => new Promise((resolve, reject) => {
        const request = indexedDB.open('panel-workbench-recovery-v1', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('snapshots')) { db.close(); resolve(null); return; }
          const tx = db.transaction(['snapshots', 'studies'], 'readonly'); let value = null;
          tx.objectStore('snapshots').getAll().onsuccess = event => {
            const record = event.target.result.filter(r => r.projectId === id && r.revision === revision).sort((a, b) => b.sequence - a.sequence)[0];
            if (record) tx.objectStore('studies').get(record.id).onsuccess = event => { value = JSON.parse(event.target.result.text); };
          };
          tx.oncomplete = () => { db.close(); resolve(value); }; tx.onerror = () => reject(tx.error);
        };
      }), { id: current.project.id, revision: current.project.revision });
    }
    async function startDrag(dx = 0, dy = -20) {
      const p = await page.evaluate(() => cellStudy.projectOffsetHandle()); assert.ok(p);
      await page.mouse.move(p.x, p.y); await page.mouse.down();
      await until(() => page.evaluate(() => !cellStudy.controls.enabled), 'captured normal handle');
      const instruction = await page.locator('#status').innerText();
      await page.mouse.move(p.x + dx, p.y + dy, { steps: 3 });
      return { p, instruction, preview: Number(await page.locator('#panel-offset').inputValue()) };
    }
    async function rhinoDownload(repair = false) {
      const expected = await page.evaluate(() => ({ cells: cellStudy.state.cells, solids: cellStudy.state.result.solids, source: cellStudy.state.result.surfaceCells }));
      await page.getByRole('tab', { name: 'Export', exact: true }).click();
      const event = page.waitForEvent('download'); await page.locator(repair ? '#export-rhino-repair' : '#export-rhino').click();
      const file = await event, bytes = await fs.readFile(await file.path());
      assert.match(bytes.subarray(0, 32).toString('ascii'), /3D Geometry File Format\s+60/);
      const detail = await page.evaluate(({ bytes, expected, repair }) => (async () => {
        const appURL = document.querySelector('script[type="module"][src]').src;
        const { loadRhino } = await import(new URL('./rhino-runtime.js', appURL).href), rhino = await loadRhino();
        const doc = rhino.File3dm.fromByteArray(new Uint8Array(bytes));
        const require = (condition, message) => { if (!condition) throw new Error(message); };
        const matrix = t => Array.from({ length: 16 }, (_, i) => t[`m${Math.floor(i / 4)}${i % 4}`]);
        const transform = (m, p) => [0, 1, 2].map(r => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);
        let maximumVertexErrorMm = 0, maximumCandidateErrorMm = 0, verticesChecked = 0, outlinesChecked = 0, unresolved = 0;
        try {
          require(doc.archiveVersion === 60, 'Rhino 6 archive version');
          require(doc.settings().modelUnitSystem === rhino.UnitSystem.Millimeters, 'Rhino millimetre units');
          require(doc.instanceDefinitions().count === expected.cells.length, 'One definition per offset panel');
          const refs = [];
          for (let i = 0; i < doc.objects().count; i++) { const o = doc.objects().get(i), g = o.geometry(); if (g.objectType === rhino.ObjectType.InstanceReference) refs.push({ geometry: g, attributes: o.attributes() }); }
          require(refs.length === expected.cells.length * 2, 'Two linked placements per definition');
          for (let i = 0; i < doc.instanceDefinitions().count; i++) {
            const definition = doc.instanceDefinitions().get(i), id = Number(definition.name.slice(1)) - 1;
            const cell = expected.cells.find(c => c.id === id), solid = expected.solids.find(c => c.id === id);
            require(!!cell, 'Exported panel retains its stable name');
            const pair = refs.filter(ref => ref.geometry.parentIdefId === definition.id);
            require(pair.length === 2, 'Assembly and flat copy share a block definition');
            require(pair.every(ref => ref.attributes.name === definition.name), 'Both placements retain the same panel name');
            const placements = pair.map(ref => ref.attributes.getUserString('panel-workbench-placement')).sort();
            require(JSON.stringify(placements) === JSON.stringify(repair ? ['assembly', 'repair-layout'] : ['assembly', 'flat']), 'Expected placement kinds');
            const assembly = pair.find(ref => ref.attributes.getUserString('panel-workbench-placement') === 'assembly'), m = matrix(assembly.geometry.xform);
            const members = definition.getObjectIds().map(id => doc.objects().findId(id)).map(o => ({ geometry: o.geometry(), attributes: o.attributes() }));
            const mesh = members.find(member => member.geometry.objectType === rhino.ObjectType.Mesh).geometry;
            const representation = definition.getUserString('panel-workbench-representation');
            const original = repair && representation === 'source-patch' ? expected.source.find(c => c.id === id) : solid;
            require(mesh.vertices().count === original.positions.length, 'Complete original part or explicitly labelled source patch');
            for (let j = 0; j < mesh.vertices().count; j++) { const point = transform(m, mesh.vertices().point3dAt(j)); maximumVertexErrorMm = Math.max(maximumVertexErrorMm, Math.hypot(...point.map((v, axis) => v - original.positions[j][axis]))); verticesChecked++; }
            const curves = members.filter(member => member.geometry.objectType === rhino.ObjectType.Curve);
            require(curves.length === cell.loops.length, 'All panel outlines included');
            for (let j = 0; j < curves.length; j++) {
              const curve = curves[j].geometry; require(curve.isClosed, 'Closed outline'); outlinesChecked++;
              for (let k = 0; k < cell.loops[j].length; k++) {
                const p = curve.point(k);
                if (repair) { const world = transform(m, p), original = cell.flatPositions[cell.loops[j][k]]; maximumCandidateErrorMm = Math.max(maximumCandidateErrorMm, Math.hypot(...world.map((v, axis) => v - original[axis]))); }
                else require(Math.abs(p[2]) < 1e-7, 'Production cutting outline lies in its block bed plane');
              }
            }
            if (repair && definition.getUserString('panel-workbench-status') === 'unresolved') {
              unresolved++;
              const issues = JSON.parse(definition.getUserString('panel-workbench-flat-issues'));
              require(issues.some(message => /offset/.test(message)), 'Rhino repair keeps offset failure explanations');
            }
          }
          return { archiveVersion: doc.archiveVersion, definitions: doc.instanceDefinitions().count, references: refs.length,
            maximumVertexErrorMm, maximumCandidateErrorMm, verticesChecked, outlinesChecked, unresolved };
        } finally { doc.delete(); }
      })(), { bytes: [...bytes], expected, repair });
      assert.ok(detail.maximumVertexErrorMm < 1e-5); assert.ok(detail.maximumCandidateErrorMm < 1e-5);
      if (repair) assert.ok(detail.unresolved > 0);
      await page.getByRole('tab', { name: 'Modify', exact: true }).click();
      return { ...detail, filename: file.suggestedFilename(), bytes: bytes.length };
    }
    await page.goto(url); await solved();
    report.build = await page.locator('#build-version').evaluate(element => ({
      content: element.dataset.build, builtAt: element.dataset.builtAt, label: element.textContent,
    }));
    if (process.env.PANEL_EXPECTED_BUILD) assert.equal(report.build.content, process.env.PANEL_EXPECTED_BUILD, 'the deployed assets must match the tested release');
    const fixture = await page.evaluate(() => (async () => {
      const appURL = document.querySelector('script[type="module"][src]').src;
      const [{ resolveSourceLayout }, { createStudy }] = await Promise.all([import(new URL('./design.js', appURL).href), import(new URL('./study.js', appURL).href)]);
      const rawModel = { vertices: [[0,0,0],[1000,0,0],[1000,1000,0],[0,1000,0]], triangles: [[0,1,2],[0,2,3]] };
      const input = { size: 500, variation: .3, randomSeed: 7, seeds: [[250,250,0],[750,250,0],[250,750,0],[750,750,0]].map((position,id)=>({id,position,weight:1})),
        mergeGroups: [], cornerEdits: [], panelOffsets: [], layout: null, directBase: null, thickness: 40, roundover: 2 };
      const generated = resolveSourceLayout(rawModel, input);
      return createStudy({ ...input, rawModel, name: 'Public offset browser sheet', view: 'flat', seeds: generated.seeds, layout: generated.layout },
        { units: 'mm', up: 'z', camera: [1600,-1700,2200], target: [500,500,0] });
    })());
    let baseline, positive, negative, savedFile;
    await check('public four-panel sheet opens and its normal handle is selectable', async () => {
      await open(fixture); await activate(); baseline = await snapshot();
      assert.equal(baseline.cells.length, 4); assert.ok(baseline.cells.every(c => c.valid)); assert.equal(baseline.solidInvalid, 0);
      return { panels: 4, sourceHash: digest(baseline.layout), handle: await page.evaluate(() => cellStudy.projectOffsetHandle()) };
    });
    await check('positive and negative distances move the plane exactly without changing the shell', async () => {
      positive = await apply(10); sameSource(positive, baseline); exactOffset(positive, 0, 10);
      assert.ok(positive.cells.every(c => c.valid)); assert.equal(positive.solidInvalid, 0);
      negative = await apply(-10); sameSource(negative, baseline); exactOffset(negative, 0, -10);
      assert.ok(negative.cells.every(c => c.valid)); assert.equal(negative.solidInvalid, 0);
      return { positiveMm: 10, negativeMm: -10, invalidFlat: 0, invalidSolid: 0 };
    });
    await check('Undo and Redo restore exact offset geometry and the numeric control', async () => {
      await page.locator('#undo-move').click(); await solved(); let state = await snapshot();
      assert.deepEqual(state.panelOffsets, positive.panelOffsets); assert.deepEqual(state.cells, positive.cells); sameSource(state, baseline);
      assert.equal(Number(await page.locator('#panel-offset').inputValue()), 10);
      await page.locator('#redo-edit').click(); await solved(); state = await snapshot();
      assert.deepEqual(state.panelOffsets, negative.panelOffsets); assert.deepEqual(state.cells, negative.cells);
      assert.equal(Number(await page.locator('#panel-offset').inputValue()), -10);
      negative = state; return { geometryRestored: true };
    });
    await check('Rhino 6 production download contains linked blocks with actual offset stock geometry', async () => rhinoDownload());
    await check('download, reopen and automatic local resume keep the offset and required feature', async () => {
      const event = page.waitForEvent('download'); await page.locator('#save-study').click(); const file = await event;
      savedFile = JSON.parse(await fs.readFile(await file.path(), 'utf8'));
      assert.ok(savedFile.requiredFeatures.includes('panel-offsets-v1')); assert.deepEqual(savedFile.panelOffsets, negative.panelOffsets);
      sameSource(savedFile, baseline);
      await open(savedFile); let state = await snapshot(); exactOffset(state, 0, -10); sameSource(state, baseline);
      const stored = await until(() => localCopy(state), 'offset in IndexedDB'); assert.deepEqual(stored.panelOffsets, state.panelOffsets);
      await page.reload(); await until(() => page.evaluate(id => window.cellStudy?.state.project?.id === id, state.project.id), 'automatic local resume'); await solved();
      const resumed = await snapshot(); sameSource(resumed, baseline); assert.deepEqual(resumed.panelOffsets, state.panelOffsets); exactOffset(resumed, 0, -10);
      await activate(); return { filename: file.suggestedFilename(), feature: 'panel-offsets-v1', autoResume: true };
    });
    await check('unresolved offsets explain recovery, block production export and remain saveable', async () => {
      const invalid = await apply(1000); sameSource(invalid, baseline); exactOffset(invalid, 0, 1000);
      assert.ok(invalid.cells.some(c => !c.valid));
      assert.equal(await page.locator('#export-rhino').isDisabled(), true);
      assert.equal(await page.locator('#export-dxf').isDisabled(), true);
      assert.equal(await page.locator('#save-study').isDisabled(), false);
      assert.equal(await page.locator('#export-rhino-repair').isDisabled(), false);
      const explanation = await page.locator('#panel-problem-list').innerText();
      assert.match(explanation, /reduce|reset/i); assert.match(explanation, /corner|panels|opening/i);
      const repairFile = await rhinoDownload(true);
      const event = page.waitForEvent('download'); await page.locator('#save-study').click(); const file = await event;
      const saved = JSON.parse(await fs.readFile(await file.path(), 'utf8')); assert.deepEqual(saved.panelOffsets, [{ id: 0, offsetMm: 1000 }]);
      await open(saved); await activate();
      const reopened = await snapshot(); assert.deepEqual(reopened.panelOffsets, saved.panelOffsets); assert.ok(reopened.cells.some(c => !c.valid));
      await page.locator('#reset-offset').click(); await solved();
      const reset = await snapshot(); assert.deepEqual(reset.panelOffsets, []); sameSource(reset, baseline); assert.ok(reset.cells.every(c => c.valid));
      assert.equal(await page.locator('#export-rhino').isDisabled(), false);
      return { invalidPanels: invalid.cells.filter(c => !c.valid).length, explanation, repairFile, resetRestoredExport: true };
    });
    await check('out-of-range and empty numbers retain the last accepted offset', async () => {
      const before = await snapshot();
      for (const value of ['10001', '']) {
        await page.locator('#panel-offset').fill(value); await page.locator('#panel-offset').press('Enter');
        assert.match(await page.locator('#offset-status').innerText(), /previous offset is kept/);
        const after = await snapshot(); assert.deepEqual(after.panelOffsets, before.panelOffsets); assert.equal(after.project.revision, before.project.revision);
      }
      await page.locator('#panel-offset').fill('0'); return { acceptedRevisionUnchanged: true };
    });
    await check('drag preview and Escape preserve accepted geometry, source and history', async () => {
      const before = await snapshot(), drag = await startDrag(0, -25);
      assert.notEqual(drag.preview, 0); const preview = await snapshot();
      assert.deepEqual(preview.panelOffsets, before.panelOffsets); assert.deepEqual(preview.cells, before.cells); sameSource(preview, before);
      await page.keyboard.press('Escape'); await page.mouse.up();
      const after = await snapshot(); assert.equal(after.project.revision, before.project.revision); assert.equal(after.history, before.history);
      assert.deepEqual(after.panelOffsets, before.panelOffsets); assert.deepEqual(after.selectedIds, []);
      assert.ok(Object.values(after.modes).every(value => value === false));
      return { previewMm: drag.preview, cancelledWithoutHistory: true };
    });
    await check('released normal drag creates one undo step and pointer cancellation discards preview', async () => {
      await activate(); const before = await snapshot(), drag = await startDrag(0, -12);
      await page.mouse.up(); await solved(); const after = await snapshot();
      exactOffset(after, 0, drag.preview); assert.equal(after.history, before.history + 1); sameSource(after, before);
      const cancelled = await startDrag(0, -12);
      await page.locator('#viewport canvas').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true });
      await page.mouse.up();
      const final = await snapshot(); assert.deepEqual(final.panelOffsets, after.panelOffsets); assert.equal(final.project.revision, after.project.revision);
      assert.equal(await page.evaluate(() => cellStudy.controls.enabled), true);
      return { committedMm: drag.preview, cancelledPreviewMm: cancelled.preview };
    });
    await check('looking along the normal uses explained upward dragging with fine control', async () => {
      const top = { ...fixture, camera: [250,250,2200], target: [250,250,0] };
      await open(top); await activate(); await page.keyboard.down('Shift'); const drag = await startDrag(0, -20); await page.keyboard.up('Shift');
      assert.match(drag.instruction, /Arrow faces you.*upwards/); assert.ok(drag.preview > 0 && drag.preview < 20);
      await page.mouse.up(); await solved(); const after = await snapshot(); exactOffset(after, 0, drag.preview); sameSource(after, baseline);
      return { endOnInstruction: drag.instruction, fineDragMm: drag.preview };
    });
    await check('rapid numeric replacements keep the final authored plane', async () => {
      await apply(8, { wait: false }); await apply(-12, { wait: false }); await apply(6, { wait: false }); await solved();
      const after = await snapshot(); assert.deepEqual(after.panelOffsets, [{ id: 0, offsetMm: 6 }]); exactOffset(after, 0, 6);
      return { finalOffsetMm: 6, resultMatchedAcceptedValue: true };
    });
    await check('centre and corner edits preserve authored offsets and refit the changed source', async () => {
      await open(fixture); await activate(); await apply(10);
      const before = await snapshot(); await page.locator('#edit-toggle').click(); await page.locator('[data-view="surface"]').click();
      const centre = await page.evaluate(() => cellStudy.projectCellCentre(0)); assert.ok(centre);
      await page.mouse.move(centre.x, centre.y); await page.mouse.down(); await page.mouse.move(centre.x + 8, centre.y - 4, { steps: 5 }); await page.mouse.up();
      await until(() => page.evaluate(revision => cellStudy.state.project.revision > revision, before.project.revision), 'accepted centre move'); await solved();
      const moved = await snapshot(); assert.deepEqual(moved.panelOffsets, before.panelOffsets); assert.notDeepEqual(moved.layout, before.layout); assert.deepEqual(moved.rawModel, before.rawModel); exactOffset(moved, 0, 10);
      await page.locator('#corner-toggle').click();
      const corner = await page.evaluate(() => {
        const c = cellStudy.state.result.corners.find(c => !c.boundary); return c && { id: c.id, point: cellStudy.projectCorner(c.id) };
      }); assert.ok(corner?.point);
      await page.keyboard.down('Alt'); await page.mouse.move(corner.point.x, corner.point.y); await page.mouse.down();
      await page.mouse.move(corner.point.x + 6, corner.point.y + 3, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Alt');
      await until(() => page.evaluate(revision => cellStudy.state.project.revision > revision, moved.project.revision), 'accepted corner move'); await solved();
      const reshaped = await snapshot(); assert.deepEqual(reshaped.panelOffsets, before.panelOffsets); assert.notDeepEqual(reshaped.layout, moved.layout); assert.deepEqual(reshaped.rawModel, before.rawModel); exactOffset(reshaped, 0, 10);
      return { centreAndCornerApplied: true, offsetMm: 10, invalidPanels: reshaped.cells.filter(c => !c.valid).length };
    });
    await check('dividing an offset cell resets its distance and Undo restores it', async () => {
      await open(fixture); await activate(); await apply(10);
      const before = await snapshot(); await page.locator('#split-cell').click();
      const a = await projectPoint([250,100,0]), b = await projectPoint([250,400,0]);
      await page.mouse.move(a.x,a.y); await page.mouse.down(); await page.mouse.move(b.x,b.y,{steps:5}); await page.mouse.up();
      await until(() => page.evaluate(() => cellStudy.state.layout.cells.length === 5), 'split source cell'); await solved();
      const divided = await snapshot(); assert.deepEqual(divided.panelOffsets, []);
      await page.locator('#undo-move').click(); await solved(); const restored = await snapshot();
      sameSource(restored, before, false); assert.deepEqual(restored.panelOffsets, before.panelOffsets); exactOffset(restored,0,10);
      return { panelsAfterSplit: divided.cells.length, offsetReset: true, undoRestored: true };
    });
    await check('merging clears offsets on merged cells and keeps unrelated cells', async () => {
      await open(fixture); await activate(); await apply(10); await select(2); await apply(-10);
      await page.keyboard.press('Escape'); await page.locator('[data-view="surface"]').click(); await select(0); await select(1,{shift:true});
      await page.locator('#merge-cells').click(); await until(() => page.evaluate(() => cellStudy.state.layout.cells.length === 3), 'merge source cells'); await solved();
      const after = await snapshot(); assert.deepEqual(after.panelOffsets,[{id:2,offsetMm:-10}]);
      await page.locator('#undo-move').click(); await solved(); const restored=await snapshot(); assert.deepEqual(restored.panelOffsets,[{id:0,offsetMm:10},{id:2,offsetMm:-10}]);
      return { unrelatedOffsetMm: -10, mergedOffsetCleared: true, undoRestored: true };
    });
    await check('Reset all and a new arrangement can clear offsets with Undo recovery', async () => {
      await open(fixture); await activate(); await apply(10); await select(2); await apply(-10);
      const before = await snapshot(); await page.locator('#reset-all-offsets').click(); await solved();
      assert.deepEqual((await snapshot()).panelOffsets, []);
      await page.locator('#undo-move').click(); await solved(); assert.deepEqual((await snapshot()).panelOffsets, before.panelOffsets);
      await page.getByRole('tab', { name: 'Layout', exact: true }).click(); await page.locator('#regenerate').click();
      await until(() => page.evaluate(revision => cellStudy.state.project.revision > revision, before.project.revision + 1), 'new arrangement'); await solved();
      assert.deepEqual((await snapshot()).panelOffsets, []);
      await page.locator('#undo-move').click(); await solved(); const restored = await snapshot(); sameSource(restored, before, false); assert.deepEqual(restored.panelOffsets, before.panelOffsets);
      return { resetAllUndo: true, newArrangementUndo: true };
    });
    await check('offset controls and documentation are usable at 1600 and 1024 pixels', async () => {
      await open(fixture); await activate(); await apply(10);
      const info = page.getByRole('button',{name:'About panel offsets'}); await info.click();
      assert.equal(await page.locator('#offset-info').isVisible(),true); assert.match(await page.locator('#offset-info').innerText(),/neighbour|Undo|Reset/);
      await info.click();
      const geometry = [];
      for(const width of [1600,1024]) {
        await page.setViewportSize({width,height:1000});
        await page.locator('#panel-offset').scrollIntoViewIfNeeded();
        const boxes=await page.evaluate(()=>['panel-offset','apply-offset','reset-offset'].map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return {id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewport:innerWidth};}));
        for(const box of boxes) { assert.ok(box.left>=0&&box.right<=width,`${box.id} fits ${width}px viewport`); assert.ok(box.width>=30&&box.height>=24); }
        for(let i=1;i<boxes.length;i++) assert.ok(boxes[i].left>=boxes[i-1].right-1,'input and action controls do not overlap');
        const output=width===1600?screenshotPath:screenshotPath.replace(/\.png$/i,'-1024.png'); await page.screenshot({path:output,fullPage:true});
        geometry.push({width,boxes,screenshot:output});
      }
      const gl=await page.locator('#viewport canvas').evaluate(canvas=>{const gl=canvas.getContext('webgl2');return {version:gl?.getParameter(gl.VERSION),lost:gl?.isContextLost()};});
      assert.match(gl.version,/WebGL 2/);assert.equal(gl.lost,false);return {geometry,...gl};
    });
    assert.deepEqual(report.errors,[]); report.completedAt=new Date().toISOString(); await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
    console.log(`Offset browser checks passed. Report: ${reportPath}`);
  } catch(error) {
    report.failure=error.stack||error.message;
    if(page) {report.state=await page.evaluate(()=>({status:document.querySelector('#status')?.textContent,offsetStatus:document.querySelector('#offset-status')?.textContent,selected:window.cellStudy?.state.selected,offsets:window.cellStudy?.state.panelOffsets,solved:window.cellStudy?.state.solved})).catch(()=>null);await page.screenshot({path:screenshotPath.replace(/\.png$/i,'-failure.png'),fullPage:true}).catch(()=>{});}
    await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');throw error;
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
