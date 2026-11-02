// Designer-facing explanations. Keep the raw geometry issues on their results
// for technical inspection; this adapter does not change validity or export gates.
const reshape = 'Move a nearby corner or cell centre, or divide the region into smaller panels.';
const stock = 'Try less thickness or less edge rounding, then inspect this panel and its neighbours in Solid view.';
const offset = 'Try a smaller offset, or use Reset under Panel offset on this panel or a nearby offset panel.';
const rules = [
  [/cannot meet at this offset|could not make these panels meet at this offset|offset-junction/i, 'The calculation could not make these panels meet at one flat joint with the chosen offsets.', offset],
  [/offset would push|offset-distance/i, 'This offset would move a shared corner too far from the shell.', offset],
  [/offset conflicts with an opening|offset-opening/i, 'The requested offset conflicts with an opening in the shell.', offset],
  [/separate source-surface|separate outlines|separate pieces/i, 'This region contains separate pieces, so it cannot be made as one panel.', 'Divide the region so that each panel is one connected piece.'],
  [/past a planar source opening|source opening|support plane/i, 'Part of the panel would extend across the edge of an opening in the shell.', 'Adjust the nearby corners or cell centres to keep the opening clear.'],
  [/fitted rim|source boundary chords/i, 'The panel edge would move too far away from the edge of the shell.', 'Try a smaller edit, or divide the cells along this edge.'],
  [/not flat enough|out of plane|planarity/i, 'The shared corners do not all fit on one flat panel.', reshape],
  [/shared edges cannot meet/i, 'The neighbouring flat panels cannot currently meet near their intended shared corner.', reshape],
  [/carved face folds|carving.*fold/i, 'The carved face folds over itself or becomes too thin to form a usable shape.', 'Try smaller panels or change the panel position, then check the carving again.'],
  [/wood remains|minimum thickness/i, 'Carving would leave less material than the chosen minimum thickness.', 'Increase the stock thickness or adjust the panel position. Check the remaining material before exporting.'],
  [/exceeds the stock|stock overrun/i, 'The desired carved surface lies outside the available material.', 'Increase the stock thickness or adjust the panel position so that the carved surface fits inside it.'],
  [/round only the outside/i, 'The chosen edge rounding conflicts with the carved inside face.', 'Use rounding on the outside face only when carving.'],
  [/thickness or edge rounding|edge rounding.*opening|edge rounding joins|openings overlap after offsetting/i, 'Adding thickness or rounding makes parts of the outline cross, close up or overlap.', stock],
  [/folded-back joint/i, 'The neighbouring panels turn back against one another, so this joint cannot be built at the chosen thickness.', 'Adjust the nearby panel arrangement or try less thickness.'],
  [/incident offset faces|joint corner differs|incompatible mitres/i, 'The thick panel edges do not meet at a common corner.', 'Adjust the meeting corners or nearby panel offsets, or try less thickness.'],
  [/nearly parallel junction|excessively long mitre/i, 'Almost parallel neighbouring faces would require an excessively long angled cut.', 'Adjust the nearby panel arrangement or try less thickness.'],
  [/more than two panels share an edge/i, 'More than two panels use the same edge, so a normal two-panel joint cannot be made.', 'Inspect the panels along this edge and change the arrangement, or repair the joint in Rhino.'],
  [/outline crosses|crosses itself|self.intersect/i, 'Two edges of the same panel cross each other.', reshape],
  [/touches or overlaps|overlapping|overlaps itself/i, 'The panel boundary touches or overlaps itself, or an opening touches its outer edge.', 'Move the nearby corners apart, or divide the region to remove the overlap.'],
  [/collapsed|collapses|too short|no usable area|no stable normal/i, 'An edge or part of this panel has shrunk to almost nothing.', 'Move the nearby corners apart, or merge an unwanted tiny region with a neighbour.'],
  [/triangulat/i, 'The outline could not be turned into a reliable panel face.', 'Inspect the outline for a very short edge or overlap; adjust its corners or divide the region.'],
  [/unmatched|inconsistently oriented|cannot be oriented|non.manifold/i, 'The thick part has an open or incorrectly joined edge, so it is not a usable closed solid.', 'Adjust the panel or stock settings, or inspect and repair its edges in Rhino.'],
  [/no flat closed outline|invalid boundary/i, 'The panel does not have a usable closed boundary.', reshape],
  [/coverage|uncovered|incompletely covered|partition/i, 'The cell arrangement leaves part of the shell uncovered or covered more than once.', 'Undo the last source edit and try a smaller corner or centre move.'],
  [/not finite|invalid position|invalid coordinate/i, 'The calculation could not find a stable position for part of this panel.', 'Try a smaller edit or Undo, then adjust the nearby arrangement.'],
  [/reshape this cell before making a solid/i, 'A thick part can be built after the flat panel is resolved.', reshape],
];

function issueText(value) {
  return typeof value === 'string' ? value : typeof value?.message === 'string' ? value.message
    : typeof value?.text === 'string' ? value.text : '';
}

function measuredDetail(message) {
  // Retain useful dimensions from known messages, never arbitrary worker text.
  const number = text => Number.isFinite(Number(text)) ? String(Number(text)) : null;
  let match = message.match(/(?:not flat enough \(|face is )([\d.]+) mm(?:\)| out of plane)/i);
  if (match && number(match[1]) !== null) return `The corners miss a flat face by up to ${number(match[1])} mm.`;
  match = message.match(/^Only (-?[\d.]+) mm of wood remains; ([\d.]+) mm is required\./i);
  if (match && number(match[1]) !== null && number(match[2]) !== null) return Number(match[1]) < 0
    ? `Carving goes ${number(String(-Number(match[1])))} mm through the stock; at least ${number(match[2])} mm should remain.`
    : `Remaining material: ${number(match[1])} mm; chosen minimum: ${number(match[2])} mm.`;
  match = message.match(/inside surface exceeds the stock by ([\d.]+) mm/i);
  if (match && number(match[1]) !== null) return `The desired surface lies up to ${number(match[1])} mm beyond the stock.`;
  match = message.match(/joint corner differs by ([\d.]+) mm/i);
  if (match && number(match[1]) !== null) return `The joint corners miss each other by ${number(match[1])} mm.`;
  return null;
}

/** null means both current stages passed. Missing stock is still unresolved.
 * hasOffsets supplies context only: it never asserts that an offset caused an
 * unrelated failure. Limit repeated advice when one corner triggers many tests. */
export function describePanelProblems(cell, solid, { hasOffsets = false } = {}) {
  if (cell?.valid === true && solid?.valid === true) return null;
  const flatFailed = cell?.valid !== true, causes = new Set(), actions = new Set(), measurements = new Set();
  const activeOffset = Number.isFinite(cell?.offsetMm) && cell.offsetMm !== 0;
  const offsetCodes = Array.isArray(cell?.offsetIssueCodes) ? cell.offsetIssueCodes : [];
  const texts = [
    ...offsetCodes,
    ...(flatFailed && Array.isArray(cell?.issues) ? cell.issues : []),
    ...(Array.isArray(solid?.issues) ? solid.issues.filter(value => !(flatFailed && /reshape this cell before making a solid/i.test(issueText(value)))) : []),
  ];
  let unknown = false;
  for (const value of texts) {
    const message = issueText(value);
    const measurement = measuredDetail(message);
    if (measurement) measurements.add(measurement);
    // A conflicting offset commonly triggers all three downstream checks.
    // Explain the shared cause once instead of presenting three new problems.
    if (offsetCodes.length && /not flat enough|out of plane|shared edges cannot meet|triangulat/i.test(message)) continue;
    const rule = rules.find(([expression]) => expression.test(message));
    if (rule) { causes.add(rule[1]); actions.add(rule[2]); }
    else unknown = true;
  }
  if (!causes.size || unknown) causes.add(`The calculation could not finish a usable ${flatFailed ? 'flat panel' : 'thick part'}${causes.size ? ' and reported an additional issue' : ''}.`);
  if (!solid && !flatFailed) causes.add('No thick part was produced for this panel.');
  const issues = [...causes, ...measurements];
  if (activeOffset) issues.push(`This panel has a ${cell.offsetMm > 0 ? '+' : ''}${Number(cell.offsetMm.toFixed(3))} mm offset. ${offset}`);
  else if (hasOffsets || offsetCodes.length) issues.push(`Panel offsets are active. ${offset}`);
  if (activeOffset || hasOffsets || offsetCodes.length) actions.delete(offset);
  issues.push(...[...actions].slice(0, 2));
  if (!actions.size && !activeOffset && !hasOffsets) issues.push('Try Undo or adjust the nearby arrangement, then calculate again.');
  issues.push('Your design can still be saved. Production export waits for these checks; Rhino repair export includes the available candidate for manual repair.');
  return { stage: flatFailed ? 'Outline' : 'Solid', issues };
}
