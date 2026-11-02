import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDesign, createStudy, readStudy, immutableLayout } from './study.js';
import { generateCellLayout } from './geometry.js';
import { captureLayout, layoutRecipe } from './layout.js';
import { transactLayout } from './layout-edit.js';
import { readPattern } from './pattern.js';

function fixture() {
  return {
    format: 'sauna-cell-study', version: 3, layout: null, directBase: null, allowCellRemoval: true, name: 'Manual design', units: 'mm', up: 'y',
    rawModel: { vertices: [[0, 0, 0], [1000, 0, 0], [1000, 1000, 0], [0, 1000, 0]], triangles: [[0, 1, 2], [0, 2, 3]] },
    seeds: [{ id: 2, position: [200, 400, 0], weight: 1 }, { id: 7, position: [600, 400, 0], weight: 1.2 }, { id: 9, position: [800, 800, 0], weight: 1 }],
    mergeGroups: [{ id: 2, members: [2, 7] }],
    pattern: { type: 'organic', angle: 0, frequency: 2 },
    cornerEdits: [{ id: '2:7:9@500,500,0', anchor: [500, 500, 0], owners: [[2], [7], [9]], target: [520, 480, 0], radius: 400 }],
    size: 400, variation: .25, randomSeed: 7, straightness: .7, thickness: 40, roundover: 2,
    carve: false, minimumThickness: 12, flipOutside: false, view: 'flat', camera: [0, 100, 3000], target: [500, 500, 0],
  };
}

function authoredFixture() {
  const state = fixture();
  state.version = 5;
  state.cornerEdits = [];
  const surface = generateCellLayout(state.rawModel, state.seeds, state);
  state.layout = captureLayout(state.rawModel, surface, { recipe: layoutRecipe(state) });
  return state;
}

// New transport metadata must not change any field of a legacy authored study.
function asVersion5(study) {
  const { project, producer, engines, requiredFeatures, lastCalculation, nextCellId, ...design } = study;
  return { ...design, version: 5 };
}

test('saved corner and merged designs round trip with independent source, edits, settings and camera', () => {
  const original = fixture();
  const saved = readStudy(original);
  const reopened = readStudy(JSON.stringify(saved));
  assert.deepEqual(reopened, original);
  saved.mergeGroups[0].members.push(9);
  saved.cornerEdits[0].owners[0].push(9);
  saved.cornerEdits[0].target[0] = 600;
  saved.cornerEdits[0].anchor[0] = 700;
  saved.seeds[0].position[0] = 450;
  saved.rawModel.vertices[0][0] = 10;
  saved.camera[0] = 100;
  assert.deepEqual(original, fixture());
  assert.deepEqual(reopened, fixture());
});

test('undo snapshots retain source layout and design inputs without fitted geometry or model copies', () => {
  const state = { ...fixture(), cells: [{ id: 2 }], selected: 2, history: [] };
  const snapshot = captureDesign(state);
  assert.deepEqual(Object.keys(snapshot).sort(), ['seeds', 'mergeGroups', 'cornerEdits', 'layout', 'directBase', 'pattern', 'generatorPolicy', 'panelOffsets', 'projectLimits', 'protectedCellIds', 'size', 'variation', 'randomSeed', 'straightness', 'thickness', 'roundover', 'carve', 'minimumThickness', 'flipOutside'].sort());
  state.mergeGroups[0].members.push(9); state.seeds[0].position[0] = 500; state.thickness = 70;
  state.cornerEdits[0].target[0] = 600; state.cornerEdits[0].owners[0].push(9);
  assert.deepEqual(snapshot.mergeGroups, [{ id: 2, members: [2, 7] }]);
  assert.equal(snapshot.seeds[0].position[0], 200);
  assert.equal(snapshot.thickness, 40);
  assert.deepEqual(snapshot.cornerEdits, fixture().cornerEdits);
  assert.deepEqual(captureDesign({ seeds: [] }).mergeGroups, []);
  assert.deepEqual(captureDesign({ seeds: [] }).cornerEdits, []);
  assert.equal(snapshot.layout, null);
});

test('version 1 studies migrate without inventing merges and keep legacy defaults', () => {
  const old = fixture(); old.version = 1;
  for (const key of ['mergeGroups', 'cornerEdits', 'straightness', 'thickness', 'roundover', 'carve', 'minimumThickness', 'flipOutside', 'randomSeed', 'view', 'camera', 'target']) delete old[key];
  delete old.seeds[0].weight;
  const upgraded = readStudy(old);
  assert.equal(upgraded.version, 3);
  assert.deepEqual(upgraded.mergeGroups, []);
  assert.deepEqual(upgraded.cornerEdits, []);
  assert.equal(upgraded.seeds[0].weight, 1);
  assert.equal(upgraded.thickness, 40);
  assert.equal(upgraded.randomSeed, 1);
  assert.equal(upgraded.view, 'surface');
  assert.deepEqual(readStudy(JSON.stringify(upgraded)), upgraded);
  assert.equal(old.version, 1);
});

test('version 2 studies preserve merges and migrate with no corner edits', () => {
  const old = fixture(); old.version = 2; delete old.cornerEdits;
  const upgraded = readStudy(old);
  assert.equal(upgraded.version, 3);
  assert.deepEqual(upgraded.mergeGroups, old.mergeGroups);
  assert.deepEqual(upgraded.cornerEdits, []);
  assert.equal(old.version, 2);
  assert.deepEqual(readStudy(JSON.stringify(upgraded)), upgraded);
  delete old.mergeGroups;
  assert.throws(() => readStudy(old), /merge groups/);
});

test('historical corner owners survive later merges and may recur in other edits', () => {
  const study = fixture();
  study.mergeGroups = [{ id: 2, members: [2, 7, 9] }];
  study.cornerEdits.push({ id: 'another-corner', anchor: [200, 500, 0], owners: [[2, 7], [9]], target: [220, 510, 0], radius: 300 });
  const reopened = readStudy(JSON.stringify(study));
  assert.deepEqual(reopened.cornerEdits, study.cornerEdits);
  assert.deepEqual(reopened.mergeGroups, study.mergeGroups);
});

test('invalid or missing corner edits cannot be silently dropped or misapplied', () => {
  for (const mutate of [
    study => { delete study.cornerEdits; },
    study => { study.cornerEdits = null; },
    study => { study.cornerEdits = {}; },
    study => { study.cornerEdits[0].id = ''; },
    study => { study.cornerEdits[0].id = 7; },
    study => { study.cornerEdits[0].id = 'x'.repeat(513); },
    study => { study.cornerEdits.push(structuredClone(study.cornerEdits[0])); },
    study => { study.cornerEdits[0].anchor = [0, 0]; },
    study => { study.cornerEdits[0].target[0] = Infinity; },
    study => { study.cornerEdits[0].anchor[0] = NaN; },
    study => { study.cornerEdits[0].owners = [[2]]; },
    study => { study.cornerEdits[0].owners = [[2], []]; },
    study => { study.cornerEdits[0].owners = [[2], [99]]; },
    study => { study.cornerEdits[0].owners = [[2, 2], [7]]; },
    study => { study.cornerEdits[0].owners = [[2, 7], [7, 9]]; },
    study => { study.cornerEdits[0].radius = 0; },
    study => { study.cornerEdits[0].radius = -1; },
    study => { study.cornerEdits[0].radius = Infinity; },
    study => { study.cornerEdits[0].radius = NaN; },
    study => { study.cornerEdits[0].radius = '400'; },
  ]) {
    const study = fixture(); mutate(study);
    assert.throws(() => readStudy(study), /corner/);
  }
});

test('the study limit matches the geometry limit of 128 corner edits', () => {
  const study = fixture(), base = study.cornerEdits[0];
  study.cornerEdits = Array.from({ length: 128 }, (_, i) => ({ ...base, id: `corner-${i}` }));
  assert.equal(readStudy(study).cornerEdits.length, 128);
  study.cornerEdits.push({ ...base, id: 'one-too-many' });
  assert.throws(() => readStudy(study), /128 corner/);
});

test('merge references cannot be lost, overlap, repeat, or reference missing seed identities', () => {
  for (const groups of [undefined, null, {}, [{ id: 2, members: [2] }], [{ id: 9, members: [2, 7] }], [{ id: 2, members: [2, 99] }], [{ id: 2, members: [2, 2] }], [{ id: 2, members: [2, 7] }, { id: 7, members: [7, 9] }]]) {
    assert.throws(() => readStudy({ ...fixture(), mergeGroups: groups }), /merge|unknown cell/);
  }
});

test('invalid model coordinates and topology are rejected before the application can load them', () => {
  for (const mutate of [
    study => { study.rawModel.vertices[0] = [NaN, 0, 0]; },
    study => { study.rawModel.vertices[0] = [Infinity, 0, 0]; },
    study => { study.rawModel.vertices[0] = [0, 0]; },
    study => { study.rawModel.triangles[0] = [0, 1, 4]; },
    study => { study.rawModel.triangles[0] = [0, 1, 1.5]; },
    study => { study.rawModel.triangles = [[0, 0, 0]]; },
    study => { study.rawModel = { vertices: [], triangles: [] }; },
  ]) {
    const study = fixture(); mutate(study);
    assert.throws(() => readStudy(study), /model/);
  }
});

test('invalid identities, influences, settings and saved camera cannot silently change a design', () => {
  for (const mutate of [
    study => { study.seeds[0].id = 7; },
    study => { study.seeds[0].id = -1; },
    study => { study.seeds[0].id = Number.MAX_SAFE_INTEGER + 1; },
    study => { study.seeds[0].position[0] = Infinity; },
    study => { study.seeds[0].weight = 0; },
    study => { study.seeds[0].weight = NaN; },
    study => { study.seeds[0].weight = 4; },
    study => { study.thickness = '40'; },
    study => { study.thickness = 301; },
    study => { study.size = 0; },
    study => { study.variation = NaN; },
    study => { study.straightness = 1.1; },
    study => { study.carve = 'false'; },
    study => { study.randomSeed = 1.5; },
    study => { study.randomSeed = null; },
    study => { study.camera = [0, 1, NaN]; },
    study => { delete study.target; },
    study => { study.version = 6; },
  ]) {
    const study = fixture(); mutate(study);
    assert.throws(() => readStudy(study));
  }
});

test('the study limit matches the generator limit of 500 centres', () => {
  const study = fixture();
  study.mergeGroups = [];
  study.seeds = Array.from({ length: 500 }, (_, id) => ({ id, position: [id, 200, 0], weight: 1 }));
  assert.equal(readStudy(study).seeds.length, 500);
  study.seeds.push({ id: 500, position: [500, 200, 0], weight: 1 });
  assert.throws(() => readStudy(study), /500/);
});

test('new studies save the exact source layout independently of derived panels', () => {
  const original = authoredFixture();
  const saved = createStudy(original, { units: original.units, up: original.up, camera: original.camera, target: original.target });
  const reopened = readStudy(JSON.stringify(saved));
  assert.equal(saved.version, 6);
  assert.deepEqual(asVersion5(reopened), original);
  const snapshot = captureDesign(original);
  original.layout.vertices[0].position[0] += 1;
  original.layout.cells[0].positions[0][0] += 1;
  assert.deepEqual(snapshot.layout, saved.layout);
  assert.deepEqual(reopened.layout, saved.layout);
});

test('source snapshots require a complete layout and consistent legacy editing inputs', () => {
  const original = authoredFixture();
  for (const mutate of [
    state => { delete state.layout; },
    state => { state.layout = null; },
    state => { state.layout.version = 99; },
    state => { state.layout.vertices[0].position[0] = NaN; },
    state => { state.seeds[0].position[0] += 1; },
    state => { state.size += 1; },
    state => { state.mergeGroups = []; },
    state => { state.cornerEdits = fixture().cornerEdits; },
  ]) {
    const state = structuredClone(original); mutate(state);
    assert.throws(() => readStudy(state), /layout/i);
  }
});

test('legacy studies can open but cannot save a source document until their layout is materialized', () => {
  const old = fixture();
  assert.equal(readStudy(old).layout, null);
  assert.throws(() => createStudy(old, { units: old.units, up: old.up }), /layout/);
  const solved = authoredFixture();
  assert.equal(createStudy(solved, { units: solved.units, up: solved.up }).version, 6);
});

test('version 4 snapshots open unchanged with direct editing disabled and removal allowed by default', () => {
  const old = authoredFixture(); old.version = 4;
  delete old.directBase; delete old.allowCellRemoval;
  const reopened = readStudy(JSON.stringify(old));
  assert.deepEqual(reopened.layout, old.layout);
  assert.equal(reopened.directBase, null);
  assert.equal(reopened.allowCellRemoval, true);
});

function directFixture() {
  const state = authoredFixture();
  state.directBase = state.layout;
  state.layout = transactLayout(state.rawModel, state.layout, { type: 'merge-cells', cellIds: state.layout.cells.map(cell => cell.id) }).layout;
  state.allowCellRemoval = false;
  return state;
}

test('version 5 retains graph authority, the exact reset baseline and the removal preference', () => {
  const original = directFixture();
  const saved = createStudy(original, { units: original.units, up: original.up, camera: original.camera, target: original.target });
  const reopened = readStudy(JSON.stringify(saved));
  assert.deepEqual(asVersion5(reopened), original);
  assert.equal(saved.layout.authority, 'graph');
  assert.equal(saved.allowCellRemoval, false);
  assert.deepEqual(saved.directBase, authoredFixture().layout);
  original.directBase.vertices[0].position[0] += 1;
  assert.notDeepEqual(saved.directBase, original.directBase);
});

test('graph saves cannot lose their baseline, nest graph baselines or invent provenance', () => {
  for (const mutate of [
    state => { delete state.directBase; },
    state => { state.directBase = null; },
    state => { state.directBase = state.layout; },
    state => { state.directBase.recipe.size += 1; },
    state => { state.directBase.source.signature = '0000000000000000'; },
    state => { state.layout.cells[0].memberSeedIds.push(999); },
    state => { state.layout.corners.push({ id: 'vertex:missing' }); },
    state => { state.allowCellRemoval = 'yes'; },
  ]) {
    const state = directFixture(); mutate(state);
    assert.throws(() => readStudy(state), /direct|baseline|layout|removal/i);
  }
  const state = authoredFixture(); state.directBase = structuredClone(state.layout);
  assert.throws(() => readStudy(state), /direct/);
});

test('the removal preference does not create geometry history but direct reset state is captured', () => {
  const state = directFixture(), before = captureDesign(state);
  state.allowCellRemoval = true;
  assert.deepEqual(captureDesign(state), before);
  state.directBase.vertices[0].position[0] += 10;
  assert.notDeepEqual(state.directBase, before.directBase);
});

test('history shares protected source documents while keeping mutable inputs independent', () => {
  const state = directFixture();
  state.layout = immutableLayout(state.layout); state.directBase = immutableLayout(state.directBase);
  const before = captureDesign(state);
  state.thickness += 5;
  const after = captureDesign(state);
  assert.strictEqual(before.layout, after.layout);
  assert.strictEqual(before.directBase, after.directBase);
  assert.notEqual(before.thickness, after.thickness);
  assert.throws(() => { after.directBase.vertices[0].position[0] += 1; }, TypeError);
  assert.throws(() => { after.layout.cells[0].positions.push([0, 0, 0]); }, TypeError);
  state.seeds[0].position[0] += 1;
  assert.notDeepEqual(before.seeds, state.seeds);
});

test('pattern settings have explicit defaults and reject malformed generation controls', () => {
  assert.deepEqual(readPattern(), { type: 'organic', angle: 0, frequency: 2 });
  assert.deepEqual(readPattern({ type: 'hexagonal' }), { type: 'hexagonal', angle: 0, frequency: 2 });
  assert.deepEqual(readPattern({ frequency: 6, angle: 359.5, type: 'geodesic' }), { type: 'geodesic', angle: 359.5, frequency: 6 });
  for (const pattern of [null, [], 'hexagonal', { type: 'unknown' }, { type: null },
    { angle: null }, { angle: NaN }, { angle: Infinity }, { angle: -1 }, { angle: 360 }, { angle: '30' },
    { frequency: null }, { frequency: 0 }, { frequency: 7 }, { frequency: 2.5 }, { frequency: '2' }]) {
    assert.throws(() => readPattern(pattern), /pattern/);
    assert.throws(() => readStudy({ ...fixture(), pattern }), /pattern/);
  }
  assert.throws(() => readStudy({ ...fixture(), pattern: { type: 'hexagonal' } }), /legacy corner targets/);
});

function structuredFixture(type = 'hexagonal') {
  const state = authoredFixture();
  state.pattern = { type, angle: 30, frequency: 3 };
  state.layout.recipe = layoutRecipe(state);
  return state;
}

test('structured generator settings save and reopen independently of future draft changes', () => {
  for (const type of ['hexagonal', 'geodesic']) {
    const original = structuredFixture(type);
    const saved = createStudy(original, { units: original.units, up: original.up, camera: original.camera, target: original.target });
    const reopened = readStudy(JSON.stringify(saved)), history = captureDesign(original);
    assert.deepEqual(asVersion5(reopened), original);
    assert.equal(saved.layout.recipe.engine, 'structured-v1');
    assert.deepEqual(saved.layout.recipe.pattern, original.pattern);
    original.pattern.angle = 75; original.pattern.frequency = 4; original.pattern.type = 'organic';
    assert.deepEqual(history.pattern, { type, angle: 30, frequency: 3 });
    assert.deepEqual(saved.pattern, history.pattern);
    assert.deepEqual(reopened.pattern, history.pattern);
  }
  assert.deepEqual(captureDesign({}).pattern, { type: 'organic', angle: 0, frequency: 2 });
});

test('saved structured provenance cannot disagree with the design pattern or reset baseline', () => {
  for (const mutate of [
    state => { state.pattern.angle += 1; },
    state => { state.pattern.frequency += 1; },
    state => { state.pattern.type = 'organic'; },
    state => { delete state.pattern; },
    state => { delete state.layout.recipe.pattern; },
    state => { state.layout.recipe.engine = 'seed-fields-v1'; },
  ]) {
    const state = structuredFixture(); mutate(state);
    assert.throws(() => readStudy(state), /layout/);
  }
  const state = structuredFixture();
  state.directBase = state.layout;
  state.layout = transactLayout(state.rawModel, state.layout, { type: 'merge-cells', cellIds: state.layout.cells.map(cell => cell.id) }).layout;
  const saved = createStudy(state, { units: state.units, up: state.up });
  assert.deepEqual(saved.directBase.recipe.pattern, saved.pattern);
  assert.deepEqual(saved.layout.recipe.pattern, saved.pattern);
  saved.directBase.recipe.pattern.angle += 1;
  assert.throws(() => readStudy(saved), /baseline/);
});

test('regularity is bounded and canonical only for the regularized surface pattern', () => {
  assert.deepEqual(readPattern({ type: 'regularized' }), { type: 'regularized', angle: 0, frequency: 2, regularity: .7 });
  for (const regularity of [0, .4, 1]) assert.equal(readPattern({ type: 'regularized', regularity }).regularity, regularity);
  for (const regularity of [null, -1, 1.01, NaN, Infinity, '0.7']) {
    assert.throws(() => readPattern({ type: 'regularized', regularity }), /regularity/);
  }
  for (const type of ['organic', 'hexagonal', 'geodesic']) {
    assert.deepEqual(readPattern({ type, regularity: .9 }), { type, angle: 0, frequency: 2 });
  }
});

test('regularized settings survive saves, independent history copies and direct graph provenance', () => {
  const state = authoredFixture();
  state.pattern = readPattern({ type: 'regularized', regularity: .8 });
  state.layout.recipe = layoutRecipe(state);
  const before = captureDesign(state);
  const saved = createStudy(state, { units: state.units, up: state.up, camera: state.camera, target: state.target });
  assert.deepEqual(asVersion5(readStudy(JSON.stringify(saved))), state);
  assert.equal(saved.layout.recipe.engine, 'regularized-surface-v1');
  state.pattern.regularity = .3;
  assert.equal(before.pattern.regularity, .8);
  assert.equal(saved.pattern.regularity, .8);
  assert.throws(() => readStudy(state), /editing inputs/);
  state.pattern.regularity = .8;
  state.directBase = state.layout;
  state.layout = transactLayout(state.rawModel, state.layout, { type: 'merge-cells', cellIds: state.layout.cells.map(cell => cell.id) }).layout;
  const direct = createStudy(state, { units: state.units, up: state.up });
  assert.equal(direct.layout.recipe.pattern.regularity, .8);
  assert.equal(direct.directBase.recipe.pattern.regularity, .8);
  direct.directBase.recipe.pattern.regularity = .2;
  assert.throws(() => readStudy(direct), /baseline/);
});
