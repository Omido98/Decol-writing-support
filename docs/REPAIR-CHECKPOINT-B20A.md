# Repair handoff — state after B20a (next: B20b)

Written 2026-09-16. The tree is VERIFIED GREEN at this checkpoint; nothing
is half-typed. Authoritative per-batch history is the "Repair programme"
section of `docs/IMPLEMENTATION-PROGRESS.md` (B19 and B20a entries at the
end).

---

## 0. One-line kickoff for a fresh session

> Read `docs/REPAIR-CHECKPOINT-B20A.md` in full, then continue the Decol
> Writing Support repair programme from **B20b** using the execution
> discipline in `docs/REPAIR-CHECKPOINT-B16A.md` section 4 (unchanged).
> Do not commit/push/reset/release; preserve all uncommitted and untracked
> work.

---

## 1. Verified state (commands + numbers, run after B20a)

From the project root:
- `npx tsc --noEmit` — OK.
- `npm test` — **532 passed (52 files)**.
- `npm run build` — OK (pre-existing chunk-size warning only).

From `src-tauri`:
- `cargo test --lib` — **89 passed, 1 ignored** (fixture generator).
- `cargo check` — OK.

Known non-failing stderr noise (unchanged): keychain-locked warnings in
`credentialIsolation.test.ts`; one pre-existing React "update while
rendering" warning in `saveAcknowledgement.test.tsx`.

**Native schema v13; desktop backup format v3** (unchanged since B18 —
B19/B20a touched no Rust and no dump contract).

## 2. What B19 and B20a changed (short version)

B19 — faithful footnotes and DOCX export:
- Citation labels and ids are escaped in Markdown; footnote markdown
  carries `data-footnote-id`, `data-source-id`, `data-passage-id`, and
  `data-locator` (escaped); the reader parses atom tags tolerantly.
- Footnotes have stable ids and a document-order renumbering plugin
  (deleting a note cannot leave duplicate labels); the editor marker
  opens a click-to-edit popover; the reader shows a Notes list.
- Citations AND source-backed footnotes are collected for bibliographies;
  unresolved/deleted source references are reported (editor notice and
  reader export notice) while the stored note text is kept.
- DOCX: recursive lists (nested levels, start values, separate numbering
  instances), hyperlinks as real relationships, quote indentation with
  paragraphs and tables preserved, merged cells, empty bibliographies
  skipped, and an explicit `appendBibliography` option plus
  `hasBibliographyHeading` so an existing bibliography is not duplicated.
- Asset decision (user): **option (b)** — backups preserve the extracted
  text of uploaded sources, not the original files. Documented in the
  README and Settings > Backup & restore.

B20a — find/shortcuts:
- Unicode-safe case-insensitive offset mapping (İ expansions no longer
  shift matches).
- Replacements are literal `tr.insertText` transactions (HTML-looking
  replacement text is not parsed).
- Focus stays in the Find inputs during Enter/button navigation; Escape
  works from both inputs.
- Shortcuts ignore dialog surfaces; Ctrl/Cmd+K inserts a link when the
  keystroke originates in the manuscript and opens the palette elsewhere
  (the shell skips contenteditable targets).

## 3. B20b — Command palette (exact next batch)

Files: `src/components/workspace/CommandPalette.tsx`, the existing modal
primitive `src/components/ui/dialog.tsx`; tests: the workspace-shell
tests that exercise the palette plus a focused palette test file.

Implement:
- Use the existing modal primitive (Dialog) instead of the hand-rolled
  overlay.
- Focus trapping/restoration, Escape, IME-safe Enter, and ONE consistent
  active-result model (keyboard highlight and mouse hover must not
  diverge).
- Ignore stale asynchronous search results (a slow query A resolving
  after query B must not replace B's results).

Tests: slow query A cannot replace B; the focused result activates once
(Enter must not run both a stale and a current handler); Tab cannot
escape behind the palette.

First three reads:
1. `src/components/workspace/CommandPalette.tsx` — current overlay,
   active-index state, async search, keydown handling.
2. `src/components/ui/dialog.tsx` — the modal primitive's API (Base UI)
   and focus behavior.
3. `src/components/__tests__/workspaceShell.test.tsx` (palette) and any
   palette-specific test imports.

## 4. After B20b

B20c → B21 → B22 in order; the full remaining plan is in
`docs/REPAIR-CHECKPOINT-B16A.md` section 8 (B20c panels/accessibility,
B21 browser parity/derived indexes, B22 evidence-based evaluation).
DESIGN.md is the design contract for B20c; use the design-md skill.

## 5. Hard constraints (reminder)

- Branch `repair-r1-r11`, version 0.0.4; everything uncommitted; do NOT
  reset/clean/discard/commit/push/release/bump.
- Use the dedicated file tools; never PowerShell content round-trips.
- Isolated/in-memory datasets only; mocked transports; no paid calls.
- Acceptance must exercise the production path (real editor, real export
  buttons, inspected XML/state).
- Test-isolation land mines (unchanged): libraryStore content cache,
  applied-proposal ledger, aiOperations registry, briefCache,
  repo.resetSessionState, Tiptap async destroy, jsdom rect stubs.
- Vitest default `findBy*` timeout is 1000 ms; heavy editor mounts need
  `waitFor(..., { timeout: 5000 })`. Tiptap's `focus()` command defers
  through requestAnimationFrame in jsdom — focus the editor DOM directly
  in tests when focus matters.
