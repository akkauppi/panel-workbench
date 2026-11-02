import test from 'node:test';
import assert from 'node:assert/strict';
import { describePanelProblems } from './panel-diagnostics.js';

const flat = { id: 4, valid: true, issues: [] }, solid = { id: 4, valid: true, issues: [] };
const failed = issues => ({ ...flat, valid: false, issues });

test('successful panels need no error explanation and missing stock stays unresolved', () => {
  assert.equal(describePanelProblems(flat, solid), null);
  const missing = describePanelProblems(flat, undefined);
  assert.equal(missing.stage, 'Solid');
  assert.match(missing.issues.join(' '), /No thick part|Production export waits/);
});

test('outline failure explains the problem, a useful edit, and saving without duplicate solid advice', () => {
  const cell = failed(['The fitted outline crosses itself. Move its centre.', 'The fitted outline crosses itself.']);
  const stock = { ...solid, valid: false, issues: ['Reshape this cell before making a solid panel.'] };
  const before = structuredClone([cell, stock]);
  const result = describePanelProblems(cell, stock);
  assert.equal(result.stage, 'Outline');
  assert.equal(result.issues.filter(text => /Two edges/.test(text)).length, 1);
  assert.match(result.issues.join(' '), /Move a nearby corner.*saved.*Rhino repair/s);
  assert.doesNotMatch(result.issues.join(' '), /after the flat panel/);
  assert.deepEqual([cell, stock], before);
});

test('authored offset failure prioritizes its amount, reset and the unresolved joint', () => {
  const cell = { ...failed(['These panels cannot meet at this offset while staying flat. Reduce or reset the nearby offsets, or divide a neighbouring cell.']), offsetMm: -12.5, offsetIssueCodes: ['offset-junction'] };
  const text = describePanelProblems(cell, solid, { hasOffsets: true }).issues.join(' ');
  assert.equal((text.match(/chosen offsets/g) || []).length, 1);
  assert.match(text, /-12.5 mm offset.*smaller offset.*Reset under Panel offset/);
  assert.doesNotMatch(text, /impossible|guaranteed|caused by/);
});

test('an affected neighbour receives nearby-offset advice without an unsupported cause claim', () => {
  const cell = failed(['The fitted panel extends past a planar source opening.']);
  const text = describePanelProblems(cell, solid, { hasOffsets: true }).issues.join(' ');
  assert.match(text, /opening.*Panel offsets are active.*nearby offset panel/);
  assert.doesNotMatch(text, /This panel has a|offset caused/);
});

test('offset-specific neighbour failures keep Reset advice and avoid cascading duplicate causes', () => {
  const cell = { ...failed([
    'The calculation could not make these panels meet at this offset while staying flat.',
    'This panel is not flat enough (7.50 mm).',
    'The shared edges cannot meet nearby while keeping this panel flat.',
    'The fitted outline could not be triangulated reliably.',
  ]), offsetMm: 0, offsetIssueCodes: ['offset-junction'] };
  const text = describePanelProblems(cell, { ...solid, valid: false, issues: ['Reshape this cell before making a solid panel.'] }, { hasOffsets: true }).issues.join(' ');
  assert.match(text, /chosen offsets.*smaller offset.*Reset under Panel offset.*nearby offset panel/);
  assert.match(text, /flat face by up to 7.5 mm/);
  assert.doesNotMatch(text, /corners do not all fit|neighbouring flat panels cannot|turned into a reliable panel face/);
});

test('known numerical checks retain measurements with familiar explanations', () => {
  const text = describePanelProblems(flat, { ...solid, valid: false, issues: ['Only 2.0 mm of wood remains; 12.0 mm is required.'] }).issues.join(' ');
  assert.match(text, /Remaining material: 2 mm; chosen minimum: 12 mm/);
  const through = describePanelProblems(flat, { ...solid, valid: false, issues: ['Only -2.0 mm of wood remains; 12.0 mm is required.'] }).issues.join(' ');
  assert.match(through, /Carving goes 2 mm through the stock; at least 12 mm should remain/);
});

test('stock and carving failures give actions appropriate to their geometry', () => {
  for (const [raw, expected] of [
    ['The incident offset faces do not meet at this thickness. Reshape the junction.', /thick panel edges.*try less thickness/],
    ['A nearly parallel junction makes an excessively long mitre.', /Almost parallel.*angled cut/],
    ['Only 2.0 mm of wood remains; 12.0 mm is required.', /Carving would leave less material.*Increase the stock thickness/],
    ['The carved face folds or collapses.', /carved face folds over itself.*Try smaller panels/],
    ['The thickness or edge rounding makes an outline cross itself.', /Adding thickness or rounding.*Try less thickness/],
    ['The solid has an unmatched edge.', /open or incorrectly joined edge.*repair.*Rhino/],
  ]) {
    const result = describePanelProblems(flat, { ...solid, valid: false, issues: [raw] });
    assert.equal(result.stage, 'Solid');
    assert.match(result.issues.join(' '), expected);
  }
});

test('unknown errors remain visible without jargon or arbitrary file details', () => {
  const text = describePanelProblems(failed(['Unspecified solver at /private/project.3dm [0,0,1]']), solid).issues.join(' ');
  assert.match(text, /could not finish a usable flat panel.*Undo.*saved/);
  assert.doesNotMatch(text, /private|solver|project.3dm/);
});
