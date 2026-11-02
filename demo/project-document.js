import { CURVATURE_SIZING_FEATURE } from './generator-policy.js';
import { PANEL_OFFSETS_FEATURE } from './panel-offsets.js';
import { CHECKPOINTS_FEATURE } from './checkpoints.js';
import { PROJECT_LIMITS_FEATURE, hasProjectLimits } from './project-limits.js';
import { EDIT_LOCKS_FEATURE } from './edit-locks.js';
import { HANDOFF_HISTORY_FEATURE } from './handoff-record.js';

/** Project metadata and transport limits are independent of geometry history.
 * Engine identifiers describe calculation implementations, not file schemas.
 * Bump the relevant identifier when a release intentionally changes its output;
 * the producer build still identifies the exact code used by a saved project. */
export const STUDY_VERSION = 6;
export const MAX_STUDY_BYTES = 128 * 1024 * 1024;
export const CURRENT_ENGINES = Object.freeze({
  sourceLayout: 'authored-source-v1', fittedPanels: 'shared-planes-v1', panelSolids: 'panel-stock-v1',
});
export const SUPPORTED_FEATURES = Object.freeze(['source-layout', 'direct-layout', 'split-ancestry', 'retired-panel-ids', CURVATURE_SIZING_FEATURE, PANEL_OFFSETS_FEATURE,
  CHECKPOINTS_FEATURE, PROJECT_LIMITS_FEATURE, EDIT_LOCKS_FEATURE, HANDOFF_HISTORY_FEATURE]);

export function utf8Bytes(text) {
  if (typeof text !== 'string') throw new Error('The project must be JSON text.');
  return new TextEncoder().encode(text).byteLength;
}

export function assertStudySize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('The project has an invalid file size.');
  if (bytes > MAX_STUDY_BYTES) throw new Error('This project exceeds the 128 MiB file limit. Keep the original file and use a smaller source mesh or a compatible version with a larger limit.');
  return bytes;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`The project contains invalid ${label}.`);
  return value;
}

function text(value, label, maximum = 256) {
  if (typeof value !== 'string' || !value.length || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new Error(`The project contains an invalid ${label}.`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`The project contains an invalid ${label}.`);
  return value;
}

export function readProjectMetadata(input) {
  object(input, 'project identity');
  const id = text(input.id, 'project ID', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new Error('The project contains an invalid project ID.');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('The project contains an invalid revision.');
  const createdAt = timestamp(input.createdAt, 'creation date'), updatedAt = timestamp(input.updatedAt, 'revision date');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error('The project revision date precedes its creation date.');
  return { id, revision: input.revision, createdAt, updatedAt };
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) return `project-${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')}`;
  // Local development and test hosts may not expose Web Crypto. IDs identify
  // documents; they are not authentication tokens or security boundaries.
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function createProjectMetadata({ id = newId(), now = new Date() } = {}) {
  const createdAt = new Date(now).toISOString();
  return readProjectMetadata({ id, revision: 1, createdAt, updatedAt: createdAt });
}

export function advanceProjectRevision(input, { now = new Date() } = {}) {
  const project = readProjectMetadata(input);
  const updatedAt = new Date(Math.max(Date.parse(project.updatedAt), new Date(now).getTime())).toISOString();
  return readProjectMetadata({ ...project, revision: project.revision + 1, updatedAt });
}

export function readProducer(input) {
  object(input, 'producer metadata');
  return { name: text(input.name, 'producer name', 100), build: text(input.build, 'producer build') };
}

export function readEngines(input) {
  object(input, 'calculation engine metadata');
  // A stored source graph can be read independently of the fitter that last
  // processed it. Preserve unfamiliar engine versions as provenance.
  return Object.fromEntries(Object.keys(CURRENT_ENGINES).map(key => [key, text(input[key], `${key} engine`, 100)]));
}

export function requiredStudyFeatures(study) {
  const adaptive = study.generatorPolicy != null || study.layout?.recipe?.generatorPolicy != null || study.directBase?.recipe?.generatorPolicy != null;
  return ['source-layout', ...(study.layout?.authority === 'graph' ? ['direct-layout'] : []),
    ...(study.layout?.version === 3 ? ['split-ancestry'] : []), 'retired-panel-ids', ...(adaptive ? [CURVATURE_SIZING_FEATURE] : []),
    ...(study.panelOffsets?.length ? [PANEL_OFFSETS_FEATURE] : []),
    ...(hasProjectLimits(study.projectLimits) ? [PROJECT_LIMITS_FEATURE] : []),
    ...(study.protectedCellIds?.length ? [EDIT_LOCKS_FEATURE] : []),
    ...(study.checkpoints?.length ? [CHECKPOINTS_FEATURE] : []),
    ...(study.lastHandoff != null ? [HANDOFF_HISTORY_FEATURE] : [])];
}

export function readRequiredFeatures(input, study) {
  if (!Array.isArray(input) || input.length > 64 || input.some(feature => typeof feature !== 'string' || !feature.length || feature.length > 100) || new Set(input).size !== input.length) throw new Error('The project contains invalid required features.');
  const unsupported = input.filter(feature => !SUPPORTED_FEATURES.includes(feature));
  if (unsupported.length) throw new Error(`This project requires unsupported features: ${unsupported.join(', ')}. Open it with a newer compatible Panel Workbench. Keep the original file unchanged.`);
  for (const feature of requiredStudyFeatures(study)) if (!input.includes(feature)) throw new Error(`The project is missing its required ${feature} feature declaration.`);
  return [...input];
}

export function readCalculationMetadata(input, project, readSummary) {
  object(input, 'last calculation metadata');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > project.revision) throw new Error('The project contains an invalid last calculation revision.');
  return { revision: input.revision, build: text(input.build, 'calculation build'), summary: readSummary(input.summary) };
}
