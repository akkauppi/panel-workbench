/** Deliberate, portable design alternatives. Unlike rolling recovery copies,
 * named checkpoints are never evicted to make room for another checkpoint. */
export const CHECKPOINTS_FEATURE = 'named-checkpoints-v1';
export const MAX_CHECKPOINTS = 8;

function fail(message) { throw new Error(`The named checkpoints ${message}. Keep the original study unchanged.`); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f]/.test(value)) throw new Error('Give the checkpoint a name between 1 and 80 characters.');
  return value.trim();
}
function identity(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
function sourceKey(study) { const source=study?.layout?.source; return `${source?.vertexCount}:${source?.triangleCount}:${source?.signature}`; }

function snapshotStudy(study) {
  const { rawModel, checkpoints, lastHandoff, ...snapshot } = study;
  snapshot.requiredFeatures = snapshot.requiredFeatures?.filter(feature => ![CHECKPOINTS_FEATURE, 'handoff-history-v1'].includes(feature));
  return snapshot;
}

/** The parent study stores the mesh once. Each checkpoint stores the complete
 * authored design, view, settings and calculation evidence against that mesh.
 * readStudy validates the materialized document before any live replacement. */
export function checkpointStudy(checkpoint, parentStudy) {
  if (!object(checkpoint?.study) || !object(parentStudy?.rawModel)) fail('need their original source mesh');
  const snapshot = checkpoint.study;
  if (snapshot.version !== 6) fail('require a supported version 6 checkpoint document');
  if (snapshot.rawModel !== undefined || snapshot.checkpoints !== undefined || snapshot.lastHandoff !== undefined) fail('must not contain nested checkpoints, source meshes or handoff history');
  if (!parentStudy.layout || !snapshot.layout || sourceKey(snapshot) !== sourceKey(parentStudy) || snapshot.units !== parentStudy.units) fail('refer to a different source shell or units');
  if (!parentStudy.project || snapshot.project?.id !== parentStudy.project.id || !Number.isSafeInteger(snapshot.project?.revision) || snapshot.project.revision > parentStudy.project.revision) fail('refer to another project or a future revision');
  return { ...structuredClone(snapshot), rawModel: parentStudy.rawModel };
}

/** Validate without importing study.js (which uses this module). Keeping the
 * reader as a callback avoids a circular module dependency and bounds nesting
 * before the complete child document is examined. */
export function readCheckpoints(input, parentStudy, readStudy) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_CHECKPOINTS) fail(`must contain at most ${MAX_CHECKPOINTS} entries; download a backup and remove an unwanted checkpoint before adding another`);
  const ids = new Set(), names = new Set();
  return input.map(item => {
    if (!object(item) || !identity(item.id) || ids.has(item.id)) fail('have a missing or repeated checkpoint ID');
    const label = name(item.name), folded = label.toLocaleLowerCase('en-US');
    if (names.has(folded)) fail('have repeated names; use a different name for each design alternative');
    if (!timestamp(item.createdAt)) fail('have an invalid saved date');
    const materialized = checkpointStudy(item, parentStudy);
    if (Date.parse(item.createdAt) < Date.parse(materialized.project.createdAt)) fail('have a saved date before the project existed');
    const study = readStudy(materialized);
    if (study.nextCellId > parentStudy.nextCellId) fail('contain panel IDs beyond the current project counter');
    ids.add(item.id); names.add(folded);
    return { id: item.id, name: label, createdAt: item.createdAt, study: snapshotStudy(study) };
  });
}

/** Call with a validated currentStudy(). The application must serialize the
 * proposed parent study before accepting it, so the shared file-size limit is
 * enforced while the current checkpoints are still untouched. */
export function createCheckpoint(study, label, { id = globalThis.crypto?.randomUUID?.() ?? `checkpoint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, now = new Date() } = {}) {
  if (!study?.layout || !study.project) throw new Error('Finish the source layout before creating a checkpoint.');
  const existing = study.checkpoints || [];
  if (existing.length >= MAX_CHECKPOINTS) throw new Error(`This study already has ${MAX_CHECKPOINTS} named checkpoints. Download a backup and remove an unwanted checkpoint before adding another. No checkpoint was removed.`);
  const checkpointName = name(label);
  if (existing.some(checkpoint => checkpoint.name.toLocaleLowerCase('en-US') === checkpointName.toLocaleLowerCase('en-US'))) throw new Error('That checkpoint name is already used. Choose a different name.');
  if (!identity(id) || existing.some(checkpoint => checkpoint.id === id)) throw new Error('The checkpoint ID is invalid or already used.');
  const createdAt = new Date(now).toISOString();
  if (!timestamp(createdAt) || Date.parse(createdAt) < Date.parse(study.project.createdAt)) throw new Error('The checkpoint date must not be earlier than this project.');
  return { id, name: checkpointName, createdAt, study: structuredClone(snapshotStudy(study)) };
}
