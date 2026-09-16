# Repair handoff — state after B17b (next: B18)

Written 2026-09-16. The tree is VERIFIED GREEN at this checkpoint; nothing
is half-typed. Authoritative per-batch history is the "Repair programme"
section of `docs/IMPLEMENTATION-PROGRESS.md` (B17b entry at the end).

---

## 0. One-line kickoff for a fresh session

> Read `docs/REPAIR-CHECKPOINT-B17B.md` in full, then continue the Decol
> Writing Support repair programme from **B18** using the execution
> discipline in `docs/REPAIR-CHECKPOINT-B16A.md` section 4 (unchanged).
> Do not commit/push/reset/release; preserve all uncommitted and untracked
> work.

---

## 1. Verified state (commands + numbers, run after B17b)

From the project root:
- `npx tsc --noEmit` — OK.
- `npm test` — **486 passed (50 files)**.
- `npm run build` — OK (pre-existing chunk-size warning only).

From `src-tauri`:
- `cargo test --lib` — **89 passed, 1 ignored** (fixture generator).
- `cargo check` — OK.

Known non-failing stderr noise (unchanged): keychain-locked warnings in
`credentialIsolation.test.ts`; one pre-existing React "update while
rendering" warning in `saveAcknowledgement.test.tsx`.

Native schema v12; desktop backup format version 3. Fixture generator:
`cargo test --lib regenerate_backup_contract_fixture -- --ignored` (run it
ONLY if the dump contract changes; B18 may change the source rows — see
below).

## 2. What B17b changed (short version)

- `normalizeEndpoint` preserves endpoint PATH case (scheme/host still
  lowercased); `loadCredential` migrates a pre-B17b all-lowercase account
  forward with a verified write.
- Store: `setConfig` never carries a key across a profile change without
  a key in the same call; `loadConfig` migrates legacy keys only when the
  persisted `keychainAccount` reference matches the computed profile;
  new `forgetCredential(profile?)`.
- Form: the editable key is bound to its normalized profile; provider and
  endpoint changes clear it synchronously and disable Test/Save/Reload
  until the new profile resolves (debounced 250 ms, stale responses
  discarded); "Forget saved key" action.

## 3. B18 — Preserve bibliography identity and metadata (exact next batch)

Files: `src/utils/bibliography.ts`, source input/model
(`src/stores/sourceStore.ts`, `src/types/index.ts`), `src/utils/cslProcessor.ts`,
`src/components/workspace/SourcesPanel.tsx`.

Known state: BibTeX/RIS/CSL JSON interchange and tests exist
(`src/utils/__tests__/bibliography.test.ts`, `src/utils/__tests__/cslProcessor.test.ts`).
`SourceMeta` today carries: id, projectId, title, author, year, doi, url,
language, translation, assetRef, originalText, contentHash,
extractionStatus, truncationNote, includedInContext, notes, verification,
createdAt, updatedAt. There is NO abstract/publisher/type field. The Rust
`SourceRow` mirrors these fields; if the dump shape changes, update
`src-tauri/src/repository.rs` (`SourceRow`, `source_insert`, export/import),
`src/utils/repository.ts` (`SourceMetaWire`), `src/utils/backup.ts`
(`DumpSourceRow` + `normSource`), the JSON backend/fake repository, and
REGENERATE `src/test/backup-contract.json`.

Implement:
- Fix BibTeX's actual multi-author field to use unambiguous separators.
- Preserve structured CSL family, given, and literal organization names.
- Separate notes, abstract, journal/publisher information, and
  translation attribution.
- Parse/serialize RIS notes and CSL notes symmetrically.
- Retain bibliographic type and relevant publication fields; do not turn
  every article into a book.
- Use bibliographic identity such as normalized DOI rather than a
  title/author/year display-line hash.
- Report duplicate/merge decisions.
- Validate recognizable CSL input; unrelated JSON must not create
  invented sources.
- Escape BibTeX values and enforce unique citation keys.
- Expose source metadata editing and the advertised export formats.

Acceptance: round-trip multiple authors, "Linda Tuhiwai Smith," a literal
organization, distinct DOIs with equal titles, notes, a long abstract, and
literal braces without semantic changes.

First three reads:
1. `src/utils/bibliography.ts` — `parseBibTeX`/`parseBibEntry`/
   `serializeBibTeX`, `parseRIS`/`serializeRIS`, `parseCslJson`/
   `serializeCslJson`, `formattedReference`, `bibKey`.
2. `src/utils/__tests__/bibliography.test.ts` +
   `src/utils/__tests__/cslProcessor.test.ts` — the existing interchange
   contract and its gaps.
3. `src/stores/sourceStore.ts` (`addSource`/`updateSource`/dedup inputs)
   and `SourceMeta` in `src/types/index.ts` — what a source can carry.

Test seams: `sourceStore` tests use `fakeRepository`;
`bibliography.test.ts` is pure; `cslProcessor` tests use the bundled CSL
engine. Keep all new fields optional with serde defaults so older backups
still import.

## 4. Hard constraints (reminder)

- Branch `repair-r1-r11`, version 0.0.4; everything uncommitted; do NOT
  reset/clean/discard/commit/push/release/bump.
- Use the dedicated file tools; never PowerShell content round-trips.
- Isolated/in-memory datasets only; mocked transports; no paid calls.
- Acceptance must exercise the production path (real parser/serializer,
  real sources panel controls where possible).

## 5. After B18

B19 → B22 in order; the full remaining plan is in
`docs/REPAIR-CHECKPOINT-B16A.md` section 8.
