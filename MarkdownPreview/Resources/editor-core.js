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
    var innerOld = kids.map(function (c) { return c.raw; }).join('');
    var idx = token.raw.indexOf(innerOld);
    if (idx < 0) return token.raw; // can't locate the inner span — don't risk corruption
    var open = token.raw.slice(0, idx);
    var close = token.raw.slice(idx + innerOld.length);
    var inner = kids.map(function (c) { return reserialize(c, edits); }).join('');
    return open + inner + close;
  }

  /** Rebuild a segment's raw from leaf edits. */
  function applyLeafEdits(segment, edits) {
    return reserialize(segment.token, edits);
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

  /**
   * Toggle bold/italic over a source range [start,end) within one block's
   * markdown. Returns { md, selStart, selEnd } or null if the wrap wouldn't
   * parse (e.g. wrapping whitespace). kind is 'strong' or 'em'.
   */
  function toggleEmphasis(s, start, end, kind, marked) {
    var d = delimFor(kind), dl = d.length;

    // Unwrap: selection sits just inside the delimiters — **[sel]**
    if (start >= dl && s.slice(start - dl, start) === d && s.slice(end, end + dl) === d) {
      return { md: s.slice(0, start - dl) + s.slice(start, end) + s.slice(end + dl), selStart: start - dl, selEnd: end - dl };
    }
    // Unwrap: selection includes the delimiters — [**sel**]
    if (end - start >= 2 * dl && s.slice(start, start + dl) === d && s.slice(end - dl, end) === d) {
      return { md: s.slice(0, start) + s.slice(start + dl, end - dl) + s.slice(end), selStart: start, selEnd: end - 2 * dl };
    }
    // Wrap: strip same-kind wrappers inside the selection, then wrap once.
    var stripped = stripSameKind(s.slice(start, end), kind, marked);
    var md = s.slice(0, start) + d + stripped + d + s.slice(end);
    if (!hasTokenRaw(md, d + stripped + d, kind, marked)) return null;
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

  function splitList(listMd, offset, list) {
    var items = list.items, pos = 0;
    for (var i = 0; i < items.length; i++) {
      var raw = items[i].raw;
      if (offset > pos && offset < pos + raw.length) {
        var item = items[i];
        var innerOld = item.tokens.map(function (c) { return c.raw; }).join('');
        var idx = raw.indexOf(innerOld);
        var marker = raw.slice(0, idx);
        var trailing = raw.slice(idx + innerOld.length);
        var rel = Math.max(0, Math.min(offset - pos - idx, innerOld.length));
        var sp = splitTokenList(item.tokens, rel);
        // Single \n keeps the list tight; reuse the marker (markdown renumbers
        // ordered lists on render, so no explicit renumber is needed).
        var newItemRaw = marker + sp.left + '\n' + marker + sp.right + trailing;
        return {
          md: listMd.slice(0, pos) + newItemRaw + listMd.slice(pos + raw.length),
          caret: pos + (marker + sp.left + '\n' + marker).length,
        };
      }
      pos += raw.length;
    }
    return { md: listMd, caret: offset };
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

  // Ordered leaves of a block with source (raw) and display spans.
  function leafMap(blockToken) {
    var leaves = [];
    (function walk(token, rawBase) {
      var kids = childrenOf(token);
      if (!kids) {
        leaves.push({ token: token, type: token.type, rawStart: rawBase, rawEnd: rawBase + token.raw.length });
        return;
      }
      var innerOld = kids.map(function (c) { return c.raw; }).join('');
      var idx = token.raw.indexOf(innerOld);
      if (idx < 0) idx = 0;
      var pos = rawBase + idx;
      for (var i = 0; i < kids.length; i++) { walk(kids[i], pos); pos += kids[i].raw.length; }
    })(blockToken, 0);
    var disp = 0;
    for (var j = 0; j < leaves.length; j++) {
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

  // bias resolves leaf-boundary ambiguity: a selection START biases into the
  // following leaf (e.g. just past an opening **), an END biases into the
  // preceding leaf (just before a closing **) so emphasis stays selectable.
  function domOffsetToSourceOffset(el, node, offset, blockToken, bias) {
    var target = displayOffset(el, node, offset);
    var leaves = leafMap(blockToken);
    for (var i = 0; i < leaves.length; i++) {
      var L = leaves[i];
      var inside = (bias === 'end')
        ? (target > L.dispStart && target <= L.dispEnd)
        : (target >= L.dispStart && target < L.dispEnd);
      if (inside) {
        if (L.type === 'text') return L.rawStart + (target - L.dispStart);
        return target <= L.dispStart ? L.rawStart : L.rawEnd; // opaque leaf: clamp
      }
    }
    if (leaves.length && target <= leaves[0].dispStart) return leaves[0].rawStart;
    return leaves.length ? leaves[leaves.length - 1].rawEnd : 0;
  }

  function sourceOffsetToDom(el, srcOffset, blockToken) {
    var leaves = leafMap(blockToken);
    var dispTarget = 0, placed = false;
    for (var i = 0; i < leaves.length; i++) {
      var L = leaves[i];
      if (srcOffset >= L.rawStart && srcOffset <= L.rawEnd) {
        dispTarget = L.type === 'text' ? L.dispStart + (srcOffset - L.rawStart)
          : (srcOffset <= L.rawStart ? L.dispStart : L.dispEnd);
        placed = true;
        break;
      }
    }
    if (!placed) {
      if (leaves.length && srcOffset <= leaves[0].rawStart) dispTarget = 0;
      else dispTarget = leaves.length ? leaves[leaves.length - 1].dispEnd : 0;
    }
    return locateTextNode(el, dispTarget);
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
    reconcile: reconcile,
    domOffsetToSourceOffset: domOffsetToSourceOffset,
    sourceOffsetToDom: sourceOffsetToDom,
    readEditsFromDom: readEditsFromDom,
  };
});
