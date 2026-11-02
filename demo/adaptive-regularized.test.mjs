import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRegularizedLayout } from './regularized.js';

const policy = { type: 'curvature', version: 1, minSizeMm: 100, maxSizeMm: 260 };
const pattern = regularity => ({ type: 'regularized', regularity });
const sub = (a, b) => a.map((value, axis) => value - b[axis]);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const distance = (a, b) => Math.hypot(...sub(a, b));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// The two equal-area halves have the same triangle spacing. Only the right
// half bends: its tangent joins the flat half continuously at s=0.
function flatAndBend() {
  const vertices = [], triangles = [], nx = 30, ny = 20, radius = 300;
  for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
    const s = -600 + x * 40;
    vertices.push(s <= 0 ? [s, y * 40, 0]
      : [radius * Math.sin(s / radius), y * 40, radius * (1 - Math.cos(s / radius))]);
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const a = y * (nx + 1) + x;
    triangles.push([a, a + 1, a + nx + 2], [a, a + nx + 2, a + nx + 1]);
  }
  return { vertices, triangles };
}

let fixture;
function results() {
  if (!fixture) {
    const model = flatAndBend(), options = { size: 260, randomSeed: 7, generatorPolicy: policy };
    fixture = { model, options,
      initial: generateRegularizedLayout(model, pattern(0), options),
      relaxed: generateRegularizedLayout(model, pattern(.8), options) };
  }
  return fixture;
}

function regionAreas(result) {
  const cells = new Map(result.surface.cells.map(cell => [cell.id, cell]));
  return {
    flat: result.seeds.filter(seed => seed.position[0] < -180).map(seed => cells.get(seed.id).area),
    bend: result.seeds.filter(seed => seed.position[2] > 100).map(seed => cells.get(seed.id).area),
  };
}

function triangleArea([a, b, c]) {
  const u = sub(b, a), v = sub(c, a);
  return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
}

// Independent integration check: symmetric degree-two quadrature, rather than
// the solver's closed-form triangle moment formula. The stored source density
// is constant over each clipped source triangle.
function objective(result, initialSeeds, regularity, weighted = true) {
  const sites = new Map(result.seeds.map(seed => [seed.id, seed.position]));
  const anchors = new Map(initialSeeds.map(seed => [seed.id, seed.position]));
  let total = 0;
  for (const cell of result.surface.cells) {
    const site = sites.get(cell.id), move = sub(site, anchors.get(cell.id));
    let mass = 0;
    cell.triangles.forEach((ids, index) => {
      const points = ids.map(id => cell.positions[id]);
      const weight = triangleArea(points) * (weighted ? cell.triangleDensities[index] : 1);
      mass += weight;
      for (let dominant = 0; dominant < 3; dominant++) {
        const sample = [0, 1, 2].map(axis => points.reduce((sum, point, i) => sum + point[axis] * (i === dominant ? 2 / 3 : 1 / 6), 0));
        const offset = sub(sample, site);
        total += regularity * weight * dot(offset, offset) / 3;
      }
    });
    total += (1 - regularity) * mass * dot(move, move);
  }
  return total;
}

test('adaptive regularization retains smaller cells in the bend instead of equalizing physical areas', t => {
  const { initial, relaxed } = results();
  assert.equal(relaxed.seeds.length, initial.seeds.length, 'relaxation must retain the allocated sites');
  assert.ok(relaxed.seeds.length <= 240);
  assert.ok(relaxed.diagnostics.iterations > 0, 'the test must exercise accepted relaxation');
  const before = regionAreas(initial), after = regionAreas(relaxed);
  for (const regions of [before, after]) {
    assert.ok(regions.flat.length >= 3 && regions.bend.length >= 8, 'both regions must contain enough cells for the comparison');
    assert.ok(median(regions.bend) < median(regions.flat) * .55,
      `bend median ${median(regions.bend)} should remain smaller than flat median ${median(regions.flat)}`);
  }
  const initialRatio = median(before.bend) / median(before.flat);
  const finalRatio = median(after.bend) / median(after.flat);
  assert.ok(finalRatio <= initialRatio * 1.5, `size contrast weakened from ${initialRatio} to ${finalRatio}`);
  assert.ok(relaxed.surface.stats.coverageError < 1e-8);
  assert.ok(Math.abs(relaxed.surface.stats.totalArea - initial.surface.stats.totalArea) / initial.surface.stats.totalArea < 1e-10);
  assert.ok(relaxed.surface.cells.every(cell => cell.sourceComponentCount === 1));
  t.diagnostic(JSON.stringify({ cells: relaxed.seeds.length, iterations: relaxed.diagnostics.iterations,
    initialBendFlatAreaRatio: initialRatio, finalBendFlatAreaRatio: finalRatio,
    flatMedianArea: median(after.flat), bendMedianArea: median(after.bend),
    coverageError: relaxed.surface.stats.coverageError }));
});

test('accepted adaptive moves reduce the density-weighted objective including the weighted anchor penalty', t => {
  const { initial, relaxed } = results(), regularity = .8;
  const first = objective(initial, initial.seeds, regularity);
  assert.ok(Math.abs(first - relaxed.diagnostics.initialObjective) <= first * 1e-10);
  let last = first;
  for (const step of relaxed.diagnostics.iterationLog) if (step.accepted) {
    assert.ok(Number.isFinite(step.objective) && step.objective < last);
    assert.ok(step.maxStepRatio >= 0 && step.maxStepRatio <= .45 + 1e-10);
    assert.ok(step.maxMovement <= policy.maxSizeMm * .45 + 1e-7);
    last = step.objective;
  }
  const final = objective(relaxed, initial.seeds, regularity);
  assert.ok(Math.abs(final - last) <= final * 1e-10, 'reported objective must match the returned geometry');
  assert.ok(final < first);
  assert.ok(objective(relaxed, initial.seeds, regularity, false) > final * 2,
    'the fixture must distinguish weighted energy from uniform-area energy');
  const byId = new Map(initial.seeds.map(seed => [seed.id, seed.position]));
  for (const seed of relaxed.seeds) {
    assert.ok(seed.position.every(Number.isFinite));
    assert.ok(distance(seed.position, byId.get(seed.id)) <= relaxed.diagnostics.iterations * policy.maxSizeMm * .45 + 1e-7);
  }
  t.diagnostic(JSON.stringify({ initialObjective: first, finalObjective: final,
    maxAcceptedStepRatio: Math.max(...relaxed.diagnostics.iterationLog.filter(step => step.accepted).map(step => step.maxStepRatio)) }));
});

test('adaptive regularization is deterministic and leaves the source mesh untouched', () => {
  const { model, options, relaxed } = results(), original = flatAndBend();
  assert.deepEqual(model, original);
  assert.deepEqual(generateRegularizedLayout(model, pattern(.8), options), relaxed);
  assert.deepEqual(model, original);
});

test('disabled curvature sizing retains the uniform regularized result and diagnostics', () => {
  const vertices = [], triangles = [], n = 6;
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push([x * 100, y * 100, 0]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x;
    triangles.push([a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]);
  }
  const model = { vertices, triangles }, options = { size: 200, randomSeed: 7 };
  const uniform = generateRegularizedLayout(model, pattern(.7), options);
  const disabled = generateRegularizedLayout(model, pattern(.7), { ...options, generatorPolicy: null });
  assert.deepEqual(disabled, uniform);
  assert.equal(disabled.diagnostics.sizing, undefined);
  assert.equal(disabled.diagnostics.initialObjective, undefined);
});
