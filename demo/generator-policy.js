export const CURVATURE_SIZING_FEATURE = 'curvature-sizing-v1';
export const GENERATION_BUDGET_FEATURE = 'generation-budget-v1';
export const DEFAULT_MAX_GENERATED_CELLS = 240;
export const MIN_GENERATED_CELLS = 12;
export const MAX_GENERATED_CELLS = 500;

/** A preference for new Organic/Regularized arrangements, not a restriction
 * on an accepted source layout or a promise that detailed meshes will finish. */
export function readMaxGeneratedCells(input) {
  if (input === undefined || input === null) return DEFAULT_MAX_GENERATED_CELLS;
  if (!Number.isSafeInteger(input) || input < MIN_GENERATED_CELLS || input > MAX_GENERATED_CELLS) {
    throw new Error(`Set the maximum generated cells to a whole number from ${MIN_GENERATED_CELLS} to ${MAX_GENERATED_CELLS}.`);
  }
  return input;
}

/** Optional source-generation policy. Sizes are target centre spacings in mm,
 * independent of the source file's units. Null means the existing uniform
 * generator; serializers omit it so earlier authored documents stay unchanged.
 * A new policy meaning requires a new version and required-feature declaration.
 */
export function readGeneratorPolicy(input, pattern) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('The generator policy must be an object or disabled.');
  if (input.type !== 'curvature') throw new Error('This generator policy is unsupported. Open the project with a compatible Panel Workbench.');
  if (input.version !== 1) throw new Error('This curvature-sizing version is unsupported. Open the project with a newer compatible Panel Workbench.');
  if (!Number.isFinite(input.minSizeMm) || input.minSizeMm < 10) throw new Error('The minimum curvature cell size must be a finite value of at least 10 mm.');
  if (!Number.isFinite(input.maxSizeMm) || input.maxSizeMm < input.minSizeMm) throw new Error('The maximum curvature cell size must be finite and at least the minimum size.');
  const type = typeof pattern === 'string' ? pattern : pattern?.type;
  if (pattern !== undefined && !['organic', 'regularized'].includes(type)) throw new Error('Curvature sizing is supported only for Organic and Regularized arrangements.');
  return { type: 'curvature', version: 1, minSizeMm: input.minSizeMm, maxSizeMm: input.maxSizeMm };
}
