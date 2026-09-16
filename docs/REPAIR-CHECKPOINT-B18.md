# Repair handoff — state after B18 (next: B19)

Written 2026-09-16. The tree is VERIFIED GREEN at this checkpoint; nothing
is half-typed. Authoritative per-batch history is the "Repair programme"
section of `docs/IMPLEMENTATION-PROGRESS.md` (B18 entry at the end).

---

## 0. One-line kickoff for a fresh session

> Read `docs/REPAIR-CHECKPOINT-B18.md` in full, then continue the Decol
> Writing Support repair programme from **B19** using the execution
> discipline in `docs/REPAIR-CHECKPOINT-B16A.md` section 4 (unchanged).
> Do not commit/push/reset/release; preserve all uncommitted and untracked
> work.

---

## 1. Verified state (commands + numbers, run after B18)

From the project root:
- `npx tsc --noEmit` — OK.
- `npm test` — **500 passed (50 files)**.
- `npm run build` — OK (pre-existing chunk-size warning only).

From `src-tauri`:
- `cargo test --lib` — **89 passed, 1 ignored** (fixture generator).
- `cargo check` — OK.

Known non-failing stderr noise (unchanged): keychain-locked warnings in
`credentialIsolation.test.ts`; one pre-existing React "update while
rendering" warning in `saveAcknowledgement.test.tsx`.

**Native schema is now v13** (B18 added seven source metadata columns).
**Desktop backup format is version 3**; `src/test/backup-contract.json`
was REGENERATED in B18 (source rows carry type/container/publisher/
volume/issue/pages/abstract). Regenerate only after a dump change:
`cargo test --lib regenerate_backup_contract_fixture -- --ignored`.

## 2. What B18 changed (short version)

- Sources now carry `sourceType`, `containerTitle`, `publisher`,
  `volume`, `issue`, `pages`, `abstract`, `notes` end-to-end (model,
  SQLite v13, JSON backend, dump contract, fake repository, panel
  editor).
- Interchange rewritten: unambiguous "; " author boundaries and brace
  literals (`{Org}`), notes/abstract/container/publisher separation,
  symmetric RIS, CSL recognition gate (unrelated JSON is skipped),
  BibTeX escaping, unique citation keys, type retention (no more
  "book" for everything).
- Source dedup uses `doi:<normalized>` when a DOI exists; duplicates
  merge only ABSENT metadata and report the decision.

Limitations (documented): RIS literals are plain text; imports display
family-first; duplicate merge never overwrites; one `containerTitle`
field shared by journals/book titles.

## 3. B19 — Faithful footnotes and DOCX export (exact next batch)

Files: `src/components/editor/footnoteExtension.ts`,
`src/components/editor/citationExtension.ts`, CiteControls in
`src/components/editor/DocumentEditorView.tsx`,
`src/utils/docxExport.ts`, tests (`src/utils/__tests__/docxExport.test.ts`,
`src/components/__tests__/footnote.test.tsx`,
`src/components/__tests__/citation.test.tsx`).
`src/components/__tests__/libraryExport.test.tsx` already inspects
`word/document.xml` and `word/footnotes.xml` via jszip through the real
DOCX button — reuse that pattern.

Implement:
- Escape citation labels and ID attributes in Markdown.
- Give footnotes inspectable/editable text and stable identity.
- Number notes from document order, avoiding duplicate labels after
  deletion.
- Source-backed footnotes retain source ID, passage ID, locator, and
  fallback display text.
- Include them in bibliography collection.
- Report unresolved/deleted source references.
- Export lists recursively, respecting nesting, start values, and
  separate numbering instances.
- Preserve paragraph boundaries, quotation formatting, hyperlinks,
  tables inside quotations, and merged cells.
- Skip empty bibliography sections.
- Provide an explicit append-generated-bibliography option to avoid
  duplication.

Acceptance: inspect generated DOCX XML and relationships — not just ZIP
size — for exact text order, links, numbering, cell spans, notes, and
bibliography count.

Asset note (UNCHANGED, must be surfaced to the user): `assetRef =
filename` is not a durable asset. Either implement a content-addressed
asset store + portable archive, or clearly document that backups
preserve extracted text only. This is an open decision — put it to the
user before implementing it.

First three reads:
1. `src/components/editor/footnoteExtension.ts` — `FootnoteAttrs`,
   `FootnoteRef`, `collectFootnotes`, `nextFootnoteLabel`, and how the
   attrs render to Markdown (`escapeAttr`).
2. `src/components/editor/citationExtension.ts` +
   `DocumentEditorView.tsx` CiteControls — `CitationAttrs`,
   `collectCitations(FromJson)`, how footnotes/citations are inserted
   (labels, source id, passages) and what is editable today.
3. `src/utils/docxExport.ts` — `buildDocx`, `inlineRuns`,
   `blockToParagraphs`, `docxBibliography`; then the DOCX tests
   (`libraryExport.test.tsx`, `docxExport.test.ts`) for the established
   jszip XML-inspection pattern.

Test seams: real ProseMirror editors via `canonicalExtensions()` from
`src/components/editor/editorSchema.ts`; `jszip` for DOCX XML; the
`libraryExport.test.tsx` real-button export pattern; `fakeRepository`
for source records.

## 4. Hard constraints (reminder)

- Branch `repair-r1-r11`, version 0.0.4; everything uncommitted; do NOT
  reset/clean/discard/commit/push/release/bump.
- Use the dedicated file tools; never PowerShell content round-trips.
- Isolated/in-memory datasets only; mocked transports; no paid calls.
- Acceptance must exercise the production path (real editor, real
  export buttons, inspected XML).

## 5. After B19

B20a → B22 in order; the full remaining plan is in
`docs/REPAIR-CHECKPOINT-B16A.md` section 8.
