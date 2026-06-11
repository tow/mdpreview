# Editing model — target architecture

## Why

Every editing bug shipped so far (resurrected deletions, zombie formatting,
Cmd+I nesting instead of splitting, boundary-biased folds) had one root: the
spec of an editing gesture lives in display space ("flip the italic state of
the selected characters") while the implementation manipulated markdown bytes
— delimiter pairing, star-run parity, marker surgery — and approximated the
spec through case analysis. Each unenumerated case was a bug.

## Target

One parser, one printer, a document model in between. Operations are
functions on the model and therefore *are* their specs.

    markdown --parse--> StyledDoc --op--> StyledDoc' --print--> markdown'

- **StyledDoc**: list of blocks.
  - styled block: { kind: paragraph | heading(n) | listItem(depth, marker) |
    quote, text: [ { ch, attrs: {bold, italic, code, link(href), image(src,alt)} } ] }
  - opaque block (code fence, table, hr, html): { raw } — bytes pass through.
- **Operations**: insertText (attrs inherited from caret context), deleteRange,
  toggleAttr(range, attr), splitBlock, mergeBlocks, indent/outdent,
  setBlockKind. No delimiters exist in this space.
- **DOM readback**: rendered DOM ≈ model. Reconciliation = DOM→model, diff,
  print. (editor-core's canonicalOfEl already judges in this space; promote
  it from verifier to the write path and delete source-splicing candidates.)
- **Byte fidelity**: printer reuses original raws for blocks/runs whose model
  is unchanged (_em_ stays _em_, escapes stay as written). Only touched runs
  get freshly printed markdown.

## Laws (the test suite's spine)

1. Round-trip: parse(print(doc)) ≡ doc (model space).
2. Fidelity: print(parse(md)) === md when no op ran.
3. Convergence: render(print(doc)) canonical-equals the live DOM after every
   event (tests/convergence.test.mjs, already enforced).
4. Op semantics: ops are definitionally correct in model space; what needs
   testing shrinks to parse and print.

## Migration order (each step lands behind the existing fuzzer + 167 tests)

1. Inline layer: parse/print of styled text within a block; rebuild
   toggleEmphasis as parse→flip→print with raw-reuse. Deletes star-run
   parity, run-splitting, stripSameKind, absorbed-run validation.
2. DOM reconciliation: replace reconcileDomEdit's byte-splice candidates with
   DOM→model diffing. Deletes srcCandidatesAt boundary enumeration.
3. Block ops: doSplit/doMerge/doIndent/doMergeListItem as model ops. Deletes
   splitBlock/mergeBlock/indentItem/outdentItem byte surgery.
4. Remove the then-dead splicing helpers from editor-core.

## Known frontiers not addressed by this model

- disk↔source 3-way merge (applyDiskChange) — separate convergence boundary,
  still untested by the fuzzer.
- WebKit-vs-jsdom fidelity of emulated default editing — backstopped by the
  editor.log transcript (~/Library/Logs/MarkdownPreview/editor.log).
