// Real WebGL / download check for a served demo or built Pages candidate.
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
    const geometry = await page.evaluate(async () => {
      const { computeExplodedOffsets } = await import('./explode.js');
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
