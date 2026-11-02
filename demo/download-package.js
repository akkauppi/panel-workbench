/** Small, dependency-free ZIP writer. STORE preserves the original bytes;
 * there is no compression, encryption, network access, or ZIP64 output. */
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export async function packageBytes(value) {
  const length = typeof value === 'string' ? value.length : value?.byteLength ?? value?.size;
  if (Number.isFinite(length) && length > MAX_PACKAGE_BYTES) throw new Error('This attachment exceeds the 256 MiB package limit.');
  if (typeof value === 'string') {
    const bytes = encoder.encode(value);
    if (bytes.length > MAX_PACKAGE_BYTES) throw new Error('This attachment exceeds the 256 MiB package limit.');
    return bytes;
  }
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  throw new Error('A download attachment has an unsupported content type.');
}

function filename(value) {
  if (typeof value !== 'string' || value.length > 180 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.'))) {
    throw new Error('A download attachment has an unsafe filename.');
  }
  return value;
}

function dosDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('The download package needs a valid creation date.');
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return { date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2) };
}

export async function createDownloadPackage(entries, { createdAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 64) throw new Error('A download package needs between 1 and 64 attachments.');
  const seen = new Set(), files = []; let contentSize = 0;
  for (const entry of entries) {
    const name = filename(entry?.name), lower = name.toLowerCase();
    if (seen.has(lower)) throw new Error('A download package contains repeated filenames.');
    seen.add(lower);
    const bytes = await packageBytes(entry.data);
    contentSize += bytes.length;
    if (contentSize > MAX_PACKAGE_BYTES) throw new Error('This package exceeds 256 MiB. Download the study and Rhino file separately, or reduce the source mesh.');
    files.push({ name: encoder.encode(name), bytes, crc: crc32(bytes), offset: 0 });
  }
  const stamp = dosDate(createdAt), localLength = files.reduce((sum, file) => sum + 30 + file.name.length + file.bytes.length, 0);
  const centralLength = files.reduce((sum, file) => sum + 46 + file.name.length, 0);
  if (localLength + centralLength + 22 > MAX_PACKAGE_BYTES) throw new Error('This package exceeds 256 MiB. Download the study and Rhino file separately, or reduce the source mesh.');
  const output = new Uint8Array(localLength + centralLength + 22), view = new DataView(output.buffer);
  let position = 0;
  const u16 = value => { view.setUint16(position, value, true); position += 2; };
  const u32 = value => { view.setUint32(position, value, true); position += 4; };
  const bytes = value => { output.set(value, position); position += value.length; };
  for (const file of files) {
    file.offset = position;
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(stamp.time); u16(stamp.date);
    u32(file.crc); u32(file.bytes.length); u32(file.bytes.length); u16(file.name.length); u16(0);
    bytes(file.name); bytes(file.bytes);
  }
  for (const file of files) {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(stamp.time); u16(stamp.date);
    u32(file.crc); u32(file.bytes.length); u32(file.bytes.length); u16(file.name.length);
    u16(0); u16(0); u16(0); u16(0); u32(0); u32(file.offset); bytes(file.name);
  }
  u32(0x06054b50); u16(0); u16(0); u16(files.length); u16(files.length);
  u32(centralLength); u32(localLength); u16(0);
  return output;
}

const shaConstants = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (value, count) => (value >>> count) | (value << (32 - count));

/** SHA-256 fallback also works on HTTP LAN hosts where SubtleCrypto is absent.
 * Hashes establish file identity, not authenticity or fabrication validity. */
export function sha256Bytes(input) {
  if (!(input instanceof Uint8Array) || input.length > MAX_PACKAGE_BYTES) throw new Error('The file cannot be hashed within the package size limit.');
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64, block = new Uint8Array(64), words = new Uint32Array(64);
  const state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    block.fill(0); block.set(input.subarray(offset, offset + 64));
    if (offset <= input.length && input.length < offset + 64) block[input.length - offset] = 0x80;
    const view = new DataView(block.buffer);
    if (offset + 64 === paddedLength) { view.setUint32(56, Math.floor(input.length / 0x20000000), false); view.setUint32(60, (input.length * 8) >>> 0, false); }
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15], b = words[i - 2];
      words[i] = (words[i - 16] + (rotate(a,7)^rotate(a,18)^(a>>>3)) + words[i - 7] + (rotate(b,17)^rotate(b,19)^(b>>>10))) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = state;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + shaConstants[i] + words[i]) >>> 0;
      const t2 = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    for (const [i, value] of [a,b,c,d,e,f,g,h].entries()) state[i] = (state[i] + value) >>> 0;
  }
  return [...state].map(value => value.toString(16).padStart(8,'0')).join('');
}

export async function sha256(input) {
  const bytes = await packageBytes(input);
  if (bytes.length > MAX_PACKAGE_BYTES) throw new Error('The file cannot be hashed within the package size limit.');
  if (globalThis.crypto?.subtle) {
    try { return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2,'0')).join(''); }
    catch { /* The deterministic local fallback supports restricted browsers. */ }
  }
  return sha256Bytes(bytes);
}
