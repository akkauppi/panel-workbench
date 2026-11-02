/** Authored translations of fitted panel planes, in millimetres. The normal
 * belongs to the unoffset fitted plane and does not change with stock-side
 * settings. Geometry and feasibility remain the fitter's responsibility. */
export const PANEL_OFFSETS_FEATURE = 'panel-offsets-v1';
export const MAX_PANEL_OFFSET_MM = 10000;

/** Return an independent canonical array. Passing accepted cells additionally
 * checks identity: an offset must never move a different or retired panel. */
export function readPanelOffsets(input, cells) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 100000) throw new Error('Panel offsets must be a list of panel numbers and distances.');
  const available = cells === undefined ? null : new Set(cells.map(cell => cell.id));
  const seen = new Set(), result = [];
  for (const item of input) {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 0 || seen.has(item.id)) throw new Error('A panel offset has a missing, repeated or invalid panel number.');
    seen.add(item.id);
    if (!Number.isFinite(item.offsetMm) || Math.abs(item.offsetMm) > MAX_PANEL_OFFSET_MM) throw new Error(`Enter a panel offset between -${MAX_PANEL_OFFSET_MM} and ${MAX_PANEL_OFFSET_MM} mm. This range does not guarantee that the panels can meet.`);
    if (available && !available.has(item.id)) throw new Error(`The offset refers to panel P${String(item.id + 1).padStart(3, '0')}, which is not in this layout. Keep the original project file unchanged.`);
    if (item.offsetMm !== 0) result.push({ id: item.id, offsetMm: item.offsetMm });
  }
  return result.sort((a, b) => a.id - b.id);
}

/** Source edits keep offsets by stable panel ID. Callers explicitly reset
 * changed identities: merge passes all merged IDs, split passes its parent.
 * New arrangements and reset-layout pass no offsets. Undo stores the prior
 * array, so reset distances can always be restored with the source edit. */
export function reconcilePanelOffsets(input, layout, { clearIds = [] } = {}) {
  const present = new Set((layout?.cells || []).map(cell => cell.id)), cleared = new Set(clearIds);
  return readPanelOffsets(input).filter(item => present.has(item.id) && !cleared.has(item.id));
}
