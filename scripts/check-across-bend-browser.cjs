// Real Chromium/WebGL checks with a public synthetic crease, real controls,
// source/fitted previews and a downloaded study. Works with source or packaged
// app module URLs. Private project geometry is never used by this script.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const url = process.argv[2] || process.env.PANEL_BROWSER_URL || 'http://127.0.0.1:8799/';
const reportPath = process.env.PANEL_BEND_REPORT || path.join(os.tmpdir(), 'panel-across-bend-browser.json');
const screenshotPath = process.env.PANEL_BEND_SCREENSHOT || path.join(os.tmpdir(), 'panel-across-bend-browser.png');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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
        if (await predicate()) return;
        await pause(60);
      }
      throw new Error(`Timed out waiting for ${label}: ${await page.locator('#status').innerText()} / ${await page.locator('#across-bend-status').innerText()}`);
    }
    const solved = () => until(() => page.evaluate(() => window.cellStudy?.state.solved && !cellStudy.state.busy && !cellStudy.state.pending && !cellStudy.state.generating), 'settled panels');
    const tab = name => page.getByRole('tab', { name, exact: true }).click();
    const state = () => page.evaluate(() => {
      const s = cellStudy.state, p = s.acrossBendPreview;
      return { layout: s.layout, rawModel: s.rawModel, seeds: s.seeds, directBase: s.directBase, panelOffsets: s.panelOffsets,
        protectedCellIds: s.protectedCellIds, nextCellId: s.nextCellId, project: s.project, history: s.history.length, future: s.future.length,
        mode: s.acrossBendMode, selected: s.selectedIds, view: s.view, previewBusy: s.acrossBendPreviewBusy,
        preview: p && { fitState: p.fitState, widthMm: p.widthMm, cellIds: p.change.trimmedCellIds, newCellId: p.change.newCellId,
          sourcePositions: p.sourceCell.positions, sourceTriangles: p.sourceCell.triangles, flatPositions: p.fittedCell?.flatPositions,
          trimmedCount: p.fittedTrimmedCells?.length },
        panels: s.cells.map(c => ({ id: c.id, valid: c.valid })), solids: s.result.solids.map(c => ({ id: c.id, valid: c.valid })), coverageError: s.result.stats.coverageError };
    });
    const authored = s => ({ layout:s.layout,rawModel:s.rawModel,seeds:s.seeds,directBase:s.directBase,panelOffsets:s.panelOffsets,protectedCellIds:s.protectedCellIds,nextCellId:s.nextCellId,project:s.project,history:s.history,future:s.future });
    async function project(point) {
      return page.evaluate(point => { const p = new cellStudy.camera.position.constructor(...point).project(cellStudy.camera), r = document.querySelector('#viewport canvas').getBoundingClientRect();
        return { x:r.x+(p.x+1)*r.width/2,y:r.y+(1-p.y)*r.height/2 }; }, point);
    }
    async function clickPoint(point, shift = false) {
      const p = await project(point); if (shift) await page.keyboard.down('Shift');
      await page.mouse.click(p.x,p.y); if (shift) await page.keyboard.up('Shift');
    }
    async function open(study) {
      await page.keyboard.press('Escape'); const before = await page.evaluate(() => cellStudy.state.modelRevision);
      await page.locator('#study-file').setInputFiles({ name:'public-across-bend-fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(study)) });
      await until(() => page.evaluate(revision => cellStudy.state.modelRevision > revision,before),'study opened'); await solved(); await tab('Modify');
    }
    async function activate({ pair = false } = {}) {
      await page.keyboard.press('Escape'); await tab('Modify'); await page.locator('[data-view="surface"]').click();
      if (pair) {
        await clickPoint([-200,500,120]); await clickPoint([200,500,120],true);
        await until(() => page.evaluate(() => cellStudy.state.selectedIds.includes(0) && cellStudy.state.selectedIds.includes(1)),'two cells selected');
      }
      await page.locator('#across-bend-toggle').click();
      if (!pair) await clickPoint([0,500,0]);
      await until(() => page.evaluate(() => cellStudy.state.acrossBendSelection?.cellIds.join(',') === '0,1'),'chosen shared seam');
    }
    async function width(value) { await page.locator('#across-bend-width').fill(String(value)); }
    async function preview(value) {
      if (value !== undefined) await width(value);
      await until(() => page.evaluate(() => cellStudy.state.acrossBendPreview?.fitState === 'ready' && !cellStudy.state.acrossBendPreviewBusy),'fitted preview');
      assert.equal(await page.locator('#apply-across-bend').isEnabled(),true);
    }
    async function apply() {
      const before = await state(); await page.locator('#apply-across-bend').click();
      await until(() => page.evaluate(count => cellStudy.state.layout.cells.length === count + 1,before.layout.cells.length),'bridge applied'); await solved(); return state();
    }
    async function downloadStudy() {
      const event = page.waitForEvent('download'); await page.locator('#save-study').click(); const file = await event;
      const bytes = await fs.readFile(await file.path()); return { study:JSON.parse(bytes),bytes:bytes.length };
    }
    await page.goto(url); await solved();
    report.build = await page.locator('#build-version').getAttribute('data-build') || 'Local development';
    if (process.env.PANEL_EXPECTED_BUILD) assert.equal(report.build,process.env.PANEL_EXPECTED_BUILD);
    const fixtures = await page.evaluate(() => (async () => {
      const appURL = document.querySelector('script[type="module"][src]').src;
      const [{rebuildSurfaceCells},{captureLayout,layoutRecipe},{createStudy}] = await Promise.all([
        import(new URL('./geometry.js',appURL).href),import(new URL('./layout.js',appURL).href),import(new URL('./study.js',appURL).href)]);
      function make(neighbours,offsets = [],protectedCellIds = []) {
        const xs=[-400,-300,-200,-100,0,100,200,300,400],ys=neighbours?[-600,-300,0,250,500,750,1000,1300]:[0,200,400,600,800,1000];
        const vertices=ys.flatMap(y=>xs.map(x=>[x,y,Math.abs(x)*.6])),triangles=[],owners=[];
        for(let y=0;y<ys.length-1;y++)for(let x=0;x<xs.length-1;x++){
          const a=y*xs.length+x;triangles.push([a,a+1,a+xs.length+1],[a,a+xs.length+1,a+xs.length]);
          const owner=neighbours&&ys[y]<-300?4:neighbours&&ys[y]<0?2:neighbours&&ys[y]>=1000?3:xs[x]<0?0:1;owners.push(owner,owner);
        }
        const rawModel={vertices,triangles},seeds=[],builders=[...new Set(owners)].sort((a,b)=>a-b).map(id=>{
          const faces=triangles.filter((_,i)=>owners[i]===id),indices=[...new Set(faces.flat())],position=vertices[faces[0][0]];
          seeds.push({id,position,weight:1});return{id,seed:position,weight:1,memberSeedIds:[id],positions:indices.map(i=>vertices[i]),triangles:faces.map(f=>f.map(i=>indices.indexOf(i)))};
        });
        const layout=captureLayout(rawModel,rebuildSurfaceCells(rawModel,builders),{recipe:layoutRecipe({seeds,size:500})});
        return createStudy({rawModel,name:'Public Across bend crease',seeds,size:500,variation:.3,randomSeed:7,layout,directBase:null,nextCellId:20,
          thickness:10,roundover:0,straightness:.7,carve:false,panelOffsets:offsets,protectedCellIds,view:'surface'},
          {units:'mm',up:'z',camera:[1250,-1200,1700],target:[0,500,80]});
      }
      return {simple:make(false),locked:make(false,[],[0]),neighbours:make(true,[{id:0,offsetMm:5},{id:4,offsetMm:5}],[4])};
    })());
    let accepted;
    await check('seam picking previews fitted geometry without changing layout, revisions, history or IDs',async()=>{
      await open(fixtures.simple); const before=await state(); await activate(); await preview(100); const shown=await state();
      assert.deepEqual(authored(shown),authored(before)); assert.equal(shown.view,'surface'); assert.deepEqual(shown.preview.cellIds,[0,1]);
      assert.ok(shown.preview.flatPositions.length>=4&&shown.preview.flatPositions.every(p=>p.every(Number.isFinite)));
      assert.notEqual(digest(shown.preview.sourcePositions),digest(shown.preview.flatPositions));
      assert.equal(shown.preview.trimmedCount,2);
      await page.screenshot({path:screenshotPath,fullPage:true});
      return {newPanelId:shown.preview.newCellId,previewWidth:100,sourceAndFlatDiffer:true,unchangedRevision:before.project.revision,screenshot:screenshotPath};
    });
    await check('invalid widths explain rejection and Cancel or Escape discards checked and pending previews',async()=>{
      const before=authored(await state()); await width(0); await until(async()=>/positive/.test(await page.locator('#across-bend-status').innerText()),'zero width explanation');
      assert.equal(await page.locator('#apply-across-bend').isDisabled(),true);
      await width(2000); await until(async()=>/use up|sliver/.test(await page.locator('#across-bend-status').innerText()),'wide width explanation');
      assert.equal(await page.locator('#apply-across-bend').isDisabled(),true); assert.deepEqual(authored(await state()),before);
      await preview(100); await page.locator('#cancel-across-bend').click(); assert.equal((await state()).mode,false); assert.deepEqual(authored(await state()),before);
      await activate({pair:true}); await width(120); await page.keyboard.press('Escape'); await pause(1000);
      const cancelled=await state();assert.equal(cancelled.mode,false);assert.equal(cancelled.preview,null);assert.deepEqual(authored(cancelled),before);
      return {invalidWidths:[0,2000],cancelledPendingPreview:true,unchangedRevision:before.project.revision};
    });
    await check('Apply keeps both parent IDs, creates one valid part, and survives Undo, Redo and actual save/reopen',async()=>{
      await activate({pair:true}); await preview(100); const before=await state(); accepted=await apply();
      assert.deepEqual(accepted.layout.cells.map(c=>c.id),[0,1,20]);assert.equal(accepted.nextCellId,21);assert.equal(accepted.history,before.history+1);
      assert.deepEqual(accepted.selected,[20]);assert.equal(accepted.mode,false);assert.ok(accepted.coverageError<1e-10);
      assert.ok(accepted.panels.every(c=>c.valid)&&accepted.solids.every(c=>c.valid));assert.deepEqual(accepted.rawModel,before.rawModel);
      await page.locator('#undo-move').click();await solved();assert.equal(digest((await state()).layout),digest(before.layout));
      assert.equal((await state()).nextCellId,21,'Undo does not recycle a reserved panel number');
      await page.locator('#redo-edit').click();await solved();assert.equal(digest((await state()).layout),digest(accepted.layout));
      const downloaded=await downloadStudy();await open(downloaded.study);const reopened=await state();
      assert.deepEqual(reopened.layout,accepted.layout,'reopening preserves the authored geometry and identity');assert.equal(reopened.nextCellId,21);assert.ok(reopened.panels.every(c=>c.valid)&&reopened.solids.every(c=>c.valid));
      return {panelIds:[0,1,20],flatValid:3,solidValid:3,retiredCounter:21,studyBytes:downloaded.bytes,reopened:true};
    });
    await check('locked neighbours reject previews without editing the saved source',async()=>{
      await open(fixtures.locked);const before=await state();await activate({pair:true});
      await until(async()=>/protected|locked|Unlock/i.test(await page.locator('#across-bend-status').innerText()),'protected panel explanation');
      assert.equal(await page.locator('#apply-across-bend').isDisabled(),true);assert.deepEqual(authored(await state()),authored(before));
      await page.keyboard.press('Escape');return {protectedPanelIds:[0],unchangedRevision:before.project.revision};
    });
    await check('trimmed offsets clear while unrelated offsets and edit locks survive, and Undo restores them',async()=>{
      await open(fixtures.neighbours);const before=await state();await activate({pair:true});await preview(100);const after=await apply();
      assert.deepEqual(after.panelOffsets,[{id:4,offsetMm:5}]);assert.deepEqual(after.protectedCellIds,[4]);assert.ok(after.layout.cells.some(c=>c.id===20));
      assert.deepEqual(after.layout.cells.find(c=>c.id===4),before.layout.cells.find(c=>c.id===4));
      await page.locator('#undo-move').click();await solved();assert.deepEqual((await state()).panelOffsets,before.panelOffsets);assert.equal(digest((await state()).layout),digest(before.layout));
      return {trimmedOffsetCleared:0,unrelatedOffsetKept:4,protectedIds:[4],undoRestored:true};
    });
    await check('changing material cancels a preview and controls remain usable at 1024 pixels',async()=>{
      await open(fixtures.simple);await activate();await preview(100);await page.setViewportSize({width:1024,height:1100});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await pause(250);
      const bounds={};for(const id of ['across-bend-width','apply-across-bend','cancel-across-bend']){await page.locator(`#${id}`).scrollIntoViewIfNeeded();const b=await page.locator(`#${id}`).boundingBox();assert.ok(b&&b.x>=0&&b.x+b.width<=1024,`${id} fits width`);bounds[id]=b;}
      const image=screenshotPath.replace(/\.png$/i,'-1024.png');await page.screenshot({path:image,fullPage:true});
      await page.setViewportSize({width:1600,height:1100});const before=await state();
      const stock=page.locator('.panel-shape-section');if(!await stock.evaluate(e=>e.open))await stock.locator('summary').click();
      await page.locator('#thickness').focus();await page.locator('#thickness').press('ArrowRight');await page.locator('#thickness').press('Tab');await solved();
      await until(()=>page.evaluate(()=>!cellStudy.state.acrossBendMode),'material change cancels mode');
      const after=await state();assert.equal(after.preview,null);assert.equal(digest(after.layout),digest(before.layout));assert.equal(after.nextCellId,before.nextCellId);
      return {bounds,screenshot:image,materialChangeCancelled:true};
    });
    assert.deepEqual(report.errors,[]);report.completedAt=new Date().toISOString();await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(`Across bend browser checks passed. Report: ${reportPath}`);
  } catch(error) {
    report.failure=error.stack||error.message;
    if(page){report.status=await page.locator('#status').innerText().catch(()=>null);report.bendStatus=await page.locator('#across-bend-status').innerText().catch(()=>null);await page.screenshot({path:screenshotPath.replace(/\.png$/i,'-failure.png'),fullPage:true}).catch(()=>{});}
    await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');throw error;
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
