import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from './vendor/three.core.js';
import { cornerDisplayPosition, cornerProjectionPatch, projectCornerDisplacement } from './corner-drag.js';

test('corner display follows exact fitted metadata and the camera-facing stock side', () => {
  const corner = { position: [50, 50, 0], flatPosition: [70, 60, 30], solidPositions: [
    { position: [70, 60, 50], side: 'positive', cellId: 0 },
    { position: [70, 60, 10], side: 'negative', cellId: 0 },
  ] };
  assert.deepEqual(cornerDisplayPosition(corner, 'surface', [0, 0, 1000]), corner.position);
  assert.deepEqual(cornerDisplayPosition(corner, 'flat', [0, 0, 1000]), corner.flatPosition);
  assert.deepEqual(cornerDisplayPosition(corner, 'solid', [0, 0, 1000]), [70, 60, 50]);
  assert.deepEqual(cornerDisplayPosition(corner, 'solid', [0, 0, -1000]), [70, 60, 10]);
  assert.deepEqual(cornerDisplayPosition({ ...corner, solidPositions: [] }, 'solid', [0, 0, 1000]), corner.flatPosition);
  assert.equal(cornerDisplayPosition({ ...corner, flatPosition: null }, 'flat', [0, 0, 1000]), null);
  assert.equal(cornerDisplayPosition(corner, 'reference', [0, 0, 1000]), null);
});

test('derived-view movement stays on the connected source sheet instead of snapping across nearby layers', () => {
  const model = { vertices: [], triangles: [] };
  for (const z of [0, 10]) {
    const offset = model.vertices.length;
    model.vertices.push([0, 0, z], [100, 0, z], [100, 100, z], [0, 100, z]);
    model.triangles.push([offset, offset + 1, offset + 2], [offset, offset + 2, offset + 3]);
  }
  const corner = { position: [25, 50, 0], flatPosition: [60, 80, 30], radius: 200 };
  const patch = cornerProjectionPatch(model, corner);
  assert.equal(patch.length, 2);
  assert.deepEqual(projectCornerDisplacement(corner, new Vector3(20, 5, 9), patch).toArray(), [45, 55, 0]);
  assert.deepEqual(projectCornerDisplacement(corner, new Vector3(), patch).toArray(), corner.position);
  assert.deepEqual(corner.position, [25, 50, 0]);
});

test('local projection follows a sloping source face and rejects an unattached anchor', () => {
  const model = { vertices: [[0, 0, 0], [100, 0, 100], [0, 100, 0]], triangles: [[0, 1, 2]] };
  const corner = { position: [20, 20, 20], radius: 100 };
  const patch = cornerProjectionPatch(model, corner);
  const moved = projectCornerDisplacement(corner, new Vector3(20, 10, 0), patch);
  assert.ok(moved.distanceTo(new Vector3(30, 30, 30)) < 1e-9);
  assert.throws(() => cornerProjectionPatch(model, { ...corner, position: [20, 20, 40] }), /not attached/);
});
