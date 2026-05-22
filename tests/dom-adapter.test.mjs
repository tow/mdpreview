import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { core, marked } from './_setup.mjs';

// Step 6: the DOM adapter maps between a rendered block element and source
// offsets, and reads pure-text edits back out as a leaf-edits map. These are
// the only DOM-coupled functions; everything they compute is checked against
// the pure core (segment/reserialize/applyLeafEdits).

// Render one block's markdown into a detached <div data-seg> like the app does.
function renderBlock(md) {
  const seg = core.segment(md, marked)[0];
  const html = marked.parser([seg.token]);
  const dom = new JSDOM(`<!DOCTYPE html><div id="seg">${html}</div>`);
  return { seg, el: dom.window.document.getElementById('seg'), win: dom.window };
}

// Find the text node + local offset for a given linear display offset.
function locate(el, dispOffset) {
  const w = el.ownerDocument.createTreeWalker(el, el.ownerDocument.defaultView.NodeFilter.SHOW_TEXT);
  let acc = 0, node;
  while ((node = w.nextNode())) {
    if (dispOffset <= acc + node.textContent.length) return { node, offset: dispOffset - acc };
    acc += node.textContent.length;
  }
  return { node, offset: node ? node.textContent.length : 0 };
}

test('source offset round-trips through the DOM for plain text', () => {
  const md = 'hello world';
  const { seg, el } = renderBlock(md);
  for (const src of [0, 5, 6, 11]) {
    const { node, offset } = core.sourceOffsetToDom(el, src, seg.token);
    assert.equal(core.domOffsetToSourceOffset(el, node, offset, seg.token), src, `offset ${src}`);
  }
});

test('a caret inside bold maps to the right source offset (past the **)', () => {
  const md = 'a **bold** c';
  const { seg, el } = renderBlock(md);
  // Display offset of the start of "bold" is 2 ("a "); source offset is 4 (past "a **").
  const { node, offset } = locate(el, 2);
  assert.equal(core.domOffsetToSourceOffset(el, node, offset, seg.token), 4);
});

test('selecting an emphasized word maps its end inside the closing delimiter', () => {
  // Selecting the visible text "bold" of **bold**: the start biases into the
  // run (past the opening **), and the end must bias to the run's inner end
  // (before the closing **), not jump past it — otherwise unwrap can't see the
  // delimiters. md "a **bold** c": inner "bold" is source [4,8).
  const md = 'a **bold** c';
  const { seg, el } = renderBlock(md);
  const start = locate(el, 2); // display start of "bold"
  const end = locate(el, 6);   // display end of "bold"
  assert.equal(core.domOffsetToSourceOffset(el, start.node, start.offset, seg.token, 'start'), 4);
  assert.equal(core.domOffsetToSourceOffset(el, end.node, end.offset, seg.token, 'end'), 8);
});

test('offsets inside an escape clamp to the leaf boundary', () => {
  const md = 'x \\* y';
  const { seg, el } = renderBlock(md);
  // Display "x * y": offset 2 is the "*" (one display char ↔ two source bytes "\\*").
  const before = locate(el, 2);
  const after = locate(el, 3);
  assert.equal(core.domOffsetToSourceOffset(el, before.node, before.offset, seg.token), 2);
  assert.equal(core.domOffsetToSourceOffset(el, after.node, after.offset, seg.token), 4);
});

test('readEditsFromDom returns no edits when nothing changed', () => {
  const { seg, el } = renderBlock('unchanged text');
  const r = core.readEditsFromDom(el, seg.token);
  assert.equal(r.clean, true);
  assert.equal(r.edits.size, 0);
});

test('editing a plain word yields a leaf edit that applyLeafEdits can replay', () => {
  const md = 'the quick fox';
  const { seg, el } = renderBlock(md);
  // Simulate the user editing the text: "quick" -> "slow".
  el.querySelector('p').textContent = 'the slow fox';
  const r = core.readEditsFromDom(el, seg.token);
  assert.equal(r.clean, true);
  assert.equal(core.applyLeafEdits(seg, r.edits), 'the slow fox');
});

test('editing text inside bold preserves the ** delimiters on replay', () => {
  const md = 'a **bold** c';
  const { seg, el } = renderBlock(md);
  // Edit only the bold word's text node.
  el.querySelector('strong').firstChild.textContent = 'BOLD';
  const r = core.readEditsFromDom(el, seg.token);
  assert.equal(r.clean, true);
  assert.equal(core.applyLeafEdits(seg, r.edits), 'a **BOLD** c');
});

test('a change spanning a formatting boundary is reported not-clean', () => {
  const md = 'a **bold** c';
  const { seg, el } = renderBlock(md);
  // Collapse everything into one text node — crosses the <strong> boundary.
  el.querySelector('p').textContent = 'a X c';
  const r = core.readEditsFromDom(el, seg.token);
  assert.equal(r.clean, false);
});
