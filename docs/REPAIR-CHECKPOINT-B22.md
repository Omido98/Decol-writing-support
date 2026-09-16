# Repair handoff — state after B22 (programme complete)

Written 2026-09-16. The tree is VERIFIED GREEN; nothing is half-typed. This
supersedes `docs/REPAIR-CHECKPOINT-B21E.md` and
`docs/REPAIR-CHECKPOINT-B21D.md` as the handoff. Authoritative per-batch
history is the "Repair programme" section of
`docs/IMPLEMENTATION-PROGRESS.md` (the last entries are B21c, B21e, B21d,
B22).

---

## 1. Final verified state (commands + numbers, run after B22)

From the project root:
- `npx tsc --noEmit` — OK.
- `npm test` — **569 passed (54 files)**.
- `npm run build` — OK (pre-existing chunk-size warning only).

From `src-tauri`:
- `cargo test --lib` — **96 passed, 1 ignored** (fixture generator).
- `cargo check` — OK.

Native schema **v14**; desktop backup format **v3**; the canonical dump
contract is unchanged (`src/test/backup-contract.json` untouched).

## 2. What this session completed

- **B21c — deletion/relink invariants.** JSON and SQLite `projectDelete`
  unlink texts, threads AND sources, advance every affected child's
  revision (JSON: one `commitFiles` batch including `revisions.json`;
  SQLite: `db_project_delete` returns `Vec<AffectedChildRow>`), and
  refresh waiting debounced payloads. Every save/create path sanitizes the
  project link (`resolveProjectId` / `live_project_id`); import/upsert
  paths preserve dump values. +7 TS tests, +5 Rust tests.
- **B21e — FTS triggers for message replacement.** Schema v14 adds
  `search_messages_au`, fixes the over-broad `search_messages_ad`, and
  `migrate_v14` rebuilds the message index (repairable, self-sufficient).
  +2 Rust tests plus migration-repair case (g).
- **B21d — canonical dataset parity.** Both backends now export ONE
  canonical v3 bundle (validated dump + full credential-free preferences
  including `recovery-drafts`); the browser restores a v3 dump through the
  commit envelope with REMOVALS (`commitFiles(files, removePaths)`), so an
  older dump can never leave a newer omitted body behind; preferences are
  replaced, not merged; a Rust-generated dump round-trips through the
  browser field-for-field. +7 backup tests.
- **B22 — evidence-based evaluation.** Eval reports carry a run id and a
  `cancelled` flag; cancelled runs stop scheduling tasks, show partial
  (never Done), and cannot overwrite a newer run; only COMPLETED samples
  are scored and averaged (`mean([]) = 0`); numeric tokens match whole
  (1492 is not inside 11492) and the meaning score IS the retention ratio
  against the 0.6 gate; the report labels meaning as a lexical proxy and
  exposes outputs for review; cancel latency is actually recorded
  (`markCancelRequested` + `recordCancelLatency`) and aggregated in
  Diagnostics; CI installs the Tauri Linux prerequisites. +11 tests.
- **B21b-4 (optional hardening, completed after B22).** The last six
  `withRev` call sites (`textRestore`, thread append/rename/replace/state,
  text state) now use `withRevBatched`, so their content and revision
  commit in one envelope; the unused `withRev` helper was removed. +3
  tests, each proven failing before the migration.

## 3. Final verification scenario (section 12 of the programme)

The agent ran every automated gate (above). The END-TO-END UI scenario
(cold start on an isolated native dataset, navigation/drafts, source
extraction, citation/footnote insertion, Markdown/DOCX export, backup
export → import, restore over open entities, restart, minimum window size,
keyboard-only navigation) was NOT run by the agent: it requires driving
the GUI. Run it before declaring the programme user-verified:

1. `npm run tauri dev` with a fresh/isolated app-data dataset.
2. Walk the 12 steps in `docs/REPAIR-CHECKPOINT-B16A.md` section 9.
3. For the performance claim: run Settings → AI evaluation before/after
   any model change and keep the reports; Diagnostics shows the recorded
   TTFT/duration/cancel-latency aggregates.

## 4. Remaining work

- No repair batches remain: B01-B21e, B21d, B22, and the optional B21b-4
  hardening are all complete and green.
- Known non-blocking limitations are listed per batch in
  `docs/IMPLEMENTATION-PROGRESS.md` (B21b-4/B21c/B21d/B21e/B22 entries).
- The user-owned final steps: run the end-to-end UI scenario (section 3)
  and trigger the CI workflow from the branch.

## 5. Hard constraints (reminder)

- Branch `repair-r1-r11`, version 0.0.4; everything is uncommitted. The
  agent made no commits, pushes, resets, cleans, version bumps, or
  releases. The user merges PRs and publishes releases.
- `.github/workflows/pr-verify.yml` can only be verified by running it on
  GitHub (the agent never pushes); `workflow_dispatch` is enabled, so it
  can be triggered from the Actions tab on this branch.
- Native schema v14; if the dump contract ever changes, regenerate
  `src/test/backup-contract.json` from `src-tauri` with
  `cargo test --lib regenerate_backup_contract_fixture -- --ignored`.
