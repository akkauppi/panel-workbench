import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const fixedEpoch = '1793361600';
const privateCanary = 'PAGES-PRIVATE-CANARY';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'panel-pages-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('./', import.meta.url), join(root, 'demo'), { recursive: true });
  await cp(new URL('../server.mjs', import.meta.url), join(root, 'server.mjs'));
  await mkdir(join(root, 'scripts'));
  for (const name of ['build-public.mjs', 'build-pages.mjs']) await cp(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  await mkdir(join(root, 'private')); await writeFile(join(root, 'private/model.3dm'), privateCanary);
  await writeFile(join(root, 'demo/unlisted-model.3dm'), privateCanary);
  await writeFile(join(root, 'demo/saved-study.json'), privateCanary);
  return root;
}

async function build(root, epoch = fixedEpoch) {
  await execute(process.execPath, [join(root, 'scripts/build-pages.mjs')], { env: { ...process.env, SOURCE_DATE_EPOCH: epoch } });
  const output = join(root, 'dist/panel-workbench-pages'), html = await readFile(join(output, 'index.html'), 'utf8');
  const release = html.match(/data-build="([a-f0-9]{16})"/)?.[1];
  assert.ok(release, 'the visible build field identifies the runtime content');
  return { output, html, release };
}

async function filesUnder(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await filesUnder(join(directory, entry.name), `${prefix}${entry.name}/`));
    else result.push(prefix + entry.name);
  }
  return result.sort();
}

async function checkGraph({ output, html, release }, pageURL) {
  const base = new URL('./', pageURL), prefix = `assets/${release}/`, versionRoot = new URL(prefix, base);
  const appPath = html.match(/<script type="module" src="([^"]+)"/)?.[1];
  const cssPath = html.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1];
  assert.equal(appPath, `./${prefix}app.js`); assert.equal(cssPath, `./${prefix}style.css`);
  assert.ok(!/<base\b/.test(html), 'asset versioning leaves document-relative navigation and inline SVG symbols alone');
  assert.match(html, /class="application-mark" href="\.\/"/);
  assert.match(html, /<use href="#i-cell"/);
  assert.equal(new URL('./', pageURL).href, base.href);
  const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
  assert.equal(imports.three, `./${prefix}vendor/three.module.js`);
  assert.equal(imports['three/addons/'], `./${prefix}vendor/addons/`);
  const readURL = async url => {
    assert.ok(url.href.startsWith(versionRoot.href), `${url.href} stays within one runtime release`);
    return readFile(join(output, decodeURIComponent(url.pathname.slice(base.pathname.length))));
  };
  await readURL(new URL(cssPath, pageURL));
  const pending = [new URL(appPath, pageURL)], visited = new Set();
  while (pending.length) {
    const url = pending.pop(); if (visited.has(url.href)) continue;
    visited.add(url.href);
    const source = (await readURL(url)).toString('utf8');
    if (!url.pathname.endsWith('.js')) continue;
    for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] || match[2];
      if (specifier.startsWith('.')) pending.push(new URL(specifier, url));
      else if (specifier === 'three') pending.push(new URL(imports.three, pageURL));
      else if (specifier.startsWith('three/addons/')) pending.push(new URL(imports['three/addons/'] + specifier.slice('three/addons/'.length), pageURL));
    }
    for (const match of source.matchAll(/new URL\(\s*['"]([^'"]+)['"],\s*import\.meta\.url\)/g)) pending.push(new URL(match[1], url));
    assert.ok(!/\bnew\s+Worker\(\s*['"]/.test(source), 'workers resolve from their versioned module, never from the root document');
  }
  for (const name of ['worker.js', 'rhino-worker.js', 'rhino-export.js', 'rhino-import.js', 'rhino-runtime.js', 'vendor/rhino3dm/rhino3dm.module.js', 'vendor/rhino3dm/rhino3dm.wasm']) {
    assert.ok(visited.has(new URL(name, versionRoot).href), `${name} belongs to the discovered versioned dependency graph`);
  }
}

test('Pages versions the complete dependency graph while preserving root and subpath navigation', async t => {
  const root = await fixture(t), built = await build(root);
  const expectedDate = new Date(Number(fixedEpoch) * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  assert.ok(built.html.includes(`>Build ${expectedDate}</span>`), 'the published UI shows an explicit UTC build time');
  assert.match(built.html, /id="build-version"[^>]*title="Content [a-f0-9]{16}"/);
  for (const page of ['https://example.test/', 'https://example.test/panel-workbench/', 'https://example.test/panel-workbench/index.html']) await checkGraph(built, page);
  const files = await filesUnder(built.output);
  assert.ok(files.includes('app.js') && files.includes('rhino-worker.js'), 'legacy root assets remain available to already-open old pages');
  assert.ok(files.includes('.nojekyll'));
  for (const relative of files) {
    assert.ok(!/\.(?:3dm|test\.mjs)$/.test(relative) && !relative.includes('private/') && !relative.includes('saved-study'));
    assert.ok(!(await readFile(join(built.output, relative))).includes(Buffer.from(privateCanary)));
  }
  assert.equal(await readFile(join(root, 'demo/app.js'), 'utf8'), await readFile(new URL('./app.js', import.meta.url), 'utf8'), 'build transforms never change local-development source');
});

test('identical input gives identical releases; changing an exporter or WASM invalidates every runtime URL', async t => {
  const root = await fixture(t), first = await build(root), firstFiles = await filesUnder(first.output);
  const second = await build(root);
  assert.equal(second.release, first.release); assert.equal(second.html, first.html);
  assert.deepEqual(await filesUnder(second.output), firstFiles);
  const later = await build(root, String(Number(fixedEpoch) + 60));
  assert.equal(later.release, first.release, 'time alone cannot mutate content-addressed runtime assets');
  assert.notEqual(later.html, first.html, 'a later rebuild is visible in the UI even with unchanged code');
  let previous = later;
  for (const relative of ['app.js', 'rhino-export.js', 'vendor/rhino3dm/rhino3dm.wasm']) {
    const path = join(root, 'demo', relative), contents = await readFile(path);
    await writeFile(path, Buffer.concat([contents, Buffer.from(relative.endsWith('.wasm') ? [0] : '\n// Changed release input.\n')]));
    const changed = await build(root);
    assert.notEqual(changed.release, previous.release, `${relative} invalidates the complete release`);
    assert.ok(!changed.html.includes(`assets/${previous.release}/`));
    await checkGraph(changed, 'https://example.test/nested/project/');
    previous = changed;
  }
});
