import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPolygon, measureLayoutQuality } from './quality.js';

const square = [[0, 0], [4, 0], [4, 4], [0, 4]];
const notch = [[0, 0], [4, 0], [4, 4], [2, 2], [0, 4]];
const hole = [[1, 1], [3, 1], [3, 3], [1, 3]];
function close(actual, expected, tolerance = 1e-10) { assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`); }
const transform = (rings, scale, offset = [0, 0], angle = 0) => rings.map(ring => ring.map(([x, y]) =>
  [offset[0] + scale * (x * Math.cos(angle) - y * Math.sin(angle)), offset[1] + scale * (x * Math.sin(angle) + y * Math.cos(angle))]));

test('convex polygons report normalized regularity without requiring equal sides', () => {
  const result = inspectPolygon([square]);
  assert.equal(result.classification, 'convex'); assert.equal(result.valid, true); assert.equal(result.convex, true);
  assert.equal(result.holeCount, 0); assert.equal(result.componentCount, 1);
  assert.equal(result.cornerCount, 4); assert.equal(result.concaveVertexCount, 0);
  close(result.area, 16); close(result.perimeter, 16); close(result.edgeLengthCV, 0);
  close(result.compactness, Math.PI / 4); close(result.minInteriorAngle, 90); close(result.maxInteriorAngle, 90);
  close(result.hullDeficit, 0); close(result.reflexTurnFraction, 0);
  const rectangle = inspectPolygon([[[0, 0], [8, 0], [8, 4], [0, 4]]]);
  assert.equal(rectangle.convex, true); assert.ok(rectangle.edgeLengthCV > 0);
  const hexagon = inspectPolygon([Array.from({ length: 6 }, (_, i) => [Math.cos(i * Math.PI / 3), Math.sin(i * Math.PI / 3)])]);
  assert.equal(hexagon.convex, true); close(hexagon.edgeLengthCV, 0); close(hexagon.maxInteriorAngle, 120);
});

test('collinear boundary subdivisions and explicit closure do not distort corner or edge metrics', () => {
  const subdivided = [[0, 0], [1, 0], [3, 0], [4, 0], [4, 2], [4, 4], [2, 4], [0, 4], [0, 1], [0, 0]];
  assert.deepEqual(inspectPolygon([subdivided]), inspectPolygon([square]));
  assert.equal(subdivided.length, 10, 'inspection never mutates the source outline');
});

test('a concave notch reports reflex turns and hull deficit without filling the notch', () => {
  const before = structuredClone(notch), result = inspectPolygon([notch]);
  assert.equal(result.classification, 'concave'); assert.equal(result.valid, true); assert.equal(result.convex, false);
  assert.equal(result.concaveVertexCount, 1); close(result.area, 12);
  close(result.maxInteriorAngle, 270); close(result.reflexTurnFraction, .25); close(result.hullDeficit, .25);
  assert.deepEqual(notch, before);
  const reverse = inspectPolygon([[...notch].reverse()]);
  for (const key of ['area', 'perimeter', 'hullDeficit', 'reflexTurnFraction', 'minInteriorAngle', 'maxInteriorAngle']) close(result[key], reverse[key]);
});

test('holes are recognized from containment regardless of ring order or winding', () => {
  for (const rings of [[square, hole], [hole, square], [[...square].reverse(), hole], [square, [...hole].reverse()]]) {
    const result = inspectPolygon(rings);
    assert.equal(result.classification, 'holed'); assert.equal(result.valid, true); assert.equal(result.convex, false);
    assert.equal(result.holeCount, 1); assert.equal(result.componentCount, 1); close(result.area, 12); close(result.perimeter, 24);
    assert.equal(result.hullDeficit, null, 'an intentional opening is not treated as a concavity penalty');
    assert.equal(result.reflexTurnFraction, null);
  }
  const separate = inspectPolygon([square, hole.map(([x, y]) => [x + 10, y])]);
  assert.equal(separate.classification, 'disconnected'); assert.equal(separate.valid, false);
  assert.equal(separate.componentCount, 2); assert.equal(separate.holeCount, 0);
  const island = inspectPolygon([square, hole, [[1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 2.5]]]);
  assert.equal(island.classification, 'disconnected'); assert.equal(island.componentCount, 2); assert.equal(island.holeCount, 1);
});

test('crossings, self contact and a touching hole cannot be called convex', () => {
  for (const rings of [
    [[[0, 0], [4, 4], [0, 4], [4, 0]]],
    [[[0, 0], [4, 0], [2, 0], [4, 4], [0, 4]]],
    [square, [[0, 1], [2, 1], [2, 3], [0, 3]]],
    [square, hole.map(([x, y]) => [x + 2, y])],
  ]) {
    const result = inspectPolygon(rings);
    assert.equal(result.classification, 'self-crossing'); assert.equal(result.selfIntersects, true);
    assert.equal(result.valid, false); assert.equal(result.convex, false); assert.equal(result.hullDeficit, null);
  }
});

test('zero-area, collapsed and malformed outlines are explicitly degenerate', () => {
  for (const rings of [[], null, [[]], [[[0, 0], [1, 0]]], [[[0, 0], [1, 0], [2, 0]]],
    [[[0, 0], [0, 0], [0, 0]]], [[[0, 0], [4, 0], [4, 0], [4, 4], [0, 4]]],
    [[[0, 0], [1, NaN], [0, 1]]], [[[0, 0], [1, Infinity], [0, 1]]]]) {
    const result = inspectPolygon(rings);
    assert.equal(result.classification, 'degenerate'); assert.equal(result.degenerate, true);
    assert.equal(result.valid, false); assert.equal(result.convex, false);
  }
});

test('normalized quality is invariant to translation, rotation and unit changes', () => {
  const baseline = inspectPolygon([notch]);
  for (const scale of [.001, 1, 1000]) {
    const result = inspectPolygon(transform([notch], scale, [123 * scale, -456 * scale], .37));
    assert.equal(result.classification, baseline.classification); assert.equal(result.concaveVertexCount, 1);
    for (const key of ['edgeLengthCV', 'compactness', 'hullDeficit', 'reflexTurnFraction', 'minInteriorAngle', 'maxInteriorAngle']) close(result[key], baseline[key], 1e-8);
    close(result.area / scale ** 2, baseline.area, 1e-8); close(result.perimeter / scale, baseline.perimeter, 1e-8);
  }
  const narrow = inspectPolygon([[[0, 0], [1000, 0], [1000, .001], [0, .001]]]);
  assert.equal(narrow.classification, 'convex', 'normalization must retain a real narrow shape');
});

test('layout quality keeps convexity separate from fabrication validity and invalid outlines', () => {
  const outlines = [[square], [notch], [square, hole], [[[0, 0], [4, 4], [0, 4], [4, 0]]],
    [[[0, 0], [1, 0], [2, 0]]], [square, hole.map(([x, y]) => [x + 10, y])]];
  const cells = outlines.map((outline2d, id) => ({ id, outline2d, valid: false }));
  const result = measureLayoutQuality(cells);
  assert.deepEqual(Object.fromEntries(Object.entries(result).filter(([key]) => key.endsWith('Count'))),
    { totalCount: 6, convexCount: 1, concaveCount: 1, holedCount: 1, disconnectedCount: 1, degenerateCount: 1, selfCrossingCount: 1, invalidCount: 3 });
  close(result.meanHullDeficit, .125); close(result.meanReflexTurnFraction, .125);
  assert.ok(result.meanCompactness > 0 && result.meanCompactness <= 1); assert.ok(result.meanEdgeLengthCV >= 0);
  assert.equal(measureLayoutQuality([]).meanCompactness, null);
});
