# Repair handoff — state after B17a (next: B17b)

Written 2026-09-16. The tree is VERIFIED GREEN at this checkpoint; nothing
is half-typed. Authoritative per-batch history is the "Repair programme"
section of `docs/IMPLEMENTATION-PROGRESS.md` (B17a entry at the end).

---

## 0. One-line kickoff for a fresh session

> Read `docs/REPAIR-CHECKPOINT-B17A.md` in full, then continue the Decol
> Writing Support repair programme from **B17b** using the execution
> discipline in `docs/REPAIR-CHECKPOINT-B16A.md` section 4 (unchanged).
> Do not commit/push/reset/release; preserve all uncommitted and untracked
> work.

---

## 1. Verified state (commands + numbers, run after B17a)

From the project root:
- `npx tsc --noEmit` — OK.
- `npm test` — **477 passed (49 files)**.
- `npm run build` — OK (pre-existing chunk-size warning only).

From `src-tauri`:
- `cargo test --lib` — **89 passed, 1 ignored** (fixture generator).
- `cargo check` — OK.

Known non-failing stderr noise (unchanged): keychain-locked warnings in
`credentialIsolation.test.ts`; one pre-existing React "update while
rendering" warning in `saveAcknowledgement.test.tsx`.

Native schema is v12; desktop backup format is version 3
(`src/test/backup-contract.json` regenerated in B16b). Fixture generator:
`cargo test --lib regenerate_backup_contract_fixture -- --ignored`.

## 2. What B17a changed (short version)

- Rust: `race_cancel` + one cancellation registry (`StreamState`) for
  streams, the one-shot `zen_chat` fallback, and research tools.
  `zen_chat_stream_cancel` is the generic cancel; a cancel that beats its
  request leaves a pre-cancelled tombstone. `zen_chat`, `zen_web_search`,
  and `zen_fetch_page` accept an optional `id`, race DNS/headers/body
  reads, and release their registry entry when done.
- Security: IPv4-mapped IPv6 addresses follow the IPv4 block list;
  bracketed IPv6 literals (`[::1]`) are classified; IPv6 literals build a
  typed `SocketAddr` instead of a string round-trip; address
  verification/pinning unchanged.
- TS: `invokeAbortable` gives non-streaming commands a stable id and
  cancels that exact native request on abort; both adapters treat aborts
  as `stopped` after every awaited phase; active tool workers receive the
  signal; an interrupted batch's note counts only genuinely finished
  retrievals.

Limitations (documented in the progress doc): model-list/pricing commands
remain non-cancellable; post-Stop tool results are discarded by design;
the cancel command keeps its historical name.

## 3. B17b — Credential transitions (exact next batch)

Files: `src/components/settings/ApiConfigForm.tsx`, `src/utils/keychain.ts`,
configuration store (`src/stores/chatStore.ts` `setConfig`/`loadConfig`).

Known state: R7 already keys credentials by normalized provider+endpoint
account, verifies writes, and prevents cross-profile reuse;
`src/stores/__tests__/credentialIsolation.test.ts` exists.

Implement:
- Bind the editable key to normalized profile identity (the input's key
  belongs to ONE profile; editing provider/baseUrl must not carry it).
- Clear/invalidate the key synchronously when provider or endpoint
  changes (before any await), so an immediate Test/Reload/Save can never
  send the old profile's key to the new endpoint.
- Disable authenticated actions until the (new) profile resolves.
- Enforce ownership in the store as well as the form.
- Preserve case-sensitive URL paths in account normalization.
- Migrate legacy credentials only with established original-profile
  provenance.
- Add an explicit Forget credential action.

Acceptance: URL A→B and immediate Test/Reload/Save never sends A's key to
B; stale keychain/model/test responses cannot overwrite new inputs.

First three reads:
1. `src/components/settings/ApiConfigForm.tsx` — the editable key state,
   Test/Save/Reload handlers, and their async guards.
2. `src/utils/keychain.ts` — `credentialAccount`, `loadCredential`,
   `saveCredential`, `deleteCredential`, legacy migration helpers.
3. `src/stores/chatStore.ts` — `setConfig`/`loadConfig` credential
   resolution + `src/stores/__tests__/credentialIsolation.test.ts`.

Test seams: mock `@tauri-apps/api/core` invoke plus the keychain module
(see `credentialIsolation.test.ts`); `setPref`/`getPref` preference
state; `resetPreferenceState()`.

## 4. Hard constraints (reminder)

- Branch `repair-r1-r11`, version 0.0.4; everything uncommitted; do NOT
  reset/clean/discard/commit/push/release/bump.
- Use the dedicated file tools; never PowerShell content round-trips.
- Isolated/in-memory datasets only; mocked transports; no paid calls.
- Acceptance must exercise the production path (real form controls,
  real store actions), not helpers alone.

## 5. After B17b

B18 → B22 in order; the full remaining plan is in
`docs/REPAIR-CHECKPOINT-B16A.md` section 8.
