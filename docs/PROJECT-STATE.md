# Project state — Decol Writing Support

Recorded 2026-09-17, after v0.1.3 (published). Applies to `main` at 8d8ead1.
This is the short, durable reference for starting work; the complete
per-batch history is `docs/IMPLEMENTATION-PROGRESS.md`.

## Verified state at programme close

Last full run (F13 batch, 2026-09-16), all green:

- `npx tsc --noEmit` — OK.
- `npm test` — 593 passed (54 files).
- `npm run build` — OK (pre-existing chunk-size warning only).
- `cargo test --lib` (from `src-tauri`) — 97 passed, 1 ignored (fixture
  generator).
- `cargo check` — OK.

Data contracts:

- Native SQLite schema **v14** (`SUPPORTED_SCHEMA_VERSION` in
  `src-tauri/src/repository.rs`); rich-content schema v1
  (`SUPPORTED_CONTENT_SCHEMA_VERSION`).
- Desktop backup format **v3** (`BACKUP_VERSION` in `src/utils/backup.ts`),
  format id `decol-writing-support-backup`.
- The canonical dump contract is frozen: `src/test/backup-contract.json`
  changes only together with an intentional format version bump, and is
  regenerated from `src-tauri` with
  `cargo test --lib regenerate_backup_contract_fixture -- --ignored`.

## End-to-end UI verification checklist

Automated gates do not cover the GUI. Run this against an ISOLATED native
dataset before accepting a dataset-affecting change (the agent cannot drive
the GUI):

1. Cold-start with existing projects, conversations, manuscripts, and
   recovery drafts.
2. Edit, navigate immediately, return, Save, edit again during delayed
   persistence.
3. Switch conversations from every navigation surface and send through a
   mocked local endpoint (mocked transport / `setTransportInterceptor`).
4. Request a revision in A, navigate to B, verify A's proposal cannot
   modify B.
5. Add a multipage source, toggle inclusion/verification, retain its
   passages.
6. Insert citations and source-linked footnotes.
7. Export Markdown and DOCX through the actual UI.
8. Export a backup and import that exact file.
9. Restore over already-open entities with identical IDs.
10. Restart and verify content, history, drafts, sources, proposals,
    preferences, and relationships.
11. Repeat relevant paths with rejected/delayed persistence and interrupted
    AI responses.
12. Test the supported minimum window size and keyboard-only navigation.

## Test-isolation land mines

Module-level state that leaks between tests unless reset:

- `libraryStore` content cache: call
  `useLibraryStore.getState().invalidateTextContent(id)` between tests that
  change a body.
- `revisionService` applied-proposal ledger:
  `resetAppliedProposalsForTests()`.
- `aiOperations` registry: `resetOperations()` clears BOTH operations and
  retained failed sends; `invalidateAllOperations()` also clears retained
  failures (restore semantics).
- `projectStore` brief cache (`briefCache`), cleared by `resetForRestore`.
- Repository revisions cache: `repo.resetSessionState()`.
- Tiptap editor destroy is asynchronous (~1 ms setTimeout); clear
  registrations with identity guards, not unconditional nulls.
- `@tauri-apps/plugin-fs` mocks in jsdom tests must export
  `BaseDirectory: { AppData: ... }` (storage/preferences import it).
- jsdom needs `Text`/`Element.prototype.getClientRects` stubs and
  `scrollIntoView` (already in `src/test/setup.ts`).
- Vitest default `findBy*` timeout is 1000 ms; heavy editor mounts need
  `waitFor(..., { timeout: 5000 })`.
- `jszip` is available (transitive via `docx`) and is the accepted way to
  inspect DOCX XML in tests.

## Test seams available

- `setTransportInterceptor(fn)` (`src/utils/repository.ts`) for delayed or
  rejected transport; `src/test/fakeRepository.ts` (`fakeRepository`,
  `fakeRepoState`, `resetFakeRepository`).
- `resetPreferenceState()`, `resetBootstrap()`, `repositorySaveState()`,
  `subscribeSaveState()`.
- `resetOperations()`, `listOperations()`, `startOperation`,
  `admitOperation`, `settleOperation`, `isStaleOperation`, `appendOutput`,
  `activeOperationForThread`, `operationsVersion`, `subscribeOperations`
  (`src/services/aiOperations.ts`).
- Failed sends: `rememberFailedSend`, `getFailedSend`, `takeFailedSend`,
  `failedSendsForThread`, `forgetFailedSendsForThread`,
  `failedSendsVersion`, `subscribeFailedSends`; UI hooks
  `useThreadOperation` / `useThreadFailedSends`
  (`src/components/chat/useThreadOperation.ts`); `cleanupMessage`
  (`src/services/chatSend.ts`).
- `messageKey(msg)` (`src/stores/chatStore.ts`); `addMessage` assigns an id
  when absent. `commitToOwner(threadId, {kind:"append"|"replace"})`.
- `prepareChatRequest`, `PreparedChatRequest`, `resolveInstructionBoundary`
  (`src/services/chatPrepare.ts`); `usePreparedPreview`.
- `sourceStore.addSource(input, guard?)`, `derivePassages`, `finishPages`.
- `setActiveEditor`, `clearActiveEditor`, `getActiveEditorDocumentId`,
  `subscribeActiveEditor`, `subscribeProposalChanges`, `acceptProposal`,
  `requestProposal`, `resetAppliedProposalsForTests`.
- Editor schema: `canonicalExtensions`, `validateRichJson`,
  `validateRichPayload`, `richBodyProblem`
  (`src/components/editor/editorSchema.ts`).
- Streaming completeness: `ApiResponse.outcome`
  (`complete | stopped | interrupted | truncated | failed`);
  `sendMessage`/`deslopText` mocked via `vi.mock("@/utils/api")`; Rust
  accumulator `openai_done`, `openai_drain_remaining`, `wants_drain()`,
  `capture_usage()`.

## Known limitations

Kept per batch, with the consolidated summary at the end of the F13 entry
in `docs/IMPLEMENTATION-PROGRESS.md` (search "Known limitations across the
programme"). Deferred out-of-scope items are listed there too.

## Where the history lives

`docs/IMPLEMENTATION-PROGRESS.md`, in order:

- R1–R11 — Phase 1–2 repair (data contract, atomic saves, revisions,
  migration/import, backup/restore, drafts, credentials, AI operations,
  streaming, test gates).
- 3.1–5.5 — Phase 3–5 features (workspace shell, editor, sources,
  reviewable revisions, BibTeX/RIS/Zotero, citations, DOCX, CSL styles,
  evaluation harness).
- D1–D5 — deferred design notes.
- B01–B22 — repair programme (backups, navigation, drafts, saver,
  maintenance, migration, recovery snapshots, editor schema, proposals,
  sources, requests, failed sends, response completeness, cancellation,
  credentials, bibliography, footnotes, find/shortcuts, palette,
  panels/accessibility, browser parity, evaluation).
- F01–F13 — follow-up programme (retry gating, commit-journal replay, error
  drafts, export drains, conflict adoption, atomic JSON writes,
  resource/credential bounds, SSRF classifier, cancel latency, UI edges,
  evaluation/bibliography edges, credential hygiene, cleanups).
