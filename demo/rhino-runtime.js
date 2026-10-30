// Lazy local loading keeps ordinary editing independent of the CAD runtime.
let pending;
export function loadRhino() {
  return pending ??= (async () => {
    const { default: createRhino } = await import('./vendor/rhino3dm/rhino3dm.module.js');
    const wasm = new URL('./vendor/rhino3dm/rhino3dm.wasm', import.meta.url);
    const options = { locateFile: () => wasm.href };
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { readFile } = await import('node:fs/promises');
      options.wasmBinary = await readFile(wasm);
    }
    return createRhino(options);
  })().catch(error => { pending = null; throw new Error(`Could not load Rhino file support: ${error.message}`); });
}
