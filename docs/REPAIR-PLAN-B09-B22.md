# Repair plan — B10 → B22 (handoff)

Written 2026-09-16 at the B08 checkpoint; UPDATED after B09 completed.
This file is the execution plan for the remaining batches. The
authoritative history of what was actually done lives in
`docs/IMPLEMENTATION-PROGRESS.md` (see the "Repair programme" section).

## Current state (verified at this checkpoint)

- Branch `repair-r1-r11`, version 0.0.4, extensive uncommitted work
  (repository.rs is untracked and contains most of the native layer).
- Native schema version 11. Backup format version 3.
- Verification (all green at this checkpoint):
  - `npx tsc --noEmit` — OK
  - `npm test` — 376 passed (42 files)
  - `npm run build` — OK (pre-existing chunk-size warning)
  - `cargo test --lib` — 77 passed, 1 ignored (fixture generator)
  - `cargo check` — OK
- Completed: B01, B02, B03, B04, B05, B06, B07, B08, B09.
- B09 is DONE: recovery snapshots are validated v3 envelopes; v1 imports
  convert through a scratch directory; the legacy importer preserves rich
  bodies, labels, and pin/archive state.
- Do not reset/clean/commit/push/release. Preserve untracked files. Use the
  dedicated file tools (UTF-8 discipline; never PowerShell re-encoding).

## Working method per batch

1. Read the production call sites named in the batch and their tests.
2. Add a regression test that reproduces the stated failure FIRST (prove it
   fails against the current code when practical); never weaken assertions,
   skip the production path, or drop unsupported data to make it pass.
3. Fix the smallest coherent boundary.
4. Run focused tests, then the full gates above.
5. Update `docs/IMPLEMENTATION-PROGRESS.md` with real results and remaining
   limitations.

## B10 — Unify the editor schema and repair export entry points

Files: `src/components/editor/RichTextEditor.tsx`, `src/components/editor/citationExtension.ts`,
`footnoteExtension.ts`, `src/utils/richMarkdown.ts`, `documentCodec.ts`,
`src/components/library/LibraryReader.tsx`, `src/utils/docxExport.ts`.

Known state: the editor builds extensions inline (`StarterKit, TableKit,
Citation, FootnoteRef, Markdown`); the reader and Markdown import/export
paths build their own schemas; `docxExport` collects citations from parsed
JSON with a string scan. `safeParse` turns invalid rich JSON into a code
block (no error state; Save would replace the original with that).

Implement:
1. One canonical extension/schema factory used by editor, reader
   conversion, Markdown import/export, and DOCX preparation (include
   Citation + FootnoteRef consistently).
2. Validate rich JSON against that schema (not just `JSON.parse`). On
   invalid structure: preserve raw bytes, show a recovery/error state, and
   BLOCK normal Save from replacing it with empty content.
3. Derive missing `plainText` from valid rich nodes instead of returning
   serialized JSON.
4. DOCX citation collection: parse the JSON tree (or convert to a real
   schema node) — never substring-match.
5. Handled reader/export errors with Retry.
6. Reader keeps citation labels and footnotes visible without raw HTML.

Acceptance: exercise the actual reader/export buttons; prose around
citations/footnotes survives conversion; unknown nodes never silently
become an empty manuscript.

## B11 — Bind proposals to their exact document and session

Files: `src/services/revisionService.ts`, `src/components/workspace/ReviewPanel.tsx`,
`src/components/editor/DocumentEditorView.tsx`, proposal types/storage.

Implement: register `{documentId, editor, sessionGeneration}` (not a global
untagged editor); capture document revision + editor edit version before the
AI await; structured selection fingerprint + validated range; require
matching document/session ownership before acceptance; unknown revision =
unverified (not valid); guard async loads by document/request identity;
refresh Review when a proposal completes; read mode offers "Open in editor"
instead of Accept; visible load/accept/reject errors.

Acceptance: delayed A proposal can never appear/apply in B (identical words
included); a save during generation does not move the proposal's base rev.

## B12 — Make proposal application match the review display

Files: proposal application (`revisionService`/Review apply path), canonical
schema from B10.

Implement: no raw model strings into HTML-parsing APIs; define the supported
replacement format explicitly; construct literal text/validated nodes;
initially reject protected atoms/complex structure with a clear message;
detect formatting-only changes and out-of-range selections; check the
transaction actually succeeded; persist acceptance + accepted
manuscript/recovery coherently; prevent double application; reconcile dirty
drafts explicitly on history restore.

Acceptance: applied content equals the preview for literal `<...>`,
entities, Unicode, multiline; real Undo restores the original fragment;
failed/stale acceptance changes nothing.

## B13 — Preserve source passages and extraction ownership

Files: `src/stores/sourceStore.ts`, source repository commands,
`src/services/sourceExtraction.ts`, `src/components/workspace/SourcesPanel.tsx`.

Implement: metadata-only saves are explicit (omitted passages = unchanged,
`[]` = clear); inclusion/verification/metadata edits preserve passage
id/content/locator; surface persistence errors; associate extraction with
job id + dataset generation; cancel handles during restore; missing jobs are
not active; recheck ownership before committing a source; empty extraction
is failed/unusable; preserve file-byte identity separately from truncated
text identity; keep PDF page boundaries/locators.

Acceptance: toggle inclusion/verification on a two-passage source and
reload — passages remain. Cancel during hashing / restore during extraction
— no old source/job reappears. Distinct files with equal truncated prefixes
stay distinguishable.

## B14 — Prepare one operation-aware request

Files: `src/services/chatSend.ts`, `src/services/contextCompiler.ts`,
`src/components/tabs/ChatTab.tsx`, `CompactAssistant.tsx`,
`WhatWillBeSent.tsx`.

Implement: one prepared-request object consumed unchanged by preview and
transport; resolve sources/uploads/brief/instruction-history boundaries
once; distinct preparation for fresh/retry/regenerate (regeneration must not
compile the old assistant answer as a new instruction); re-read source state
after awaited hydration; preview includes pending uploads and project-mode
attachments; `undefined` default sources vs `[]` none; define source-pick
lifetime; compact assistant shows context/attachment disclosure.

Acceptance: compare prepared preview vs captured IPC payloads for all three
operations, project mode, pending files, changed briefs, cold source
loading. Uncheck all sources → zero source content sent.

## B15 — Repair failed-send identity and operation-driven UI

Files: `chatSend.ts`, `src/stores/chatStore.ts`, `src/services/aiOperations.ts`,
`MessageList.tsx`, `CompactAssistant.tsx`.

Implement: stable user-message id before insertion (or return it); link
failed sends to their prepared-request snapshot; retry replays the snapshot;
render each visible owner's operation buffer; A→B→A restores A's entire
buffer immediately; move cleanup execution into the shared service with its
abort signal; admission/concurrency policy across surfaces; errors/busy
scoped to the owning operation; bound finished-operation retention and strip
credentials from terminal records.

Acceptance: fresh failures expose Retry; two surfaces cannot duplicate
cleanup; hidden-owner failures discoverable; navigation preserves streaming
output without another thread's spinner.

## B16 — Preserve response completeness through every consumer

Files: `src/utils/api.ts`, Rust stream accumulator (`lib.rs`),
chat/revision/evaluation consumers, message/proposal metadata.

Implement: shared outcome model (complete/stopped/interrupted/truncated/
failed); partial text preserved independently of errors; completeness
metadata on messages/proposals; block ordinary acceptance of incomplete
replacements; separate observed finish reason from protocol terminal state;
read OpenAI usage after the finish chunk; normalized root-level usage; merge
Anthropic usage fields; handle provider error events; never execute tools
from an interrupted round; report evidence cuts/failed retrievals accurately.

Acceptance: offline wire-shaped fixtures (finish→usage→DONE, provider errors
before/after text, output limits, interrupted tool calls); assert the final
UI-facing outcome.

## B17a — Cancellation

Files: `src/utils/api.ts`, Rust request/research functions, operation service.

Implement: check abort after every awaited phase before advancing/committing;
cancellable native lifetimes for the nonstreaming fallback and research
commands; include body reading and DNS resolution in cancellation/deadlines;
cancel active tool workers; fix IPv4-mapped IPv6 classification and typed
public-IPv6 socket construction; keep resolved-address verification/pinning.

Acceptance: abort during headers, body, fallback, DNS, tools → no later
success/proposal and native work terminates.

## B17b — Credentials

Files: `ApiConfigForm.tsx`, keychain helpers, configuration store.

Implement: bind the editable key to normalized profile identity;
clear/invalidate synchronously on provider/endpoint change; disable
authenticated actions until the profile resolves; enforce ownership in the
store as well as the form; preserve case-sensitive URL paths in account
normalization; migrate legacy credentials only with established provenance;
add an explicit Forget credential action.

Acceptance: URL A→B and immediate Test/Reload/Save never sends A's key to B;
stale keychain/model/test responses cannot overwrite new inputs.

## B18 — Preserve bibliography identity and metadata

Files: `src/utils/bibliography.ts`, source input/model, `cslProcessor.ts`,
`SourcesPanel.tsx`.

Implement: BibTeX multi-author separator fix; structured CSL family/given/
literal organization names; separate notes/abstract/journal/publisher/
translation; symmetric RIS notes; retain type and publication fields; use
normalized DOI identity (not title/author/year hash); report duplicate/merge
decisions; validate recognizable CSL input (unrelated JSON must not invent
sources); escape BibTeX values; unique citation keys; expose source metadata
editing and advertised export formats.

Acceptance: round-trip multiple authors, "Linda Tuhiwai Smith", a literal
organization, distinct DOIs with equal titles, notes, a long abstract,
literal braces without semantic changes.

## B19 — Faithful footnotes and DOCX export

Files: footnote/citation extensions, `CiteControls`, `docxExport.ts`,
export tests.

Implement: escape citation labels/ID attributes in Markdown; inspectable/
editable footnotes with stable identity; document-order numbering without
duplicate labels after deletion; source-backed footnotes keep source id,
passage id, locator, fallback display text; include in bibliography
collection; report unresolved/deleted source references; recursive lists
(nesting, start values, separate numbering instances); paragraph
boundaries, quotation formatting, hyperlinks, tables inside quotations,
merged cells; skip empty bibliography sections; explicit
append-generated-bibliography option.

Acceptance: inspect generated DOCX XML/relationships for exact text order,
links, numbering, cell spans, notes, bibliography count.

Asset note (unchanged): `assetRef = filename` is not a durable asset —
either implement a content-addressed asset store + portable archive or
document that backups preserve extracted text only.

## B20a — Find/shortcuts

Unicode case-insensitive offset mapping (e.g. İ); literal replacement via
text transactions; keep focus in Find; scope Save/Find shortcuts; resolve
the Link/palette shortcut conflict. Tests with real ProseMirror documents,
Unicode ranges, literal HTML-looking replacement, repeated Enter, Escape.

## B20b — Palette

Use the existing modal primitive; focus trap/restore, Escape, IME-safe
Enter, one active-result model; ignore stale async results. Tests: slow A
cannot replace B; focused result activates once; Tab cannot escape.

## B20c — Panels/accessibility

Collapse from actual widths; narrow-width explicit Show opens a drawer or
one-panel view; resize handle on the inner edge; persist widths + keyboard
resizing; preserve panel-local state; list markers/editor focus; inspector
tabs, visible keyboard row actions, expanded/current state; reader/editor
typography per DESIGN.md; reduced motion. Tests at 900/1080/1200 px, max
panel widths, 200% zoom, keyboard-only, mount/state preservation.

## B21 — Browser parity and derived indexes

Files: browser repository (`src/utils/repository.ts` JSON backend), backup
converters, project deletion, search migrations.

Implement: revision-map lookups via `entityKey(kind, id)`; migrate legacy
browser history to stable persistent version ids; atomic
body/history/metadata/revision commits (IndexedDB or documented transactional
envelope); same canonical dataset from both backends (sources, proposals,
drafts, preferences); browser restore must not inherit newer omitted live
bodies; project deletion bumps child revisions and refreshes
associations/pending payloads; stale saves cannot relink deleted projects;
FTS triggers for stable-ID message replacement + stale-index rebuild.

Acceptance: browser create→save→reload→save per entity; mid-write failure
leaves a complete old state; deleted-project children stay standalone;
replaced messages searchable only under new text.

## B22 — Evidence-based evaluation and completion claims

Files: `src/utils/evalHarness.ts`, `EvalReportView.tsx`, `src/utils/perfLog.ts`,
Diagnostics, progress doc, CI.

Implement: run IDs + cancel/settlement ownership; stop scheduling after
cancel; do not score errors/stopped/truncated as completed; older run cannot
overwrite newer controller; accurate numeric token matching (1492 not inside
11492); meaning-proxy threshold fix; label lexical retention as a proxy;
record cancellation latency or drop the claim; regression tests through real
buttons/conversion paths; CI provisions native prerequisites and is actually
verified; progress checkboxes updated only after real acceptance passes.

Acceptance: cancelled evaluations cannot report Done; corrupted dates/numbers
fail fidelity checks; performance claims link to recorded measurements.

## Final verification scenario (after all batches)

Run against an ISOLATED native dataset:
cold start with existing data; edit/navigate/return/save; switch
conversations from every surface with a mocked local endpoint; revision in A
while navigating to B; multipage source toggle + passages; citations and
source footnotes; Markdown/DOCX export through the UI; backup export+import;
restore over open identical IDs; restart; repeat with rejected/delayed
persistence and interrupted AI responses; minimum window size + keyboard
navigation.

## Checkpoint report format (per batch)

- Batch/sub-batch IDs completed.
- Files changed.
- Regression scenarios demonstrated.
- Commands actually run and results.
- Remaining defects or deliberately unsupported features.
- Exact next batch.
