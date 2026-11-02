export const HANDOFF_HISTORY_FEATURE = 'handoff-history-v1';

/** Small export history, separate from geometry history. It does not contain
 * file hashes, source geometry, names, or nested prior handoff records. */
export function readLastHandoff(input, project) {
  if (input === undefined || input === null) return null;
  const fail = () => { throw new Error('The saved Rhino handoff history is invalid. Keep the original study unchanged.'); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1 ||
      typeof input.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.projectId) ||
      !Number.isSafeInteger(input.revision) || input.revision < 1 ||
      typeof input.build !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._:+()@-]{0,255}$/.test(input.build) ||
      !['production','repair'].includes(input.kind) || typeof input.exportedAt !== 'string' ||
      !Number.isFinite(Date.parse(input.exportedAt)) || new Date(input.exportedAt).toISOString() !== input.exportedAt ||
      !Array.isArray(input.panels) || !input.panels.length || input.panels.length > 2000) fail();
  if (project && (input.projectId !== project.id || input.revision > project.revision)) fail();
  const seen = new Set(), panels = input.panels.map(panel => {
    if (!Number.isSafeInteger(panel?.id) || panel.id < 0 || seen.has(panel.id) || typeof panel.fingerprint !== 'string' || !/^pf1:[a-f0-9]{16}$/.test(panel.fingerprint)) fail();
    seen.add(panel.id); return { id: panel.id, fingerprint: panel.fingerprint };
  }).sort((a,b) => a.id - b.id);
  return { version: 1, projectId: input.projectId, revision: input.revision, build: input.build,
    exportedAt: input.exportedAt, kind: input.kind, panels };
}
