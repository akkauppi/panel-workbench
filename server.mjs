import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const defaultDemoRoot = fileURLToPath(new URL('./demo/', import.meta.url));
const defaultPrivateRoot = fileURLToPath(new URL('./private/', import.meta.url));
const types = { '.wasm': 'application/wasm', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.obj': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
const within = (root, path) => path.startsWith(root.endsWith(sep) ? root : root + sep);
const localConfigError = () => new Error('The local example configuration is invalid.');

async function localExamples(privateRoot) {
  let contents;
  try { contents = await readFile(resolve(privateRoot, 'examples.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw localConfigError(); }
  try {
    const entries = JSON.parse(contents), root = await realpath(privateRoot);
    if (!within(root, await realpath(resolve(privateRoot, 'examples.json'))) || !Array.isArray(entries) || entries.length > 100) throw localConfigError();
    const ids = new Set(), examples = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id) || ids.has(entry.id) ||
        typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 200 ||
        typeof entry.description !== 'string' || entry.description.length > 2000 ||
        !['mm', 'cm', 'm'].includes(entry.units) || !['y', 'z'].includes(entry.up) ||
        !Number.isFinite(entry.initialSize) || entry.initialSize <= 0 ||
        typeof entry.file !== 'string' || !entry.file.endsWith('.obj') || entry.file.includes('\\') || entry.file.includes('\0') ||
        entry.file.split('/').some(part => !part || part === '.' || part === '..')) throw localConfigError();
      const file = await realpath(resolve(privateRoot, entry.file));
      if (!within(root, file) || !(await stat(file)).isFile()) throw localConfigError();
      ids.add(entry.id);
      examples.push({ file, descriptor: { id: entry.id, name: entry.name, description: entry.description,
        units: entry.units, up: entry.up, initialSize: entry.initialSize, url: `./local-examples/${entry.id}.obj` } });
    }
    return examples;
  } catch { throw localConfigError(); }
}

function send(req, res, status, content, type = 'text/plain; charset=utf-8') {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createServer({ demoRoot = defaultDemoRoot, privateRoot = defaultPrivateRoot } = {}) {
  demoRoot = resolve(demoRoot); privateRoot = resolve(privateRoot);
  return http.createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { send(req, res, 405, 'Method not allowed'); return; }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/local-examples.js' || pathname.startsWith('/local-examples/')) {
        const match = pathname.match(/^\/local-examples\/([a-z0-9][a-z0-9-]{0,63})\.obj$/);
        if (pathname !== '/local-examples.js' && !match) { send(req, res, 404, 'Not found'); return; }
        let examples;
        try { examples = await localExamples(privateRoot); }
        catch { send(req, res, 500, 'The local example configuration is invalid.'); return; }
        if (pathname === '/local-examples.js') {
          if (!examples.length) send(req, res, 200, await readFile(resolve(demoRoot, 'local-examples.js')), types['.js']);
          else send(req, res, 200, `export const LOCAL_EXAMPLES = ${JSON.stringify(examples.map(example => example.descriptor))};\n`, types['.js']);
          return;
        }
        const example = examples.find(value => value.descriptor.id === match[1]);
        if (!example) { send(req, res, 404, 'Not found'); return; }
        send(req, res, 200, await readFile(example.file), types['.obj']);
        return;
      }
      const path = resolve(demoRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!within(demoRoot, path)) { send(req, res, 403, 'Forbidden'); return; }
      const actual = await realpath(path), root = await realpath(demoRoot);
      if (!within(root, actual)) { send(req, res, 403, 'Forbidden'); return; }
      if (!(await stat(actual)).isFile()) { send(req, res, 404, 'Not found'); return; }
      send(req, res, 200, await readFile(actual), types[extname(path)] || 'application/octet-stream');
    } catch { send(req, res, 404, 'Not found'); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.on('error', error => { console.error(`Could not start the demo: ${error.message}`); process.exitCode = 1; });
  server.listen(port, host, () => {
    console.log(`Panel Workbench: http://localhost:${port}`);
    console.log(`Listening on ${host}:${port}`);
    try {
      for (const list of Object.values(os.networkInterfaces())) for (const address of list || []) {
        if (address.family === 'IPv4' && !address.internal) console.log(`LAN: http://${address.address}:${port}`);
      }
    } catch { console.log(`LAN: http://<this-computer-IP>:${port}`); }
  });
}
