import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, marked } from './_setup.mjs';

// Step 3: toggleEmphasis(blockMd, start, end, kind, marked) wraps/unwraps a
// source range with ** (strong) or * (em). Operates on one block's source;
// returns { md, selStart, selEnd } or null when the result wouldn't parse.

const at = (s, sub) => s.indexOf(sub);

test('wraps a plain word in bold', () => {
  const s = 'hello world';
  const r = core.toggleEmphasis(s, at(s, 'world'), s.length, 'strong', marked);
  assert.equal(r.md, 'hello **world**');
  assert.equal(r.md.slice(r.selStart, r.selEnd), 'world');
});

test('wraps a plain word in italic with single *', () => {
  const s = 'hello world';
  const r = core.toggleEmphasis(s, at(s, 'world'), s.length, 'em', marked);
  assert.equal(r.md, 'hello *world*');
  assert.equal(r.md.slice(r.selStart, r.selEnd), 'world');
});

test('unwraps when the selection sits inside the delimiters', () => {
  const s = 'a **bold** c';
  const start = at(s, 'bold');
  const r = core.toggleEmphasis(s, start, start + 4, 'strong', marked);
  assert.equal(r.md, 'a bold c');
  assert.equal(r.md.slice(r.selStart, r.selEnd), 'bold');
});

test('unwraps when the selection includes the delimiters', () => {
  const s = 'a **bold** c';
  const start = at(s, '**bold**');
  const r = core.toggleEmphasis(s, start, start + '**bold**'.length, 'strong', marked);
  assert.equal(r.md, 'a bold c');
  assert.equal(r.md.slice(r.selStart, r.selEnd), 'bold');
});

test('partial overlap with an existing run produces valid markdown (no **** garbling)', () => {
  const s = 'one **two** three';
  const start = at(s, '**two**');
  const r = core.toggleEmphasis(s, start, s.length, 'strong', marked);
  assert.equal(r.md, 'one **two three**');
  assert.ok(!r.md.includes('****'), 'no doubled delimiters');
  // Result must be a single clean strong token.
  const segs = core.segment(r.md, marked);
  assert.equal(segs.map((x) => x.raw).join(''), r.md);
});

test('refuses (returns null) when the wrap would not parse as emphasis', () => {
  const s = 'a b';
  const r = core.toggleEmphasis(s, at(s, ' '), at(s, ' ') + 1, 'strong', marked);
  assert.equal(r, null);
});
