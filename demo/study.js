import { readLayout, layoutRecipe, nextLayoutCellId } from './layout.js';
import { readPattern } from './pattern.js';
import { readGeneratorPolicy, readMaxGeneratedCells, DEFAULT_MAX_GENERATED_CELLS } from './generator-policy.js';
import { readPanelOffsets } from './panel-offsets.js';
import { readProjectLimits, hasProjectLimits } from './project-limits.js';
import { readProtectedCellIds } from './edit-locks.js';
import { readCheckpoints } from './checkpoints.js';
import { readLastHandoff } from './handoff-record.js';
import { STUDY_VERSION, CURRENT_ENGINES, assertStudySize, utf8Bytes, createProjectMetadata,
  readProjectMetadata, readProducer, readEngines, requiredStudyFeatures, readRequiredFeatures, readCalculationMetadata } from './project-document.js';
import { readCalculationSummary } from './project-feedback.js';

// The authored source layout is persistent. Fitted panels and stock solids are
// derived outputs. Legacy generator inputs remain available to the old tools
// while direct graph editing is introduced.
const defaults = {
  seeds: [], mergeGroups: [], cornerEdits: [], layout: null, directBase: null, size: 620, variation: .3, randomSeed: 1,
  straightness: .7, thickness: 40, roundover: 2,
  carve: false, minimumThickness: 12, flipOutside: false,
};

const immutableLayouts = new WeakSet();

/** Worker results become immutable documents so history can safely share the
 * unchanged source layout and reset baseline across stock/settings edits. */
export function immutableLayout(layout) {
  if (!layout || immutableLayouts.has(layout)) return layout;
  const seen = new WeakSet();
  function freeze(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(layout);
  immutableLayouts.add(layout);
  return layout;
}

export function captureDesign(state) {
  const entries = Object.entries(defaults).filter(([key]) => key !== 'layout' && key !== 'directBase');
  const result = structuredClone(Object.fromEntries(entries.map(([key, fallback]) => [key, state[key] ?? fallback])));
  result.pattern = readPattern(state.pattern);
  // History uses explicit null so Object.assign can turn an earlier adaptive
  // policy off. The transport reader below omits null for legacy byte stability.
  result.generatorPolicy = readGeneratorPolicy(state.generatorPolicy, result.pattern);
  // Explicit in history so Undo resets the limit; default omitted on transport.
  result.maxGeneratedCells = readMaxGeneratedCells(state.maxGeneratedCells);
  // Explicit empty arrays let Undo clear offsets; transport omits empty values
  // so all earlier no-offset studies retain their exact serialized fields.
  result.panelOffsets = readPanelOffsets(state.panelOffsets);
  result.projectLimits = readProjectLimits(state.projectLimits);
  result.protectedCellIds = readProtectedCellIds(state.protectedCellIds);
  for (const key of ['layout', 'directBase']) {
    const layout = state[key] ?? null;
    result[key] = layout && immutableLayouts.has(layout) ? layout : structuredClone(layout);
  }
  return result;
}

function isId(value) { return Number.isSafeInteger(value) && value >= 0; }
function isPoint(value) { return Array.isArray(value) && value.length === 3 && [0, 1, 2].every(i => Number.isFinite(value[i])); }

function number(value, fallback, min, max, label) {
  const result = value === undefined ? fallback : value;
  if (!Number.isFinite(result) || result < min || result > max) throw new Error(`The study contains an invalid ${label}.`);
  return result;
}

function boolean(value, label, fallback = false) {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`The study contains an invalid ${label}.`);
  return value ?? fallback;
}

function readModel(model, units) {
  if (!model || !Array.isArray(model.vertices) || !Array.isArray(model.triangles) || !model.vertices.length || !model.triangles.length) {
    throw new Error('The saved model needs vertices and surface triangles.');
  }
  if (model.vertices.length > 200000 || model.triangles.length > 150000) throw new Error('The saved model is too large for this demo.');
  const factor = { mm: 1, cm: 10, m: 1000 }[units];
  if (model.vertices.some(point => !isPoint(point) || point.some(value => !Number.isFinite(value * factor)))) {
    throw new Error('The saved model contains an invalid coordinate.');
  }
  let usableArea = 0;
  for (const triangle of model.triangles) {
    if (!Array.isArray(triangle) || triangle.length !== 3 || triangle.some(id => !isId(id) || id >= model.vertices.length)) {
      throw new Error('The saved model contains an invalid face index.');
    }
    const [a, b, c] = triangle.map(id => model.vertices[id]);
    const ab = b.map((v, i) => (v - a[i]) * factor), ac = c.map((v, i) => (v - a[i]) * factor);
    const area = .5 * Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
    if (!Number.isFinite(area)) throw new Error('The saved model contains an invalid surface area.');
    if (area >= 1e-9) usableArea += area;
  }
  if (!Number.isFinite(usableArea) || usableArea <= 0) throw new Error('The saved model has no usable surface area.');
  const result = { vertices: model.vertices.map(point => [...point]), triangles: model.triangles.map(triangle => [...triangle]) };
  if (typeof model.name === 'string') result.name = model.name;
  for (const key of ['originalFaceCount', 'skippedFaces']) if (isId(model[key])) result[key] = model[key];
  return result;
}

function readSeeds(seeds) {
  if (!Array.isArray(seeds) || !seeds.length || seeds.length > 500) throw new Error('The study needs between 1 and 500 cell centres.');
  const ids = new Set();
  return seeds.map(seed => {
    if (!seed || !isId(seed.id) || ids.has(seed.id)) throw new Error('The study has duplicate or invalid cell IDs.');
    if (!isPoint(seed.position)) throw new Error('The study contains an invalid cell position.');
    ids.add(seed.id);
    return { id: seed.id, position: [...seed.position], weight: number(seed.weight, 1, .1, 3, 'cell influence') };
  });
}

function readGroups(groups, seeds) {
  if (!Array.isArray(groups)) throw new Error('The study is missing its cell merge groups.');
  const seedIds = new Set(seeds.map(seed => seed.id)), used = new Set();
  return groups.map(group => {
    if (!group || !isId(group.id) || !Array.isArray(group.members) || group.members.length < 2 || !group.members.includes(group.id)) {
      throw new Error('The study contains an invalid cell merge group.');
    }
    const members = group.members.map(id => {
      if (!isId(id) || !seedIds.has(id)) throw new Error('A cell merge refers to an unknown cell.');
      if (used.has(id)) throw new Error('A cell belongs to more than one merge group or appears twice.');
      used.add(id);
      return id;
    });
    return { id: group.id, members };
  });
}

function readCornerEdits(edits, seeds) {
  if (!Array.isArray(edits)) throw new Error('The study is missing its corner edits.');
  if (edits.length > 128) throw new Error('The study supports at most 128 corner edits.');
  const seedIds = new Set(seeds.map(seed => seed.id)), editIds = new Set();
  return edits.map(edit => {
    if (!edit || typeof edit.id !== 'string' || !edit.id.length || edit.id.length > 512 || editIds.has(edit.id)) {
      throw new Error('The study contains a duplicate or invalid corner edit ID.');
    }
    editIds.add(edit.id);
    if (!isPoint(edit.anchor) || !isPoint(edit.target)) throw new Error('The study contains an invalid corner position.');
    if (!Array.isArray(edit.owners) || edit.owners.length < 2) throw new Error('A corner edit needs at least two cell owners.');
    // Owners describe the seed regions when the corner was first edited.
    // Subsequent merges may hide that corner without removing its influence.
    const used = new Set();
    const owners = edit.owners.map(owner => {
      if (!Array.isArray(owner) || !owner.length) throw new Error('A corner owner needs its original cell IDs.');
      return owner.map(id => {
        if (!isId(id) || !seedIds.has(id)) throw new Error('A corner edit refers to an unknown cell.');
        if (used.has(id)) throw new Error('A cell appears more than once among a corner edit\'s owners.');
        used.add(id);
        return id;
      });
    });
    return { id: edit.id, anchor: [...edit.anchor], owners, target: [...edit.target],
      radius: number(edit.radius, undefined, Number.MIN_VALUE, Infinity, 'corner influence radius') };
  });
}

/** Validate a complete save before the caller updates any live application state. */
export function readStudy(input) {
  if (typeof input === 'string') assertStudySize(utf8Bytes(input));
  const study = typeof input === 'string' ? JSON.parse(input) : input;
  if (!study || study.format !== 'sauna-cell-study') throw new Error('This is not a supported cell study.');
  if (Number.isInteger(study.version) && study.version > STUDY_VERSION) throw new Error(`This project uses file version ${study.version}; this build supports up to version ${STUDY_VERSION}. Open it with a newer compatible Panel Workbench. Keep the original file unchanged.`);
  if (![1, 2, 3, 4, 5, STUDY_VERSION].includes(study.version)) throw new Error('This is not a supported cell study version. Keep the original file and open it with a compatible Panel Workbench.');
  // Feature gates apply even if a future writer retains an older outer version.
  // Required editing semantics must never disappear through a read/save cycle.
  if (study.requiredFeatures !== undefined || study.version === STUDY_VERSION) readRequiredFeatures(study.requiredFeatures, study);
  if (!['mm', 'cm', 'm'].includes(study.units) || !['y', 'z'].includes(study.up)) throw new Error('The saved study has invalid units or orientation.');
  const seeds = readSeeds(study.seeds);
  const mergeGroups = readGroups(study.version === 1 ? [] : study.mergeGroups, seeds);
  const cornerEdits = readCornerEdits(study.version < 3 ? [] : study.cornerEdits, seeds);
  const randomSeed = study.randomSeed === undefined ? 1 : study.randomSeed;
  if (!isId(randomSeed)) throw new Error('The study contains an invalid arrangement seed.');
  const pattern = readPattern(study.pattern), generatorPolicy = readGeneratorPolicy(study.generatorPolicy, pattern);
  const maxGeneratedCells = readMaxGeneratedCells(study.maxGeneratedCells);
  if (maxGeneratedCells !== DEFAULT_MAX_GENERATED_CELLS && study.version < 6) throw new Error('A custom generation budget requires study file version 6 and its required-feature declaration. Keep the original file unchanged.');
  if (generatorPolicy && study.version < 6) throw new Error('Curvature sizing requires study file version 6 and its required-feature declaration. Keep the original file unchanged.');
  const panelOffsets = readPanelOffsets(study.panelOffsets);
  if (panelOffsets.length && study.version < 6) throw new Error('Panel offsets require study file version 6 and their required-feature declaration. Keep the original file unchanged.');
  const projectLimits = readProjectLimits(study.projectLimits), protectedCellIds = readProtectedCellIds(study.protectedCellIds);
  if (study.version < 6 && (hasProjectLimits(projectLimits) || protectedCellIds.length || study.checkpoints?.length || study.lastHandoff != null)) throw new Error('Project limits, edit locks, checkpoints and handoff history require study file version 6 and their required-feature declarations. Keep the original file unchanged.');
  const view = study.view ?? 'surface';
  if (!['surface', 'flat', 'solid', 'reference'].includes(view)) throw new Error('The study contains an invalid view.');
  if (study.name !== undefined && typeof study.name !== 'string') throw new Error('The study contains an invalid name.');
  const result = {
    // Versions 1–3 are normalized as a legacy recipe. The worker materializes
    // their source layout before the document is installed or saved as v6.
    format: 'sauna-cell-study', version: study.version >= 4 ? study.version : 3, name: study.name || 'Opened study',
    rawModel: readModel(study.rawModel, study.units), units: study.units, up: study.up,
    seeds, mergeGroups, cornerEdits, pattern,
    ...(generatorPolicy ? { generatorPolicy } : {}),
    ...(maxGeneratedCells !== DEFAULT_MAX_GENERATED_CELLS ? { maxGeneratedCells } : {}),
    ...(panelOffsets.length ? { panelOffsets } : {}),
    ...(hasProjectLimits(projectLimits) ? { projectLimits } : {}),
    ...(protectedCellIds.length ? { protectedCellIds } : {}),
    size: number(study.size, undefined, Number.MIN_VALUE, Infinity, 'cell size'),
    variation: number(study.variation, undefined, 0, 1, 'variation'), randomSeed,
    straightness: number(study.straightness, .7, 0, 1, 'border straightness'),
    thickness: number(study.thickness, 40, 10, 300, 'thickness'),
    roundover: number(study.roundover, 2, 0, 10, 'edge radius'),
    carve: boolean(study.carve, 'carving setting'),
    minimumThickness: number(study.minimumThickness, 12, 3, 100, 'minimum thickness'),
    flipOutside: boolean(study.flipOutside, 'inside/outside setting'), view,
    layout: study.version >= 4 ? readLayout(study.layout) : null,
    directBase: study.version >= 5 && study.directBase != null ? readLayout(study.directBase) : null,
    allowCellRemoval: boolean(study.allowCellRemoval, 'cell removal setting', true),
  };
  if (panelOffsets.length) {
    if (!result.layout) throw new Error('Panel offsets need their saved source layout. Keep the original project file unchanged.');
    readPanelOffsets(panelOffsets, result.layout.cells);
  }
  if (protectedCellIds.length) {
    if (!result.layout) throw new Error('Edit locks need their saved source layout. Keep the original study unchanged.');
    readProtectedCellIds(protectedCellIds, result.layout.cells);
  }
  if (result.pattern.type !== 'organic' && result.cornerEdits.length) {
    throw new Error('This layout pattern cannot use legacy corner targets.');
  }
  if (result.layout && JSON.stringify(result.layout.recipe) !== JSON.stringify(layoutRecipe(result))) {
    throw new Error('The saved layout does not match its editing inputs.');
  }
  if ((result.layout?.authority === 'graph') !== !!result.directBase) {
    throw new Error('The saved direct layout needs its original layout for resetting edits.');
  }
  if (result.directBase && (result.directBase.authority === 'graph' ||
    JSON.stringify(result.directBase.recipe) !== JSON.stringify(layoutRecipe(result)) ||
    JSON.stringify(result.directBase.source) !== JSON.stringify(result.layout.source))) {
    throw new Error('The saved direct-edit baseline does not match this design.');
  }
  if(study.nextCellId!==undefined){
    const minimum=Math.max(nextLayoutCellId(result.layout),nextLayoutCellId(result.directBase),...seeds.map(seed=>seed.id+1));
    if(!isId(study.nextCellId)||study.nextCellId<minimum)throw new Error('The study contains a stale or invalid next panel ID.');
    result.nextCellId=study.nextCellId;
  }
  if (study.version === STUDY_VERSION) {
    if (study.nextCellId === undefined) throw new Error('The project is missing its next panel ID.');
    result.project = readProjectMetadata(study.project);
    result.producer = readProducer(study.producer);
    result.engines = readEngines(study.engines);
    result.requiredFeatures = readRequiredFeatures(study.requiredFeatures, result);
    if (study.lastCalculation !== undefined) result.lastCalculation = readCalculationMetadata(study.lastCalculation, result.project, readCalculationSummary);
    const lastHandoff = readLastHandoff(study.lastHandoff, result.project);
    if (lastHandoff) result.lastHandoff = lastHandoff;
  }
  if (study.camera !== undefined || study.target !== undefined) {
    if (!isPoint(study.camera) || !isPoint(study.target)) throw new Error('The study contains an invalid camera position.');
    result.camera = [...study.camera]; result.target = [...study.target];
  }
  if (study.checkpoints !== undefined) {
    const checkpoints = readCheckpoints(study.checkpoints, result, readStudy);
    if (checkpoints.length) result.checkpoints = checkpoints;
  }
  // Recheck after optional document metadata was canonicalized. A checkpoint
  // or handoff must never disappear from a subsequent read/save cycle.
  if (study.version === STUDY_VERSION) result.requiredFeatures = readRequiredFeatures(study.requiredFeatures, result);
  return result;
}

export function createStudy(state, { units, up, camera, target, project, producer, engines, lastCalculation = state.lastCalculation } = {}) {
  if (!state.layout) throw new Error('Wait for the source layout to finish before saving.');
  const study = {
    ...captureDesign(state), format: 'sauna-cell-study', version: STUDY_VERSION, allowCellRemoval: state.allowCellRemoval ?? true,
    nextCellId: state.nextCellId ?? Math.max(nextLayoutCellId(state.layout), nextLayoutCellId(state.directBase), ...state.seeds.map(seed => seed.id + 1)),
    name: state.name, rawModel: state.rawModel, view: state.view,
    units, up, camera, target,
    project: project ?? state.project ?? createProjectMetadata(),
    producer: producer ?? state.producer ?? { name: 'Panel Workbench', build: 'Local development' },
    engines: engines ?? state.engines ?? CURRENT_ENGINES,
    ...(lastCalculation !== undefined ? { lastCalculation } : {}),
    ...(state.checkpoints?.length ? { checkpoints: state.checkpoints } : {}),
    ...(state.lastHandoff != null ? { lastHandoff: state.lastHandoff } : {}),
  };
  study.requiredFeatures = requiredStudyFeatures(study);
  return readStudy(study);
}

/** The single transport path for downloads and recovery uses the same UTF-8
 * byte limit as opening. A large valid study cannot become an unreadable save. */
export function serializeStudy(study) {
  const text = JSON.stringify(readStudy(study));
  assertStudySize(utf8Bytes(text));
  return text;
}
