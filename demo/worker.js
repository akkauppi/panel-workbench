import { analyzeModel } from './geometry.js';
import { resolveSourceLayout } from './design.js';
import { transactLayout } from './layout-edit.js';
import { fitSharedPanels } from './fitted.js';
import { buildPanelSolids, attachSolidCornerPositions } from './solids.js';
import { buildCarvedPanels, summarizeCarving } from './carving.js';
import { inspectPolygon, measureLayoutQuality } from './quality.js';

export function createWorkerHandler(postMessage) {
  let model = null;
  return ({ data }) => {
    if (data.validationId !== undefined) {
      try {
        if (!data.model) throw new Error('The saved study needs a source model.');
        const { layout, change, surface } = data.transaction
          ? transactLayout(data.model, data.layout, data.transaction)
          : resolveSourceLayout(data.model, data, { strict: true });
        postMessage({ validationId: data.validationId, layout, change, surface: data.transaction ? surface : undefined });
      } catch (error) {
        postMessage({ validationId: data.validationId, error: error.message || String(error) });
      }
      return;
    }
    const started = performance.now();
    try {
      if (data.model) model = data.model;
      if (!model) throw new Error('Load a mesh first.');
      const { seeds, surface, layout } = resolveSourceLayout(model, data);
      const analysis = analyzeModel(model);
      const result = fitSharedPanels(surface, { straightness: data.straightness ?? 0.7, iterations: 700,
        panelOffsets: data.panelOffsets, thickness: data.thickness ?? 40, outwardCenter: analysis.center, flipDirection: !!data.flipOutside });
      for (const cell of result.cells) cell.polygonQuality = inspectPolygon(cell.outline2d);
      result.quality = measureLayoutQuality(result.cells);
      result.solids = buildPanelSolids(result.cells, { thickness: data.thickness ?? 40, radius: data.roundover ?? 2,
        roundoverSide: data.carve ? 'positive' : 'both', outwardCenter: analysis.center, flipDirection: !!data.flipOutside });
      if (data.carve) {
        result.solids = buildCarvedPanels(result.solids, result.cells, model, { minimumThickness: data.minimumThickness ?? 12, subdivisions: 2 });
        result.carving = summarizeCarving(result.solids);
      }
      result.corners = attachSolidCornerPositions(result.corners || [], result.solids);
      postMessage({ id: data.id, seeds, layout, result, analysis, elapsed: performance.now() - started });
    } catch (error) {
      postMessage({ id: data.id, error: error.message || String(error) });
    }
  };
}
if (typeof self !== 'undefined') self.onmessage = createWorkerHandler(data => self.postMessage(data));
