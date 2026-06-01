import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, marked } from './_setup.mjs';

// Pure list-editing transforms (no DOM). All operate on a single list block's
// markdown + a source offset, and must preserve the segment invariant
// (segs.map(s=>s.raw).join('') === md).

const roundTrips = (md) => core.segment(md, marked).map((s) => s.raw).join('') === md;
const list = (md) => marked.lexer(md)[0];

// --- splitBlock / splitList: Return ---------------------------------------

test('Return at the end of the last item appends a new empty item', () => {
  const s = '- one\n- two\n';
  const r = core.splitBlock(s, 11, marked); // caret after "two"
  assert.equal(r.md, '- one\n- two\n-'); // bare bullet — stays one clean list on re-lex
  assert.ok(roundTrips(r.md));
  const re = list(r.md);
  assert.equal(re.items.length, 3);
  assert.equal(re.items[2].text, ''); // empty
});

test('Return at the end of a non-last item inserts a new empty item after it', () => {
  const s = '- one\n- two\n';
  const r = core.splitBlock(s, 5, marked); // caret after "one"
  assert.equal(r.md, '- one\n- \n- two\n');
  assert.ok(roundTrips(r.md));
});

test('Return in the middle of an item still splits it in two (regression)', () => {
  const s = '- one\n- two\n';
  const r = core.splitBlock(s, 9, marked); // between t and wo
  assert.equal(r.md, '- one\n- t\n- wo\n');
  assert.ok(roundTrips(r.md));
});

test('Return at the end of an ordered-list item re-lexes to a 3-item list', () => {
  const s = '1. one\n2. two\n';
  const r = core.splitBlock(s, 13, marked); // after "two"
  assert.ok(roundTrips(r.md));
  const re = list(r.md);
  assert.equal(re.type, 'list');
  assert.equal(re.ordered, true);
  assert.equal(re.items.length, 3);
});

test('Return at the end of a nested item adds a sibling nested item', () => {
  const s = '- one\n  * sub\n';
  const r = core.splitBlock(s, s.indexOf('sub') + 3, marked); // end of "sub"
  assert.equal(r.md, '- one\n  * sub\n  *');
  assert.ok(roundTrips(r.md));
});

test('Return in the middle of a nested item splits it at the same indent', () => {
  const s = '- one\n  * subitem\n';
  const r = core.splitBlock(s, s.indexOf('sub') + 3, marked); // between "sub" and "item"
  assert.equal(r.md, '- one\n  * sub\n  * item\n');
  assert.ok(roundTrips(r.md));
});

// --- Empty item + Return: exit the list -----------------------------------

test('Return on an empty trailing item signals exit, list before / nothing after', () => {
  const s = '- one\n- \n';
  const r = core.splitBlock(s, 8, marked); // caret in the empty item
  assert.equal(r.exit, true);
  assert.equal(r.before, '- one\n');
  assert.equal(r.after, '');
});

test('Return on an empty middle item splits the list around the exit point', () => {
  const s = '- one\n- \n- two\n';
  const r = core.splitBlock(s, 8, marked);
  assert.equal(r.exit, true);
  assert.equal(r.before, '- one\n');
  assert.equal(r.after, '- two\n');
});

// --- mergeListItem: Backspace at item start -------------------------------

test('Backspace at the start of item 2 merges it into item 1', () => {
  const s = '- one\n- two\n';
  const r = core.mergeListItem(s, 8, marked); // start of "two"
  assert.equal(r.md, '- onetwo\n');
  assert.equal(r.caret, 5); // between "one" and "two"
  assert.ok(roundTrips(r.md));
});

test('Backspace at the start of a middle item keeps the following items', () => {
  const s = '- one\n- two\n- three\n';
  const r = core.mergeListItem(s, 8, marked);
  assert.equal(r.md, '- onetwo\n- three\n');
  assert.equal(r.caret, 5);
  assert.ok(roundTrips(r.md));
});

test('Backspace at the start of the first item outdents it to a paragraph', () => {
  const s = '- one\n- two\n';
  const r = core.mergeListItem(s, 2, marked); // start of "one"
  assert.equal(r.md, 'one\n\n- two\n');
  assert.equal(r.caret, 0);
  assert.ok(roundTrips(r.md));
});

test('Backspace in a single-item list outdents to a bare paragraph', () => {
  const s = '- one\n';
  const r = core.mergeListItem(s, 2, marked);
  assert.equal(r.md, 'one\n');
  assert.ok(roundTrips(r.md));
});

// --- indentItem / outdentItem: Tab / Shift+Tab ----------------------------

test('Tab on item 2 indents it into a nested sub-list', () => {
  const s = '- one\n- two\n';
  const r = core.indentItem(s, 8, marked);
  assert.equal(r.md, '- one\n  - two\n');
  assert.equal(r.caret, 10);
  assert.ok(roundTrips(r.md));
});

test('Tab on the first item is a no-op (nothing to nest under)', () => {
  const s = '- one\n- two\n';
  const r = core.indentItem(s, 2, marked);
  assert.equal(r.md, s);
});

test('Shift+Tab on a nested item outdents it one level', () => {
  const s = '- one\n  - two\n';
  const r = core.outdentItem(s, 10, marked); // inside nested "two"
  assert.equal(r.md, '- one\n- two\n');
  assert.equal(r.caret, 8);
  assert.ok(roundTrips(r.md));
});

test('Tab on an empty bullet nests it without forming a setext heading', () => {
  // An indented bare "-" under a text line is read as a setext-H2 underline;
  // an empty nested bullet must use a non-setext marker.
  const s = '- one\n-'; // trailing empty item "-"
  const r = core.indentItem(s, 6, marked);
  assert.equal(r.md, '- one\n  *');
  assert.ok(roundTrips(r.md));
  assert.ok(!/<h[1-6]/.test(marked.parse(r.md)), 'must not render a heading');
});

test('Shift+Tab on a top-level item outdents it to a paragraph', () => {
  const s = '- one\n- two\n';
  const r = core.outdentItem(s, 8, marked); // top-level "two"
  assert.equal(r.md, '- one\n\ntwo\n');
  assert.ok(roundTrips(r.md));
});
