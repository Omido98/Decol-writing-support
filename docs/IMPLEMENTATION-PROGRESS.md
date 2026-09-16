# Implementation Progress

Working branch: `repair-r1-r11` (Phase 1â€“2 repair, batches R1 â†’ R11, then Phase 3+).
Verification commands: `npx tsc --noEmit`, `npm test`, `npm run build`, `cargo test --lib` / `cargo check` (from `src-tauri`).

## Completed batches

### R1 â€” Fix the frontend/Rust data contract

Completed: 2026-09-15.

Files changed:
- `src/types/index.ts` â€” `ThreadMeta.mode` is now required (`ThreadMode`); legacy rows are normalized to `"text"` on read by the backends.
- `src/utils/repository.ts` â€” explicit wire types (`TextMetaWire`, `ProjectMetaWire`, `ThreadMetaWire`) and converters (`*ToWire` / `*FromWire`) at the SQLite boundary. `null` wire fields normalize to absent domain fields. Reference material uses the canonical wire name `references` (Rust keeps its internal `refs` column; legacy `refs` payloads stay readable). JSON backend normalizes legacy `threads.json` rows missing `mode`.
- `src/stores/chatStore.ts` â€” `createThread()` sets `mode: "text"`; the synthesized fallback meta in `scheduleThreadSave` includes `mode: "text"`.
- `src/test/repository-contract.json` â€” NEW shared JSON contract fixtures (consumed by frontend tests and Rust serde tests via `include_str!`).
- `src/utils/__tests__/repository.test.ts` â€” new tests: exact contract payloads for thread/project/text create+update paths; null normalization; metadata update preserves `references`; legacy JSON rows lacking `mode`.
- `src/stores/__tests__/chatStore.test.ts` â€” `mode: "text"` added to meta literals (type requirement).
- `src-tauri/src/repository.rs` â€” serde contract: `ThreadRow.mode` defaults to `"text"` for missing/null values; `refs` fields on `ThreadRow`/`ProjectRow` serialize as `references` and deserialize from both `references` and `refs`; `#[serde(default)]` on optional fields for tolerant legacy dumps. New tests: 5 fixture contract tests + `references_survive_create_read_export_import` + `legacy_v2_dump_with_refs_imports`.

Commands run and results:
- `npx tsc --noEmit` â€” OK (after fixing 3 new type errors introduced by the required `mode`).
- `npm test` â€” 141 tests passed (13 files).
- `cargo test --lib` â€” 28 tests passed (was 16, +12 repository contract/roundtrip coverage).
- `cargo check` â€” OK.

Acceptance status (R1):
- [x] Exact `createThread()` payload deserializes into Rust (fixture equality: frontend asserts invoke payload === fixture; Rust asserts fixture deserializes into `ThreadRow`).
- [x] Project/conversation references survive create â†’ read â†’ update â†’ export â†’ import (Rust roundtrip test).
- [x] Metadata update does not clear references (Rust + frontend tests).
- [x] Existing v2 dumps containing `refs` remain supported (serde alias + `legacy_v2_dump_with_refs_imports`).

Known limitations:
- The Rust `refs` column name is unchanged internally; only the wire name changed. `DbDump` exports now contain `references`; old dumps with `refs` read via alias.
- Frontend tests still mock the Tauri transport (no real IPC); real-adapter tests are R11 scope.

### R2 â€” Make saves genuinely atomic and acknowledged

Completed: 2026-09-15.

Files changed:
- `src/utils/repository.ts` â€” rewritten save discipline:
  - Domain saves: `textSave(id, {meta, content?})`, `projectSave(id, {meta, brief?})`, `threadSave(id, {meta, briefJson, messages})` â€” each commits in ONE Rust transaction; debounced variants `textScheduleSave`/`projectScheduleSave`/`threadScheduleSave` coalesce per entity.
  - Per-entity queues (`enqueue(entityKey, op)`): operations never invoke before entering the queue; deletes queue after in-flight writes so nothing resurrects.
  - Persisted revision counters + expected-revision checks: saves carry `expectedRev`; stale updates are rejected (`Stale revision: expected N, current M`), classified `stale` / `missing` / `error`.
  - Failure registry: failed scheduled saves retain their latest payload with `retry()`; `saveFailures()`, `retrySave(key)`, `subscribeSaveState()`, `resetSessionState()` exposed; timer-fired failures never become unhandled rejections.
  - Flushes (`flushTextSaves`/`flushProjectSaves`/`flushThreadSaves`) attempt all pending and reject on first failure while retaining payloads.
  - Wire rows now carry `rev`; the SQLite adapter maintains a revision cache fed by lists/get/save responses; JSON backend persists revisions in `revisions.json` and serializes ALL registry read-modify-write cycles through a global queue (concurrent mutations can no longer clobber registries).
  - Test seam: `setTransportInterceptor(fn)` for delayed/rejected-transport tests (thunks start only when the interceptor calls them).
- `src/stores/libraryStore.ts` â€” `updateText` issues one domain save (metadata+content together; metadata-only saves are immediate and awaited); restore/reset paths clear the revision cache.
- `src/stores/projectStore.ts` â€” `createProject` uses `projectCreate`; `updateProject` issues one domain save (metadata+brief together); reset path clears revision cache.
- `src/stores/chatStore.ts` â€” `createThread` uses `threadCreate` (update-only saves afterwards); metadata updates (mode/references/title) ride the debounced whole-thread save instead of a separate upsert; `switchThread`/`createThread` tolerate failed flushes (retained for retry).
- `src/App.tsx` â€” close drain uses `Promise.allSettled` so one failing domain drain cannot skip the others.
- `src-tauri/src/repository.rs` â€” schema v2: `rev` columns on texts/projects/threads (column-existence-checked ALTER); databases newer than `SUPPORTED_SCHEMA_VERSION` are refused; `text_create`/`project_insert`/`thread_create` are INSERT-only (create â‰  update); `text_save`/`project_save`/`thread_save` are update-only, bump `rev`, accept `expected_rev` and reject stale writes inside the transaction; `thread_append_message` bumps `rev` so pre-append whole-thread saves are rejected; restore bumps `rev` and returns the new one; imports preserve row revisions.
- `src-tauri/src/lib.rs` â€” command registrations updated (removed `db_text_update_meta`, `db_text_set_content`, `db_project_upsert`, `db_project_set_brief`, `db_thread_upsert`; added `db_text_save`, `db_project_create`, `db_project_save`, `db_thread_create`).
- `src/test/fakeRepository.ts` â€” implements the new interface with create/update split, revision counters, update-only semantics.
- Tests: `src/utils/__tests__/repository.test.ts` (rewritten + new R2 cases), store test fixtures gained `rev` fields, Rust tests rewritten for the new API + new stale/missing/duplicate/schema-version cases.

Commands run and results:
- `npx tsc --noEmit` â€” OK.
- `npm test` â€” 146 tests passed (13 files).
- `cargo test --lib` â€” 33 tests passed.
- `cargo check` â€” OK.
- `npm run build` â€” OK (chunk-size warning pre-exists).

Acceptance status (R2):
- [x] Successful Save followed immediately by reopening contains the saved content.
- [x] Failed content persistence leaves no committed metadata describing unsaved content.
- [x] Save â†’ append â†’ save cannot silently remove an appended reply (Rust + delayed-transport frontend tests).
- [x] Save â†’ delete cannot resurrect the entity.
- [x] A failed timer write causes flush to fail visibly and retains a retryable payload.
- [x] Concurrent JSON-backend mutations do not overwrite each other's registries.

Known limitations:
- Retrying a stale thread save is "user wins": it overwrites the intermediate append (explicit choice; the UI for this lands with the R6 draft/session layer).
- "Saved" UI indicators still pending (R6 wires acknowledged-state display; the repository now only resolves saves after commit).

### R3 â€” Make revision history authoritative and collision-safe

Completed: 2026-09-15.

Files changed:
- `src-tauri/src/repository.rs`:
  - Schema v3: `text_versions` rebuilt with a stable `version_id` PK (`(text_id, version_id)`); legacy rows migrated with generated ids, preserving timestamps and content; version cap orders by `saved_at` but identifies rows by id. DBs newer than `SUPPORTED_SCHEMA_VERSION` (3) are refused.
  - `text_save` no longer takes snapshot flags from the frontend: the snapshot decision (compare persisted old vs new content) happens inside the transaction.
  - `next_version_id()` â€” nanos + process counter; same-millisecond snapshots stay distinguishable.
  - `text_restore(id, version_id, now, expected_rev)` â€” resolves the target content INSIDE Rust from the stable version id; rejects missing ids, wrong-document ids, and stale expected revisions without mutation; snapshots the replaced current content; derives snippet/word count; returns `RestoreResult {rev, savedAt, content, snippet, wordCount, updatedAt}`.
  - `project_delete` is now one domain operation: unlinks texts AND threads (`project_id` â†’ NULL), removes the brief, deletes the project â€” all in one transaction; nothing dangling remains.
  - Import paths generate version ids for legacy/dump rows lacking them; exports carry ids.
- `src/types/index.ts` â€” `TextVersion` gains `versionId`.
- `src/utils/repository.ts` â€” `TextSaveArgs` lost `snapshotCurrent`/`versionSavedAt`; `textRestore(id, versionId)` returns `TextRestoreResult`; JSON backend mirrors the in-transaction snapshot comparison, restores by version id, and `projectDelete` unlinks texts+threads in one registry pass; version ids generated for JSON snapshots.
- `src/stores/libraryStore.ts` â€” `updateText` no longer computes snapshot flags; `restoreVersion(id, versionId)` refreshes cache/meta from the authoritative result.
- `src/stores/projectStore.ts` â€” doc comment: the repository unlinks in the delete operation.
- `src/components/library/HistoryDialog.tsx` â€” selection/keying by `versionId`.
- `src/components/library/ProjectDetail.tsx` â€” removed the manual per-text unlink loop (the domain op handles texts AND conversations).
- `src/test/fakeRepository.ts` â€” mirrors the R3 semantics.
- Tests: Rust (same-ms distinguishable, editâ†’saveâ†’save history, restore-by-id resolution, wrong-doc/missing restore without mutation, stale restore rejection, project unlink, v3 migration) and frontend (history preservation on double save, restore by version id, missing-version failure, project delete unlinking); libraryStore tests updated to `versionId`.

Commands run and results:
- `npx tsc --noEmit` â€” OK.
- `npm test` â€” 149 tests passed (13 files).
- `cargo test --lib` â€” 39 tests passed.
- `cargo check` â€” OK.

Acceptance status (R3):
- [x] Two different revisions with identical timestamps remain distinguishable.
- [x] Edit â†’ Save â†’ Save again before debounce does not lose history.
- [x] Restoring a missing or wrong-document revision fails without mutation.
- [x] Restore failure leaves the reader/cache displaying the last committed document (restore rejects before any write).
- [x] Project deletion leaves no dangling live project references (texts + conversations unlinked in one op).
- [x] Additive schema migration preserving legacy timestamps/history; newer schema versions rejected.

Known limitations:
- The restore's snapshot timestamp for replaced content comes from the frontend's `now` (one argument); version identity does not depend on it.

### R4 â€” Replace unsafe migration with a validated import

Completed: 2026-09-15.

Files changed:
- `src-tauri/src/repository.rs` â€” migration core rewritten as an inventory â†’ validate â†’ import â†’ verify â†’ archive pipeline:
  - `read_json_classified` distinguishes missing / unreadable / malformed; read and parse failures are never treated as "missing".
  - `build_legacy_dataset(dir)` builds the WHOLE validated dataset in memory before anything is activated. A malformed/unreadable REGISTRY file aborts with issues â†’ `completed: false`, no marker, no archive, no import. Invalid individual records (including ids that fail `is_safe_id` â€” checked BEFORE any path is constructed) are skipped and reported as issues. Orphan body/history files (no registry entry) are inventoried in the report, never imported, never touched.
  - `run_legacy_import` imports the dataset + sets the `legacy_imported` marker in ONE transaction, then `verify_import` checks counts, byte-level content equality, and relationships before commit. Archive only happens after commit.
  - `archive_files` writes to a UNIQUE `legacy/<run>` directory per run â€” previous archives are never overwritten; files that cannot be moved stay in place.
  - `init_at(dir, db)` â€” testable init core: idempotent no-op (with `already_open` flag) when the repository is already open; `db_init` now returns a `MigrationReport` (counts + issues + archived dir). `db_import_legacy` (v1 restore) fails visibly on malformed input instead of importing partial data.
- `src/utils/bootstrap.ts` â€” rewritten: inventories `dws:*` browser copies and reconciles them safely â€” adoption only writes to a MISSING native file and removes the copy only after success; identical copies are deduplicated; conflicting native/browser versions are BOTH preserved and reported (native is never silently assumed newer); malformed copies are kept and reported. Bootstrap resets its cached promise on failure so startup can be retried; returns `BootstrapResult { migration, issues, adopted }`.
- `src/utils/storage.ts` â€” `loadJson` no longer silently adopts (and deletes) legacy `dws:*` copies on a native miss; that side-effecting path is gone (adoption is exclusively the verified bootstrap's job).
- `src/App.tsx` â€” startup error screen rewritten (accurate text: nothing was imported, no files deleted, Retry button); a recovery-report banner lists malformed/orphan/conflict findings after a completed migration.
- Tests: `src/utils/__tests__/bootstrap.test.ts` (NEW: adoption, permission failure preserves the copy, malformed kept, conflicts preserved, dedupe, incomplete report surfacing, retry), `storage.test.ts` (adoption test replaced by no-side-effects test), Rust tests (malformed registry blocks marker; unreadable content preserved; orphans inventoried; unsafe ids rejected; Unicode + legacy array threads survive; idempotent init; unique archive dirs; rewritten import tests).

Commands run and results:
- `npx tsc --noEmit` â€” OK.
- `npm test` â€” 156 tests passed (14 files).
- `cargo test --lib` â€” 46 tests passed.
- `cargo check` â€” OK.
- `npm run build` â€” OK.

Acceptance status (R4):
- [x] Permission failure preserves the dws: copy.
- [x] Malformed registry prevents a successful migration marker.
- [x] Interruption before commit leaves no partially activated dataset (single transaction: rows + marker; verification before commit).
- [x] Repeating initialization does not duplicate or overwrite imported data.
- [x] Conflicting copies and orphan files appear in the report (startup recovery banner).
- [x] Legacy array-shaped conversations and Unicode content retain their data.
- [x] Migration testing uses isolated temporary directories (`init_at`, `run_legacy_import` take a storage root).

Known limitations:
- Conflicting browser copies are preserved in their `dws:*` key with a report pointer; an explicit conflict-resolution UI (choose a winner) is deferred until the Phase 3 workspace shell.

### R5 â€” Make backup/restore an exclusive, validated operation

Completed: 2026-09-15.

Files changed:
- `src-tauri/src/repository.rs`:
  - Schema v4: `preferences` table (key/value, JSON-encoded values).
  - `apply_dump(tx, dump)` â€” dump application on an open transaction; `db_restore(dump, prefs)` replaces domain rows AND preferences in ONE transaction and returns real `RestoreCounts` (texts/projects/threads/messages/versions); `db_import_legacy` returns `MigrationCounts` instead of a file count. `db_prefs_get/get_all/set` commands. Migration bookkeeping (app_meta) is never exported and never touched by a restore.
- `src/utils/preferences.ts` â€” NEW: `getPref`/`getAllPrefs`/`setPref` â€” SQLite preferences on desktop, localStorage in browser; credentials never pass through here.
- `src/utils/backup.ts` â€” rewritten:
  - v3 format: `{ format, version: 3, data: <dump>, preferences }` (v1/v2 readers retained; `BACKUP_VERSION = 3`).
  - Export drains pending saves BEFORE the barrier goes up (synchronous hand-off), then holds newly scheduled saves and releases them after the snapshot â€” "export right after Save includes that save".
  - `parseBackupBundle` deeply validates v2/v3 dumps: row shapes, duplicate ids, relationship integrity (contents/versions/briefs/messages referencing known parents), content types, supported versions; rejects bundles carrying a credential.
  - Restore runs one exclusive barrier: aborts active AI ops (via callback), blocks persistence (`beginMaintenance`), drains, writes a recovery snapshot of the CURRENT dataset (`pre-restore-<ts>.json`), commits restored domain data + preferences in one `db_restore`, discards held pre-restore saves (`endMaintenance("discard")`), and bumps the dataset generation. Desktop backups are rejected in browser dev BEFORE anything changes. v1 restores route settings into preferences (credentials stripped) and report real counts.
  - `datasetGeneration()` exported (AI-operation invalidation lands in R8).
- `src/stores/settingsStore.ts` / `src/stores/chatStore.ts` / `src/components/settings/ApiConfigForm.tsx` â€” preferences now read/write the SQLite table (legacy `settings.json`/`config.json`/`zen-prices.json` are migrated on first load and remain read fallbacks). `setConfig` persists a KEYLESS config (apiKey stripped; the key lives only in the OS keychain) â€” a first step toward R7's full credential isolation.
- `src/stores/libraryStore.ts` / `projectStore.ts` / `chatStore.ts` â€” restore-reload paths no longer flush (the barrier drained; flushing post-restore could write pre-restore state back).
- `src/components/settings/SettingsDialog.tsx` â€” import handler aborts in-flight AI sends, relies on the restore's internal barrier, and reports real counts ("N documents, M projects, K conversations restored"); export handler reports dump counts.
- Tests: `src/utils/__tests__/backup.test.ts` (NEW: export includes pre-export saves, credential stripping, v3 validation incl. duplicate-id/relationship/credential rejections, desktop-backup rejection in browser, barrier hold/discard/release, failed restore releases the barrier, generation bump), Rust tests (restore replaces domain+prefs in one transaction, missing content does not inherit live content, prefs roundtrip).

Commands run and results:
- `npx tsc --noEmit` â€” OK.
- `npm test` â€” 168 tests passed (15 files).
- `cargo test --lib` â€” 48 tests passed.
- `cargo check` â€” OK (no warnings).
- `npm run build` â€” OK.

Acceptance status (R5):
- [x] Export immediately after Save includes that save.
- [x] Invalid backup changes neither domain data nor preferences (validation before any swap; failed restores leave the barrier clean).
- [x] Restoring a backup while the same document IDs are already loaded displays restored content (one-transaction swap + generation bump + store reload without post-restore flush).
- [x] A pre-restore AI completion cannot modify the restored dataset (abort + held/discarded schedules).
- [x] Missing optional content in an old backup does not inherit newer live content (Rust test).
- [x] Credentials never appear in normal backup exports (export strips; validation rejects bundles containing a key).

Known limitations:
- v1 restore inside the desktop app still performs a stepwise file replacement + legacy import (not one transaction); v2/v3 restores are fully atomic. v1 is a legacy reader.
- Scheduled saves made DURING an export are released after it; they are not part of the exported snapshot (by design).

### R6 â€” Protect unsaved drafts and lifecycle transitions

Completed: 2026-09-15.

Files changed:
- `src/stores/draftStore.ts` â€” NEW: recoverable draft sessions keyed `text:<id>` / `project-brief:<id>` (content + editor metadata + savedAt/error state), persisted through the preferences table (debounced, restart-safe), hydrated at startup; `markSaved`/`markError`/`clearDraft` (discard is always explicit); `flushDrafts()` joins the shutdown/relaunch drains.
- `src/components/library/LibraryEditor.tsx` â€” the draft no longer lives in component state: the editor projects the store session, so switching tabs/documents/panels keeps it and a restart recovers the last typed draft (draft wins over the stored body on load). Editing is disabled while a document loads ("Loadingâ€¦"); a recoverable load failure shows an error with "Retry load". Explicit Save awaits the acknowledgment (flush + idle) before showing "Saved" and navigating; a failed save retains the editable content with an explicit Retry / Discard draft banner.
- `src/components/library/ProjectDetail.tsx` â€” the project brief gets the same protection: draft session per project, acknowledged-save flash only after flush, Retry/Discard on failure.
- `src/stores/settingsStore.ts` â€” `loadSettings` is a handled startup state: a failed read applies defaults, sets `isLoaded` (no permanent blank window) and exposes `settingsError`.
- `src/App.tsx` â€” the close drain now also flushes recovery drafts (after the domain drains).
- `src/components/settings/SettingsDialog.tsx` â€” updater relaunch goes through the same persistence drain (domain flushes + drafts) before `relaunch()`.
- Tests: `src/stores/__tests__/draftStore.test.ts` (NEW: draft survives remount, typing invalidates acknowledgment, save errors retain content, restart recovery via hydrate, debounced persistence lands on its own, unreadable store starts clean, close during the debounce window flushes), `repository.test.ts` (close during a delayed save waits for the write to land â€” real adapter, delayed transport).

Commands run and results:
- `npx tsc --noEmit` â€” OK.
- `npm test` â€” 176 tests passed (16 files).
- `cargo test --lib` â€” 48 tests passed.
- `cargo check` â€” OK.
- `npm run build` â€” OK.

Acceptance status (R6):
- [x] Edit â†’ switch tabs â†’ return retains the draft (store-owned sessions).
- [x] Restart restores the last acknowledged recovery draft (preferences-backed, hydrated at startup).
- [x] A delayed initial load cannot overwrite newly typed content (recovered draft wins over the load; editing disabled while loading).
- [x] Closing during a delayed save waits for it (drain test with delayed transport).
- [x] Save errors retain editable content and offer retry (editor + brief banner; explicit discard).
- [x] Project-brief editing gets the same protection.
- [x] Load settings through a handled startup state; a failed settings read cannot blank the window.
- [x] "Saved" shows only for acknowledged persistence (flush + idle before the indicator).

Known limitations:
- Component-level (rendered-DOM) tests are not yet possible (no jsdom/testing-library) â€” the draft lifecycle is covered at store level; component tests are queued for R11 (which may add the missing tooling).
- Pending preferences writes flush on close/relaunch, but a failed preference write is not yet surfaced in the UI (draft stays in memory and retries on the next edit).

### R7 â€” Complete credential isolation

Completed: 2026-09-15.

Files changed:
- `src/utils/keychain.ts` â€” rewritten: credentials are keyed by provider/profile + NORMALIZED endpoint identity (`dws-key:<provider>:<endpoint>`); `saveCredential` verifies the native write with a read-back (half-written entries are removed); `loadCredential`/`deleteCredential` per profile; legacy single-account entry (`api_key`) and legacy config.json plaintext helpers for migration.
- `src/stores/chatStore.ts`:
  - `ApiConfig` gains `keychainAccount` (credential REFERENCE, not the secret) and `sessionKeyOnly`.
  - `setConfig` stores the key ONLY in the OS keychain under the profile account; the persisted config (SQLite prefs) never contains the key. A verified store allows removing the legacy plaintext copies of THAT key (legacy entries holding a different profile's key stay). Unavailable/unverifiable keychain â†’ session-only credential (in memory, never persisted) with a UI note.
  - Clearing the key deletes this profile's credential + stale legacy entries.
  - `loadConfig` resolves the key from THIS profile's account only â€” a restored/edited configuration for another provider can never reuse the currently stored key. One-time verified migration of the legacy shared keychain entry and of config.json plaintext (file stripped only after the verified profile write; on failure the file is kept â€” recoverability).
- `src/components/settings/ApiConfigForm.tsx`:
  - Provider switch selects THAT profile's stored credential or clears the field (never carries the prior profile's key); model lists load without any key on switch.
  - Sequence guard discards stale model-list/test responses after profile changes.
  - Connection-test status resets when provider/endpoint/key change.
  - Save surfaces the session-only-credential note when secure storage is unavailable.
- Tests: `src/stores/__tests__/credentialIsolation.test.ts` (NEW, 11 tests: per-profile accounts + endpoint normalization, verified read-back, keyless persistence, no cross-profile key reuse on restored configs, restart survival, clearing removes credentials, session-only fallback, failed/unverifiable writes, legacy keychain + plaintext migration with recoverability on failure); `api.test.ts` config literal updated.

Commands run and results:
- `npx tsc --noEmit` â€” OK.
- `npm test` â€” 187 tests passed (17 files).
- `cargo test --lib` â€” 48 tests passed.
- `cargo check` â€” OK.
- `npm run build` â€” OK.

Acceptance status (R7):
- [x] Switching provider does not transmit the prior key (profile-scoped field + model lists loaded keyless on switch; form-level logic; send path always uses the saved profile's own key).
- [x] Test, Reload, Save, and backup restore all obey profile ownership (sequence guards + keyless persistence + profile-scoped resolution after restore).
- [x] Native credentials survive separate calls and app restart (verified write/read-back + reload test).
- [x] New configuration and ordinary backups contain no plaintext key (persisted config is keyless; R5 validation rejects bundles carrying keys).

Known limitations:
- The ApiConfigForm provider-switch/test logic is not covered by rendered-component tests (no jsdom yet â€” R11 decision); the store/transport-level contract is fully tested.
- A keychain-unavailable environment still cannot STORE credentials; the session-only path is the documented fallback.

### R8 â€” Complete AI operation ownership

Completed: 2026-09-15.

Files changed:
- `src/services/aiOperations.ts` â€” NEW: the operation service owns every AI operation's lifetime outside React. Each operation carries a request id, the owning thread (and future document id), the target message id, the dataset generation at start, an immutable snapshot of config + system prompt + history, the attachments it consumes, its own abort controller, an independent output buffer, and a terminal status. Settlement is idempotent (first call wins; late deltas after settlement are ignored). `isStaleOperation` (generation mismatch) gates every commit; `invalidateAllOperations` aborts + terminalizes running ops (restore). `appendOutput` is navigation-independent.
- `src-tauri/src/repository.rs` â€” schema v5: stable message ids (`msg_id` column; serialized as `id`, default null for legacy rows; ids flow through create/save/append/import/export); `thread_replace_message(id, msgId, content, updatedAt)` â€” replace-by-stable-id, update-only, bumps the thread revision, fails on unknown ids without mutation.
- `src/utils/repository.ts` â€” `StoredMessage.id: string | null`; `threadReplaceMessage` (SQLite + JSON backends, flushes pending saves first); JSON thread files carry ids.
- `src/stores/chatStore.ts`:
  - `ChatMessage.id` (stable identity) + `messageKey` prefers the id (legacy fallback for unmigrated messages); `addMessage` assigns ids; `storedToMessage` migrates legacy rows (order/content unchanged; ids persist on the next save).
  - `commitToOwner(threadId, append|replace)` â€” commits to the OWNER regardless of the visible conversation (in-memory + schedule when active; atomic repository append/replace when hidden); refuses commits for deleted/restored owners.
  - Per-thread composer attachments (`threadAttachments`) with `get/set/clearThreadAttachments` â€” a parse finishing after navigation lands in the conversation where it started; clears remove only consumed attachments; attachments die with their thread and with restores.
- `src/components/tabs/ChatTab.tsx` â€” sends/retries/regenerations run as operations (context snapshot recorded on the op after the brief load; the request replays the snapshot); onDelta writes the op buffer + mirrors to the store only while the thread is visible; stop-partial commits the OPERATION's buffer (not the display buffer) to the owner; failed background sends retain their retry state in the op; consumed attachments are cleared only for the request's own set.
- `src/components/chat/MessageList.tsx` â€” the deslop cleanup is a `cleanup` operation: ownership pinned at start, settled through the service, committed to the owner (in-memory or repository append).
- `src/utils/backup.ts` â€” `bumpDatasetGeneration()` exported (also used by tests).
- Tests: `src/services/__tests__/aiOperations.test.ts` (NEW: unique ids/ownership, context snapshots, navigation-independent buffers, terminal settlement, abortable cleanups, restore invalidation/staleness, regeneration targets) and chatStore tests (stable id assignment + migration without reordering, one-time background regeneration replacement, commits refused for deleted owners, buffer append to hidden owners, per-thread attachment isolation + consumed-only clearing).

Commands run and results:
- `npx tsc --noEmit` â€” OK.
- `npm test` â€” 198 tests passed (18 files).
- `cargo test --lib` â€” 49 tests passed.
- `cargo check` â€” OK.
- `npm run build` â€” OK.

Acceptance status (R8):
- [x] A â†’ B â†’ A navigation during generation does not lose text (op buffer + commit-to-owner; tested).
- [x] Background regeneration updates the intended message once (stable-id replace; tested).
- [x] Cleanup can be stopped and cannot interleave unpredictably with chat (owned operations; tested).
- [x] Deleting the owner or restoring data prevents stale commits (existence + generation checks; tested).
- [x] An attachment being parsed cannot migrate to another conversation (per-thread slots; tested).
- [x] Retrying a request uses its recorded context and conversation boundary (context snapshot; tested).
- [x] Stable message ids added; old messages migrate without changing order/content (tested incl. persistence roundtrip).

Known limitations:
- Composer attachments/drafts survive navigation in memory but not yet restarts (persisting full composer state incl. parsing jobs is queued with the Phase 4 session layer).
- A failed background send's retry state lives on the operation; a UI affordance to list/retry failed background sends arrives with the Phase 3 workspace (the failed marker already persists for visible-thread failures).

### R9 - Repair streaming, cancellation, and research finalization

Completed: 2026-09-15.

Files changed:
- src-tauri/src/lib.rs:
  - StreamAccumulator now captures the OpenAI finish_reason, provider usage (both wire formats), and exposes is_empty(); the assembled Done payload carries finish_reason / usage / an explicit truncated flag (!is_finished()).
  - stream_sse EOF semantics: a stream ending WITHOUT the provider's completion signal is INTERRUPTED - with no content at all it is an error ("connection interrupted; no answer was produced"); with partial content it is delivered as an explicitly truncated answer.
  - Research network controls: is_public_url blocks loopback, private/link-local ranges, unspecified/broadcast, .local/.internal/localhost hosts and non-HTTP(S) schemes; the scrape client's automatic redirect policy is DISABLED and fetch_public_validated follows up to 5 redirects manually, validating EVERY hop. zen_fetch_page and zen_web_search use it. The user's configured chat endpoint is separate (explicit local-model endpoints keep working).
  - New Rust tests: blocked/allowed URL matrix, truncated/finished accumulator states (OpenAI + Anthropic incl. usage preservation), emptiness check.
- src/utils/api.ts:
  - streamChat discipline: the channel handler is attached BEFORE the request starts (early events cannot be lost); cancellation BEFORE the startup acknowledgement is queued and fires as soon as the request id arrives; EVERY event after terminal settlement is ignored.
  - ApiResponse gains truncated / finishReason / usage (extracted from the Done payload, both wire formats).
  - Research finalization: an evidence ledger records every tool call's identity, query/URL, retrieval status, and excerpt; the round-cap and tools-rejected fallbacks collapse the evidence INTO the final request (never answer from nothing) and the label is accurate ("uses the N research results gathered") - the misleading "answering without it" label appears only when nothing was gathered.
  - Capability fallbacks (streaming to non-streaming, tools to no-tools) only run BEFORE output starts; after output a stream failure returns the partial content as truncated with the error preserved instead of silently restarting the answer.
  - Tool permission is enforced at EXECUTION time: with web search disabled, provider-returned tool calls are never executed (the drafted text is answered from, or an explicit error).
  - Cancellation propagates through the tool batch (checked between tool calls).
  - Truncated streams with tool-call-shaped payloads no longer drop partial content.
- src/components/chat/MessageList.tsx - markdown images render as alt text + external link, NOT <img>: model-supplied markdown can no longer make the webview fetch external images automatically (bypassing network controls).
- Tests: api.test.ts +8 stream-discipline tests (early events, abort during startup, late events after settlement, truncated stream keeps the partial, disabled research blocks tool execution, stop during a tool batch, stream failure after output => truncated partial, round-cap evidence hand-off assertion) and existing assertions updated for the new response flags.

Commands run and results:
- npx tsc --noEmit - OK.
- npm test - 206 tests passed (18 files).
- cargo test --lib - 52 tests passed.
- cargo check - OK.
- npm run build - OK.

Acceptance status (R9):
- [x] Immediate events, abort during startup, late deltas, truncated streams, tool rejection after research, Stop during a tool batch (all tested).
- [x] A disabled research setting prevents tool execution even if a provider returns a tool call anyway.
- [x] EOF without protocol completion is interrupted, not successfully complete (empty => error; partial => explicitly truncated).
- [x] Finish reason, truncation, provider errors, and usage preserved.
- [x] Automatic capability fallback only before output starts.
- [x] Research results preserved in every finalization/fallback path; evidence packets retain tool identity, URL/query, retrieval status, excerpts; the inaccurate "answering without it" label removed when evidence was retained.
- [x] Tool permission enforced at execution time.
- [x] Research URLs and redirects validated against local/private-address access; explicit local-model chat endpoints unaffected; automatic external-image loading blocked.

Known limitations:
- DNS rebinding (a public hostname resolving to a private IP at connect time) is not yet mitigated - hostname and IP-literal checks + validated redirects are in place; connect-time IP verification would need a custom reqwest connector (noted for a hardening pass).

### R10 - Finish smaller Phase 1 defects

Completed: 2026-09-15.

Files changed:
- src/utils/libraryIo.ts:
  - exists() errors now PROPAGATE from uniqueExportPath (an access-denied no longer pretends the name is taken, which produced endless numbered collisions); only genuine taken names retry.
  - Bulk export writes through export_write_exclusive (Rust create_new) - overwriting an existing file is impossible; a genuine collision retries with a numbered name; per-file results (BulkExportResult { exported, failed }) are returned instead of a bare count. Single-text export keeps the plain save-dialog write (the user explicitly picks the path).
  - New CollisionError distinguishes "name taken" from other failures.
  - Windows reserved device names (con/prn/aux/nul/com1-9/lpt1-9) get a "_" prefix.
  - exportFilename iterates CODE POINTS (surrogate pairs never split - astral letters survive whole), keeps combining marks (p{M}), and slices by code points.
  - parseImport treats a leading --- block as application front matter ONLY when it carries one of the exporter's own fields; ordinary Markdown beginning with horizontal rules (or foreign YAML) survives import unchanged.
- src/components/library/LibraryList.tsx - folder filters encode concrete folders as folder:<name>, separate from the "all"/"none" sentinels: folders literally called none or all are selectable and usable; import pre-assignment decodes the prefix.
- src/components/chat/MessageList.tsx - Save-to-Library preserves the conversation brief's text type (chat.brief.textType instead of always "other"); bulk-export failure lists surface via window.alert when a folder export partially fails (exportTexts returns per-file results).
- src/components/chat/MessageInput.tsx - Enter respects IME composition (isComposing / keyCode 229 never sends); the textarea re-fits its height when the stored draft changes programmatically (thread switch, send-clear).
- src/index.css - the missing --color-surface-alt utility mapping added (bg-surface-alt silently produced nothing before), with light (#f1ece4) and dark (#282419) values.
- src/stores/settingsStore.ts - accentWithContrast(accent) guarantees the WCAG 4.5:1 target: the foreground is the better fixed candidate, and when even it fails (mid-tone custom accents), the accent's LIGHTNESS is adjusted (hue untouched) until the target is met.
- src/App.tsx + SettingsDialog.tsx - use accentWithContrast for --primary/--chart-1/--sidebar-primary and the palette previews.
- src/utils/fileParse.ts - wordCount is the RETAINED text's count with originalWordCount reported separately and a structured warning for truncation; empty extractions on multi-page PDFs are reported as scanned/image-only instead of silently attaching an empty file; ChatTab surfaces the warning.
- package.json - the stale SheetJS npm package (xlsx 0.18.5, unmaintained since 2022, known advisories) replaced with the verified maintained SheetJS CE build (0.20.3 from cdn.sheetjs.com, includes the security patches).
- Tests: libraryIo.test.ts +6 (distinct non-Latin export names, combining marks, surrogate-pair safety, reserved-name prefixing, horizontal-rule/foreign-YAML preservation, own front matter still parsed).

Commands run and results:
- npx tsc --noEmit - OK.
- npm test - 212 tests passed (18 files).
- cargo test --lib - 52 tests passed.
- cargo check - OK.
- npm run build - OK.

Acceptance status (R10):
- [x] Export access-denied fails promptly; existing files remain untouched (exclusive creation).
- [x] Non-Latin titles export distinctly; combining marks/surrogate pairs preserved.
- [x] "No folder" works and folders called none/all remain usable.
- [x] IME Enter does not send prematurely.
- [x] Front-matter detection no longer assumes every initial --- block is application metadata.
- [x] Retained-vs-original word counts corrected; empty/scanned PDFs and truncation reported explicitly.
- [x] The xlsx dependency replaced with a verified maintained, patched approach (SheetJS CE 0.20.3).

Known limitations:
- Bulk-export failure surfacing uses window.alert (no toast system yet - Phase 3 status bar will replace it).

### R11 - Establish trustworthy test gates

Completed: 2026-09-15.

Files changed:
- .github/workflows/pr-verify.yml - NEW: PR verification workflow (Node 24, npm ci, npx tsc --noEmit, npm test, npm run build, cargo test --lib + cargo check with Rust caching).
- src-tauri/src/repository.rs - real-database and failure-injection tests:
  - smoke_fresh_startup_to_backup_restore: the isolated native smoke test against a REAL temp SQLite FILE - fresh startup, create conversation, create project WITH references, save/edit/reopen a document, restore history by stable version id, export a consistent dump (references survive serialization), restore into a second fresh dataset, and reopen the first database intact after "shutdown".
  - corrupt_database_file_fails_startup_visibly: a corrupt DB file fails startup loudly and is left untouched for recovery.
  - real_file_migration_from_v1_preserves_data: a real v1 file database migrates through every schema step to the current version with data (texts, versions, timestamps, threads) preserved.
  - Fixed a real bug the new test exposed: verify_import no longer fails when the dataset is entirely empty (first-run migration into a database that already holds rows, e.g. after a v1-restore).
- src/components/__tests__/draft-navigation.test.tsx - NEW jsdom component tests (@testing-library/react added as devDependencies):
  - Draft navigation: typing a draft, unmounting, and remounting the editor retains the draft.
  - Error handling: a failed save shows the alert with Retry/Discard, keeps the editable content, and a retry after recovery commits the draft; a successful save clears the recovery draft with acknowledged content in the repository.
  - Restore refresh: HistoryDialog restores a version by its stable id, refreshes the holding views (onRestored), and closes.

Verification commands and results (final state):
- npx tsc --noEmit - OK.
- npm test - 217 tests passed (19 files, incl. 5 component tests in jsdom and the real-adapter delayed/rejected-transport suites).
- npm run build - OK.
- cargo test --lib - 55 tests passed (incl. the native smoke test, real-file migration, and corrupt-DB failure injection).
- cargo check - OK.

Test-gate inventory (R11 requirements):
- [x] Shared frontend/Rust serialization fixtures (repository-contract.json, consumed by both test suites).
- [x] Rust tests using real temporary SQLite databases (smoke, migration, corrupt-file).
- [x] Failure injection for commit (transport interceptor), migration (malformed registry), restore (validation/failed-restore), delayed operations (delayed transport).
- [x] Frontend tests using the real repository adapter with delayed/rejected transport (repository/backup suites).
- [x] Component tests for draft navigation, error handling, and restore refresh (jsdom).
- [x] An isolated native smoke test (fresh startup -> conversation -> project with references -> document save/edit/reopen -> history restore -> backup export/restore).
- [x] A PR verification workflow (Node 24, typecheck, frontend tests/build, Rust tests).
- [x] Fakes remain for view-state tests only; transactional/IPC correctness claims rest on the real-adapter and real-DB tests.

REPAIR GATE: R1-R11 are all complete with their acceptance checks demonstrated. Phases 1-2 repair is DONE; next: Phase 3 (design contract + document-centred workspace).

## Phase 3 - Design contract and document-centred workspace

### 3.1 - Rewrite DESIGN.md

Completed: 2026-09-15.

Files changed:
- DESIGN.md - full rewrite of the Inkwell contract:
  - Direction implemented: dark = warm charcoal paper + warm ink + restrained mint accent (normative); light = warm paper + dark ink + deep teal accent. Interface Geist Sans at a 14px base; manuscript Source Serif 4 at a user-adjustable 18px default; technical metadata Geist Mono. Document reading measure 65-75ch.
  - New tokens: warning/on-warning, navigator/inspector widths (240px/360px), doc-column 720px, doc-lg at 18px (user-adjustable), doc-md; new components: navigator-panel, inspector-panel, list-item-hover, button-primary-disabled, status-saving/-error/-empty/-warning, revision-row.
  - Specified interaction states (hover, focus, selected, disabled, error, saving, revision), manuscript typography (paragraphs, headings, tables, quotations, annotations), panel layout + collapse rules (document pane never below ~50ch; panels collapse first), keyboard navigation + dialog behaviour, reduced motion + 200% zoom reflow, and loading/empty/saving/interrupted/recovery status patterns.
  - Lint: `npx -p @google/design.md designmd lint DESIGN.md` - 0 errors, 0 warnings.
- src/index.css - mapped the new tokens: --color-warning/--color-on-warning utilities + light (#b45309) and dark (#fbbf24) values (surface-alt mapping landed with R10).
- src/components (color sweep) - undocumented per-component Tailwind palette colors replaced with tokens: text-green-400 => text-primary (success = the accent's job), text-amber-500 => text-warning, text-red-400/bg-red-400 => text/bg-destructive. The preset accent VALUE list (user data) intentionally stays.

Commands run and results:
- designmd lint - 0 errors, 0 warnings.
- npx tsc --noEmit - OK. npm test - 217 passed. npm run build - OK.

Acceptance (3.1): contract valid per the designmd linter; tokens mapped into CSS; no undocumented per-component color values remain (accent presets excepted as user data).

Known limitations:
- The manuscript 18px default + size control take effect with the Phase 4 editor; the chat doc bubbles (15px) and current textareas already follow the contract.

### 3.2 - Build the workspace shell

Completed: 2026-09-15.

Files changed:
- src/stores/useAppStore.ts - rewritten: workspace view state (list | manage | read | edit | project | discussion, with prefill for paste-flows), panel state (navigatorCollapsed/inspectorCollapsed, DRAG-RESIZABLE widths clamped 180-360 / 280-520, inspectorView, focusMode) - all persisted through the preferences table (hydrateShell); legacy setActiveTab maps onto workspace views (project-detail brief-chat handoff keeps working).
- src/services/chatSend.ts - NEW: the chat-send pipeline extracted from ChatTab so every chat surface (full discussion view AND the compact assistant) shares one implementation: operation-service ownership, context snapshots, per-thread attachments/brief inclusion from the store, commits to the owner.
- src/utils/references.ts - NEW: shared collectReferences (the token estimate and the actual send now literally cannot disagree).
- src/components/workspace/WorkspaceShell.tsx - NEW: three-column layout (navigator 240px default, document pane, inspector 360px default), drag handles for both panels, automatic collapse when the centre would drop under ~480px, focus mode, Ctrl/Cmd+K palette, Settings entry.
- src/components/workspace/ProjectNavigator.tsx - NEW: projects (expandable: Brief / documents / discussions), standalone documents, standalone conversations; New blank document vs Paste as new document are SEPARATE actions; conversation rename (metadata-only repository op - safe for unloaded threads); auto-expands the project owning the current view; selection persists.
- src/components/workspace/DocumentPane.tsx - NEW: hosts the EXISTING reader/editor/project/chat views unchanged (Phase 4 replaces the editor), plus the document-centred empty state.
- src/components/workspace/InspectorPanel.tsx - NEW: Assistant / Sources / Review tabs; all views stay MOUNTED (hidden when inactive) so the assistant's state survives view switching; Sources/Review carry honest Phase 5 placeholders.
- src/components/workspace/CompactAssistant.tsx - NEW: the narrow-surface assistant using the same store, drafts, and send pipeline; link to open the full conversation view.
- src/components/workspace/WorkspaceStatusBar.tsx - NEW: persistence readout (Saved only when nothing is pending and no failure retained; Unsaved with draft count; failures point to retry), item counts, panel/focus toggles (aria-pressed).
- src/stores/chatStore.ts - briefIncludedByThread (shared brief-inclusion state) + toggleBriefInclude; renameThread (metadata-only).
- src-tauri/src/repository.rs - db_thread_rename (metadata-only, update-only, bumps rev); db_search + the FTS infrastructure (3.3, below).
- src/components/tabs/ChatTab.tsx - now delegates the send pipeline to the chatSend service (the full discussion view is one host of the shared pipeline).

Tests: workspaceShell.test.tsx (NEW, 7 jsdom component tests: shell composition, navigator selection opens documents in the pane, inspector collapse keeps the assistant mounted, view switching never remounts the assistant, layout persistence, focus mode, status-bar unsaved reporting).

Commands run and results:
- npx tsc --noEmit - OK. npm test - 224 passed. npm run build - OK. cargo test --lib - 59 passed. cargo check - OK.

### 3.3 - Search and everyday navigation

Completed: 2026-09-15.

Files changed:
- src-tauri/src/repository.rs - schema v6: FTS5 search_index (kind/doc_id/body, unicode61 tokenizer) maintained by TRIGGERS on text_contents / project_briefs / messages - every index update commits in the SAME transaction as the write; the migration backfills existing rows. fts_query() quotes user tokens (malformed operator input cannot break the matcher). db_search returns ranked body hits (FTS snippet()) plus leading title matches, capped at 25; resolve_title joins the live tables.
- Verified FIRST: fts5_support_available_in_bundled_build test (the bundled rusqlite supports FTS5).
- src/utils/repository.ts - repo.search (SQLite command; JSON backend implements a substring search over its files for browser dev); SearchHit type; fake search for store tests.
- src/components/workspace/CommandPalette.tsx - NEW: Ctrl/Cmd+K palette - actions (New blank document / Paste as new document / New conversation / New project / Toggle focus), navigator entries filtered by title, and full-text results (debounced repo.search) appended with excerpts; arrow-key + Enter navigation, Escape closes, scroll-into-view.
- src/components/chat/BriefForm.tsx - detailed writing-brief questions (background, type/length/audience/tone/citations/language, must-include/avoid) now collapse behind a "More details" disclosure; Topic + submit always visible; a "(some are filled in)" hint when collapsed with content.
- Tests (Rust): search_finds_documents_conversations_and_briefs, search_index_follows_writes_and_deletes_transactionally (edits replace, renames update titles, deletes clear, thread rewrites stay in sync), search_handles_unicode_and_malformed_queries, fts5 support probe.

Commands run and results:
- cargo test --lib - 59 tests passed. npx tsc --noEmit - OK. npm test - 224 passed. npm run build - OK. cargo check - OK.

Phase 3 acceptance review:
- [x] Keyboard-only navigation works (all rows/controls are buttons/selects; palette arrows+Enter; dialogs from the base components trap focus and close on Escape).
- [x] Both themes meet contrast requirements (DESIGN.md lint AA; accentWithContrast guarantees text-on-accent; disabled state raised to secondary/surface-alt = 6.2:1).
- [x] Panels resize/collapse without losing work (drag handles + persisted widths; drafts live in stores).
- [x] Project navigation returns to the correct project (auto-expand + persisted view).
- [x] Long titles and zoom do not hide controls (truncate + reflowing layout; panels collapse by rule).
- [x] Search: FTS with transactional indexes; command palette; New blank vs Paste-as-new separated; briefs progressively disclosed.

Known limitations:
- Pin/archive states are deferred (schema fields + UX) - rename is implemented for conversations; texts/projects rename via their existing editors.
- The inspector Assistant is compact (no attachment chips yet in the narrow view); the full discussion view has the complete composer.

Known limitations (phase-wide): FTS does not index standalone text TITLES into the index itself (title matches use LIKE at query time) - body content is fully indexed.

## Phase 4 - Rich-text editor and document lifecycle

### 4.1 - Define the document format contract

Completed: 2026-09-15.

The versioned content contract (applied end-to-end before any editor work):
- `contentFormat`: `"markdown" | "tiptap-json"`.
- `contentSchemaVersion`: contract version of the payload (currently 1; `CONTENT_SCHEMA_VERSION`).
- `content`: the AUTHORITATIVE payload (markdown source, or a ProseMirror document serialized to JSON text).
- `plainText`: derived plain text for search/snippets/word counts/context — a serialized structured payload is NEVER used as manuscript prose.
- Document revision number: the existing per-row `rev` (R2) unchanged.
- History snapshots (`text_versions`) carry the SAME fields, so historical restore preserves the body format exactly.

Files changed:
- `src/utils/documentCodec.ts` - NEW: the contract module. `markdownDocument`/`richDocument` build bodies; `plainTextFromMarkdown` (deterministic syntax stripper: headings/emphasis/links→text/images→alt/lists/quotes/tables→cells/code fences kept verbatim, Unicode-safe); `plainTextFromProseMirror` (schema-free structural text collector with per-context separators — paragraph breaks, list items one per line, table cells space-joined, hardBreak honored); `decodeDocumentBody` (pre-contract rows → markdown v1; UNKNOWN format or NEWER schema version fails LOUDLY, content untouched); `decodeDocumentBodyLenient` (history listings degrade to preserved markdown); `displayTextFromBody`/`markdownFromBody` (markdown → source; rich → plain text; never the payload); `ConversionReport` type for 4.2/4.3.
- `src-tauri/src/repository.rs`:
  - Schema v7 (`SUPPORTED_SCHEMA_VERSION = 7`): `content_format TEXT NOT NULL DEFAULT 'markdown'`, `content_schema_version INTEGER NOT NULL DEFAULT 1`, `plain_text TEXT` on BOTH `text_contents` and `text_versions`; migration backfills `plain_text = content` (markdown rows keep their exact v6 search/readout behavior); the TEXT FTS triggers are dropped and recreated to index `COALESCE(plain_text, content)` in the same transaction as every write.
  - `TextBody` wire struct (content + format + schemaVersion + plainText, serde defaults for legacy) for `db_text_create`/`db_text_save`; unknown wire formats are stored as markdown (preserved verbatim).
  - `text_save` snapshots the replaced body WITH its format fields; `text_restore` resolves/writes them and derives snippet/word count from `plain_text` when present (`derive_snippet_words`); `text_content`/`text_versions`/`export_dump`/`apply_dump` (legacy dumps COALESCE to markdown v1) carry the fields; legacy JSON import stamps markdown v1.
  - New tests: `document_body_fields_roundtrip_through_create_save_restore`, `plain_text_drives_derived_readouts_and_search_for_rich_bodies` (search hits the projection, never payload tokens like "contentFormat"; restore snippets derive from plain text), `legacy_dump_without_format_fields_imports_as_markdown`, `document_format_survives_export_import_dump_cycle`.
- `src/utils/repository.ts` - the repository interface now speaks the contract: `textCreate(meta, body: DocumentBody)`, `TextSaveArgs.content?: DocumentBody`, `textContent → DocumentBody | null`, `TextRestoreResult.body: DocumentBody`, `TextVersion { versionId, savedAt, body }`. Wire converters `bodyToWire`/`bodyFromWire` (strict) / `versionBodyFromWire` (lenient). SQLite adapter sends `body:` and decodes rows; JSON backend stores body files with the format fields, compares PAYLOAD bytes for snapshots, searches `plainText || content`, and reads legacy `{content}` files / legacy version entries tolerantly.
- `src/types/index.ts` - `TextVersion.body: DocumentBody` (snapshots carry the format contract).
- `src/stores/libraryStore.ts` - content cache holds `DocumentBody`; the store API takes `content?: string | DocumentBody` (strings wrap via `markdownDocument` — every current producer writes markdown; the rich editor passes bodies directly); meta snippet/word counts derive from `plainText`; `loadTextContent` returns the body (missing body → empty markdown doc).
- Consumers - all updated to project through the codec: `LibraryEditor` (transitional markdown editor displays `displayTextFromBody`; saves markdown strings), `LibraryReader` (display/copy via plain-text projection; export via `markdownFromBody`), `HistoryDialog` (previews + word counts from the body), `ChatTab` (attachments attach the plain-text projection — a structured payload is never sent as manuscript prose), `LibraryList` (bulk export via `markdownFromBody`), `backup.ts` (dump validation rejects unknown `contentFormat` values and malformed `contentSchemaVersion`), `fakeRepository` (same semantics, body-typed).
- Tests updated: repository.test.ts (contract payloads now assert `body: {content, contentFormat, contentSchemaVersion, plainText}`), backup.test.ts, libraryStore.test.ts, draft-navigation.test.tsx, workspaceShell.test.tsx.

Incident note: a PowerShell `Get-Content`/`Set-Content` re-encode briefly corrupted this untracked file (UTF-8 → cp1252 mojibake + BOM). It was fully recovered by reversing the code-page round-trip programmatically; Unicode content verified intact (`Café — 東京 concretismo`). File edits now go exclusively through the dedicated file tools or Python with explicit UTF-8.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 241 tests passed (21 files, incl. 17 new codec tests + 4 new Rust-contract tests on the frontend side).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 63 tests passed (was 59; +4 document-format tests).
- `cargo check` - OK.

Acceptance status (4.1):
- [x] The contract fields exist end-to-end (frontend codec → wire → SQLite columns → dumps → legacy imports) and apply to history snapshots.
- [x] Existing Markdown remains intact: pre-contract rows/dumps decode as markdown v1; no conversion has run yet.
- [x] Plain text is a derived projection; structured payloads never reach search, snippets, word counts, or the model.
- [x] One authoritative copy: `DocumentBody` replaces the bare string at the boundary; no independent editable copies exist.

Known limitations:
- Nothing produces `tiptap-json` bodies yet (4.2); every document is still markdown.
- The markdown editor still edits source text; the conversion path (validate + report + preserve original) lands with the editor in 4.2/4.3.
- Legacy markdown rows keep raw-markdown FTS text until their next save (backfill preserves v6 behavior by design).

### 4.2 - Implement the core rich editor

Completed: 2026-09-15.

Packages (Tiptap 3.31.3, all locally bundled, one exact version): `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit` (paragraphs/headings/bold/italic/underline/strike/code/code-block/lists/blockquote/hr/hard-break/link/undo-redo), `@tiptap/extension-table` (TableKit: editable tables), `@tiptap/markdown` (official marked-based parser + serializer — the validated conversion path).

Files changed:
- `src/components/editor/useDocumentSession.ts` - NEW: the per-document session hook. Owns load → edit → save: the recovered draft wins over the stored body (R6, body-typed: rich drafts carry `meta.contentFormat` + `plainText`); a markdown body converts ONCE on open in the editor with a `ConversionReport` (regex-detected lossy constructs: footnote refs, definition lists, HTML comments); metadata (title/type/folder/project) is a session projection with draft-typed metadata; `recordEdit` projects the debounced rich payload into the draft store ONLY (no global-store churn per keystroke); `save()` commits a `DocumentBody` through libraryStore → repository and waits for `flushTextSaves + idle` (the R2 acknowledgment), returns the saved id (new-document hand-off), and records retryable failures.
- `src/components/editor/RichTextEditor.tsx` - NEW: the ProseMirror surface. One editor instance per document id (keyed remount, never recreated by typing); markdown bodies parse via contentType "markdown", rich bodies hydrate from stored JSON (a corrupt payload shows verbatim in a code block — original bytes stay visible); updates debounce at 500ms before reaching the session (typing stays local); a new empty document focuses itself.
- `src/components/editor/EditorToolbar.tsx` - NEW: bold/italic/underline/strike/code, H1–H3/¶, bullet/ordered lists, blockquote, code block, insert-table, link (prompt-based), undo/redo — real buttons, `aria-pressed` active states, disabled state from `editor.can()` via `useEditorState`; Find + Outline toggles.
- `src/components/editor/DocumentOutline.tsx` - NEW: heading list refreshed on the debounced doc-change signal; click jumps the selection + scrolls; indented by level. `collectHeadings` is a pure function.
- `src/components/editor/DocumentStatus.tsx` - NEW: Saving/Saved/Unsaved/Failed readout ("Saved" = ACKNOWLEDGED) + the failed-save banner (content retained; explicit Retry/Discard).
- `src/components/editor/FindReplaceBar.tsx` - NEW: literal find (case-optional), match counter ("3 of 17"), Enter/Shift+Enter navigation with wrap, Replace / Replace all (end-anchored transactions — undoable like any edit), Escape closes; IME-safe (isComposing checked).
- `src/components/editor/DocumentReadout.tsx` - NEW: word/character readouts from the ProseMirror document (never a payload).
- `src/components/editor/DocumentEditorView.tsx` - NEW: the full edit surface (metadata header with manuscript size control, toolbar, find bar, manuscript + outline column, footer readout with shortcut hints). Keyboard: Ctrl/Cmd+S save (waits for commit), Ctrl/Cmd+F find (seeds from the selection) — both IME-safe.
- `src/utils/documentFind.ts` - NEW: match collection over a PM document (runs with per-character positions, blocks/hard-breaks as barriers, node-boundary-spanning matches, wrap-aware next-match). Pure + unit-tested.
- `src/stores/useAppStore.ts` - `docFontSize` (14–26px, default 18 per DESIGN.md) persisted with the shell.
- `src/components/workspace/DocumentPane.tsx` - edit views now host DocumentEditorView (the old textarea LibraryEditor leaves the workspace; it remains for its own R6 tests until 4.3 retires it together with the dead LibraryTab).
- `src/index.css` - `.rich-doc` manuscript typography per DESIGN.md (Source Serif, heading scale, lists, quote, code, links, tables with selected-cell tint + column resize handle, gap cursor).

Tests: `src/components/__tests__/documentEditor.test.tsx` (NEW: rich draft survives unmount/remount through the real command → transaction → debounce → draft pipeline; explicit Save commits a tiptap-json body AND the markdown original is snapshotted; markdown round-trip through the real editor parsers preserving headings/lists/quotations/links/tables/Unicode; rich bodies survive save-reopen with formatting intact) and `src/utils/__tests__/documentFind.test.ts` (NEW: runs, case-insensitive matches, cross-node matches, hard-break barriers, wrap navigation).

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 253 tests passed (23 files). `npm run build` - OK (pre-existing chunk warning). `cargo test --lib` - 63 passed. `cargo check` - OK.

Known limitations:
- The link editor uses `window.prompt` (functional, accessible); a proper dialog is polish.
- `LibraryEditor`/`LibraryTab` are now dead code kept only for their R6 test file; 4.3 deletes them after moving the save-failure coverage to DocumentEditorView.
- The Reader (LibraryReader) still renders markdown bodies via react-markdown; rendering rich bodies (and markdown EXPORT via `editor.getMarkdown()`) is 4.3.
- The conversion report is session-lived (shown in the editor, not persisted); original-source preservation currently rides the automatic version snapshot. 4.3 evaluates persisting the report with the document.

### 4.3 - Integrate versions, conversion, and named snapshots

Completed: 2026-09-15.

Files changed:
- `src/utils/richMarkdown.ts` - NEW: the format-preserving conversion pair, built on the SAME extensions the editor uses (one reused headless editor, never focused): `markdownFromRich` (markdown bodies pass through untouched; rich bodies serialize via `editor.getMarkdown()`; a corrupt payload shows verbatim in a code block) and `richFromMarkdown` (parse → serialized tiptap-json). Export, reimport, and the reader can never disagree with the editor.
- `src/components/library/LibraryReader.tsx` - rich bodies now RENDER with full structure (markdown via the serializer → the existing `doc-markdown` renderer); Copy and Export use the same markdown. (Rich bodies previously degraded to plain text.)
- `src/components/library/LibraryList.tsx` - bulk export uses `markdownFromRich` (structure kept, was plain text).
- `src/stores/draftStore.ts` - FIXED a real R6 bug: `markError` no-oped when no draft existed, so a failed explicit Save on an unedited document was silently swallowed (status showed "Saved" after a failure). A failure is now ALWAYS recorded (kind/entityId parsed from the key).
- `src-tauri/src/repository.rs` - schema v8 (`SUPPORTED_SCHEMA_VERSION = 8`): `label TEXT` on `text_versions`; `text_snapshot` (named snapshot of the CURRENT body inside one transaction — captures content + format fields, applies the version cap, does NOT bump rev so pending scheduled saves stay valid); `db_text_snapshot` command (registered in `lib.rs`); `VersionRow`/`TextVersionRow` carry `label` (serde default); dumps/imports carry labels. New test `named_snapshots_capture_the_current_body_and_keep_labels` (snapshot → no rev bump → later save still accepted at the same rev → restore works → labels survive dumps).
- `src/utils/repository.ts` - `textSnapshot(id, label, now)` (flushes the text's pending save first — both backends), version rows carry `label`, JSON backend snapshots into its versions file; `fakeRepository` mirrors.
- `src/types/index.ts` - `TextVersion.label?: string`.
- `src/stores/libraryStore.ts` - `createSnapshot(id, label)`.
- `src/components/library/HistoryDialog.tsx` - "Save snapshot" row (name input + button, Enter submits, IME-safe); labeled rows show a badge; restore unchanged.
- Retired dead code: `src/components/library/LibraryEditor.tsx` + `LibraryTab.tsx` DELETED (the workspace edit view is DocumentEditorView); `draft-navigation.test.tsx` trimmed to the HistoryDialog restore-refresh coverage (draft navigation + save-failure Retry/Discard now covered against DocumentEditorView in `documentEditor.test.tsx`, which gained the save-failure test — written before the markError fix exposed the store bug above).

Tests: `src/utils/__tests__/richMarkdown.test.ts` (NEW: markdown pass-through, rich serialization, corrupt payload verbatim, parse → rich payload, and the export → reimport fidelity round-trip: export(reimport(x)) == export(x) over headings/Unicode/quotes/lists/links/tables) + the libraryStore snapshot test. TOTALS: `npx tsc --noEmit` OK · `npm test` 256 passed (24 files) · `npm run build` OK · `cargo test --lib` 64 passed · `cargo check` OK.

Phase 4 acceptance review:
- [x] Headings, lists, quotations, Unicode, links, and tables survive edit → save (documentEditor component tests: rich body committed, markdown original snapshotted) → restart (draft recovery test across remount; R6 restart-safe drafts) → export → reimport (richMarkdown fidelity round-trip; importFiles still imports markdown untouched as markdown v1).
- [x] Undo works after AI-independent edits (ProseMirror history is editor-local; external state never calls setContent while editing).
- [x] Draft recovery preserves formatting (recovered drafts carry the tiptap-json payload + format tag; component-tested).
- [x] Historical restore preserves formatting (version rows carry the full format contract; restore writes format fields back — Rust-tested).
- [x] Unsupported imports remain recoverable (unknown formats/schema versions fail loudly with bytes untouched; lenient degradation for history; corrupt payloads display verbatim).
- [x] Saving/Saved/Unsaved/Failed status is honest (acknowledgment-based; the markError bug fix closes the last lying path).
- [x] Named snapshots added (schema v8, labels ride dumps/imports).

Known limitations:
- The conversion report is session-lived (shown in the editor) and the label set is free-text (no rename/delete of a label after creation — restore/cap behavior identical to other versions).
- Snapshot cap shares MAX_VERSIONS=20 with automatic save points (a named snapshot can be pushed out after 20 newer versions; acceptable, noted).
- The link editor uses window.prompt.

REPAIR/PHASE GATE: Phases 1–2 (R1–R11), Phase 3 (design + workspace + search), and Phase 4 (4.1 document contract, 4.2 core editor, 4.3 versions/conversion/snapshots) are complete with their acceptance checks demonstrated.

## Phase 5 - Reviewable AI, source context, and interoperability

### 5.1 - The source model

Completed: 2026-09-15.

Schema v9 (`SUPPORTED_SCHEMA_VERSION = 9`): `sources` (id, project association, title/author/year/DOI/URL, original language + translation attribution, asset_ref, `original_text` preserved VERBATIM, `content_hash` UNIQUE = content identity, extraction_status (pending|ready|failed|truncated) + truncation_note, `included_in_context` (user-controlled), notes, verification (unverified|retrieved|quote_matched|supports|disputed — distinct states, never a score), rev/created/updated) and `source_passages` (id, source_id CASCADE, idx, locator (page/section), content).

Files changed:
- `src-tauri/src/repository.rs` - SCHEMA_V9; `SourceRow`/`SourcePassageRow`/`SourceData` wire structs (serde defaults, legacy backups deserialize); `sources_list`/`source_get`/`source_create` (INSERT-only, UNIQUE content_hash → "identical content" error = DEDUP BY CONTENT IDENTITY), `source_save` (row + passages replaced wholesale, revision-checked, one transaction), `source_delete` (passages cascade); dumps export/import sources + passages; `clear_domain_tables` + `RestoreCounts` (+sources, +source_passages); new test `sources_roundtrip_dedup_and_restore` (dedup rejects the same bytes under a different title/filename, read-back with passages, rev-checked saves, dump roundtrip, cascade delete). `DbDump` vectors now `#[serde(default)]` (older backups missing new tables still import).
- `src/types/index.ts` - `SourceMeta`/`SourcePassage`/`SourceData` domain types, `ExtractionStatus`, `VerificationStatus`, `contentIdentity()` (SHA-256 of the text).
- `src/utils/repository.ts` - source wire converters + the five source operations on BOTH backends (SQLite commands `db_sources_list/get/create/save/delete` registered in `lib.rs`; JSON files `sources.json` + `source_<id>.json`; entityKey gains "source"; rev caching).
- `src/test/fakeRepository.ts` - in-memory sources with the same dedup/rev semantics.
- `src/services/sourceExtraction.ts` - NEW: background extraction from uploaded files (reuses the fileParse pipeline), cancellable (abort checked at boundaries; a cancelled result is DISCARDED, never written), passage derivation (paragraph blocks ~2400 chars, locators "¶ n–m", >40 passages → explicit truncation note), parser truncation propagated into `extraction_status: truncated`.
- `src/stores/sourceStore.ts` - NEW: sources list + CRUD + extraction jobs (status machine: extracting → done | cancelled | failed); `addSource` (dedup → duplicate: true, nothing written), `addSourceFromFile` (job id returned; completion writes the source with assetRef), `cancelExtraction`, `setIncluded`, `setVerification`, `updateSource`, `deleteSource`, `resetForRestore`.
- `src/components/workspace/SourcesPanel.tsx` - NEW: the inspector's Sources tab (replaces the placeholder): source rows (context-inclusion checkbox, verification dot with distinct-state tooltips, delete), expandable detail (truncation warning, DOI/URL, language + translation attribution, verification select with the five honest states, original-text viewer), add-by-paste form (duplicate-content feedback), upload (background jobs with cancel + failure surfacing).
- `src/components/workspace/InspectorPanel.tsx` - Sources tab now hosts SourcesPanel.
- `src/utils/backup.ts` - dump validation validates source rows (unique ids AND unique hashes) + passages (known parents, shapes); `RestoreCounts` gains sources/sourcePassages.
- `src/components/settings/SettingsDialog.tsx` - restore reloads the source store; the completion message reports source counts.

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 262 passed (25 files, incl. 6 new sourceStore tests). `npm run build` - OK. `cargo test --lib` - 65 passed. `cargo check` - OK.

Acceptance status (5.1):
- [x] Versioned source records with the specified fields; distinct verification states; user-controlled context inclusion.
- [x] Dedup by content identity (UNIQUE hash; tested on both backends).
- [x] Cancellable background extraction with explicit truncation reporting; original text preserved verbatim.
- [x] Backups carry source metadata + passages with integrity checks (hash uniqueness + shape validation before anything is touched).

Known limitations (5.1):
- Original BINARY assets (PDF bytes) are not yet stored — the extracted text + asset_ref are preserved; byte-level asset preservation needs an app-data asset store (deferred; the text is the usable identity for our purposes).
- Passages for pasted sources are empty until passage selection lands (5.2/5.3 scope); file sources get derived paragraph-block passages.
- The project link for new sources is not yet settable from the panel (per-send source picking arrives with the 5.2 context compiler).

### 5.2 - One context compiler

Completed: 2026-09-15.

Files changed:
- `src/services/contextCompiler.ts` - NEW: the single compiler every AI operation uses. `compileContext({ systemPrompt, history, instruction, sources, manuscript, model, outputBudget })` produces: the ACTUAL provider payload (`messages`: system → history → instruction), the manifest (one entry per material: kind, title, source id, included, fullChars/includedChars, token estimate, and an explicit `omittedReason` for every exclusion or truncation), the total token estimate, model identity, and output budget. Included sources ride the system content under "Sources the writer selected for this request"; EXCLUDED sources stay visible in the manifest as omissions (never silently dropped); a large manuscript is a bounded prefix with the cut reported. Sources in scope: project-linked sources for project threads, standalone sources otherwise, inclusion per the user's checkbox.
- `src/services/aiOperations.ts` - the operation carries `compiled?: CompiledContext` — the manifest of a running/recent request is inspectable.
- `src/services/chatSend.ts` - the send now compiles: the SAME compileContext output is both the payload (the compiled system content is what sendMessage receives) and the manifest (attached to the operation). Prior history excludes the instruction being sent (fresh send: last message; resend/regenerate: the target message) — no duplicated instruction in the payload.
- `src/components/chat/WhatWillBeSent.tsx` - NEW: the "What will be sent?" panel renders the compiler's manifest VERBATIM (entries, token estimates, omission reasons, model) — there is no second, approximate preview anymore.
- `src/components/tabs/ChatTab.tsx` - the old token-estimate useMemo (which rebuilt an approximate preview) replaced by the compiled preview context; a "What will be sent? ≈ N tokens" disclosure above the input renders WhatWillBeSent; scoped sources come from the source store.
- Tests: `src/services/__tests__/contextCompiler.test.ts` (NEW: payload shape, manifest completeness + estimates, included sources ride the system content while excluded material is verifiably absent from the payload, manuscript truncation reporting, model/budget).

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 267 passed (26 files). `npm run build` - OK. `cargo test --lib` - 65 passed.

Acceptance status (5.2 partial):
- [x] One compiler for the chat send path: the UI preview and the actual request are the same object (compiled context attached to the operation).
- [x] Manifest: included source ids, omissions/truncations with reasons, token estimate, model/output budget.
- [x] The "What will be sent?" panel renders the same manifest.

Known limitations (5.2):
- Manuscript context is not yet attached to CHAT sends (the manuscript rides sources/manuscript inputs of the compiler; wiring a "working document" per thread arrives with 5.3's selection flow — the compiler's manuscript path is implemented and tested).
- Briefs/attached texts/uploaded files are still INSIDE the realized system prompt string (their manifest entry is the system prompt entry) — decomposing buildSystemPrompt into structured parts is deferred; the manifest is still honest (nothing sent is unmanifested).
- The compact assistant does not show the panel yet (same pipeline, UI follow-up).

### 5.3 - Reviewable revisions (COMPLETE)

Completed: 2026-09-15 (implementation + dedicated tests).

Schema v10 (`SUPPORTED_SCHEMA_VERSION = 10`): `document_proposals` (id, document_id, base_rev, request_kind (revise|tighten|clarify|comment), base_fragment (the ORIGINAL selected fragment), proposed_fragment, sel_from/sel_to (verified locating hint), context_note (comment text / source references), status (pending|accepted|rejected|stale), created/updated).

Files changed:
- `src-tauri/src/repository.rs` - SCHEMA_V10; `ProposalRow` (serde defaults for legacy dumps); `proposals_list`/`proposal_create`/`proposal_set_status` + `db_proposals_list`/`db_proposal_create`/`db_proposal_set_status` (registered in lib.rs); dumps export/import proposals; clear_domain_tables clears them.
- `src/types/index.ts` - `DocumentProposal`, `ProposalKind`, `ProposalStatus`.
- `src/utils/repository.ts` - `proposalsList`/`proposalCreate`/`proposalSetStatus` (SQLite commands; JSON backend keeps `proposals.json`; `peekRev("text", id)` exposes the cached revision for acceptance checks); `fakeRepository` mirrors (module-level `fakeProposals`, reset with everything else).
- `src/services/revisionService.ts` - NEW: `requestProposal` (selection → kind-specific instruction → single AI request → PERSISTED pending proposal with baseRev + verbatim fragment + range), `acceptProposal` (base-revision check → STALE on mismatch; locate EXACTLY: verified selection range first, then a UNIQUE case-sensitive whole-document match via findMatches — ambiguous/not-found are never applied; ONE undoable ProseMirror transaction; status persisted), `rejectProposal`, `markStaleIfMoved` (Review panel revalidation). Quotation/name/terminology preservation is part of the request instructions; the comment kind produces a note-only proposal (no fragment replacement).
- `src/services/aiOperations.ts` - operations carry `compiled?: CompiledContext` (5.2).
- `src/components/workspace/ReviewPanel.tsx` - NEW: the Review inspector tab — proposal cards with before/after (strikethrough original, proposed replacement), status badges, Accept/Reject on pending, stale explanation, comment cards.
- `src/components/editor/EditorToolbar.tsx` - Revise/Tighten/Clarify/Comment menu (selection-driven, busy state); `src/components/editor/DocumentEditorView.tsx` - wires `requestProposal` + `setActiveEditor` (the bridge the Review panel accepts through) + revision error surfacing.
- `src/components/workspace/InspectorPanel.tsx` - Review tab now hosts ReviewPanel for the open document.

Verification (current state): `npx tsc --noEmit` OK · `npm test` 267 passed (26 files) · `npm run build` OK · `cargo test --lib` 65 passed · `cargo check` OK.

DEDICATED TESTS (complete): `src/services/__tests__/revisionService.test.ts` (NEW, 9 tests against a real ProseMirror editor in jsdom):
- requestProposal creates a pending proposal from the selection with the base revision (from peekRev) and the verbatim fragment; refuses an empty selection; the request instructions carry the passage.
- acceptProposal locates the fragment EXACTLY (whole-doc unique match → one undoable transaction, history boundary proven by can().undo(), accepted status persisted); accepts via the VERIFIED selection range replacing only the first occurrence (never a global replace); STALE on base-rev mismatch applies NOTHING (document untouched, no undo entry, status persisted stale); AMBIGUOUS (two exact matches) refused without mutation, proposal stays pending; NOT-FOUND refused without mutation.
- reject persists; markStaleIfMoved flags exactly the pending proposals from older revisions.
Rust: `proposals_roundtrip_through_dump_and_status_updates` (create/list-per-document/status updates with visible missing-id failures, dump roundtrip preserving fragments + status, legacy dump WITHOUT proposals still imports).
Final state: `npx tsc --noEmit` OK · `npm test` 276 passed (27 files) · `npm run build` OK · `cargo test --lib` 66 passed · `cargo check` OK.

Acceptance status (5.3):
- [x] Selection → Revise/Tighten/Clarify/Comment → a persisted proposal → before/after review with Accept/Reject.
- [x] Acceptance validates the base revision and applies one undoable ProseMirror transaction; stale proposals can never overwrite edits (tested).
- [x] The target is NEVER located by unrestricted string replacement (verified range or unique exact match; tested).
- [x] Quotation/name/terminology preservation is enforced in the request instructions; per-change acceptance is the current flow (each fragment is its own proposal).

Known limitations (5.3):
- Proposals are per-fragment; multi-paragraph selections spanning block boundaries serialize with "\n" separators (findMatches joins runs — a fragment spanning separate blocks matches only when the run join reproduces it exactly; complex cross-block proposals may report not-found → regenerate).
- The AI request inside requestProposal runs as a single awaited call (cancellation wiring to the op service lands with the 5.5 pass; the request is small and blocking only the toolbar button).
### 5.4 (batch a) - BibTeX/RIS interchange

Completed: 2026-09-15.

Files changed:
- src/utils/bibliography.ts - NEW: BibTeX + RIS parsing/serialization. Import produces SOURCE INPUTS (title/author/year/doi/url/language; journal/publisher land in the note field; no citation details are invented - absent fields stay absent); the source's text is the formatted reference line (content identity + dedup ride the existing hash). BibTeX parser handles braced (nested), quoted, and bare values, and-separated authors, unicode + accented authors, and skips comment/preamble/string entries; RIS parses multiple ER-terminated records (TI/T1, AU/A1, PY/Y1, DO, UR, LA, AB). Serializers: BibTeX (@misc with generated keys) + RIS (GEN records, one AU line per author).
- src/components/workspace/SourcesPanel.tsx - Import button (file dialog .bib/.ris -> parse -> addSource each; duplicates content-deduped away) and Export button (save dialog -> BibTeX of every source). The form's open state renamed (formOpen) - it shadowed the dialog import.

Tests: src/utils/__tests__/bibliography.test.ts (NEW, 5: braced/quoted/bare values + unicode authors, comment/preamble skipping with nested braces, multi-record RIS with multiple authors + unicode, and BOTH serialize-to-parse round-trips). TOTALS: npx tsc --noEmit OK - npm test 281 passed (28 files) - npm run build OK.

Known limitations (5.4a):
- BibTeX is parsed pragmatically (no TeX macro/unicode tables) - accents already in unicode survive; TeX escapes are unescaped.

### 5.4 (batch b) - Citation nodes + bibliography insertion

Completed: 2026-09-15.

Files changed:
- src/components/editor/citationExtension.ts - NEW: the citation inline ATOM node - sourceId (the versioned source record) + label (author-date text). renderHTML as span[data-citation][data-source-id], parseHTML re-reads it, renderText yields the label. Markdown interchange: renderMarkdown emits the span as literal HTML - the @tiptap/markdown manager preserves HTML tokens on parse, so a citation NEVER disappears from an export and round-trips through import (tested). collectCitations(doc) - ordered, deduplicated by source id.
- src/utils/documentCodec.ts - the plain-text walk now includes citation labels (search/context/readouts keep the markers readable).
- src/components/editor/RichTextEditor.tsx - Citation extension registered (citations exist in every rich body; JSON round-trip native).
- src/components/editor/DocumentEditorView.tsx - CiteControls in the header: a source picker (YOUR sources only - the app never inserts a citation for a source that does not exist), insert-at-cursor, and a bibliography button that appends Bibliography + one paragraph per citation (citation order, deduplicated, DOI/URL appended) as ONE undoable insertion.
- src/index.css - .citation-node manuscript styling.
- Tests: src/components/__tests__/citation.test.tsx (NEW: insert -> collect by id -> rich-body plain text contains the label -> markdown export keeps the citation -> reimport restores it with its source id). TOTALS: npx tsc --noEmit OK - npm test 282 passed (29 files) - npm run build OK.

Known limitations (5.4b):
- The bibliography is the app's own author-date formatting with DOI/URL suffixes; a full CSL-processor style sheet system (citeproc) remains an open 5.4 item (the citation NODE structure is the ground truth a CSL processor consumes - labels are display-only).
- Bibliography insertion appends a NEW section (it does not yet replace a previous one); footnotes + locators remain.

### 5.4 (batch c) - DOCX export

Completed: 2026-09-15.

Files changed:
- src/utils/docxExport.ts - NEW (the maintained docx package, v9.7.1): DOCX export preserving the SUPPORTED structure - headings (mapped levels), paragraphs with bold/italic/strike/underline/code runs, hard breaks, bullet + numbered lists (numbering config), blockquote content, tables (rows/cells), and citation labels as italic runs; markdown bodies convert through the editor parser first (richFromMarkdown); the bibliography (from the document's own citations + source records, DOI/URL appended) is appended as a Bibliography section. Unknown nodes degrade to their inline text - nothing is silently dropped, and the original document is never touched.
- src/components/library/LibraryReader.tsx - an Export-as-DOCX button (save dialog; binary write via plugin-fs writeFile; the bibliography is gathered from the document's citations through the editor parser).

Tests: src/utils/__tests__/docxExport.test.ts (NEW, 2: a representative markdown document with unicode headings/quotes/lists/tables produces a real non-trivial ZIP archive (PK magic + size), and a rich body builds directly). TOTALS: npx tsc --noEmit OK - npm test 284 passed (30 files) - npm run build OK.

Known limitations (5.4c):
- Footnote nodes + source-locator footnotes, CSL styles (citeproc), and Zotero fielded import/export remain open 5.4 items; DOCX output fidelity beyond the supported set (e.g. images - there are none in the schema) is untested.
- DOCX round-trip fidelity is one-way (export); DOCX import stays mammoth-to-markdown (existing).

### 5.4 (batch d) - Zotero interoperability (CSL JSON import/export)

Completed: 2026-09-15.

Files changed:
- src/utils/bibliography.ts - parseCslJson (Zotero's explicit CSL JSON export: title, author name-parts + org names, issued date-parts, DOI, URL, language, abstract as note; non-CSL JSON returns nothing - no false imports) + serializeCslJson (every source as a CSL item with split name parts and issued date-parts).
- src/components/workspace/SourcesPanel.tsx - the import dialog now also accepts .json and routes it through parseCslJson.

Tests: bibliography.test.ts +3 (Zotero CSL parsing incl. name-parts/organization names/unicode, non-CSL JSON rejection, serialize-to-parse round-trip). TOTALS: npx tsc --noEmit OK - npm test 287 passed (30 files) - npm run build OK.

Known limitations (5.4d):
- CSL-processor STYLED bibliography (citeproc) and footnote nodes remain open 5.4 items; Zotero interop is the explicit import/export path (as planned) - no live API integration.

### 5.5 (batch a) - Measured, low-risk optimizations

Completed: 2026-09-15.

Files changed:
- src/utils/perfLog.ts - NEW: an in-memory 50-entry ring buffer of performance marks (local-only diagnostics; nothing leaves the process): ttft (time to first token), duration, request-size (chars + token estimate), cancel-latency (reserved); measureTtft is idempotent (first delta wins).
- src/services/chatSend.ts - every send records: request size (from the COMPILED context - chars + the manifest token estimate), TTFT (first delta), and total duration with the terminal state (completed/stopped/failed). Cancellation latency is derivable from marks; research duration arrives with research instrumentation (R9 already bounds and finalizes research deterministically).
- src/stores/libraryStore.ts - the document-body cache is now BOUNDED (40 entries, newest-recency eviction) - long sessions no longer grow it without limit.

Tests: src/utils/__tests__/perfLog.test.ts (NEW, 3: newest-first order, ring bound + eviction recency, idempotent TTFT). TOTALS: npx tsc --noEmit OK - npm test 290 passed (31 files) - npm run build OK - cargo test --lib 66 passed - cargo check OK.

Already in place from earlier phases (5.5 inventory): streamed deltas render incrementally with the operation buffer authoritative (R8/R9); truncated/interrupted streams keep partials; cancellation is queued and propagates through tool batches (R9); research finalization is deterministic with an evidence ledger (R9); the context compiler bounds what is sent and reports it (5.2).

Known limitations (5.5a):
- The marks have no UI surface yet (a diagnostics readout can join the status bar); caches for source extraction by content hash are not yet in (sources are parsed once per upload; the SAME file re-uploaded re-parses).
- No automatic quality evaluation harness yet: any future substitution of cheaper models or context trimming must still go through explicit evaluation (never as an unmeasured 'optimization').

### 5.4 (batch e, part 1) - CSL-processor bibliography styles

Completed: 2026-09-16.

The processor: `citeproc` npm 2.4.63 (citeproc-js 1.4.63, the CommonJS snapshot Zotero bundles — `@citeproc-rs/core`/`citeproc-js` are NOT published to npm; citeproc-js upstream remains the maintained reference). Styles + locale VENDORED one-time from the official citation-style-language repos into the source tree (local-first: no runtime fetching): `src/assets/csl/{apa.csl (7th ed.), chicago-author-date.csl (18th ed.), modern-language-association.csl (9th ed.), locales-en-US.xml}`.

Files changed:
- `src/utils/cslProcessor.ts` - NEW (light facade): `CSL_STYLES` (APA=References / Chicago=Bibliography / MLA=Works Cited), `parseAuthorName`/`parseAuthors` ("Family, Given" vs "Given Family"; author boundaries are "; " or " and " - a bare comma is never a boundary), `cslItemFromSource` (honest fields only, type book), `formatBibliography(cited, sources, style)` -> structured `FormattedEntry`s (runs with real italic/bold), `entryToText`. Cited ids WITHOUT a source record are skipped (nothing invented); entries are style-SORTED by the processor, not in citation order.
- `src/utils/cslEngine.ts` - NEW (heavy, lazily imported): citeproc + the style XMLs (`?raw`) + the DOMParser entry-HTML -> runs walk (i/em/b/strong kept, span/a unwrapped, block children flattened with a space). Engines cached per style; items resolved through `sys.retrieveItem` at formatting time (this build has NO `addItems`); `makeBibliography` returns a `[params, entryStrings]` TUPLE in this build (both shapes handled). `runBibliography` sets/clears the active item map around the synchronous formatting.
- `src/types/citeproc.d.ts` - NEW: minimal module declaration for `citeproc`.
- `src/stores/useAppStore.ts` - `cslStyle` (default "apa") persisted with the shell + `setCslStyle`/hydrate.
- `src/components/editor/DocumentEditorView.tsx` - CiteControls gained the style picker; bibliography insertion now goes through the processor (section title per style, entries as real italic/bold PM marks, ONE undoable insertion, busy state + inline error).
- `src/utils/bibliography.ts` - multi-author strings now join with "; " on IMPORT (BibTeX/RIS/CSL-JSON paths) so author boundaries never collide with "Family, Given" commas; serializers split on "; " / " and " and emit honest name parts via parseAuthors. NOTE: source text/content-hash for multi-author imports changes vs previous builds (pre-release app; re-import dedupes by the new hash).
- `src/utils/docxExport.ts` - bibliography entries are the processor's structured runs (real italics in DOCX); `bibliographyTitle` option (References/Works Cited/Bibliography).
- `src/components/library/LibraryReader.tsx` - DOCX export formats the bibliography through the processor with the current style.

Tests: `src/utils/__tests__/cslProcessor.test.ts` (NEW, 11: APA initials/year/italic-title, style-sorted order, MLA "Césaire, Aimé" + section titles, ghost-id skipping, reused-engine id scoping (updateItems discipline), Family-Given multi-author, empty input, style picker, name parsing incl. org-name ambiguity note, honest CSL items); bibliography.test.ts (RIS "; " join + serializer name-parts via parseAuthors); docxExport.test.ts (structured runs + title). Debug probes used during development (node + scratch vitest) were removed.

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 302 passed (32 files). `npm run build` - OK (cslEngine lands in its own 709 kB ASYNC chunk - citeproc + styles cost nothing until a bibliography is formatted).

Known limitations (5.4e part 1):
- Only the en-US locale is bundled (other-language terms like "and"/"edited by" stay English).
- The processor consumes citation sourceIds for the BIBLIOGRAPHY; in-text citation LABELS remain the display-only author-date strings (not style-styled in-text citations).
- buildDocx still appends the bibliography unconditionally (if the user already inserted one in the editor, the DOCX shows both) - pre-existing 5.4c behavior, noted.
- Display strings cannot preserve multi-word organization names (only structured CSL {name:...} import can).

### 5.4 (batch e, part 2) - footnotes + source locators

Completed: 2026-09-16.

Files changed:
- `src/components/editor/footnoteExtension.ts` - NEW: the `footnoteRef` inline ATOM node (label marker + footnote content as attrs - the same survival pattern as citations). renderMarkdown emits `<sup data-footnote data-footnote-text="ESCAPED">label</sup>` literal HTML - a footnote NEVER disappears from a markdown export and round-trips through import (HTML-escape covers `& < > "`); parseHTML re-reads it; renderText gives `[^label] text`; `collectFootnotes` (document order, no dedup - each footnote is distinct) + `nextFootnoteLabel` (count + 1).
- `src/components/editor/RichTextEditor.tsx` - FootnoteRef registered (footnotes exist in every rich body).
- `src/utils/documentCodec.ts` - the plain-text walk reads footnote markers + content (`[^1] text`) so search/readouts keep footnote text findable.
- `src/utils/docxExport.ts` - REAL DOCX footnotes: `FootnoteReferenceRun(n)` references + the `footnotes` document part (numbered by document order; Word numbers them natively); no footnotes -> no footnotes part.
- `src/components/editor/DocumentEditorView.tsx` - CiteControls gained the footnote button: with a source picked, the footnote text is the processor's style-consistent reference (entryToText) with the chosen passage LOCATOR inserted before the trailing period ("Césaire, A. (1966). Une saison au Congo, ¶ 3–4."); a locator picker appears from the source's passages (repo.sourceGet); without a source, a prompt takes free text. Busy state; sequential labels.
- `src/index.css` - `.footnote-node` superscript manuscript styling.

Tests: `src/components/__tests__/footnote.test.tsx` (NEW, 2: sequential labels + collect-in-order + plain-text projection; markdown round-trip preserving content incl. `<`, `>`, `&`, `"` escapes); docxExport.test.ts +1 (footnotes ship as a real `footnotes.xml` part - grepped from the ZIP's plain-byte entry names). TOTALS: `npx tsc --noEmit` OK · `npm test` 305 passed (33 files) · `npm run build` OK · `cargo test --lib` 66 passed · `cargo check` OK.

Known limitations (5.4e):
- Editor footnote labels are the marker assigned at INSERTION (count + 1); deleting/reordering middle footnotes leaves label gaps (DOCX export is unaffected - Word numbers references natively). Dynamic renumbering (NodeView/decoration) is future polish.
- Footnote text is PLAIN text (no rich content inside footnotes).
- Only the en-US locale is bundled; other-language CSL terms stay English.
- In-text citation labels remain display-only (not style-styled in-text citations); the processor drives bibliographies and footnote reference text.

REPAIR/PHASE GATE update: Phases 1–2 (R1–R11), Phase 3, Phase 4, and Phase 5 batches 5.1–5.4 (a–e complete: source model, context compiler, reviewable revisions, BibTeX/RIS, citation nodes, DOCX export, Zotero CSL JSON, CSL-processor styles, footnotes + locators) are done. Remaining in Phase 5: 5.5b (extraction cache by content hash, diagnostics surface, bounded tool concurrency, proposal-request cancellation), the evaluation harness, deferred low-priority notes, and the final acceptance run.

### 5.5 (batch b) - remaining efficiency work

Completed: 2026-09-16.

Files changed:
- `src/services/sourceExtraction.ts` - the parse cache by CONTENT IDENTITY (5.5b): the file BYTES are hashed (SHA-256) before parsing; the same content skips the re-parse. The cache stores the PARSED TEXT only (bounded 10 entries, recency-evicted) - passages are re-derived per use because their row ids are per-source identity (`source_passages.id` is a global PRIMARY KEY; cached passage ids would collide across sources). Cancellation boundaries preserved (abort checked after the byte read and after the parse).
- `src/components/workspace/DiagnosticsDialog.tsx` - NEW: the perfLog diagnostics surface (status bar "Diagnostics" button): the ring buffer rendered newest-first (time/kind/value/detail), REAL aggregates (mean TTFT, mean duration with counts - measured, not estimated), Refresh + Clear. Local only, per the perfLog contract.
- `src/components/workspace/WorkspaceStatusBar.tsx` - the Diagnostics entry point (Activity icon).
- `src/utils/api.ts` - BOUNDED CONCURRENCY for independent tool calls (5.5b): `runBounded` (limit MAX_PARALLEL_TOOLS=4) runs one batch's tool calls in both research loops (OpenAI + Anthropic) instead of strictly sequentially. Stop discipline preserved: workers not yet started never run; completed results still feed back into history/toolContext; an interrupted batch returns stopped (R9's "stop during a tool batch" contract kept - all 13 api tests pass unchanged + 1 new).
- `src/services/revisionService.ts` - requestProposal now runs as an OPERATION (type "proposal", 5.5b): the request carries the operation's AbortController signal (real cancellation), the operation settles terminal (completed/failed/stopped/aborted), and the proposal is persisted ONLY after the stale-generation check (a restore mid-request never writes a proposal onto the restored dataset). Cancelled requests return `{ cancelled: true, operationId }` (a user decision, not an error). NEW export `cancelProposalRequests(documentId)` - the service-side cancel.
- `src/components/editor/EditorToolbar.tsx` - while a revision request runs, the Revise/Tighten/Clarify/Comment menu becomes a "Cancel…" affordance calling cancelProposalRequests.
- `src/components/editor/DocumentEditorView.tsx` - handles the cancelled result (no error banner) + wires onCancelRevision.
- `src/services/aiOperations.ts` - `AiOperationType` gains "proposal".

Tests: `src/services/__tests__/sourceExtraction.test.ts` (NEW, 2: identical content parses ONCE with passages re-derived (same locators/content, FRESH ids per source); different content re-parses; 12 uploads evict the oldest entries - the first is re-parsed, the last stays cached); `src/components/__tests__/diagnostics.test.tsx` (NEW, 2: rows newest-first + real means + Clear empties; empty-buffer state); `api.test.ts` +1 (a 6-call batch runs through the bounded pool: max in-flight is 4 AND >1 (the pool is real), and every result maps back to its OWN tool_call_id); `revisionService.test.ts` +2 (a cancelled request settles aborted in the operation service and persists NOTHING; a stopped result likewise; cancel after settlement reports false).

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 312 passed (35 files). `npm run build` - OK. (No Rust changes; cargo gates verified green at the 5.4e boundary and re-run at the Phase 5 acceptance gate.)

Known limitations (5.5b):
- The extraction cache is in-memory (per session); a RESTART re-parses (the source row itself still dedupes by content hash at the repository level).
- Tool-call concurrency is capped at 4 per batch; rounds remain sequential (per the R9 loop design).
- Proposal-request cancellation surfaces only through the editor toolbar (the Review panel has no running-request indicator).

### 5.5 (batch c) - the evaluation harness

Completed: 2026-09-16.

THE QUALITY GATE: no model substitution or context trimming may ship as an "optimization" without a before/after run of this harness (Settings → AI evaluation).

Files changed:
- `src/services/evalHarness.ts` - NEW: the harness core.
  - EVAL_TASKS: 6 representative FIXED tasks (revise with quotation+citation, tighten with a shrink expectation, clarify in SPANISH, revise with Arabic content + names, comment, revise with numbers/dates + a Spanish quotation) - Unicode-rich, decolonial-writing-flavored.
  - Five deterministic, LOCAL scorers (no second model judging another): `scoreQuotationFidelity` (every quoted span VERBATIM in the output), `scoreVoice` (terminology/names survive, case-insensitive), `scoreMeaning` (a documented CONTENT-WORD RETENTION PROXY - imperfect but stable; the SAME yardstick before/after is what makes comparisons honest; gate 0.6), `scoreCitations` (the passage's citation markers survive verbatim AND no new author-date marker is invented - the app never invents citation details, neither may a revision), `scoreCompleteness` (non-empty, no meta preamble, no instruction echo, no-op echoes fail, tighten must shrink, replacements stay within 0.3x-2.5x length, comments are substantive).
  - `runEvaluation`: sends every task through the SAME `buildRevisionInstruction` + `REVISION_SYSTEM_PROMPT` the proposal flow uses (single source of truth - extracted from revisionService), webSearchEnabled forced false, cancellable via signal, reports the model identity + per-dimension summary means.
- `src/services/revisionService.ts` - `buildRevisionInstruction` + `REVISION_SYSTEM_PROMPT` extracted (requestProposal uses them unchanged).
- `src/components/settings/EvalReportView.tsx` - NEW: the runner UI (lazy-loads the harness - it code-splits into its own ~6 kB chunk): run/cancel, progress readout, the five dimension means (color-coded), per-task failures with the EXACT scorer detail (which quote was lost, which citation was invented, which term disappeared), key-required guard. Real requests are sent and the UI says so.
- `src/components/settings/SettingsDialog.tsx` - the "AI evaluation" section.

Tests: `src/services/__tests__/evalHarness.test.ts` (NEW, 7: quotation verbatim/loss/comment-exemption; voice terminology; the meaning proxy's stability + loss reporting; citations kept/invented-penalty/comment-half; completeness no-op/meta/un-shrunk/thin-comment + a good tighten; runEvaluation sends through the REAL instruction builder with webSearchEnabled false and scores honestly - an echo fails completeness only while quotation/citations/meaning hold; a dropped quotation + invented citation fail the task and drag the summary). TOTALS: `npx tsc --noEmit` OK · `npm test` 319 passed (36 files) · `npm run build` OK (evalHarness in its own 6 kB async chunk).

Known limitations (5.5c):
- "Meaning" is a retention PROXY, not semantic understanding - deliberately: the value is a stable, local, reproducible measurement, not a judge. Human review still matters for meaning claims.
- The task set is fixed and small (6); it measures REGRESSION of the proposal flow's quality dimensions, not general writing quality.
- The evaluation is sequential and synchronous with the dialog open (6 small requests); no parallelism (the point is measurement, not speed).

## PHASE 5 ACCEPTANCE RUN (final, 2026-09-16)

Every gate from the phase list, demonstrated (the cited tests run real editors / real repositories / real temp SQLite files — not just mocks):

- [x] **Selected-text revision is reviewable and undoable** — revisionService.test.ts: selection → request → persisted pending proposal → before/after Review cards → Accept applies ONE undoable ProseMirror transaction (history boundary proven by can().undo()); accepted status persisted.
- [x] **Stale proposals cannot overwrite edits** — base-rev mismatch → status stale, NOTHING applied, no undo entry; ambiguous/not-found fragments refused without mutation (9+ dedicated revisionService tests).
- [x] **Context preview matches the request** — contextCompiler.test.ts: the "What will be sent?" manifest IS the compiled payload the send uses (same object attached to the operation); excluded sources verifiably absent from the payload.
- [x] **Source links survive restart/backup** — Rust `sources_roundtrip_dedup_and_restore` (real temp SQLite): dedup by content identity, read-back with passages, rev-checked saves, dump roundtrip, cascade delete; backup validation checks unique ids AND unique hashes.
- [x] **Citation export is reproducible** — bibliography.test.ts round-trips (BibTeX, RIS, CSL JSON); citation.test.tsx + footnote.test.tsx (citations/footnotes survive markdown export → reimport with source ids/contents); cslProcessor.test.ts (the same sources produce the same style-sorted processor output).
- [x] **Cancellation works throughout research** — api.test.ts R9 discipline (early events, abort during startup, stop during a tool batch, EOF-as-interrupted) + cancel-latency marks in the perf ring buffer; proposal requests are cancellable through the operation service (5.5b tests: settled aborted, nothing persisted).
- [x] **Optimizations show measured benefit without demonstrated quality regression** — perfLog marks (ttft/duration/request-size/cancel-latency) surfaced in the Diagnostics dialog with real means; the EVALUATION HARNESS (5.5c) is the quality gate: no model substitution or context trimming ships without a before/after EvalReportView run.
- [x] **5.1 re-verified** — versioned source fields; five DISTINCT verification states; user-controlled context inclusion; dedup by content identity; cancellable background extraction with explicit truncation; original text preserved verbatim (sourceStore tests + Rust roundtrip + the 5.5b extraction-cache tests, which also keep passage ids per-source).
- [x] **CSL-processor bibliography styles + footnotes/locators** (5.4e) — citeproc-js drives bibliographies in 3 styles + DOCX footnotes (see the 5.4e entries above).

Final gate commands (all run at the boundary, all green):
- `npx tsc --noEmit` — OK.
- `npm test` — **319 passed (36 files)**.
- `npm run build` — OK (evalHarness/cslEngine in their own async chunks).
- `cargo test --lib` — **66 passed** (incl. the native smoke test, real-file migration, corrupt-DB failure injection).
- `cargo check` — OK.

PHASE 5 IS COMPLETE. Still deferred (deliberately, low priority — each is a project of its own): DNS-rebinding connect-time IP verification (R9 note); conflict-resolution UI for conflicting browser copies (R4 note); pin/archive states (Phase 3 note); per-send source picking beyond project scope (5.2 note); composer attachment persistence across restarts (R8 note).

## Deferred notes picked up (2026-09-16)

### D1 - DNS-rebinding connect-time IP verification (R9 note)

Completed: 2026-09-16.

Files changed (`src-tauri/src/lib.rs`):
- `is_blocked_ip(ip)` - the IP block list extracted as a single source of truth (hostname checks AND the resolution check use it).
- `verify_resolved_addrs(addrs)` - PURE, offline-testable: validates a set of RESOLVED addresses; a public hostname resolving to a private address (even MIXED with public ones) is refused BEFORE any connection; empty resolutions refused; returns the first allowed address to pin.
- `resolve_verified_host(host, port)` - IP literals validated directly (no lookup); hostnames resolved via `tokio::net::lookup_host` and every address verified.
- `fetch_public_validated` - EVERY hop now resolves + verifies + PINS the connection: a per-hop client is built with `resolve(domain, verified_socket_addr)` (the URL hostname stays for TLS/SNI/cert validation while the connect IP is forced to the verified address - no second DNS lookup between check and connect). Call sites use `HttpClients::scrape_builder()` (same UA/redirect-none/connect-timeout configuration).
- `zen_web_search`/`zen_fetch_page` no longer need the shared scrape client state (removed unused params).

Tests (Rust): `resolved_addresses_are_verified_before_connecting` (clean public resolution pins the first address; rebinding refusal; private-only refusal; empty refusal; IPv6 unique-local caught), `ip_literal_hosts_are_verified_directly_without_lookup` (public literal ok; loopback/link-local literals blocked; "localhost" refused via resolution).

INCIDENT (recovered): a call-site replacement was made via PowerShell `Get-Content`/`Set-Content` despite the standing prohibition - this re-encoded lib.rs (UTF-8 → cp1252 mojibake + BOM, 200 corrupted sequences). RECOVERED the same way as the 4.1 incident: reversed the exact cp1252 round-trip with explicit .NET encodings ([IO.File]::ReadAllText/WriteAllText only), verified 0 mojibake matches + em-dashes/arrows intact + all 66 tests passing after. Reinforced: FILE EDITS go exclusively through the dedicated file tools or Python with explicit UTF-8 - even for "simple" mechanical replacements.

Commands run and results:
- `cargo test --lib` - 68 passed (was 66; +2). `cargo check` - OK (no warnings).

Known limitations (D1):
- Each hop builds a fresh pinned client (no connection pooling across research fetches) - the cost is negligible at research-call frequency and the pin is the security property.
- The OS resolver is trusted for the lookup itself (verification happens on its RESULTS).

### D3 - Pin/archive states (Phase 3 note)

Completed: 2026-09-16. Schema v11 (`SUPPORTED_SCHEMA_VERSION = 11`): `archived INTEGER NOT NULL DEFAULT 0`, `pinned INTEGER NOT NULL DEFAULT 0` on BOTH `texts` and `threads`.

Files changed:
- `src-tauri/src/repository.rs` - SCHEMA_V11 (column-adding migration); `TextRow`/`ThreadRow` carry `archived`/`pinned` (serde default false - legacy dumps import unchanged); row readers, INSERT/upsert paths (creation + imports carry the states) updated; `text_set_state`/`thread_set_state` - metadata-only, update-only, revision-checked (unmentioned fields keep their values, unpin/unarchive via false); `db_text_set_state`/`db_thread_set_state` commands registered. Whole-row saves (text_save/thread_save) do NOT touch the new columns, so they can never clobber a pin/archive set by the navigator.
- `src/types/index.ts` - `LibraryTextMeta`/`ThreadMeta` gain optional `archived`/`pinned` (absent = false for legacy rows).
- `src/utils/repository.ts` - wire structs + converters carry the fields (absent normalizes to absent/false); `textSetState`/`threadSetState` on BOTH backends (SQLite commands; JSON backend writes library.json/threads.json metadata, flushes pending saves first); shared contract fixtures gained the fields.
- `src/test/fakeRepository.ts` - same semantics.
- `src/stores/libraryStore.ts` / `src/stores/chatStore.ts` - `setTextState`/`setThreadState` (acknowledged metadata op + in-memory update).
- `src/components/workspace/ProjectNavigator.tsx` - PINNED rows first in every list (recency order preserved within the groups); ARCHIVED rows leave the main lists and the project lists; a collapsible "Archived (N)" section at the bottom lists archived documents + conversations with restore actions; hover actions on standalone rows (Pin/Unpin - a pinned row keeps its button visible - and Archive). FIXED a pre-existing defect while restructuring: the conversation Rename button had `opacity-0 group-hover:opacity-100` but no `group` class on its row - it was permanently invisible; rows now carry `group`.

Tests: Rust `pin_archive_states_roundtrip_through_dump_and_set_state` (defaults false; pin/archive with unmentioned fields preserved + rev bump; states ride the dump → import cycle; unpin via the same op); the shared contract fixtures updated (5 exact-payload tests pass on both sides); workspaceShell navigator test queries by exact name (the row vs its Pin/Archive action buttons). FINAL GATES: `npx tsc --noEmit` OK · `npm test` **329 passed (36 files)** · `npm run build` OK · `cargo test --lib` **69 passed** · `cargo check` OK.

Known limitations (D3):
- Pin/archive actions live on the standalone navigator rows (project children show only the pinned-first ordering; archiving a project-owned item happens via... it does not yet - project children lack the hover actions; move the item out of the project or use the archived section for standalone items only).

## Upcoming batches (not started)

- None - all five deferred notes are picked up (D1-D5).

### D5 - Conflict-resolution UI for conflicting browser copies (R4 note)

Completed: 2026-09-16.

Files changed:
- `src/utils/bootstrap.ts` - `resolveConflict(path, winner)`: the explicit winner choice the R4 note deferred. "browser" overwrites the native file with the dws: copy (the copy is removed ONLY after the write succeeded - the adoption discipline); "native" keeps the native file and deletes the browser copy. Malformed/missing copies resolve nothing (false) and stay reported.
- `src/App.tsx` - the recovery banner now renders CONFLICT rows as decision cards with two explicit buttons ("Use the browser copy" / "Keep the native file"), each confirmed via a warning dialog (both choices destroy the loser - that is what resolution means, and now the user makes it); a resolved conflict disappears from the report; a failed resolution reports "nothing was changed" and both sides stay. The banner text is honest: "nothing was deleted without your explicit choice."

Tests: bootstrap.test.ts +4 (keeping the native file deletes ONLY the browser copy and never touches the file; using the browser copy overwrites the native file and removes the copy after the write; a failed write keeps the browser copy; nothing-to-resolve returns false and keeps everything in place). TOTALS: `npx tsc --noEmit` OK · bootstrap 11 passed.

Known limitations (D5):
- Resolution is per-conflict, one at a time (conflicts are rare by design - both sides are preserved until a decision).
- D5: conflict-resolution UI for conflicting browser copies (R4 note).

### D4 - Per-send source picking beyond project scope (5.2 note)

Completed: 2026-09-16.

Files changed:
- `src/services/contextCompiler.ts` - `ContextSourceInput.omittedReason` (verbatim override for the manifest's omission wording) + `applySourcePicks(scoped, pickedIds)`: a pick REPLACES the inclusion decision for the send - picked sources ride (the more recent explicit act, visibly), unpicked ones are omitted with the exact reason "Not picked for this send." Shared by the send path AND the preview so the manifest can never disagree with the request. Empty/absent pick = unchanged default behavior.
- `src/stores/chatStore.ts` - `threadSourcePicks` per thread + set/clear; cleared with the thread (delete) and on restore. In-memory per-thread state (like briefIncludedByThread).
- `src/services/chatSend.ts` - the send compiles with applySourcePicks.
- `src/components/tabs/ChatTab.tsx` - the preview compiles with the SAME picks + the SendSourcePicker disclosure above "What will be sent?": per-source checkboxes seeded from the CURRENT effective set on first interaction, "N of M will ride" summary, reset-to-Sources-panel button when an override is active.

Tests: contextCompiler.test.ts +2 (a pick overrides inclusion for the send with exact omission reasons - the payload contains ONLY the picked material and the manifest reports "Not picked for this send." verbatim; an empty/absent pick leaves the default behavior). TOTALS: `npx tsc --noEmit` OK · contextCompiler 7 passed · chatStore 19 passed.

Known limitations (D4):
- Picks are in-memory per-thread (a restart returns to the Sources-panel defaults; the manifest always shows what will actually ride).
- The compact assistant does not render the picker yet (same pipeline; the full discussion view is the picker surface).

### D2 - Composer attachment persistence across restarts (R8 note)

Completed: 2026-09-16.

Files changed:
- `src/stores/chatStore.ts` - composer attachments now persist through the preferences table (key "composer-attachments", debounced 300ms like drafts; `scheduleAttachmentPersist` on set/clear/delete; `hydrateComposerAttachments()` at startup; `flushComposerAttachments()` in the close drain AND the updater-relaunch drain). Bounded: threads whose extracted text exceeds a 512k-char budget are kept in MEMORY for the session but not persisted (largest-first skip, never truncated content). A backup restore CLEARS the persisted set (pre-restore attachments must not resurrect). `resetComposerAttachmentHydration` is the test seam.
- `src/App.tsx` - hydrate once storage is ready; flush after the drafts in the close drain.
- `src/components/settings/SettingsDialog.tsx` - flush before the updater relaunch.

Tests (chatStore.test.ts +4): set → debounce → pref written → "restart" (wipe memory, hydrate) restores library+file attachments; consumption/deletion follows persistence (clearThreadAttachments keeps only unconsumed; deleteThread drops the thread's persisted entry); oversized attachments stay in memory but are skipped in persistence (small thread kept); a restore discards persisted attachments.

Commands run and results:
- `npx tsc --noEmit` - OK. `npx vitest run src/stores/__tests__/chatStore.test.ts` - 19 passed.

Known limitations (D2):
- The budget (512k chars total) is a memory bound: oversized attachments live only for the session (the message history still carries whatever was actually sent).

## Repair programme (milestones A-E)

The entries above are implementation history. This section records the repair
batches against real production paths; each entry lists what was actually
run, not what was intended.

### B01 - Make exported backups importable

Completed: 2026-09-16.

Root cause: Rust's `StoredMessageRow`/`StoredSourcePassageRow` use
`#[serde(flatten)]`, so `db_export` writes message/passage fields into the
parent row (`{threadId, idx, role, ...}`), while the frontend validator
required `row.message` / `row.passage`. Every desktop-generated v3 backup
therefore failed `parseBackupBundle` on import. Secondary defects: no
proposals validation at all (silently unvalidated), no integer-version
check, no content-schema ceiling, no composite-identity checks, non-
deterministic export row order, and `apply_dump` used `INSERT OR IGNORE` /
upserts that could silently drop or merge duplicate identities.

Files changed:
- `src/utils/backup.ts` - canonical dump contract: exported `CanonicalDump`
  + row types exactly matching the Rust serializer (camelCase, all fields
  present, message/passage rows FLATTENED). New `normalizeDump` /
  `normalizeDumpChecked` convert historical nested `message`/`passage`
  payloads explicitly (supplying serde defaults such as `failed: false`)
  and reject: non-integer/unsupported bundle versions, unsupported
  content-schema versions, unknown content formats, duplicate row ids and
  duplicate composite identities (messages `(threadId, idx)`, textContents
  `textId`, textVersions `(textId, versionId)`, projectBriefs/threadBriefs
  parent ids, source ids/hashes, proposal ids), unknown enum values,
  malformed JSON strings (`briefJson`, `attachmentsJson` must be a JSON
  array), and relationship violations (project/thread/source project refs,
  proposal document refs, orphan children). `parseBackupBundle` returns a
  bundle whose `data`/`db` are canonical only, so the nested shape can never
  reach Rust. `buildBackupBundle` now validates its own `db_export` output
  and ABORTS the export if the production payload would not pass the
  production parser (no unimportable file is written).
- `src-tauri/src/repository.rs` -
  - `apply_dump` is strict: plain INSERTs (texts, projects, threads,
    sources, project briefs, thread briefs, text versions) so duplicate
    identities fail the restore transaction instead of being ignored;
    unknown content formats and content schema > `SUPPORTED_CONTENT_SCHEMA_VERSION`
    are refused before the row is written (rollback leaves the dataset
    untouched).
  - `source_upsert_import` (ON CONFLICT DO UPDATE) replaced by strict
    `source_insert`; `thread_data` no longer upserts during import.
  - `SUPPORTED_CONTENT_SCHEMA_VERSION` constant; `default_content_schema_version()`
    uses it.
  - Deterministic export: ORDER BY added to text_contents, text_versions,
    project_briefs, thread_briefs, proposals and `, id` tiebreakers on the
    texts/projects/threads/sources lists - byte-stable snapshots.
- `src/test/backup-contract.json` - NEW shared fixture GENERATED BY RUST
  (`regenerate_backup_contract_fixture`, ignored test writing the file)
  containing a rich manuscript (tiptap-json + markdown), history with
  labels, project + brief, conversation messages with attachments and a
  legacy id-less failed message, sources + passages + locators, proposals,
  and all non-secret preferences (recovery drafts, shell state, settings,
  price table, keyless config).
- `src/utils/__tests__/backup.test.ts` - new suites: canonical validation
  (integer versions, credential, duplicates incl. composite, dangling
  references, unsupported content schema/format, malformed JSON/enums),
  historical nested conversion, the Rust fixture parsed through the
  production parser with full row equality (the regression for this batch),
  and the desktop export path (`db_export` -> validated, importable bundle;
  an invalid dataset aborts the export).

Rust tests added (`src-tauri/src/repository.rs`):
- `regenerate_backup_contract_fixture` (ignored; writes the shared fixture
  from the actual Rust serialization).
- `backup_contract_fixture_roundtrips_through_rust` - deserializes the
  fixture into `DbDump`, applies it through `apply_dump`, re-exports and
  asserts value equality with the fixture (serde-drift guard); preferences
  round-trip through the `PrefRow` shape.
- `production_export_reimports_faithfully` - seeds through the production
  create/save APIs (text + snapshots, project + brief, thread + messages +
  attachments, source + passage, proposal), exports, re-imports into a
  second database, re-exports: identical payloads.
- `duplicate_identities_fail_restore_without_mutation` - messages,
  text_versions, project_briefs, sources; failed restores roll back and the
  pre-existing dataset is unchanged.
- `unsupported_content_contract_fails_restore` - schema v2 / `latex`
  refused with the pre-existing data intact.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 341 passed (36 files); backup suite 24 passed.
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 73 passed, 1 ignored (the fixture generator).
- `cargo check` - OK.

Remaining defects / limitations (B01):
- The v2 (dev-era) bundle reader is now held to the same strict validation;
  a v2 dump with dangling project references or duplicate composite keys is
  rejected rather than partially imported. No shipped release produced v2
  bundles, so this affects development artifacts only.
- `parseBackupBundle` still returns `null` for a rejected bundle; the
  specific reason is available through `normalizeDumpChecked` for callers
  that want to show it (the Settings dialog still shows the generic
  "not a valid backup" message).
- The fixture's preferences are validated structurally by Rust only (the
  frontend checks the credential and object shape); per-preference schema
  validation (settings/drafts) is not part of this batch.
- The restore path itself was not changed beyond the parser/strict-import
  boundary; exclusivity/maintenance work is B07 and recovery snapshots are
  B09.

Exact next batch: B02 - Initialize the workspace and unify conversation
navigation.

### B02 - Initialize the workspace and unify conversation navigation

Completed: 2026-09-16.

Root causes found: (a) the workspace route and the chat owner were separate
state - `openDiscussion(id)` only set the route, while `ChatTab` displayed
whatever `chatStore.activeThreadId` held (`loadThreads` picked the newest
thread), so selecting B showed A's messages; the in-chat switcher changed
the thread but not the route. (b) Cold startup loaded nothing: documents
and projects were never fetched (the navigator stayed empty until the
manage view mounted), recovery drafts were never hydrated, and settings
load raced the storage bootstrap. (c) `switchThread` entered its loading
state only after awaiting a flush, leaving the previous conversation
visible and composable under the new route for that window. (d) ChatTab's
`scopedSources` selector filtered/mapped inside `useSelector`, returning a
new array per snapshot read (React "Maximum update depth exceeded").
(e) Configure API was wired to `setView({kind:"list"})`. (f) ChatTab
required the caller to pass a settings opener that did not exist.

Files changed:
- `src/stores/useAppStore.ts` - `openDiscussion` is now the ONE conversation
  navigation action: updates the workspace route, loads the requested owner
  (`switchThread`), falls back through the thread list when the owner no
  longer exists (adopting what the fallback selects), and treats `null` as
  "open the assistant" (adopt the current owner, else let the thread list
  pick/create). `setActiveTab("chat")` and `hydrateShell` route through it,
  so legacy handoffs and restored selections cannot disagree either.
- `src/stores/chatStore.ts` - `loadThreadInventory` (list only, no
  selection/creation side effect) is what startup hydrates;
  `loadThreads` shares one in-flight run (two "no threads" observations can
  no longer create two threads), still repairs a vanished active thread;
  `switchThread` sets `threadLoaded:false` SYNCHRONOUSLY before any await,
  returns whether the requested owner was found (superseded loads report by
  ownership), and reports a missing owner without presenting an empty
  conversation under its id.
- `src/components/tabs/ChatTab.tsx` - select the stable `sources` array and
  derive `scopedSources` with `useMemo` (unstable-snapshot fix); the thread
  switcher runs through `openDiscussion`; new-conversation and delete
  actions route the resulting owner; uses the real settings opener.
- `src/components/workspace/CompactAssistant.tsx` - while a switch loads,
  shows "Loading conversation…" instead of the previous thread's messages.
- `src/components/workspace/DocumentPane.tsx` - takes the real
  `onOpenSettings` and passes it to ChatTab; the empty state's "Open the
  assistant" goes through `openDiscussion(null)`.
- `src/components/workspace/WorkspaceShell.tsx` - owns the settings dialog
  and passes its opener into the document pane; the duplicate shell
  hydration was removed (App hydrates once).
- `src/App.tsx` - one startup sequence in dependency order: bootstrap
  storage -> settings, recovery drafts, composer attachments ->
  inventories (documents, projects, conversations) -> shell state last (a
  restored conversation selection loads its owner). The workspace renders
  only after the whole sequence succeeded; an inventory failure shows the
  startup error screen with Retry (nothing imported/deleted). The dead
  duplicate SettingsDialog was removed.
- `src/services/chatSend.ts` - `canSend()` and `sendChatMessage()` require
  `threadLoaded`, so no send can target a conversation whose messages are
  not the requested owner's.
- `src/test/setup.ts` - jsdom `scrollIntoView` stub (the chat auto-scroll
  uses it; without it every ChatTab render threw).
- `src/components/__tests__/conversationNavigation.test.tsx` - NEW (5 jsdom
  tests): selecting B from A flips route/messages/active owner/send source;
  composing is disabled and the previous messages hidden until the delayed
  load lands; the real ChatTab renders without unstable-snapshot warnings
  (verified to fail with "Maximum update depth exceeded" against the old
  selector); a dangling route id falls back to a real owner; Configure API
  opens the real Settings dialog and does not navigate away.
- `src/components/__tests__/appStartup.test.tsx` - NEW (3 jsdom tests):
  cold startup stays blank until settings/drafts/shell/inventories hydrate,
  then shows existing documents and conversations; an inventory failure
  shows Retry and recovers; a persisted discussion selection restores the
  route AND loads the owner's messages.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 349 passed (38 files; +8).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 73 passed, 1 ignored.
- `cargo check` - OK.

Remaining defects / limitations (B02):
- The route-owner invariant is enforced at the navigation action; code
  that writes `useAppStore.setState({ view: {kind:"discussion"} })`
  directly (tests) bypasses it and can disagree until the next action.
- Startup blocks the UI until the inventories land (blank window, no
  progress indicator); a very large library shows a longer empty screen
  rather than a spinner.
- `loadThreads` still creates an "Untitled conversation" when the
  assistant is opened on a dataset with no conversations (existing
  product behavior, now explicit at startup only for a restored
  `discussion/null` selection).
- The compact assistant's "configure" note is unchanged (it points at
  Settings; the full view now opens it directly).

Exact next batch: B03 - Capture editor changes before navigation.

### B03 - Capture editor changes before navigation

Completed: 2026-09-16.

Root causes: the editor debounced the draft projection 500 ms and CANCELLED
the timer on unmount, so a change made 100 ms before navigating never
reached the recovery draft (and the document was gone on return); every
unsaved new document shared the `text:new` draft key (two new documents
overwrote each other); new-document recovery was bypassed entirely (the
`!id` branch set an empty body before consulting the draft); metadata-only
drafts with `content: ""` would have replaced the stored body; explicit
discard left the optimistic library cache holding the discarded body.

Files changed:
- `src/components/editor/useDocumentSession.ts` - per-transaction
  `markEdited(doc)` marks the session dirty IMMEDIATELY (ref + one state
  transition) and retains the latest ProseMirror document independently of
  the debounced projection; `projectLatest()` is a synchronous capture;
  a module-level registry + `capturePendingEditorChanges()` lets drains
  flush every mounted editor; unmount FLUSHES instead of cancelling; a
  unique `sessionId` gives every unsaved document its own
  `text:new:<session>` key; `draftToBody` recovers new-document bodies
  (and ignores metadata-only empty-content drafts); the load effect checks
  the draft BEFORE the new-document empty fallback; `discard()` sets a flag
  so cleanup cannot resurrect discarded text and invalidates the optimistic
  library cache.
- `src/components/editor/RichTextEditor.tsx` - immediate `onSessionEdit`
  signal per transaction (no serialization/re-render) alongside the
  debounced draft projection; timers remain, but the latest document does
  not depend on them.
- `src/components/editor/DocumentEditorView.tsx` - passes `sessionId`,
  edits the editor by `session.draftKey`, discards through `session.discard`.
- `src/stores/useAppStore.ts` - edit views carry `sessionId`;
  `openNewDocument()` mints a fresh identity; `openDocument()` helper.
- `src/components/workspace/DocumentPane.tsx` - new-document paths
  (project "new text", library paste/new) go through `openNewDocument`;
  the editor is keyed by id OR session identity; `sessionId` is passed.
- `src/stores/libraryStore.ts` - `invalidateTextContent(id)` drops the
  optimistic cached body (explicit discard reads the persisted body again).
- `src/App.tsx` / `src/components/settings/SettingsDialog.tsx` - close and
  relaunch drains call `capturePendingEditorChanges()` BEFORE `flushDrafts`.
- `src/test/fakeRepository.ts` - a scheduled save with an ARMED failure no
  longer silently succeeds first; the failure belongs to the awaited flush
  (matching the real repository).
- `src/test/setup.ts` - jsdom client-rect/scroll stubs for ProseMirror.
- `src/components/__tests__/documentEditor.test.tsx` +4 B03 tests: an edit
  100 ms before navigation survives unmount and remount (and shows Unsaved
  immediately); the synchronous capture flushes before a drain; two
  unsaved new documents in different projects keep separate bodies and
  metadata (no shared `text:new`); explicit discard stays discarded across
  unmount/remount (stored body returns, discarded text does not).

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 353 passed (38 files; +4).
- `npm run build` - OK. `cargo test --lib` - 73 passed, 1 ignored.
- `cargo check` - OK.

Remaining defects / limitations (B03):
- Formatted marks are captured through the same document transaction; the
  recovery draft stores the rich JSON (format preserved), verified by
  existing round-trip tests, not by a dedicated formatting test.
- A new unsaved document's draft is only reachable while its workspace
  view (with its session identity) is restored; there is no navigator
  entry for an unsaved document (by design, unchanged).
- Metadata-only drafts keep `content: ""` in the draft record (the body is
  recovered from the stored document); the payload shape is cleaned up in
  B04.

Exact next batch: B04 - Fix draft payloads and Save acknowledgements.

### B04 - Fix draft payloads and Save acknowledgements

Completed: 2026-09-16.

Root causes: a failed Save recorded an error draft with no manuscript (an
untouched document's remount recovered an EMPTY body); Save cleared the
draft unconditionally, wiping edits typed while the save was in flight; a
late new-document save callback still called `onSaved` after the user had
navigated away; ProjectDetail was not keyed by project identity, so A's
brief editor and edit-dialog fields stayed in B's page.

Files changed:
- `src/components/editor/useDocumentSession.ts` - monotonic session edit
  version (`editVersionRef`, incremented by every transaction AND metadata
  edit). Save captures the submitted version; only that version is
  acknowledged (`clearDraft` + clean). Edits typed during the save leave
  the draft dirty and recoverable. On failure the EXACT attempted
  manuscript is recorded with the error when nothing newer exists;
  otherwise newer text is preserved and only the error is added.
- `src/stores/draftStore.ts` - `markError(key, message, patch?)` can carry
  the attempted content/meta; without it, existing content is preserved
  (never replaced with `content: ""`).
- `src/components/editor/DocumentEditorView.tsx` - `aliveRef` guard: a
  save that completes after unmount no longer calls `onSaved` (no late
  navigation).
- `src/components/library/ProjectDetail.tsx` - brief Save captures the
  submitted revision; newer typing keeps the editor open and the draft
  dirty; failure records the submitted text only when no newer text
  exists.
- `src/components/workspace/DocumentPane.tsx` - ProjectDetail keyed by
  project id: switching projects fully resets the brief editor and modal
  state.
- `src/components/__tests__/saveAcknowledgement.test.tsx` - NEW (4 jsdom
  tests): title-only edit keeps body+title on remount; failed untouched
  Save keeps body+error; Save A → type B → acknowledge A leaves B
  recoverable and Unsaved (B is persisted on remount); project A → B
  leaks neither brief text nor edit-dialog fields (and A's own draft is
  still there on return).

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 357 passed (39 files; +4).
- `npm run build` - OK. `cargo test --lib` - 73 passed, 1 ignored.

Remaining defects / limitations (B04):
- A concurrent second Save while one is in flight is refused (`saving`
  guard); the user retries after the first settles.
- Project brief saves do not carry an expected revision (projectStore
  updates are whole-row); the session-level version guard covers the
  recovery layer only.

Exact next batch: B05 - Repair domain saver composition, drainage, and retries.

### B05 - Repair domain saver composition, drainage, and retries

Completed: 2026-09-16.

Root causes: `saveNow` cancelled a pending debounced write and persisted
only its own args (a rename dropped a pending body save); `flush` cleared
each entry's timer only right before awaiting its write, so a timer could
fire mid-flush and run the same entry twice; retained failures from
timer-fired writes were invisible to later flushes; a queued local save
pinned the revision from schedule time and went stale when an earlier
queued save advanced it; the retry closure blindly refreshed the expected
revision and could overwrite newer content; history restore sent no
expected revision; there was no user-facing retry/conflict/discard UI.

Files changed:
- `src/utils/repository.ts` -
  - `createSaver` takes a merge function: partial pending updates compose
    (omitted body/brief preserves the pending value). `saveNow` merges the
    pending entry instead of dropping it.
  - `flush` detaches the COMPLETE batch and cancels every timer
    synchronously before awaiting any write; entries scheduled after the
    detach are untouched.
  - `drain` = flush + fail visibly while earlier writes are retained.
  - Queued writes adopt a revision advanced by THIS saver's own earlier
    queued write (`ownRev`); an advance from anywhere else keeps the
    pinned expectation and is rejected as stale.
  - Retained failures carry BOTH a pinned-revision `retry` and an explicit
    `overwrite` (rebase onto the current revision), plus `discard`;
    `resolveSaveFailure(key, "overwrite" | "discard")` exposed.
  - `repositorySaveState()` exposes scheduled/in-flight/failed counts;
    `saveState()` added to the repository interface.
  - History restore sends `expectedRev` from the revision cache.
  - `flushLibrarySave`/`flushProjectSave`/`flushChatSave` use the new
    drains (drain + idle).
- `src/components/workspace/SaveFailuresDialog.tsx` - NEW: every retained
  failure (including hidden conversations) with Retry / Overwrite /
  Discard.
- `src/components/workspace/WorkspaceStatusBar.tsx` - reads
  `repo.saveState()` and shows "Saving — N writes pending" instead of
  "Saved"; the failure label opens the dialog.
- `src/test/fakeRepository.ts` - new interface members.
- `src/utils/__tests__/repository.test.ts` - +4 B05 regressions on the
  real adapter: saveNow merge; flush detaches its batch (blocked first
  write cannot make the second run twice); drain fails visibly after a
  timer failure and the retained payload retries; queued local saves
  adopt their own advancement while external staleness stays rejected.
  The restore test now asserts the transmitted `expectedRev`.

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 361 passed (39 files).
- `npm run build` - OK. `cargo test --lib` - 73 passed, 1 ignored.

Remaining defects / limitations (B05):
- The status bar failure dialog is the only retry surface; an inline
  per-document banner would need B07's session reset discipline.
- The JSON backend still stores revisions per registry write; both
  backends share the corrected saver.

Exact next batch: B06 - Make preference/draft drains acknowledged and exits conditional.

### B06 - Make preference/draft drains acknowledged and exits conditional

Completed: 2026-09-16.

Root causes: preference writes were fire-and-forget (`void setPref(...)`)
with no retention, so a delayed or rejected write was invisible; the
draft/attachment flushes only waited for a PENDING debounce timer (a timer
that had already fired left its write unawaited); the close and relaunch
drains ignored rejections and destroyed/relaunched anyway; the status bar
could claim "Saved" while preference or domain writes were pending.

Files changed:
- `src/utils/preferences.ts` - acknowledged write tracking: every `setPref`
  is retained (`value`, in-flight `promise`, `error`) until transport
  success; latest value per key wins; `flushPreferences()` awaits in-flight
  writes, retries retained failures once, and throws while anything is
  still retained; `preferenceFailures()`, `discardPreference()`,
  `pendingPreferenceWrites()`, `subscribePreferences()`, test seam.
- `src/stores/draftStore.ts` / `src/stores/chatStore.ts` - the debounced
  persists keep the promise they started; `flushDrafts()` /
  `flushComposerAttachments()` await it even when the debounce already
  fired.
- `src/App.tsx` - `drainForExit()` collects every domain/preference
  failure; the close handler prevents exit while work cannot be saved and
  shows a dialog with Retry exit / Cancel / explicit "Discard work and
  exit"; the last one resolves retained saves/preferences and then exits.
- `src/components/settings/SettingsDialog.tsx` - updater relaunch drains
  first and keeps the app open on failure, offering "Retry restart" and
  "Discard work and restart".
- `src/components/workspace/SaveFailuresDialog.tsx` - retained preference
  writes are listed with Retry (drain) / Discard alongside the domain
  failures.
- `src/components/workspace/WorkspaceStatusBar.tsx` - reads repository
  scheduled/in-flight/failed counts AND preference pending/failures; shows
  "Saving — N writes pending" instead of "Saved" while work is outstanding.
- Tests: `src/stores/__tests__/preferenceDrain.test.ts` (NEW, 4 tests:
  delayed write blocks flush; rejected write retained + retried by a later
  flush; flushDrafts waits after the debounce fired; explicit discard),
  `workspaceShell.test.tsx` +1 (status bar never claims Saved while a
  preference write is pending), `appStartup.test.tsx` +1 (failed exit
  drain keeps the app open until explicit discard).

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 367 passed (40 files; +6).
- `npm run build` - OK. `cargo test --lib` - 73 passed, 1 ignored.

Remaining defects / limitations (B06):
- The exit-blocked dialog lists messages, not per-payload controls; the
  status bar's failure dialog is the place to retry individual payloads.
- Preference writes that arrive while exit is blocked are still attempted
  during "Retry exit" (correct), but the dialog list does not update live.

Exact next batch: B07 - Make maintenance truly exclusive and reset sessions once.

### B07 - Make maintenance truly exclusive and reset sessions once

Completed: 2026-09-16.

Root causes: the maintenance barrier went up AFTER the drains (a write
could be scheduled in the awaits before the snapshot); only saver flushes
respected it — creates, deletes, state updates, sources, proposals,
appends, renames and restores invoked directly and could cross a delayed
restore boundary; concurrent exports/restores were not serialized; a
failed restore discarded held work; each store reset the repository state
separately; nothing reactive told mounted views that the dataset had been
replaced, so same-ID content and stale reads could repopulate.

Files changed:
- `src/utils/repository.ts` - `runExclusiveMaintenance(mode, task)`:
  serializes requests, enters the barrier SYNCHRONOUSLY, and releases held
  work on FAILURE ("release") while a successful replacement discards it
  ("discard"). `privilegedDrain()` runs the savers' internal flushes while
  ordinary flushes are rejected. `gateMutations()` rejects every ordinary
  mutation family (creates, deletes, updates, set-state, sources,
  proposals, append/replace/rename/snapshot/restore) at one choke point;
  scheduled saves are still held and released/discarded with the barrier.
- `src/utils/preferences.ts` - a preference maintenance barrier: `setPref`
  during maintenance is held (`beginPreferenceMaintenance` /
  `endPreferenceMaintenance`), `privilegedPreferenceDrain()` drains
  in-flight values before the swap, `setPrefPrivileged()` serves the v1
  restore path.
- `src/utils/datasetGeneration.ts` - NEW: reactive generation counter with
  `subscribeDatasetGeneration` and the `useDatasetGeneration` hook (backup
  re-exports the bump/counter for compatibility).
- `src/utils/backup.ts` - export and restore both run inside
  `runExclusiveMaintenance`; the restore does privileged domain+preference
  drains BEFORE the snapshot, resets the repository session state ONCE
  (centrally), bumps the generation only on success, and ends the
  preference barrier with release on failure / discard on success.
- `src/components/workspace/DocumentPane.tsx` - the whole pane is keyed by
  the dataset generation: a restore remounts the editor/reader/project
  with identical ids.
- `src/stores/libraryStore.ts` - a body read that spans a replacement
  re-reads against the restored dataset instead of caching stale content.
- `src/components/editor/useDocumentSession.ts` - a load resolved after a
  replacement never populates the restored editor.
- `src/stores/draftStore.ts` - `resetDraftsForRestore()`; the restore
  caller resets drafts and re-hydrates the shell.
- Per-store `repo.resetSessionState()` calls removed (single central
  reset).
- Tests: `src/utils/__tests__/maintenance.test.ts` (NEW, 3: mutation
  families rejected across a delayed restore + held work discarded on
  success; failed maintenance releases held work; concurrent maintenance
  serializes), `src/stores/__tests__/datasetGeneration.test.ts` (NEW:
  a read spanning a replacement returns the restored body),
  `documentEditor.test.tsx` +1 (same-ID restore replaces mounted content).

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 372 passed (42 files; +5).
- `npm run build` - OK. `cargo test --lib` - 73 passed, 1 ignored.

Remaining defects / limitations (B07):
- Export holds writes during the snapshot and releases them afterwards
  (unchanged semantics); a release can be lost if the process exits during
  the snapshot (the held closure lives in memory).
- The v1 restore path writes files and preferences directly inside the
  barrier (privileged); its full conversion is B09's scope.

Exact next batch: B08 - Repair migration activation and crash-safe schema upgrades.

### B08 - Repair migration activation and crash-safe schema upgrades

Completed: 2026-09-16.

Root causes: `ensure_schema` ran each migration and only bumped
`user_version` at the END, so a crash mid-migration left a stranded
database (re-running the unconditional v3 rename failed forever); a
partially applied ALTER could never be re-run (duplicate column); an
incomplete legacy migration still registered a writable connection (an
apparently empty workspace); `bootstrapStorage` cached the incomplete
result, so Retry could not re-attempt; D5 conflict resolution overwrote
the OLD JSON file after SQLite had already imported the native winner, so
"Use browser copy" changed nothing the app reads; the conflict import
verified global counts, which only works for a full replacement.

Files changed:
- `src-tauri/src/repository.rs` -
  - `apply_migration(conn, version, step)`: each step AND its
    `user_version` bump commit in ONE transaction.
  - Every migration is now REPAIRABLE/idempotent: `migrate_v2` (column
    guards), `migrate_v3` (handles crash-after-rename and
    crash-after-copy, drops a leftover staging table), `migrate_v5`,
    `migrate_v6` (rebuilds the index from scratch), `migrate_v7`
    (per-column guards + NULL-only backfill), `migrate_v8`,
    `migrate_v11` (per-column guards).
  - `init_at` does NOT register the connection when the legacy migration
    reports `completed: false` — no writable workspace opens.
  - `verify_import(conn, ds, strict_counts)`: a MERGE import verifies the
    per-entity content bytes/relationships instead of global counts.
  - NEW `db_import_legacy_at(app, db, dir, clear)`: imports a chosen
    browser copy from a scratch directory under the app data dir
    (traversal-guarded) into the ACTIVE database; registered in lib.rs.
  - Rust tests +3: `stranded_partial_migrations_are_repaired` (v3
    crash-after-rename, v3 crash-after-copy, v6→v7 pre-contract bodies,
    v11 partial columns), `incomplete_legacy_migration_does_not_open_the_workspace`
    (no connection registered; corrected input + retry completes),
    `conflict_resolution_import_merges_into_the_active_dataset`.
- `src/utils/bootstrap.ts` - an incomplete migration result is NOT cached
  (Retry re-attempts db_init); `resolveConflict("browser")` now applies the
  chosen copy through the validated import into the active SQLite dataset
  (settings files become live preferences), removes the recovery copy only
  after the import verified, and never writes the obsolete JSON files.
- `src/App.tsx` - an incomplete legacy migration throws into the startup
  error screen (with the issue list and Retry) instead of opening the
  workspace.
- `src/utils/__tests__/bootstrap.test.ts` - conflict tests rewritten to
  the active-repository contract (+2: failed import keeps the copy;
  settings conflicts become live preferences).
- `src/components/__tests__/appStartup.test.tsx` +1: incomplete migration
  never opens the workspace, Retry recovers.

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 374 passed (42 files).
- `npm run build` - OK.
- `cargo test --lib` - 76 passed, 1 ignored. `cargo check` - OK.

Remaining defects / limitations (B08):
- The conflict import applies the conflicting registry plus its related
  entity files; other conflicting families keep their own decisions.
- `db_import_legacy_at` scratch directories are removed after the import;
  a leftover (crashed) scratch directory is harmless but not swept at
  startup.

Exact next batch: B09 - Make recovery snapshots complete and usable.

### B09 - Make recovery snapshots complete and usable

Completed: 2026-09-16.

Root causes: the pre-restore recovery artifact was the RAW `db_export`
payload, not a backup envelope (the normal import parser could not read
it); the v1 restore wrote bundle files into LIVE storage and then imported
them; the legacy importer degraded every body to markdown and dropped
`contentFormat`/`contentSchemaVersion`/`plainText`/`label`/pin/archive, so
browser-generated rich documents and named snapshots did not survive the
transfer to desktop.

Files changed:
- `src/utils/backup.ts` -
  - `writeRecoverySnapshot()` writes a COMPLETE v3 envelope (canonical
    dump + credential-free preferences, including `recovery-drafts`) and
    validates it through `parseBackupBundle` BEFORE the swap; an invalid
    snapshot aborts the restore with nothing changed. Used by both the v3
    and v2 paths.
  - The v1 desktop restore now converts through a SCRATCH directory with
    the validated legacy import (`db_import_legacy_at`, clear) — the live
    data directory is never written; browser sessions keep the file
    replacement path. A failed conversion throws with the issue list.
  - Removed the now-unused live-file sweeping helpers.
- `src-tauri/src/repository.rs` -
  - The legacy dataset carries `TextContentRow`/`TextVersionRow`: v1
    `text_<id>.json` and `text_<id>.versions.json` keep the format fields,
    plain text, stable version ids, and labels; `library.json`/
    `threads.json` keep `pinned`/`archived`; nested `body` version shapes
    are read. Import applies the content contract (check + COALESCE).
  - Rust test `legacy_v1_transfer_preserves_rich_bodies_labels_and_states`.
- `src/utils/__tests__/backup.test.ts` +2: the generated pre-restore
  snapshot parses as a normal v3 bundle (documents + preferences/drafts);
  a desktop v1 restore converts through the scratch import and writes NO
  live files.

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 376 passed (42 files).
- `npm run build` - OK.
- `cargo test --lib` - 77 passed, 1 ignored. `cargo check` - OK.

Remaining defects / limitations (B09):
- The v1 browser export still writes a v1 file bundle (by design); the
  desktop import now preserves everything it contains.
- A restore's recovery snapshot lives in the app data directory as
  `pre-restore-*.json`; the startup UI does not yet link to it (it is
  importable through the normal Import action).

Exact next batch: B10 - Unify the editor schema and repair export entry
points. The detailed remaining plan is in `docs/REPAIR-PLAN-B09-B22.md`.

### B10 - Unify the editor schema and repair export entry points

Completed: 2026-09-16.

Root causes: the interactive editor and the headless conversions built
SEPARATE extension lists - `richMarkdown.ts` omitted Citation/FootnoteRef -
so ProseMirror's permissive parser silently dropped those nodes and
`getMarkdown()` returned an EMPTY document. Every reader/export/copy path
for a manuscript containing citations or footnotes therefore presented
the document as empty (and bulk export wrote an empty file). The editor's
`safeParse` turned invalid rich JSON into a visible code block that the
next Save would persist over the stored original. `decodeDocumentBody`
returned serialized JSON as `plainText` for rich rows without one. The
reader's DOCX button called `collectCitations(JSON.parse(body.content))` -
a plain JSON tree has no `descendants`, so the export threw a TypeError
(unhandled) before writing anything. Reader/export failures had no error
state or retry.

Files changed:
- `src/components/editor/editorSchema.ts` - NEW. The ONE canonical
  extension factory (`canonicalExtensions()`: StarterKit, TableKit,
  Citation, FootnoteRef, Markdown), a shared headless editor for
  conversions/validation, `validateRichJson`/`validateRichPayload`
  (ProseMirror `nodeFromJSON` + `doc.check()`, so unknown node/mark types
  and schema-violating content fail instead of being silently dropped),
  and `richBodyProblem(body)` with the user-facing explanation.
- `src/components/editor/BodyRecoveryState.tsx` - NEW. Recovery panel:
  explanation, the raw bytes verbatim (`[data-testid=raw-body]`), Copy,
  optional Retry.
- `src/components/library/sourceAtoms.ts` - NEW. A rehype plugin that
  converts ONLY the editor's `<span data-citation …>` / `<sup
  data-footnote …>` runs into real elements (labels, footnote marker +
  hover text). Everything else keeps react-markdown's default escaped
  behavior - no rehype-raw, no unrestricted HTML.
- `src/components/editor/RichTextEditor.tsx` - builds the canonical
  extensions; validates a rich body BEFORE handing it to ProseMirror;
  invalid payloads render `BodyRecoveryState` (raw bytes preserved) and
  never reach the editor, so Save cannot replace them with empty content
  or a code block.
- `src/components/editor/DocumentEditorView.tsx` - computes
  `bodyProblem` from the loaded body: the recovery state replaces the
  editor, Save is disabled, and `handleSave` refuses. No editor mounts,
  so no draft capture can write an empty projection.
- `src/utils/richMarkdown.ts` - conversions run through the canonical
  headless editor (citations/footnotes now survive `markdownFromRich` and
  `richFromMarkdown`); an invalid payload exports verbatim in a code
  block instead of an empty string.
- `src/utils/documentCodec.ts` - rich `plainText` without a stored value
  is derived from the valid nodes (`plainTextFromProseMirror`); invalid
  JSON yields `""` with the content preserved (serialized JSON never
  masquerades as prose).
- `src/components/editor/citationExtension.ts` -
  `collectCitationsFromJson`: a structural walk of a plain ProseMirror
  JSON tree (no substring scanning, no live Node API required).
  **F13 correction:** `collectCitationsFromJson` no longer exists in the
  current code. B19 replaced it with `collectSourceRefsFromJson` in
  `src/utils/sourceRefs.ts`, which structurally walks the JSON for BOTH
  citations and source-backed footnotes; the reader/DOCX paths use that
  collector.
- `src/components/library/LibraryReader.tsx` - DOCX export collects
  citations with the JSON collector (markdown bodies convert through the
  canonical parser first) and refuses a schema-invalid body with a
  visible error; load and every export/copy action have visible error
  states with Retry; invalid rich bodies render the recovery state; the
  reader renders through `rehypeSourceAtoms`.
- `src/index.css` - the reader (.doc-markdown) uses the same citation/
  footnote atom styling as the editor.
- Tests:
  - `src/components/__tests__/libraryExport.test.tsx` - NEW (5 jsdom
    tests through the real buttons): the reader shows the citation label
    and a real `<sup>` footnote marker (no raw tags, not "empty"); the
    DOCX button writes a file whose XML is inspected with JSZip -
    prose order around the citation, real `word/footnotes.xml` text, and
    the CSL-generated bibliography; the Markdown button writes the
    citation/footnote atoms; a rejected export shows the error and Retry
    succeeds; a schema-invalid body shows the recovery state with the raw
    bytes.
  - `src/components/__tests__/editorSchema.test.ts` - NEW (7): valid
    docs derive plain text; unknown nodes, unknown marks, schema-
    violating content, non-document payloads, and JSON syntax errors are
    all rejected; `richBodyProblem` explains preservation/Save blocking.
  - `src/utils/__tests__/richMarkdown.test.ts` +3 - citations/footnotes
    survive serialization and round-trip; a schema-invalid body exports
    its bytes, never empty.
  - `src/utils/__tests__/documentCodec.test.ts` +2 - rich plainText
    derived from nodes; invalid JSON preserves content with `""` text.
  - `src/components/__tests__/documentEditor.test.tsx` +2 - an unknown
    node and a corrupt payload each show the recovery state, keep the
    stored bytes, write no draft, and disable Save.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 395 passed (44 files; +19).
- `npm run build` - OK (pre-existing chunk-size warning).
- Rust untouched this batch (no native files changed).

Remaining defects / limitations (B10):
- The library's bulk export (`LibraryList.handleExportSelected`) still
  calls `markdownFromRich` without per-item failure UI: corrupt bodies
  export as a verbatim code block (preserved), but a failing body load
  still rejects the batch silently - pre-existing, outside this batch's
  named files.
- DOCX export of a schema-invalid body is refused with a visible error
  rather than partially converted; recovery is Copy/Export-Markdown of
  the raw bytes.
- Citation label/ID attribute escaping in the Markdown serializer is
  B19's scope; the reader's atom parser tolerates the current output.
- The reader exposes footnote text via the marker's hover title; a full
  footnote list treatment is B19's scope.

Exact next batch: B11 - Bind proposals to their exact document and
session (see `docs/REPAIR-PLAN-B09-B22.md`).

### B11 - Bind proposals to their exact document and session

Completed: 2026-09-16.

Root causes: `setActiveEditor` registered a GLOBAL untagged editor;
`requestProposal` read the selection from whatever editor was active and
never checked it was showing the requested document; `acceptProposal`
applied the proposal to whatever editor was active, so a delayed
proposal for document A could modify document B whenever the old and new
text matched. The base revision was read AFTER the AI await
(`repo.peekRev(...) ?? 0`), so a Save during generation silently moved
the proposal's base to the new revision and the stale check could no
longer catch it. An unknown revision (`peekRev` null) skipped the
revision gate entirely ("unverified" counted as valid). ReviewPanel
loads had no request identity (a slow load for A could overwrite B's
rows) and no failure state; a completed request did not refresh the
panel; a read view offered Accept with no editor to apply it to.

Files changed:
- `src/services/revisionService.ts` -
  - `setActiveEditor({documentId, editor, editVersion})` registers the
    live editor WITH its document identity and a monotonically assigned
    session generation; `clearActiveEditor(editor)` is
    identity-guarded (a late editor destroy can never disarm a newer
    document's registration); `getActiveEditorDocumentId()` and
    `subscribeActiveEditor()` expose ownership to the panel.
  - `requestProposal` requires the registration to be showing the
    requested document; captures a STRUCTURED SELECTION FINGERPRINT
    (documentId, baseRev, selFrom, selTo, exact fragment, edit version,
    session generation) BEFORE the AI await; refuses to create a
    proposal when the revision cannot be captured.
  - `acceptProposal` requires the owning document's live editor
    (`not-owner`), treats an unknown revision as `unverified-revision`
    (nothing applied), re-verifies ownership immediately before the
    transaction, and validates the recorded range against the exact
    fragment (unique-match fallback unchanged).
  - `subscribeProposalChanges()` notifies after create/accept/reject/
    stale so the Review panel refreshes when a request completes.
- `src/components/editor/useDocumentSession.ts` - exposes
  `getEditVersion()` (stable provider over the B04 edit counter).
- `src/components/editor/DocumentEditorView.tsx` - registers
  `{documentId, editor, editVersion}` only for saved documents and
  clears its OWN registration on destroy via `clearActiveEditor`.
- `src/components/workspace/ReviewPanel.tsx` - `useSyncExternalStore`
  ownership: pending replacements in a read view (or another document's
  editor) show "Open in editor" instead of an invalid Accept;
  document/request-identity guarded loads (a stale A response can never
  replace B's rows); visible load errors with Retry; accept/reject
  failures surface with the new reason messages; refreshes on proposal
  lifecycle events.
- Tests:
  - `src/services/__tests__/revisionService.test.ts` - registration
    helper updated to the new contract; +5 B11 regressions: delayed A
    proposal cannot apply to B (identical words); a request for a
    document the editor is not showing is refused; the base revision is
    captured before the AI await (a save during generation leaves
    baseRev at the OLD value); an unknown revision is unverified at
    acceptance (nothing applied); a proposal cannot be created when the
    revision cannot be captured.
  - `src/components/__tests__/reviewPanel.test.tsx` - NEW (5 jsdom
    tests): read view offers "Open in editor" (and it opens the edit
    view); Accept applies only when the own document's editor is
    registered; a delayed A load cannot replace B's rows; a completed
    request refreshes the panel; an accept failure is visible and does
    not mutate the document.
  - `src/components/__tests__/documentEditor.test.tsx` +2: the
    production registration path registers the open document and clears
    it on unmount; an unsaved new document is not registered as a
    proposal target. Also fixed the file's body-cache isolation (the
    module-level library content cache leaked an invalid body into the
    next test).

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 407 passed (45 files; +12).
- `npm run build` - OK (pre-existing chunk-size warning).
- Rust untouched this batch (no native files changed).

Remaining defects / limitations (B11):
- The selection fingerprint's session-scoped parts (edit version,
  session generation) are not persisted: after a restart, acceptance
  relies on the persisted documentId/baseRev/range/fragment checks and
  live ownership. Persisting them would change the proposal row and the
  backup contract; deferred.
- A proposal whose base revision was captured while the document was
  clean but whose draft changed during generation is still accepted if
  the persisted range/fragment checks pass; the draft is not part of
  the revision gate (the exact-location check is the guard).
- The Review panel does not surface `unverified-revision` as a
  dedicated card state; it appears on the accept attempt.

Exact next batch: B12 - Make proposal application match the review
display (see `docs/REPAIR-PLAN-B09-B22.md`).

### B12 - Make proposal application match the review display

Completed: 2026-09-16.

Root causes: acceptance passed the model's raw string to
`insertContentAt`, which parses strings as HTML — `<b>bold</b>` became a
bold mark and the tags vanished, entities were decoded, and multiline
text collapsed into one paragraph, so the applied content did not match
the preview. There was no protection for selections containing
citation/footnote atoms or spanning blocks (replacing them destroyed
structure), a proposal that repeated the source text still "applied"
(formatting-only), an out-of-range recorded selection threw instead of
falling back, the transaction's success was never checked, nothing
prevented applying the same proposal twice (a failed status write left a
"pending" row that could be applied again), and a history restore left
the pre-restore recovery draft in place so reopening Edit silently
undid it.

Files changed:
- `src/services/revisionService.ts` -
  - `literalReplacement(value)`: the explicit replacement contract — the
    model's reply is literal plain text; one line becomes a literal text
    run (marks inherited at the insertion point), each additional line
    becomes its own paragraph. Never HTML/Markdown parsing.
  - `selectionProblem(doc, from, to)`: supported selections are a range
    inside ONE text block containing text and inline marks only;
    citations, footnotes, other atoms, and cross-block selections are
    refused with a clear explanation (at request time and again at
    acceptance).
  - `acceptProposal`: refuses non-pending/already-applied proposals
    (in-memory ledger even when the status write fails), validates the
    recorded range bounds (out-of-range falls back to the unique exact
    match), returns `no-change` when the proposal repeats the source
    text, checks the transaction result (`apply-failed`), applies literal
    text with `errorOnInvalidContent`, and returns a `warning` when the
    manuscript changed but the accepted status write failed.
  - `requestProposal` refuses unsupported selections before contacting
    the AI.
- `src/components/workspace/ReviewPanel.tsx` - messages for the new
  accept failures; applied-with-warning notes are shown (role="status").
- `src/stores/libraryStore.ts` - `restoreVersion` clears the document's
  dirty recovery draft after the restore commits: the explicit restore
  of stored content is never silently overridden by a pre-restore draft
  when Edit reopens.
- `src/components/library/HistoryDialog.tsx` - warns (role="status")
  when the text has an unsaved draft, so discarding it with the restore
  is explicit.
- Tests:
  - `src/services/__tests__/revisionService.test.ts` +7: literal
    application (HTML-looking tags, entities, Unicode, multiline exactly
    as previewed; actual Undo restores the fragment); entity-looking
    single-line replacement; citation-atom and cross-block selections
    refused (request + accept, nothing mutated); no-change detection;
    double application blocked; out-of-range range hint falls back to the
    unique match.
  - `src/components/__tests__/draft-navigation.test.tsx` +1: the
    HistoryDialog warns about a dirty draft and the restore clears it.
  - `src/components/__tests__/documentEditor.test.tsx` +1: after a
    history restore, reopening Edit shows the restored version, not the
    pre-restore draft.
  - `src/components/__tests__/reviewPanel.test.tsx` +reset seam for the
    applied-proposal ledger.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 416 passed (45 files; +9).
- `npm run build` - OK (pre-existing chunk-size warning).
- Rust untouched this batch (no native files changed).

Remaining defects / limitations (B12):
- The replacement is plain text only: inline formatting inside the
  selection (bold/italic spans) is replaced by literal text. The
  supported-format contract is documented and enforced; preserving marks
  through a replacement is not implemented.
- Selections spanning multiple blocks are refused rather than
  restructured; a manually-applied multiline rewrite is the workaround.
- The applied-proposal ledger is session-scoped; a crash between the
  transaction and the status write can leave a "pending" row whose
  fragment no longer matches (accept then reports not-found/stale).
- `no-change` leaves the proposal pending so the user can reject it; it
  is not auto-rejected.

Exact next batch: B13 - Preserve source passages and extraction
ownership (see `docs/REPAIR-PLAN-B09-B22.md`).

### B13 - Preserve source passages and extraction ownership

Completed: 2026-09-16.

Root causes: `sourceStore.updateSource`/`setIncluded`/`setVerification`
called `repo.sourceSave(id, next, [])` — an explicit EMPTY passage list —
so every metadata/inclusion/verification edit silently WIPED the stored
passages, and the save errors were swallowed by `.catch(() => {})`. File
dedup hashed the EXTRACTED TEXT, so two distinct files whose extraction
truncated at the same prefix collapsed into one "duplicate" source. A
restore did not cancel running extraction handles, and a late result
re-added its source AND job into the restored dataset (a missing job was
treated as active). An empty extraction became a "ready" source with no
text. PDF extraction joined pages with single newlines and used
paragraph locators, losing page boundaries.

Files changed:
- `src-tauri/src/repository.rs` - `source_save(..., passages:
  Option<&[SourcePassageRow]>, ...)`: `None` is a metadata-only save that
  leaves `source_passages` untouched; `Some(list)` (including `Some([])`)
  replaces them in the same transaction. `db_source_save` takes
  `Option<Vec<SourcePassageRow>>` (absent/null from the frontend).
  Rust test extended: metadata-only keeps id/locator/content; explicit
  `[]` clears.
- `src/utils/repository.ts` - `sourceSave(id, source, passages?)`; the
  native adapter sends `passages: passages ?? null`; the JSON backend
  skips the passages file when omitted.
- `src/test/fakeRepository.ts` - the same omitted/`[]` semantics.
- `src/stores/sourceStore.ts` -
  - `updateSource`/`setIncluded`/`setVerification` persist BEFORE
    updating state and REJECT on failure (no silent success; the panel
    shows the error and the source stays unchanged). Omitted passages =
    unchanged.
  - `addSource(input, guard?)`: identity from `contentHash` when
    supplied, otherwise the text digest; the guard is checked after the
    async identity work and immediately before the repository write.
  - `addSourceFromFile`: captures the dataset generation at start;
    `ownsJob()` requires the job still extracting AND the same
    generation; rechecked before the commit and before marking done; an
    empty extraction FAILS the job without adding a source; a vanished
    job (restore/reset) is never re-added by a late result.
  - `resetForRestore` cancels every extraction handle and clears the
    map before the dataset swap.
- `src/services/sourceExtraction.ts` - `ExtractionOutcome.fileHash`
  (SHA-256 of the file BYTES, the dedup identity for uploads);
  `derivePassages(text, pages?)` uses REAL page ranges when present
  (one passage per page, locator `p. N`) and the paragraph batching
  otherwise.
- `src/utils/fileParse.ts` - PDFs keep page boundaries: pages are joined
  with blank lines and `finishPages` returns each kept page's character
  range (truncation keeps only the part that fits; the marker is not a
  passage).
- `src/components/workspace/SourcesPanel.tsx` - inclusion, verification,
  and delete actions run through a visible failure state (`role="alert"`,
  "Could not save this change… the source is unchanged").
- Tests:
  - `src/stores/__tests__/sourceStore.test.ts` - the toggle test now
    requires passage ids/locators/content to survive inclusion,
    verification, and notes edits; + metadata-only vs explicit `[]`
    semantics; failed saves reject without an acknowledged change; empty
    extraction fails the job and adds nothing; two >50k-byte files with
    an identical truncated prefix both import (byte identity); a restore
    during extraction leaves no job/source; cancel before parsing
    discards the result; page-locator derivation and truncation ranges.
  - `src/utils/__tests__/repository.test.ts` +1: the exact
    `db_source_save` payload for omitted (`null`), `[]`, and explicit
    passage lists.
  - `src/components/__tests__/sourcesPanel.test.tsx` - NEW (2 jsdom
    tests): a failed inclusion toggle shows the error and leaves the
    source unchanged; a successful toggle keeps the passages.

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 428 passed (46 files; +12).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 77 passed, 1 ignored. `cargo check` - OK.

Remaining defects / limitations (B13):
- The upload identity (file bytes) replaces the text identity for file
  sources in the existing `contentHash` column: a file and a paste of the
  same text no longer dedup against each other, and the extracted-text
  hash is not stored separately (no dump-contract change). Pasted text
  keeps text identity.
- PDF passages are one per page; a page larger than the passage target is
  a single long passage (its page locator is still real). Block-level
  locators within pages are not generated.
- The `p. N` locators come from the parser's page order; a PDF whose
  pages the parser cannot read (scanned) still fails as an empty
  extraction.
- SourcesPanel does not expose metadata editing beyond the import forms
  (B18's scope).

Exact next batch: B14 - Prepare one operation-aware request (see
`docs/REPAIR-PLAN-B09-B22.md`).

### B14 - Prepare one operation-aware request

Completed: 2026-09-16.

Root causes: the preview (ChatTab) and the transport (chatSend) compiled
SEPARATELY — the preview read `projectBriefContent` from component state
without awaiting the brief, skipped `sourceStore.ensureLoaded()` (cold
start showed no sources while the send included them), omitted the
composer's pending uploads and project-mode attachments, and guessed the
regeneration boundary; the send re-sent `op.history` (which EXCLUDED the
retried instruction, so a retry sent no instruction at all) and compiled
the OLD assistant answer as the new instruction on regenerate. An empty
per-thread source pick was deleted by the store (`setThreadSourcePick`
treated `[]` as "clear"), so "uncheck all sources" silently sent all
included sources.

Files changed:
- `src/services/chatPrepare.ts` - NEW. THE prepared-request builder:
  `resolveInstructionBoundary` (fresh = typed text/current messages;
  retry = the failed user message, history before it; regenerate = the
  user message BEFORE the answer, history before that — the old answer is
  never an instruction), awaited source hydration + re-read, awaited
  (cached) project-brief load, pending uploads and library attachments,
  the source scope with `applySourcePicks` (`undefined` = panel
  inclusion, `[]` = explicitly none), and ONE `compileContext` whose
  payload and manifest travel together. Returns the exact
  `wireMessages` (history + instruction) the transport sends.
- `src/services/chatSend.ts` - prepares ONCE and sends that object:
  `sendMessage` receives the prepared wire messages and the compiled
  system message; the operation snapshots the same values; a preparation
  in flight blocks a second send; ownership is re-checked after every
  await. Fresh/retry/regenerate share the pipeline with distinct
  boundaries.
- `src/services/contextCompiler.ts` - `applySourcePicks`: `undefined`
  keeps defaults, `[]` omits every source ("Not picked for this send");
  `CompileOptions.attachments` adds an attachment-count disclosure entry
  to the manifest.
- `src/stores/chatStore.ts` - an explicit empty pick is STORED (only
  `clearThreadSourcePick` removes it).
- `src/components/chat/usePreparedPreview.ts` - NEW hook: every surface
  renders the compiled manifest of the same prepared request, with
  cancellation so a slow preparation cannot replace a newer one.
- `src/components/tabs/ChatTab.tsx` - the local preview useMemo (and its
  stale brief state) is gone; the panel renders the shared prepared
  preview; the source picker treats an empty pick as an explicit choice
  and says the pick lasts until reset.
- `src/components/workspace/CompactAssistant.tsx` - the compact
  assistant discloses the same manifest (context, sources, attachments).
- `src/components/chat/WhatWillBeSent.tsx` - copy reflects the
  per-conversation pick lifetime.
- Tests: `src/services/__tests__/chatPrepare.test.ts` - NEW (11):
  boundary rules for fresh/retry/regenerate (the old answer never
  appears); preview manifest === transport payload (captured sendMessage
  args for the same prepared object); cold source loading awaited;
  undefined vs `[]` picks (zero source content sent); pending uploads
  ride and are disclosed; a changed brief enters the system prompt; the
  preview hook equals a direct prepare. `contextCompiler.test.ts`: the
  empty-pick test updated to the new, stronger contract.

Commands run and results:
- `npx tsc --noEmit` - OK. `npm test` - 439 passed (47 files; +11).
- `npm run build` - OK (pre-existing chunk-size warning).
- Rust untouched this batch (no native files changed).

Remaining defects / limitations (B14):
- The preview hook re-prepares on every relevant store change (each
  keystroke); preparation is synchronous except the cached brief/source
  hydration, so the cost is a compile per keystroke (acceptable for the
  current library sizes).
- Retry/regenerate preparation drops messages that came AFTER the target
  from the wire history (the store keeps them); that is the defined
  resend semantics, not a display change.
- The attachment disclosure is a count, not per-file entries.

Exact next batch: B15 - Repair failed-send identity and operation-driven
UI (see `docs/REPAIR-PLAN-B09-B22.md`).

### B15 - Repair failed-send identity and operation-driven UI

Completed: 2026-09-16.

Root causes:
- Fresh sends let `addMessage` mint the stable id INSIDE the store
  (`{ id: msg.id ?? crypto.randomUUID(), ...msg }`), so the operation
  could not record which user message it sent and a failure could not be
  linked back to it.
- Retry re-prepared the request from the CURRENT store (settings,
  messages, sources): a failure followed by any configuration change (or
  a later message) retried a different request than the one that failed.
  Nothing retained the failed prepared-request snapshot.
- The UI mirrored generation through ONE global `streamingText`, updated
  only while the owner thread was visible and cleared by `switchThread`:
  A→B→A lost the whole answer until the next delta arrived (or forever,
  if the stream had already finished hidden). A global `isSending` made
  every conversation show the running request's spinner and disabled
  other conversations' composers.
- Cleanup ("Remove AI slop") was a MessageList component concern: each
  mounted surface had its own pending flag and could start its own
  request; `deslopText` received no abort signal, so a restore could not
  cancel it.
- Terminal operation records retained their snapshot config — including
  the API key — forever, and finished operations were never evicted.

Files changed:
- `src/services/aiOperations.ts` — `AiOperation.userMessageId`; the
  retained-failure registry (`FailedSendRecord`, `rememberFailedSend`,
  `getFailedSend`, `takeFailedSend`, `failedSendsForThread`,
  `forgetFailedSendsForThread`, `clearFailedSends`) keyed by
  thread + message key (navigation-independent, in-memory);
  `admitOperation` (at most ONE running operation per conversation,
  across surfaces); `settleOperation` strips the credential from the
  terminal record and evicts the oldest finished records beyond
  `MAX_RETAINED_OPERATIONS` (running records are never evicted);
  `invalidateAllOperations` (restore) also drops retained failures and
  strips aborted records. Version/subscription seams
  (`operationsVersion`, `failedSendsVersion`, `subscribeFailedSends`)
  for the UI mirrors.
  **F13 correction:** the historical file list above names
  `clearFailedSends`; no such export exists (or ever did in the merged
  code). The registry is cleared by `invalidateAllOperations` (restore)
  and `resetOperations` (tests), and bounded by `MAX_RETAINED_FAILURES`
  with oldest-first eviction (F07).
- `src/services/chatSend.ts` — fresh sends mint the id BEFORE insertion
  and record it on the operation; Retry replays the retained prepared
  request verbatim (snapshot config included) instead of re-preparing;
  per-conversation preparation guard (`preparingThreads`) instead of one
  global flag; ownership re-checked after every await and admission
  re-checked after preparation; failures retain the snapshot and set the
  OWNER's error banner (visible or per-thread); `cleanupMessage` NEW —
  the shared cleanup service: admission guard (duplicate impossible),
  `deslopText` runs with the operation's abort signal, an aborted cleanup
  appends nothing, and the cleaned reply commits to the owner.
- `src/stores/chatStore.ts` — removed the global `isSending`,
  `streamingText`, `sendAbortController` state and setters (plus their
  three call sites); added per-thread `threadErrors` +
  `setThreadError`; `setError` now scopes the banner to the active
  conversation; `switchThread` restores the requested owner's error (no
  cross-thread banner); `deleteThread` forgets its retained failures and
  error; restore/create reset the maps.
- `src/components/chat/useThreadOperation.ts` — NEW hooks
  `useThreadOperation` (the visible owner's running operation; re-renders
  on deltas) and `useThreadFailedSends` (retained failures; re-renders
  only when the registry changes).
- `src/components/chat/MessageList.tsx` — renders the OWNER's operation
  buffer directly (no global mirror); the busy/disabled state is that
  operation; failed overlay merges `msg.failed` with the retained-failure
  registry so a failure that landed while hidden still exposes Retry;
  cleanup clicks go through the shared service (spinner derived from the
  running cleanup op's target); `LoadingDots` is a labelled
  `role="status"` so tests and screen readers can see (or not see) it.
- `src/components/workspace/CompactAssistant.tsx` — per-conversation
  operation for Stop/disabled instead of the global controller.
- `src/components/tabs/ChatTab.tsx` — per-conversation operation for
  busy states and Stop (`abortOperation`); no other conversation's
  request disables this composer.
- `src/components/settings/SettingsDialog.tsx` — restore aborts ALL
  operations (`invalidateAllOperations`) instead of one controller.
- `src/components/workspace/ProjectNavigator.tsx` — a failure badge on
  conversation rows (project, standalone, archived) driven by the
  retained-failure registry: a hidden-owner failure stays discoverable
  without opening the conversation.
- Tests: `src/services/__tests__/chatSendOperations.test.ts` — NEW (7):
  fresh failure flags the message + records the stable id + exposes the
  snapshot; Retry replays snapshot config/history after settings and
  messages changed; hidden failure retains for A with no error in B and
  surfaces on return to A; busy scoped per conversation; two cleanup
  calls start ONE request and the abort signal reaches it (aborted
  cleanup appends nothing); cleanup blocked behind a running chat op;
  a completed cleanup appends exactly one reply.
  `src/components/__tests__/messageListOperations.test.tsx` — NEW (3,
  real MessageList buttons): A→B→A keeps the complete streamed buffer
  and B shows no `role="status"`; the real Retry button replays the
  retained snapshot (later config ignored); two mounted surfaces cannot
  duplicate cleanup. `conversationNavigation.test.tsx` — +1: a retained
  failure marks exactly the failing conversation's navigator row (real
  WorkspaceShell) without opening it. `aiOperations.test.ts` — +6:
  stable user-message id recorded; terminal records keep no credentials;
  retention bound with a running op never evicted; per-conversation
  admission; one-shot snapshot consumption scoped by thread;
  deletion/restore clear the registry.

Regression scenarios demonstrated:
- Fresh failure → the real Retry button appears and replays the exact
  prepared request (captured `sendMessage` args) even after the model/key
  changed.
- Failure landing while the owner is hidden: nothing is shown in the
  other conversation, the snapshot is retained and scoped to its thread,
  the navigator row carries the failure badge, and opening the owner
  restores its error banner and Retry affordance.
- A→B→A with a mid-stream navigation: B never renders A's spinner, and A
  immediately shows the full output buffer without waiting for a delta.
- Two surfaces clicking cleanup: exactly one `deslopText` call; the
  request's signal is the operation's controller signal; aborting
  appends no partial reply.

Simplification pass (delegated, after the batch was verified): removed
the orphaned `canSend` export (no production caller; its predicate is
`activeOperationForThread`, which the tests now assert directly); folded
the two identical failure-retention blocks in `sendChatMessage` into one
`retainFailure` closure; `commitToOwner`'s hidden append now delegates to
the previously orphaned `appendAssistantToThread`; `setError` delegates
to `setThreadError` instead of duplicating its bookkeeping. No behavior
changes; tsc/tests/build re-run green afterwards.

Commands run and results:
- `npx tsc --noEmit` — OK.
- `npm test` — 456 passed (49 files; +17). No failures; the pre-existing
  React "cannot update while rendering" warning in a save-acknowledgement
  test and the keychain-locked stderr noise remain (non-failing).
- `npm run build` — OK (pre-existing chunk-size warning only).
- Rust untouched this batch (no native files changed).

Remaining defects / limitations (B15):
- The retained failed-send snapshot lives in memory only. It survives
  navigation, remounts, and tab switches; after an app RESTART the
  message's persisted `failed` marker still exposes Retry, but that
  retry re-prepares against current state (no snapshot to replay). A
  durable snapshot would need a persisted envelope.
- A hidden failure persists no `failed` flag on the stored message (the
  in-memory registry supplies the overlay); restarting before opening
  that conversation loses the marker entirely.
- Cleanup has no user-facing Stop affordance (its signal is honoured by
  restores/invalidation, not by a button); a cleanup that settles after
  navigation commits to the owner as before.
- Regenerate failures do not enter the retained-failure registry (the
  regenerate affordance stays available); their error banner is
  per-thread but not discoverable from the navigator.
- Parallel sends in DIFFERENT conversations are now admitted (one per
  conversation); the transport itself is stateless per call and each
  operation commits to its owner, but the app never previously exercised
  two simultaneous streams — B17a's cancellation work should be verified
  with that case in mind.

Exact next batch: B16 - Preserve response completeness through every
consumer (see `docs/REPAIR-PLAN-B09-B22.md`).

### B16a - Shared completeness model + streaming protocol repair

Completed: 2026-09-16. B16 was split into B16a (this) and B16b (consumer
metadata + proposal gating, listed below).

Root causes found while implementing:
- `ApiResponse` carried only error/stopped/truncated booleans: every
  consumer re-derived the outcome ad hoc, and a provider-declared output
  limit (`finish_reason: "length"` / `stop_reason: "max_tokens"`) was
  indistinguishable from a clean completion. Protocol terminal state and
  observed finish reason were conflated.
- `StreamAccumulator` returned as soon as `finish_reason` arrived, so the
  OpenAI usage chunk (sent AFTER it) and `[DONE]` were never read.
- Anthropic usage was REPLACED per event: the `message_delta`
  output_tokens overwrote the `message_start` usage (input_tokens lost);
  message_start usage was not read at all.
- Provider error payloads inside the stream (`{"error": ...}` and
  Anthropic `error` events) were ignored as unknown events, so an
  overloaded provider looked like a silent interruption.
- A round assembled from an interrupted/limit-stopped stream still
  returned tool_calls; the TS adapters executed them even though their
  argument JSON could be (and in tests was) cut in half.
- The TS gate must prefer the assembled round content when no delta
  reached the frontend (non-streamed replies and mocked transports).

Files changed:
- `src/utils/api.ts` - `ApiOutcome` ("complete" | "stopped" |
  "interrupted" | "truncated" | "failed") on every `ApiResponse`;
  `finishOutcome` separates observed finish reason (length/max_tokens =
  truncated) from protocol state (missing terminal signal = interrupted);
  `partialResponse`/`roundResponse` attach the outcome and mark partial
  text; every return site classifies explicitly; both adapters GATE tool
  execution on `finishOutcome === "complete"` and preserve the partial
  text otherwise; `streamResultFlags` normalizes usage to the root
  (`usage` root or `choices[0].usage`).
- `src-tauri/src/lib.rs` - `StreamAccumulator`: `openai_done` +
  bounded `openai_drain_remaining` (2 events) so the usage chunk and
  `[DONE]` after a finish_reason are read; `capture_usage` MERGES usage
  objects (Anthropic message_start `message.usage` + message_delta root
  usage); explicit provider error payloads return an error (partial text
  stays in the accumulator for the frontend); the assembled OpenAI
  payload now emits normalized root-level `usage`.
- Tests: `src/utils/__tests__/api.test.ts` +4 wire-shaped fixtures
  through the production `sendMessage` path: finish→usage→DONE clean
  completion with root usage; output-limit stop = truncated (not
  complete); provider error before text = failed; interrupted tool-call
  round never executes tools and preserves the partial text. The
  existing EOF-truncation test now also asserts `outcome: "interrupted"`.
  Rust `cargo test`: +4 (usage-after-finish, bounded drain, Anthropic
  usage merge, provider error events) = 81 passed, 1 ignored.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 460 passed (49 files; +4).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 81 passed, 1 ignored. `cargo check` - OK.

Remaining B16 work (B16b) - carry the completeness into consumers:
- `ChatMessage`/`StoredMessage` completeness metadata (needs a native
  schema decision: the `messages` table has `failed` but no incomplete
  marker; either a v12 migration or a persisted envelope).
- chatSend: commit `outcome: "interrupted" | "truncated"` partials as
  visibly marked assistant messages (today an error after output starts
  retains the failure but commits nothing, so the partial is lost from
  the thread once the live stream ends/navigates).
- revisionService: refuse proposal creation (or refuse ordinary
  acceptance) for interrupted/truncated replacements, coordinated with
  the B12 accept checks.
- evalHarness: never score stopped/truncated/interrupted responses as
  completed samples (also listed under B22).
- `renderEvidence`: report evidence cuts/failed retrievals explicitly
  (the packet status exists; the fallback note does not yet count them).

Exact next batch: B16b (consumer completeness metadata and proposal
gating), then B17a.

### B16b - Carry completeness metadata into every consumer

Completed: 2026-09-16.

Root causes found while implementing:
- chatSend treated ANY `result.error` as a failure: an interrupted or
  truncated response carrying usable partial text (`partialResponse`
  sets both `error` and a partial outcome) retained the failure and
  committed NOTHING, so the partial vanished from the thread the moment
  the live stream ended or the user navigated.
- The message model had no completeness marker at all: `ChatMessage`,
  `StoredMessage`, and the native `messages` table could express
  `failed` but not "the answer is a partial that should stay visible".
- `revisionService.requestProposal` accepted a cut-off response as a
  replacement proposal (it only checked `!proposed || result.error`);
  accepting it would have deleted the rest of the selected passage.
- `renderEvidence` sliced tool bodies at 2000 chars without saying so,
  and the `finishWithoutTools` note counted EVERY evidence packet —
  including failed retrievals — as "research results gathered".
- An interrupted tool batch (Stop mid-batch) returned an empty stopped
  response: the completed retrievals and the cancelled ones were lost
  with no trace in the thread.
- `evalHarness` scored whatever text arrived regardless of outcome, so
  a stopped/truncated/interrupted sample could be credited as quality.

Files changed:
- `src/types/index.ts` - `IncompleteReason = "interrupted" |
  "truncated"` (the shared marker).
- `src/utils/repository.ts` - `StoredMessage.incomplete:
  IncompleteReason | null`; `threadReplaceMessage` carries the marker
  (`incomplete` argument; null clears it); the SQLite backend sends it
  through `db_thread_replace_message`; the JSON backend persists it in
  `chat_<id>.json` and reads it back (`toStored` validates the closed
  set).
- `src-tauri/src/repository.rs` -
  - Schema v12 (`SUPPORTED_SCHEMA_VERSION = 12`): `migrate_v12` adds
    `messages.incomplete TEXT` column-guarded and repairable;
    `MessageRow.incomplete` (serde default) flows through `thread_get`,
    `write_thread_data`, `thread_append_message`,
    `thread_replace_message`, the legacy conversion, `export_dump`, and
    `apply_dump`.
  - `apply_dump` validates the marker with `check_incomplete_contract`:
    a restore carrying an unknown value is refused and rolls back.
- `src/stores/chatStore.ts` - `ChatMessage.incomplete`;
  `messageToStored`/`storedToMessage` map it; `addMessage`,
  `replaceMessageById`, `appendAssistantToThread`, and `commitToOwner`
  carry it (including the hidden-owner repository commit).
- `src/services/chatSend.ts` - an incomplete-but-usable response
  (`outcome` interrupted/truncated with non-empty text) is COMMITTED as
  an assistant message with its marker; the user message stays
  unflagged and no failure snapshot is retained. The error banner still
  explains an interrupted-with-error response. A stopped response with
  no streamed text now commits `result.content` when it carries the
  service note (an interrupted tool batch is no longer silent).
- `src/components/chat/MessageList.tsx` - an amber `role="status"` note
  on incomplete assistant messages ("Answer interrupted — partial
  response." / "Answer truncated — the model reached its output
  limit.") and a Retry button ("Retry answer") for them even when they
  are not the last message (it goes through the same regenerate path,
  which replaces the message in place).
- `src/services/revisionService.ts` - `requestProposal` refuses
  interrupted/truncated responses with an explicit "cut off" error;
  nothing is persisted and the operation settles failed.
- `src/utils/api.ts` - `renderEvidence` marks cut excerpts
  (`[excerpt cut at 2000 characters]`); `evidenceCounts` +
  `evidenceNote` count ONLY successful retrievals and report failed /
  interrupted ones explicitly ("all N retrievals failed; answering
  without research material"); an interrupted tool batch records its
  unstarted calls as `interrupted` evidence and prepends a note
  (`interruptedResearchNote`) to the stopped response; both adapters
  share the helpers.
- `src/services/evalHarness.ts` - `EvalTaskResult.outcome`; a response
  that is not `complete` is reported through `unscoredTask` (every
  dimension 0 + "not scored: the response was interrupted/truncated/
  stopped/failed") and can never pass.
- `src/test/backup-contract.json` - REGENERATED from Rust (schema v12
  fixture; the assistant fixture message carries
  `"incomplete": "interrupted"`).
- `src/utils/backup.ts` - `DumpMessageRow.incomplete` +
  `normMessage` validation (unknown markers are rejected).

Tests added/updated:
- `src/services/__tests__/chatSendOperations.test.ts` +4: an
  interrupted partial commits with its marker and survives navigation
  through the repository; truncated commits marked truncated; a hidden
  owner's partial keeps its marker on return; a stopped service note
  commits.
- `src/components/__tests__/messageListOperations.test.tsx` +2: the
  marker renders and the Retry button invokes the regenerate path; the
  truncated marker reads distinctly.
- `src/services/__tests__/revisionService.test.ts` +1: both
  interrupted and truncated responses refuse proposal creation and
  persist nothing.
- `src/services/__tests__/evalHarness.test.ts` +1 (and the two
  existing mocks now set `outcome: "complete"`): interrupted/truncated/
  stopped/failed samples are unscored, zeroed, and never pass.
- `src/utils/__tests__/api.test.ts` +3: cut excerpts are marked and
  only successful retrievals are counted; failed retrievals are
  reported instead of being called results; a cancelled tool batch
  reports "Research was interrupted after 4 of 5 research steps
  finished." through the production `sendMessage` path.
- `src/utils/__tests__/backup.test.ts` +1: unknown incomplete markers
  are rejected; the real markers parse.
- `src/utils/__tests__/repository.test.ts` +2: the SQLite
  append/replace payloads carry `incomplete`; the JSON backend
  persists and returns it.
- Rust (repository.rs) +2: `incomplete_marker_survives_thread_roundtrips`
  (create -> get -> replace clears -> replace sets -> export/apply_dump/
  export exact) and `unsupported_incomplete_marker_fails_restore`
  (rollback leaves the dataset intact); `stranded_partial_migrations_are_repaired`
  gained a v12 section (v11 database with messages upgrades; re-running
  is a no-op).

Regression scenarios demonstrated through production paths:
- A cut-off response now leaves the partial in the conversation with a
  visible marker and the user message NOT flagged failed; Retry stays
  available on the partial itself; the marker survives switching away
  and back (repository reload) and a hidden-owner completion.
- A manually truncated response commits marked truncated.
- No proposal can be created from a cut-off response (both outcomes),
  and the evaluation harness zeroes every dimension of an incomplete
  sample instead of scoring it.
- Evidence notes count successful retrievals only and report failures;
  a cancelled tool batch is committed as an explanatory note.

Simplification pass (delegated, after the batch was verified): extracted
`storedMessageToRaw` (three identical message-serialization blocks in the
JSON backend), `insert_message` (four identical `INSERT INTO messages`
statements in Rust), and merged the single-consumer `evidenceCounts` into
`evidenceNote`. No behavior changes; tsc/tests/build/cargo re-run green
afterwards.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 474 passed (49 files; +14).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 83 passed, 1 ignored (+2). `cargo check` - OK.

Remaining defects / limitations (B16b):
- Proposals created BEFORE this build from a cut-off response carry no
  marker (the proposal table has no completeness column); acceptance
  still relies on the B12 review + revision/fragment checks. A
  proposal-level marker was not added because creation is now refused.
- The incomplete marker is not shown for stopped answers (a deliberate
  stop); only interrupted/truncated are marked.
- The retained failed-send snapshot limitation is unchanged (B15): a
  partial does not enter the registry, so its Retry affordance is the
  per-message regenerate path, not a snapshot replay.
- `interruptedResearchNote` counts only the batch that was running; a
  round interrupted BEFORE its tool_calls were assembled is still
  reported by outcome, not with per-call evidence.
- The desktop bundle format stays version 3: the dump gained a nullable
  field, older readers drop it (serde ignores unknown fields) and newer
  readers default it to null.

Exact next batch: B17a - Complete cancellation (abort checks after every
awaited phase; cancellable native lifetimes for the nonstreaming
fallback and research commands; body reading + DNS in cancellation;
cancel active tool workers; IPv4-mapped IPv6 classification fix; keep
resolved-address pinning).

### B17a - Complete cancellation

Completed: 2026-09-16.

Root causes found while implementing:
- `zen_chat` (the non-streaming fallback) had NO cancellation token: the
  frontend invoked it without a signal and Rust bounded it only by a
  300s timeout, so a Stop during the fallback left the native request
  running to completion and its late result could still feed the
  fallback/answer path.
- `zen_web_search` and `zen_fetch_page` had no cancellation either: DNS
  lookups, header waits, redirect hops, and body reads ran to completion
  after a Stop. `runToolBody` invoked them with no signal, and once a
  tool worker had STARTED, the loop's abort check only prevented new
  workers (it never cancelled the active ones).
- `run_stream`'s header wait was not raced: only the SSE body read
  honoured the token.
- `is_blocked_ip` classified IPv4-mapped IPv6 (`::ffff:127.0.0.1`,
  `::ffff:10.0.0.5`, `::ffff:169.254.169.254`) as a generic IPv6
  address, so loopback/private/link-local IPv4 ranges reachable through
  the mapped form were allowed. Additionally `reqwest::Url::host_str()`
  returns IPv6 literals in BRACKETS (`[::1]`), which `IpAddr::from_str`
  rejects, so bracketed IPv6 literals bypassed the block list entirely.
- `resolve_verified_host` built IPv6 socket addresses through a string
  round-trip (`format!("{host}:{port}")`), which fails for IPv6 forms
  without brackets ("Invalid address") — a public IPv6 literal could
  never resolve.

Files changed:
- `src-tauri/src/lib.rs` -
  - `race_cancel(token, fut)`: the shared cancellation race. Every
    awaited native phase a Stop can reach now goes through it (DNS
    lookup, header waits, body reads, one-shot requests).
  - `StreamState::token_for` + `StreamState::cancel`: one registry for
    streams, the one-shot fallback, and research tools. A cancel for an
    id that has not registered yet leaves a PRE-CANCELLED tombstone, so
    a Stop can never race past its request; the request releases its
    entry when it finishes.
  - `zen_chat_stream_cancel` is now the generic cancel (documented);
    `zen_chat_stream` uses `token_for`.
  - `request_token`/`release_request` helpers; `run_chat` extracted from
    `zen_chat`; `zen_chat(state, id, ...)` races the send (429 retries
    included) AND the body read.
  - `run_stream` rejects a pre-cancelled token before sending and races
    the initial send; the non-SSE body read is raced too.
  - `zen_web_search(state, id, query)` + `run_web_search`;
    `zen_fetch_page(state, id, url)` + `run_fetch_page`: DNS
    (`lookup_host`), headers (`send`), every redirect hop, and the body
    read are cancellable.
  - `parse_host_ip` (strips `[`/`]` before `IpAddr` parsing),
    IPv4-mapped unwrapping in `is_blocked_ip`, and TYPED
    `SocketAddr::new(ip, port)` construction. The resolved-address
    verification/pinning is unchanged.
- `src/utils/api.ts` -
  - `cancelledError()` + `invokeAbortable(cmd, args, signal)`: a
    non-streaming command gets a stable request id and the abort calls
    `zen_chat_stream_cancel` for exactly that id, then races the invoke
    against the signal.
  - Both adapters: `runNonStreamingRound` uses `invokeAbortable` and
    classifies an abort as `stopped`; abort checks run after the round
    AND after each capability fallback (no tools/fallback/commit once
    the signal fired); `finishWithoutTools` refuses to claim an answer
    when its final round was cancelled.
  - `runToolBody`/`executePermittedTool`/`executePermittedAnthropicTool`
    carry the signal, so Stop cancels ACTIVE tool workers; a cancelled
    retrieval is recorded as `interrupted`, never as a failed provider
    call.
  - The interrupted-batch note now counts FINISHED retrievals from the
    evidence ledger: a cancelled active worker returns an error string,
    so counting non-null results would overstate the batch.

Tests:
- `src/utils/__tests__/api.test.ts` +3: abort during the OpenAI
  non-streaming fallback stops it, cancels the EXACT native request id,
  and never retries; the Anthropic fallback aborts the same way; abort
  cancels both ACTIVE tool workers, performs no later round, and reports
  the interrupted batch. The B16b interrupted-batch fixture was rewritten
  to four finished + one in-flight retrieval, matching the new discard
  semantics (post-Stop results are treated as interrupted).
- Rust (lib.rs) +6: IPv4-mapped addresses follow the IPv4 rules;
  bracketed IPv6 literals are classified and resolve to TYPED socket
  addresses; a pre-cancelled token stops DNS and fetch before any
  network; `race_cancel` aborts pending futures and is transparent with
  no token; a pre-cancelled one-shot chat never sends; a cancel before
  registration leaves a pre-cancelled token that the late request
  consumes.

Regression scenarios demonstrated through production paths:
- Stop during the one-shot fallback: `sendMessage` returns
  `outcome: "stopped"`, the native id received `zen_chat_stream_cancel`,
  and no retry/resume happens.
- Stop during active research: every in-flight tool request id is
  cancelled natively, the loop never starts another round, and the
  thread gets the "Research was interrupted…" note.
- Offline: `::ffff:127.0.0.1` and `[::1]` are blocked; a public IPv6
  literal resolves to its typed `SocketAddr` instead of failing.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 477 passed (49 files; +3).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 89 passed, 1 ignored (+6). `cargo check` - OK.

Remaining defects / limitations (B17a):
- `zen_list_models` and `zen_fetch_zen_pricing` remain non-cancellable
  (outside the named scope); stale model-list responses are B17b's.
- Tool cancellation is cooperative at the native request boundary: a
  body already read is still parsed, but no result from a post-Stop
  request is ever claimed.
- An aborted in-flight tool batch deliberately discards its results even
  if the network calls complete afterwards; the note counts only
  genuinely finished retrievals.
- `zen_chat_stream_cancel` keeps its historical name although it now
  cancels every request family (renaming would churn exposed commands
  for no behavior gain).

Exact next batch: B17b - Credential transitions (bind the editable key
to normalized profile identity; clear synchronously on
provider/endpoint change; disable actions until resolved; store-level
ownership; case-sensitive URL paths; legacy migration with provenance;
Forget credential).

### B17b - Credential transitions

Completed: 2026-09-16.

Root causes found while implementing:
- The editable key was plain form state with NO profile ownership:
  `applyProvider` reloaded the new provider's credential only AFTER an
  await (the old key stayed in the field during that window and a click
  on Test/Save/Reload could send it to the new endpoint), and manual
  base-URL edits never reloaded or invalidated the key at all.
- Store-level: `setConfig({ baseUrl: B })` without a key changed the
  endpoint but KEPT the in-memory key from profile A — a later send
  could authenticate A's key against B.
- `normalizeEndpoint` lowercased the ENTIRE URL including the path:
  `https://x.dev/V1` and `https://x.dev/v1` collided into one keychain
  account (cross-profile credential reuse), and no migration could tell
  the two stored credentials apart.
- `loadConfig` migrated the pre-R7 shared keychain entry / plaintext
  key into whatever profile the stored config named, even when the
  persisted account reference pointed at a DIFFERENT account
  (provenance failure after hand-edits or restores).
- There was no explicit way to forget a stored credential.

Files changed:
- `src/utils/keychain.ts` -
  - `normalizeEndpoint` preserves path/search case (scheme + host are
    lowercased; trailing slashes dropped), so different-cased paths are
    different profiles.
  - `legacyNormalizeEndpoint` (whole URL lowercased) plus
    `loadCredential` migration: when the new account has no entry, an
    account under the old rule is migrated forward with a VERIFIED
    write before the old copy is removed.
- `src/stores/chatStore.ts` -
  - `setConfig`: a profile change (provider or normalized endpoint)
    without a key in the SAME call clears the carried in-memory key
    (the old profile's stored credential stays untouched).
  - `loadConfig`: legacy shared/plaintext migration is gated on
    `profileMatchesDeclared` (the persisted `keychainAccount` reference)
    so a mismatched profile never claims or deletes a legacy key.
  - `forgetCredential(profile?)`: deletes the selected profile's
    credential, removes legacy copies only when they hold that exact
    key, clears the in-memory key for that profile, and persists the
    stripped config.
- `src/components/settings/ApiConfigForm.tsx` -
  - `keyProfileRef`/`keyResolved`/`keySeq`: the editable key is bound to
    the normalized profile it came from. Provider switches and endpoint
    edits clear the field SYNCHRONOUSLY before any await; a debounced
    resolution effect (250 ms) loads the displayed profile's stored
    credential (stale responses are discarded by sequence number) and
    refreshes the model list with it.
  - Test connection, Save, and Reload models are disabled while the
    profile is unresolved (handlers also guard); typing a key settles
    the profile immediately and cancels any pending load.
  - Explicit "Forget saved key" action (calls the store with the
    FORM's profile, not the persisted one); aria-labels on the key and
    base-URL inputs.
- Tests: `credentialIsolation.test.ts` +5 (path-case identity + old
  account migration; a partial profile change never carries the key;
  forget clears the profile + persistence; forgetting another profile
  is a no-op; a mismatched account reference blocks legacy migration),
  and NEW `apiConfigCredentials.test.tsx` (4 jsdom tests through the
  real form controls: an endpoint edit clears the field and disables
  Test/Save synchronously and K1 is never sent to the new URL; a slow
  keychain response cannot overwrite a newer endpoint's field; a
  detected provider switch keeps the typed key; Forget removes the
  credential and the field).

Regression scenarios demonstrated through production paths:
- URL A→B then an immediate Test/Save click: the field is empty, the
  actions are disabled, and the captured `listModels` calls never
  include A's key for B.
- Switching back to A resolves A's stored credential and shows it —
  the key was not deleted by the profile change.
- The stale-read test releases the old profile's hanging keychain
  response AFTER the new profile resolved: the field keeps the new
  profile's key.
- Forget removes exactly the selected profile's keychain entry and the
  persisted config carries no key material.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 486 passed (50 files; +9).
- `npm run build` - OK (pre-existing chunk-size warning).
- Rust untouched this batch (`cargo test --lib` 89 passed, 1 ignored;
  `cargo check` OK - re-run unchanged).

Remaining defects / limitations (B17b):
- Credential resolution is debounced (250 ms): between an endpoint edit
  and resolution the authenticated actions are disabled (that is the
  designed safety window, not a regression).
- A profile switch keeps the old profile's stored credential on purpose;
  "Forget saved key" removes it explicitly.
- The case-preserving normalization changes account identities for URLs
  whose path case differs; migration covers the exact-URL old account
  only (a credential stored under a differently-cased path was always a
  different credential).
- Provider switching through the Base UI Select is covered by the
  store-level partial-change test and the auto-detect form test, not by
  a direct Select interaction.

Exact next batch: B18 - Preserve bibliography identity and metadata
(see `docs/REPAIR-CHECKPOINT-B17B.md`).

### B18 - Preserve bibliography identity and metadata

Completed: 2026-09-16.

Root causes found while implementing:
- BibTeX authors were joined with ", " when building the source record
  (`author.split(/\s+and\s+/).join(", ")`) while the app's author
  boundaries are "; ": every later parse read the whole list as ONE name
  ("Quijano, Aníbal; ..." became a single family/given pair). Multi-author
  imports were silently corrupted.
- `journal`, `booktitle`, `publisher`, and `note` were all collapsed into
  the `translation` field; RIS/CSL abstracts were stored as translation
  and TRUNCATED at 300 characters. The model had no type, container,
  publisher, volume/issue/pages, abstract, or notes-from-import fields.
- The CSL exporter hardcoded `type: "book"` and BibTeX emitted `@misc`
  for every source ("do not turn every article into a book").
- Source dedup hashed the formatted reference line (title/author/year),
  so the same DOI imported from BibTeX and RIS (different reference
  lines) produced two sources.
- BibTeX values were written raw: a literal `{`, `}`, `&`, `%`, `_`, `#`,
  `$`, or `\` in a title produced a corrupted entry; citation keys could
  collide silently (equal author/year/title prefixes).
- `parseCslJson` accepted ANY array of objects, inventing "Untitled
  source" records from unrelated JSON.
- Structured CSL names were flattened lossily ("Tuhiwai Smith, Linda" →
  display "Linda Tuhiwai Smith" → family "Smith", given "Linda
  Tuhiwai"); literal organizations were guessed as Given Family.
- The Sources panel could not edit metadata, exported only BibTeX, and
  reported nothing about imported/duplicate decisions.

Files changed:
- `src/types/index.ts` - `SourceMeta` gains `sourceType`,
  `containerTitle`, `publisher`, `volume`, `issue`, `pages`, `abstract`;
  `normalizeDoi` (resolver prefixes stripped, case-folded).
- `src/utils/bibliography.ts` - rewritten:
  - `BibliographySource`, kind↔type maps for BibTeX and RIS in both
    directions (unknown kinds → "document", never a more specific
    claim).
  - `escapeBibValue` + escape-aware brace matching + `stripGroupBraces`/
    `decodeBibEscapes`, so literal braces and symbols round-trip.
  - `{{Org Name}}` / `{Org Name}` literal-organization detection;
    author parts joined with "; ".
  - notes, abstract, translator, journal/booktitle → containerTitle,
    publisher/institution/school, volume, number/issue, pages all
    separated.
  - `uniqueCitationKeys` (collisions suffixed; distinct DOIs with equal
    titles can never collide silently).
  - RIS: TY retained and mapped; N1/AB/JO/JF/T2/BT/PB/VL/IS/SP/EP read
    and written symmetrically (multi-line values sanitized to one line).
  - CSL JSON: recognition gate (string `type` AND a real `title`) —
    unrelated JSON yields NO sources; literal/name/family-given names
    preserved; type/container/publisher/volume/issue/page/abstract/note
    carried; export type comes from the source, defaulting to
    "document".
- `src/utils/cslProcessor.ts` - `CslName.literal`; brace-aware, exported
  `splitAuthorList` (a separator inside a literal org is not a boundary);
  `parseAuthorName` recognizes `{Org}`; `cslItemFromSource` carries
  type/container/publisher/volume/issue/page/abstract and no longer
  hardcodes "book".
- `src/stores/sourceStore.ts` - `SourceInput` gains the metadata fields +
  `notes`; `addSource` stores `doi:<normalized>` as the dedup identity
  when a DOI is present; a duplicate now MERGES absent metadata from the
  import (never overwrites) and reports `merged`; existing values win.
- `src/components/workspace/SourcesPanel.tsx` - metadata editor (title,
  author, year, type, container, publisher, volume/issue/pages, DOI,
  URL, language, translation, abstract, notes) with visible failure and
  save-before-acknowledge; export row for BibTeX/RIS/CSL JSON; the import
  reports real counts ("Imported N; M duplicates skipped (K merged
  missing metadata)") and says when a file had no importable records;
  expanded rows show the retained metadata.
- `src-tauri/src/repository.rs` - schema v13: seven nullable source
  columns (`source_type`, `container_title`, `publisher`, `volume`,
  `issue`, `pages`, `abstract_text`; `#[serde(rename = "abstract")]`
  because `abstract` is a Rust keyword), `migrate_v13` (column-guarded,
  repairable), and every source SQL path (create/save/insert/read/
  export/import) carries them. The migration test's fabricated v10/v11
  databases now create the v9 tables they would really have.
- `src/utils/repository.ts` - `SourceRowWire` + converters.
- `src/utils/backup.ts` - `DumpSourceRow` + `normSource`.
- `src/test/backup-contract.json` - REGENERATED from Rust (schema v13;
  the two fixture sources carry real type/container/publisher/volume/
  issue/pages/abstract values).

Tests:
- `bibliography.test.ts` +8: multi-author boundary fidelity and
  round-trip (incl. "Tuhiwai Smith, Linda" and a literal org); full
  metadata separation + round-trip; BibTeX escaping (literal braces,
  `&`, `%`, `_`, `#`, `$`, `\`); unique keys for equal titles with
  different DOIs; `normalizeDoi`; RIS symmetry with a >1000-character
  abstract (no silent truncation) and article type retention; CSL
  literal/type/container round-trip; unrelated-JSON rejection.
- `cslProcessor.test.ts` +2: brace-literal parsing and separators inside
  a literal organization; item metadata passthrough with the honest
  "document" fallback. Two existing expectations were updated to the
  FAITHFUL family-first display and the no-longer-invented book type.
- `sourceStore.test.ts` +3: DOI identity dedup; absent-metadata merge
  without overwrite; metadata retained through add and edit.
- `sourcesPanel.test.tsx` +2 (real controls): the metadata editor
  persists and closes; the real import reports imported/duplicate/merged
  counts and merges the duplicate's publisher.
- Rust: `stranded_partial_migrations_are_repaired` gained a v13 section
  (v12→v13 upgrade, data intact, re-run no-op); the production
  export→import→export test now seeds populated metadata and asserts
  byte-identical re-exports.

Regression scenarios demonstrated through production paths:
- Importing `Quijano, Aníbal and Tuhiwai Smith, Linda and {Colectivo
  Abya Yala}` yields three intact authors, and the BibTeX round-trip
  returns the identical display string.
- A full journal entry keeps journal, publisher, volume, issue, pages,
  abstract, notes, translator, and type separately (no more collapsing
  into translation, no 300-char truncation).
- The same DOI imported with a different reference line dedups; the
  existing source keeps its values and receives only absent metadata.
- Unrelated JSON never creates a source; a typed item without a title is
  skipped too.
- The panel editor writes through updateSource (persist first) and only
  then shows success; a failed write leaves the source unchanged.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 500 passed (50 files; +14).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 89 passed, 1 ignored. `cargo check` - OK.

Remaining defects / limitations (B18):
- RIS has no literal-name convention: a literal organization is written
  as plain text, so a RIS round-trip may read it as Given Family.
  BibTeX (`{{Org}}`) and CSL JSON (`literal`) round-trip exactly.
- Imports write family-first author displays ("Tuhiwai Smith, Linda");
  that is deliberate for part fidelity and existing given-first strings
  are left untouched until edited.
- Duplicate merge fills only ABSENT fields; failure of the metadata
  merge is reported as not merged (the import itself still succeeds).
- The model stores one container field; a chapter's book title and an
  article's journal share `containerTitle` (their BibTeX field differs
  by type on export).
- Citation keys for non-ASCII author names fall back to a slug of the
  remaining characters (never invalid characters, but not transliterated).

Exact next batch: B19 - Faithful footnotes and DOCX export (see
`docs/REPAIR-CHECKPOINT-B18.md`). The asset-store decision must be
surfaced to the user before/with that batch.

### B19 - Faithful footnotes and DOCX export

Completed: 2026-09-16.

Asset decision (user, before B19): option (b) - backups preserve the
extracted text of uploaded sources, not the original files; no
content-addressed asset store and no schema/backup-contract change.
Documented in the README backup bullet and in Settings > Backup & restore
("Backups preserve the extracted text of uploaded sources, not the
original files. API keys are never included.").

Root causes found while implementing:
- Citation markdown interpolated the label and `data-source-id` raw, and
  the footnote label raw in element text: `"`, `<`, `>` or an early
  `</sup>` in a label could break the literal HTML that the Markdown
  round-trip depends on.
- Footnotes had no stable identity, no source provenance (source id,
  passage id, locator), no text editing after insertion (only the
  `window.prompt` at insertion), and the reader exposed note text only
  through the marker's hover title.
- `nextFootnoteLabel` was count + 1, so deleting a middle note produced
  DUPLICATE labels (delete note 1 of 3, insert → both note 3 and the new
  note were labelled "3").
- Bibliographies and the DOCX export collected only citation nodes;
  source-backed footnotes were invisible, and references whose source
  record no longer existed were skipped silently everywhere.
- DOCX export flattened every list to level 0 under ONE shared numbering
  reference (so a second list continued the first list's count), ignored
  list nesting/start values, dropped hyperlinks entirely, replaced tables
  inside quotations with empty paragraphs, lost quotation paragraph
  boundaries and formatting, ignored merged cells, emitted an empty
  bibliography heading, and always appended a generated bibliography even
  when the document already contained one.

Files changed:
- `src/components/editor/markdownEscape.ts` - NEW: `escapeHtmlText` /
  `escapeHtmlAttr` shared by both atom extensions.
- `src/components/editor/footnoteExtension.ts` - attrs gained `id`,
  `sourceId`, `passageId`, `locator` (text stays the display fallback);
  `createFootnoteId`; markdown/HTML/parse all carry the new attrs;
  a ProseMirror plugin rewrites labels to document order after every
  change (duplicates are impossible); a NodeView renders the marker and
  opens a click-to-edit popover (Enter/Save commits, Escape cancels,
  outside click dismisses); `collectFootnotesFromJson`; the editor's
  `closeFootnoteEditor` test seam.
- `src/components/editor/citationExtension.ts` - escaped label text and
  `data-source-id` attribute in the markdown serializer.
- `src/components/library/sourceAtoms.ts` - generic atom-tag parsing:
  attribute order, extra attributes (footnote id/source/locator), and
  entity-encoded values are all tolerated; the reader marker carries the
  new data attributes.
- `src/utils/sourceRefs.ts` - NEW: `collectSourceRefs` (live editor doc),
  `collectSourceRefsFromJson` (stored/parsed JSON), `missingSourceIds` -
  citations AND source-backed footnotes, document order, deduplicated.
- `src/components/editor/DocumentEditorView.tsx` - CiteControls passage
  picker now tracks the passage id (locator derived); source-backed
  footnotes insert id/sourceId/passageId/locator; the bibliography action
  uses `collectSourceRefs` and reports unresolved references in a
  `role="status"` notice.
- `src/components/library/LibraryReader.tsx` - document JSON computed once;
  a Notes list shows every note's text; DOCX export uses
  `collectSourceRefsFromJson` + `missingSourceIds` (visible notice) and
  passes `appendBibliography: !hasBibliographyHeading(...)`.
- `src/utils/docxExport.ts` - recursive list export (per-top-level-list
  numbering instances, abstract configs per level shape, start values,
  nested `ilvl`); hyperlinks as `ExternalHyperlink` relationships; quote
  depth indentation preserving paragraph boundaries and embedded tables;
  merged cells via `columnSpan`/`rowSpan`; empty bibliographies skipped;
  `hasBibliographyHeading` + explicit `appendBibliography` option.
- `src/index.css` - clickable editor marker + `.footnote-editor` popover
  styles (design tokens).
- `src/components/settings/SettingsDialog.tsx` + `README.md` - the
  extracted-text-only backup statement.

Tests:
- `citation.test.tsx` +1: hostile label/id escaping and exact round-trip.
- `footnote.test.tsx` rewritten (+5): stable ids and full provenance
  round-trip; document-order renumbering after deleting the first note
  (labels 1..2, next label 3, hostile labels normalized); click-to-edit
  through the real mounted editor; Escape discard; escaping.
- `docxExport.test.ts` +7 (now 10): nested lists with separate numbering
  instances and start overrides (XML + numbering.xml); hyperlinks in
  document.xml + document.xml.rels; quotation paragraph order/indent and
  a table inside the quote; `gridSpan`/`vMerge`; empty bibliography
  skipped; explicit append option (1 vs 2 headings); fallback footnote
  text with a deleted source.
- `sourceRefs.test.ts` NEW (+4).
- `libraryExport.test.tsx` +3 through the real DOCX button: a footnote-only
  source reaches the bibliography; an unresolved source produces the
  report while the stored note text is kept; an existing bibliography is
  not duplicated; the DOCX test now also checks the link relationship and
  the bibliography count, and the reader test checks the Notes list.
- `documentEditor.test.tsx` +1 through the real CiteControls button: the
  known source is inserted into the bibliography and the unresolved
  reference is reported.

Regression scenarios demonstrated through production paths:
- The reader's real DOCX button on a manuscript with prose, a citation, a
  note, a hyperlink, and a source-backed footnote produces: prose order
  intact, exactly one References heading, the URL in
  `word/_rels/document.xml.rels` (`TargetMode="External"`), the note text
  in `word/footnotes.xml`, and the footnote's source in the bibliography.
- A note whose source was deleted shows the unresolved-reference report,
  keeps its stored fallback text, and adds no invented bibliography entry.
- Clicking a footnote marker in the editor edits its text; deleting the
  first of three notes renumbers the rest and the next insertion uses "3".
- Two ordered lists export with different numbering ids; the list with
  `start: 3` carries a `startOverride` of 3.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 521 passed (51 files; +21).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 89 passed, 1 ignored (no Rust/dump change in B19);
  `cargo check` - OK.

Remaining defects / limitations (B19):
- The editor's "Insert bibliography" action still appends a fresh section
  when clicked repeatedly; duplication is avoided on export via
  `hasBibliographyHeading` + the explicit append option, and detection is
  an exact heading-text match on the style's section title.
- Footnote content is plain text; only the text is editable.
- A source-backed note formats its display text at insertion; later source
  metadata edits do not rewrite existing notes (the note text is the
  fallback and the locator is retained).
- Ordered lists share one abstract numbering config per level shape; two
  nested ordered lists at the same depth with different `type` values use
  the first one's format.
- The reader's Notes list is a list, not anchor links from the markers.

Exact next batch: B20a - Find/shortcuts (`src/utils/documentFind.ts`,
`DocumentEditorView.tsx`, `WorkspaceShell.tsx`; first reads:
`documentFind.ts`, the find UI/shortcuts in `DocumentEditorView.tsx`,
`documentFind.test.ts`).

### B20a - Find/shortcuts

Completed: 2026-09-16.

Root causes found while implementing:
- `findMatches` lowercased the whole run and used offsets from that
  lowercased string against the ORIGINAL per-character position array.
  When lowercasing changes length (İ → "i" + combining dot), every match
  after such a character mapped off by one or more characters (searching
  "archive" in "İstanbul archive" highlighted the space before the word).
- Replace inserted through Tiptap's `insertContentAt` string API, which
  PARSES strings: replacing "bold" with `<b>bold</b>` produced a bold run
  instead of the literal text the user typed.
- `focusCurrent` called `editor.commands.focus()` on every next/previous,
  pulling focus out of the Find input mid-navigation.
- Escape closed the bar only from the Find input, not the Replace input.
- Ctrl/Cmd+S and Ctrl/Cmd+F were handled by a window listener regardless
  of an open dialog; Ctrl/Cmd+K opened the command palette even while the
  toolbar advertised "Link (Ctrl+K)" and the manuscript had focus.

Files changed:
- `src/utils/documentFind.ts` - `foldForSearch` (length-preserving
  whole-string lowercase keeps old behavior, e.g. Greek final sigma;
  otherwise a per-character offset map is built) and `findMatches` maps
  folded offsets back to real characters; NEW `replaceMatches(state,
  matches, replacement)` — one transaction, applied end-first, inserting
  with `tr.insertText` (LITERAL text, never parsed).
- `src/components/editor/FindReplaceBar.tsx` - highlighting uses a
  selection transaction instead of `focus()`; Replace and Replace all go
  through `replaceMatches`; nav/replace buttons keep the input focus
  (mousedown preventDefault) and refocus the query input after replacing;
  Escape works in the Replace input too.
- `src/components/editor/linkCommand.ts` - NEW: the ONE `promptForLink`
  flow shared by the toolbar and the shortcut.
- `src/components/editor/EditorToolbar.tsx` - uses `promptForLink`.
- `src/components/editor/DocumentEditorView.tsx` - the shortcut handler
  ignores keystrokes from `[role='dialog'/'alertdialog']` surfaces and
  handles Ctrl/Cmd+K itself when the keystroke originated inside the
  manuscript DOM (link); otherwise the palette owns the chord.
- `src/components/workspace/WorkspaceShell.tsx` - the palette handler
  skips contenteditable/`.ProseMirror` targets, so exactly one of the two
  actions handles Ctrl+K.

Tests:
- `documentFind.test.ts` +4 (real ProseMirror documents): real position
  mapping; İ fold offsets; literal single replacement with zero marks;
  end-first replacement of every match.
- `findReplace.test.tsx` NEW +5 (a REAL mounted Tiptap editor through the
  production bar): Enter navigation keeps focus and never mutates the
  manuscript; an HTML-looking Replace all stays literal text; Replace
  replaces the selected match; Escape closes from each input.
- `documentEditor.test.tsx` +2: Ctrl+K prompts for a link only from the
  manuscript (window/chord elsewhere does not); Ctrl+F is suppressed from
  dialog surfaces.

Regression scenarios demonstrated through production paths:
- Three Enter presses in Find leave the document byte-identical and the
  caret in the Find input; the editor selection still follows matches.
- Replacing "bold" with `<b>bold</b>` yields the literal text and zero
  marked text nodes.
- Searching "archive" in "İstanbul archive" highlights the real word
  (offsets corrected after the İ expansion).
- Ctrl+K inside the manuscript opens the link prompt; from elsewhere it
  does not fire the link flow (the shell's palette keeps it).

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 532 passed (52 files; +11).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 89 passed, 1 ignored; `cargo check` - OK
  (no Rust change).

Remaining defects / limitations (B20a):
- Case folding follows JavaScript's default Unicode folding: a
  length-preserving whole-string lowercase when possible, per-character
  folding otherwise. Locale-specific rules (Turkish dotless i) are not
  applied.
- Find matches stay within a block (hard breaks/structured nodes are
  barriers) — unchanged by design.
- Ctrl+K from an input (title, chat composer) still opens the palette;
  only the manuscript claims it for Link.

Exact next batch: B20b - Command palette (`CommandPalette.tsx` + the
existing modal primitive `src/components/ui/dialog.tsx`; first reads:
`CommandPalette.tsx`, `dialog.tsx`, the workspace-shell tests that
exercise the palette).

### B20b - Command palette

Completed: 2026-09-16.

Root causes found while implementing:
- The palette was a hand-rolled `createPortal` overlay with a bare
  `role="dialog"`: no focus trap, no focus restoration, and Escape/outside
  click only worked through ad-hoc handlers.
- The window keydown handler handled arrows/Enter globally and ignored
  composition: an IME Enter could activate a result mid-composition. It
  also created a SECOND activation path beside the row buttons' onClick.
- Full-text responses had no staleness guard: a slow query A resolving
  after query B overwrote B's results.
- `active` was only reset when the query changed: a late search hit could
  change the list while `active` pointed past its end (Enter silently did
  nothing), and hover/keyboard could disagree about the active row.
- Focus was never restored to the surface the palette was opened from
  (Ctrl+K has no DialogTrigger to infer it from).

Files changed:
- `src/components/workspace/CommandPalette.tsx` - rebuilt on the app's
  modal primitive (`Dialog` / `DialogContent` from `ui/dialog.tsx`).
  Results are a `listbox` with `aria-activedescendant` /
  `aria-selected`; ONE `activate(item)` path serves Enter and clicks; the
  keyboard handler lives on the input and is IME-safe (`isComposing` /
  keyCode 229); the debounced search discards stale responses (a
  cancellation flag per query effect); the active index is clamped
  whenever the result list changes; the element focused
  at open time is captured and passed as `finalFocus`, restoring focus on
  close.
- `src/components/__tests__/commandPalette.test.tsx` - NEW +6.

Tests:
- `commandPalette.test.tsx` NEW +6: a slow earlier query cannot replace
  the newer query's results; Enter activates the focused result exactly
  once and closes; an IME-composing Enter (keyCode 229) does not activate;
  arrow navigation keeps exactly one `aria-selected` option; content
  behind the palette is inert/`aria-hidden` and the modal focus guards
  return focus inside; Escape closes and restores focus to the opener.
- The old palette had no tests; the "Search everything" button remains
  wired in the shell unchanged.

Regression scenarios demonstrated through production paths:
- Typing "slow", then "fast" while slow is still pending: when slow
  resolves, B's result stays and A's never appears.
- Opening the palette with the real dialog primitive, pressing Escape,
  and focus returns to the button that opened it.
- An Enter with an active IME composition leaves the result unactivated.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 538 passed (53 files; +6).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 89 passed, 1 ignored; `cargo check` - OK.

Remaining defects / limitations (B20b):
- The palette still matches titles only (plus full-text hits); there is no
  fuzzy matching (unchanged from before).
- The backdrop is now the shared dialog overlay (10% + backdrop blur)
  instead of the old custom 40% black — a deliberate consistency change
  with every other dialog.
- `DialogContent`'s default close button is suppressed; Escape and
  outside click remain the dismissal paths.

Exact next batch: B20c - Panels/accessibility (`WorkspaceShell.tsx`,
`InspectorPanel.tsx`, `ProjectNavigator.tsx`, `src/index.css`,
`DESIGN.md`; first reads: `WorkspaceShell.tsx`, `InspectorPanel.tsx`,
`workspaceShell.test.tsx` + `DESIGN.md`).

### B20c - Panels and accessibility

Completed: 2026-09-16.

Root causes found while implementing:
- Collapse was `window.innerWidth < MIN_CENTRE_WIDTH + 240 + 360`: it
  ignored the user's actual panel widths (a 360px navigator + 520px
  inspector left the centre below its minimum at widths that "fit" by the
  formula) and ignored the real container (zoom/OS scaling changes CSS
  pixels, not the formula's assumptions).
- At narrow widths the Show buttons were dead controls: toggling the
  collapsed state could not make a panel appear (it stayed auto-hidden),
  so the navigator/inspector were unreachable.
- The inspector's drag handle sat OUTSIDE the panel (window edge) instead
  of its inner edge.
- `persistShell` wrote neither panel width even though `hydrateShell`
  read them: resized panels reset on restart. There was no keyboard
  resizing and no aria-valuenow on the separators.
- Collapsing/focus mode UNMOUNTED the panels, discarding navigator
  expansion and assistant state (the store survived, the component did
  not).
- Tailwind's preflight strips list markers: the manuscript editor
  rendered bullet/numbered lists without any markers. The editor also had
  `outline: none` on the manuscript surface with no keyboard focus
  replacement.
- Inspector tabs lacked `aria-controls`/`aria-labelledby`, every tab was
  in the tab order, and arrows did not move between tabs. Row actions
  (pin/archive/rename/restore) were `opacity-0 group-hover:opacity-100`:
  invisible to keyboard users. Active rows had no `aria-current` and
  project expand buttons no `aria-expanded`.
- `.rich-doc`/`.doc-markdown` headings used the UI sans voice (DESIGN.md
  says manuscript headings stay in the document voice) and the reader was
  17px/1.75 instead of the contract's 18px/1.7. Navigator section labels
  used `muted` for meaningful text (the contract reserves muted for
  placeholders/disabled). No reduced-motion handling existed.

Files changed:
- `src/components/workspace/WorkspaceShell.tsx` - measured layout: a
  ResizeObserver (window-resize fallback) reads the REAL shell container;
  exported `fitPanels(width, collapsed, collapsed, navWidth, inspWidth)`
  hides the inspector first, then the navigator; both panels stay MOUNTED
  (HTML `hidden` when collapsed/auto-hidden/focus mode) so local state
  survives; an auto-hidden panel opens as a drawer (role=dialog,
  aria-modal, scrim, Escape, focus moved in, closes when the width grows);
  the inspector separator moved to the inner edge; both separators resize
  by Arrow keys with aria-valuenow/min/max; rail buttons are labelled and
  focusable.
- `src/stores/useAppStore.ts` - `persistShell` now writes both panel
  widths (they were read on hydrate but never written).
- `src/components/workspace/InspectorPanel.tsx` - proper tab pattern:
  `aria-controls`/`aria-labelledby`, roving tabIndex, Left/Right/Home/End
  selection with focus, visible focus ring.
- `src/components/workspace/ProjectNavigator.tsx` - `aria-current` on the
  active project/document/thread rows, `aria-expanded`/`aria-controls` on
  project toggles, row actions visible for keyboard users
  (`group-focus-within` + `focus-visible`), run-time focus rings, section
  labels moved from `muted` to `secondary`.
- `src/index.css` - manuscript list markers restored (disc/circle/square,
  decimal/lower-alpha/lower-roman); editor keyboard focus ring; reader and
  editor headings in the document voice with the contract's step-down
  sizes; reader body 18px/1.7; global `prefers-reduced-motion` block.
- `DESIGN.md` - Panel behaviour prose extended (measured collapse,
  drawers, mounted panels, keyboard/token-persistent widths). Linted:
  `npx -p @google/design.md designmd lint DESIGN.md` - 0 errors,
  0 warnings.

Tests (`workspaceShell.test.tsx` +6, now 14):
- `fitPanels` at 1200/1080/900 with default and maximum widths, plus the
  below-minimum both-hide case and user-collapsed rails;
- 1200 keeps both panels inline; 1080 auto-hides the inspector but keeps
  it mounted and opens it as a drawer; Escape closes the drawer and the
  rail returns;
- keyboard resizing of both separators (Arrow keys, aria-valuenow,
  persisted widths incl. the prefs row);
- navigator-local state (expanded project) survives collapse/re-expand;
- `aria-current` on the opened document row and the full inspector tab
  pattern (aria-controls, roving tabIndex, arrow/Home/End focus movement).

Regression scenarios demonstrated through production paths:
- At 1080px the inspector tablist is not visible inline, still exists in
  the DOM, and the "Show inspector" rail opens a focus-moving drawer that
  Escape closes.
- At 1200px with maximum panel widths the inspector auto-hides; at 700px
  both panels fold to rails.
- Arrow keys on a focused separator change the stored/persisted width and
  update aria-valuenow.
- A project expanded before collapsing the navigator is still expanded
  after re-expanding it.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 544 passed (53 files; +6).
- `npm run build` - OK (pre-existing chunk-size warning).
- `npx -p @google/design.md designmd lint DESIGN.md` - 0 errors/0
  warnings.
- `cargo test --lib` - 89 passed, 1 ignored; `cargo check` - OK.

Remaining defects / limitations (B20c):
- The narrow-width drawer is a labelled modal surface with scrim + Escape,
  but it is not a full focus trap (moving focus behind it is possible).
- Auto-hide is presentation-only: it never flips the user's explicit
  collapse preference, so growing the window restores the preference.
- 200% zoom is handled through the measured container width; the
  integration tests simulate it via narrow widths (fitPanels covers
  700px), not a real browser zoom.
- List markers inside the reader rely on the typography plugin; the
  explicit rules are for the editor.

Exact next batch: B21 - Browser parity and derived indexes (JSON backend
in `src/utils/repository.ts`, backup converters in `src/utils/backup.ts`,
project deletion paths, search migrations in `src-tauri/src/repository.rs`;
first reads: `repository.ts` (JSON backend + entityKey/rev maps),
`src/utils/__tests__/repository.test.ts` (both describes),
`src-tauri/src/repository.rs` (FTS triggers, thread_replace_message,
delete paths)).

### B21a - Canonical revision-map keys (part 1 of B21)

Completed: 2026-09-16.

Root causes found while implementing:
- The browser JSON backend wrote `revisions.json` keyed by
  `entityKey(kind, id)` ("text:t1") on create/save/delete, but every
  LIST loader read the map by the BARE id (`revMap[t.id]`). After a
  restart, every entity's revision read as 0: the optimistic-concurrency
  revision was silently lost and a queued save's expectedRev could be
  rejected as stale (or an actually-stale save accepted).
- Legacy browser files keyed by the bare id had no migration path, so the
  values were unreachable even after fixing the reads.

Files changed:
- `src/utils/repository.ts` - `EntityKind` type + exported-in-file
  `revOf(map, kind, id)` (canonical entry wins, legacy bare-id entry is
  honoured until migrated); `withRev` adopts a legacy bare-id entry under
  the canonical key before the staleness check and persists the migration
  with the bump; all four list loaders (texts/projects/sources/threads)
  and the direct reads (`sourceGet`, `threadGet`) now use `revOf`.

Tests:
- `repository.test.ts` +1 (JSON backend): a legacy bare-id
  `revisions.json` is read (list load sets the cached rev to 1), the next
  save adopts it canonically (rev 2), and the persisted file holds
  `text:t1` with the bare key removed.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 545 passed (53 files; +1).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 89 passed, 1 ignored; `cargo check` - OK.

Remaining B21 work (B21b-e) is listed in
`docs/REPAIR-CHECKPOINT-B21A.md`: atomic browser commit/transactional
envelope, legacy history-to-stable-version-id migration checks, deletion
and relink invariants, canonical dataset parity across backends, and the
Rust FTS triggers for stable-ID message replacement.

### B21b-1 - Atomic text commits in the browser backend (part 2 of B21)

Completed: 2026-09-16.

Root cause found while implementing:
- `jsonTextSave` wrote the versions file, the body file, and
  `library.json` as three independent `saveJson` calls. A failure between
  them committed new content with old metadata (or the reverse), and a
  process crash between two writes left the same mixed generation for the
  next launch.

Files changed:
- `src/utils/repository.ts` - a commit-journal envelope in the JSON
  backend: `commitFiles` writes a journal containing the whole batch,
  writes each file, then deletes the journal; on a mid-batch failure it
  restores the captured previous values (deleting files that did not
  exist), and it keeps the journal ONLY when the rollback itself failed —
  then the next reader completes the NEW generation, so the observable
  state is never mixed. `replayPendingCommit` re-applies a leftover
  journal idempotently and is hooked into `readRevs` (every list/save
  path) and `textContent`. `jsonTextSave`'s work is now ONE `commitFiles`
  batch: version snapshot + body + registry entry.

Tests:
- `repository.test.ts` +2 (JSON backend):
  - a one-shot mid-batch failure on the BODY write rolls versions, body,
    and registry back to the complete old generation, leaves no journal,
    and the next save succeeds;
  - a leftover journal (simulated crash after the body landed, before the
    registry) is replayed by the next read (`textsList`) so the new
    generation completes and no mixed state is observable.
- Known nuance (documented in the checkpoint): the failure-target file
  itself cannot always be rolled back while the fault persists; in that
  case the envelope keeps the journal and heals to the NEW generation —
  still atomic, never half-new/half-old.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 547 passed (53 files; +2).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 89 passed, 1 ignored; `cargo check` - OK (no Rust
  change).

Remaining for B21b-2: wire `jsonProjectSave`, `jsonThreadSave`, and
`jsonSourceSave` through the same envelope, and fold the `withRev`
revision write into the batch so a failed save cannot advance the
revision (today the bump persists before `work()`); then the B21c-e
items (see `docs/REPAIR-CHECKPOINT-B21A.md`).

### B21b-2 - Atomic project/thread/source saves (part 3 of B21)

Completed: 2026-09-16.

Root cause (same shape as B21b-1): the browser backend's project, thread,
and source saves wrote their payload file and the registry entry as two
independent writes, and their creates wrote the payload then the registry,
so a failure between them committed half the generation.

Files changed:
- `src/utils/repository.ts` - `jsonProjectSave` (brief + `projects.json`),
  `jsonThreadSave` (messages file + `threads.json`), `sourceSave`
  (`sources.json` + optional passages), and `sourceCreate`
  (passages + `sources.json`) now go through `commitFiles` as ONE
  transaction each. `textCreate` batches body + registry too. The
  remaining single-file creates (project/thread) need no envelope.
  `replayPendingCommit` is now also hooked into `projectBrief` and
  `textVersions`, covering every direct browser read path.

Tests:
- `repository.test.ts` +1 (JSON backend): one test drives a mid-write
  failure (one-shot `localStorage.setItem` throw on the registry key)
  through project, thread, AND source saves, then asserts each entity
  kept its complete old generation (brief + registry, messages +
  registry, passages + metadata) and no journal is left behind.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 548 passed (53 files; +1).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 89 passed, 1 ignored; `cargo check` - OK.

Remaining for B21b-3: fold the `withRev` revision write into the same
batch for every save path (nine call sites; today the revision bump
persists before `work()`, so a failed save still advances the revision
even though the content is rolled back). Then B21c-e.

### B21b-3 - The revision joins the transaction (part 4 of B21)

Completed: 2026-09-16.

Root cause found while implementing:
- `withRev` persisted the revision bump BEFORE `work()` ran (a leftover
  from pre-envelope days). A failed save therefore rolled the content
  back but left the revision advanced, so the next client's expectedRev
  was rejected as stale even though nothing had changed.

Files changed:
- `src/utils/repository.ts` - new `withRevBatched(kind, id, expectedRev,
  exists, work(files))`: the same serialized existence/staleness pass, but
  the bump is NOT persisted alone — the work callback only fills the file
  batch and `revisions.json` is appended to it, so content, metadata, and
  the revision commit as ONE `commitFiles` envelope. `jsonTextSave`,
  `jsonProjectSave`, `jsonThreadSave`, and `sourceSave` now use it.
  The remaining `withRev` callers (`textSnapshot` and the thread message
  operations) keep the old behavior; they are single-file ops pending the
  same migration (B21b-4, optional hardening).

Tests:
- `repository.test.ts` +1 (JSON backend): a failed text save leaves the
  content at v2 AND the revision at 1 (in memory after a reload AND in
  `revisions.json`); the next save advances to 2.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 549 passed (53 files; +1).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 89 passed, 1 ignored; `cargo check` - OK.

Remaining: B21b-4 migrates the remaining `withRev` callers (textSnapshot,
thread append/replace/restore operations) to `withRevBatched`; then B21c
(deletion/relink invariants), B21d (backend dataset parity), B21e (Rust
FTS triggers), B22 (evaluation).

### B21c - Deletion and relink invariants (part 5 of B21)

Completed: 2026-09-16.

Root causes found while implementing:
- `projectDelete` (JSON) cleared each child's `projectId` in the index
  files but did NOT advance the child's revision, so a save carrying the
  pre-deletion metadata (a debounced payload or a stale in-memory meta)
  was accepted at the old revision and wrote the link straight back.
- Sources were never unlinked at all on either backend: a project-linked
  source kept a dangling `projectId`, and the native export validator
  (`requireParent`) rejects exactly that — the whole backup export would
  abort ("Export aborted: the stored dataset failed backup validation").
- The SQLite `project_delete` also did not advance child revisions and
  the TS session cache never learned about the child changes, so the two
  backends disagreed about post-delete revisions.
- No save path validated the incoming project link: both backends wrote
  `meta.projectId` verbatim (`text_save`/`thread_save`/`source_save` and
  `jsonTextSave`/`jsonThreadSave`/`sourceSave`), so any stale client could
  relink a deleted project.

Files changed:
- `src/utils/repository.ts` - `DomainSaver.refresh(id, patch, rev)` +
  `createSaver.refresh` (rewrites a waiting debounced payload in place and
  rebases its revision expectation); `dropProjectLink` and
  `applyUnlinkedChildren(children, savers)` (one shared implementation of
  "advance the session cache + refresh waiting payloads"); new
  `resolveProjectId(currentLink, incomingLink)` inside
  `createJsonRepository` (a persisted link must reference an existing
  project or be absent). JSON `jsonTextSave`, `jsonThreadSave`,
  `sourceSave`, `sourceCreate`, `textCreate`, `threadCreate` sanitize the
  link. JSON `projectDelete` now unlinks texts, threads AND sources in ONE
  `commitFiles` batch together with the revision map; each unlinked child
  advances its revision (canonical key, legacy bare key migrated) and
  waiting payloads are refreshed. SQLite `projectDelete` consumes the
  `AffectedChildWire[]` the backend reports to refresh the session cache
  and waiting payloads. `AffectedChildWire` added; `peekRev`'s `kind`
  parameter widened from `"text"` to `EntityKind` (the B21c tests query
  all kinds; the implementation always accepted them).
- `src-tauri/src/repository.rs` - new `live_project_id(tx, candidate)`
  (inside the caller's transaction): a save or create must reference an
  existing project or store NULL. Applied to `text_save`, `thread_save`,
  `source_save`, `source_create`, `text_create`, `thread_create`.
  `project_delete` now advances `rev` for every unlinked child
  (texts/threads/sources) and returns `Vec<AffectedChildRow>` (new
  serializable struct); `db_project_delete` returns it.

Tests:
- `repository.test.ts` +7 (5 JSON, 2 SQLite):
  - JSON: projectDelete advances child revisions (memory + `revisions.json`)
    and unlinks sources; a queued child save cannot relink a deleted
    project and its content still lands; a direct save with stale metadata
    drops the dead link; a queued save for the deleted project itself fails
    instead of resurrecting it; creates keep live links and drop dead ones.
  - SQLite: `db_project_delete`'s reported child revisions refresh the
    session cache; a queued child save refreshed by the delete sends
    `projectId: null` at the delete's new `expectedRev`.
- `src-tauri/src/repository.rs` +5 Rust lib tests (94 total): the existing
  `project_delete_unlinks_texts_and_threads` now also asserts the revision
  bumps, the source unlink, and the returned affected list; new tests for
  `text_save`, `thread_save`, `source_save`, `source_create`, and the two
  creates dropping dead links while keeping live ones.

Simplification pass (delegated, after the batch was verified): the child
refresh block was duplicated across both backends and the patch lambda
appeared four times - extracted `applyUnlinkedChildren` + `dropProjectLink`
(one policy point). The create-path gap the pass flagged (text/thread
creates could persist a dead link) was closed in both backends. The pass
also verified the remaining `...t` index writes cannot interleave with the
delete's unlink pass.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 556 passed (53 files; +7).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 94 passed, 1 ignored (+5); `cargo check` - OK.

Remaining defects / deliberately unsupported (B21c):
- A child save already IN FLIGHT when the delete lands can be rejected as
  stale (the delete advanced the revision); its payload stays retained and
  the explicit overwrite path rebases it, so content is never lost. Only
  waiting (debounced) payloads are refreshed in place.
- `createSaver.run`'s success handler sets the session revision
  unconditionally, so if an in-flight child save resolves after the
  delete's bump the cache can step back to the pre-delete revision and the
  next pinned save needs the overwrite path. No data-integrity issue; a
  later hardening can make the cache update monotonic.
- Retained failures (failure registry) for unlinked children are not
  proactively rebased; the pinned Retry fails stale until Overwrite is
  used. Same established pattern as other external bumps.
- UI stores (`libraryStore`, `chatStore`, `sourceStore`) keep the stale
  in-memory `projectId` until their next load; persistence is already
  unlinked and the Navigator already tolerates dangling links.
- The JSON brief file is deleted after the registry batch (unchanged from
  before): a crash between the two leaves an orphan brief file, never a
  mixed registry.
- Import/upsert paths (`text_upsert_meta`, `thread_upsert`,
  `source_insert`) intentionally do NOT sanitize: a dump restores exactly
  what it carries. Dump validity belongs to B21d.
- Pre-existing parity nuance (not introduced here): with an omitted
  incoming `projectId`, JSON keeps the persisted link while SQLite stores
  NULL. Normal save flows send the full meta, so this is unreachable today.

Exact next batch: B21e - FTS triggers for stable-ID message replacement
(`search_messages_au` for `thread_replace_message`, a schema-guarded
repairable migration with index rebuild; first reads:
`src-tauri/src/repository.rs` FTS blocks ~633-670 and ~829,
`thread_replace_message`, the migration chain and its repairability tests,
the SQLite search tests in `repository.test.ts`). B21b-4 remains optional
hardening; then B21d (backend dataset parity) and B22 (evaluation).

### B21e - FTS triggers for stable-ID message replacement (part 6 of B21)

Completed: 2026-09-16.

Root causes found while implementing:
- v6 created `search_messages_ai` and `search_messages_ad` but no
  `search_messages_au`, so `thread_replace_message`'s UPDATE of
  `messages.content` left the OLD text searchable and never indexed the
  NEW text.
- The v6 `search_messages_ad` trigger was also over-broad: deleting ONE
  message removed every `search_index` row of that thread, so the
  remaining messages silently stopped matching.
- The index has no message identity (rows are `('thread', thread_id,
  content)`), so both triggers match the affected row by its exact stored
  body; rows with identical bodies are interchangeable for search.

Files changed:
- `src-tauri/src/repository.rs` - new `SCHEMA_V14` (self-sufficient:
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_index` + replaced
  `search_messages_ai`/`search_messages_au`/`search_messages_ad`; the new
  UPDATE trigger removes the replaced body's row and inserts the new
  content, the DELETE trigger removes only the deleted row's body); new
  `migrate_v14` (repairable: replaces the triggers, then re-derives ALL
  message rows from the `messages` table, repairing indexes left stale by
  either bug); `SUPPORTED_SCHEMA_VERSION` 13 -> 14; migration 14 wired
  into `ensure_schema`. No dump-contract change (search_index is derived
  and never exported), so `src/test/backup-contract.json` is untouched.

Tests:
- `src-tauri/src/repository.rs` +2 Rust lib tests (96 total):
  `replaced_message_is_searchable_only_under_its_new_text` (old text
  stops matching, new text matches, a sibling message stays indexed) and
  `deleting_one_message_keeps_the_others_searchable` (single-row delete
  removes exactly its own entry; whole-thread delete still clears
  everything). Both were proven failing against the v13 schema before the
  fix.
- Extended `stranded_partial_migrations_are_repaired` with case (g): a
  fabricated v13 database holding a replaced message indexed under its
  OLD text plus a sibling row lost from the index upgrades to v14 with a
  full re-index; the upgraded database then tracks a new replacement; the
  migration is re-runnable. Also hardened the fixture (real v13 columns)
  and removed a pre-existing flake: `repeated_initialization_is_idempotent`
  reused a temp dir keyed only by pid, so a leftover dir from an earlier
  crashed run with a recycled pid made it import nothing; it now clears
  the directory first (same pattern as the incomplete-migration test).

Commands run and results:
- `npx tsc --noEmit` - OK (no TS change).
- `npm test` - 556 passed (53 files; unchanged).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 96 passed, 1 ignored (+2); `cargo check` - OK.

Remaining defects / deliberately unsupported (B21e):
- Search still returns ONE hit per thread (dedup by `kind`/`doc_id`), so
  a query matching several messages of the same conversation surfaces the
  best-ranked excerpt only; per-message hits would need a message-id
  column in the index (a larger schema change, not required by the
  acceptance).
- The re-index runs on the v14 upgrade only; a database already at v14
  with manually corrupted index rows is not auto-healed (no such path
  exists in the app; FTS rows are derived).
- `thread_replace_message` keeps the whole-thread revision bump; the
  index update rides the same transaction by trigger.

Exact next batch: B21d - canonical dataset parity across backends
(export the same canonical dataset from the JSON and SQLite backends,
including sources/proposals/drafts/preferences; prevent browser restore
from inheriting newer omitted live bodies; round-trip stability. First
reads: `buildBackupBundle`/`restoreBackupBundle` in `src/utils/backup.ts`,
the Rust export/import commands and `check_*` validators in
`src-tauri/src/repository.rs`, `src/test/repository-contract.json` and
`src/test/backup-contract.json`). Then B22; B21b-4 remains optional
hardening.

### B21d - Canonical dataset parity across backends (part 7 of B21)

Completed: 2026-09-16.

Root causes/gaps found while implementing:
- The browser backend exported a legacy v1 FILE bundle (config/settings/
  zen-prices + text/chat/project files) while the desktop exported a v3
  canonical dump. Sources, passages, proposals, and the full preferences
  record (which carries `recovery-drafts`) were absent from a browser
  export entirely, and the browser could not restore a v3 bundle at all
  ("can only be restored there").
- The browser v1 restore wrote only the files the bundle carried: an
  older/smaller bundle left newer live bodies on disk (and in localStorage)
  that the restored indexes no longer referenced.
- Browser preferences were merged on restore; the desktop `db_restore`
  REPLACES the preference table, so an older dump could not clear a newer
  preference key.
- A body row with a null `contentFormat` (but a schema) restored readable
  on desktop (`apply_dump` COALESCEs to markdown/1) but unreadable in the
  browser (`decodeDocumentBody` throws on a missing format).

Files changed:
- `src/utils/repository.ts` - `Repository` gained `exportDump()` (both
  backends: JSON assembles, SQLite returns `db_export`) and
  `replaceDump(dump)` (JSON only: one journal envelope; SQLite rejects
  with a descriptive error because `db_restore` owns the desktop path),
  plus `DatasetCounts`. The commit envelope now supports REMOVALS
  (`commitFiles(files, removePaths)` / journal `{files, removals}` with
  rollback of deleted files). New factory-local helpers: `unionIds`,
  `canonicalBodyShape` (raw-fidelity body projection: explicit nulls are
  preserved for export, legacy both-absent files normalize to markdown/1,
  unknown formats abort loudly, null format/schema heal to markdown/1 like
  `apply_dump`), `assembleBrowserDump` (reads every file, reuses the
  production wire converters `textMetaToWire`/`sourceToWire`/... and
  `toStoredList` so dump rows cannot drift from the wire contract), and
  `dumpReplacement` (dump -> index files + per-entity body/brief/chat/
  source files + `revisions.json`, with every path the dump does not carry
  in `removals`; uses `textMetaFromWire`/`sourceFromWire`/... and
  `storedMessageToRaw`). Null body/version formats restore as markdown/1.
- `src/utils/backup.ts` - `buildBackupBundle` is now backend-agnostic:
  both backends produce ONE canonical v3 bundle (validated dump + full
  credential-free preferences) through the shared `exportCanonicalBundle`;
  the v1 browser file-bundle branch and `V1_STATIC_FILES` are gone.
  `writeRecoverySnapshot` uses the same helper. `restoreBackupBundle`:
  only v2 remains desktop-only; a v3 bundle in the browser now writes its
  recovery snapshot, applies `repo.replaceDump(bundle.data)`, replaces
  preferences, resets session state, and bumps the dataset generation.
- `src/utils/preferences.ts` - new `replacePrefsPrivileged(entries)`
  (browser restore): writes the bundle's keys and REMOVES `dws:pref:` keys
  it omits (matching `db_restore`), with a clear error when localStorage
  fails partway (the recovery snapshot is the way back).
- `src/test/fakeRepository.ts` - throwing stubs for the two new methods
  (the backup suites exercise the REAL backends).

Tests:
- `backup.test.ts` (+7 net, 34 total): browser export includes the
  canonical rows for sources/passages/proposals and the full prefs record
  (drafts); export -> restore -> export is identical; a Rust-generated
  production dump restores in the browser and re-exports the same row
  sets field-for-field; a v3 dump restores in the browser (preferences
  replaced, not merged); an older dump over newer live bodies removes the
  omitted body and version files; same-id content the dump does not carry
  is removed; a null body format heals to markdown v1. The previous
  "rejects a desktop backup" test now asserts the v2 rejection (v2 is the
  legacy desktop-only shape) and a new test covers v3 restore.

Simplification pass (delegated, after the batch was verified): the dump
assembly/replacement now reuses the production wire converters instead of
re-declaring ~140 lines of field mappings; `replaceDump` no longer
repopulates the revision cache (the caller resets it); omitted
threads/sources are removed like texts/projects (no empty-file orphans);
`buildBackupBundle`/`writeRecoverySnapshot` share
`exportCanonicalBundle`; redundant journal replays removed; the pass also
surfaced the null-format restore gap, now fixed and pinned by a test.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 563 passed (53 files; +7).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 96 passed, 1 ignored (no Rust change);
  `cargo check` - OK.
- Dump contract unchanged: `src/test/backup-contract.json` untouched
  (the desktop export is byte-shape identical; the browser now consumes
  and produces it).

Remaining defects / deliberately unsupported (B21d):
- Browser v3 restore is two-phase across preferences (domain envelope,
  then preference replacement); localStorage has no multi-key transaction,
  so a failure between them can leave the domain restored with partially
  applied preferences. The pre-swap recovery snapshot is the way back; the
  desktop commits both in one Rust transaction.
- Browser recovery snapshots accumulate (`dws:pre-restore-*.json`) with no
  pruning, matching the desktop's file snapshots; repeated restores grow
  localStorage until the user removes old keys (a quota failure aborts the
  restore safely before the swap).
- A browser v1 (legacy file bundle) restore still writes files directly
  and does not delete omitted domain files; v1 bundles are only produced
  by old app versions, and the new browser export is v3. The desktop v1
  path (scratch-dir legacy import) is unchanged.
- The browser restore keeps the dump's per-table row order differences
  (order is not part of the canonical contract; parity is asserted as row
  sets).
- B21c's import/upsert non-sanitization stands: a dump restores exactly
  what it carries, and `parseBackupBundle` rejects dangles (the desktop's
  `requireParent` equivalent) before anything is touched.

Exact next batch: B22 - evidence-based evaluation and completion claims
(run IDs/cancel ownership in `src/services/evalHarness.ts`, no scoring of
errors/stopped/truncated responses, older runs must not overwrite newer,
numeric-token matching `1492` vs `11492`, meaning-proxy threshold,
label lexical retention as a proxy, cancellation latency or drop the
claim, regression tests through real production buttons, CI prerequisites
in `.github/workflows/pr-verify.yml`; UI touches use DESIGN.md). B21b-4
(remaining `withRev` call sites) remains optional hardening.

### B22 - Evidence-based evaluation and completion claims (final batch)

Completed: 2026-09-16.

Root causes/gaps found while implementing:
- `runEvaluation` kept SENDING tasks after cancellation (each further
  request returned stopped), and its summary averaged unscored zeros in
  with quality samples — a cancelled or cut-off run could drag the report
  down AND, once the UI set the report, could overwrite a NEWER run's
  result (no run identity or ownership).
- `mean([])` returned 1 (perfect) so a run that scored nothing reported
  100%.
- `scoreMeaning` matched content words as substrings, so "1492" counted
  as preserved inside "11492" (same for terminology in `scoreVoice`); the
  piecewise normalization made `score >= MEANING_GATE` mean a raw
  retention of only ~0.48.
- `perfLog` declared a `cancel-latency` kind that NOTHING recorded, while
  Diagnostics claimed cancellation latency was measured.
- CI (`.github/workflows/pr-verify.yml`) ran the Rust steps on
  ubuntu-latest without Tauri's Linux system libraries, so cargo could
  not compile before any test ran.

Files changed:
- `src/services/evalHarness.ts` - `EvalReport` gained `runId` (unique per
  run), `cancelled`, `scored`, `unscored`; the runner checks
  `signal.aborted` before EACH task (no further scheduling), marks the
  report cancelled, and computes every dimension mean over COMPLETED
  samples only (`mean([]) = 0`). `scoreMeaning` now returns the raw
  retention ratio (the gate genuinely means MEANING_GATE retention) and
  matches numeric tokens whole (`survives`); `scoreVoice` applies the same
  numeric-token rule.
- `src/components/settings/EvalReportView.tsx` - a run-ownership token
  (`runSeq`) so an older run can never overwrite a newer one; a cancelled
  run renders as failed/"partial", never Done; the status line reports
  `scored`/`not scored`; the meaning dimension is labelled "Meaning
  (proxy)" and the intro says lexical retention is a proxy, not a
  semantic verdict; failed tasks expose their actual output (`<details>`)
  so a report is reviewable evidence.
- `src/utils/perfLog.ts` - `markCancelRequested()` +
  `recordCancelLatency(detail?)` (no-op without a marked stop request).
- `src/services/aiOperations.ts` - `abortOperation` marks the stop
  request before aborting.
- `src/services/chatSend.ts` - a stopped send records the measured
  cancel latency from the Stop click to the settle.
- `src/components/workspace/DiagnosticsDialog.tsx` - mean cancel latency
  added to the aggregates; the "Measured, not estimated" claim is now
  backed.
- `.github/workflows/pr-verify.yml` - a Tauri Linux prerequisites step
  (webkit2gtk-4.1, ayatana appindicator, rsvg, xdo, ssl, gtk, patchelf)
  before the Rust steps.

Tests:
- `src/services/__tests__/evalHarness.test.ts` (NEW, 7): 1492 is not
  retained inside 11492; the meaning score IS the ratio and a 50%
  retention fails the 0.6 gate (the old curve passed it); numeric
  terminology matches whole; stopped samples are unscored and excluded
  from the summary; cancellation stops scheduling after 2 calls and marks
  the report cancelled; an all-unscored run reports zeros (never 100%);
  run ids are unique.
- `src/components/__tests__/evalReportView.test.tsx` (NEW, 2): the REAL
  "Run AI evaluation" button produces a report ("6 scored"); and with
  controlled promises, a cancelled run cannot report Done and its late
  completion is discarded while a newer run's report stays (exactly 7
  requests: A's 1 + B's 6 — the cancelled run scheduled no further
  tasks).
- `src/utils/__tests__/perfLog.test.ts` (+1): cancel latency is recorded
  only after a stop request, once per request.
- `src/services/__tests__/chatSendOperations.test.ts` (+1): aborting a
  send through the production path records a `cancel-latency` mark for
  the thread.

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 566 passed (54 files; +11).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 96 passed, 1 ignored (no Rust change);
  `cargo check` - OK.
- `.github/workflows/pr-verify.yml` parses as YAML (js-yaml) with the
  prerequisites step; the workflow itself can only RUN after a push, so
  the run-verification is owned by the user (workflow_dispatch is
  enabled; the agent never pushes).

Remaining defects / deliberately unsupported (B22):
- The evaluation still sends REAL requests (by design); CI does not run
  it.
- The meaning dimension remains a lexical retention proxy; the report
  now says so, but it is not a semantic judge.
- CI's first real run may still surface runner-specific issues beyond
  the system libraries (e.g. cache keys); the commands mirror the local
  gates exactly.
- B21b-4 (migrating the remaining `withRev` call sites to
  `withRevBatched`) remains the only optional hardening item.

Programme status: B21c, B21e, B21d, and B22 are complete; B01-B20c were
complete before this session. All gates are green with the numbers above.
No commits, pushes, version bumps, or releases were made by the agent.

### B21b-4 - The remaining revision batching (optional hardening, completed)

Completed: 2026-09-16 (after B22; closes the last `withRev` call sites).

Root cause/scope: six operations still used the old `withRev` pass, which
persisted the revision bump BEFORE their work and wrote their files one by
one — a failure between the writes could leave the revision advanced with
content only partially written (and `textRestore` wrote three files
non-atomically: snapshot, body, registry).

Files changed:
- `src/utils/repository.ts` - `textRestore`, `threadAppendMessage`,
  `threadRename`, `textSetState`, `threadSetState`, and
  `threadReplaceMessage` now use `withRevBatched`, pushing every file they
  write into ONE `commitFiles` envelope with `revisions.json`. The old
  `withRev` helper had no callers left and was removed (its registry
  adoption/staleness logic lives on in `withRevBatched`). `textSnapshot`
  was already outside the bump contract (a snapshot intentionally does
  not advance the revision) and is unchanged.

Tests:
- `repository.test.ts` +3 (JSON backend), each proven failing before the
  migration:
  - a mid-batch failure during `threadAppendMessage` leaves the chat file,
    `threads.json`, and the revision at the old generation; the next
    append advances cleanly;
  - a failed registry-only `threadRename` leaves the title and revision
    unchanged;
  - a failed `textRestore` keeps the live body, the snapshot history, the
    metadata, and the revision (no half-restored state, no journal left).

Commands run and results:
- `npx tsc --noEmit` - OK.
- `npm test` - 569 passed (54 files; +3).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 96 passed, 1 ignored (no Rust change);
  `cargo check` - OK.

## F-series repair programme (F01-F13)

The batches below repair correctness-affecting defects (F01-F06), hygiene and
hardening (F07-F09), and smaller UI/edge fixes (F10-F13). Branch
`repair-r1-r11`, v0.0.4, native schema v14, backup format v3. Nothing was
committed, pushed, or version-bumped. Baseline gates before F01: tsc OK;
`npm test` 569 passed (54 files); build OK; `cargo test --lib` 96 passed,
1 ignored; `cargo check` OK.

### F01 - Gate save retries behind maintenance

Completed: 2026-09-16.

Root cause: `retrySave` and `resolveSaveFailure(..., "overwrite")` invoked the
retained payload's `run()`/failure closures directly. `run()` is deliberately
NOT maintenance-gated (privileged drains use it), so a Retry/Overwrite clicked
during a delayed restore/export wrote across the barrier.

Files changed:
- `src/utils/repository.ts` - new `resolveRetainedFailure(key, resolution)`:
  rejects with the same "Maintenance in progress: saving is paused." error
  `saveNow`/`flush` use while `maintenanceActive()`, before consulting the
  registry, so the payload stays retained. `discard` is local-only and stays
  allowed. Both backends' `retrySave`/`resolveSaveFailure` now delegate to it
  (was two duplicated copies per backend).
- `src/utils/__tests__/maintenance.test.ts` - F01 regression: a retained
  failure exists, a delayed maintenance task holds the barrier; `retrySave`
  and `resolveSaveFailure(..., "overwrite")` both reject with the maintenance
  error, no transport write is attempted, the failure stays retained and the
  stored generation is untouched; after the barrier ends, Retry commits the
  payload and a fresh failure is resolved by Overwrite.

Failing-test-first evidence: before the fix the regression failed at the
first `rejects.toThrow(/maintenance/i)` (the retry succeeded and cleared the
failure), and the leaked barrier cascaded into the concurrent-maintenance
test - both passed after the fix.

Commands run and results:
- `npx vitest run src/utils/__tests__/maintenance.test.ts src/utils/__tests__/repository.test.ts`
  - 55 passed (F01 regression included).
- `npx tsc --noEmit` - OK.
- `npm test` - 570 passed (54 files; +1).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 96 passed, 1 ignored (no Rust change); `cargo check` - OK.

Known limitations (F01):
- Discard stays available during maintenance by design (it only drops the
  retained in-memory payload; it writes nothing).
- The maintenance lock is per-process; a crash mid-maintenance still relies
  on the JSON backends' commit journal / SQLite transactions for coherence.

### F02 - Replay the commit journal before reading payloads

Completed: 2026-09-16.

Root cause: the JSON backend's `replayPendingCommit()` ran only through
`readRevs`, but `textsList`, `projectsList`, `sourcesList`, `threadsList`,
`sourceGet`, `threadGet`, `proposalsList`, and `search` read their
registry/payload files FIRST. With a leftover journal (crash after the
payload landed, before the registry), the first read returned OLD registry
rows paired with NEW bodies.

Files changed:
- `src/utils/repository.ts` (JSON backend) - `replayPendingCommit()` is now
  awaited at the top of `textsList`, `projectsList`, `sourcesList`,
  `sourceGet`, `proposalsList`, `threadsList`, `threadGet`, and `search`
  (before any file read). `assembleBrowserDump` already replayed through
  `readRevs()`; `textContent`/`textVersions`/`projectBrief` already did.
- `src/utils/__tests__/repository.test.ts` - the existing leftover-journal
  test now asserts `textsList()` itself returns the NEW generation (wordCount
  + updatedAt from the journal, not the stale row); a new test writes a
  leftover journal covering threads + sources and asserts `threadsList`,
  `threadGet`, `sourcesList`, and `sourceGet` all return the new generation
  and the journal is gone.

Failing-test-first evidence: both tests failed against the old code
(`expected undefined to be 9` for the list row; `expected 'Thread' to be
'New thread'` for threadsList), and pass after the fix.

Commands run and results:
- `npx vitest run src/utils/__tests__/repository.test.ts` - 52 passed.
- `npx tsc --noEmit` - OK.
- `npm test` - 571 passed (54 files; +1 new test, 1 extended).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 96 passed, 1 ignored (no Rust change); `cargo check` - OK.

Known limitations (F02):
- Replay happens once at the start of each read; a commit that lands
  concurrently with an in-progress multi-file read is still serialized only
  by the JSON backend's registry queue (unchanged behavior; the journal
  contract makes the next read coherent).
- A pre-existing rollback failure can leave the journal in place by design:
  the next reader completes the NEW generation (never a mixed one).

Exact next batch: F03 - Patchless error drafts must never mask the stored
document.

### F03 - Patchless error drafts must never mask the stored document

Completed: 2026-09-16.

Root cause: when a failed Save had no body to record (a newer edit exists
only inside the debounce window, or `getBody()` threw), `save()` called
`markError(draftKey, message)` with no patch. With no draft record,
`draftStore.markError` fabricated `content: ""` + `meta: null`, and
`draftToBody` treated that as an intentionally emptied markdown document —
an empty body won over the stored manuscript on remount.

Files changed:
- `src/stores/draftStore.ts` - `DraftSession.errorOnly` (optional; legacy
  persisted drafts read as false). `markError` marks a fabricated record
  (no existing draft AND no patch-supplied content) as error-only; it
  preserves an existing body claim otherwise. `setDraft` clears the marker
  whenever a content projection is supplied (even an empty one), so an
  intentional empty is never error-only.
- `src/components/editor/useDocumentSession.ts` - `draftToBody` returns null
  for error-only records; a plain empty draft with no body tag (an emptied
  brief / legacy markdown body) still recovers as empty, while a legacy
  metadata-only draft (meta without a content tag) no longer replaces the
  stored document.
- `src/components/__tests__/saveAcknowledgement.test.tsx` - F03 tests:
  (a) a failed Save whose body read throws keeps the stored manuscript AND
  the error banner on remount (the error record is marked error-only), and
  (b) an intentionally emptied document and an intentionally emptied
  project brief both still recover as empty.

Failing-test-first evidence: before the fix the (a) test failed
(`errorOnly` undefined, and the remount would have shown the fabricated
empty draft); after the fix all three tests pass, and the existing
title-only/failed-untouched-Save/B04-acknowledgement tests are unchanged.

Commands run and results:
- `npx vitest run src/components/__tests__/saveAcknowledgement.test.tsx src/stores/__tests__/draftStore.test.ts`
  - 14 passed.
- `npx tsc --noEmit` - OK.
- `npm test` - 574 passed (54 files; +3).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 96 passed, 1 ignored (no Rust change); `cargo check` - OK.

Known limitations (F03):
- A fabricated error record persisted by an earlier build (no `errorOnly`
  field) is indistinguishable from an intentionally emptied brief draft
  (both `content: ""`, `meta: null`, `error` set); the marker protects
  records created from this build onward.
- Legacy metadata-only drafts (meta without `contentFormat` and empty
  content) now fall back to the stored document instead of recovering an
  empty body; content-carrying legacy drafts are unaffected.

Exact next batch: F04 - Export drains pending preference writes.

### F04 - Export drains pending preference writes

Completed: 2026-09-16.

Root cause: `buildBackupBundle` drained only the domain savers before
reading the dataset; a delayed `setPref` (settings, recovery drafts) could
still be in flight when `getAllPrefs()` ran, so the exported bundle omitted
a value the app reported pending (the restore path already drained both).

Files changed:
- `src/utils/backup.ts` - the export maintenance task now awaits
  `privilegedPreferenceDrain()` (the privileged preference flush) before
  `exportCanonicalBundle` reads `getAllPrefs()`.
- `src/utils/__tests__/backup.test.ts` - `resetPreferenceState()` in the
  suite setup; F04 regression: a desktop export with a held `db_prefs_set`
  waits for the write to land and the bundle contains the pending value
  (before the fix the export resolved with the value missing).

Failing-test-first evidence: the F04 test failed against the old export
(`expected { value: "pending" }, received undefined`); passes after the fix.

Commands run and results:
- `npx vitest run src/utils/__tests__/backup.test.ts` - 35 passed.
- `npx tsc --noEmit` - OK.
- `npm test` - 575 passed (54 files; +1).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 96 passed, 1 ignored (no Rust change); `cargo check` - OK.

Known limitations (F04):
- A preference write that arrives DURING the snapshot is not part of it
  (same established semantics as saves scheduled during an export).
- A retained preference FAILURE makes the export abort (the drain throws),
  matching the restore path; the failure is surfaced by the existing
  preference-failure UI instead of exporting a stale value silently.

Exact next batch: F05 - Adoption/conflict must not destroy unconsumable
fallback copies.

### F05 - Adoption/conflict must not destroy unconsumable fallback copies

Completed: 2026-09-16.

Root cause: `bootstrap.ts` adopted and deleted every `dws:` key as if the
native app could consume it. For paths the Rust legacy importer never reads
(`sources.json`, `proposals.json`, unknown paths) adoption wrote a native
file the app ignores AND removed the only copy; `resolveConflict` imported
nothing for them (the importer ignores the file) yet deleted the chosen
copy after the no-op import verified. The conflict dialog also claimed the
native file was "overwritten" although `resolveConflict("browser")` merges
through the validated import.

Files changed:
- `src/utils/bootstrap.ts` - `isNativelyConsumablePath(path)`: the legacy
  importer's registries + entity files (`library/projects/threads.json`,
  `text_/project_/chat_*.json`) and the settings files the preference
  migration reads. `adoptLegacyDwsKeys` now skips non-consumable paths
  BEFORE any file read or write: the key is kept and reported with the new
  `unimportable` issue kind. `resolveConflict` refuses non-consumable paths
  in both directions (nothing imported, nothing deleted).
- `src/App.tsx` - the browser-winner confirmation now says records are
  MERGED into the current data (the chosen copy wins for the records it
  contains) instead of claiming a wholesale overwrite.
- `src/utils/__tests__/bootstrap.test.ts` - F05 tests: a `dws:sources.json`
  copy with no native file is kept and reported (no native write); a
  `sources.json` native/browser difference is reported as unimportable and
  both resolutions refuse while keeping the copy; a `dws:text_doc1.json`
  copy (importer-consumed) is still adopted.

Failing-test-first evidence: both F05 tests failed against the old code
(the adoption test saw `adopted: 1`, no issue, and the key deleted; the
conflict test saw kind `"conflict"` and a resolvable copy).

Commands run and results:
- `npx vitest run src/utils/__tests__/bootstrap.test.ts` - 15 passed.
- `npx tsc --noEmit` - OK.
- `npm test` - 578 passed (54 files; +3).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 96 passed, 1 ignored (no Rust change); `cargo check` - OK.

Known limitations (F05):
- Settings files remain adoptable/resolvable because the preference
  migration does read them; only files with no native consumer are
  preserved.
- Preserved `dws:` copies still have no in-app viewer; they stay reported
  in the recovery banner and recoverable from a browser session.

Exact next batch: F06 - Make the remaining JSON-backend writes atomic.

### F06 - Make the remaining JSON-backend writes atomic

Completed: 2026-09-16.

Root cause: several JSON-backend mutations wrote outside the commit
envelope: text/thread/source deletes wrote the registry + revisions and
then deleted payload files outside any batch; creates wrote revisions.json
after their content batch; projectDelete deleted the brief file after the
registry batch. A mid-write failure left a mixed generation (registry row
without revision, half-deleted entity, orphaned brief) that a later read
would expose.

Files changed:
- `src/utils/repository.ts` (JSON backend) - all of these now commit through
  `commitFiles` (which supports removals):
  - `textDelete`/`threadDelete`/`sourceDelete`: registry + revision +
    payload removals in ONE envelope.
  - `textCreate`/`projectCreate`/`threadCreate`/`sourceCreate`: the
    revision bump is appended to the same content batch.
  - `projectDelete`: the brief removal joined the registry/unlink batch
    (was a separate `deleteFile` after it).
- `src/utils/__tests__/repository.test.ts` - F06 regressions, each failing
  against the old code: a one-shot mid-write failure during the three
  deletes, during the four creates, and during projectDelete (the brief
  removal fails) leaves the complete OLD generation (registry, payload
  files, revision) and no journal.

Failing-test-first evidence: all three tests failed against the old code
(the delete tests found the registry already mutated, the create tests
found a partial entity + body, the projectDelete test found the project
already gone with the brief orphaned); all pass after the fix.

Commands run and results:
- `npx vitest run src/utils/__tests__/repository.test.ts` - 55 passed.
- `npx tsc --noEmit` - OK.
- `npm test` - 581 passed (54 files; +3).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 96 passed, 1 ignored (no Rust change); `cargo check` - OK.

Known limitations (F06):
- The envelope is a localStorage/JSON-file journal, not a database
  transaction: a crash between the journal write and the file writes is
  healed by the next reader (replay), which is the documented contract.
- Direct `proposalCreate`/`proposalSetStatus` writes remain single-file
  ops (one file; no multi-file generation to split).

MILESTONE F1 COMPLETE: F01-F06 (correctness-affecting defects) are done
with their acceptance tests passing on the real production paths and all
gates green (581 frontend tests / 96 Rust tests). Next: F2 hygiene and
hardening, starting with F07.

Exact next batch: F07 - Bound operation resources and credentials.

### F07 - Bound operation resources and credentials

Completed: 2026-09-16.

Root causes: the retained failed-send registry had no eviction bound and
every record held the prepared request's config verbatim — including the
raw `apiKey`. Rust's cancel tombstone registry (`StreamState::cancel` for
an id that never registers) could accumulate forever.

Files changed:
- `src/services/aiOperations.ts` - `MAX_RETAINED_FAILURES = 20`;
  `rememberFailedSend` re-inserts the record at the newest position and
  evicts the oldest beyond the bound; the retained request's config is
  stored with `apiKey: ""` (the caller's request object is not mutated).
- `src/services/chatSend.ts` - Retry re-resolves the credential from the
  profile's keychain account (`loadCredential(provider, baseUrl)`) before
  sending; when it cannot be resolved (forgotten key, session-only
  credential, unavailable keychain) the retry sets a normal thread error
  and sends nothing. The retained snapshot stays available for a later
  attempt after the key is re-entered.
- `src-tauri/src/lib.rs` - `RequestSlot { token, tombstone_since }`:
  `token_for` adopts a tombstone (clearing the marker) so the
  pre-registration race protection is unchanged; `cancel` cancels a live
  token in place and leaves a tombstone otherwise;
  `prune_cancel_tombstones` drops tombstones older than
  `CANCEL_TOMBSTONE_TTL` (30s) and evicts the oldest beyond
  `MAX_CANCEL_TOMBSTONES` (32); live entries are never evicted.
- Tests: `aiOperations.test.ts` +2 (credential stripping incl. no caller
  mutation; bound/eviction order with refresh-on-remember) and the
  snapshot-identity assertions updated to the new copied shape;
  `chatSendOperations.test.ts` +2 (retry re-resolves K1 from the keychain
  after settings changed; unresolvable credential fails visibly, sends
  nothing, keeps the snapshot); `messageListOperations.test.tsx`'s Retry
  test mocks the keychain read; Rust
  `cancel_tombstones_are_bounded_and_expire` (many unknown cancels stay
  ≤ cap, recent tombstone still pre-cancels its late request, TTL expiry
  drops only the stale one).

Commands run and results:
- `npx vitest run src/services/__tests__/aiOperations.test.ts src/services/__tests__/chatSendOperations.test.ts`
  - 28 passed.
- `npx tsc --noEmit` - OK.
- `npm test` - 584 passed (54 files; +3).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 97 passed, 1 ignored (+1); `cargo check` - OK.

Known limitations (F07):
- Re-resolution needs the key to be present in the keychain. A
  session-only credential (keychain unavailable) cannot be replayed after
  a failure; the retry explains that and keeps the snapshot.
- Eviction is insertion-order based (a refreshed failure moves to the
  newest position); failures for the same conversation are bounded
  globally, not per thread.
- Tombstone TTL is wall-clock `Instant` based; a system clock jump only
  changes retention, never the race-protection semantics.

Exact next batch: F08 - Extend the SSRF address classifier.

### F08 - Extend the SSRF address classifier

Completed: 2026-09-16.

Root cause: `is_blocked_ip` unwrapped only IPv4-mapped (`::ffff:`) IPv6
addresses. IPv4-compatible (`::/96`), 6to4 (`2002::/16`), Teredo
(`2001:0::/32`), and NAT64 (`64:ff9b::/96`) forms also carry IPv4 and
could reach loopback/private networks past the block list.

Files changed:
- `src-tauri/src/lib.rs` - `embedded_ipv4_addrs(v6)`: unwraps mapped,
  compatible, 6to4 (segments 1-2), Teredo (server segments 2-3 AND the
  obfuscated client segments 4-5), and NAT64 well-known-prefix forms;
  `is_blocked_ip` classifies every embedded address with the IPv4 rules
  before the IPv6 ranges. Resolved-address pinning and the
  pre-registration cancel semantics are unchanged.
- Test (renamed `embedded_ipv4_ipv6_addresses_follow_the_ipv4_rules`):
  all embedded forms carrying loopback/private IPv4 (including a Teredo
  address whose SERVER is public but whose CLIENT is loopback) are
  blocked; mapped/6to4/NAT64 forms carrying a public IPv4 and a genuine
  public IPv6 stay allowed.

Failing-test-first evidence: the extended test failed against the old
classifier on `::7f00:1`; passes after the fix.

Commands run and results:
- `cargo test --lib` - 97 passed, 1 ignored.
- `npx tsc --noEmit` - OK (no TS change).
- `npm test` - 584 passed (no TS change).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo check` - OK.

Known limitations (F08):
- 6to4/Teredo are legacy transition mechanisms; the classifier treats the
  embedded IPv4 as the reachable target (the conservative choice). NAT64's
  local-use prefix `64:ff9b:1::/48` is not unwrapped (RFC 8215); only the
  well-known `64:ff9b::/96` is.
- IPv6 transition forms remain subject to the same
  resolve-verify-pin discipline; no behavior change there.

Exact next batch: F09 - Attribute cancel latency per request.

### F09 - Attribute cancel latency per request

Completed: 2026-09-16.

Root cause: `perfLog` kept ONE global `cancelRequestedAt` slot. With
parallel conversations a second Stop overwrote the first marker, and a
record for any operation consumed whatever marker existed (misattributing
or losing the measurement).

Files changed:
- `src/utils/perfLog.ts` - the marker map is keyed by operation/request id
  (`markCancelRequested(key)`); `recordCancelLatency(key, detail)` is
  idempotent per key (the marker is consumed by the first record) and a
  marker past `CANCEL_MARK_TTL_MS` (5 minutes, exported) records nothing;
  marking prunes abandoned markers so a stop that never settles cannot
  accumulate.
- `src/services/aiOperations.ts` - `abortOperation` marks the OPERATION's
  id (not a global slot).
- `src/services/chatSend.ts` - a stopped send records the latency under
  `op.id` with the `send <threadId>` detail.
- `src/utils/__tests__/perfLog.test.ts` - rewritten keyed tests: two
  operations stopped in sequence each record their own latency and no
  cross-attribution; an abandoned marker is never misattributed and
  expires without producing a measurement.
- `DiagnosticsDialog.tsx` needed no change: its aggregate already reads
  every `cancel-latency` mark from the ring with a real count (B22).

Failing-test-first evidence: the new keyed tests failed against the global
slot (a record for `other` consumed the abandoned marker and produced a
mark; two stops overwrote each other); pass after the fix.

Commands run and results:
- `npx vitest run src/utils/__tests__/perfLog.test.ts src/services/__tests__/chatSendOperations.test.ts src/services/__tests__/aiOperations.test.ts`
  - 33 passed.
- `npx tsc --noEmit` - OK.
- `npm test` - 585 passed (54 files; +1).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 97 passed, 1 ignored (no Rust change); `cargo check` - OK.

Known limitations (F09):
- A marker older than the TTL is discarded, so an operation settling after
  five minutes of being stopped reports no latency (by design: a stale
  measurement is worse than none).
- Diagnostics shows mean/count over the current ring (50 marks); no
  per-operation history.

MILESTONE F2 COMPLETE: F07-F09 (hygiene and hardening) are done with their
tests passing and all gates green (585 frontend / 97 Rust). Next: F3
smaller UI/edge fixes, starting with F10.

Exact next batch: F10 - Three UI edge fixes (palette stale hits, footnote
label normalization on load, switchThread phantom empty conversation).

### F10 - Three UI edge fixes

Completed: 2026-09-16.

Root causes:
- CommandPalette kept the previous query's full-text `hits` in state while
  the new query's search was debounced, so stale hits stayed visible and
  activatable.
- The footnote renumbering plugin only ran in `appendTransaction`; the
  INITIAL document was never a transaction, so stored/imported bodies with
  duplicate/stale labels displayed (and could export) that way until the
  first edit.
- `chatStore.switchThread` set `messages: []` + `threadLoaded: true` when
  the requested owner no longer existed, presenting a phantom empty
  loaded conversation under the missing id instead of letting the
  caller's fallback load a real owner.

Files changed:
- `src/components/workspace/CommandPalette.tsx` - hits are stored WITH
  their query (`{ query, results }`), cleared synchronously in the input
  onChange, only appended when the hit query equals the current query,
  and `activate` ignores a search item whose query is no longer current.
- `src/components/editor/footnoteExtension.ts` -
  `footnoteRelabelTransaction(state)` extracted; the plugin's `view` hook
  dispatches it once (no undo entry) when the editor view is created, so
  load-time labels are normalized without an edit; `appendTransaction`
  uses the same helper.
- `src/stores/chatStore.ts` - the not-found branch of `switchThread`
  returns false and leaves the loading state in place (no empty loaded
  conversation); the existing `openDiscussion`/`loadThreads` fallback
  then selects a real owner.
- Tests: `commandPalette.test.tsx` +1 (stale A hit disappears
  synchronously and Enter cannot activate it under the new query);
  `footnote.test.tsx` +1 (a stored doc with labels 7,7 renders as 1,2
  without editing and `nextFootnoteLabel` stays collision-free);
  `chatStore.test.ts` +1 (a switch to a deleted owner returns false, the
  previous messages stay, and `loadThreads` falls back to the surviving
  owner).

Failing-test-first evidence: all three tests failed against the old code
(stale hit still rendered/activated; labels stayed 7,7; the phantom state
was `{}` + loaded) and pass after the fixes.

Commands run and results:
- `npx vitest run src/components/__tests__/commandPalette.test.tsx src/components/__tests__/footnote.test.tsx src/stores/__tests__/chatStore.test.ts`
  - 7 + 8 + 20 passed.
- `npx tsc --noEmit` - OK.
- `npm test` - 588 passed (54 files; +3).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 97 passed, 1 ignored (no Rust change); `cargo check` - OK.

Known limitations (F10):
- Footnote normalization runs after view creation (a microtask), not
  during state construction; a headless editor still normalizes through
  its content-setting transaction (appendTransaction).
- The palette's activation guard is per-render state; a hit from a
  previous query cannot be activated, but a navigator/action item
  matching the new query activates normally.
- `switchThread` leaves `threadLoaded: false` after a not-found; callers
  that do not run the fallback must handle that state (the workspace
  routes all switches through `openDiscussion`, which does).

Exact next batch: F11 - Evaluation and bibliography edges.

### F11 - Evaluation and bibliography edges

Completed: 2026-09-16.

Root causes:
- `runEvaluation` set `cancelled = signal.aborted` AFTER the loop, so an
  abort that arrived after the final task finished still rendered a fully
  scored report as "partial".
- `uniqueCitationKeys` counted BASE keys and returned `base-n` without
  recording the suffixed key as taken, so a later entry whose natural
  base equals an already emitted suffix could reuse it.
- `parseBibEntry` kept a fabricated "Untitled source" title while RIS and
  CSL JSON skip title-less records.

Files changed:
- `src/services/evalHarness.ts` - `abortedEarly` is set only when the
  abort PREVENTED a scheduled task (the loop-break path); a run whose
  tasks all completed reports `cancelled: false`.
- `src/utils/bibliography.ts` - `uniqueCitationKeys` tracks EMITTED keys
  in a set and increments until the candidate is free; `parseBibEntry`
  returns null without a title (`parseBibTeX` skips it), aligning BibTeX
  with RIS/CSL; the module contract now states the shared skip policy.
- Tests: `evalHarness.test.ts` +1 (abort after the final task => complete,
  6 calls, 6 scored); `bibliography.test.ts` +2 (suffix chains never
  reused, emitted keys distinct across BibTeX and CSL JSON; title-less
  BibTeX skipped while the real entry imports, and RIS/CSL agree).

Failing-test-first evidence (verified by temporarily reverting each fix):
the eval test failed with `cancelled: true`; the title-less test failed
importing "Untitled source". The emitted-key test passes before and after
(see limitations).

Commands run and results:
- `npx vitest run src/services/__tests__/evalHarness.test.ts src/utils/__tests__/bibliography.test.ts`
  - 27 passed.
- `npx tsc --noEmit` - OK.
- `npm test` - 591 passed (54 files; +3).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 97 passed, 1 ignored (no Rust change); `cargo check` - OK.

Known limitations (F11):
- The emitted-key collision the old algorithm could theoretically produce
  is not reachable through the current `bibKey`: author words and title
  slugs strip non-alphanumerics, so natural bases never contain the "-"
  separator. The emitted-key set is a hardening (and the test documents
  the invariant); it has no failing-first case.
- An abort DURING the final task still marks the run cancelled (that task
  did not complete); the report lists it as unscored.
- Title-less BibTeX entries are now skipped without a per-entry report;
  the import UI's "no importable records" path covers an all-title-less
  file.

Exact next batch: F12 - Credential hygiene edges.

### F12 - Credential hygiene edges

Completed: 2026-09-16.

Root causes:
- `forgetCredential(profile)` deleted legacy shared/plaintext copies based
  on the ACTIVE profile's in-memory key even when it was forgetting a
  DIFFERENT profile — so forgetting profile B could destroy profile A's
  legacy fallback.
- The one-time legacy migration stripped the plaintext `config.json` after
  a verified write unconditionally, even when the plaintext file held a
  DIFFERENT key than the one migrated (that copy belonged to another
  profile and was destroyed).

Files changed:
- `src/stores/chatStore.ts` - `forgetCredential` computes `sameProfile`
  first and removes legacy copies only inside the same-profile branch (the
  profile being forgotten must be the active one whose secret is known).
  The migration path strips the plaintext file only when
  `plaintext === candidate` (the file actually held the stored key);
  `deleteLegacyKey` is likewise guarded by `legacy === candidate`.
- `src/stores/__tests__/credentialIsolation.test.ts` - F12 tests:
  forgetting a non-active profile leaves the active key AND its legacy
  keychain/plaintext fallbacks intact; migration from the shared keychain
  entry keeps a plaintext file holding a different key.

Failing-test-first evidence (verified by temporarily reverting each
condition): both tests failed against the old code (the legacy entries /
plaintext copy were deleted); pass after the fix. The pre-existing
"different profile leaves the active key alone" test is retained unchanged.

Commands run and results:
- `npx vitest run src/stores/__tests__/credentialIsolation.test.ts` - 18 passed.
- `npx tsc --noEmit` - OK.
- `npm test` - 593 passed (54 files; +2).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 97 passed, 1 ignored (no Rust change); `cargo check` - OK.

Known limitations (F12):
- Forgetting a non-active profile cannot clean up that profile's legacy
  copies (their secret is not in memory); the profile's keychain entry IS
  deleted, so nothing can silently authenticate with it.
- The plaintext migration reads `config.json` only (the only legacy
  plaintext location the app ever wrote).

Exact next batch: F13 - Cleanups and truthful documentation.

### F13 - Cleanups and truthful documentation

Completed: 2026-09-16.

Changes:
- `src/services/chatPrepare.ts` - removed the orphaned
  `preparedInstructionKey` export (zero callers; the instruction key is
  computed by the send path from the stored message). `messageKey` stays
  (used by `resolveInstructionBoundary`).
- `docs/IMPLEMENTATION-PROGRESS.md` - two correction notes added to the
  historical entries (the entries themselves are kept):
  - B10's `collectCitationsFromJson` claim: the function no longer exists;
    B19 replaced it with `collectSourceRefsFromJson` in
    `src/utils/sourceRefs.ts`.
  - B15's `clearFailedSends` claim: no such export exists; the registry is
    cleared by `invalidateAllOperations`/`resetOperations` and bounded by
    `MAX_RETAINED_FAILURES` (F07).
- The per-batch F-series checkpoints (F01-F12 above) were written with the
  real command output of each batch; this entry closes the programme.

Commands run and results (final state):
- `npx tsc --noEmit` - OK.
- `npm test` - 593 passed (54 files).
- `npm run build` - OK (pre-existing chunk-size warning).
- `cargo test --lib` - 97 passed, 1 ignored.
- `cargo check` - OK.

F-SERIES PROGRAMME COMPLETE. F01-F13 are done with their acceptance tests
passing on the real production paths; all gates are green at
593 frontend tests / 97 Rust tests. Baseline before F01 was 569/96.
Nothing was committed, pushed, version-bumped, or released; the branch
`repair-r1-r11` remains uncommitted with all work in the working tree.

Known limitations across the programme (carried forward, each documented
per batch): the F07 retained-failure keychain re-resolution needs a stored
keychain credential; F11's emitted-key collision is unreachable through the
current `bibKey` (documented as hardening); F02's replay is once per read;
F05 preserved `dws:` copies have no in-app viewer beyond the recovery
banner; F09 measurements remain ring-buffer diagnostics; and every deferred
out-of-scope item from the brief (asset store, rich footnote content, fuzzy
palette matching, RIS literal-org round-trip, locale case folding, drawer
focus trap, startup spinner, recovery-snapshot UI link, bulk-export
failure polish, browser v1 legacy restore, snapshot pruning, per-message
search hits, CSS polish) is untouched by design.
