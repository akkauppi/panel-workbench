import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSourceLayout } from './design.js';
import { transactLayout } from './layout-edit.js';
import { createExample } from './examples.js';

function fixture() {
  const vertices = [], triangles = [];
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 6; x++) vertices.push([x * 100, y * 100, 0]);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) {
    const a = y * 7 + x;
    triangles.push([a, a + 1, a + 8], [a, a + 8, a + 7]);
  }
  return { model: { vertices, triangles }, inputs: {
    seeds: [{ id: 10, position: [100, 200, 0], weight: 1 }, { id: 20, position: [300, 200, 0], weight: 1 }, { id: 30, position: [500, 200, 0], weight: 1 }],
    size: 200, variation: .3, randomSeed: 7, mergeGroups: [], cornerEdits: [],
  } };
}

const geometry = surface => surface.cells.map(cell => ({ id: cell.id, positions: cell.positions, triangles: cell.triangles, loops: cell.loops }));

test('legacy inputs materialize a source document that is used directly on reopening', () => {
  const { model, inputs } = fixture();
  const before = structuredClone(inputs);
  const first = resolveSourceLayout(model, inputs);
  assert.equal(first.source, 'generated');
  assert.ok(first.layout.vertices.length);
  const reopened = resolveSourceLayout(model, { ...inputs, layout: JSON.parse(JSON.stringify(first.layout)) }, { strict: true });
  assert.equal(reopened.source, 'stored');
  assert.deepEqual(geometry(reopened.surface), geometry(first.surface));
  assert.deepEqual(reopened.surface.corners, first.surface.corners);
  assert.deepEqual(inputs, before);
});

test('fitting, stock and generator draft settings cannot repartition an accepted source layout', () => {
  const { model, inputs } = fixture();
  const first = resolveSourceLayout(model, inputs);
  const next = resolveSourceLayout(model, { ...inputs, layout: first.layout,
    thickness: 120, roundover: 7, straightness: .15, carve: true, minimumThickness: 20,
    flipOutside: true, variation: .9, randomSeed: 999,
  }, { strict: true });
  assert.equal(next.source, 'stored');
  assert.strictEqual(next.layout, first.layout);
  assert.deepEqual(geometry(next.surface), geometry(first.surface));
});

test('legacy editing deliberately replaces the source layout and preserves unaffected vertex identities', () => {
  const { model, inputs } = fixture();
  const first = resolveSourceLayout(model, inputs);
  const edited = structuredClone({ ...inputs, layout: first.layout });
  edited.seeds[0].weight = 1.3;
  const next = resolveSourceLayout(model, edited);
  assert.equal(next.source, 'generated');
  assert.notDeepEqual(geometry(next.surface), geometry(first.surface));
  const previous = new Map(first.layout.vertices.map(vertex => [vertex.position.join(','), vertex.id]));
  let retained = 0;
  for (const vertex of next.layout.vertices) if (previous.has(vertex.position.join(','))) {
    assert.equal(vertex.id, previous.get(vertex.position.join(',')));
    retained++;
  }
  assert.ok(retained > 0);
  assert.deepEqual(first.layout.recipe.seeds, inputs.seeds);
});

test('strict saved-document validation rejects inconsistent recipes instead of regenerating', () => {
  const { model, inputs } = fixture();
  const first = resolveSourceLayout(model, inputs);
  assert.throws(() => resolveSourceLayout(model, { ...inputs, size: 250, layout: first.layout }, { strict: true }), /does not match/);
});

test('restoring a layout checks actual source geometry even when model counts match', () => {
  const { model, inputs } = fixture();
  const first = resolveSourceLayout(model, inputs);
  const shifted = { ...model, vertices: model.vertices.map(point => [point[0], point[1], point[2] + 10]) };
  assert.throws(() => resolveSourceLayout(shifted, { ...inputs, layout: first.layout }, { strict: true }), /source|surface|model|layout/i);
});

test('an explicit replacement arrangement generates a new layout without carrying old geometry', () => {
  const { model, inputs } = fixture();
  const first = resolveSourceLayout(model, inputs);
  const replacement = resolveSourceLayout(model, { ...inputs, seeds: [], mergeGroups: [], cornerEdits: [], layout: null });
  assert.equal(replacement.source, 'generated');
  assert.notDeepEqual(geometry(replacement.surface), geometry(first.surface));
  assert.deepEqual(replacement.layout.recipe.seeds, replacement.seeds);
});

test('direct graph layouts remain authoritative and cannot be overwritten by legacy seed changes', () => {
  const { model, inputs } = fixture();
  const first = resolveSourceLayout(model, inputs);
  const direct = transactLayout(model, first.layout, { type: 'merge-cells', cellIds: [10, 20] });
  const saved = { ...inputs, layout: direct.layout, directBase: first.layout };
  const restored = resolveSourceLayout(model, { ...saved, thickness: 80 }, { strict: true });
  assert.equal(restored.source, 'stored');
  assert.deepEqual(geometry(restored.surface), geometry(direct.surface));
  const changed = structuredClone(saved); changed.seeds[0].weight = 1.5;
  assert.throws(() => resolveSourceLayout(model, changed), /Reset direct edits/);
  assert.deepEqual(first.layout.recipe.seeds, inputs.seeds);
});

test('saved direct-edit baselines are geometrically checked before installing the current layout', () => {
  const { model, inputs } = fixture();
  const first = resolveSourceLayout(model, inputs);
  const direct = transactLayout(model, first.layout, { type: 'merge-cells', cellIds: [10, 20] });
  const baseline = structuredClone(first.layout); baseline.vertices[0].position[2] += 10;
  assert.throws(() => resolveSourceLayout(model, { ...inputs, layout: direct.layout, directBase: baseline }, { strict: true }), /attachment|vertex|layout/i);
  assert.deepEqual(geometry(resolveSourceLayout(model, { ...inputs, layout: direct.layout }).surface), geometry(direct.surface));
});

test('structured generation creates an editable snapshot and is independent of random settings', () => {
  const { model } = fixture();
  const inputs = { size: 100, pattern: { type: 'hexagonal', angle: 17, frequency: 2 }, seeds: [] };
  const first = resolveSourceLayout(model, inputs);
  assert.equal(first.source, 'generated');
  assert.equal(first.layout.recipe.engine, 'structured-v1');
  assert.deepEqual(first.layout.recipe.pattern, inputs.pattern);
  assert.ok(first.surface.corners.some(corner => !corner.boundary));
  assert.ok(first.surface.stats.coverageError < 1e-8);
  const repeated = resolveSourceLayout(model, { ...inputs, variation: 1, randomSeed: 500 });
  assert.deepEqual(repeated.layout, first.layout);
  const restored = resolveSourceLayout(model, { ...inputs, seeds: first.seeds, layout: first.layout,
    straightness: 0, thickness: 180, roundover: 0 }, { strict: true });
  assert.equal(restored.source, 'stored');
  assert.strictEqual(restored.layout, first.layout);
  assert.deepEqual(geometry(restored.surface), geometry(first.surface));
});

test('structured pattern replacement is explicit and direct graph edits retain generator provenance', () => {
  const { model } = fixture();
  const inputs = { size: 100, pattern: { type: 'hexagonal', angle: 17, frequency: 2 }, seeds: [] };
  const first = resolveSourceLayout(model, inputs);
  const rotated = { ...inputs, pattern: { ...inputs.pattern, angle: 35 } };
  assert.throws(() => resolveSourceLayout(model, { ...rotated, seeds: first.seeds, layout: first.layout }, { strict: true }), /does not match/);
  const replacement = resolveSourceLayout(model, rotated);
  assert.notDeepEqual(geometry(replacement.surface), geometry(first.surface));
  const cell = first.surface.cells.find(cell => cell.neighbors.length > 0);
  const merge = transactLayout(model, first.layout, { type: 'merge-cells', cellIds: [cell.id, cell.neighbors[0]] });
  assert.equal(merge.layout.cells.length, first.layout.cells.length - 1);
  const restored = resolveSourceLayout(model, { ...inputs, seeds: first.seeds, layout: merge.layout, directBase: first.layout }, { strict: true });
  assert.deepEqual(restored.layout.recipe, first.layout.recipe);
  assert.deepEqual(geometry(restored.surface), geometry(merge.surface));
});

test('regularized surface snapshots retain their exact cells through fitting settings, save validation and direct merges', () => {
  const model = createExample('saddle');
  const inputs = { size: 700, randomSeed: 7, pattern: { type: 'regularized', regularity: .7 }, seeds: [] };
  const first = resolveSourceLayout(model, inputs);
  assert.equal(first.layout.recipe.engine, 'regularized-surface-v1');
  assert.equal(first.layout.recipe.pattern.regularity, .7);
  assert.ok(first.surface.stats.coverageError < 1e-8);
  const saved = { ...inputs, seeds: first.seeds, layout: structuredClone(first.layout) };
  const restored = resolveSourceLayout(model, { ...saved, thickness: 60, straightness: .1 }, { strict: true });
  assert.equal(restored.source, 'stored');
  assert.deepEqual(geometry(restored.surface), geometry(first.surface));
  assert.throws(() => resolveSourceLayout(model, { ...saved, pattern: { type: 'regularized', regularity: .2 } }, { strict: true }), /does not match/);
  const cell = first.surface.cells.find(cell => cell.neighbors.length);
  const merged = transactLayout(model, first.layout, { type: 'merge-cells', cellIds: [cell.id, cell.neighbors[0]] });
  const edited = resolveSourceLayout(model, { ...saved, layout: merged.layout, directBase: first.layout }, { strict: true });
  assert.deepEqual(geometry(edited.surface), geometry(merged.surface));
  assert.deepEqual(edited.layout.recipe, first.layout.recipe);
  assert.equal(edited.layout.cells.length, first.layout.cells.length - 1);
});
