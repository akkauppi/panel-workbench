// Freeze the current v6 writer against small authored source documents.
// Run only when deliberately establishing a new compatibility baseline.
// Existing baselines must remain byte-for-byte unchanged in later releases.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createStudy, readStudy, serializeStudy } from '../../study.js';
import { createProjectMetadata, advanceProjectRevision } from '../../project-document.js';
import { summarizeCalculation } from '../../project-feedback.js';
import { createWorkerHandler } from '../../worker.js';

const directory = new URL('./', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
manifest.compatibilityBaseline = {
  formatVersion: 6, family: '2026-10-30-durable-projects-v6',
  sourceBaselineCommit: '18f6da1c7a0d812df7e6d16662b8bd1c99117e68',
  provenance: 'Written by the v6 candidate before its final release commit. Source hashes identify the exact writer without a self-referential commit hash.',
  generator: 'generate-v6.mjs', generatorSha256: hash(await readFile(new URL(import.meta.url))),
  writerHashes: {}, fixtures: [],
};
for (const file of ['study.js', 'project-document.js', 'project-feedback.js']) {
  manifest.compatibilityBaseline.writerHashes[file] = hash(await readFile(new URL(`../../${file}`, directory)));
}
for (const [scenario, sourceFile] of [['authored', 'ed74193-organic.json'], ['direct', '1295306-curved-merge.json'], ['split', '18f6da1-split-retired.json']]) {
  const input = readStudy(await readFile(new URL(sourceFile, directory), 'utf8'));
  let project = createProjectMetadata({ id: `v6-baseline-${scenario}`, now: '2026-10-30T12:00:00.000Z' });
  let lastCalculation;
  if (scenario === 'direct') {
    let calculation;
    createWorkerHandler(result => { calculation = result; })({ data: { ...input, id: 1, model: input.rawModel } });
    if (calculation.error) throw new Error(calculation.error);
    lastCalculation = { revision: 1, build: '2026-10-30-durable-projects-v6', summary: summarizeCalculation(calculation.result) };
    project = advanceProjectRevision(project, { now: '2026-10-30T12:05:00.000Z' });
  }
  const study = createStudy(input, { units: input.units, up: input.up, camera: input.camera, target: input.target,
    project, producer: { name: 'Panel Workbench', build: '2026-10-30-durable-projects-v6' }, lastCalculation });
  const file = `v6-${scenario}.json`, text = serializeStudy(study) + '\n';
  await writeFile(new URL(file, directory), text);
  manifest.compatibilityBaseline.fixtures.push({ file, sourceFixture: sourceFile, sha256: hash(text),
    layoutSha256: hash(JSON.stringify(study.layout)), directBaseSha256: hash(JSON.stringify(study.directBase)),
    cellIds: study.layout.cells.map(cell => cell.id), nextCellId: study.nextCellId, projectId: project.id, projectRevision: project.revision });
}
await writeFile(new URL('manifest.json', directory), JSON.stringify(manifest, null, 2) + '\n');
