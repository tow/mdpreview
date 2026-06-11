import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { core, marked } from './_setup.mjs';

// THE editor invariant, fuzzed.
//
// The editor keeps two representations of the document: the rendered DOM the
// user edits, and the markdown source that saves, undo, and re-renders are
// built from. Every bug of the "deleted text comes back" family is the same
// defect: a DOM state the fold-back machinery couldn't represent, kept
// silently, then clobbered by the next render-from-source.
//
// So the property under test is convergence itself, not any specific key
// sequence: after ANY sequence of editing events, flushing the DOM into the
// source and re-reading the source must reproduce exactly the text the DOM
// shows. We drive randomized action sequences (seeded, reproducible) through
// the same beforeinput/keydown entry points WKWebView uses, emulate the
// browser's default mutations for whatever the handlers don't intercept, and
// assert convergence after every single step.

const here = dirname(fileURLToPath(import.meta.url));
const templateHtml = readFileSync(join(here, '../MarkdownPreview/Resources/template.html'), 'utf8');
const scriptSrc = (templateHtml.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, ''))
  .find((s) => s.includes('marked.use'));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const irange = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// --- random documents -------------------------------------------------------
function genInline(rnd) {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'fox'];
  const bits = [];
  for (let i = 0, n = irange(rnd, 1, 4); i < n; i++) {
    const w = pick(rnd, words);
    bits.push(pick(rnd, [w, w, w, `**${w}**`, `*${w}*`, '`' + w + '`']));
  }
  return bits.join(' ');
}
function genBlock(rnd) {
  switch (irange(rnd, 1, 4)) {
    case 1: return '#'.repeat(irange(rnd, 1, 3)) + ' ' + genInline(rnd);
    case 2: case 3: return genInline(rnd);
    case 4: {
      const items = [];
      for (let i = 0, n = irange(rnd, 2, 4); i < n; i++) {
        items.push((rnd() < 0.25 && i > 0 ? '  - ' : '- ') + genInline(rnd));
      }
      return items.join('\n');
    }
  }
}
function genDoc(rnd) {
  const blocks = [];
  for (let i = 0, n = irange(rnd, 2, 4); i < n; i++) blocks.push(genBlock(rnd));
  return blocks.join('\n\n') + '\n';
}

// --- page under test --------------------------------------------------------
async function setup(md) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="content" class="markdown-body"></div></body>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.EditorCore = core; win.marked = marked;
  win.hljs = { highlightElement() {} };
  win.mermaid = { initialize() {}, parse() { return Promise.resolve(true); }, render() { return Promise.resolve({ svg: '' }); } };
  win.Paged = { Previewer: function () { this.preview = () => Promise.resolve({}); } };
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  win.scrollTo = () => {};
  win.webkit = { messageHandlers: { documentEdited: { postMessage() {} }, paginationDone: { postMessage() {} } } };
  win.eval(scriptSrc);
  win._rawMarkdown = md; win._baseMarkdown = md;
  await win.renderReading();
  return { win, doc: win.document };
}

const editableTextNodes = (t) => {
  const out = [];
  for (const div of t.doc.querySelectorAll('[data-seg][contenteditable="true"]')) {
    const w = t.doc.createTreeWalker(div, t.win.NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) { if (n.textContent.length) out.push(n); }
  }
  return out;
};

function setCaret(t, node, offset) {
  const sel = t.win.getSelection(), r = t.doc.createRange();
  r.setStart(node, offset); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
}
function setRange(t, n1, o1, n2, o2) {
  const r = t.doc.createRange();
  try { r.setStart(n1, o1); r.setEnd(n2, o2); } catch { return null; }
  if (r.collapsed) return null;
  const sel = t.win.getSelection();
  sel.removeAllRanges(); sel.addRange(r);
  return r;
}
function fire(t, type, init) {
  const sel = t.win.getSelection();
  if (!sel.rangeCount) return true;
  const anchor = sel.anchorNode;
  const el = anchor.nodeType === 1 ? anchor : anchor.parentNode;
  const Ev = type === 'keydown' ? t.win.KeyboardEvent : t.win.InputEvent;
  const ev = new Ev(type, { ...init, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

// --- the random actions -----------------------------------------------------
// Each returns a short transcript string (for failure reports) or null if it
// couldn't apply (no-op this round).
const ACTIONS = [
  function typeChar(t, rnd) {
    const nodes = editableTextNodes(t);
    if (!nodes.length) return null;
    const n = pick(rnd, nodes), off = irange(rnd, 0, n.textContent.length);
    const ch = pick(rnd, ['x', 'q', ' ', '9']);
    setCaret(t, n, off);
    if (!fire(t, 'beforeinput', { inputType: 'insertText', data: ch })) n.insertData(off, ch);
    return `type ${JSON.stringify(ch)} @ ${JSON.stringify(n.textContent.slice(0, 12))}+${off}`;
  },
  function backspace(t, rnd) {
    const nodes = editableTextNodes(t);
    if (!nodes.length) return null;
    const n = pick(rnd, nodes), off = irange(rnd, 0, n.textContent.length);
    setCaret(t, n, off);
    if (!fire(t, 'beforeinput', { inputType: 'deleteContentBackward' })) {
      if (off > 0) n.deleteData(off - 1, 1);
      // at a text-node boundary inside a block the browser eats the previous
      // node's last char; emulating exactly is fiddly — skip, handlers own it
    }
    return `backspace @ ${JSON.stringify(n.textContent.slice(0, 12))}+${off}`;
  },
  function selectDelete(t, rnd) {
    const nodes = editableTextNodes(t);
    if (nodes.length < 1) return null;
    const a = pick(rnd, nodes), b = pick(rnd, nodes);
    const [n1, n2] = a === b || a.compareDocumentPosition(b) & 4 ? [a, b] : [b, a];
    const o1 = irange(rnd, 0, n1.textContent.length);
    const o2 = n1 === n2 ? irange(rnd, o1, n2.textContent.length) : irange(rnd, 0, n2.textContent.length);
    const r = setRange(t, n1, o1, n2, o2);
    if (!r) return null;
    const desc = `selectDelete ${JSON.stringify(r.toString().slice(0, 24))}`;
    if (!fire(t, 'beforeinput', { inputType: 'deleteContentBackward' })) r.deleteContents();
    return desc;
  },
  function selectType(t, rnd) {
    const nodes = editableTextNodes(t);
    if (nodes.length < 1) return null;
    const a = pick(rnd, nodes), b = pick(rnd, nodes);
    const [n1, n2] = a === b || a.compareDocumentPosition(b) & 4 ? [a, b] : [b, a];
    const o1 = irange(rnd, 0, n1.textContent.length);
    const o2 = n1 === n2 ? irange(rnd, o1, n2.textContent.length) : irange(rnd, 0, n2.textContent.length);
    const r = setRange(t, n1, o1, n2, o2);
    if (!r) return null;
    const desc = `selectType over ${JSON.stringify(r.toString().slice(0, 24))}`;
    if (!fire(t, 'beforeinput', { inputType: 'insertText', data: 'Z' })) {
      r.deleteContents();
      const sel = t.win.getSelection();
      if (sel.rangeCount && sel.anchorNode.nodeType === 3) sel.anchorNode.insertData(sel.anchorOffset, 'Z');
    }
    return desc;
  },
  function pressReturn(t, rnd) {
    const nodes = editableTextNodes(t);
    if (!nodes.length) return null;
    const n = pick(rnd, nodes), off = irange(rnd, 0, n.textContent.length);
    setCaret(t, n, off);
    fire(t, 'beforeinput', { inputType: 'insertParagraph' }); // always handled
    return `return @ ${JSON.stringify(n.textContent.slice(0, 12))}+${off}`;
  },
  function emphasis(t, rnd) {
    const nodes = editableTextNodes(t);
    if (!nodes.length) return null;
    const n = pick(rnd, nodes);
    if (n.textContent.length < 2) return null;
    const o1 = irange(rnd, 0, n.textContent.length - 1);
    const o2 = irange(rnd, o1 + 1, n.textContent.length);
    if (!setRange(t, n, o1, n, o2)) return null;
    const key = pick(rnd, ['b', 'i']);
    fire(t, 'keydown', { key, metaKey: true });
    return `cmd+${key} on ${JSON.stringify(n.textContent.slice(o1, o2))}`;
  },
  function tabIndent(t, rnd) {
    const nodes = editableTextNodes(t);
    if (!nodes.length) return null;
    const n = pick(rnd, nodes);
    setCaret(t, n, 0);
    fire(t, 'keydown', { key: 'Tab', shiftKey: rnd() < 0.4 });
    return `tab @ ${JSON.stringify(n.textContent.slice(0, 12))}`;
  },
  function undoRedo(t, rnd) {
    const shift = rnd() < 0.3;
    fire(t, 'keydown', { key: 'z', metaKey: true, shiftKey: shift });
    return shift ? 'redo' : 'undo';
  },
];

// Display text the source should produce — rendered exactly the way the
// editor renders blocks.
function sourceDisplay(t) {
  let out = '';
  for (const seg of t.win._segments) {
    if (seg.type === 'space' || seg.transient) continue;
    const scratch = t.doc.createElement('div');
    scratch.innerHTML = marked.parse(seg.raw);
    core.stripStructuralWhitespace(scratch);
    out += scratch.textContent.replace(/\n+$/, '');
  }
  return out;
}
function domDisplay(t) {
  let out = '';
  for (const div of t.doc.querySelectorAll('#content [data-seg]')) {
    out += div.textContent.replace(/\n+$/, '');
  }
  return out;
}

// Formatting must converge too, not just text: a deletion can leave a zombie
// <em>/<strong> in the DOM that the source no longer has, silently formatting
// whatever is typed into it (and making Cmd+I act on the wrong model).
const SKEL_TAGS = 'strong,em,a,code,del';
function skeleton(root) {
  return Array.from(root.querySelectorAll(SKEL_TAGS))
    .filter((n) => n.textContent.length) // empty zombies render as nothing
    .map((n) => n.tagName + ':' + n.textContent).join('|');
}
function sourceSkeleton(t) {
  const parts = [];
  for (const seg of t.win._segments) {
    if (seg.type === 'space' || seg.transient) continue;
    const scratch = t.doc.createElement('div');
    scratch.innerHTML = marked.parse(seg.raw);
    core.stripStructuralWhitespace(scratch);
    parts.push(skeleton(scratch));
  }
  return parts.filter(Boolean).join('|');
}
function domSkeleton(t) {
  const parts = [];
  for (const div of t.doc.querySelectorAll('#content [data-seg]')) parts.push(skeleton(div));
  return parts.filter(Boolean).join('|');
}

const RUNS = parseInt(process.env.FUZZ_RUNS || '40', 10);
const STEPS = 25;

for (let seed = 1; seed <= RUNS; seed++) {
  test(`editing convergence, seed ${seed}`, async () => {
    const rnd = mulberry32(seed * 2654435761);
    const docMd = genDoc(rnd);
    const t = await setup(docMd);
    const transcript = [`doc: ${JSON.stringify(docMd)}`];
    for (let step = 0; step < STEPS; step++) {
      const desc = pick(rnd, ACTIONS)(t, rnd);
      if (!desc) continue;
      transcript.push(`${step}: ${desc}`);
      // Source must capture the DOM at save time, byte-for-byte in display text.
      t.win.saveNow();
      const fromSource = sourceDisplay(t) + ' ## ' + sourceSkeleton(t);
      const fromDom = domDisplay(t) + ' ## ' + domSkeleton(t);
      if (fromSource !== fromDom) {
        assert.fail(
          `DIVERGED after step ${step} (seed ${seed})\n` +
          transcript.join('\n') +
          `\nsource shows: ${JSON.stringify(fromSource)}` +
          `\nDOM shows:    ${JSON.stringify(fromDom)}` +
          `\nmarkdown:     ${JSON.stringify(t.win.currentMarkdown())}` +
          `\neditor log:\n${t.win.dumpEditorLog().split('\n').slice(-15).join('\n')}`
        );
      }
    }
  });
}
