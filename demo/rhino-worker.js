import { loadRhino } from './rhino-runtime.js';
import { exportProduction3DM, exportRepair3DM } from './rhino-export.js';
import { parse3DM } from './rhino-import.js';

export function createWorkerHandler(postMessage) {
  return async ({ data }) => {
    try {
      const rhino = await loadRhino();
      if (data.operation === 'import') {
        postMessage({ id:data.id, model:parse3DM(new Uint8Array(data.bytes),rhino) });
      } else if(data.operation === 'export') {
        const bytes=exportProduction3DM(data.cells,data.solids,rhino,data.options);
        postMessage({ id:data.id, bytes },[bytes.buffer]);
      } else if(data.operation === 'repair-export') {
        const bytes=exportRepair3DM(data.cells,data.solids,data.sourceCells,rhino,data.options);
        postMessage({ id:data.id, bytes },[bytes.buffer]);
      } else throw new Error('Unknown Rhino file operation.');
    } catch(error) { postMessage({ id:data.id, error:error.message || String(error) }); }
  };
}
if(typeof self !== 'undefined') self.onmessage=createWorkerHandler((...args)=>self.postMessage(...args));
