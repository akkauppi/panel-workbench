import test from 'node:test';
import assert from 'node:assert/strict';
import { readGeneratorPolicy } from './generator-policy.js';

const policy = { type: 'curvature', version: 1, minSizeMm: 120, maxSizeMm: 600 };

test('missing and disabled policies retain the existing uniform generator', () => {
  assert.equal(readGeneratorPolicy(), null);
  assert.equal(readGeneratorPolicy(null), null);
  for (const type of ['organic', 'regularized', 'hexagonal', 'geodesic']) assert.equal(readGeneratorPolicy(null, { type }), null);
});

test('curvature policy is canonical, independent and supported by Organic and Regularized', () => {
  for (const pattern of [undefined, 'organic', 'regularized', { type: 'organic' }, { type: 'regularized', regularity: .8 }]) {
    const original = { maxSizeMm: 600, minSizeMm: 120, version: 1, type: 'curvature', ignoredOptionalLabel: 'not provenance' };
    const parsed = readGeneratorPolicy(original, pattern);
    assert.deepEqual(parsed, policy);
    assert.deepEqual(Object.keys(parsed), ['type', 'version', 'minSizeMm', 'maxSizeMm']);
    parsed.minSizeMm = 150;
    assert.equal(original.minSizeMm, 120);
  }
});

test('finite millimetre targets allow equal bounds and large scales without an arbitrary ratio cap', () => {
  assert.deepEqual(readGeneratorPolicy({ ...policy, minSizeMm: 10, maxSizeMm: 10 }), { ...policy, minSizeMm: 10, maxSizeMm: 10 });
  assert.equal(readGeneratorPolicy({ ...policy, minSizeMm: 10, maxSizeMm: 1e12 }).maxSizeMm, 1e12);
});

test('malformed, unknown and unsupported policies fail without changing their input', () => {
  for (const input of [false, 0, 'curvature', [], {}, { ...policy, type: 'future' }, { ...policy, version: 2 }, { ...policy, version: '1' },
    ...[NaN, Infinity, -Infinity, 0, 9.99, '120'].map(minSizeMm => ({ ...policy, minSizeMm })),
    ...[NaN, Infinity, -Infinity, 119.99, '600'].map(maxSizeMm => ({ ...policy, maxSizeMm }))]) {
    const before = structuredClone(input);
    assert.throws(() => readGeneratorPolicy(input));
    assert.deepEqual(input, before);
  }
  for (const pattern of ['hexagonal', 'geodesic', 'unknown', {}, { type: 'hexagonal' }]) {
    assert.throws(() => readGeneratorPolicy(policy, pattern), /only for Organic and Regularized/);
  }
});
