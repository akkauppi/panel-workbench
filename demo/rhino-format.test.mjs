import test from 'node:test';
import assert from 'node:assert/strict';
import { rhinoArchiveVersion, verifyRhino6Export } from './rhino-format.js';
import { loadRhino } from './rhino-runtime.js';
const rhino = await loadRhino();

test('download gate checks real writer bytes and rejects an older worker returning Rhino 7', () => {
  const doc = new rhino.File3dm(), options = new rhino.File3dmWriteOptions();
  try {
    for (const version of [6, 7, 8]) {
      options.version = version;
      const bytes = doc.toByteArrayOptions(options);
      assert.equal(rhinoArchiveVersion(bytes), version * 10);
      if (version === 6) assert.equal(verifyRhino6Export(bytes), bytes);
      else assert.throws(() => verifyRhino6Export(bytes), new RegExp(`Rhino ${version} format instead of Rhino 6.*Download stopped`));
    }
  } finally { options.delete(); doc.delete(); }
});

test('version reader honors binary view offsets and rejects malformed headers', () => {
  const encoded = new TextEncoder().encode('3D Geometry File Format       60');
  const buffer = new Uint8Array(50); buffer.set(encoded, 5);
  assert.equal(rhinoArchiveVersion(buffer.subarray(5, 37)), 60);
  assert.equal(rhinoArchiveVersion(encoded.buffer), 60);
  for (const input of [null, '60', new Uint8Array(31), new Uint8Array(32)]) {
    assert.throws(() => verifyRhino6Export(input), /header/);
  }
});
