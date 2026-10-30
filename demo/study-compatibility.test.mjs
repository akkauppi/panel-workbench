import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readStudy, createStudy, serializeStudy } from './study.js';
import { resolveSourceLayout } from './design.js';
import { nextLayoutCellId } from './layout.js';
import { transactLayout } from './layout-edit.js';
import { createProjectMetadata } from './project-document.js';

const base = new URL('./fixtures/studies/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

test('released fixture provenance and frozen bytes remain unchanged', async () => {
  assert.equal(manifest.version, 1);
  assert.equal(hash(await readFile(new URL(manifest.generator, base))), manifest.generatorSha256);
  assert.ok(manifest.fixtures.some(fixture => fixture.commit.startsWith('18f6da1')));
  assert.ok(new Set(manifest.fixtures.map(fixture => fixture.commit)).size >= 3);
  for (const fixture of manifest.fixtures) {
    assert.match(fixture.commit, /^[0-9a-f]{40}$/);
    assert.equal(fixture.writer, 'demo/study.js#createStudy');
    assert.equal(hash(await readFile(new URL(fixture.file, base))), fixture.sha256, fixture.file);
  }
});

for (const fixture of manifest.fixtures) test(`released ${fixture.file} opens and upgrades without changing authored geometry`, async () => {
  const originalText = await readFile(new URL(fixture.file, base), 'utf8');
  const original = JSON.parse(originalText), before = structuredClone(original), opened = readStudy(original);
  const factor = { mm: 1, cm: 10, m: 1000 }[opened.units];
  const model = { vertices: opened.rawModel.vertices.map(point => point.map(value => value * factor)), triangles: opened.rawModel.triangles };
  const resolved = resolveSourceLayout(model, opened, { strict: true });
  assert.equal(resolved.source, 'stored', 'a released snapshot must never be regenerated');
  assert.deepEqual(opened.layout, original.layout);
  assert.deepEqual(opened.directBase, original.directBase);
  assert.deepEqual(resolved.layout, original.layout);
  assert.equal(hash(opened.rawModel), fixture.sourceSha256);
  assert.equal(hash(opened.layout), fixture.layoutSha256);
  assert.equal(hash(opened.directBase), fixture.directBaseSha256);
  assert.deepEqual(resolved.surface.cells.map(cell => cell.id), fixture.cellIds);
  const project = createProjectMetadata({ id: `compat-${fixture.scenario}`, now: '2026-10-30T12:00:00.000Z' });
  const upgraded = createStudy(opened, { units: opened.units, up: opened.up, camera: opened.camera, target: opened.target,
    project, producer: { name: 'Panel Workbench', build: 'compatibility-test' } });
  const text = serializeStudy(upgraded), reopened = readStudy(text);
  assert.equal(reopened.version, 6);
  assert.deepEqual(reopened.layout, original.layout);
  assert.deepEqual(reopened.directBase, original.directBase);
  assert.deepEqual(reopened.rawModel, original.rawModel);
  assert.deepEqual(reopened.seeds, original.seeds);
  assert.deepEqual(reopened.project, project);
  assert.deepEqual(resolveSourceLayout(model, reopened, { strict: true }).surface, resolved.surface);
  assert.deepEqual(original, before, 'reading and migration cannot modify the original file');
  if (fixture.nextCellId !== null) assert.equal(reopened.nextCellId, fixture.nextCellId);
  if (fixture.scenario === 'split-retired') {
    assert.deepEqual(reopened.layout.splitOrigins.map(origin => origin.id), [20, 21]);
    assert.deepEqual(reopened.layout.cells.map(cell => cell.id), [0, 21]);
    assert.equal(nextLayoutCellId(reopened.layout), 22);
    assert.equal(reopened.nextCellId, 100, 'cancelled/undone edits retain their reserved IDs');
    const split = transactLayout(model, reopened.layout, { type: 'split-cell', cellId: 0,
      start: [900, 0, 0], end: [900, 1200, 0], nextCellId: reopened.nextCellId });
    assert.equal(split.change.newCellId, 100);
    assert.deepEqual(split.layout.splitOrigins.slice(0, 2), original.layout.splitOrigins);
  }
});

test('the durable v6 baseline records its candidate writer and immutable source fixtures', async () => {
  const baseline = manifest.compatibilityBaseline;
  assert.equal(baseline.formatVersion, 6);
  assert.equal(baseline.family, '2026-10-30-durable-projects-v6');
  assert.match(baseline.sourceBaselineCommit, /^18f6da1[0-9a-f]{33}$/);
  assert.equal(hash(await readFile(new URL(baseline.generator, base))), baseline.generatorSha256);
  for (const file of ['study.js', 'project-document.js', 'project-feedback.js']) assert.match(baseline.writerHashes[file], /^[0-9a-f]{64}$/);
  // Deliberately do not compare writer hashes with today's implementation:
  // later implementations must pass by reading the original baseline files.
  assert.deepEqual(baseline.fixtures.map(fixture => fixture.file), ['v6-authored.json', 'v6-direct.json', 'v6-split.json']);
});

for (const fixture of manifest.compatibilityBaseline.fixtures) test(`durable baseline ${fixture.file} preserves its complete source document and identity`, async () => {
  const bytes = await readFile(new URL(fixture.file, base));
  assert.equal(hash(bytes), fixture.sha256);
  const original = JSON.parse(bytes), opened = readStudy(bytes.toString('utf8'));
  assert.equal(opened.version, 6);
  assert.equal(opened.project.id, fixture.projectId);
  assert.equal(opened.project.revision, fixture.projectRevision);
  assert.equal(opened.nextCellId, fixture.nextCellId);
  assert.deepEqual(opened.layout.cells.map(cell => cell.id), fixture.cellIds);
  assert.equal(hash(opened.layout), fixture.layoutSha256);
  assert.equal(hash(opened.directBase), fixture.directBaseSha256);
  assert.deepEqual(opened, original);
  const model = opened.rawModel; // These public fixtures are authored in mm.
  const resolved = resolveSourceLayout(model, opened, { strict: true });
  assert.equal(resolved.source, 'stored');
  assert.deepEqual(resolved.layout, original.layout);
  const saved = createStudy(opened, { units: opened.units, up: opened.up, camera: opened.camera, target: opened.target });
  assert.deepEqual(readStudy(serializeStudy(saved)), original);
  if (fixture.file === 'v6-direct.json') {
    assert.equal(opened.project.revision, 2);
    assert.equal(opened.lastCalculation.revision, 1);
    assert.equal(opened.lastCalculation.summary.version, 1);
  }
  assert.deepEqual(opened, original, 'reopening and resaving cannot mutate the baseline');
});
