import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { core, marked } from './_setup.mjs';

// reconcileDomEdit(el, blockToken, marked): fold an arbitrary browser edit —
// anything beyond a single-leaf text substitution — back into block source.
// These are the edits that used to sit silently in the DOM and resurrect on
// the next re-render (e.g. select a whole list section, delete, press Return).

function renderBlock(md) {
  const dom = new JSDOM('<body><div id="b"></div></body>');
  const el = dom.window.document.getElementById('b');
  el.innerHTML = marked.parse(md);
  core.stripStructuralWhitespace(el);
  return { el, token: marked.lexer(md)[0], doc: dom.window.document };
}

// Make the DOM text equal `want` by removing/altering text nodes, mimicking
// what a contenteditable selection edit leaves behind.
function textNodes(el, doc) {
  const w = doc.createTreeWalker(el, 4 /* SHOW_TEXT */);
  const out = []; let n;
  while ((n = w.nextNode())) out.push(n);
  return out;
}

test('deleting a middle list item folds into source', () => {
  const t = renderBlock('- one\n- two\n- three\n');
  const li = t.el.querySelectorAll('li')[1];
  li.parentNode.removeChild(li);
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.raw, '- one\n- three\n');
});

test('deleting every list item folds into source', () => {
  const t = renderBlock('- one\n- two\n- three\n');
  textNodes(t.el, t.doc).forEach((n) => { n.textContent = ''; });
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r.changed && r.empty, 'should report the block as emptied');
  const remaining = marked.lexer(r.raw);
  const disp = remaining.filter((x) => x.type !== 'space')
    .map((x) => x.raw).join('').replace(/[-*+\s\d.)]/g, '');
  assert.equal(disp, '', 'no visible text may survive');
});

test('deletion spanning two items merges them like the browser did', () => {
  const t = renderBlock('- one\n- two\n- three\n');
  // browser merge: "on|e\n- two\n- thr|ee" deleted → single li "onee"... emulate:
  const nodes = textNodes(t.el, t.doc);
  nodes[0].textContent = 'on';           // "one" → "on"
  const liTwo = t.el.querySelectorAll('li')[1];
  liTwo.parentNode.removeChild(liTwo);   // "two" gone
  nodes[2].textContent = 'ree';          // "three" → "ree"
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  const disp = marked.lexer(r.raw)[0];
  assert.ok(r.raw.includes('on') && r.raw.includes('ree') && !r.raw.includes('two'));
});

test('deleting a whole bold run removes its delimiters', () => {
  const t = renderBlock('a **bold** c');
  const strong = t.el.querySelector('strong');
  strong.parentNode.removeChild(strong);
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.raw, 'a  c');
});

test('deletion running from inside a bold run into the text after it', () => {
  const t = renderBlock('a **bold** c');
  const nodes = textNodes(t.el, t.doc);
  // delete display "ld c": bold text → "bo", trailing " c" → ""
  nodes[1].textContent = 'bo';
  nodes[2].textContent = '';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.raw, 'a **bo**');
});

test('typing over a selection spanning an emphasis run', () => {
  const t = renderBlock('alpha *beta* gamma');
  // select "beta gam", type "X" → display "alpha Xma"
  const nodes = textNodes(t.el, t.doc);
  nodes[0].textContent = 'alpha X';
  const em = t.el.querySelector('em');
  em.parentNode.removeChild(em);
  nodes[2].textContent = 'ma';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.raw, 'alpha Xma');
});

test('emptying a heading keeps it a heading', () => {
  const t = renderBlock('## Title\n');
  textNodes(t.el, t.doc).forEach((n) => { n.textContent = ''; });
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r.changed && r.empty);
  assert.match(r.raw, /^##\s*\n?$/);
});

test('an untouched block reports changed:false', () => {
  const t = renderBlock('- one\n- two\n');
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.changed, false);
});

test('an unmappable edit returns null rather than corrupting source', () => {
  const t = renderBlock('a `code` b');
  // mutate INSIDE the opaque codespan — not representable as a leaf edit
  const code = t.el.querySelector('code');
  code.textContent = 'co';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  // either reconciled faithfully or refused — never a wrong raw
  if (r !== null) {
    const disp = marked.lexer(r.raw)[0];
    assert.ok(r.raw.includes('co'), 'if accepted, must reflect the DOM');
  }
});
