// Real Chromium/WebGL check using a public synthetic gridded sheet. Verifies
// a generated arrangement above the former 240-cell default, with real study
// downloads, Undo, checkpoint restoration and responsive controls.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const url = process.argv[2] || process.env.PANEL_BROWSER_URL || 'http://127.0.0.1:8799/';
const reportPath = process.env.PANEL_BUDGET_REPORT || path.join(os.tmpdir(), 'panel-generation-budget-browser.json');
const screenshotPath = process.env.PANEL_BUDGET_SCREENSHOT || path.join(os.tmpdir(), 'panel-generation-budget-browser.png');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function publicSheet() {
  const vertices = [], triangles = [], count = 18;
  for (let y = 0; y <= count; y++) for (let x = 0; x <= count; x++) vertices.push([x * 1200 / count, y * 1200 / count, 0]);
  for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) {
    const a = y * (count + 1) + x; triangles.push([a,a+1,a+count+2],[a,a+count+2,a+count+1]);
  }
  return { vertices, triangles };
}
async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true,
    args: ['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const report = { startedAt: new Date().toISOString(), url, browser: browser.version(), checks: [], errors: [] };
  let page;
  async function check(name, run) { const detail = await run(); report.checks.push({ name, ...detail }); console.log(`PASS ${name}`); }
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
    page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    page.on('dialog', dialog => dialog.accept());
    async function until(predicate, label, timeout = 120000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (report.errors.length) throw new Error(report.errors.at(-1));
        if (await predicate()) return;
        await pause(60);
      }
      throw new Error(`Timed out waiting for ${label}: ${await page.locator('#status').innerText()}`);
    }
    const solved = () => until(() => page.evaluate(() => window.cellStudy?.state.solved && !cellStudy.state.busy && !cellStudy.state.pending && !cellStudy.state.generating), 'settled panels');
    const state = () => page.evaluate(() => {
      const s = cellStudy.state;
      return { project: s.project, budget: s.maxGeneratedCells, layout: s.layout, size: s.size, pattern: s.pattern,
        cells: s.cells.length, rawModel: s.rawModel, history: s.history.length, checkpoints: s.checkpoints.length,
        invalidFlat: s.cells.filter(c => !c.valid).length, invalidSolid: s.result.solids.filter(c => !c.valid).length, coverageError: s.result.stats.coverageError };
    });
    const tab = name => page.getByRole('tab', { name, exact: true }).click();
    async function openStudy(study) {
      const before = await page.evaluate(() => cellStudy.state.modelRevision);
      await page.locator('#study-file').setInputFiles({ name: 'public-generation-budget.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(study)) });
      await until(() => page.evaluate(before => cellStudy.state.modelRevision > before, before), 'study opened'); await solved();
    }
    async function generate() {
      const before = await state(); await page.locator('#regenerate').click();
      await until(async () => {
        if (/Arrangement not applied:/.test(await page.locator('#status').innerText())) throw new Error(await page.locator('#status').innerText());
        return page.evaluate(revision => cellStudy.state.project.revision > revision, before.project.revision);
      }, 'new arrangement accepted'); await solved();
    }
    async function checkpoints() { await tab('File'); await page.locator('#open-checkpoints').click(); await page.locator('#checkpoints-dialog').waitFor({ state: 'visible' }); }
    await page.goto(url); await solved();
    report.build = await page.locator('#build-version').getAttribute('data-build') || 'Local development';
    if (process.env.PANEL_EXPECTED_BUILD) assert.equal(report.build, process.env.PANEL_EXPECTED_BUILD);
    const rawModel = publicSheet();
    const fixture = await page.evaluate(rawModel => (async () => {
      const appURL = document.querySelector('script[type="module"][src]').src;
      const [{resolveSourceLayout},{createStudy}] = await Promise.all([import(new URL('./design.js', appURL).href),import(new URL('./study.js', appURL).href)]);
      const input = { size: 114, variation: .3, randomSeed: 7, seeds: [[300,300,0],[900,300,0],[300,900,0],[900,900,0]].map((position,id)=>({id,position,weight:1})),
        mergeGroups:[],cornerEdits:[],panelOffsets:[],layout:null,directBase:null,thickness:10,roundover:0 };
      const generated = resolveSourceLayout(rawModel,input);
      return createStudy({...input,rawModel,name:'Public generation budget sheet',view:'flat',seeds:generated.seeds,layout:generated.layout},
        {units:'mm',up:'z',camera:[1800,-1800,2400],target:[600,600,0]});
    })(), rawModel);
    await openStudy(fixture); await tab('Layout'); let generated, downloadedStudy;
    await check('generation maximum is a draft with bounds and a visible performance explanation', async () => {
      const before = await state(); assert.equal(before.budget,240); assert.equal(await page.locator('#max-generated-cells').inputValue(),'240');
      await page.locator('#max-generated-cells').fill('300'); await page.locator('#pattern-type').selectOption('regularized');
      await page.locator('#pattern-regularity').focus(); await page.locator('#pattern-regularity').press('Home');
      await page.locator('#pattern-regularity').press('ArrowRight'); await page.locator('#pattern-regularity').press('ArrowRight');
      // Study opening sets a continuous range: Home plus arrow keys selects a
      // physically reachable size below 80 mm without a synthetic input event.
      await page.locator('#size').focus(); await page.locator('#size').press('Home');
      const range = await page.locator('#size').evaluate(e => ({ min:Number(e.min),step:e.step==='any'?1:Number(e.step)||1 }));
      const steps = Math.max(0,Math.round((76-range.min)/range.step));
      for (let i=0;i<steps;i++) await page.locator('#size').press('ArrowRight');
      assert.deepEqual(await state(),before,'unapplied layout controls preserve the accepted design');
      assert.match(await page.locator('#generation-help').innerText(),/More cells take longer/);
      assert.equal(await page.locator('#max-generated-cells').getAttribute('min'),'12'); assert.equal(await page.locator('#max-generated-cells').getAttribute('max'),'500');
      await page.getByRole('button',{name:'About the generated cell limit'}).click();
      assert.match(await page.locator('#generation-budget-info').innerText(),/500-cell editing limit/);
      await page.getByRole('button',{name:'Close generated cell limit information'}).click();
      return {defaultMaximum:240,requestedMaximum:300,targetSize:Number(await page.locator('#size').inputValue()),draftPreserved:true};
    });
    await check('Regularized generates more than 240 cells and preserves the setting through Undo and a real study download', async () => {
      const started = Date.now(); await generate(); generated = await state();
      assert.equal(generated.budget,300); assert.equal(generated.layout.recipe.maxGeneratedCells,300);
      assert.ok(generated.cells>240&&generated.cells<=300); assert.ok(generated.coverageError<1e-8);
      assert.equal(generated.invalidFlat,0); assert.equal(generated.invalidSolid,0); assert.deepEqual(generated.rawModel,rawModel);
      const generationMs=Date.now()-started;
      await tab('Modify'); await page.locator('#undo-move').click(); await solved(); assert.equal((await state()).budget,240);
      assert.equal(await page.locator('#max-generated-cells').inputValue(),'240');
      await page.locator('#redo-edit').click(); await solved(); assert.equal(digest((await state()).layout),digest(generated.layout));
      const event=page.waitForEvent('download'); await page.locator('#save-study').click(); const download=await event;
      const bytes=await fs.readFile(await download.path()); downloadedStudy=JSON.parse(bytes);
      assert.equal(downloadedStudy.maxGeneratedCells,300); assert.ok(downloadedStudy.requiredFeatures.includes('generation-budget-v1'));
      await openStudy(downloadedStudy); assert.equal((await state()).budget,300); assert.equal(digest((await state()).layout),digest(generated.layout));
      assert.equal(await page.locator('#max-generated-cells').inputValue(),'300');
      return {cells:generated.cells,invalidFlat:generated.invalidFlat,invalidSolid:generated.invalidSolid,coverageError:generated.coverageError,generationMs,studyBytes:bytes.length,reopened:true};
    });
    await check('checkpoint restoration keeps its applied maximum and invalid drafts keep the accepted design', async () => {
      await checkpoints(); await page.locator('#checkpoint-name').fill('Maximum300'); await page.locator('#save-checkpoint').click();
      await until(()=>page.evaluate(()=>cellStudy.state.checkpoints.length===1),'saved checkpoint'); await page.locator('#close-checkpoints').click(); await tab('Layout');
      const before=await state(); await page.locator('#max-generated-cells').fill('100'); assert.deepEqual(await state(),before,'lower draft does not remove existing cells');
      await page.locator('#max-generated-cells').fill('320'); await generate(); const changed=await state(); assert.equal(changed.budget,320);
      await checkpoints(); await page.locator('#checkpoint-list').getByRole('button',{name:'Restore',exact:true}).click(); await page.locator('#checkpoints-dialog').waitFor({state:'hidden'}); await solved();
      assert.equal((await state()).budget,300); assert.equal(digest((await state()).layout),digest(generated.layout)); assert.equal(await page.locator('#max-generated-cells').inputValue(),'300');
      await tab('Modify'); await page.locator('#undo-move').click(); await solved(); assert.equal((await state()).budget,320);
      await tab('Layout'); const accepted=await state(); await page.locator('#max-generated-cells').fill('501'); await page.locator('#regenerate').click();
      await until(async()=>/whole number from 12 to 500/.test(await page.locator('#status').innerText()),'invalid maximum explained'); assert.deepEqual(await state(),accepted);
      await page.locator('#max-generated-cells').fill('320');
      return {checkpointMaximum:300,undoMaximum:320,lowerDraftPreservedCells:before.cells,invalidDraftPreserved:true};
    });
    await check('generation controls fit 1024 pixels and a new source resets the preference', async () => {
      const layouts=[];
      for(const width of [1600,1024]) {
        await page.setViewportSize({width,height:1000}); await page.locator('#max-generated-cells').scrollIntoViewIfNeeded();
        const box=await page.locator('#generation-budget-control').boundingBox(); assert.ok(box.x>=0&&box.x+box.width<=width);
        const geometry=await page.locator('#generation-budget-control').evaluate(group=>{
          const rect=e=>e.getBoundingClientRect().toJSON(); return {input:rect(group.querySelector('input')),label:rect(group.querySelector('label')),caption:rect(group.querySelector('.ribbon-group-caption'))};
        });
        assert.ok(geometry.input.bottom<=geometry.caption.top+1); assert.ok(geometry.label.bottom<=geometry.input.top+1);
        const file=width===1600?screenshotPath:screenshotPath.replace(/\.png$/i,'-1024.png'); await page.screenshot({path:file,fullPage:true}); layouts.push({width,box,geometry,screenshot:file});
      }
      const obj=[...rawModel.vertices.map(p=>`v ${p.join(' ')}`),...rawModel.triangles.map(t=>`f ${t.map(i=>i+1).join(' ')}`)].join('\n');
      await page.locator('#mesh-file').setInputFiles({name:'new-public-source.obj',mimeType:'text/plain',buffer:Buffer.from(obj)});
      await until(()=>page.evaluate(()=>cellStudy.state.name==='new-public-source'),'new source opened'); await solved();
      assert.equal((await state()).budget,240); assert.equal(await page.locator('#max-generated-cells').inputValue(),'240');
      return {layouts,newSourceMaximum:240};
    });
    assert.deepEqual(report.errors,[]); report.completedAt=new Date().toISOString(); await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n'); console.log(`Generation budget browser checks passed. Report: ${reportPath}`);
  } catch(error) {
    report.failure=error.stack||error.message;
    if(page) {report.status=await page.locator('#status').innerText().catch(()=>null);await page.screenshot({path:screenshotPath.replace(/\.png$/i,'-failure.png'),fullPage:true}).catch(()=>{});}
    await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n'); throw error;
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
