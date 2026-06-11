import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, marked } from './_setup.mjs';
import { mulberry32, irange, genDoc } from './_prop.mjs';

// Block operations in model space (docs/editing-model.md, migration step 3).
// Each op is a small definitional function on the block list — splitting is
// slicing a text array, merging is concatenation, indenting is depth+1.
// Emphasis close/reopen across a split is free: attrs travel with the chars.

const M = core.Model;

const chars = (s, attrs) => s.split('').map((ch) => ({ ch, attrs: attrs ? { ...attrs } : {} }));
const para = (s) => ({ kind: 'paragraph', text: chars(s), prov: null, raw: null, sep: '\n' });
const item = (s, depth, marker) => ({
  kind: 'listItem', depth: depth || 0, marker: marker || { bullet: '-' },
  text: chars(s), prov: null, raw: null, sep: '\n',
});

// --- splitBlockM ----------------------------------------------------------------

test('splitting a heading yields heading + paragraph, text sliced at the point', () => {
  const blocks = [{ kind: 'heading', level: 2, text: chars('Title here'), prov: null, raw: null, sep: '\n' }];
  const r = M.splitBlockM(blocks, 0, 6);
  assert.equal(r.blocks.length, 2);
  assert.equal(r.blocks[0].kind, 'heading');
  assert.equal(r.blocks[0].level, 2);
  assert.equal(r.blocks[1].kind, 'paragraph');
  assert.equal(r.blocks[0].text.map((c) => c.ch).join(''), 'Title ');
  assert.equal(r.blocks[1].text.map((c) => c.ch).join(''), 'here');
});

test('splitting a quote keeps the left a quote, the right a paragraph', () => {
  const blocks = [{ kind: 'quote', text: chars('a b'), prov: null, raw: null, sep: '\n' }];
  const r = M.splitBlockM(blocks, 0, 2);
  assert.equal(r.blocks[0].kind, 'quote');
  assert.equal(r.blocks[1].kind, 'paragraph');
});

test('attrs travel with the chars across a split', () => {
  const blocks = [{ kind: 'paragraph', text: chars('ab', { b: true }), prov: null, raw: null, sep: '' }];
  const r = M.splitBlockM(blocks, 0, 1);
  assert.ok(r.blocks[0].text[0].attrs.b && r.blocks[1].text[0].attrs.b);
  assert.equal(M.printBlocks(r.blocks, marked), '**a**\n\n**b**');
});

test('splitting an ordered item continues the numbering on the right', () => {
  const blocks = [item('one', 0, { ordered: true, num: 3, delim: '.' })];
  const r = M.splitBlockM(blocks, 0, 3);
  assert.deepEqual(r.blocks[1].marker, { ordered: true, num: 4, delim: '.' });
  assert.equal(r.blocks[1].kind, 'listItem');
  assert.equal(r.blocks[1].depth, 0);
});

test('splitting an EMPTY listItem signals exit with the surrounding blocks', () => {
  const blocks = [item('one'), item(''), item('two')];
  const r = M.splitBlockM(blocks, 1, 0);
  assert.equal(r.exit, true);
  assert.equal(r.before.length, 1);
  assert.equal(r.after.length, 1);
  assert.equal(r.after[0].text.map((c) => c.ch).join(''), 'two');
});

test('ops refuse opaque blocks', () => {
  assert.equal(M.splitBlockM([{ kind: 'opaque', raw: '```\nx\n```\n' }], 0, 1), null);
  assert.equal(M.indentM([{ kind: 'opaque', raw: 'x' }], 0), null);
});

// --- mergeBlocksM ---------------------------------------------------------------

test('merging concatenates texts; the left block kind wins', () => {
  const blocks = [{ kind: 'heading', level: 1, text: chars('H'), prov: null, raw: null, sep: '\n\n' }, para('rest')];
  const r = M.mergeBlocksM(blocks, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'heading');
  assert.equal(r[0].text.map((c) => c.ch).join(''), 'Hrest');
});

test('merging items keeps the left marker', () => {
  const blocks = [item('a', 0, { ordered: true, num: 1, delim: '.' }), item('b', 0, { ordered: true, num: 2, delim: '.' })];
  const r = M.mergeBlocksM(blocks, 1);
  assert.deepEqual(r[0].marker, { ordered: true, num: 1, delim: '.' });
  assert.equal(r[0].text.map((c) => c.ch).join(''), 'ab');
});

// --- indentM / outdentM ---------------------------------------------------------

test('indentM is depth+1; the first item cannot nest', () => {
  const blocks = [item('a'), item('b')];
  assert.equal(M.indentM(blocks, 0), null);
  const r = M.indentM(blocks, 1);
  assert.equal(r[1].depth, 1);
  assert.equal(r[0].depth, 0);
});

test('outdentM is depth-1; at depth 0 the item becomes a paragraph', () => {
  const blocks = [item('a'), item('b', 1)];
  const r1 = M.outdentM(blocks, 1);
  assert.equal(r1[1].kind, 'listItem');
  assert.equal(r1[1].depth, 0);
  const r0 = M.outdentM(blocks, 0);
  assert.equal(r0[0].kind, 'paragraph');
});

test('outdenting to a paragraph opens a blank line after a preceding item', () => {
  const blocks = M.parseBlocks('- one\n- two\n', marked);
  const r = M.outdentM(blocks, 1);
  assert.equal(M.printBlocks(r, marked), '- one\n\ntwo\n');
});

// --- split-then-merge identity (property) ---------------------------------------

test('split then merge is identity on kind/marker/text, over generated docs', () => {
  const rnd = mulberry32(0x0975);
  let exercised = 0;
  for (let iter = 0; iter < 100; iter++) {
    const doc = M.parseDoc(genDoc(rnd, true), marked);
    const blocks = doc.blocks;
    const styled = blocks.map((b, i) => i).filter((i) => blocks[i].kind !== 'opaque' && blocks[i].text.length);
    if (!styled.length) continue;
    const i = styled[irange(rnd, 0, styled.length - 1)];
    const ch = irange(rnd, 0, blocks[i].text.length);
    const r = M.splitBlockM(blocks, i, ch);
    if (!r || r.exit) continue;
    exercised++;
    const back = M.mergeBlocksM(r.blocks, i + 1);
    assert.equal(back.length, blocks.length);
    const a = back[i], b = blocks[i];
    assert.equal(a.kind, b.kind);
    assert.deepEqual(a.marker || null, b.marker || null);
    assert.ok(M.textEq(a.text, b.text),
      `split+merge lost text (iter ${iter}, block ${i}, ch ${ch})`);
  }
  assert.ok(exercised >= 50, `too few cases exercised: ${exercised}`);
});

// --- wrapper-level sanity (full byte expectations live in split-merge/list-editing)

test('splitBlock on a quote produces quote + paragraph bytes', () => {
  const r = core.splitBlock('> a b\n', 4, marked); // before "b"
  assert.equal(r.md, '> a \n\nb\n');
});

test('mergeBlock with marked merges through the model, caret at the join', () => {
  const s = '## H\n\nrest.';
  const r = core.mergeBlock(s, s.indexOf('rest'), marked);
  assert.equal(r.md, '## Hrest.');
  assert.equal(r.md.slice(r.caret), 'rest.');
});
