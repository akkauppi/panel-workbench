/** Shared, serializable generator settings. A fresh object is returned so
 * changing the next arrangement cannot mutate saved provenance or history. */
export function readPattern(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The layout pattern must be an object.');
  const type = input.type === undefined ? 'organic' : input.type;
  const angle = input.angle === undefined ? 0 : input.angle;
  const frequency = input.frequency === undefined ? 2 : input.frequency;
  if (!['organic', 'regularized', 'hexagonal', 'geodesic'].includes(type)) throw new Error('The layout pattern type is unsupported.');
  if (!Number.isFinite(angle) || angle < 0 || angle >= 360) throw new Error('The layout pattern angle must be from 0 to less than 360 degrees.');
  if (!Number.isInteger(frequency) || frequency < 1 || frequency > 6) throw new Error('The layout pattern frequency must be an integer from 1 to 6.');
  if (type === 'regularized') {
    const regularity = input.regularity === undefined ? .7 : input.regularity;
    if (!Number.isFinite(regularity) || regularity < 0 || regularity > 1) throw new Error('The layout pattern regularity must be from 0 to 1.');
    return { type, angle, frequency, regularity };
  }
  return { type, angle, frequency };
}
