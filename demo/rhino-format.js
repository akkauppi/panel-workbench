/** The archive version is stored in the first 32 bytes of every 3DM file.
 * Check the delivered bytes, not a requested writer option or a filename. */
export function rhinoArchiveVersion(input) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes || bytes.length < 32) throw new Error('The Rhino export has no complete 3DM file header.');
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 32));
  const match = /^3D Geometry File Format\s+(\d+)$/.exec(header);
  if (!match) throw new Error('The Rhino export has an invalid 3DM file header.');
  return Number(match[1]);
}

export function verifyRhino6Export(bytes) {
  const version = rhinoArchiveVersion(bytes);
  if (version !== 60) {
    const label = version >= 50 ? version / 10 : version;
    throw new Error(`The exporter returned Rhino ${label} format instead of Rhino 6. Download stopped. Save your study, reopen the updated site, and export again.`);
  }
  return bytes;
}
