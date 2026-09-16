# Repair checkpoint — after B14, before B15

Written 2026-09-16. The tree is VERIFIED GREEN at this checkpoint; nothing
is half-typed. Authoritative per-batch history is the "Repair programme"
section of `docs/IMPLEMENTATION-PROGRESS.md`; the remaining plan is
`docs/REPAIR-PLAN-B09-B22.md`.

## Completed batch IDs

- B01–B09 — completed in the previous session (see the progress doc).
- B10 — Unify the editor schema and repair export entry points. DONE.
- B11 — Bind proposals to their exact document and session. DONE.
- B12 — Make proposal application match the review display. DONE.
- B13 — Preserve source passages and extraction ownership. DONE.
- B14 — Prepare one operation-aware request. DONE.

Each batch has a full entry in `docs/IMPLEMENTATION-PROGRESS.md` (files,
root causes, tests, remaining limitations).

## Commands actually run at this checkpoint

- `npx tsc --noEmit` — OK (last run after B14).
- `npm test` — 439 passed (47 files).
- `npm run build` — OK (pre-existing chunk-size warning only).
- `cargo test --lib` — 77 passed, 1 ignored (last run at B13; B14 touched
  no native file). `cargo check` — OK.
- No failures, no unverified tests, no scratch files left behind
  (`git status` shows only the intended repair work).

## Current batch state

No batch is in progress. B14 is closed with its acceptance evidence in
the progress doc (prepared preview === captured transport payload for
fresh/retry/regenerate; undefined vs `[]` source picks; cold source
loading; pending uploads; changed briefs).

## Test seams available for later batches

- `setTransportInterceptor` (`src/utils/repository.ts`) for delayed or
  rejected transport; `src/test/fakeRepository.ts` (`fakeRepository`,
  `fakeRepoState`, `resetFakeRepository`).
- `resetOperations()`, `listOperations()`, `startOperation`,
  `settleOperation`, `isStaleOperation`, `appendOutput`
  (`src/services/aiOperations.ts`).
- `messageKey` (`src/stores/chatStore.ts`); message ids are assigned by
  `addMessage` when absent.
- B14: `prepareChatRequest` / `PreparedChatRequest` /
  `resolveInstructionBoundary` (`src/services/chatPrepare.ts`) — the
  prepared object now carries `wireMessages`, `compiled`, `config`,
  `consumedAttachments`, `instruction`, `history`.
- B11: editor registration/ownership in `revisionService.ts`.
- B10: `canonicalExtensions`, `validateRichPayload`, `richBodyProblem`
  (`src/components/editor/editorSchema.ts`).

## Next batch: B15 — failed-send identity and operation-driven UI

Plan (from `docs/REPAIR-PLAN-B09-B22.md`):
stable user-message id before insertion; failed sends linked to their
prepared-request snapshot; retry replays the snapshot; render each
visible owner's operation buffer; A→B→A restores the full buffer;
cleanup execution moved into the shared service with its abort signal;
admission/concurrency policy across full/compact surfaces; errors and
busy controls scoped to the owning operation; bounded finished-operation
retention with credentials stripped from terminal records.

First three reads:
1. `src/services/aiOperations.ts` (operation registry, buffers,
   settlement — the natural home for a bounded registry and a replayed
   request snapshot).
2. `src/services/chatSend.ts` (after B14: preparation is separate; the
   operation currently snapshots `wireMessages` and `config`, and fresh
   sends assign the message id inside `addMessage` — B15 must mint it
   BEFORE insertion and record it on the operation).
3. `src/components/chat/MessageList.tsx` plus
   `src/components/workspace/CompactAssistant.tsx` (failed Retry UI,
   cleanup ownership, streaming buffer rendering, busy/error scoping).

Acceptance to prove: fresh failures expose Retry; two surfaces cannot
start duplicate cleanup; hidden-owner failures remain discoverable;
navigation preserves complete streaming output without showing another
thread's spinner.
