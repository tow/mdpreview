/*
 * editor-core.js — pure markdown-editing transforms for MarkdownPreview.
 *
 * No DOM, no globals: every function takes a markdown string (and integer
 * source offsets) plus the `marked` module, and returns markdown (plus caret
 * offsets). This is the load-bearing logic, unit-tested under Node via
 * `node --test`. The browser loads this file with a <script> tag and reaches
 * the functions through `window.EditorCore`; the thin DOM adapter that maps
 * selections to source offsets lives separately.
 *
 * UMD wrapper so the same file works as a CommonJS module (Node tests) and as
 * a classic browser script (template.html).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EditorCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Block token types the user is allowed to edit in place. Everything else
  // (space separators, fenced/indented code, mermaid — which is a `code` token
  // with lang "mermaid" — html, hr) is rendered read-only and its source bytes
  // pass through verbatim.
  // Tables use a distinct token shape (.header/.rows) the leaf re-serializer
  // doesn't reconstruct, so they stay read-only for now (correct-but-limited).
  var EDITABLE_BLOCKS = { paragraph: true, heading: true, blockquote: true, list: true };

  function isEditableBlock(token) {
    return EDITABLE_BLOCKS[token.type] === true;
  }

  /**
   * Split markdown into top-level block segments. The invariant the rest of the
   * editor relies on: segs.map(s => s.raw).join('') === md, byte for byte.
   */
  function segment(md, marked) {
    var tokens = marked.lexer(md);
    return tokens.map(function (token, i) {
      return {
        index: i,
        type: token.type,
        raw: token.raw,
        token: token,
        editable: isEditableBlock(token),
      };
    });
  }

  // --- Re-serializer + leaf substitution -----------------------------------
  //
  // `edits` is a Map keyed by text-leaf token (object identity) → new text.
  // The DOM adapter builds this map by walking text nodes against the token
  // tree; the pure tests build it directly.

  function childrenOf(token) {
    if (token.tokens && token.tokens.length) return token.tokens;
    if (token.items && token.items.length) return token.items;
    return null;
  }

  function anyEdited(token, edits) {
    if (edits.has(token)) return true;
    var kids = childrenOf(token);
    if (!kids) return false;
    for (var i = 0; i < kids.length; i++) {
      if (anyEdited(kids[i], edits)) return true;
    }
    return false;
  }

  /**
   * Rebuild a token's markdown source. Untouched subtrees return token.raw
   * verbatim (so delimiters, escapes, entities, and unsupported constructs are
   * never disturbed). An edited subtree is rebuilt as open + children + close,
   * where the children's joined raw locates the affixes within token.raw.
   */
  function reserialize(token, edits) {
    edits = edits || new Map();
    var kids = childrenOf(token);
    if (!kids) {
      // Leaf. Only plain text leaves are substitutable; codespan/escape/etc.
      // are opaque and pass through.
      if (token.type === 'text' && edits.has(token)) return edits.get(token);
      return token.raw;
    }
    if (!anyEdited(token, edits)) return token.raw;
    // Locate each child's raw by forward search and keep the gaps between them
    // (list markers, nested indentation, open/close affixes) verbatim. A single
    // indexOf of the joined children fails for nested lists — marked strips a
    // nested block's leading indentation from its raw, so the concatenation
    // isn't a contiguous substring — which would silently drop the edit.
    var raw = token.raw, out = '', search = 0;
    for (var i = 0; i < kids.length; i++) {
      var idx = raw.indexOf(kids[i].raw, search);
      if (idx < 0) return token.raw; // can't locate — don't risk corruption
      out += raw.slice(search, idx) + reserialize(kids[i], edits);
      search = idx + kids[i].raw.length;
    }
    return out + raw.slice(search);
  }

  /**
   * Apply pure text-leaf edits to a segment's raw. Splices each edited leaf's
   * new text at its source span (from leafMap) — robust to nested lists, where
   * the tree-walking reserialize can't reconstruct deindented child raws.
   */
  function applyLeafEdits(segment, edits) {
    if (!edits || edits.size === 0) return segment.raw;
    var leaves = leafMap(segment.token), ops = [];
    for (var i = 0; i < leaves.length; i++) {
      if (leaves[i].type === 'text' && edits.has(leaves[i].token)) {
        ops.push({ start: leaves[i].rawStart, end: leaves[i].rawEnd, text: edits.get(leaves[i].token) });
      }
    }
    ops.sort(function (a, b) { return b.start - a.start; }); // right-to-left so offsets stay valid
    var raw = segment.raw;
    for (var j = 0; j < ops.length; j++) raw = raw.slice(0, ops[j].start) + ops[j].text + raw.slice(ops[j].end);
    return raw;
  }

  // --- Bold / italic toggle ------------------------------------------------

  function delimFor(kind) { return kind === 'strong' ? '**' : '*'; }

  function inlineLex(frag, marked) { return marked.Lexer.lexInline(frag); }

  // Does re-lexing `md` yield a `kind` token whose raw is exactly `raw`?
  function hasTokenRaw(md, raw, kind, marked) {
    var found = false;
    (function walk(ts) {
      for (var i = 0; i < ts.length; i++) {
        var t = ts[i];
        if (t.type === kind && t.raw === raw) found = true;
        if (t.tokens) walk(t.tokens);
      }
    })(inlineLex(md, marked));
    return found;
  }

  // Drop one level of same-kind emphasis inside an inline fragment, preserving
  // everything else (links, other-kind emphasis) verbatim.
  function stripSameKind(frag, kind, marked) {
    return inlineLex(frag, marked).map(function (t) {
      if (t.type === kind && t.tokens) return t.tokens.map(function (c) { return c.raw; }).join('');
      return t.raw;
    }).join('');
  }

  // Length of the contiguous '*' run ending just before / starting at offset i.
  function starsBefore(s, i) { var n = 0; while (i - n - 1 >= 0 && s[i - n - 1] === '*') n++; return n; }
  function starsAfter(s, i) { var n = 0; while (i + n < s.length && s[i + n] === '*') n++; return n; }

  // Does a '*' run of length n on each side of a range carry `kind`?
  // 1 = em, 2 = strong, 3 = em+strong — em needs an odd run, strong needs ≥ 2.
  // Without this, the inner '*' of a ** delimiter passes the em slice check and
  // Cmd+I on a bold word strips the bold instead of nesting italics.
  function runCarries(left, right, kind) {
    return kind === 'em' ? (left % 2 === 1 && right % 2 === 1) : (left >= 2 && right >= 2);
  }

  /**
   * Toggle bold/italic over a source range [start,end) within one block's
   * markdown. Returns { md, selStart, selEnd } or null if the wrap wouldn't
   * parse (e.g. wrapping whitespace). kind is 'strong' or 'em'.
   */
  function toggleEmphasis(s, start, end, kind, marked) {
    var d = delimFor(kind), dl = d.length;
    var L = starsBefore(s, start), R = starsAfter(s, end);

    // Unwrap: selection sits just inside the delimiters — **[sel]**
    if (runCarries(L, R, kind) && start >= dl && s.slice(start - dl, start) === d && s.slice(end, end + dl) === d) {
      return { md: s.slice(0, start - dl) + s.slice(start, end) + s.slice(end + dl), selStart: start - dl, selEnd: end - dl };
    }
    // Unwrap: selection includes the delimiters — [**sel**]
    if (runCarries(starsAfter(s, start), starsBefore(s, end), kind) &&
        end - start >= 2 * dl && s.slice(start, start + dl) === d && s.slice(end - dl, end) === d) {
      return { md: s.slice(0, start) + s.slice(start + dl, end - dl) + s.slice(end), selStart: start, selEnd: end - 2 * dl };
    }
    // Wrap: strip same-kind wrappers inside the selection, then wrap once.
    var stripped = stripSameKind(s.slice(start, end), kind, marked);
    var md = s.slice(0, start) + d + stripped + d + s.slice(end);
    // The kind token's raw may absorb an adjacent run (em inside ** lexes as
    // ***…***, raw spanning the whole run), so accept either form.
    var absorbed = s.slice(start - L, start) + d + stripped + d + s.slice(end, end + R);
    if (!hasTokenRaw(md, d + stripped + d, kind, marked) && !hasTokenRaw(md, absorbed, kind, marked)) return null;
    return { md: md, selStart: start + dl, selEnd: start + dl + stripped.length };
  }

  // --- Enter split / Backspace merge ---------------------------------------

  function wrapDelim(type) {
    return type === 'strong' ? '**' : type === 'del' ? '~~' : type === 'em' ? '*' : '';
  }

  // Split a token at a byte offset within its raw, returning { left, right }
  // markdown. Wrappers spanning the offset are closed on the left and reopened
  // on the right; plain text is sliced; opaque leaves go whole to one side.
  function splitToken(token, local) {
    var kids = token.tokens;
    if (!kids || !kids.length) {
      if (token.type === 'text') return { left: token.raw.slice(0, local), right: token.raw.slice(local) };
      return local > 0 ? { left: token.raw, right: '' } : { left: '', right: token.raw };
    }
    var d = wrapDelim(token.type), dl = d.length;
    var innerLen = kids.map(function (c) { return c.raw; }).join('').length;
    var innerLocal = local - dl;
    if (innerLocal <= 0) return { left: '', right: token.raw };
    if (innerLocal >= innerLen) return { left: token.raw, right: '' };
    var sp = splitTokenList(kids, innerLocal);
    return { left: d + sp.left + d, right: d + sp.right + d };
  }

  // Split a list of sibling tokens at a byte offset within their concatenated raw.
  function splitTokenList(kids, off) {
    var acc = 0, left = '', right = '';
    for (var i = 0; i < kids.length; i++) {
      var len = kids[i].raw.length;
      if (off >= acc + len) { left += kids[i].raw; }
      else if (off <= acc) { right += kids[i].raw; }
      else { var sp = splitToken(kids[i], off - acc); left += sp.left; right += sp.right; }
      acc += len;
    }
    return { left: left, right: right };
  }

  // --- List item structure -------------------------------------------------
  //
  // marked drops trailing whitespace from a trailing *empty* item's raw (the
  // last item of "- one\n- \n" has raw "-"), so item.raw lengths don't tile the
  // source exactly. We locate each item by forward search, detect empty items
  // from the source line, and handle indent/outdent line-based — all robust to
  // that quirk and to nesting.

  var LIST_MARKER = /^(\s*(?:[-*+]|\d+[.)])[ \t]?)/;       // marker incl one optional space
  var EMPTY_ITEM_LINE = /^\s*(?:[-*+]|\d+[.)])[ \t]*$/;     // a marker with no content
  var MARKER_LINE = /^\s*(?:[-*+]|\d+[.)])/;

  function itemMarker(raw) { var m = raw.match(LIST_MARKER); return m ? m[1] : ''; }
  function itemContent(raw) { return raw.slice(itemMarker(raw).length).replace(/\n+$/, ''); }

  // Absolute [start,end) of each top-level item within listMd.
  function itemSpans(listMd, items) {
    var spans = [], search = 0;
    for (var i = 0; i < items.length; i++) {
      var raw = items[i].raw;
      var start = listMd.indexOf(raw, search);
      if (start < 0) start = search;
      spans.push({ item: items[i], start: start, end: start + raw.length });
      search = start + raw.length;
    }
    return spans;
  }

  // Index of the (top-level) item the caret sits in: the last item that starts
  // at or before the offset.
  function itemAt(spans, offset) {
    var idx = 0;
    for (var i = 0; i < spans.length; i++) { if (spans[i].start <= offset) idx = i; }
    return idx;
  }

  function lineRange(md, offset) {
    var start = md.lastIndexOf('\n', offset - 1) + 1;
    var end = md.indexOf('\n', offset);
    return { start: start, end: end < 0 ? md.length : end };
  }

  // Turn the item at index i into a paragraph; items before/after stay lists.
  function outdentToParagraph(listMd, spans, i) {
    var before = '', after = '';
    for (var k = 0; k < spans.length; k++) {
      if (k < i) before += spans[k].item.raw;
      else if (k > i) after += spans[k].item.raw;
    }
    before = before.replace(/\s+$/, '');
    after = after.replace(/\s+$/, '');
    var content = itemContent(spans[i].item.raw);
    var parts = [];
    if (before) parts.push(before);
    parts.push(content);
    if (after) parts.push(after);
    return { md: parts.join('\n\n') + '\n', caret: (before ? before.length + 2 : 0) };
  }

  // Split a list at the caret. Line-based on the caret's item line, so it works
  // at any nesting depth (the line's own indent+marker is reused for the new
  // item) and is robust to marked's empty-item raw quirks.
  function splitList(listMd, offset) {
    var lr = lineRange(listMd, offset);
    var line = listMd.slice(lr.start, lr.end);
    // Empty item under the caret → exit the list.
    if (EMPTY_ITEM_LINE.test(line)) {
      return { exit: true, before: listMd.slice(0, lr.start), after: listMd.slice(lr.end + 1) };
    }
    var m = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+)/);
    if (!m) { // continuation/lazy line with no marker — just break the line
      return { md: listMd.slice(0, offset) + '\n' + listMd.slice(offset), caret: offset + 1 };
    }
    var marker = m[1];
    var rightOnLine = listMd.slice(offset, lr.end);
    // A new empty item with nothing meaningful after it (it will be the last
    // item at its level): emit a bare bullet — no trailing space/newline. A
    // "- \n" trailing item re-lexes into list + a stray `space` token; the bare
    // form stays one clean list and round-trips. An *indented* bare "-" would
    // be read as a setext underline, so use "*" there (never a setext char).
    if (rightOnLine === '' && /^\s*$/.test(listMd.slice(offset))) {
      var bullet = marker.replace(/\s+$/, '');
      if (/^\s+-$/.test(bullet)) bullet = bullet.replace('-', '*');
      return { md: listMd.slice(0, offset) + '\n' + bullet, caret: offset + 1 + bullet.length };
    }
    var newMarker = marker;
    if (rightOnLine === '' && /^\s+-\s+$/.test(newMarker)) newMarker = newMarker.replace('-', '*');
    return {
      md: listMd.slice(0, offset) + '\n' + newMarker + listMd.slice(offset),
      caret: offset + 1 + newMarker.length,
    };
  }

  /**
   * Backspace at the start of a list item's content. A non-first item merges
   * its content onto the end of the previous item; the first item (no previous
   * sibling to merge into) outdents to a plain paragraph.
   */
  // Backspace at the start of a list item's content. Line-based, so it works at
  // any nesting depth: an item with an item line above it merges its content up
  // into that line (dropping this line's marker); the very first line of the
  // block outdents to a plain paragraph. Mirrors how a contenteditable joins a
  // line to the one above, but marker-aware.
  function mergeListItem(listMd, offset, marked) {
    var lr = lineRange(listMd, offset);
    var line = listMd.slice(lr.start, lr.end);
    var m = line.match(/^(\s*(?:[-*+]|\d+[.)])\s*)/); // indent + marker (+ optional space)
    if (!m) return { md: listMd, caret: offset };
    var contentStart = lr.start + m[1].length;
    if (offset > contentStart) return { md: listMd, caret: offset }; // not at item start
    if (lr.start === 0) {
      // First line of the block → outdent to a paragraph; the rest stays a list.
      var content = line.slice(m[1].length);
      var rest = listMd.slice(lr.end).replace(/^\n+/, '');
      return { md: rest ? content + '\n\n' + rest : content + '\n', caret: 0 };
    }
    // Merge up: delete the newline before this line and this line's marker.
    return { md: listMd.slice(0, lr.start - 1) + listMd.slice(contentStart), caret: lr.start - 1 };
  }

  /** Tab: nest the caret's item line under the item above it. */
  function indentItem(listMd, offset, marked) {
    var lr = lineRange(listMd, offset);
    var line = listMd.slice(lr.start, lr.end);
    if (lr.start === 0 || !MARKER_LINE.test(line)) return { md: listMd, caret: offset }; // can't nest the first line
    var indented = '  ' + line;
    // An empty "-" bullet, once indented under a text line, is parsed as a
    // setext-H2 underline (turning the parent line into a heading). Switch an
    // empty dash bullet to "*", which can never be a setext underline.
    if (/^\s*-\s*$/.test(indented)) indented = indented.replace('-', '*');
    return { md: listMd.slice(0, lr.start) + indented + listMd.slice(lr.end), caret: offset + 2 };
  }

  /** Shift+Tab: unindent the caret's item line; a top-level item becomes a paragraph. */
  function outdentItem(listMd, offset, marked) {
    var lr = lineRange(listMd, offset);
    var line = listMd.slice(lr.start, lr.end);
    var m = line.match(/^( {1,2}|\t)/);
    if (m) {
      var out = line.slice(m[1].length);
      return {
        md: listMd.slice(0, lr.start) + out + listMd.slice(lr.end),
        caret: Math.max(lr.start, offset - m[1].length),
      };
    }
    var list = marked.lexer(listMd)[0];
    if (!list || list.type !== 'list') return { md: listMd, caret: offset };
    var spans = itemSpans(listMd, list.items);
    return outdentToParagraph(listMd, spans, itemAt(spans, offset));
  }

  /**
   * Split a block at a source offset. Paragraphs/headings/blockquotes get a
   * \n\n inserted (the right side becomes a plain paragraph); emphasis runs
   * spanning the offset are closed and reopened; lists get a new tight item.
   */
  function splitBlock(blockMd, offset, marked) {
    var tok = marked.lexer(blockMd)[0];
    if (tok.type === 'list') return splitList(blockMd, offset, tok);
    var kids = tok.tokens || [];
    var innerOld = kids.map(function (c) { return c.raw; }).join('');
    var cStart = blockMd.indexOf(innerOld);
    if (cStart < 0) cStart = 0;
    var prefix = blockMd.slice(0, cStart);
    var suffix = blockMd.slice(cStart + innerOld.length);
    var rel = Math.max(0, Math.min(offset - cStart, innerOld.length));
    var sp = splitTokenList(kids, rel);
    var leftBlock = prefix + sp.left;
    return { md: leftBlock + '\n\n' + sp.right + suffix, caret: (leftBlock + '\n\n').length };
  }

  /**
   * Merge the block starting at `offset` into the preceding block by removing
   * the run of whitespace immediately before it.
   */
  function mergeBlock(md, offset) {
    var i = offset;
    while (i > 0 && /\s/.test(md[i - 1])) i--;
    return { md: md.slice(0, i) + md.slice(offset), caret: i };
  }

  // --- Conflict reconciliation ---------------------------------------------

  /**
   * Per-block 3-way merge. `base` is the last version common to both sides,
   * `view` carries the in-view edits, `disk` the external change. When the
   * block count is stable across all three, each block is merged independently:
   * a side that left a block untouched yields to the side that changed it, and
   * a block changed differently on both sides becomes a conflict (view wins in
   * the merged output, pre-selected for the UI). A block-count change can't be
   * aligned safely, so it degrades to one document-level conflict.
   */
  function reconcile(base, view, disk, marked) {
    if (view === disk) return { merged: view, conflicts: [] };
    if (base === view) return { merged: disk, conflicts: [] }; // view untouched → take disk
    if (base === disk) return { merged: view, conflicts: [] }; // disk untouched → keep view

    var B = segment(base, marked).map(function (s) { return s.raw; });
    var V = segment(view, marked).map(function (s) { return s.raw; });
    var D = segment(disk, marked).map(function (s) { return s.raw; });

    if (B.length === V.length && V.length === D.length) {
      var merged = [], conflicts = [];
      for (var i = 0; i < B.length; i++) {
        if (V[i] === B[i]) merged.push(D[i]);
        else if (D[i] === B[i]) merged.push(V[i]);
        else if (V[i] === D[i]) merged.push(V[i]);
        else {
          merged.push(V[i]);
          conflicts.push({ segIndex: i, base: B[i], view: V[i], disk: D[i] });
        }
      }
      return { merged: merged.join(''), conflicts: conflicts };
    }

    // Block count changed — alignment isn't safe; surface one coarse conflict.
    return { merged: view, conflicts: [{ segIndex: -1, base: base, view: view, disk: disk }] };
  }

  // --- DOM adapter ---------------------------------------------------------
  //
  // The only DOM-coupled functions. They map between a rendered block element
  // and source offsets, and read pure-text edits back out. Mapping is done on
  // *linear display offsets* (cumulative textContent length), which is robust
  // to the fact that escapes/entities merge into neighbouring text nodes and
  // marked appends a trailing "\n" to each block.

  var SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT

  function dispTextOf(token) { return token.text !== undefined ? token.text : token.raw; }

  // Ordered leaves of a block with source (raw) and display spans. Positions are
  // found by forward-searching each leaf's raw in the block source directly —
  // NOT by composing offsets down the token tree. Composition breaks for nested
  // lists because marked strips a nested block's leading indentation from its
  // raw, so child raws don't tile the parent. A leaf's own raw (text, codespan,
  // escape) always appears verbatim in the source, so a left-to-right scan locates
  // it correctly at any nesting depth.
  function leafMap(blockToken) {
    var leaves = [];
    (function walk(token) {
      var kids = childrenOf(token);
      if (!kids) { leaves.push({ token: token, type: token.type }); return; }
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
    })(blockToken);
    var src = blockToken.raw, search = 0, disp = 0;
    for (var j = 0; j < leaves.length; j++) {
      var raw = leaves[j].token.raw;
      var idx = src.indexOf(raw, search);
      if (idx < 0) idx = search; // best effort — should not happen for leaf raws
      leaves[j].rawStart = idx;
      leaves[j].rawEnd = idx + raw.length;
      search = idx + raw.length;
      var len = dispTextOf(leaves[j].token).length;
      leaves[j].dispStart = disp;
      leaves[j].dispEnd = disp + len;
      disp += len;
    }
    return leaves;
  }

  // Display offset of (node, offset) within el — text length from el's start.
  function displayOffset(el, node, offset) {
    var r = el.ownerDocument.createRange();
    r.setStart(el, 0);
    r.setEnd(node, offset);
    return r.toString().length;
  }

  // The (node, offset) for a linear display offset (stops before the trailing \n).
  function locateTextNode(el, dispTarget) {
    var w = el.ownerDocument.createTreeWalker(el, SHOW_TEXT);
    var acc = 0, node, last = null;
    while ((node = w.nextNode())) {
      last = node;
      var len = node.textContent.length;
      if (dispTarget <= acc + len) return { node: node, offset: dispTarget - acc };
      acc += len;
    }
    return { node: last, offset: last ? last.textContent.length : 0 };
  }

  // Remove whitespace-only text nodes (outside <pre>/<code>) from a rendered
  // block. marked pretty-prints HTML with "\n" between block tags (e.g. between
  // <li> elements); those nodes inflate the DOM's textContent relative to the
  // token-based leaf display model, so caret mapping drifts in multi-element
  // blocks like lists. Stripping them makes textContent === concat(leaf text).
  function stripStructuralWhitespace(el) {
    var doc = el.ownerDocument;
    var w = doc.createTreeWalker(el, SHOW_TEXT);
    var kill = [], n;
    while ((n = w.nextNode())) {
      if (!/^\s*$/.test(n.textContent)) continue;
      var p = n.parentNode, inPre = false;
      while (p && p !== el) {
        var tag = (p.tagName || '').toUpperCase();
        if (tag === 'PRE' || tag === 'CODE') { inPre = true; break; }
        p = p.parentNode;
      }
      if (!inPre) kill.push(n);
    }
    kill.forEach(function (x) { x.parentNode.removeChild(x); });
    return el;
  }

  // Ordered non-empty text nodes of el. After stripStructuralWhitespace these
  // carry exactly the leaf display text, in document order. A single node may
  // span several leaves (e.g. text + escape + text within one <p>), so the
  // correspondence is by display *range*, not 1:1.
  function textNodesOf(el) {
    var w = el.ownerDocument.createTreeWalker(el, SHOW_TEXT);
    var nodes = [], n;
    while ((n = w.nextNode())) { if (n.textContent.length) nodes.push(n); }
    return nodes;
  }

  // Display start offset of `node` (sum of prior text nodes' lengths), or -1 if
  // it isn't one of el's text nodes.
  function nodeDispStart(nodes, node) {
    var acc = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] === node) return acc;
      acc += nodes[i].textContent.length;
    }
    return -1;
  }

  // The (node, offset) at a linear display offset, biased to the node that
  // *starts* at the offset (preferStart) or *ends* at it. This is what tells
  // start-of-item-2 (node "two", 0) apart from end-of-item-1 (node "one", end)
  // — they share a display offset but live in different list elements.
  function locateDisp(nodes, dispPos, preferStart) {
    var acc = 0;
    for (var i = 0; i < nodes.length; i++) {
      var len = nodes[i].textContent.length, end = acc + len;
      if (preferStart ? (dispPos >= acc && dispPos < end)
                      : (dispPos > acc && dispPos <= end)) {
        return { node: nodes[i], offset: dispPos - acc };
      }
      acc = end;
    }
    var last = nodes.length ? nodes[nodes.length - 1] : null;
    return last ? { node: last, offset: last.textContent.length } : { node: null, offset: 0 };
  }

  // bias resolves leaf-boundary ambiguity: a selection START at a leaf boundary
  // biases into the following leaf (e.g. just past an opening **), an END into
  // the preceding leaf (just before a closing **) so emphasis stays selectable.
  // With no bias the caret resolves by which *node* it sits in — at a node's
  // end it stays in that node's last leaf (so end-of-item-1 ≠ start-of-item-2).
  // Within a node, adjacent leaves are source-contiguous so either side agrees.
  function domOffsetToSourceOffset(el, node, offset, blockToken, bias) {
    var leaves = leafMap(blockToken);
    // Caret parked in an empty block element (empty <li>): map to the paired
    // zero-width leaf's source position.
    if (node && node.nodeType === 1) {
      var empties = emptyBlockEls(el), idx = empties.indexOf(node), seen = 0;
      if (idx >= 0) {
        for (var e = 0; e < leaves.length; e++) {
          if (leaves[e].dispStart !== leaves[e].dispEnd) continue;
          if (seen === idx) return leaves[e].rawStart;
          seen++;
        }
      }
    }
    var nodes = textNodesOf(el);
    var tnStart = nodeDispStart(nodes, node);
    if (tnStart < 0) { // caret not in a known text node — linear fallback
      var target = displayOffset(el, node, offset);
      return resolveDisp(leaves, target, bias === 'start' ? true : bias === 'end' ? false : true);
    }
    var nodeLen = node.textContent.length;
    var off = Math.max(0, Math.min(offset, nodeLen));
    var dispPos = tnStart + off;
    var preferNext = bias === 'start' ? true : bias === 'end' ? false : (off <= 0);
    return resolveDisp(leaves, dispPos, preferNext);
  }

  // Map a linear display offset to a source offset, choosing the following leaf
  // (preferNext) or preceding leaf at a boundary.
  function resolveDisp(leaves, dispPos, preferNext) {
    var endsHere = null, startsHere = null;
    for (var i = 0; i < leaves.length; i++) {
      var L = leaves[i];
      if (dispPos > L.dispStart && dispPos < L.dispEnd) { // strictly interior
        return L.type === 'text' ? L.rawStart + (dispPos - L.dispStart)
          : (dispPos <= L.dispStart ? L.rawStart : L.rawEnd);
      }
      if (L.dispEnd === dispPos) endsHere = L;
      if (L.dispStart === dispPos && !startsHere) startsHere = L;
    }
    if (preferNext && startsHere) return startsHere.rawStart;
    if (!preferNext && endsHere) return endsHere.rawEnd;
    if (startsHere) return startsHere.rawStart;
    if (endsHere) return endsHere.rawEnd;
    if (leaves.length && dispPos <= leaves[0].dispStart) return leaves[0].rawStart;
    return leaves.length ? leaves[leaves.length - 1].rawEnd : 0;
  }

  // --- Cross-block arrow navigation ----------------------------------------
  //
  // Each top-level block is its own contenteditable, so the browser's caret
  // navigation stops at a block's edge. These helpers decide when an Up/Down
  // press should hop to the neighbouring block. dir is -1 (Up) or +1 (Down).

  // Is the caret on the block's first (Up) or last (Down) visual line? Compared
  // geometrically against the block's edge, within ~0.6 of a line height.
  function atBlockEdge(caretRect, blockRect, dir) {
    var pad = Math.max(4, (caretRect.height || 16) * 0.6);
    return dir < 0 ? (caretRect.top - blockRect.top) <= pad
                   : (blockRect.bottom - caretRect.bottom) <= pad;
  }

  // The next/previous sibling block that is itself editable (skips read-only
  // blocks like code/tables/hr). Returns null at the document edge.
  function adjacentEditableSeg(div, dir) {
    var sib = div;
    for (;;) {
      sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
      if (!sib) return null;
      if (sib.getAttribute && sib.getAttribute('contenteditable') === 'true') return sib;
    }
  }

  // Empty editable block elements (e.g. an empty <li> from a just-created list
  // item) in document order. They host a caret but have no text node, so they
  // can't be reached through the display-offset machinery; they pair, in order,
  // with the zero-width leaves leafMap emits for empty items.
  function emptyBlockEls(el) {
    var out = [];
    Array.prototype.forEach.call(el.querySelectorAll('li,p'), function (e) {
      if (e.textContent === '' && !e.querySelector('li,p')) out.push(e);
    });
    return out;
  }

  function sourceOffsetToDom(el, srcOffset, blockToken) {
    var leaves = leafMap(blockToken);
    var nodes = textNodesOf(el);
    for (var i = 0; i < leaves.length; i++) {
      var L = leaves[i];
      if (L.dispStart === L.dispEnd) continue; // empty leaf — handled below
      if (srcOffset >= L.rawStart && srcOffset <= L.rawEnd) {
        var atStart = srcOffset <= L.rawStart;
        var dispPos = L.type === 'text' ? L.dispStart + (srcOffset - L.rawStart) : (atStart ? L.dispStart : L.dispEnd);
        return locateDisp(nodes, dispPos, atStart);
      }
    }
    // Empty item: pair the j-th zero-width leaf with the j-th empty element.
    var empties = emptyBlockEls(el), j = 0;
    for (var k = 0; k < leaves.length; k++) {
      var E = leaves[k];
      if (E.dispStart !== E.dispEnd) continue;
      var next = (k + 1 < leaves.length) ? leaves[k + 1].rawStart : Infinity;
      if (srcOffset >= E.rawStart && srcOffset < next && empties[j]) return { node: empties[j], offset: 0 };
      j++;
    }
    if (leaves.length && srcOffset <= leaves[0].rawStart) return locateDisp(nodes, 0, true);
    var lastDisp = leaves.length ? leaves[leaves.length - 1].dispEnd : 0;
    return locateDisp(nodes, lastDisp, false);
  }

  // Inline formatting elements our tokens render to, in document order.
  function domSkeleton(el) {
    return Array.prototype.map.call(el.querySelectorAll('strong,em,a,code,del'),
      function (n) { return n.tagName.toUpperCase(); });
  }
  var TAG_FOR = { strong: 'STRONG', em: 'EM', link: 'A', codespan: 'CODE', del: 'DEL' };
  function tokenSkeleton(blockToken) {
    var out = [];
    (function walk(token) {
      var kids = childrenOf(token);
      if (TAG_FOR[token.type]) out.push(TAG_FOR[token.type]);
      if (kids) for (var i = 0; i < kids.length; i++) walk(kids[i]);
    })(blockToken);
    return out;
  }

  /**
   * Read a pure-text edit out of an edited block element as a leaf-edits map.
   * Returns { edits, clean }. clean is false when the inline structure changed
   * (a formatting boundary was crossed) — those go through the structural ops,
   * not leaf substitution.
   */
  function readEditsFromDom(el, blockToken) {
    var leaves = leafMap(blockToken);
    var oldDisp = leaves.map(function (L) { return dispTextOf(L.token); }).join('');
    var newDisp = (el.textContent || '').replace(/\n+$/, '');
    if (newDisp === oldDisp) return { edits: new Map(), clean: true };
    if (domSkeleton(el).join(',') !== tokenSkeleton(blockToken).join(',')) {
      return { edits: new Map(), clean: false };
    }
    var minLen = Math.min(oldDisp.length, newDisp.length);
    var p = 0;
    while (p < minLen && oldDisp[p] === newDisp[p]) p++;
    var s = 0;
    while (s < minLen - p && oldDisp[oldDisp.length - 1 - s] === newDisp[newDisp.length - 1 - s]) s++;
    var oldEnd = oldDisp.length - s;
    var newSub = newDisp.slice(p, newDisp.length - s);
    // The change must sit within a single text leaf to be a clean leaf edit.
    var container = null;
    for (var i = 0; i < leaves.length; i++) {
      var L = leaves[i];
      if (L.type === 'text' && p >= L.dispStart && oldEnd <= L.dispEnd) { container = L; break; }
    }
    if (!container) return { edits: new Map(), clean: false };
    var dt = dispTextOf(container.token);
    var newText = dt.slice(0, p - container.dispStart) + newSub + dt.slice(oldEnd - container.dispStart);
    var edits = new Map();
    edits.set(container.token, newText);
    return { edits: edits, clean: true };
  }

  return {
    segment: segment,
    isEditableBlock: isEditableBlock,
    reserialize: reserialize,
    applyLeafEdits: applyLeafEdits,
    toggleEmphasis: toggleEmphasis,
    splitBlock: splitBlock,
    mergeBlock: mergeBlock,
    mergeListItem: mergeListItem,
    indentItem: indentItem,
    outdentItem: outdentItem,
    reconcile: reconcile,
    domOffsetToSourceOffset: domOffsetToSourceOffset,
    sourceOffsetToDom: sourceOffsetToDom,
    readEditsFromDom: readEditsFromDom,
    stripStructuralWhitespace: stripStructuralWhitespace,
    atBlockEdge: atBlockEdge,
    adjacentEditableSeg: adjacentEditableSeg,
  };
});
