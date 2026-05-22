import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, marked } from './_setup.mjs';

// Step 4: splitBlock(blockMd, offset, marked) → { md, caret } splits one block
// into two at a source offset. mergeBlock(md, offset, marked) is the inverse:
// Backspace at a block start removes the separator and rejoins.

const roundTrips = (md) => core.segment(md, marked).map((s) => s.raw).join('') === md;

test('splits a paragraph at the caret into two paragraphs', () => {
  const s = 'First. Second.';
  const r = core.splitBlock(s, s.indexOf('Second'), marked);
  assert.equal(r.md, 'First. \n\nSecond.');
  assert.equal(r.md.slice(r.caret), 'Second.');
  assert.ok(roundTrips(r.md));
});

test('splitting inside **bold** closes and reopens the delimiters', () => {
  const s = '**ab**';
  const r = core.splitBlock(s, 3, marked); // between a and b
  assert.equal(r.md, '**a**\n\n**b**');
  assert.ok(roundTrips(r.md));
});

test('splitting a heading yields a heading plus a new paragraph (no leading #)', () => {
  const s = '## Title here\n\n';
  const r = core.splitBlock(s, s.indexOf('here'), marked);
  assert.equal(r.md, '## Title \n\nhere\n\n');
  const types = core.segment(r.md, marked).filter((x) => x.type !== 'space').map((x) => x.type);
  assert.deepEqual(types, ['heading', 'paragraph']);
  assert.ok(roundTrips(r.md));
});

test('splitting a list item makes a new tight item with the same marker', () => {
  const s = '- one\n- two\n';
  const r = core.splitBlock(s, s.indexOf('two') + 1, marked); // between t and wo
  assert.equal(r.md, '- one\n- t\n- wo\n');
  assert.ok(roundTrips(r.md));
});

test('mergeBlock rejoins two blocks and drops the intervening separator', () => {
  const s = 'First.\n\nSecond.';
  const r = core.mergeBlock(s, s.indexOf('Second'), marked);
  assert.equal(r.md, 'First.Second.');
  assert.equal(r.caret, 6);
  assert.ok(roundTrips(r.md));
});
