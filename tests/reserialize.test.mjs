import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, marked, fixtures, fixture } from './_setup.mjs';

// Step 2: reserialize(token, edits) rebuilds a block's markdown from its token
// tree. An untouched subtree must come back byte-for-byte; an edited text leaf
// is substituted while every delimiter byte is preserved.

// Walk a token tree, collecting text leaves (depth-first, document order).
function textLeaves(token, out = []) {
  const kids = (token.tokens && token.tokens.length) ? token.tokens
    : (token.items && token.items.length) ? token.items : null;
  if (!kids) {
    if (token.type === 'text') out.push(token);
    return out;
  }
  for (const k of kids) textLeaves(k, out);
  return out;
}

function find(token, pred) {
  const kids = (token.tokens && token.tokens.length) ? token.tokens
    : (token.items && token.items.length) ? token.items : null;
  if (pred(token)) return token;
  if (!kids) return null;
  for (const k of kids) {
    const hit = find(k, pred);
    if (hit) return hit;
  }
  return null;
}

test('reserialize with no edits is byte-identical for every block in every fixture', () => {
  for (const { name, md } of fixtures()) {
    for (const seg of core.segment(md, marked)) {
      assert.equal(
        core.reserialize(seg.token, new Map()),
        seg.raw,
        `identity failed for a ${seg.type} in ${name}`,
      );
    }
  }
});

test('editing a bold word keeps the ** delimiters', () => {
  const md = fixture('basic.md');
  const para = core.segment(md, marked).find((s) => s.raw.includes('**bold**'));
  const strong = find(para.token, (t) => t.type === 'strong');
  const leaf = textLeaves(strong)[0];
  const out = core.reserialize(para.token, new Map([[leaf, 'BOLD']]));
  assert.equal(out, para.raw.replace('**bold**', '**BOLD**'));
});

test('editing a link label keeps the destination', () => {
  const md = fixture('basic.md');
  const para = core.segment(md, marked).find((s) => s.raw.includes('[link]'));
  const link = find(para.token, (t) => t.type === 'link');
  const leaf = textLeaves(link)[0];
  const out = core.reserialize(para.token, new Map([[leaf, 'site']]));
  assert.equal(out, para.raw.replace('[link](https://example.com)', '[site](https://example.com)'));
});

test('editing one text run leaves escapes and entities in the same block untouched', () => {
  const md = fixture('basic.md');
  const para = core.segment(md, marked).find((s) => s.raw.includes('escaped'));
  const leaf = textLeaves(para.token).find((t) => t.text.includes('second'));
  const newText = leaf.text.replace('second', '2nd');
  const out = core.reserialize(para.token, new Map([[leaf, newText]]));
  assert.equal(out, para.raw.replace(leaf.raw, newText));
  assert.ok(out.includes('\\*asterisk\\*'), 'escaped asterisks preserved');
  assert.ok(out.includes('&amp;'), 'entity preserved');
});

test('editing a word inside a list item keeps the list marker', () => {
  const md = fixture('lists.md');
  const list = core.segment(md, marked).find((s) => s.type === 'list');
  const leaf = textLeaves(list.token).find((t) => t.text.includes('item'));
  const newText = leaf.text.replace('item', 'ITEM');
  const out = core.reserialize(list.token, new Map([[leaf, newText]]));
  assert.equal(out, list.raw.replace(leaf.raw, newText));
});

test('applyLeafEdits(segment, edits) returns the rebuilt block raw', () => {
  const md = fixture('basic.md');
  const para = core.segment(md, marked).find((s) => s.raw.includes('**bold**'));
  const strong = find(para.token, (t) => t.type === 'strong');
  const leaf = textLeaves(strong)[0];
  const edits = new Map([[leaf, 'BOLD']]);
  assert.equal(core.applyLeafEdits(para, edits), core.reserialize(para.token, edits));
});
