# Repair handoff — state after B16a (next: B16b)

Written 2026-09-16. The tree is VERIFIED GREEN at this checkpoint; nothing
is half-typed. Authoritative per-batch history is the "Repair programme"
section of `docs/IMPLEMENTATION-PROGRESS.md`; the original remaining-batch
plan is `docs/REPAIR-PLAN-B09-B22.md`. This document is the fresh-window
kickoff: read it in full, then continue with B16b.

---

## 0. One-line kickoff for a fresh session

> Read `docs/REPAIR-CHECKPOINT-B16A.md` in full, then continue the Decol
> Writing Support repair programme from **B16b** using the execution
> discipline in section 4. Do not commit/push/reset/release; preserve all
> uncommitted and untracked work.

---

## 1. Project, objective, environment, hard constraints

Project: Decol Writing Support — local-first Tauri 2 desktop app for
writing essays/articles/academic texts from a decolonial perspective,
with a rich-text manuscript editor, projects, AI conversations, research
sources, citation formatting, and reviewable AI proposals.

Workspace: this repository (the decol-writing-support project root).

Objective: finish the repair programme B16b → B22 (plan below), one
coherent batch at a time, with tests that exercise the PRODUCTION path
the user invokes (real buttons, real parser, real repository adapter /
real SQLite where possible).

Stack / environment:
- Windows ARM64; PowerShell 5.1; no `rg`; no Edge (Chrome at
  `C:\Program Files\Google\Chrome\Application\chrome.exe`).
- Node 24, npm. Tauri 2, Rust, bundled SQLite via rusqlite. React 19,
  TypeScript, Zustand 5. Tiptap/ProseMirror 3. Tailwind 4, Base UI/shadcn.
- Locally bundled CSL styles + citeproc. DOCX via `docx` (jszip is
  transitively available and already used in tests for DOCX XML
  inspection). pdfjs-dist for PDFs.

At review time — do NOT alter:
- Branch `repair-r1-r11`, version 0.0.4. Everything is uncommitted;
  ~90 entries in `git status` including important untracked files
  (`src-tauri/src/repository.rs`, `src/services/`, `src/components/workspace/`,
  `src/components/editor/`, `docs/IMPLEMENTATION-PROGRESS.md`,
  `src/test/backup-contract.json`, `.github/workflows/pr-verify.yml`).
- Current native schema version is 11. Current desktop backup format is
  version 3.
- Do NOT reset, clean, discard untracked files, release, bump versions,
  commit, or push unless separately requested. The user merges PRs and
  publishes releases.
- Use the dedicated file tools (Read/Write/Edit/Grep/Glob). Never
  PowerShell `Set-Content`/`Get-Content` round-trips for source edits —
  previous sessions damaged files via re-encoding. Preserve UTF-8.
- `src-tauri/target/` is a git-ignored build cache that can be deleted
  freely (~15 GB) if disk space is needed.

Machine conventions (global `~/.config/opencode/AGENTS.md`):
- Release/local-install process: project `AGENTS.md`. Releases are always
  drafts; the agent NEVER publishes; release tasks go to the
  `release-manager` subagent.
- UI design work uses the `design-md` skill and the project `DESIGN.md`
  contract; `npx -p @google/design.md designmd <lint|diff|export|spec>`
  for the Google linter (never install globally; on Windows use the
  `designmd` bin alias).
- Delegation: `simplifier` after a feature/refactor is implemented and
  verified (one evidence-backed pass); `notes-curator` when a decision
  note is written; one spawn per checkpoint. B15 received a simplifier
  pass; consider one for B16b/B17a if substantial.

## 2. Required reading order for the fresh session

1. Project `AGENTS.md` (release process, local dev, local install).
2. `DESIGN.md` (design contract) — needed for B19/B20 UI work.
3. `~/.config/opencode/AGENTS.md` (machine conventions).
4. `docs/IMPLEMENTATION-PROGRESS.md` — §"Repair programme" (B01–B16a).
   Treat earlier sections as implementation history, not proof; some
   acceptance statements are overclaimed.
5. `docs/REPAIR-PLAN-B09-B22.md` — the working checklist (may not yet
   reflect B16a; this document is newer).
6. `docs/REPAIR-CHECKPOINT-B15.md` and this document.

## 3. Current verified state (commands + numbers)

From the project root:
- `npx tsc --noEmit` — OK.
- `npm test` — **460 passed (49 files)**.
- `npm run build` — OK (pre-existing chunk-size warning only).

From `src-tauri`:
- `cargo test --lib` — **81 passed, 1 ignored** (the ignored one is the
  backup fixture generator).
- `cargo check` — OK.

Known non-failing stderr noise: keychain-locked warnings in
`credentialIsolation.test.ts`; a pre-existing React "Cannot update a
component while rendering" warning in `saveAcknowledgement.test.tsx`
(also seen historically in `documentEditor.test.tsx`). Neither is a
failure.

If the dump contract changes: regenerate `src/test/backup-contract.json`
from `src-tauri` with
`cargo test --lib regenerate_backup_contract_fixture -- --ignored` and
update validators/fixtures.

## 4. Execution discipline per batch (unchanged)

1. Read the named production call sites and their tests.
2. Add a regression test reproducing the stated failure BEFORE the fix
   (when practical, prove it fails against current code).
3. Fix the smallest coherent boundary.
4. Run focused tests and typechecking.
5. Run the full gates (section 3) and `npm run build`.
6. Update `docs/IMPLEMENTATION-PROGRESS.md` with actual results and
   remaining limitations.
7. Continue in order; split a large batch into numbered substeps
   (e.g. B17a/B17b, B20a/b/c) rather than changing many unrelated systems
   together.
8. Do NOT "fix" a failing test by weakening its assertion, changing the
   mock to skip the production path, or silently dropping unsupported
   data.
9. Paid-provider calls are unnecessary; use mocked transports
   (`setTransportInterceptor`, mocked `invoke`) and isolated temp/in-memory
   datasets for migration/restore tests. Do NOT experiment on the user's
   real app data.
10. Acceptance must exercise the production path; never claim completion
    from helper tests, `can().undo()`, ZIP magic bytes, or preloaded-store
    component tests alone.

## 5. Test-isolation land mines (avoid re-debugging)

- `libraryStore` content cache is module-level: call
  `useLibraryStore.getState().invalidateTextContent(id)` between tests
  that change a body.
- `revisionService` applied-proposal ledger is module-level:
  `resetAppliedProposalsForTests()`.
- `aiOperations` registry is module-level: `resetOperations()` clears
  BOTH operations and retained failed sends; `invalidateAllOperations()`
  also clears retained failures (restore semantics).
- `projectStore` brief cache is module-level (`briefCache`), cleared by
  `resetForRestore`.
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

## 6. Test seams available

- `setTransportInterceptor(fn)` (`src/utils/repository.ts`) for delayed or
  rejected transport; `src/test/fakeRepository.ts` (`fakeRepository`,
  `fakeRepoState`, `resetFakeRepository`).
- `resetPreferenceState()`, `resetBootstrap()`, `repositorySaveState()`,
  `subscribeSaveState()`.
- `resetOperations()`, `listOperations()`, `startOperation`,
  `admitOperation`, `settleOperation`, `isStaleOperation`, `appendOutput`,
  `activeOperationForThread`, `operationsVersion`, `subscribeOperations`
  (`src/services/aiOperations.ts`).
- B15 failures: `rememberFailedSend`, `getFailedSend`, `takeFailedSend`,
  `failedSendsForThread`, `forgetFailedSendsForThread`,
  `failedSendsVersion`, `subscribeFailedSends`; UI hooks
  `useThreadOperation` / `useThreadFailedSends`
  (`src/components/chat/useThreadOperation.ts`); `cleanupMessage`
  (`src/services/chatSend.ts`).
- `messageKey(msg)` (`src/stores/chatStore.ts`); `addMessage` assigns an
  id when absent. `commitToOwner(threadId, {kind:"append"|"replace"})`.
- B14: `prepareChatRequest`, `PreparedChatRequest`,
  `resolveInstructionBoundary`, `preparedInstructionKey`
  (`src/services/chatPrepare.ts`); `usePreparedPreview`.
- B13: `sourceStore.addSource(input, guard?)`, `derivePassages`,
  `finishPages`.
- B11: `setActiveEditor`, `clearActiveEditor`,
  `getActiveEditorDocumentId`, `subscribeActiveEditor`,
  `subscribeProposalChanges`, `acceptProposal`, `requestProposal`,
  `resetAppliedProposalsForTests`.
- B10: `canonicalExtensions`, `validateRichJson`, `validateRichPayload`,
  `richBodyProblem` (`src/components/editor/editorSchema.ts`).
- B16a: `ApiResponse.outcome` (`complete | stopped | interrupted |
  truncated | failed`); `sendMessage`/`deslopText` mocked via
  `vi.mock("@/utils/api")`; both adapters gate tool execution on a
  complete round. Rust accumulator: `openai_done`,
  `openai_drain_remaining`, `wants_drain()`, `capture_usage()`.

## 7. Completed work — B01 through B16a

B01–B09 (previous session, verified at the B09 checkpoint) — see the
progress doc. Summary:
- B01 canonical backup dump types + strict `apply_dump`, content-schema
  ceiling, deterministic export ordering; fixture generated by Rust.
- B02 workspace init + `openDiscussion` as the ONE navigation action.
- B03 capture-before-navigation (`capturePendingEditorChanges`,
  per-session draft keys, keyed DocumentPane).
- B04 draft payloads + Save acknowledgements keyed by edit version.
- B05 domain saver composition/drainage/retries + SaveFailuresDialog.
- B06 acknowledged preference/draft drains; close blocked while work
  cannot be saved.
- B07 exclusive maintenance + dataset-generation counter.
- B08 crash-safe migration activation + repairable migrations.
- B09 validated v3 recovery snapshots; v1 restore through scratch dir.

B10–B14 (previous session, fully verified; details in the progress doc):
- B10 unified editor schema + export entry points; invalid rich JSON is
  never silently replaced; reader/DOCX use the JSON citation collector.
- B11 proposals bound to exact document/session (revision + edit version
  captured before the AI await; ownership re-checks on accept).
- B12 proposal application equals the review display (literal replacement
  construction, selection validation, double-apply ledger, history
  restore draft reconciliation).
- B13 source passages preserved on metadata saves; extraction ownership
  tied to dataset generation; PDF page locators preserved.
- B14 one prepared request consumed by preview and transport
  (`chatPrepare.ts`), distinct fresh/retry/regenerate boundaries,
  `undefined` vs `[]` source picks.

B15 (this session, verified) — failed-send identity and operation-driven
UI:
- `aiOperations.ts`: `userMessageId`; retained-failure registry
  (in-memory, navigation-independent, keyed by thread + message key);
  `admitOperation` = at most ONE running operation per conversation
  across surfaces; terminal records strip the credential; finished
  records bounded (`MAX_RETAINED_OPERATIONS = 20`, running never
  evicted); `invalidateAllOperations` clears retained failures.
- `chatSend.ts`: stable user-message id minted BEFORE insertion and
  recorded on the operation; Retry replays the retained
  `PreparedChatRequest` verbatim (snapshot config included); per-thread
  preparation guard; failures retain the snapshot and set the owner's
  error; `cleanupMessage` shared service (admission guard, abort signal,
  aborted cleanup appends nothing).
- `chatStore.ts`: removed global `isSending`/`streamingText`/
  `sendAbortController`; added per-thread `threadErrors` +
  `setThreadError`; `switchThread` restores the owner's error;
  `deleteThread` forgets retained failures.
- UI: `useThreadOperation`/`useThreadFailedSends`; MessageList renders
  the owner's operation buffer (no global mirror), failure overlay,
  cleanup spinner, labelled `role="status"`; CompactAssistant/ChatTab use
  per-thread operation for Stop/disabled; navigator failure badge.
- Tests: `chatSendOperations.test.ts` (7), `messageListOperations.test.tsx`
  (3), `aiOperations.test.ts` +6, `conversationNavigation.test.tsx` +1.
- Limitations (documented): retained snapshots are in-memory only
  (restart keeps the persisted `failed` marker but re-prepares); hidden
  failures don't persist a marker; no user-facing Stop for cleanup;
  regenerate failures are not in the registry; parallel sends in
  DIFFERENT conversations are now admitted (verify under B17a).

B16a (this session, verified) — shared completeness model + streaming
protocol:
- `ApiResponse.outcome` (`complete | stopped | interrupted | truncated |
  failed`) required on every response; `finishOutcome` separates the
  observed finish reason (`length`/`max_tokens` → truncated) from the
  protocol terminal state (missing signal → interrupted);
  `partialResponse`/`roundResponse` attach outcomes and mark partial
  text at every return site.
- Both adapters GATE tool execution on a complete round; partial text is
  preserved and marked otherwise.
- Rust `StreamAccumulator`: drains the OpenAI usage chunk + `[DONE]`
  after `finish_reason` (bounded, 2 events); `capture_usage` MERGES
  usage objects (Anthropic `message_start` `message.usage` +
  `message_delta` root usage); explicit provider error payloads end the
  stream with an error while partial text stays assembled; normalized
  root-level `usage` in the assembled OpenAI payload.
- Tests: `api.test.ts` +4 wire-shaped fixtures (17 total); Rust +4 (81
  total, 1 ignored).

## 8. What is left — B16b → B22

### B16b — Carry completeness metadata into every consumer
Files: `src/stores/chatStore.ts` (ChatMessage + persistence mapping),
`src/services/chatSend.ts` (result handling), `src-tauri/src/repository.rs`
(`MessageRow`, messages table), `src/utils/repository.ts`
(`StoredMessage`, both backends), `src/services/revisionService.ts`,
`src/services/evalHarness.ts`, `src/utils/api.ts` (`renderEvidence`).

Implement:
1. ChatMessage completeness: add an explicit incomplete marker
   (`interrupted` | `truncated`) OR a visible note. The native `messages`
   table has `failed` but no incomplete column — decide ONE:
   (a) schema v12 migration adding e.g. `incomplete TEXT NULL` (update
   `SCHEMA_VERSION`, migration chain, dump/restore contract + fixture,
   JSON backend, fake repository), or (b) a documented envelope on the
   message content. Prefer (a) only if the migration chain is clean; the
   dump contract change requires regenerating `src/test/backup-contract.json`.
2. chatSend: when `result.outcome` is "interrupted"/"truncated" and
   `result.content.trim()` is non-empty, COMMIT the partial as an
   assistant message carrying the incomplete marker (today a post-output
   error retains the failure but commits nothing, so the partial is lost
   from the thread when the live stream ends/navigates). Keep the user
   message `failed` only when there is no usable content (outcome
   "failed").
3. MessageList: render the incomplete marker visibly (e.g. "Answer
   interrupted — partial response") and keep Retry available.
4. revisionService: refuse proposal creation (or mark the proposal
   incomplete and refuse ordinary acceptance in `acceptProposal`,
   coordinated with B12's accept checks) when `result.outcome` is
   interrupted/truncated. A proposal must never be accepted as a
   complete replacement when its source response was cut off.
5. `renderEvidence`: report evidence cuts and failed retrievals
   accurately (packet status exists; the fallback note does not count
   failed retrievals yet). An interrupted tool batch must be reflected in
   the final note.
6. evalHarness: do not score stopped/truncated/interrupted responses as
   completed samples (also listed under B22).

Acceptance: interrupted/truncated responses survive navigation in the
thread with a visible marker; retry still works; no incomplete proposal
can be accepted; the final UI-facing outcome is asserted through
production paths.

First three reads: `src/stores/chatStore.ts` (`messageToStored`/
`storedToMessage`), `src/services/chatSend.ts` (result handling),
`src-tauri/src/repository.rs` (`MessageRow` + messages table +
migration helpers).

### B17a — Complete cancellation
Files: `src/utils/api.ts`, Rust request/research functions
(`src-tauri/src/lib.rs`), operation service.

Known state: R9/B17 groundwork exists (stream discipline, tool-batch
cancellation checks, manual validated redirects, resolved-address
pinning); the nonstreaming fallback (`zen_chat`) and research commands
(`zen_web_search`, `zen_fetch_page`) may not have cancellable native
lifetimes.

Implement:
- Check abort after every awaited phase before advancing or committing.
- Give the nonstreaming fallback and research commands cancellable native
  lifetimes (e.g. `CancellationToken` plumbed like `zen_chat_stream`, or
  abort-aware `tokio::select!`).
- Include response-body reading and DNS resolution in cancellation/
  deadline handling.
- Cancel active tool workers, not only prevent additional workers.
- Fix IPv4-mapped IPv6 classification and typed public-IPv6 socket
  construction.
- Preserve the existing resolved-address verification/pinning.

Acceptance: abort during headers, body, fallback, DNS, and tools causes
no later success/proposal and terminates native work.

### B17b — Credential transitions
Files: `src/components/settings/ApiConfigForm.tsx`, `src/utils/keychain.ts`,
configuration store (`src/stores/chatStore.ts` setConfig/loadConfig).

Known state: R7 already keys credentials by normalized provider+endpoint
account, verifies writes, and prevents cross-profile reuse;
`src/stores/__tests__/credentialIsolation.test.ts` exists.

Implement:
- Bind the editable key to normalized profile identity.
- Clear/invalidate synchronously when provider or endpoint changes.
- Disable authenticated actions until that profile resolves.
- Enforce ownership in the store as well as the form.
- Preserve case-sensitive URL paths in account normalization.
- Migrate legacy credentials only with established original-profile
  provenance.
- Add an explicit Forget credential action.

Acceptance: URL A→B and immediate Test/Reload/Save never sends A's key to
B. Stale keychain/model/test responses cannot overwrite new inputs.

### B18 — Preserve bibliography identity and metadata
Files: `src/utils/bibliography.ts`, source input/model
(`src/stores/sourceStore.ts`, `src/types/index.ts`),
`src/utils/cslProcessor.ts`, `src/components/workspace/SourcesPanel.tsx`.

Known state: BibTeX/RIS/CSL JSON interchange and tests exist
(`bibliography.test.ts`, `cslProcessor.test.ts`). Source fields are
author/year/doi/url/language/translation/notes/assetRef/originalText/
verification; abstract/publisher/type do NOT exist yet. If the dump shape
changes, update `src/test/backup-contract.json` via the Rust fixture
test. Note from B13: for file sources `contentHash` currently holds the
file-byte hash.

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

Acceptance: Round-trip multiple authors, "Linda Tuhiwai Smith," a literal
organization, distinct DOIs with equal titles, notes, a long abstract,
and literal braces without semantic changes.

### B19 — Faithful footnotes and DOCX export
Files: `src/components/editor/footnoteExtension.ts`,
`citationExtension.ts`, CiteControls in `DocumentEditorView.tsx`,
`src/utils/docxExport.ts`, tests (`src/utils/__tests__/docxExport.test.ts`,
`src/components/__tests__/footnote.test.tsx`, `citation.test.tsx`).
`src/components/__tests__/libraryExport.test.tsx` already inspects
`word/document.xml` and `word/footnotes.xml` via jszip through the real
DOCX button — reuse that pattern.

Implement:
- Escape citation labels and ID attributes in Markdown.
- Give footnotes inspectable/editable text and stable identity.
- Number notes from document order, avoiding duplicate labels after
  deletion.
- Source-backed footnotes retain source ID, passage ID, locator, and
  fallback display text.
- Include them in bibliography collection.
- Report unresolved/deleted source references.
- Export lists recursively, respecting nesting, start values, and
  separate numbering instances.
- Preserve paragraph boundaries, quotation formatting, hyperlinks,
  tables inside quotations, and merged cells.
- Skip empty bibliography sections.
- Provide an explicit append-generated-bibliography option to avoid
  duplication.

Acceptance: Inspect generated DOCX XML and relationships — not just ZIP
size — for exact text order, links, numbering, cell spans, notes, and
bibliography count.

Asset note (unchanged): `assetRef = filename` is not a durable asset.
Either implement a content-addressed asset store + portable archive, or
clearly document that backups preserve extracted text only. This is an
open decision to surface to the user.

### B20a — Find/shortcuts
Files: `src/utils/documentFind.ts`, `DocumentEditorView.tsx`,
`WorkspaceShell.tsx`. `documentFind.test.ts` exists.

Implement:
- Fix case-insensitive offset mapping when Unicode lowercasing changes
  length (e.g. İ).
- Insert replacement strings literally using text transactions (no HTML
  parsing).
- Keep focus in Find during next/previous navigation.
- Scope Save/Find shortcuts to the correct surface.
- Resolve the Link/command-palette shortcut conflict (Ctrl/Cmd+K vs link
  insertion).

Tests: real ProseMirror documents, Unicode ranges, literal HTML-looking
replacement, repeated Enter without manuscript mutation, Escape from
either input.

### B20b — Palette
Files: `src/components/workspace/CommandPalette.tsx`, existing modal
primitive in `src/components/ui/`.

Implement:
- Use the existing modal primitive.
- Add focus trapping/restoration, Escape, IME-safe Enter, and one
  consistent active-result model.
- Ignore stale asynchronous search results.

Tests: slow query A cannot replace B; focused result activates once; Tab
cannot escape behind the palette.

### B20c — Panels/accessibility
Files: `WorkspaceShell.tsx`, `InspectorPanel.tsx`, `ProjectNavigator.tsx`,
`src/index.css`, `DESIGN.md`. `workspaceShell.test.tsx` exists.

Implement:
- Calculate collapse from actual container/panel widths (current
  heuristic uses `window.innerWidth < MIN_CENTRE_WIDTH + 240 + 360`).
- At narrow widths, explicit Show opens a drawer or reachable one-panel
  view.
- Move the inspector resize handle to the inner edge.
- Persist both widths; add keyboard resizing.
- Preserve panel-local state across collapse/focus mode.
- Restore list markers and visible editor focus.
- Implement proper inspector tabs, visible keyboard row actions, and
  expanded/current navigation state.
- Align reader/editor typography and meaningful muted text with the
  design contract.
- Respect reduced motion.

Tests: 900/1080/1200 CSS px, maximum panel widths, 200% zoom,
keyboard-only use, and actual mount/state preservation.

### B21 — Browser parity and derived indexes
Files: JSON backend in `src/utils/repository.ts`, backup converters in
`src/utils/backup.ts`, project deletion paths, search migrations in
`src-tauri/src/repository.rs`. `repository.test.ts` has separate
"repository (JSON backend)" and "repository (SQLite backend)" describes.

Implement:
- Correct revision-map lookups to use `entityKey(kind, id)` consistently.
- Migrate legacy browser history to stable persistent version IDs.
- Commit browser body/history/metadata/revision atomically (IndexedDB or
  a documented transactional envelope).
- Export the same canonical dataset from both backends, including
  sources, proposals, drafts, and applicable preferences.
- Prevent browser restore from inheriting newer omitted live bodies.
- Project deletion must bump/update affected child revisions and refresh
  loaded associations/pending payloads.
- Prevent stale saves from relinking deleted projects.
- Add/update FTS triggers for stable-ID message replacement and rebuild
  stale indexes.

Acceptance: Browser create→save→reload→save works for each entity type.
Mid-write failure leaves a complete old state. Deleted-project children
stay standalone. Replaced messages are searchable only under their new
text.

### B22 — Evidence-based evaluation and completion claims
Files: `src/utils/evalHarness.ts`,
`src/components/settings/EvalReportView.tsx`, `src/utils/perfLog.ts`,
Diagnostics, `docs/IMPLEMENTATION-PROGRESS.md`, CI
(`.github/workflows/pr-verify.yml`, currently untracked).

Implement:
- Give evaluations run IDs and cancel/settlement ownership.
- Stop scheduling tasks after cancellation.
- Do not score errors, stopped, or truncated responses as normal
  completed samples.
- Prevent an older run from overwriting a newer run/controller.
- Match numeric tokens accurately: 1492 must not count as preserved
  inside 11492.
- Fix the meaning-proxy threshold calculation.
- Label lexical retention as a proxy, not semantic verification.
- Record cancellation latency or remove the unsupported measurement
  claim.
- Add regression tests through actual production buttons and conversion
  paths.
- Make CI provision the native prerequisites required by its runner;
  verify the workflow actually runs rather than treating its presence as
  proof.
- Update progress checkboxes only after their real acceptance workflows
  pass.

Acceptance: Cancelled evaluations cannot later report Done. Corrupted
dates/numbers fail fidelity checks. A before/after performance claim
links to actual recorded measurements and output review.

## 9. Final verification scenario (after all batches)

Run against an ISOLATED native dataset:

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
11. Repeat relevant paths with rejected/delayed persistence and
    interrupted AI responses.
12. Test the supported minimum window size and keyboard-only navigation.

## 10. Required checkpoint report (per batch)

After each batch, report:
- Batch/sub-batch IDs completed.
- Files changed.
- Regression scenarios demonstrated (through production paths).
- Commands actually run and results (tsc, npm test counts, build, cargo
  test/check).
- Remaining defects or deliberately unsupported features.
- Exact next batch.

Do not claim completion based only on helper tests, `can().undo()`, ZIP
magic bytes, or preloaded-store component tests. Exercise the production
path the user actually invokes.

## 11. If you run low on context

Write a checkpoint as a new section appended to
`docs/IMPLEMENTATION-PROGRESS.md` or a new
`docs/REPAIR-CHECKPOINT-<next>.md` containing:
- Completed batch IDs with the last green test/typecheck numbers.
- Files changed in the current in-progress batch and their state.
- Current failures (exact test names/messages) and the smallest next
  action.
- The next batch ID and its first three reads.
Then stop. Do not leave the tree in a half-typed state with passing tests
unverified.

## 12. Safety / release notes

- Never release directly from main; releases use a branch and a draft
  release (project `AGENTS.md`).
- The agent NEVER publishes a release or merges a PR.
- Pushing branches/tags never modifies main; tags are never reused.
- Old releases can be deleted by the user at any time.
