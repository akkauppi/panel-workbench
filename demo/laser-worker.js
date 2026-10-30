import { buildLaserNet } from './laser-net.js';

export function createWorkerHandler(postMessage) {
  return ({ data }) => {
    try { postMessage({ id: data.id, result: buildLaserNet(data.cells, data.options) }); }
    catch (error) { postMessage({ id: data.id, error: error.message || String(error), diagnostics: error.diagnostics || [] }); }
  };
}
if (typeof self !== 'undefined') self.onmessage = createWorkerHandler(data => self.postMessage(data));
