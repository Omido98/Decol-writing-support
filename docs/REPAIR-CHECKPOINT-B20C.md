# Repair handoff — state after B20c (next: B21)

Written 2026-09-16. The tree is VERIFIED GREEN at this checkpoint; nothing
is half-typed. Authoritative per-batch history is the "Repair programme"
section of `docs/IMPLEMENTATION-PROGRESS.md` (B19, B20a, B20b, B20c
entries at the end).

---

## 0. One-line kickoff for a fresh session

> Read `docs/REPAIR-CHECKPOINT-B20C.md` in full, then continue the Decol
> Writing Support repair programme from **B21** using the execution
> discipline in `docs/REPAIR-CHECKPOINT-B16A.md` section 4 (unchanged).
> Do not commit/push/reset/release; preserve all uncommitted and untracked
> work.

---

## 1. Verified state (commands + numbers, run after B20c)

From the project root:
- `npx tsc --noEmit` — OK.
- `npm test` — **544 passed (53 files)**.
- `npm run build` — OK (pre-existing chunk-size warning only).
- `npx -p @google/design.md designmd lint DESIGN.md` — 0 errors, 0
  warnings (the contract prose was extended, tokens unchanged).

From `src-tauri`:
- `cargo test --lib` — **89 passed, 1 ignored** (fixture generator).
- `cargo check` — OK.

**Native schema v13; desktop backup format v3** (unchanged since B18).

Known non-failing stderr noise (unchanged): keychain-locked warnings in
`credentialIsolation.test.ts`; one pre-existing React "update while
rendering" warning in `saveAcknowledgement.test.tsx`.

## 2. What the recent batches changed (short version)

- B19: faithful footnotes (stable ids, document-order renumbering,
  click-to-edit, source/passage/locator/fallback retained) and DOCX
  fidelity (recursive lists with numbering instances, links, quote
  tables, merged cells, explicit bibliography append). Asset decision
  (user): backups are extracted-text-only (README + Settings note).
- B20a: Unicode-safe literal find/replace, focus kept in Find, scoped
  shortcuts, Ctrl+K Link-vs-palette resolution.
- B20b: command palette rebuilt on the dialog primitive (focus trap,
  return focus, one active-result model, IME-safe Enter, stale responses
  discarded).
- B20c: measured panel collapse (inspector first, then navigator) from
  the real container + widths; drawers for auto-hidden panels; mounted
  panels preserve state; persisted widths + keyboard resizing; inner-edge
  inspector handle; proper inspector tabs; `aria-current`/`aria-expanded`
  and keyboard-visible row actions; manuscript list markers + focus ring;
  document-voice headings; reduced motion.

## 3. B21 — Browser parity and derived indexes (exact next batch)

Files: the JSON backend in `src/utils/repository.ts`, backup converters in
`src/utils/backup.ts`, project deletion paths, search migrations in
`src-tauri/src/repository.rs`. `src/utils/__tests__/repository.test.ts`
has separate "repository (JSON backend)" and "repository (SQLite backend)"
describes.

Implement:
- Correct revision-map lookups to use `entityKey(kind, id)` consistently.
- Migrate legacy browser history to stable persistent version IDs.
- Commit browser body/history/metadata/revision atomically (IndexedDB or a
  documented transactional envelope).
- Export the same canonical dataset from both backends, including sources,
  proposals, drafts, and applicable preferences.
- Prevent browser restore from inheriting newer omitted live bodies.
- Project deletion must bump/update affected child revisions and refresh
  loaded associations/pending payloads.
- Prevent stale saves from relinking deleted projects.
- Add/update FTS triggers for stable-ID message replacement and rebuild
  stale indexes.

Acceptance: browser create→save→reload→save works for each entity type.
Mid-write failure leaves a complete old state. Deleted-project children
stay standalone. Replaced messages are searchable only under their new
text.

First three reads:
1. `src/utils/repository.ts` — JSON backend + `entityKey`/revision maps,
   transactional envelope, delete paths.
2. `src/utils/__tests__/repository.test.ts` — both describes.
3. `src-tauri/src/repository.rs` — FTS triggers, `thread_replace_message`,
   delete paths, migration guards.

Note: if the dump contract changes, regenerate
`src/test/backup-contract.json` from `src-tauri` with
`cargo test --lib regenerate_backup_contract_fixture -- --ignored` and
update validators/fixtures.

## 4. After B21

B22 last: evidence-based evaluation (`evalHarness.ts`,
`EvalReportView.tsx`, `perfLog.ts`, `DiagnosticsDialog.tsx`,
`.github/workflows/pr-verify.yml`): run ids + cancel/settlement
ownership, no scoring of errors/stopped/truncated as completed samples,
older runs cannot overwrite newer ones, accurate numeric-token matching
(1492 not inside 11492), meaning-proxy threshold fix, lexical retention
labelled a proxy, cancellation latency recorded or the claim removed,
production-path regression tests, CI provisioning native prerequisites
and actually verified. Full plan: `docs/REPAIR-CHECKPOINT-B16A.md`
section 8.

## 5. Hard constraints (reminder)

- Branch `repair-r1-r11`, version 0.0.4; everything uncommitted; do NOT
  reset/clean/discard/commit/push/release/bump.
- Use the dedicated file tools; never PowerShell content round-trips.
- Isolated/in-memory datasets only; mocked transports; no paid calls.
- Acceptance must exercise the production path.
- Test-isolation land mines (unchanged): libraryStore content cache,
  applied-proposal ledger, aiOperations registry, briefCache,
  repo.resetSessionState, Tiptap async destroy, jsdom rect stubs. Vitest
  default `findBy*` timeout is 1000 ms; heavy mounts need
  `waitFor(..., { timeout: 5000 })`. Tiptap `focus()` defers through
  requestAnimationFrame in jsdom — focus the editor DOM directly. Base UI
  modals mark outside content inert — use text queries behind modals and
  `[data-base-ui-focus-guard]` for the trap. WorkspaceShell measures the
  real container via ResizeObserver and falls back to `window.innerWidth`
  when jsdom reports no layout — tests set `window.innerWidth` before
  rendering.
