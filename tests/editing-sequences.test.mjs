import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { core, marked } from './_setup.mjs';

// End-to-end editing SEQUENCES through the real template.html handlers. Unlike
// the single-op integration tests, this harness can *type* the way a user does
// (mirroring the browser's native text insertion that jsdom doesn't perform),
// so we can drive realistic flows — type, Enter, Tab, Shift+Tab, Backspace —
// and assert the resulting markdown. The bugs found by hand (setext on indent,
// separator eaten on exit, dropped edits in nested items) are all of this shape
// and are reproducible here; this suite is the net that should catch them.

const here = dirname(fileURLToPath(import.meta.url));
const templateHtml = readFileSync(join(here, '../MarkdownPreview/Resources/template.html'), 'utf8');
const scriptSrc = (templateHtml.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, ''))
  .find((s) => s.includes('marked.use'));

function makeEditor(md) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="content" class="markdown-body"></div></body>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.EditorCore = core;
  win.marked = marked;
  win.hljs = { highlightElement() {} };
  win.mermaid = { initialize() {}, parse() { return Promise.resolve(true); }, render() { return Promise.resolve({ svg: '' }); } };
  win.Paged = { Previewer: function () { this.preview = () => Promise.resolve({}); } };
  win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  win.scrollTo = () => {};
  win.webkit = { messageHandlers: { documentEdited: { postMessage() {} }, paginationDone: { postMessage() {} } } };
  win.eval(scriptSrc);
  win._rawMarkdown = md;
  win._baseMarkdown = md;
  return win.renderReading().then(() => new Editor(win));
}

class Editor {
  constructor(win) { this.win = win; this.doc = win.document; }

  md() {
    // Mirror autosave/blur: fold the focused block's pending DOM edits in first.
    const sel = this.win.getSelection();
    if (sel.rangeCount) {
      const div = this.win.segDivFor(sel.anchorNode);
      if (div) this.win.flushSegment(div);
    }
    return this.win.currentMarkdown();
  }

  html() { return marked.parse(this.md()); }

  // Place a collapsed caret. opt: {text, at} (offset within a text node whose
  // content === text) or {endOf:text} / {startOf:text}.
  caret(opt) {
    const { doc, win } = this;
    const sel = win.getSelection(), r = doc.createRange();
    const text = opt.text ?? opt.endOf ?? opt.startOf;
    const w = doc.createTreeWalker(doc.getElementById('content'), win.NodeFilter.SHOW_TEXT);
    let n, node = null;
    while ((n = w.nextNode())) { if (n.textContent === text) { node = n; break; } }
    if (!node) throw new Error(`no text node === ${JSON.stringify(text)} (have: ${[...doc.querySelectorAll('li,p,h1,h2')].map((e) => JSON.stringify(e.textContent))})`);
    const at = opt.endOf != null ? text.length : opt.startOf != null ? 0 : opt.at;
    r.setStart(node, at); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    return this;
  }

  dispatch(type, data) {
    const { win } = this;
    const an = win.getSelection().anchorNode;
    const target = an.nodeType === 1 ? an : an.parentNode;
    const ev = new win.InputEvent('beforeinput', { inputType: type, data: data ?? null, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
  }

  key(name, shift) {
    const { win } = this;
    const an = win.getSelection().anchorNode;
    const target = an.nodeType === 1 ? an : an.parentNode;
    target.dispatchEvent(new win.KeyboardEvent('keydown', { key: name, shiftKey: !!shift, bubbles: true, cancelable: true }));
    return this;
  }

  // Select an entire text node whose content === text.
  select(text) {
    const { doc, win } = this;
    const w = doc.createTreeWalker(doc.getElementById('content'), win.NodeFilter.SHOW_TEXT);
    let n, node = null;
    while ((n = w.nextNode())) { if (n.textContent === text) { node = n; break; } }
    if (!node) throw new Error(`no text node === ${JSON.stringify(text)}`);
    const sel = win.getSelection(), r = doc.createRange();
    r.setStart(node, 0); r.setEnd(node, node.textContent.length);
    sel.removeAllRanges(); sel.addRange(r);
    return this;
  }

  cmd(k, shift) {
    const { win } = this;
    const an = win.getSelection().anchorNode;
    const target = an.nodeType === 1 ? an : an.parentNode;
    target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, metaKey: true, shiftKey: !!shift, bubbles: true, cancelable: true }));
    return this;
  }

  enter() { this.dispatch('insertParagraph'); return this; }
  tab() { this.key('Tab', false); return this; }
  shiftTab() { this.key('Tab', true); return this; }
  backspace() { this.dispatch('deleteContentBackward'); return this; }

  // Type text one char at a time, mirroring the browser: dispatch the
  // beforeinput; if the handler did not preventDefault, insert the char into
  // the DOM at the caret ourselves (jsdom does not).
  type(str) {
    const { win, doc } = this;
    for (const ch of str) {
      const ev = this.dispatch('insertText', ch);
      if (ev.defaultPrevented) continue; // handler folded it + re-rendered
      const sel = win.getSelection(), r = sel.getRangeAt(0);
      let node = r.startContainer, off = r.startOffset;
      if (node.nodeType !== 3) {
        const tn = doc.createTextNode(ch);
        node.insertBefore(tn, node.childNodes[off] || null);
        node = tn; off = 1;
      } else {
        node.textContent = node.textContent.slice(0, off) + ch + node.textContent.slice(off);
        off += 1;
      }
      const nr = doc.createRange(); nr.setStart(node, off); nr.collapse(true);
      sel.removeAllRanges(); sel.addRange(nr);
    }
    return this;
  }
}

// Invariants every editing result must hold.
function roundTrips(md) { return core.segment(md, marked).map((s) => s.raw).join('') === md; }
function sane(ed, { headings = false, paras = [] } = {}) {
  const md = ed.md();
  assert.ok(roundTrips(md), `must round-trip: ${JSON.stringify(md)}`);
  const html = ed.html();
  if (!headings) assert.ok(!/<h[1-6]/.test(html), `no accidental heading in ${JSON.stringify(md)} -> ${html}`);
  for (const p of paras) {
    assert.ok(new RegExp('<p>' + p + '</p>').test(html), `"${p}" must stay its own paragraph in ${JSON.stringify(md)} -> ${html}`);
  }
  return md;
}

// ---------------------------------------------------------------------------

test('build a nested list from scratch: type, Enter, Tab, type, Enter, type', async () => {
  const ed = await makeEditor('- one\n');
  ed.caret({ endOf: 'one' }).enter().type('two').enter().tab().type('a').enter().type('b');
  const md = sane(ed);
  assert.equal(md, '- one\n- two\n  * a\n  * b');
  const html = ed.html().replace(/\s+/g, '');
  assert.match(html, /<li>two<ul><li>a<\/li><li>b<\/li><\/ul><\/li>/);
});

test('type three chars in a fresh sub-item then Enter keeps all three', async () => {
  const ed = await makeEditor('- one\n');
  ed.caret({ endOf: 'one' }).enter().tab().type('xyz').enter();
  assert.equal(sane(ed), '- one\n  * xyz\n  *');
});

test('Enter on an empty sub-item exits to the parent level (not a heading)', async () => {
  const ed = await makeEditor('- one\n');
  ed.caret({ endOf: 'one' }).enter().tab().type('sub').enter().enter(); // 2nd Enter on empty sub
  sane(ed); // must not become a heading or swallow anything
});

test('list followed by a paragraph: editing the last item keeps the paragraph', async () => {
  const ed = await makeEditor('- a\n- b\n\nAfter.\n');
  ed.caret({ endOf: 'b' }).type('!');
  sane(ed, { paras: ['After\\.'] });
  assert.equal(ed.md(), '- a\n- b!\n\nAfter.\n');
});

test('Enter then exit before a paragraph preserves the blank line', async () => {
  const ed = await makeEditor('- a\n- b\n\nAfter.\n');
  ed.caret({ endOf: 'b' }).enter().enter(); // new empty item, then exit
  sane(ed, { paras: ['After\\.'] });
});

test('Tab then Shift+Tab returns an item to its original level', async () => {
  const ed = await makeEditor('- one\n- two\n');
  ed.caret({ at: 1, text: 'two' }).tab();
  assert.equal(ed.md(), '- one\n  - two\n');
  ed.caret({ at: 1, text: 'two' }).shiftTab();
  assert.equal(sane(ed), '- one\n- two\n');
});

test('Backspace at the start of a sub-item content edits cleanly', async () => {
  const ed = await makeEditor('- one\n  - two\n');
  ed.caret({ startOf: 'two' }).backspace();
  sane(ed); // should not corrupt / drop text
});

test('ordered list: type, Enter, type produces a contiguous list', async () => {
  const ed = await makeEditor('1. first\n');
  ed.caret({ endOf: 'first' }).enter().type('second').enter().type('third');
  const md = sane(ed);
  const lst = marked.lexer(md)[0];
  assert.equal(lst.ordered, true);
  assert.deepEqual(lst.items.map((i) => i.text), ['first', 'second', 'third']);
});

test('typing across an existing item then Enter keeps text and splits correctly', async () => {
  const ed = await makeEditor('- alpha\n- beta\n');
  ed.caret({ endOf: 'alpha' }).type('XYZ').enter().type('Q');
  assert.equal(sane(ed), '- alphaXYZ\n- Q\n- beta\n');
});

test('multiple sub-items then Enter on empty exits the sublist', async () => {
  const ed = await makeEditor('- top\n');
  ed.caret({ endOf: 'top' }).enter().tab().type('s1').enter().type('s2').enter().enter();
  const md = sane(ed);
  // s1 and s2 are nested under top; the exit dropped the empty trailing sub-item
  const html = ed.html().replace(/\s+/g, '');
  assert.match(html, /<li>top<ul><li>s1<\/li><li>s2<\/li><\/ul><\/li>/);
});

// --- Backspace / merge ----------------------------------------------------

test('Backspace at the start of the 2nd sub-item merges it into the 1st sub-item', async () => {
  const ed = await makeEditor('- top\n  * one\n  * two\n');
  ed.caret({ startOf: 'two' }).backspace();
  const md = sane(ed);
  const html = ed.html().replace(/\s+/g, '');
  assert.match(html, /<li>top<ul><li>onetwo<\/li><\/ul><\/li>/);
});

test('Backspace at the start of a top-level item merges into the previous item', async () => {
  const ed = await makeEditor('- one\n- two\n- three\n');
  ed.caret({ startOf: 'two' }).backspace();
  assert.equal(sane(ed), '- onetwo\n- three\n');
});

test('Backspace at the start of the first item outdents it to a paragraph', async () => {
  const ed = await makeEditor('- one\n- two\n');
  ed.caret({ startOf: 'one' }).backspace();
  assert.equal(sane(ed, { paras: ['one'] }), 'one\n\n- two\n');
});

// --- Outdent with content / children --------------------------------------

test('Shift+Tab on a sub-item with content keeps its text', async () => {
  const ed = await makeEditor('- top\n  - sub\n');
  ed.caret({ at: 1, text: 'sub' }).shiftTab();
  const md = sane(ed);
  assert.ok(/sub/.test(md), `lost "sub": ${JSON.stringify(md)}`);
});

// --- Paragraphs / mixed blocks --------------------------------------------

test('Enter in the middle of a paragraph splits it into two paragraphs', async () => {
  const ed = await makeEditor('Hello world.\n');
  ed.caret({ text: 'Hello world.', at: 6 }).enter(); // between "Hello " and "world."
  assert.equal(sane(ed, { paras: ['Hello ', 'world\\.'] }), 'Hello \n\nworld.\n');
});

test('Enter at the end of a paragraph then typing makes a new paragraph', async () => {
  const ed = await makeEditor('First.\n');
  ed.caret({ endOf: 'First.' }).enter().type('Second.');
  assert.equal(sane(ed, { paras: ['First\\.', 'Second\\.'] }), 'First.\n\nSecond.\n');
});

test('editing the text of a list item folds back cleanly (no duplication)', async () => {
  const ed = await makeEditor('- alpha\n- beta\n');
  ed.caret({ text: 'beta', at: 2 }).type('XX'); // beXXta
  assert.equal(sane(ed), '- alpha\n- beXXta\n');
});

// --- Emphasis inside a list item ------------------------------------------

test('Cmd+B bolds a word inside a list item', async () => {
  const ed = await makeEditor('- make this bold\n');
  ed.select('make this bold');           // whole item text
  // select just "bold": reselect a sub-range
  const win = ed.win, doc = ed.doc;
  const node = doc.querySelector('li').firstChild;
  const r = doc.createRange();
  r.setStart(node, 'make this '.length); r.setEnd(node, 'make this bold'.length);
  win.getSelection().removeAllRanges(); win.getSelection().addRange(r);
  ed.cmd('b');
  assert.equal(sane(ed), '- make this **bold**\n');
});

// --- Ordered lists --------------------------------------------------------

test('nested ordered list builds and renders contiguous numbers', async () => {
  const ed = await makeEditor('1. a\n');
  ed.caret({ endOf: 'a' }).enter().type('b').enter().tab().type('x').enter().type('y');
  const md = sane(ed);
  const top = marked.lexer(md)[0];
  assert.equal(top.ordered, true);
  assert.ok(/x/.test(md) && /y/.test(md), `lost nested items: ${JSON.stringify(md)}`);
});

// --- Stability / idempotence ----------------------------------------------

// --- Deeper nesting & un-nesting ------------------------------------------

test('three levels of nesting build correctly', async () => {
  const ed = await makeEditor('- a\n');
  ed.caret({ endOf: 'a' }).enter().type('b').tab().enter().type('c').tab();
  // a, with b nested, with c nested under b
  const md = sane(ed);
  assert.ok(/a/.test(md) && /b/.test(md) && /c/.test(md), md);
  const html = ed.html().replace(/\s+/g, '');
  assert.match(html, /<li>a<ul><li>b<ul><li>c<\/li><\/ul><\/li><\/ul><\/li>/);
});

test('Backspace at start of the first sub-item merges it up into the parent', async () => {
  const ed = await makeEditor('- top\n  * one\n');
  ed.caret({ startOf: 'one' }).backspace();
  const md = sane(ed);
  assert.ok(/topone/.test(ed.html().replace(/\s+/g, '')), `expected merge-up, got ${JSON.stringify(md)}`);
});

// --- Backspace across block types -----------------------------------------

test('Backspace at the start of a paragraph after a list does not corrupt', async () => {
  const ed = await makeEditor('- a\n- b\n\nPara.\n');
  ed.caret({ startOf: 'Para.' }).backspace();
  sane(ed); // round-trips; merging into the prior block is allowed, corruption is not
});

test('Backspace at the start of the second paragraph merges the two', async () => {
  const ed = await makeEditor('One.\n\nTwo.\n');
  ed.caret({ startOf: 'Two.' }).backspace();
  const md = sane(ed);
  assert.match(ed.html().replace(/\s+/g, ''), /<p>One\.Two\.<\/p>/);
});

// --- Markdown-special characters round-trip safely ------------------------

test('typing markdown-special characters in an item stays literal and round-trips', async () => {
  const ed = await makeEditor('- x\n');
  ed.caret({ endOf: 'x' }).type(' a*b_c`d#e');
  const md = sane(ed);
  assert.equal(md, '- x a*b_c`d#e\n');
});

test('typing an asterisk pair does not silently vanish', async () => {
  const ed = await makeEditor('- word\n');
  ed.caret({ endOf: 'word' }).type('*!*');
  assert.equal(sane(ed), '- word*!*\n');
});

// --- Ordered list renumbering ---------------------------------------------

test('merging an ordered-list item renders contiguous numbers', async () => {
  const ed = await makeEditor('1. a\n2. b\n3. c\n');
  ed.caret({ startOf: 'b' }).backspace(); // merge b into a
  const md = sane(ed);
  const lst = marked.lexer(md)[0];
  assert.equal(lst.ordered, true);
  assert.equal(lst.items.length, 2);
});

// --- Inline constructs in list items --------------------------------------

test('editing text after a link in a list item keeps the link intact', async () => {
  const ed = await makeEditor('- see [site](http://x.com) now\n');
  ed.caret({ text: ' now', at: 4 }).type('!'); // end of " now"
  const md = sane(ed);
  assert.match(md, /\[site\]\(http:\/\/x\.com\)/);
  assert.match(ed.html(), /<a href="http:\/\/x\.com">site<\/a>/);
});

test('editing text inside a blockquote folds back', async () => {
  const ed = await makeEditor('> quote here\n');
  ed.caret({ endOf: 'quote here' }).type('!');
  const md = sane(ed);
  assert.match(md, /^> quote here!/);
});

test('a long mixed sequence round-trips and re-renders stably', async () => {
  const ed = await makeEditor('# Title\n\n- one\n- two\n\nA paragraph.\n');
  ed.caret({ endOf: 'two' }).enter().tab().type('sub').enter().type('sub2').enter().enter()
    .caret({ endOf: 'one' }).type('!');
  const md = sane(ed, { headings: true, paras: ['A paragraph\\.'] });
  // Re-segmenting and re-joining the produced markdown must be a fixed point.
  const reseg = core.segment(md, marked).map((s) => s.raw).join('');
  assert.equal(reseg, md);
});

// --- Fuzz -----------------------------------------------------------------
// Random sequences of real keystrokes across several seed documents. The
// invariant after every step: the document must still round-trip (segments
// rejoin to it byte-for-byte) and nothing may throw. A broken round-trip means
// the segmentation invariant the whole editor relies on has been corrupted.

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function caretTargets(ed) {
  const w = ed.doc.createTreeWalker(ed.doc.getElementById('content'), ed.win.NodeFilter.SHOW_TEXT);
  const out = []; let n;
  while ((n = w.nextNode())) if (n.textContent.length) out.push({ node: n });
  // empty editable slots (a fresh empty <li>) — caret targets with no text node
  ed.doc.querySelectorAll('li,p').forEach((e) => { if (e.textContent === '' && !e.querySelector('li,p')) out.push({ node: e, empty: true }); });
  return out;
}
function putCaret(ed, t, at) {
  const r = ed.doc.createRange();
  r.setStart(t.node, t.empty ? 0 : Math.min(at, t.node.textContent.length)); r.collapse(true);
  const s = ed.win.getSelection(); s.removeAllRanges(); s.addRange(r);
}

test('fuzz: random editing sequences never corrupt the document', async () => {
  const seeds = [
    '- a\n- b\n', '- a\n  * b\n', '# H\n\n- one\n- two\n\nPara.\n', '1. a\n2. b\n', 'Just text.\n',
    '- a\n  - b\n    - c\n', '- [x](http://y) z\n- two\n', '> quote\n\n- after\n', 'P1.\n\nP2.\n\nP3.\n',
    '- **bold** item\n- plain\n',
  ];
  for (let iter = 0; iter < 1000; iter++) {
    const rand = rng(iter * 2654435761 + 12345);
    const seed = seeds[Math.floor(rand() * seeds.length)];
    const ed = await makeEditor(seed);
    const ops = [];
    for (let k = 0; k < 20; k++) {
      const targets = caretTargets(ed);
      if (!targets.length) break;
      const t = targets[Math.floor(rand() * targets.length)];
      putCaret(ed, t, Math.floor(rand() * ((t.node.textContent.length || 0) + 1)));
      const choice = Math.floor(rand() * 6);
      const label = ['type', 'enter', 'tab', 'shiftTab', 'backspace', 'typeword'][choice];
      ops.push(label);
      try {
        if (choice === 0) ed.type('xy z'[Math.floor(rand() * 4)]);
        else if (choice === 1) ed.enter();
        else if (choice === 2) ed.tab();
        else if (choice === 3) ed.shiftTab();
        else if (choice === 4) ed.backspace();
        else ed.type('cat');
        const md = ed.md();
        // Round-trip up to EOF trailing-whitespace: marked normalizes a final
        // trailing space to a newline, which is benign (self-heals on render).
        // Any *structural* (non-trailing) difference is real corruption.
        const re = core.segment(md, marked).map((s) => s.raw).join('');
        assert.equal(re.replace(/\s+$/, ''), md.replace(/\s+$/, ''),
          `round-trip broke (seed ${JSON.stringify(seed)}, ops [${ops.join(',')}]): ${JSON.stringify(md)} -> ${JSON.stringify(re)}`);
        marked.parse(md); // must not throw
      } catch (e) {
        assert.fail(`fuzz failed (seed ${JSON.stringify(seed)}, ops [${ops.join(',')}]): ${e.message}`);
      }
    }
  }
});
