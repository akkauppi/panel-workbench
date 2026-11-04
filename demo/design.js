import { generateSeeds, generateAdaptiveSeeds, generateCellLayout } from './geometry.js';
import { captureLayout, restoreLayout, layoutRecipe } from './layout.js';
import { readPattern } from './pattern.js';
import { readGeneratorPolicy, readMaxGeneratedCells } from './generator-policy.js';
import { generateStructuredLayout } from './structured.js';
import { generateRegularizedLayout } from './regularized.js';

const generatePattern = (model, pattern, inputs) => pattern.type === 'regularized'
  ? generateRegularizedLayout(model, pattern, { size: inputs.size, randomSeed: inputs.randomSeed, generatorPolicy: inputs.generatorPolicy, maxGeneratedCells: inputs.maxGeneratedCells })
  : generateStructuredLayout(model, pattern, { size: inputs.size, mergeGroups: inputs.mergeGroups });

// During the transition to direct graph editing, legacy tools produce a new
// source layout only when their inputs change. Panel/stock settings are not
// part of this recipe and must never repartition an accepted design.
export function resolveSourceLayout(model, inputs, { strict = false } = {}) {
  const pattern = readPattern(inputs.pattern);
  const generatorPolicy = readGeneratorPolicy(inputs.generatorPolicy, pattern);
  const maxGeneratedCells = readMaxGeneratedCells(inputs.maxGeneratedCells);
  let generated = null;
  let seeds = inputs.seeds?.length ? inputs.seeds : null;
  if (!seeds) {
    if (pattern.type === 'organic') seeds = generatorPolicy
      ? generateAdaptiveSeeds(model, generatorPolicy, inputs.variation, inputs.randomSeed, maxGeneratedCells).seeds
      : generateSeeds(model, inputs.size, inputs.variation, inputs.randomSeed, maxGeneratedCells);
    else {
      generated = generatePattern(model, pattern, inputs);
      seeds = generated.seeds;
    }
  }
  const recipe = layoutRecipe({ ...inputs, pattern, seeds });
  if (strict && inputs.directBase) restoreLayout(model, inputs.directBase);
  if (inputs.layout && JSON.stringify(inputs.layout.recipe) === JSON.stringify(recipe)) {
    return { seeds, layout: inputs.layout, surface: restoreLayout(model, inputs.layout), source: 'stored' };
  }
  if ((strict || inputs.layout?.authority === 'graph') && inputs.layout) throw new Error('The saved layout does not match its editing inputs. Reset direct edits before changing the generated layout.');
  let surface;
  if (pattern.type === 'organic') surface = generateCellLayout(model, seeds, {
      size: inputs.size, mergeGroups: inputs.mergeGroups ?? [], cornerEdits: inputs.cornerEdits ?? [],
    });
  else {
    generated ??= generatePattern(model, pattern, inputs);
    seeds = generated.seeds;
    surface = generated.surface;
  }
  const layout = captureLayout(model, surface, { previous: inputs.previousLayout ?? inputs.layout ?? null,
    recipe: layoutRecipe({ ...inputs, pattern, seeds }) });
  return { seeds, layout, surface, source: 'generated' };
}
