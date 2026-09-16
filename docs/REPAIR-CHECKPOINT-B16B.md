# Repair handoff — state after B16b (next: B17a)

Written 2026-09-16. The tree is VERIFIED GREEN at this checkpoint; nothing
is half-typed. Authoritative per-batch history is the "Repair programme"
section of `docs/IMPLEMENTATION-PROGRESS.md` (B16b entry at the end).

---

## 0. One-line kickoff for a fresh session

> Read `docs/REPAIR-CHECKPOINT-B16B.md` in full, then continue the Decol
> Writing Support repair programme from **B17a** using the execution
> discipline in `docs/REPAIR-CHECKPOINT-B16A.md` section 4 (unchanged).
> Do not commit/push/reset/release; preserve all uncommitted and untracked
> work.

---

## 1. Verified state (commands + numbers, run after B16b)

From the project root:
- `npx tsc --noEmit` — OK.
- `npm test` — **474 passed (49 files)**.
- `npm run build` — OK (pre-existing chunk-size warning only).

From `src-tauri`:
- `cargo test --lib` — **83 passed, 1 ignored** (fixture generator).
- `cargo check` — OK.

Known non-failing stderr noise (unchanged): keychain-locked warnings in
`credentialIsolation.test.ts`; one pre-existing React "update while
rendering" warning in `saveAcknowledgement.test.tsx`.

Native schema is now **v12** (B16b added `messages.incomplete TEXT`).
Desktop backup format is still **version 3** (the dump gained a nullable
field; `src/test/backup-contract.json` was REGENERATED from Rust — see
B16b). If the dump contract changes again: `cargo test --lib
regenerate_backup_contract_fixture -- --ignored`.

## 2. What B16b changed (short version)

- New `IncompleteReason = "interrupted" | "truncated"` (`src/types`);
  `ChatMessage.incomplete` + `StoredMessage.incomplete` flow through the
  store, both backends, and Rust schema v12 (`migrate_v12`,
  `check_incomplete_contract` in `apply_dump`).
- `chatSend` commits an interrupted/truncated response WITH usable text as
  a marked assistant message (user message not failed, no retained
  failure); only `outcome: "failed"` (no content) retains Retry.
- `MessageList` renders an amber `role="status"` marker and a "Retry
  answer" button (via the regenerate path) on incomplete messages.
- `requestProposal` refuses interrupted/truncated responses ("cut off; no
  proposal was created").
- `api.ts` evidence accounting: cut excerpts are marked; failed/cancelled
  retrievals are counted separately in the fallback note; a cancelled tool
  batch records `interrupted` evidence and a note
  (`interruptedResearchNote`) that `chatSend` commits for a stopped
  response with no streamed text.
- `evalHarness` reports non-complete samples through `unscoredTask`
  (every dimension 0, `EvalTaskResult.outcome`), never passing them.
- Simplifier pass applied: `storedMessageToRaw`, Rust `insert_message`,
  `evidenceNote` counting inline. No behavior changes.

Limitations (documented in the progress doc): pre-B16b proposals from
cut-off responses carry no marker; stopped answers are not marked; the
partial's Retry is the per-message regenerate path, not a retained-send
snapshot.

## 3. B17a — Complete cancellation (exact next batch)

Files: `src/utils/api.ts`, Rust request/research functions
(`src-tauri/src/lib.rs`), operation service (`src/services/aiOperations.ts`).

Known state: R9/B17 groundwork exists (stream discipline, tool-batch
cancellation checks, manual validated redirects, resolved-address
pinning); the NONSTREAMING fallback (`zen_chat`) and the research
commands (`zen_web_search`, `zen_fetch_page`) may not have cancellable
native lifetimes. B16b added more `content`-note handling in the abort
paths, so re-read those call sites.

Implement:
- Check abort after EVERY awaited phase before advancing or committing.
- Give the nonstreaming fallback and research commands cancellable native
  lifetimes (e.g. `CancellationToken` plumbed like `zen_chat_stream`, or
  abort-aware `tokio::select!`).
- Include response-body reading and DNS resolution in cancellation and
  deadline handling.
- Cancel ACTIVE tool workers, not only prevent new ones.
- Fix IPv4-mapped IPv6 classification and typed public-IPv6 socket
  construction.
- Keep the existing resolved-address verification/pinning.

Acceptance: abort during headers, body, fallback, DNS, and tools causes
no later success/proposal and terminates native work.

First three reads:
1. `src-tauri/src/lib.rs` — `zen_chat`, `zen_chat_stream`,
   `zen_chat_stream_cancel`, `zen_web_search`, `zen_fetch_page`, the
   `HttpClients` setup, and the redirect/address-validation helpers.
2. `src/utils/api.ts` — `streamChat`, `runNonStreamingRound`, the abort
   checks in both adapters (search for `signal?.aborted`).
3. `src/services/aiOperations.ts` — `abortOperation`,
   `invalidateAllOperations`, `isStaleOperation`.

Test seams: `vi.mock("@/utils/api")` for component/service tests; the
`api.test.ts` wire-shaped `mockedInvoke` fixtures (including the
interrupted-tool-batch test added in B16b); Rust unit tests use
connection-based functions and `mem()`.

## 4. Test-isolation land mines (unchanged, re-checked)

- Module-level state: `libraryStore` content cache
  (`invalidateTextContent`), revision applied-proposal ledger
  (`resetAppliedProposalsForTests`), `aiOperations` registry
  (`resetOperations` clears operations AND retained failures),
  `projectStore.briefCache`, repository revisions
  (`repo.resetSessionState()`), `fakeRepository` (`resetFakeRepository`).
- Tiptap destroy is asynchronous; clear registrations with identity
  guards.
- `@tauri-apps/plugin-fs` mocks must export
  `BaseDirectory: { AppData }`.
- jsdom `Text`/`getClientRects`/`scrollIntoView` stubs live in
  `src/test/setup.ts`; heavy editor mounts need
  `waitFor(..., { timeout: 5000 })`.

## 5. Hard constraints (reminder)

- Branch `repair-r1-r11`, version 0.0.4; everything uncommitted; do NOT
  reset/clean/discard/commit/push/release/bump. The user merges PRs and
  publishes releases.
- Use the dedicated file tools; never PowerShell content round-trips.
- Test with isolated/in-memory datasets; never the user's real data;
  mocked transports only (no paid-provider calls).
- Acceptance must exercise the production path the user invokes.

## 6. After B17a

B17b (credential transitions), then B18 → B22 in order; see
`docs/REPAIR-CHECKPOINT-B16A.md` section 8 for the full remaining plan.
