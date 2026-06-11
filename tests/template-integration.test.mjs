import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { core, marked } from './_setup.mjs';

// Integration tests for the editing handlers that live in template.html. We
// load the page's inline editing script into jsdom with the real EditorCore +
// marked, then drive list edits the way WKWebView would: place a caret and
// dispatch the same beforeinput / keydown events the app handles. Structural
// ops preventDefault and re-render synchronously, so we can read the resulting
// document straight back out of currentMarkdown().

const here = dirname(fileURLToPath(import.meta.url));
const templateHtml = readFileSync(join(here, '../MarkdownPreview/Resources/template.html'), 'utf8');
// The big inline script (the one that calls marked.use).
const scriptSrc = (templateHtml.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, ''))
  .find((s) => s.includes('marked.use'));

async function setup(md) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="content" class="markdown-body"></div></body>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.EditorCore = core;
  win.marked = marked;
  win.hljs = { highlightElement() {} };
  win.mermaid = { initialize() {}, parse() { return Promise.resolve(true); }, render() { return Promise.resolve({ svg: '' }); } };
  win.Paged = { Previewer: function () { this.preview = () => Promise.resolve({}); } };
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  win.scrollTo = () => {};
  let saved = null;
  win.webkit = { messageHandlers: { documentEdited: { postMessage(m) { saved = m; } }, paginationDone: { postMessage() {} } } };
  win.eval(scriptSrc);
  win._rawMarkdown = md;
  win._baseMarkdown = md;
  await win.renderReading(); // await so editing listeners (bound after the await) are live
  return {
    win, doc: win.document,
    seg: () => win.document.querySelector('#content [data-seg]'),
    md: () => win.currentMarkdown(),
    saved: () => saved,
  };
}

// Place a collapsed caret. `where` is { text, at } (in a text node containing
// `text`, at char offset `at`) or { liEmpty:n } (in the n-th empty <li>).
function caret(win, where) {
  const doc = win.document, sel = win.getSelection(), r = doc.createRange();
  if (where.liEmpty != null) {
    const li = Array.from(doc.querySelectorAll('li')).filter((e) => e.textContent === '')[where.liEmpty];
    r.setStart(li, 0);
  } else {
    const walk = doc.createTreeWalker(doc.getElementById('content'), win.NodeFilter.SHOW_TEXT);
    let n, node = null;
    while ((n = walk.nextNode())) { if (n.textContent.includes(where.text)) { node = n; break; } }
    r.setStart(node, where.at);
  }
  r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
}

function beforeInput(win, inputType, data) {
  const ev = new win.InputEvent('beforeinput', { inputType, data: data ?? null, bubbles: true, cancelable: true });
  win.getSelection().anchorNode.parentNode.dispatchEvent(ev);
}
function pressTab(win, shift) {
  const ev = new win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true });
  (win.getSelection().anchorNode.nodeType === 1 ? win.getSelection().anchorNode : win.getSelection().anchorNode.parentNode)
    .dispatchEvent(ev);
}

test('Return at the end of a list item creates a new item', async () => {
  const t = await setup('- one\n- two\n');
  caret(t.win, { text: 'two', at: 3 }); // end of "two"
  beforeInput(t.win, 'insertParagraph');
  assert.equal(t.md(), '- one\n- two\n-'); // bare-bullet empty item (renders 3 bullets)
});

test('Backspace at the start of an item merges it into the previous one', async () => {
  const t = await setup('- one\n- two\n');
  caret(t.win, { text: 'two', at: 0 });
  beforeInput(t.win, 'deleteContentBackward');
  assert.equal(t.md(), '- onetwo\n');
});

test('Backspace at the start of the first item outdents it to a paragraph', async () => {
  const t = await setup('- one\n- two\n');
  caret(t.win, { text: 'one', at: 0 });
  beforeInput(t.win, 'deleteContentBackward');
  assert.equal(t.md(), 'one\n\n- two\n');
});

test('Tab nests a list item; Shift+Tab unnests it', async () => {
  const t = await setup('- one\n- two\n');
  caret(t.win, { text: 'two', at: 1 });
  pressTab(t.win, false);
  assert.equal(t.md(), '- one\n  - two\n');
  caret(t.win, { text: 'two', at: 1 });
  pressTab(t.win, true);
  assert.equal(t.md(), '- one\n- two\n');
});

test('Return on an empty item exits the list (empty bullet dropped)', async () => {
  const t = await setup('- one\n- \n');
  caret(t.win, { liEmpty: 0 }); // the empty second item
  beforeInput(t.win, 'insertParagraph');
  // The empty bullet is gone; a transient blank line holds the caret.
  assert.equal(t.md(), '- one');
});

test('typing into a freshly created empty item folds into the list', async () => {
  const t = await setup('- one\n- two\n');
  caret(t.win, { text: 'two', at: 3 });
  beforeInput(t.win, 'insertParagraph'); // -> "- one\n- two\n- \n", caret in empty item
  beforeInput(t.win, 'insertText', 'x');
  assert.equal(t.md(), '- one\n- two\n- x');
});

test('Enter then Tab at the end of the last item nests it without a heading', async () => {
  const t = await setup('- one\n- two\n\nAfter.\n');
  caret(t.win, { text: 'two', at: 3 });   // end of last item
  beforeInput(t.win, 'insertParagraph');  // new empty item
  pressTab(t.win, false);                 // nest it
  const md = t.md();
  assert.equal(md, '- one\n- two\n  *\n\nAfter.\n');
  assert.ok(!/<h[1-6]/.test(marked.parse(md)), '"After." must not become a heading');
});

test('Exiting a list keeps the blank line before a following paragraph', async () => {
  const t = await setup('- a\n- b\n\nAfter.\n');
  caret(t.win, { text: 'b', at: 1 });      // end of last item
  beforeInput(t.win, 'insertParagraph');   // new empty item
  beforeInput(t.win, 'insertParagraph');   // Return on empty item -> exit
  const md = t.md();
  assert.equal(md, '- a\n- b\n\nAfter.\n');  // separator preserved, empty item dropped
  const html = marked.parse(md);
  assert.ok(/<p>After\.<\/p>/.test(html), '"After." must stay its own paragraph');
});

test('typing more chars in a nested item then Return keeps all the text', async () => {
  const t = await setup('- one\n  * x');   // a realized nested sub-item "x"
  // The browser inserts "yz" into the <li> (jsdom does not, so set it directly).
  const lis = t.doc.querySelectorAll('li');
  const nested = lis[lis.length - 1];
  nested.firstChild.textContent = 'xyz';
  const r = t.doc.createRange(); r.setStart(nested.firstChild, 3); r.collapse(true);
  const sel = t.win.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  nested.dispatchEvent(new t.win.InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }));
  assert.equal(t.md(), '- one\n  * xyz\n  *'); // all of "xyz" kept, new sub-item added
});

test('Tab on a blank line starts a new list', async () => {
  const t = await setup('hello\n');
  caret(t.win, { text: 'hello', at: 5 });
  beforeInput(t.win, 'insertParagraph'); // end of paragraph -> transient blank line
  pressTab(t.win, false);                // -> new list
  beforeInput(t.win, 'insertText', 'x');
  assert.equal(t.md(), 'hello\n\n- x\n');
});

// Select `text` (within a single text node) and press a Cmd+key shortcut the
// way onKeydown receives it from WKWebView.
function selectAndPressCmd(win, text, key) {
  const doc = win.document, sel = win.getSelection(), r = doc.createRange();
  const walk = doc.createTreeWalker(doc.getElementById('content'), win.NodeFilter.SHOW_TEXT);
  let n, node = null;
  while ((n = walk.nextNode())) { if (n.textContent.includes(text)) { node = n; break; } }
  const i = node.textContent.indexOf(text);
  r.setStart(node, i); r.setEnd(node, i + text.length);
  sel.removeAllRanges(); sel.addRange(r);
  const ev = new win.KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true });
  win.getSelection().anchorNode.parentNode.dispatchEvent(ev);
}

// Select from the text node containing `fromText` to the one containing
// `toText` (whole-node endpoints), dispatch the delete beforeinput, and — when
// the handler doesn't claim it — mutate the DOM the way the browser would.
function selectAndDelete(t, fromText, toText) {
  const doc = t.win.document, sel = t.win.getSelection(), r = doc.createRange();
  const walk = doc.createTreeWalker(doc.getElementById('content'), t.win.NodeFilter.SHOW_TEXT);
  let n, a = null, b = null;
  while ((n = walk.nextNode())) {
    if (!a && n.textContent.includes(fromText)) a = n;
    if (n.textContent.includes(toText)) b = n;
  }
  r.setStart(a, a.textContent.indexOf(fromText));
  r.setEnd(b, b.textContent.indexOf(toText) + toText.length);
  sel.removeAllRanges(); sel.addRange(r);
  const ev = new t.win.InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true });
  (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode).dispatchEvent(ev);
  if (!ev.defaultPrevented) r.deleteContents();
}

test('deleting a whole list section then Return does not resurrect it', async () => {
  const t = await setup('## Heading\n\n- one\n- two\n- three\n');
  selectAndDelete(t, 'one', 'three');
  beforeInput(t.win, 'insertParagraph');
  assert.ok(!t.md().includes('two'), 'deleted items resurrected in source: ' + JSON.stringify(t.md()));
  assert.ok(!t.doc.getElementById('content').textContent.includes('two'),
    'deleted items resurrected in DOM');
  assert.ok(t.md().includes('## Heading'), 'heading must survive');
});

test('a multi-leaf deletion then Cmd+I elsewhere keeps both edits', async () => {
  const t = await setup('keep **gone** also\n\nhello world\n');
  selectAndDelete(t, 'gone', 'gone'); // deletes the whole bold run's text
  selectAndPressCmd(t.win, 'world', 'i');
  assert.ok(!t.md().includes('gone'), 'deleted text resurrected: ' + JSON.stringify(t.md()));
  assert.ok(t.md().includes('*world*'), 'italic lost: ' + JSON.stringify(t.md()));
});

test('a selection spanning two blocks deletes across them', async () => {
  const t = await setup('alpha bravo\n\ncharlie delta\n');
  selectAndDelete(t, 'bravo', 'charlie');
  assert.equal(t.md(), 'alpha  delta\n');
});

test('Cmd+B then Cmd+I on the same word stacks bold and italic', async () => {
  const t = await setup('hello world\n');
  selectAndPressCmd(t.win, 'world', 'b');
  assert.equal(t.md(), 'hello **world**\n');
  // doEmphasis restores the selection over "world" inside the bold run
  selectAndPressCmd(t.win, 'world', 'i');
  assert.equal(t.md(), 'hello ***world***\n');
});
