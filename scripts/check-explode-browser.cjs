// Real WebGL / download check for a served demo or built Pages candidate.
// Includes actual guide occlusion pixels with guides-off and forced-through
// controls. Reported hiddenPixels counts passing samples in overlapping patches.
// PANEL_BROWSER_URL=http://127.0.0.1:8796/ node scripts/check-explode-browser.cjs
// Optional: PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE_PATH,
// PANEL_EXPLODE_REPORT and PANEL_EXPLODE_SCREENSHOT (default files under /tmp).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const reportPath = process.env.PANEL_EXPLODE_REPORT || path.join(os.tmpdir(), 'panel-explode-browser.json');
const screenshotPath = process.env.PANEL_EXPLODE_SCREENSHOT || path.join(os.tmpdir(), 'panel-explode-barrel.png');

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || require.resolve('playwright', { paths: [process.cwd(), os.homedir()] }));
  const url = process.argv[2] || process.env.PANEL_BROWSER_URL || 'http://127.0.0.1:8787/';
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = { url, browser: browser.version(), errors: [], checks: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    // Expose scene/renderer references only in the response served to this test.
    // Production source/build files are never changed by the browser check.
    await context.route('**/app.js*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}\nwindow.__guideTest = { scene, renderer };\n` });
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    await page.goto(url);
    await page.waitForFunction(() => window.cellStudy?.state.solved && !window.cellStudy.state.busy && !window.cellStudy.state.pending, null, { timeout: 90000 });
    const baseline = await page.evaluate(() => {
      const s = cellStudy.state;
      return JSON.stringify({ layout: s.layout, seeds: s.seeds, project: s.project, thickness: s.thickness, roundover: s.roundover });
    });
    await page.locator('[data-view="flat"]').click();
    await page.locator('#ribbon-tab-view').click();
    await page.locator('#explode').focus(); await page.locator('#explode').press('End'); await page.locator('#explode').press('Tab');
    await page.locator('#show-assembly-guides').check();
    await page.waitForFunction(() => cellStudy.state.explode === 100);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const guideCheck = await page.evaluate(async () => {
      const appURL = document.querySelector('script[type="module"][src]').src;
      const { assemblyGuideCorners } = await import(new URL('./assembly-guides.js', appURL).href);
      const { Vector2, Vector3, Raycaster } = await import('three');
      const { scene, renderer } = window.__guideTest, camera = cellStudy.camera, s = cellStudy.state;
      scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
      const visible = object => { for (let value = object; value; value = value.parent) if (!value.visible) return false; return true; };
      const guides = [], meshes = [];
      scene.traverse(object => {
        if (!visible(object)) return;
        if (object.userData.assemblyGuide) guides.push(object);
        else if (object.isMesh && Number.isInteger(object.userData.cellId) && !object.material.transparent) meshes.push(object);
      });
      const logical = assemblyGuideCorners({ cells: s.cells, surfaceCells: s.result.surfaceCells || s.cells,
        corners: s.result.corners, solids: s.result.solids, view: s.view });
      const expected = [...logical.values()].reduce((sum, corners) => sum + corners.length, 0);
      const connectors = guides.filter(object => object.userData.assemblyGuide === 'corners');
      const rendered = connectors.reduce((sum, object) => sum + object.geometry.getAttribute('position').count / 2, 0);
      const raw = s.cells.reduce((sum, cell) => sum + cell.loops.reduce((total, loop) => total + loop.length, 0), 0);
      const ray = new Raycaster(), ndc = new Vector2(), candidates = [];
      const gl = renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
      const margin = Math.max(...s.analysis.dimensions) * 1e-5;
      for (const object of connectors) {
        const positions = object.geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i += 2) {
          const a = object.localToWorld(new Vector3().fromBufferAttribute(positions, i));
          const b = object.localToWorld(new Vector3().fromBufferAttribute(positions, i + 1));
          for (const t of [.15,.3,.45,.6,.75,.9]) {
            const point = a.clone().lerp(b, t), projected = point.clone().project(camera);
            if (Math.abs(projected.x) > .95 || Math.abs(projected.y) > .95 || Math.abs(projected.z) >= 1) continue;
            ndc.set(projected.x, projected.y); ray.setFromCamera(ndc, camera);
            const hit = ray.intersectObjects(meshes, false)[0];
            if (!hit || hit.distance + margin >= point.distanceTo(ray.ray.origin)) continue;
            candidates.push({ panel: object.userData.cellId, occludingPanel: hit.object.userData.cellId,
              x: Math.round((projected.x + 1) * width / 2), y: Math.round((projected.y + 1) * height / 2) });
          }
        }
      }
      const patches = candidates.slice(0, 250).map(candidate => ({ ...candidate,
        x: Math.max(0, Math.min(width - 9, candidate.x - 4)), y: Math.max(0, Math.min(height - 9, candidate.y - 4)) }));
      const materials = [...new Set(guides.flatMap(object => Array.isArray(object.material) ? object.material : [object.material]))];
      const original = materials.map(material => ({ material, depthTest: material.depthTest, depthWrite: material.depthWrite }));
      const read = () => {
        renderer.render(scene, camera);
        return patches.map(patch => { const pixels = new Uint8Array(9 * 9 * 4); gl.readPixels(patch.x, patch.y, 9, 9, gl.RGBA, gl.UNSIGNED_BYTE, pixels); return pixels; });
      };
      let normal, without, forced;
      try {
        normal = read();
        guides.forEach(object => { object.visible = false; }); without = read();
        guides.forEach(object => { object.visible = true; });
        materials.forEach(material => { material.depthTest = false; material.needsUpdate = true; }); forced = read();
      } finally {
        guides.forEach(object => { object.visible = true; });
        for (const saved of original) { saved.material.depthTest = saved.depthTest; saved.material.depthWrite = saved.depthWrite; saved.material.needsUpdate = true; }
        renderer.render(scene, camera);
      }
      let hiddenPixels = 0, example = null;
      for (let i = 0; i < patches.length; i++) for (let pixel = 0; pixel < 81; pixel++) {
        const k = pixel * 4;
        const normalDelta = Math.max(...[0,1,2].map(channel => Math.abs(normal[i][k + channel] - without[i][k + channel])));
        const forcedDelta = Math.max(...[0,1,2].map(channel => Math.abs(forced[i][k + channel] - without[i][k + channel])));
        if (normalDelta > 1 || forcedDelta < 12) continue;
        const x = patches[i].x + pixel % 9, y = patches[i].y + Math.floor(pixel / 9);
        ray.setFromCamera(new Vector2((x + .5) / width * 2 - 1, (y + .5) / height * 2 - 1), camera);
        if (!ray.intersectObjects(meshes, false).length) continue;
        hiddenPixels++;
        example ??= { ...patches[i], pixel: [x,y], normal: [...normal[i].slice(k,k+3)], guidesOff: [...without[i].slice(k,k+3)], forcedThrough: [...forced[i].slice(k,k+3)] };
      }
      return { rawLoopSamples: raw, expectedLogicalCorners: expected, renderedConnectors: rendered,
        opaquePanelMeshes: meshes.length, occludedSamples: candidates.length, hiddenPixels, example,
        depthTestEnabled: original.every(value => value.depthTest), depthWriteDisabled: original.every(value => !value.depthWrite), glError: gl.getError() };
    });
    report.checks.push({ name: 'Logical corner density and actual panel occlusion of assembly guides', ...guideCheck });
    assert.equal(guideCheck.renderedConnectors, guideCheck.expectedLogicalCorners);
    assert.ok(guideCheck.renderedConnectors < guideCheck.rawLoopSamples, 'Logical corner guides should omit the barrel mesh subdivisions.');
    assert.ok(guideCheck.depthTestEnabled && guideCheck.depthWriteDisabled);
    assert.ok(guideCheck.occludedSamples > 0, 'The view must include a guide behind a panel for a meaningful depth test.');
    assert.ok(guideCheck.hiddenPixels > 0, 'Behind-panel guide pixels must disappear normally and reappear in the forced-through positive control.');
    assert.equal(guideCheck.glError, 0);
    for (const view of ['surface', 'solid']) {
      await page.locator(`[data-view="${view}"]`).click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const density = await page.evaluate(async () => {
        const appURL = document.querySelector('script[type="module"][src]').src;
        const { assemblyGuideCorners } = await import(new URL('./assembly-guides.js', appURL).href);
        const s = cellStudy.state, surface = s.result.surfaceCells || s.cells;
        const logical = assemblyGuideCorners({ cells: s.cells, surfaceCells: surface,
          corners: s.result.corners, solids: s.result.solids, view: s.view });
        const expected = [...logical.values()].reduce((sum, corners) => sum + corners.length, 0);
        const raw = s.view === 'surface'
          ? surface.reduce((sum, cell) => sum + cell.loops.reduce((total, loop) => total + loop.length, 0), 0)
          : s.result.solids.reduce((sum, solid) => sum + Object.values(solid.caps || {})
            .reduce((total, cap) => total + (cap.boundaryLoops || []).reduce((count, loop) => count + loop.length, 0), 0), 0);
        let rendered = 0, panelsWithGuides = 0;
        __guideTest.scene.traverse(object => {
          if (object.userData.assemblyGuide !== 'corners') return;
          for (let parent = object; parent; parent = parent.parent) if (!parent.visible) return;
          rendered += object.geometry.getAttribute('position').count / 2; panelsWithGuides++;
        });
        return { view: s.view, rawBoundarySamples: raw, expectedLogicalCorners: expected,
          renderedConnectors: rendered, panelsWithGuides, panelCount: s.cells.length };
      });
      report.checks.push({ name: `${view === 'surface' ? 'Cells' : 'Solid'} view renders sparse logical corner guides`, ...density });
      assert.ok(density.expectedLogicalCorners > 0);
      assert.equal(density.renderedConnectors, density.expectedLogicalCorners);
      assert.ok(density.renderedConnectors < density.rawBoundarySamples, `${view} guide connectors should omit raw boundary subdivisions.`);
      if (view === 'solid') {
        const solidScreenshot = screenshotPath.replace(/\.png$/i, '-solid.png');
        await page.screenshot({ path: solidScreenshot, fullPage: true });
        report.checks.at(-1).screenshot = solidScreenshot;
      }
    }
    await page.locator('[data-view="flat"]').click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await page.evaluate(async () => {
      const appURL = document.querySelector('script[type="module"][src]').src;
      const { computeExplodedOffsets } = await import(new URL('./explode.js', appURL).href);
      const { Vector3 } = await import('three');
      const s = cellStudy.state, camera = cellStudy.camera;
      const offsets = computeExplodedOffsets({ cells: s.cells, solids: s.result.solids, center: s.analysis.center, amount: 1 });
      const positions = s.cells.flatMap(cell => cell.flatPositions.map(p => p.map((value, axis) => value + offsets.get(cell.id)[axis])));
      const projected = positions.map(p => new Vector3(...p).project(camera));
      const maximumNDC = Math.max(...projected.map(p => Math.max(Math.abs(p.x), Math.abs(p.y))));
      const allDepthVisible = projected.every(p => p.z > -1 && p.z < 1);
      const canvas = document.querySelector('#viewport canvas'), rect = canvas.getBoundingClientRect();
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const centers = s.cells.map(cell => {
        const p = cell.flatPositions.reduce((sum, point) => sum.map((value, axis) => value + point[axis] / cell.flatPositions.length), [0,0,0]);
        const projected = new Vector3(...p.map((value, axis) => value + offsets.get(cell.id)[axis])).project(camera);
        return { id: cell.id, x: rect.x + (projected.x + 1) * rect.width / 2, y: rect.y + (1 - projected.y) * rect.height / 2, z: projected.z };
      }).sort((a,b) => a.z - b.z);
      return { name: s.name, count: s.cells.length, maximumNDC, allDepthVisible,
        webgl: !!gl && !gl.isContextLost(), glError: gl?.getError(), positions, centers, triangles: s.cells.reduce((n, cell) => n + cell.triangles.length, 0) };
    });
    assert.ok(geometry.webgl); assert.equal(geometry.glError, 0); assert.ok(geometry.maximumNDC < .95, `Panels outside frame: ${geometry.maximumNDC}`);
    assert.ok(geometry.allDepthVisible);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    report.checks.push({ name: 'Full explosion with assembly guides renders inside camera frame', panels: geometry.count,
      maximumNDC: geometry.maximumNDC, screenshot: screenshotPath });
    for (const point of geometry.centers) {
      await page.mouse.click(point.x, point.y);
      if (await page.evaluate(() => cellStudy.state.selectedIds.length > 0)) break;
    }
    const selected = await page.evaluate(() => [...cellStudy.state.selectedIds]);
    assert.ok(selected.length > 0, 'A displayed exploded panel must remain selectable.');
    const selectedScreenshot = screenshotPath.replace(/\.png$/i, '-selected.png');
    await page.screenshot({ path: selectedScreenshot, fullPage: true });
    report.checks.push({ name: 'Exploded panel selection keeps assembly guides available', selected, screenshot: selectedScreenshot });
    await page.locator('#ribbon-tab-export').click();
    const downloaded = page.waitForEvent('download'); await page.locator('#export-obj').click();
    const download = await downloaded, text = await fs.readFile(await download.path(), 'utf8');
    const objVertices = text.split('\n').filter(line => line.startsWith('v ')).map(line => line.slice(2).split(/\s+/).map(Number));
    assert.equal(objVertices.length, geometry.positions.length);
    const maxExportError = Math.max(...objVertices.map((point, i) => Math.max(...point.map((value, axis) => Math.abs(value - geometry.positions[i][axis])))));
    assert.ok(maxExportError <= .000001, `OBJ/preview discrepancy ${maxExportError} mm`);
    assert.equal(text.split('\n').filter(line => line.startsWith('f ')).length, geometry.triangles);
    report.checks.push({ name: 'Real OBJ download matches exploded preview coordinates', filename: download.suggestedFilename(), maxExportError });
    const unchanged = await page.evaluate(() => {
      const s = cellStudy.state;
      return JSON.stringify({ layout: s.layout, seeds: s.seeds, project: s.project, thickness: s.thickness, roundover: s.roundover });
    });
    assert.equal(unchanged, baseline); assert.deepEqual(report.errors, []);
    report.checks.push({ name: 'View, guide, selection and export actions preserve accepted source and project revision' });
    report.passed = true;
  } finally {
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
