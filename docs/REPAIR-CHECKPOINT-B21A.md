# Repair handoff — state after B21a (next: B21b)

Written 2026-09-16. The tree is VERIFIED GREEN at this checkpoint; nothing
is half-typed. Authoritative per-batch history is the "Repair programme"
section of `docs/IMPLEMENTATION-PROGRESS.md` (B21a entry at the end).

---

## 0. One-line kickoff for a fresh session

> Read `docs/REPAIR-CHECKPOINT-B21A.md` in full, then continue the Decol
> Writing Support repair programme from **B21b** using the execution
> discipline in `docs/REPAIR-CHECKPOINT-B16A.md` section 4 (unchanged).
> Do not commit/push/reset/release; preserve all uncommitted and untracked
> work.

---

## 1. Verified state (commands + numbers, run after B21a)

From the project root:
- `npx tsc --noEmit` — OK.
- `npm test` — **545 passed (53 files)**.
- `npm run build` — OK (pre-existing chunk-size warning only).

From `src-tauri`:
- `cargo test --lib` — **89 passed, 1 ignored** (fixture generator).
- `cargo check` — OK.

**Native schema v13; desktop backup format v3** (unchanged; B21a touched
no Rust and no dump contract).

## 2. What B21a changed

The browser JSON backend persisted `revisions.json` with `entityKey(kind,
id)` keys but read them by bare id, so revisions read as 0 after a
restart and legacy bare-id files were unreachable. `revOf` now prefers the
canonical key and honours legacy entries; `withRev` adopts legacy entries
under the canonical key before the staleness check and persists the
migration; all list/direct reads use `revOf`. Regression test:
`repository.test.ts` "migrates legacy bare-id revision keys to
entityKey(kind, id) (B21)".

## 3. Remaining B21 work (implement in order)

The original B21 checklist (from `docs/REPAIR-CHECKPOINT-B16A.md` section
8), minus B21a:

### B21b — Atomic browser commit / transactional envelope
STATUS: DONE for the primary save paths, including the revision:
B21b-1 (texts), B21b-2 (project/thread/source saves + creates, replay
hooks on every direct read), B21b-3 (`withRevBatched` puts the revision
into the same batch; a failed save no longer advances the revision). What
remains is OPTIONAL hardening B21b-4: migrate the remaining `withRev`
callers (`textSnapshot`, the thread append/replace/restore operations) to
`withRevBatched`; they currently persist the bump before their single-file
work. Then B21c (deletion/relink invariants), B21d (backend dataset
parity), B21e (Rust FTS triggers), B22 (evaluation).

The envelope: `commitFiles(files)` writes a journal
(`commit-journal.json`, `dws:` prefix in the browser), writes each file,
then deletes the journal; on failure it restores captured previous values
and keeps the journal only when rollback itself failed (the next reader
then completes the new generation). `withRevBatched` appends
`revisions.json` to the callback's batch. `replayPendingCommit()` is
hooked into `readRevs`, `textContent`, `projectBrief`, and `textVersions`.
Tests to copy: the four B21b tests in `repository.test.ts`. To simulate a
transient mid-batch failure, make `localStorage.setItem` throw ONCE for
the chosen `dws:<path>` key.

Original plan follows.

- Commit browser body + history + metadata + revision ATOMICALLY
  (IndexedDB or a documented transactional envelope). Today the JSON
  backend writes the body file, the registry, the versions file, and
  revisions.json as separate `saveJson` calls; an interrupted sequence
  leaves mixed generations.
- Acceptance: browser create→save→reload→save works for EACH entity type
  (text, project, thread, source); a mid-write failure leaves a complete
  OLD state (no half-new metadata with half-old body).
- First reads: `jsonTextSave` / `jsonProjectSave` / `jsonThreadSave` /
  `jsonSourceSave` in `src/utils/repository.ts` (~1600-2250), the
  `withRev` helper (~1590), and the "JSON backend" tests around "a
  successful Save is contained when reopening immediately" and
  "failed content persistence leaves no committed metadata describing
  unsaved content".

Reconnaissance already done (precise anchors, no code changed):
- `jsonTextSave` is `src/utils/repository.ts:1640`; its work writes the
  versions file at :1671, the body at :1673, and `library.json` at :1685.
  `jsonProjectSave` at :1691 (brief :1705, registry :1713); thread/source
  saves follow in the same file.
- `withRev` (`:1596`) persists the revision bump BEFORE `work()` runs
  (comment at :1589). A failed `work()` therefore leaves the revision
  advanced while the entity did not change. For a true envelope, the
  revision write must join the same batch (the `enqueueRegistry`
  serialization already blocks concurrent saves, so persisting first is
  no longer required for safety).
- The transport interceptor (`setTransportInterceptor`, `:613`) wraps the
  SAVER's whole persist (`createSaver`, `:969`), not individual
  `saveJson` calls — it cannot inject a mid-sequence failure. Tests own
  the localStorage stub (see `repository.test.ts:4`), so a mid-write
  failure is best simulated by making `localStorage.setItem` throw for a
  chosen key (e.g. `dws:library.json`) after the body write.
- Browser storage keys are `dws:<path>` (`storage.ts:112`); a journal
  file would be e.g. `dws:commit-journal.json` read via `loadJson`.
- Suggested envelope: `commitFiles([{path, data}...])` writes a journal
  containing the full batch, writes each file, then deletes the journal;
  on failure it restores the captured previous values (deleting files
  that did not exist) and keeps the journal only if rollback itself
  fails; a `replayPendingCommit()` guard at the start of the JSON
  backend's read/save paths heals a crashed process by rewriting the
  batch (idempotent). Start with texts (the acceptance's first entity),
  then wire projects/threads/sources as B21b-2.

### B21c — Deletion/relink invariants
- Project deletion must bump/update affected child revisions and refresh
  loaded associations/pending payloads.
- Prevent stale saves from relinking deleted projects.
- The JSON backend test "projectDelete unlinks texts and conversations in
  one operation" is the current seam; the SQLite delete paths live in
  `src-tauri/src/repository.rs`.
- Acceptance: deleted-project children stay standalone; a queued save for
  a deleted project cannot recreate the link.

### B21d — Canonical dataset parity across backends
- Export the SAME canonical dataset from both backends, including
  sources, proposals, drafts, and applicable preferences (backup
  converters in `src/utils/backup.ts`; SQLite export paths in
  `src-tauri/src/repository.rs`).
- Prevent browser restore from inheriting newer omitted live bodies.
- If the dump contract changes: regenerate `src/test/backup-contract.json`
  with `cargo test --lib regenerate_backup_contract_fixture -- --ignored`
  and update validators/fixtures.

### B21e — FTS triggers for stable-ID message replacement
- Add/update FTS triggers for `thread_replace_message` with stable message
  ids, and rebuild stale indexes.
- Acceptance: replaced messages are searchable only under their NEW text.
- First reads: FTS trigger creation + `thread_replace_message` in
  `src-tauri/src/repository.rs`; the SQLite search tests in
  `src/utils/__tests__/repository.test.ts`.

## 4. After B21

B22 last: evidence-based evaluation and completion claims
(`evalHarness.ts`, `EvalReportView.tsx`, `perfLog.ts`,
`DiagnosticsDialog.tsx`, `.github/workflows/pr-verify.yml`). Full plan:
`docs/REPAIR-CHECKPOINT-B16A.md` section 8.

## 5. Hard constraints (reminder)

- Branch `repair-r1-r11`, version 0.0.4; everything uncommitted; do NOT
  reset/clean/discard/commit/push/release/bump.
- Use the dedicated file tools; never PowerShell content round-trips.
- Isolated/in-memory datasets only; mocked transports; no paid calls.
- Acceptance must exercise the production path.
- Test-isolation land mines: libraryStore content cache, applied-proposal
  ledger, aiOperations registry, briefCache, repo.resetSessionState,
  Tiptap async destroy, jsdom rect stubs. `storage.ts` uses
  `dws:<path>` localStorage keys in the browser backend — tests can seed
  legacy files directly (see the B21a test). Vitest `findBy*` timeout is
  1000 ms; heavy mounts need `waitFor(..., { timeout: 5000 })`.
