import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, marked, fixtures } from './_setup.mjs';

// Step 1: segment(md, marked) splits markdown into top-level block segments
// whose raw bytes reassemble the original file exactly.

test('segment reassembles every fixture byte-for-byte', () => {
  for (const { name, md } of fixtures()) {
    const segs = core.segment(md, marked);
    const rejoined = segs.map((s) => s.raw).join('');
    assert.equal(rejoined, md, `round-trip failed for ${name}`);
  }
});

test('space tokens are their own segments and are non-editable', () => {
  const md = 'First.\n\nSecond.\n';
  const segs = core.segment(md, marked);
  const spaces = segs.filter((s) => s.type === 'space');
  assert.equal(spaces.length, 1, 'the blank line between paragraphs is a space segment');
  assert.equal(spaces[0].raw, '\n\n');
  assert.equal(spaces[0].editable, false);
});

test('code and mermaid blocks are tagged non-editable; prose is editable', () => {
  const md = [
    'Prose paragraph.',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '```mermaid',
    'graph TD',
    '  A --> B',
    '```',
    '',
  ].join('\n');
  const segs = core.segment(md, marked);
  const byType = (t) => segs.filter((s) => s.type === t);

  const codeSegs = byType('code');
  assert.equal(codeSegs.length, 2, 'js and mermaid are both code blocks');
  for (const s of codeSegs) assert.equal(s.editable, false, 'code/mermaid not editable');

  const paras = byType('paragraph');
  assert.ok(paras.length >= 1);
  assert.equal(paras[0].editable, true, 'prose is editable');
});
