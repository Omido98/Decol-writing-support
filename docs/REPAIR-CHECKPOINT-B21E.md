# Repair handoff — state after B21c + B21e (next: B21d)

Written 2026-09-16. The tree is VERIFIED GREEN at this checkpoint; nothing
is half-typed. Authoritative per-batch history is the "Repair programme"
section of `docs/IMPLEMENTATION-PROGRESS.md` (the last entries are B21c and
B21e). This file supersedes `docs/REPAIR-CHECKPOINT-B21A.md` as the
handoff.

---

## 0. One-line kickoff for a fresh session

> Work in this repository (the decol-writing-support project root)
> on branch `repair-r1-r11`, version 0.0.4. Read this file in full, then
> continue the repair programme from **B21d** (browser/SQLite backup
> dataset parity) using the execution discipline in
> `docs/REPAIR-CHECKPOINT-B16A.md` section 4. Do not commit, push, reset,
> clean, discard untracked files, bump versions, merge, or release.
> Everything is uncommitted (~101 entries); preserve all of it.

---

## 1. Verified state (commands + numbers, run after B21e)

From the project root:
- `npx tsc --noEmit` — OK.
- `npm test` — **556 passed (53 files)**.
- `npm run build` — OK (pre-existing chunk-size warning only).

From `src-tauri`:
- `cargo test --lib` — **96 passed, 1 ignored** (fixture generator).
- `cargo check` — OK.

**Native schema is now v14** (B21e bumped it from v13); the desktop backup
format is still v3 and `src/test/backup-contract.json` is unchanged
(search_index is derived and never exported).

## 2. What B21c and B21e changed

**B21c — deletion/relink invariants.** JSON and SQLite `projectDelete` now
unlink texts, threads AND sources, advance every affected child's revision
(JSON: in-memory + `revisions.json` inside ONE `commitFiles` batch; SQLite:
`UPDATE ... rev = rev + 1` and the new command return
`db_project_delete -> Vec<AffectedChildRow>`), and refresh waiting
debounced payloads (`DomainSaver.refresh` + shared
`applyUnlinkedChildren`/`dropProjectLink`). Every save/create path
sanitizes the project link: JSON `resolveProjectId`, Rust
`live_project_id` (text/thread/source save + create). Import/upsert paths
intentionally preserve dump values. Tests: `repository.test.ts` +7, Rust
+5.

**B21e — FTS triggers for message replacement.** v14 adds
`search_messages_au` (removes the replaced body's row, inserts the new
content) and fixes the over-broad `search_messages_ad` (removed every
message row of the thread). The index has no message identity, so both
triggers match by the exact stored body. `migrate_v14` is self-sufficient
(creates `search_index` if missing) and re-derives every message row,
repairing indexes left stale by either bug. Tests: Rust +2 trigger tests,
plus migration-repair case (g) in `stranded_partial_migrations_are_repaired`;
also fixed a pre-existing temp-dir flake in
`repeated_initialization_is_idempotent` (recycled pids).

## 3. B21d — canonical dataset parity across backends (exact next batch)

### Current asymmetry (verified, not fixed)

- `buildBackupBundle` (`src/utils/backup.ts:283`):
  - Desktop: `invoke("db_export")` -> `normalizeDumpChecked` -> **v3**
    bundle `{format, version: 3, exportedAt, data, preferences}`.
  - Browser: builds a **v1** `{format, version: 1, exportedAt, files}`
    bundle from `V1_STATIC_FILES` (config/settings/zen-prices) plus
    `text_*`/`chat_*`/`project_*` files. It carries NO canonical dump, NO
    sources/passages, NO proposals, and NOT the full preferences record.
- `restoreBackupBundle` (`src/utils/backup.ts:1005`):
  - v3 is desktop-only (`bundle.version >= 2 && !hasTauriFs()` throws at
    :1011).
  - The browser v1 path writes each file with `saveJson(name, data)`
    (:1083-1085) and never deletes domain files the bundle omits, so an
    older/smaller bundle leaves newer live bodies behind (the acceptance
    failure).
- Drafts are preference key `recovery-drafts` (`src/stores/draftStore.ts:66`),
  so a full credential-free preferences record already carries them;
  only the browser export omits that record today.

### Implement

1. Export the SAME canonical dataset from both backends, including
   sources, proposals, drafts (via `preferences["recovery-drafts"]`), and
   applicable preferences. The browser backend must assemble a raw
   canonical object from its JSON files and pass it through the SAME
   validator the import path uses (`buildCanonicalDump` / `normalizeDump` /
   `normalizeDumpChecked`, `backup.ts:691/850/855`) before writing; then
   emit a v3 bundle exactly like the desktop path, with
   `preferences` from `getAllPrefs()` + `withoutSecrets` (mirror the
   desktop code at :305-315).
2. Prevent browser restore from inheriting newer omitted live bodies: a
   restore (v3, and ideally the v1 browser path too) must first clear the
   complete set of known domain files, then commit the dump's files as one
   recoverable generation; omitted bodies must not survive.
3. Round-trip export -> import -> export must be stable.

### Suggested substeps (split rather than changing everything at once)

- **B21d-1** — browser canonical export: raw assembly + validation + v3
  bundle + full preferences. Tests: `backup.test.ts` "backup export
  (browser)" (line 75) and "desktop export path (B01)" (460) style; assert
  the browser bundle's `data` equals the canonical shape for a seeded
  `dws:*` dataset (texts, versions, briefs, messages, sources, passages,
  proposals).
- **B21d-2** — browser v3 restore: allow `version === 3` without Tauri;
  apply `bundle.data` + `bundle.preferences` through the repository (JSON
  backend), replacing the dataset (delete omitted files, then commit the
  new generation through the journal envelope); keep
  `repo.resetSessionState()` + `bumpDatasetGeneration()`. Also make the
  browser v1 path clear omitted domain files before writing, or route it
  through the same replacement path.
- **B21d-3** — parity/round-trip tests + contract check; if the dump
  contract changes, regenerate `src/test/backup-contract.json` with
  `cargo test --lib regenerate_backup_contract_fixture -- --ignored` and
  update validators/fixtures (it should NOT change if only the browser
  assembly is added).

### First three reads for B21d

1. `src/utils/backup.ts` — `buildBackupBundle` (:283),
   `buildCanonicalDump` (:691), `normalizeDump`/`normalizeDumpChecked`
   (:850/:855), `parseBackupBundle` (:871), `restoreBackupBundle` (:1005).
2. `src/utils/repository.ts` — the JSON factory's file naming
   (`textFile`/`versionsFile`/`briefFile`/`sourceFile`/`threadFile`/
   `revisionsFile`), `commitFiles`/`replayPendingCommit` (currently no
   delete/remove support in the journal — extending it with a remove set
   is the clean way to get replace-all restore semantics), and the
   per-entity wire shapes.
3. `src/utils/__tests__/backup.test.ts` — "backup export (browser)" (:75),
   "canonical dump" validation (:179), "backup restore (browser)" (:597);
   also `src/test/backup-contract.json` (v3 fixture, shared with Rust).

Reference mapping for the v1 -> canonical conversion already exists in
Rust (`LEGACY_REGISTRY_FILES`, `db_import_legacy_at` in
`src-tauri/src/repository.rs` around :3016+): mirror its message `idx`
assignment and brief-JSON handling so browser and desktop agree.

Acceptance (from the programme): an export from the SQLite backend and one
from the JSON backend produce the same canonical shape (modulo ids/values);
importing an older dump over newer live bodies replaces them (no omissions
leak through); round-trip export -> import -> export is stable.

## 4. After B21d

- B22 — evidence-based evaluation and completion claims
  (`src/services/evalHarness.ts`, `EvalReportView.tsx`,
  `src/utils/perfLog.ts`, `DiagnosticsDialog.tsx`,
  `.github/workflows/pr-verify.yml`). Full plan:
  `docs/REPAIR-CHECKPOINT-B16A.md` section 8, and the kickoff's B22 item
  (run IDs/cancel ownership, no scoring of errors/stopped/truncated, older
  run must not overwrite newer, numeric-token matching `1492` vs `11492`,
  meaning-proxy threshold, label lexical retention as a proxy, cancellation
  latency or drop the claim, regression tests through real buttons, CI
  prerequisites). UI touches use DESIGN.md; lint only if the contract
  changes.
- B21b-4 (optional hardening): migrate the remaining `withRev` callers
  (`textSnapshot`, thread append/rename/restore/replace/state) to
  `withRevBatched` so the revision joins their batch. Search
  `await withRev(` in `src/utils/repository.ts`.

## 5. Hard constraints (reminder)

- Branch `repair-r1-r11`, version 0.0.4; everything uncommitted; do NOT
  reset/clean/discard/commit/push/release/bump.
- Use the dedicated file tools; never PowerShell content round-trips.
- Isolated/in-memory datasets only; mocked transports; no paid calls.
- Acceptance must exercise the production path; the user publishes
  releases, never the agent.
- Test-isolation land mines: `libraryStore` content cache,
  `resetAppliedProposalsForTests`, `resetOperations`,
  `projectStore.resetForRestore`, `repo.resetSessionState`, Tiptap async
  destroy, jsdom rect stubs, `@tauri-apps/plugin-fs` BaseDirectory mock.
  B21 adds: `dws:<path>` localStorage keys and the `dws:commit-journal.json`
  envelope (simulate a one-shot mid-batch failure by making
  `localStorage.setItem` throw once for a chosen key). Vitest `findBy*`
  timeout is 1000 ms; heavy mounts need `waitFor(..., { timeout: 5000 })`.
