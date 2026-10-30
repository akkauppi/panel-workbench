import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { createServer } from '../server.mjs';

const execute = promisify(execFile);
const stub = await readFile(new URL('./local-examples.js', import.meta.url), 'utf8');
const mesh = 'o Synthetic local triangle\nv 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n';
const descriptor = { id: 'local-triangle', name: 'Local triangle', description: 'Generated test triangle.',
  file: 'models/triangle.obj', units: 'mm', up: 'y', initialSize: 250 };

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'panel-server-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function listen(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return (path, method = 'GET') => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path, method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject); request.end();
  });
}
async function fixture(t) {
  const root = await temporary(t), demoRoot = join(root, 'demo'), privateRoot = join(root, 'private');
  await mkdir(demoRoot); await mkdir(join(privateRoot, 'models'), { recursive: true });
  await writeFile(join(demoRoot, 'local-examples.js'), stub);
  await writeFile(join(demoRoot, 'index.html'), '<!doctype html><title>Synthetic test app</title>');
  await writeFile(join(privateRoot, descriptor.file), mesh);
  return { root, demoRoot, privateRoot, request: await listen(t, createServer({ demoRoot, privateRoot })),
    manifest: contents => writeFile(join(privateRoot, 'examples.json'), typeof contents === 'string' ? contents : JSON.stringify(contents)) };
}

test('without a local manifest the catalog is the exact empty static module', async t => {
  const { request } = await fixture(t);
  const response = await request('/local-examples.js');
  assert.equal(response.status, 200); assert.equal(response.body, stub);
  assert.match(response.headers['content-type'], /javascript/);
  const head = await request('/local-examples.js', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(stub));
  assert.equal((await request('/local-examples/local-triangle.obj')).status, 404);
  assert.equal((await request('/')).status, 200);
});

test('a local catalog exposes only descriptors and explicitly configured regular OBJ files', async t => {
  const { request, manifest } = await fixture(t);
  await manifest([{ ...descriptor, ignoredMetadata: 'do-not-publish' }]);
  const response = await request('/local-examples.js');
  assert.equal(response.status, 200);
  const catalog = (await import(`data:text/javascript,${encodeURIComponent(response.body)}`)).LOCAL_EXAMPLES;
  const { file, ...expected } = descriptor;
  assert.deepEqual(catalog, [{ ...expected, url: './local-examples/local-triangle.obj' }]);
  assert.ok(!response.body.includes('models/') && !response.body.includes('do-not-publish') && !response.body.includes('v 100'));
  const asset = await request('/local-examples/local-triangle.obj');
  assert.equal(asset.status, 200); assert.equal(asset.body, mesh);
  const head = await request('/local-examples/local-triangle.obj', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(mesh));
  assert.equal((await request('/local-examples/local-triangle.obj', 'POST')).status, 405);
});

test('unknown files, traversal and static symlinks never expose other private files', async t => {
  const { request, manifest, privateRoot, demoRoot } = await fixture(t);
  await manifest([descriptor]);
  await writeFile(join(privateRoot, 'other.obj'), 'PRIVATE-CANARY');
  await symlink(join(privateRoot, 'other.obj'), join(demoRoot, 'outside.obj'));
  for (const path of ['/local-examples/unknown.obj', '/local-examples/triangle.obj', '/local-examples/models/triangle.obj',
    '/local-examples/%2e%2e%2fother.obj', '/local-examples/%2e%2e/%2e%2e/private/other.obj', '/local-examples/local-triangle.obj/extra',
    '/private/other.obj', '/private/examples.json', '/%2e%2e%2fprivate/other.obj', '/outside.obj']) {
    const response = await request(path);
    assert.ok([403, 404].includes(response.status), `${path}: ${response.status}`);
    assert.ok(!response.body.includes('PRIVATE-CANARY') && !response.body.includes(privateRoot));
  }
});

test('malformed manifests and escaping file links fail without revealing local paths', async t => {
  const { request, manifest, root, privateRoot } = await fixture(t);
  await writeFile(join(root, 'outside.obj'), 'OUTSIDE-CANARY');
  await symlink(join(root, 'outside.obj'), join(privateRoot, 'escape.obj'));
  const missingId = { ...descriptor }; delete missingId.id;
  for (const contents of ['{invalid-json', {}, [descriptor, descriptor], [missingId], [{ ...descriptor, file: '../outside.obj' }],
    [{ ...descriptor, file: join(root, 'outside.obj') }], [{ ...descriptor, file: 'escape.obj' }],
    [{ ...descriptor, file: 'models/missing.obj' }], [{ ...descriptor, units: 'unknown' }]]) {
    await manifest(contents);
    const response = await request('/local-examples.js');
    assert.equal(response.status, 500);
    assert.equal(response.body, 'The local example configuration is invalid.');
    assert.ok(!response.body.includes(root) && !response.body.includes('OUTSIDE-CANARY'));
  }
});

test('the public build retains an empty catalog and excludes local inputs and unlisted files', async t => {
  const root = await temporary(t);
  await cp(new URL('./', import.meta.url), join(root, 'demo'), { recursive: true });
  await cp(new URL('../server.mjs', import.meta.url), join(root, 'server.mjs'));
  await mkdir(join(root, 'scripts'));
  await cp(new URL('../scripts/build-public.mjs', import.meta.url), join(root, 'scripts/build-public.mjs'));
  await mkdir(join(root, 'private/models'), { recursive: true });
  await writeFile(join(root, 'private/examples.json'), JSON.stringify([descriptor]));
  await writeFile(join(root, 'private/models/triangle.obj'), 'BUILD-PRIVATE-CANARY');
  await writeFile(join(root, 'demo/not-listed.obj'), 'BUILD-PRIVATE-CANARY');
  await writeFile(join(root, 'demo/saved-study.json'), 'BUILD-PRIVATE-CANARY');
  await mkdir(join(root, '.git')); await writeFile(join(root, '.git/config'), 'BUILD-PRIVATE-CANARY');
  await execute(process.execPath, [join(root, 'scripts/build-public.mjs')]);
  const output = join(root, 'dist/panel-workbench');
  async function inspect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert.ok(!['private', '.git'].includes(entry.name));
      if (entry.isDirectory()) await inspect(join(path, entry.name));
      else {
        assert.ok(!/\.(obj|3dm|test\.mjs)$/.test(entry.name));
        assert.ok(!(await readFile(join(path, entry.name), 'utf8')).includes('BUILD-PRIVATE-CANARY'));
      }
    }
  }
  await inspect(output);
  assert.equal(await readFile(join(output, 'demo/local-examples.js'), 'utf8'), stub);
  assert.deepEqual((await import(pathToFileURL(join(output, 'demo/local-examples.js')))).LOCAL_EXAMPLES, []);
  const publicServer = (await import(pathToFileURL(join(output, 'server.mjs')))).createServer();
  const request = await listen(t, publicServer);
  assert.equal((await request('/local-examples.js')).body, stub);
  assert.equal((await request('/local-examples/local-triangle.obj')).status, 404);
});
