import { invoke } from "@tauri-apps/api/core";
import type {
  IncompleteReason,
  LibraryTextMeta,
  ProjectMeta,
  TextVersion,
  ThreadMeta,
  SourceData,
  SourceMeta,
  SourcePassage,
  DocumentProposal,
} from "@/types";
import { loadJson, saveJson, deleteFile, hasTauriFs } from "@/utils/storage";
import {
  decodeDocumentBody,
  decodeDocumentBodyLenient,
  type DocumentBody,
} from "@/utils/documentCodec";
// Type-only: the canonical dump contract lives with the backup layer; this
// direction is erased at compile time (backup.ts imports this module).
import type {
  CanonicalDump,
  DumpContentFormat,
  DumpSourceRow,
} from "@/utils/backup";

/**
 * The repository layer: all domain persistence (library texts + content +
 * version history, projects + briefs, chat threads + messages) goes through
 * this one typed boundary. Stores hold view state; the repository owns
 * disk consistency.
 *
 * Two backends implement the same interface:
 * - SQLite (via Rust commands) inside the Tauri app — transactional saves,
 *   one consistent snapshot for backups, automatic legacy JSON import.
 * - JSON files (via `storage.ts`) in a plain browser dev session.
 *
 * Save discipline (R2):
 * - Domain saves are one transaction each: a text's metadata + optional
 *   content, a project's metadata + optional brief, a thread's metadata +
 *   brief + messages never land in half-states.
 * - Debounced scheduling may coalesce; explicit saves and flushes resolve
 *   only after the bytes are committed.
 * - Operations on one entity are serialized through per-entity queues and
 *   never start before they enter the queue.
 * - Every entity carries a persisted revision counter; saves are rejected
 *   as stale instead of silently overwriting newer data.
 * - Failed saves keep their payload in a retryable failure registry; the
 *   shutdown/backup drains can see and retry them.
 */

// ──────────────────────────────────────────────
// Wire contract (SQLite backend)
// ──────────────────────────────────────────────
// These are the exact shapes the Rust commands emit and accept: optional
// fields arrive as explicit `null` (domain types model them as absent), and
// reference material travels as `references` (the Rust column is `refs` and
// also reads the legacy `refs` spelling). Every value crossing the boundary
// goes through these converters, so the domain types stay honest.

export interface TextMetaWire {
  id: string;
  title: string;
  textType: string;
  folder: string | null;
  projectId: string | null;
  snippet: string | null;
  wordCount: number | null;
  rev: number;
  /** Navigator organization (D3); serde/legacy defaults false. */
  archived: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMetaWire {
  id: string;
  title: string;
  description: string | null;
  defaultAudience: string | null;
  defaultTone: string | null;
  defaultCitations: string | null;
  defaultLanguage: string | null;
  references: string | null;
  briefWordCount: number | null;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMetaWire {
  id: string;
  title: string;
  mode: string;
  projectId: string | null;
  references: string | null;
  rev: number;
  /** Navigator organization (D3); serde/legacy defaults false. */
  archived: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

function textMetaToWire(meta: LibraryTextMeta, rev: number): TextMetaWire {
  return {
    id: meta.id,
    title: meta.title,
    textType: meta.textType,
    folder: meta.folder ?? null,
    projectId: meta.projectId ?? null,
    snippet: meta.snippet ?? null,
    wordCount: meta.wordCount ?? null,
    rev,
    archived: meta.archived ?? false,
    pinned: meta.pinned ?? false,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

function textMetaFromWire(row: TextMetaWire): LibraryTextMeta {
  return {
    id: row.id,
    title: row.title,
    textType: row.textType as LibraryTextMeta["textType"],
    ...(row.folder != null ? { folder: row.folder } : {}),
    ...(row.projectId != null ? { projectId: row.projectId } : {}),
    ...(row.snippet != null ? { snippet: row.snippet } : {}),
    ...(row.wordCount != null ? { wordCount: row.wordCount } : {}),
    ...(row.archived ? { archived: true } : {}),
    ...(row.pinned ? { pinned: true } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function projectMetaToWire(meta: ProjectMeta, rev: number): ProjectMetaWire {
  return {
    id: meta.id,
    title: meta.title,
    description: meta.description ?? null,
    defaultAudience: meta.defaultAudience ?? null,
    defaultTone: meta.defaultTone ?? null,
    defaultCitations: meta.defaultCitations ?? null,
    defaultLanguage: meta.defaultLanguage ?? null,
    references: meta.references ?? null,
    briefWordCount: meta.briefWordCount ?? null,
    rev,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

function projectMetaFromWire(row: ProjectMetaWire): ProjectMeta {
  return {
    id: row.id,
    title: row.title,
    ...(row.description != null ? { description: row.description } : {}),
    ...(row.defaultAudience != null
      ? { defaultAudience: row.defaultAudience as ProjectMeta["defaultAudience"] }
      : {}),
    ...(row.defaultTone != null
      ? { defaultTone: row.defaultTone as ProjectMeta["defaultTone"] }
      : {}),
    ...(row.defaultCitations != null
      ? {
          defaultCitations: row.defaultCitations as ProjectMeta["defaultCitations"],
        }
      : {}),
    ...(row.defaultLanguage != null
      ? { defaultLanguage: row.defaultLanguage }
      : {}),
    ...(row.references != null ? { references: row.references } : {}),
    ...(row.briefWordCount != null ? { briefWordCount: row.briefWordCount } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function threadMetaToWire(meta: ThreadMeta, rev: number): ThreadMetaWire {
  return {
    id: meta.id,
    title: meta.title,
    // Legacy in-memory rows may predate the required mode.
    mode: meta.mode ?? "text",
    projectId: meta.projectId ?? null,
    references: meta.references ?? null,
    rev,
    archived: meta.archived ?? false,
    pinned: meta.pinned ?? false,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

function threadMetaFromWire(row: ThreadMetaWire): ThreadMeta {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode === "project" ? "project" : "text",
    ...(row.projectId != null ? { projectId: row.projectId } : {}),
    ...(row.references != null ? { references: row.references } : {}),
    ...(row.archived ? { archived: true } : {}),
    ...(row.pinned ? { pinned: true } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Normalize a legacy JSON-backend thread row (mode may be missing). */
function threadMetaFromLegacyJson(row: ThreadMeta): ThreadMeta {
  return {
    ...row,
    mode: row.mode === "project" ? "project" : "text",
  };
}

// ──────────────────────────────────────────────
// Shared row types
// ──────────────────────────────────────────────

/** The versioned document body on the wire (Phase 4.1 contract). */
export interface TextBodyWire {
  content: string;
  contentFormat: string;
  contentSchemaVersion: number;
  plainText: string | null;
}

function bodyToWire(body: DocumentBody): TextBodyWire {
  return {
    content: body.content,
    contentFormat: body.contentFormat,
    contentSchemaVersion: body.contentSchemaVersion,
    plainText: body.plainText,
  };
}

/** A body row as it arrives from Rust (format fields optional on legacy). */
interface BodyRowWire {
  content: string;
  contentFormat?: string | null;
  contentSchemaVersion?: number | null;
  plainText?: string | null;
}

/** A child unlinked by `db_project_delete` (B21c): its new revision. */
interface AffectedChildWire {
  kind: "text" | "thread" | "source";
  id: string;
  rev: number;
}

/** Rows activated by a dataset replacement (B21d). */
export interface DatasetCounts {
  texts: number;
  projects: number;
  threads: number;
  messages: number;
  versions: number;
  sources: number;
  sourcePassages: number;
}

/** The restore result as it arrives from Rust (flat body fields). */
interface RestoreResultWire extends BodyRowWire {
  rev: number;
  savedAt: string;
  snippet: string;
  wordCount: number;
  updatedAt: string;
}

// ── Source wire (Phase 5.1) ──

interface SourceRowWire {
  id: string;
  projectId: string | null;
  title: string;
  author: string | null;
  year: string | null;
  doi: string | null;
  url: string | null;
  language: string | null;
  translation: string | null;
  assetRef: string | null;
  sourceType: string | null;
  containerTitle: string | null;
  publisher: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  abstract: string | null;
  originalText: string;
  contentHash: string;
  extractionStatus: string;
  truncationNote: string | null;
  includedInContext: boolean;
  notes: string | null;
  verification: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

function sourceToWire(meta: SourceMeta, rev: number): SourceRowWire {
  return {
    id: meta.id,
    projectId: meta.projectId ?? null,
    title: meta.title,
    author: meta.author ?? null,
    year: meta.year ?? null,
    doi: meta.doi ?? null,
    url: meta.url ?? null,
    language: meta.language ?? null,
    translation: meta.translation ?? null,
    assetRef: meta.assetRef ?? null,
    sourceType: meta.sourceType ?? null,
    containerTitle: meta.containerTitle ?? null,
    publisher: meta.publisher ?? null,
    volume: meta.volume ?? null,
    issue: meta.issue ?? null,
    pages: meta.pages ?? null,
    abstract: meta.abstract ?? null,
    originalText: meta.originalText,
    contentHash: meta.contentHash,
    extractionStatus: meta.extractionStatus,
    truncationNote: meta.truncationNote ?? null,
    includedInContext: meta.includedInContext,
    notes: meta.notes ?? null,
    verification: meta.verification,
    rev,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

function sourceFromWire(row: SourceRowWire): SourceMeta {
  return {
    id: row.id,
    ...(row.projectId != null ? { projectId: row.projectId } : {}),
    title: row.title,
    ...(row.author != null ? { author: row.author } : {}),
    ...(row.year != null ? { year: row.year } : {}),
    ...(row.doi != null ? { doi: row.doi } : {}),
    ...(row.url != null ? { url: row.url } : {}),
    ...(row.language != null ? { language: row.language } : {}),
    ...(row.translation != null ? { translation: row.translation } : {}),
    ...(row.assetRef != null ? { assetRef: row.assetRef } : {}),
    ...(row.sourceType != null ? { sourceType: row.sourceType } : {}),
    ...(row.containerTitle != null ? { containerTitle: row.containerTitle } : {}),
    ...(row.publisher != null ? { publisher: row.publisher } : {}),
    ...(row.volume != null ? { volume: row.volume } : {}),
    ...(row.issue != null ? { issue: row.issue } : {}),
    ...(row.pages != null ? { pages: row.pages } : {}),
    ...(row.abstract != null ? { abstract: row.abstract } : {}),
    originalText: row.originalText,
    contentHash: row.contentHash,
    extractionStatus: row.extractionStatus as SourceMeta["extractionStatus"],
    ...(row.truncationNote != null ? { truncationNote: row.truncationNote } : {}),
    includedInContext: row.includedInContext,
    ...(row.notes != null ? { notes: row.notes } : {}),
    verification: row.verification as SourceMeta["verification"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface SourceDataWire {
  source: SourceRowWire;
  passages: { id: string; locator: string | null; content: string }[];
  rev: number;
}

function sourceDataFromWire(data: SourceDataWire): SourceData {
  return {
    source: sourceFromWire(data.source),
    passages: data.passages.map((p) => ({
      id: p.id,
      ...(p.locator != null ? { locator: p.locator } : {}),
      content: p.content,
    })),
    rev: data.rev,
  };
}

/** Strict decode for the CURRENT document being opened: an unknown format
 * or a newer schema version fails visibly (content stays untouched). */
function bodyFromWire(row: BodyRowWire): DocumentBody {
  const decoded = decodeDocumentBody(row);
  if (decoded === null) {
    throw new Error("The stored document body is missing its content.");
  }
  return decoded;
}

/** Lenient decode for history listings: unsupported bodies degrade to
 * preserved markdown instead of breaking the list. */
function versionBodyFromWire(row: BodyRowWire): DocumentBody {
  const decoded = decodeDocumentBodyLenient(row);
  if (decoded === null) {
    throw new Error("The stored document body is missing its content.");
  }
  return decoded;
}

/** A chat message as persisted: attachments serialized as JSON. */
export interface StoredMessage {
  /** Stable message identity (null for pre-v5 rows; the store migrates
   * by assigning ids on load). */
  id: string | null;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  failed: boolean;
  /** Incompleteness of an assistant reply (B16b): the partial is stored
   * with its marker so the UI can say why it is partial. */
  incomplete: IncompleteReason | null;
  attachmentsJson: string | null;
}

/** One domain-level save of a library text (metadata + optional content). */
export interface TextSaveArgs {
  meta: LibraryTextMeta;
  /** When present, body and metadata commit in the same transaction.
   * Whether the replaced body is snapshotted is decided inside the
   * transaction by comparing persisted content — not by the caller. */
  content?: DocumentBody;
}

/** What a version restore produced (body resolved inside the backend). */
export interface TextRestoreResult {
  rev: number;
  /** Snapshot time of the restored version (unchanged from history). */
  savedAt: string;
  /** The restored document body (format fields included). */
  body: DocumentBody;
  snippet: string;
  wordCount: number;
  /** The updatedAt written to the metadata row. */
  updatedAt: string;
}

/** One domain-level save of a project (metadata + optional brief). */
export interface ProjectSaveArgs {
  meta: ProjectMeta;
  brief?: string;
}

/** One domain-level save of a whole thread (metadata + brief + messages). */
export interface ThreadSaveArgs {
  meta: ThreadMeta;
  briefJson: string | null;
  messages: StoredMessage[];
}

/** A thread's messages + writing brief as persisted. */
export interface ThreadData {
  briefJson: string | null;
  messages: StoredMessage[];
  /** Current revision of the thread (for optimistic-concurrency checks). */
  rev: number;
}

/** Why a persisted save failed. */
export type SaveFailureKind = "error" | "stale" | "missing";

/**
 * A save that failed after exhausting its scheduled attempt. The payload
 * stays retained (`retry`) until it is retried successfully or the entity
 * is deleted; drains surface these to the user.
 */
export interface SaveFailure {
  /** Entity key: `text:<id>` | `project:<id>` | `thread:<id>`. */
  key: string;
  kind: SaveFailureKind;
  message: string;
  failedAt: string;
  /** Re-attempt the retained payload with its ORIGINAL revision check. */
  retry: () => Promise<void>;
  /** Explicit conflict resolution: rebase the retained payload onto the
   * CURRENT persisted revision and write it (the user chose to overwrite). */
  overwrite: () => Promise<void>;
  /** Throw the retained payload away (explicit user choice). */
  discard: () => void;
}

/** One full-text search hit (documents, briefs, conversations). */
export interface SearchHit {
  kind: "text" | "project" | "thread";
  docId: string;
  title: string;
  excerpt: string;
}

export interface Repository {
  /** Wait until every queued operation has fully settled. */
  idle(): Promise<void>;
  /** Full-text search across documents, briefs, and conversations. */
  search(query: string): Promise<SearchHit[]>;
  /** Write all pending debounced saves immediately; rejects on failure. */
  flushTextSaves(): Promise<void>;
  flushProjectSaves(): Promise<void>;
  flushThreadSaves(): Promise<void>;
  /** Drain: flush AND fail visibly while earlier writes are retained. */
  drainTextSaves(): Promise<void>;
  drainProjectSaves(): Promise<void>;
  drainThreadSaves(): Promise<void>;

  // Library texts
  textsList(): Promise<LibraryTextMeta[]>;
  textCreate(meta: LibraryTextMeta, body: DocumentBody): Promise<void>;
  /** Schedule a debounced metadata+content save for the text. */
  textScheduleSave(id: string, args: TextSaveArgs): void;
  /** Persist metadata (+ optional content) in one transaction; new revision. */
  textSave(id: string, args: TextSaveArgs): Promise<number>;
  /** Null when the text has no stored content. */
  textContent(id: string): Promise<DocumentBody | null>;
  textVersions(id: string): Promise<TextVersion[]>;
  /**
   * Restore a version atomically: the backend resolves the target content
   * by its stable `versionId`, snapshots the replaced current content, and
   * commits everything in one transaction. Restoring flushes the text's
   * pending save first.
   */
  textRestore(id: string, versionId: string): Promise<TextRestoreResult>;
  /** Take a user-named snapshot of the current content; new version id. */
  textSnapshot(id: string, label: string, now: string): Promise<string>;
  textDelete(id: string): Promise<void>;

  // Projects
  projectsList(): Promise<ProjectMeta[]>;
  projectCreate(meta: ProjectMeta): Promise<void>;
  /** Schedule a debounced metadata+brief save for the project. */
  projectScheduleSave(id: string, args: ProjectSaveArgs): void;
  /** Persist metadata (+ optional brief) in one transaction; new revision. */
  projectSave(id: string, args: ProjectSaveArgs): Promise<number>;
  /** Null when the project has no stored brief. */
  projectBrief(id: string): Promise<string | null>;
  projectDelete(id: string): Promise<void>;

  // Sources (Phase 5.1)
  sourcesList(): Promise<SourceMeta[]>;
  /** Null when the source does not exist. */
  sourceGet(id: string): Promise<SourceData | null>;
  /** Create (INSERT-only). Rejects duplicate content identity. */
  sourceCreate(source: SourceMeta, passages: SourcePassage[]): Promise<void>;
  /** Persist row + passages in one transaction; new revision.
   * `passages` OMITTED = metadata-only save (stored passages unchanged);
   * an explicit list (including []) intentionally replaces them. */
  sourceSave(id: string, source: SourceMeta, passages?: SourcePassage[]): Promise<number>;
  sourceDelete(id: string): Promise<void>;

  // Reviewable revision proposals (Phase 5.3)
  proposalsList(documentId: string): Promise<DocumentProposal[]>;
  proposalCreate(proposal: DocumentProposal): Promise<void>;
  proposalSetStatus(id: string, status: DocumentProposal["status"]): Promise<void>;
  /** The cached revision for an entity key ("text:<id>"), or null. */
  peekRev(kind: EntityKind, id: string): number | null;

  /**
   * B21d: the canonical raw dump of the current dataset, validated by the
   * backup layer before it is written. The JSON backend assembles it from
   * its files (replaying a pending commit first); the SQLite backend
   * returns `db_export`.
   */
  exportDump(): Promise<unknown>;
  /**
   * B21d: replace the whole dataset with a canonical dump. JSON backend
   * only — the desktop restores through `db_restore`, where domain rows
   * and preferences commit in the same transaction. Every file the new
   * generation does not carry is removed through the commit envelope.
   */
  replaceDump(dump: unknown): Promise<DatasetCounts>;

  // Threads
  threadsList(): Promise<ThreadMeta[]>;
  threadCreate(meta: ThreadMeta): Promise<void>;
  /** Null when the thread does not exist. */
  threadGet(id: string): Promise<ThreadData | null>;
  /** Schedule a debounced whole-thread save (metadata + brief + messages). */
  threadScheduleSave(id: string, args: ThreadSaveArgs): void;
  /** Persist metadata + brief + messages in one transaction; new revision. */
  threadSave(id: string, args: ThreadSaveArgs): Promise<number>;
  /** Append one message atomically (flushes the thread's pending save first). */
  threadAppendMessage(
    id: string,
    message: StoredMessage,
    updatedAt: string,
  ): Promise<void>;
  /** Replace one message's content by its stable id (regeneration). The
   * `incomplete` marker travels with the content (null clears it). */
  threadReplaceMessage(
    id: string,
    messageId: string,
    content: string,
    incomplete: IncompleteReason | null,
    updatedAt: string,
  ): Promise<void>;
  /** Rename a thread (metadata-only; safe for unloaded threads). */
  threadRename(id: string, title: string, updatedAt: string): Promise<void>;
  /** Set navigator organization flags on a text (D3): metadata-only,
   * revision-checked; unmentioned fields keep their values. */
  textSetState(
    id: string,
    patch: { archived?: boolean; pinned?: boolean },
    updatedAt: string,
  ): Promise<void>;
  /** Set navigator organization flags on a thread (D3). */
  threadSetState(
    id: string,
    patch: { archived?: boolean; pinned?: boolean },
    updatedAt: string,
  ): Promise<void>;
  threadDelete(id: string): Promise<void>;

  // Save-state observability (acknowledgment & retry)
  /** Failures from scheduled saves that have not been retried yet. */
  saveFailures(): SaveFailure[];
  /** Re-attempt a retained failure's payload (same revision expectation). */
  retrySave(key: string): Promise<void>;
  /** Explicit resolution of a retained failure: overwrite the current
   * revision with the retained payload, or discard it. */
  resolveSaveFailure(
    key: string,
    resolution: "overwrite" | "discard",
  ): Promise<void>;
  /** Waiting / in-flight / retained-failure write counts. */
  saveState(): { scheduled: number; inFlight: number; failed: number };
  /** Subscribe to save-state changes (scheduled/in-flight/failed). */
  subscribeSaveState(listener: () => void): () => void;
  /** Drop cached revisions + failure registry (after a backup restore). */
  resetSessionState(): void;
}

// ──────────────────────────────────────────────
// Transport seam (failure/delay injection for tests)
// ──────────────────────────────────────────────

type TransportOp<T> = () => Promise<T>;

let transportInterceptor:
  | ((op: TransportOp<unknown>) => Promise<unknown>)
  | null = null;

/**
 * Test seam: intercept every repository transport operation. The interceptor
 * receives a thunk that has NOT started yet, so tests can delay or reject
 * it. Passing null restores direct transport.
 */
export function setTransportInterceptor(
  fn: ((op: TransportOp<unknown>) => Promise<unknown>) | null,
): void {
  transportInterceptor = fn;
}

function transport<T>(op: TransportOp<T>): Promise<T> {
  if (!transportInterceptor) return op();
  return transportInterceptor(op as TransportOp<unknown>) as Promise<T>;
}

// ──────────────────────────────────────────────
// In-flight tracking (for shutdown drains)
// ──────────────────────────────────────────────

let tail: Promise<unknown> = Promise.resolve();

/** Register a promise as repository work so `repoIdle` can await it. */
function track<R>(p: Promise<R>): Promise<R> {
  const settled = tail
    .then(
      () => p,
      () => p,
    )
    .then(
      () => undefined,
      () => undefined,
    );
  tail = settled;
  return p;
}

export async function repoIdle(): Promise<void> {
  let last = tail;
  for (;;) {
    await last;
    if (tail === last) return;
    last = tail;
  }
}

// ──────────────────────────────────────────────
// Per-entity operation queue
// ──────────────────────────────────────────────

const entityQueues = new Map<string, Promise<unknown>>();

/**
 * Run `op` after every previously enqueued operation for the same entity
 * key has settled. The op is invoked only when it reaches the head of the
 * queue — never before. Rejections propagate to the caller.
 */
function enqueue<T>(key: string, op: () => Promise<T>): Promise<T> {
  const tail = entityQueues.get(key) ?? Promise.resolve();
  const run = track(tail.then(op, op)) as Promise<T>;
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  entityQueues.set(key, settled);
  void settled.then(() => {
    if (entityQueues.get(key) === settled) entityQueues.delete(key);
  });
  return run;
}

// ──────────────────────────────────────────────
// Revision cache (optimistic concurrency)
// ──────────────────────────────────────────────

/** Known persisted revisions, keyed by entity key. */
const revs = new Map<string, number>();

type EntityKind = "text" | "project" | "thread" | "source";

function entityKey(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * The persisted revision for one entity (B21): the canonical
 * `entityKey(kind, id)` entry wins; a legacy bare-id entry (older builds
 * keyed the map by the raw id) is still honoured until it is migrated.
 */
function revOf(map: Record<string, number>, kind: EntityKind, id: string): number {
  return map[entityKey(kind, id)] ?? map[id] ?? 0;
}

function classifyFailure(err: unknown): SaveFailureKind {
  const message = err instanceof Error ? err.message : String(err);
  if (/stale revision/i.test(message)) return "stale";
  if (/not found/i.test(message)) return "missing";
  return "error";
}

// ──────────────────────────────────────────────
// Failure registry (retryable retained payloads)
// ──────────────────────────────────────────────

const failureRegistry = new Map<string, SaveFailure>();
const saveStateListeners = new Set<() => void>();

function notifySaveState(): void {
  for (const listener of saveStateListeners) listener();
}

function recordFailure(
  key: string,
  err: unknown,
  retry: () => Promise<void>,
  overwrite: () => Promise<void>,
): void {
  failureRegistry.set(key, {
    key,
    kind: classifyFailure(err),
    message: err instanceof Error ? err.message : String(err),
    failedAt: new Date().toISOString(),
    // Retry re-attempts the RETAINED revision: a stale payload is never
    // silently rebased onto newer persisted content (that is what the
    // explicit `overwrite` resolution is for).
    retry,
    overwrite,
    discard: () => clearFailure(key),
  });
  notifySaveState();
}

function clearFailure(key: string): void {
  if (failureRegistry.delete(key)) notifySaveState();
}

/**
 * Resolve a retained failure: retry/overwrite write through the transport,
 * so they must respect the maintenance barrier exactly like
 * `saveNow`/`flush` do — a Retry/Overwrite clicked during a delayed
 * restore or export must not write across the boundary. Discard is
 * local-only and stays allowed. The payload stays retained on rejection.
 */
function resolveRetainedFailure(
  key: string,
  resolution: "retry" | "overwrite" | "discard",
): Promise<void> {
  if (resolution !== "discard" && maintenanceActive()) {
    return Promise.reject(
      new Error("Maintenance in progress: saving is paused."),
    );
  }
  const failure = failureRegistry.get(key);
  if (!failure) return Promise.resolve();
  if (resolution === "discard") {
    failure.discard();
    return Promise.resolve();
  }
  return resolution === "retry" ? failure.retry() : failure.overwrite();
}

/** Retained failures belonging to one entity kind (`text:`, `project:`, …). */
function failuresOfKind(kind: string): SaveFailure[] {
  return [...failureRegistry.values()].filter((f) =>
    f.key.startsWith(`${kind}:`),
  );
}

/** Writes currently executing their transport operation. */
let inFlightCount = 0;

// ──────────────────────────────────────────────
// Maintenance barrier (export / restore / shutdown)
// ──────────────────────────────────────────────

let maintenanceDepth = 0;
const heldSchedules: Array<() => void> = [];
/** Serializes concurrent maintenance requests (export vs restore). */
let maintenanceChain: Promise<void> = Promise.resolve();
/** Internal drains registered by the active backend's savers. */
const privilegedDrains: Array<() => Promise<void>> = [];

/**
 * Block new persistence while maintenance (export, restore, shutdown)
 * runs: scheduled saves are HELD until the barrier ends, explicit saves
 * and flushes are rejected. Restores end the barrier in "discard" mode so
 * pre-restore state can never land after the swap.
 */
export function beginMaintenance(): void {
  maintenanceDepth++;
}

/**
 * End the barrier. `release` re-schedules what was held (export);
 * `discard` throws held pre-restore state away (restore).
 */
export function endMaintenance(mode: "release" | "discard"): void {
  maintenanceDepth = Math.max(0, maintenanceDepth - 1);
  if (maintenanceDepth > 0) return;
  const held = [...heldSchedules];
  heldSchedules.length = 0;
  if (mode === "release") {
    for (const re of held) re();
  }
}

function maintenanceActive(): boolean {
  return maintenanceDepth > 0;
}

/**
 * Every ordinary mutation family, gated by the maintenance barrier: no
 * create, delete, update, source, or proposal write may cross a delayed
 * restore boundary. Scheduled saves are NOT listed — they are held and
 * released/discarded with the barrier.
 */
const GATED_MUTATIONS = [
  "textCreate",
  "textSave",
  "textDelete",
  "textSnapshot",
  "textRestore",
  "projectCreate",
  "projectSave",
  "projectDelete",
  "threadCreate",
  "threadSave",
  "threadAppendMessage",
  "threadReplaceMessage",
  "threadRename",
  "threadDelete",
  "textSetState",
  "threadSetState",
  "sourceCreate",
  "sourceSave",
  "sourceDelete",
  "proposalCreate",
  "proposalSetStatus",
] as const;

/** Reject gated mutations while the barrier is up (single choke point). */
function gateMutations(repo: Repository): Repository {
  for (const name of GATED_MUTATIONS) {
    const original = repo[name] as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    (repo as unknown as Record<string, unknown>)[name] = (
      ...args: unknown[]
    ) => {
      if (maintenanceActive()) {
        return Promise.reject(
          new Error(`${name} is paused while maintenance is in progress.`),
        );
      }
      return original.apply(repo, args);
    };
  }
  return repo;
}

/**
 * The ONE exclusive maintenance entry point. Requests serialize (an
 * export waits for a restore and vice versa); the barrier goes up BEFORE
 * the task runs so no ordinary mutation can cross the boundary, and the
 * task can still drain pending/in-flight writes through
 * `privilegedDrain()`.
 */
export async function runExclusiveMaintenance<T>(
  mode: "release" | "discard",
  task: () => Promise<T>,
): Promise<T> {
  const previous = maintenanceChain;
  let releaseChain: () => void = () => {};
  maintenanceChain = new Promise<void>((resolve) => {
    releaseChain = resolve;
  });
  // Enter the barrier SYNCHRONOUSLY: no mutation can slip in between the
  // caller's request and the lock. If an earlier maintenance still holds
  // the barrier, the depth keeps ordinary writes blocked until BOTH end.
  beginMaintenance();
  try {
    await previous;
    const result = await task();
    endMaintenance(mode);
    releaseChain();
    return result;
  } catch (err) {
    // A FAILED maintenance task must not drop held work: pre-restore
    // writes stay recoverable instead of being discarded.
    endMaintenance("release");
    releaseChain();
    throw err;
  }
}

/**
 * Drain pending/in-flight DOMAIN writes while the barrier is up. Used by
 * the maintenance task itself (recovery snapshots must include the newest
 * pending work) — ordinary callers are rejected by `flush`.
 */
export async function privilegedDrain(): Promise<void> {
  for (const drain of privilegedDrains) {
    await drain();
  }
  await repoIdle();
}

// ──────────────────────────────────────────────
// Domain saver (schedule / explicit save / flush / retry)
// ──────────────────────────────────────────────

/** Counters of every saver's waiting payloads (status readout). */
const saverPendingCounts: Array<() => number> = [];

/**
 * What the persistence layer is doing right now: writes waiting on their
 * debounce, writes in flight, and retained failures. The workspace status
 * bar reads this instead of guessing from drafts alone.
 */
export function repositorySaveState(): {
  scheduled: number;
  inFlight: number;
  failed: number;
} {
  return {
    scheduled:
      saverPendingCounts.reduce((sum, count) => sum + count(), 0) +
      heldSchedules.length,
    inFlight: inFlightCount,
    failed: failureRegistry.size,
  };
}

interface DomainSaver<A> {
  /** Debounce-coalesce a save for the entity. */
  schedule(id: string, args: A): void;
  /** Save immediately (merges and cancels the entity's pending save). */
  saveNow(id: string, args: A): Promise<number>;
  /** Write every pending scheduled save; rejects on the first failure. */
  flush(): Promise<void>;
  /** Flush AND fail visibly when earlier writes are still retained. */
  drain(): Promise<void>;
  /** Flush ignoring the maintenance barrier (internal to maintenance). */
  flushInternal(): Promise<void>;
  /** Drop the entity's pending debounced save (e.g. before a delete). */
  cancel(id: string): void;
  /**
   * B21c: rewrite a waiting payload in place after a repository-level
   * relationship change (e.g. a project deletion unlinked this entity)
   * and rebase its revision expectation onto `rev`, so the debounced
   * write lands its content without resurrecting the removed link.
   * No-op when the entity has no waiting payload.
   */
  refresh(id: string, patch: (args: A) => A, rev: number): void;
}

function createSaver<A>(
  kind: "text" | "project" | "thread",
  delay: number,
  persist: (id: string, args: A, expectedRev: number | null) => Promise<number>,
  /**
   * Compose a pending payload with a newer one. Omitted optional fields
   * mean "keep the pending value" — never "cancel the pending write".
   */
  merge: (pendingArgs: A, incomingArgs: A) => A,
): DomainSaver<A> {
  const pending = new Map<
    string,
    { args: A; expectedRev: number | null; timer?: ReturnType<typeof setTimeout> }
  >();
  /** Last revision committed BY THIS SAVER (sequential local writes). */
  const ownRev = new Map<string, number>();
  saverPendingCounts.push(() => pending.size);
  privilegedDrains.push(() => saver.flushInternal());

  const run = (id: string, args: A, expectedRev: number | null): Promise<number> => {
    const key = entityKey(kind, id);
    return enqueue(key, () => {
      // A queued write may find the revision advanced by OUR OWN earlier
      // queued write (sequential local edits): adopt it so the queue can
      // drain. An advance that did NOT come from this saver keeps the
      // pinned expectation — the backend rejects it as stale.
      let expected = expectedRev;
      const current = revs.get(key);
      if (
        expected != null &&
        current != null &&
        current !== expected &&
        ownRev.get(key) === current
      ) {
        expected = current;
      }
      inFlightCount++;
      notifySaveState();
      return transport(() => persist(id, args, expected)).finally(() => {
        inFlightCount--;
        notifySaveState();
      });
    })
      .then((newRev) => {
        revs.set(key, newRev);
        ownRev.set(key, newRev);
        clearFailure(key);
        return newRev;
      })
      .catch((err) => {
        recordFailure(
          key,
          err,
          // Pinned retry: same revision expectation.
          () => run(id, args, expectedRev).then(() => undefined),
          // Explicit overwrite: rebase onto the current revision.
          () => run(id, args, revs.get(key) ?? null).then(() => undefined),
        );
        throw err;
      });
  };

  const saver: DomainSaver<A> = {
    schedule(id, args) {
      if (maintenanceActive()) {
        // Held until the barrier ends; the restore path discards them.
        heldSchedules.push(() => saver.schedule(id, args));
        return;
      }
      const key = entityKey(kind, id);
      const existing = pending.get(id);
      const entry: {
        args: A;
        expectedRev: number | null;
        timer?: ReturnType<typeof setTimeout>;
      } = {
        // Partial updates compose: a metadata save while a body save is
        // pending preserves the body (and vice versa).
        args: existing ? merge(existing.args, args) : args,
        // The revision expectation is pinned when the first pending write
        // was scheduled — later local advancement is adopted at run time.
        expectedRev: existing
          ? existing.expectedRev
          : (revs.get(key) ?? null),
      };
      if (existing?.timer) clearTimeout(existing.timer);
      pending.set(id, entry);
      notifySaveState();
      entry.timer = setTimeout(() => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        notifySaveState();
        // A timer-fired failure is recorded in the failure registry (with
        // its retained payload); it must not become an unhandled rejection.
        void run(id, p.args, p.expectedRev).catch(() => {});
      }, delay);
    },
    saveNow(id, args) {
      if (maintenanceActive()) {
        return Promise.reject(
          new Error("Maintenance in progress: saving is paused."),
        );
      }
      const existing = pending.get(id);
      if (existing?.timer) clearTimeout(existing.timer);
      pending.delete(id);
      notifySaveState();
      // The explicit save must not DROP a pending body/brief: compose.
      const merged = existing ? merge(existing.args, args) : args;
      const key = entityKey(kind, id);
      return run(
        id,
        merged,
        existing ? existing.expectedRev : (revs.get(key) ?? null),
      );
    },
    async flush() {
      if (maintenanceActive()) {
        throw new Error("Maintenance in progress: saving is paused.");
      }
      await saver.flushInternal();
    },
    async flushInternal() {
      // Detach the COMPLETE batch first and cancel every timer
      // synchronously: a timer firing mid-flush would otherwise run its
      // entry a second time. Entries scheduled AFTER the detach stay in
      // `pending` and are never touched by this flush.
      const batch = [...pending.entries()];
      pending.clear();
      notifySaveState();
      for (const [, entry] of batch) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      let firstError: unknown = null;
      for (const [id, entry] of batch) {
        try {
          await run(id, entry.args, entry.expectedRev);
        } catch (err) {
          // The payload stays retained in the failure registry.
          firstError ??= err;
        }
      }
      if (firstError !== null) throw firstError;
    },
    async drain() {
      await saver.flush();
      // Retained failures from earlier timer runs are part of the drain:
      // the caller must see them instead of a success report.
      const retained = failuresOfKind(kind);
      if (retained.length > 0) {
        const first = retained[0];
        throw new Error(
          `${retained.length} earlier ${kind} save${
            retained.length === 1 ? "" : "s"
          } failed and ${retained.length === 1 ? "is" : "are"} still retained: ${
            first.message
          }`,
        );
      }
    },
    cancel(id) {
      const existing = pending.get(id);
      if (existing?.timer) clearTimeout(existing.timer);
      if (pending.delete(id)) notifySaveState();
    },
    refresh(id, patch, rev) {
      const entry = pending.get(id);
      if (!entry) return;
      entry.args = patch(entry.args);
      entry.expectedRev = rev;
    },
  };
  return saver;
}

/** Clear a pending payload's project link (B21c). */
function dropProjectLink<A extends { meta: { projectId?: string } }>(args: A): A {
  return { ...args, meta: { ...args.meta, projectId: undefined } };
}

/**
 * B21c: apply a project deletion's unlink result. The session revision
 * cache advances (the relationship change is a metadata change) and any
 * waiting payload for the child is rewritten in place, so a debounced
 * save lands its content without resurrecting the removed link.
 */
function applyUnlinkedChildren(
  children: { kind: EntityKind; id: string; rev: number }[],
  savers: {
    text: DomainSaver<TextSaveArgs>;
    thread: DomainSaver<ThreadSaveArgs>;
  },
): void {
  for (const child of children) {
    revs.set(entityKey(child.kind, child.id), child.rev);
    if (child.kind === "text") {
      savers.text.refresh(child.id, dropProjectLink, child.rev);
    } else if (child.kind === "thread") {
      savers.thread.refresh(child.id, dropProjectLink, child.rev);
    }
  }
}

/** Serialize a value for storage, returning null for null/undefined. */
function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

// ──────────────────────────────────────────────
// SQLite backend (production, inside Tauri)
// ──────────────────────────────────────────────

function createSqliteRepository(): Repository {
  const textSaver = createSaver<TextSaveArgs>(
    "text",
    400,
    (id, args, expectedRev) =>
      invoke<number>("db_text_save", {
        id,
        meta: textMetaToWire(args.meta, expectedRev ?? 0),
        body: args.content ? bodyToWire(args.content) : null,
        expectedRev,
      }),
    (pendingArgs, incomingArgs) => ({
      meta: incomingArgs.meta,
      content: incomingArgs.content ?? pendingArgs.content,
    }),
  );

  const projectSaver = createSaver<ProjectSaveArgs>(
    "project",
    400,
    (id, args, expectedRev) =>
      invoke<number>("db_project_save", {
        id,
        meta: projectMetaToWire(args.meta, expectedRev ?? 0),
        brief: args.brief ?? null,
        expectedRev,
      }),
    (pendingArgs, incomingArgs) => ({
      meta: incomingArgs.meta,
      brief:
        incomingArgs.brief !== undefined ? incomingArgs.brief : pendingArgs.brief,
    }),
  );

  const threadSaver = createSaver<ThreadSaveArgs>(
    "thread",
    400,
    (id, args, expectedRev) =>
      invoke<number>("db_thread_save", {
        id,
        meta: threadMetaToWire(args.meta, expectedRev ?? 0),
        briefJson: args.briefJson,
        messages: args.messages,
        expectedRev,
      }),
    (_pendingArgs, incomingArgs) => incomingArgs,
  );

  return gateMutations({
    idle: repoIdle,
    search: (query) => track(invoke<SearchHit[]>("db_search", { query })),
    flushTextSaves: () => textSaver.flush(),
    flushProjectSaves: () => projectSaver.flush(),
    flushThreadSaves: () => threadSaver.flush(),
    drainTextSaves: () => textSaver.drain(),
    drainProjectSaves: () => projectSaver.drain(),
    drainThreadSaves: () => threadSaver.drain(),

    textsList: async () =>
      track(
        invoke<TextMetaWire[]>("db_texts_list").then((rows) => {
          for (const row of rows) revs.set(entityKey("text", row.id), row.rev);
          return rows.map(textMetaFromWire);
        }),
      ),
    textCreate: (meta, body) => {
      const key = entityKey("text", meta.id);
      return enqueue(key, () =>
        transport(() =>
          invoke("db_text_create", { meta: textMetaToWire(meta, 0), body: bodyToWire(body) }),
        ),
      ).then(() => {
        revs.set(key, 0);
      });
    },
    textScheduleSave: (id, args) => textSaver.schedule(id, args),
    textSave: (id, args) => textSaver.saveNow(id, args),
    textContent: (id) =>
      track(
        invoke<BodyRowWire | null>("db_text_content", { id }).then((row) =>
          row ? bodyFromWire(row) : null,
        ),
      ),
    textVersions: (id) =>
      track(
        invoke<(BodyRowWire & { versionId: string; savedAt: string; label?: string | null })[]>(
          "db_text_versions",
          { id },
        ).then((rows) =>
          rows.map((r) => ({
            versionId: r.versionId,
            savedAt: r.savedAt,
            body: versionBodyFromWire(r),
            ...(r.label ? { label: r.label } : {}),
          })),
        ),
      ),
    textSnapshot: (id, label, now) => {
      // Flush first: the snapshot must capture the newest draft.
      return textSaver.flush().then(() =>
        track(invoke<string>("db_text_snapshot", { id, label, now })),
      );
    },
    textRestore: async (id, versionId) => {
      // Flush the text's pending save first, so the snapshot taken inside
      // db_text_restore reflects the newest content (not a stale body).
      await textSaver.flush();
      const key = entityKey("text", id);
      const result = await track(
        invoke<RestoreResultWire>("db_text_restore", {
          id,
          versionId,
          now: new Date().toISOString(),
          // Optimistic concurrency: restoring over an external change is
          // rejected rather than silently discarding it.
          expectedRev: revs.get(key) ?? null,
        }),
      );
      const restored: TextRestoreResult = {
        rev: result.rev,
        savedAt: result.savedAt,
        body: versionBodyFromWire(result),
        snippet: result.snippet,
        wordCount: result.wordCount,
        updatedAt: result.updatedAt,
      };
      revs.set(key, restored.rev);
      return restored;
    },
    textDelete: (id) => {
      textSaver.cancel(id);
      const key = entityKey("text", id);
      return enqueue(key, () => transport(() => invoke("db_text_delete", { id }))).then(
        () => {
          revs.delete(key);
          clearFailure(key);
        },
      );
    },

    projectsList: async () =>
      track(
        invoke<ProjectMetaWire[]>("db_projects_list").then((rows) => {
          for (const row of rows) revs.set(entityKey("project", row.id), row.rev);
          return rows.map(projectMetaFromWire);
        }),
      ),
    projectCreate: (meta) => {
      const key = entityKey("project", meta.id);
      return enqueue(key, () =>
        transport(() => invoke("db_project_create", { meta: projectMetaToWire(meta, 0) })),
      ).then(() => {
        revs.set(key, 0);
      });
    },
    projectScheduleSave: (id, args) => projectSaver.schedule(id, args),
    projectSave: (id, args) => projectSaver.saveNow(id, args),
    projectBrief: (id) =>
      track(invoke<string | null>("db_project_brief", { id })),
    projectDelete: (id) => {
      projectSaver.cancel(id);
      const key = entityKey("project", id);
      return enqueue(key, () =>
        transport(() => invoke<AffectedChildWire[]>("db_project_delete", { id })),
      ).then((children) => {
        // B21c: the backend unlinked these children and advanced their
        // revisions; the session cache refreshes before the next save so
        // a queued write cannot relink the deleted project.
        const known = (children ?? []).filter(
          (child): child is AffectedChildWire =>
            child.kind === "text" ||
            child.kind === "thread" ||
            child.kind === "source",
        );
        applyUnlinkedChildren(known, { text: textSaver, thread: threadSaver });
        revs.delete(key);
        clearFailure(key);
      });
    },

    // Sources (Phase 5.1)
    sourcesList: () =>
      track(
        invoke<SourceRowWire[]>("db_sources_list").then((rows) => {
          for (const row of rows) revs.set(entityKey("source", row.id), row.rev);
          return rows.map(sourceFromWire);
        }),
      ),
    sourceGet: (id) =>
      track(
        invoke<SourceDataWire | null>("db_source_get", { id }).then((data) =>
          data ? sourceDataFromWire(data) : null,
        ),
      ),
    sourceCreate: (source, passages) => {
      const key = entityKey("source", source.id);
      return enqueue(key, () =>
        transport(() =>
          invoke("db_source_create", {
            source: sourceToWire(source, 0),
            passages,
          }),
        ),
      ).then(() => {
        revs.set(key, 0);
      });
    },
    sourceSave: (id, source, passages) => {
      const key = entityKey("source", id);
      return enqueue(key, () =>
        transport(() =>
          invoke<number>("db_source_save", {
            id,
            source: sourceToWire(source, revs.get(key) ?? 0),
            // Omitted passages = metadata-only: the native side keeps the
            // stored rows. An explicit list replaces them.
            passages: passages ?? null,
            expectedRev: revs.get(key) ?? null,
          }),
        ),
      ).then((newRev) => {
        revs.set(key, newRev);
        return newRev;
      });
    },
    sourceDelete: (id) => {
      const key = entityKey("source", id);
      return enqueue(key, () =>
        transport(() => invoke("db_source_delete", { id })),
      ).then(() => {
        revs.delete(key);
        clearFailure(key);
      });
    },

    // Reviewable revision proposals (Phase 5.3)
    proposalsList: (documentId) =>
      track(invoke<DocumentProposal[]>("db_proposals_list", { documentId })),
    proposalCreate: (proposal) =>
      track(invoke("db_proposal_create", { proposal })),
    proposalSetStatus: (id, status) =>
      track(
        invoke("db_proposal_set_status", { id, status, updatedAt: new Date().toISOString() }),
      ),
    peekRev: (kind, id) => revs.get(entityKey(kind, id)) ?? null,

    threadsList: async () =>
      track(
        invoke<ThreadMetaWire[]>("db_threads_list").then((rows) => {
          for (const row of rows) revs.set(entityKey("thread", row.id), row.rev);
          return rows.map(threadMetaFromWire);
        }),
      ),
    threadCreate: (meta) => {
      const key = entityKey("thread", meta.id);
      return enqueue(key, () =>
        transport(() =>
          invoke("db_thread_create", {
            meta: threadMetaToWire(meta, 0),
            // New conversations start empty; the Rust command requires the
            // key whether or not there is data (non-Option Vec).
            briefJson: null,
            messages: [],
          }),
        ),
      ).then(() => {
        revs.set(key, 0);
      });
    },
    threadGet: (id) =>
      track(
        invoke<ThreadData | null>("db_thread_get", { id }).then((data) => {
          if (data) revs.set(entityKey("thread", id), data.rev);
          return data;
        }),
      ),
    threadScheduleSave: (id, args) => threadSaver.schedule(id, args),
    threadSave: (id, args) => threadSaver.saveNow(id, args),
    threadAppendMessage: async (id, message, updatedAt) => {
      // Flush the thread's pending save first, so the appended reply
      // cannot be overwritten by the debounced whole-thread write.
      await threadSaver.flush();
      const key = entityKey("thread", id);
      const newRev = await track(
        invoke<number>("db_thread_append_message", { id, message, updatedAt }),
      );
      revs.set(key, newRev);
    },
    threadReplaceMessage: async (id, messageId, content, incomplete, updatedAt) => {
      // Flush the thread's pending save first so the replace cannot be
      // overwritten by the debounced whole-thread write.
      await threadSaver.flush();
      const key = entityKey("thread", id);
      const newRev = await track(
        invoke<number>("db_thread_replace_message", {
          id,
          messageId,
          content,
          incomplete,
          updatedAt,
        }),
      );
      revs.set(key, newRev);
    },
    threadRename: async (id, title, updatedAt) => {
      // Metadata-only: safe for threads whose messages are not loaded.
      await threadSaver.flush();
      const key = entityKey("thread", id);
      const newRev = await track(
        invoke<number>("db_thread_rename", { id, title, updatedAt }),
      );
      revs.set(key, newRev);
    },
    textSetState: async (id, patch, updatedAt) => {
      // Metadata-only: flush the text's pending save first so the state
      // change cannot be overwritten by it.
      await textSaver.flush();
      const key = entityKey("text", id);
      const newRev = await track(
        invoke<number>("db_text_set_state", {
          id,
          archived: patch.archived ?? null,
          pinned: patch.pinned ?? null,
          updatedAt,
        }),
      );
      revs.set(key, newRev);
    },
    threadSetState: async (id, patch, updatedAt) => {
      await threadSaver.flush();
      const key = entityKey("thread", id);
      const newRev = await track(
        invoke<number>("db_thread_set_state", {
          id,
          archived: patch.archived ?? null,
          pinned: patch.pinned ?? null,
          updatedAt,
        }),
      );
      revs.set(key, newRev);
    },
    threadDelete: (id) => {
      threadSaver.cancel(id);
      const key = entityKey("thread", id);
      return enqueue(key, () => transport(() => invoke("db_thread_delete", { id }))).then(
        () => {
          revs.delete(key);
          clearFailure(key);
        },
      );
    },

    saveFailures: () => [...failureRegistry.values()],
    retrySave: (key) => resolveRetainedFailure(key, "retry"),
    resolveSaveFailure: (key, resolution) =>
      resolveRetainedFailure(key, resolution),
    exportDump: () => track(invoke<unknown>("db_export")),
    replaceDump: () => {
      // The desktop replaces the dataset through `db_restore`, where the
      // domain dump and preferences commit in ONE Rust transaction; the
      // generic repository method would not be atomic across preferences.
      return Promise.reject(
        new Error(
          "The desktop backend restores backups through db_restore, not replaceDump.",
        ),
      );
    },
    saveState: repositorySaveState,
    subscribeSaveState: (listener) => {
      saveStateListeners.add(listener);
      return () => saveStateListeners.delete(listener);
    },
    resetSessionState: () => {
      revs.clear();
      failureRegistry.clear();
      notifySaveState();
    },
  });
}

// ──────────────────────────────────────────────
// JSON-file backend (browser dev; same layout as the legacy store)
// ──────────────────────────────────────────────

const MAX_VERSIONS = 20;

/** A body file as persisted/read (format fields optional on legacy files). */
type StoredBodyShape = {
  content: string;
  contentFormat?: string | null;
  contentSchemaVersion?: number | null;
  plainText?: string | null;
};

/** A versions file entry as persisted/read (legacy: body fields inline). */
type LegacyVersionShape = {
  versionId: string;
  savedAt: string;
  body?: StoredBodyShape;
  content?: string;
  label?: string;
};

/** Decode one versions-file entry (legacy entries hold the body inline). */
function versionFromLegacyEntry(v: LegacyVersionShape): TextVersion {
  const raw = v.body ?? { content: v.content ?? "" };
  return {
    versionId: v.versionId,
    savedAt: v.savedAt,
    body: versionBodyFromWire(raw),
    ...(v.label ? { label: v.label } : {}),
  };
}

/** Stable unique version identity (timestamps alone can collide). */
let versionSeq = 0;
function nextVersionId(): string {
  versionSeq += 1;
  return `sv-${Date.now().toString(16)}-${versionSeq.toString(16)}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
}

function textFile(id: string): string {
  return `text_${id}.json`;
}
function versionsFile(id: string): string {
  return `text_${id}.versions.json`;
}
function briefFile(id: string): string {
  return `project_${id}.json`;
}
function sourceFile(id: string): string {
  return `source_${id}.json`;
}
function threadFile(id: string): string {
  return `chat_${id}.json`;
}
function revisionsFile(): string {
  return "revisions.json";
}

type RevMap = Record<string, number>;

/**
 * Global registry-mutation queue for the JSON backend: read-modify-write
 * cycles over `library.json` / `projects.json` / `threads.json` /
 * `revisions.json` must never interleave, or one mutation silently
 * overwrites another's registry.
 */
let registryTail: Promise<unknown> = Promise.resolve();
function enqueueRegistry<T>(op: () => Promise<T>): Promise<T> {
  const run = registryTail.then(op, op);
  registryTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function createJsonRepository(): Repository {
  const textSaver = createSaver<TextSaveArgs>(
    "text",
    400,
    (id, args, expectedRev) => jsonTextSave(id, args, expectedRev),
    (pendingArgs, incomingArgs) => ({
      meta: incomingArgs.meta,
      content: incomingArgs.content ?? pendingArgs.content,
    }),
  );

  const projectSaver = createSaver<ProjectSaveArgs>(
    "project",
    400,
    (id, args, expectedRev) => jsonProjectSave(id, args, expectedRev),
    (pendingArgs, incomingArgs) => ({
      meta: incomingArgs.meta,
      brief:
        incomingArgs.brief !== undefined ? incomingArgs.brief : pendingArgs.brief,
    }),
  );

  const threadSaver = createSaver<ThreadSaveArgs>(
    "thread",
    400,
    (id, args, expectedRev) => jsonThreadSave(id, args, expectedRev),
    (_pendingArgs, incomingArgs) => incomingArgs,
  );

  // ── Revisions ──

  /**
   * Transactions (B21b): one journal + one batch of file writes. Every
   * reader replays a leftover journal before loading, so a crash between
   * two writes can never expose a mixed generation — the batch either
   * lands completely or the previous state is restored (or replayed).
   */
  const COMMIT_JOURNAL_FILE = "commit-journal.json";

  async function replayPendingCommit(): Promise<void> {
    const journal = await loadJson<{
      files?: { path: string; data: unknown }[];
      removals?: string[];
    }>(COMMIT_JOURNAL_FILE);
    const files = journal?.files ?? [];
    const removals = journal?.removals ?? [];
    if (files.length === 0 && removals.length === 0) return;
    for (const file of files) {
      await saveJson(file.path, file.data);
    }
    for (const path of removals) {
      await deleteFile(path);
    }
    await deleteFile(COMMIT_JOURNAL_FILE);
  }

  async function commitFiles(
    files: { path: string; data: unknown }[],
    removePaths: string[] = [],
  ): Promise<void> {
    // A path that is being written is never also removed.
    const written = new Set(files.map((file) => file.path));
    const removals = [...new Set(removePaths)].filter(
      (path) => !written.has(path),
    );
    if (files.length === 0 && removals.length === 0) return;
    await replayPendingCommit();
    const previous: { path: string; data: unknown | null }[] = [];
    for (const path of [...written, ...removals]) {
      previous.push({ path, data: await loadJson(path) });
    }
    // Journal first: a crash after this point is healed by the next read.
    await saveJson(COMMIT_JOURNAL_FILE, { files, removals });
    try {
      for (const file of files) {
        await saveJson(file.path, file.data);
      }
      for (const path of removals) {
        await deleteFile(path);
      }
      await deleteFile(COMMIT_JOURNAL_FILE);
    } catch (err) {
      // Mid-batch failure: restore every file to its previous value.
      let restored = true;
      for (const file of previous) {
        try {
          if (file.data === null) await deleteFile(file.path);
          else await saveJson(file.path, file.data);
        } catch {
          restored = false;
        }
      }
      // If the rollback itself failed, keep the journal so the next
      // reader completes the NEW generation instead of a mixed one.
      if (restored) {
        try {
          await deleteFile(COMMIT_JOURNAL_FILE);
        } catch {
          // The next replay finishes the batch; the state stays coherent.
        }
      }
      throw err;
    }
  }

  async function readRevs(): Promise<RevMap> {
    await replayPendingCommit();
    return (await loadJson<RevMap>(revisionsFile())) ?? {};
  }

  /**
   * The ONE serialized revision pass (B21b-3): verify existence, check the
   * expected revision, then let the work callback fill the batch's files;
   * `revisions.json` is appended to them, so content, metadata, and the
   * revision commit as ONE transaction. A failed save can never advance
   * the revision while its content rolled back, and no concurrent stale
   * save can sneak in (the registry queue serializes the pass).
   */
  async function withRevBatched<T>(
    kind: EntityKind,
    id: string,
    expectedRev: number | null,
    exists: () => Promise<boolean>,
    work: (files: { path: string; data: unknown }[]) => Promise<T>,
  ): Promise<{ value: T; newRev: number }> {
    const key = entityKey(kind, id);
    return enqueueRegistry(async () => {
      if (!(await exists())) {
        throw new Error(`Entity not found: ${key}`);
      }
      const map = await readRevs();
      // Adopt a legacy bare-id entry under the canonical key (B21).
      if (map[key] === undefined && map[id] !== undefined) {
        map[key] = map[id];
        delete map[id];
      }
      const current = revOf(map, kind, id);
      if (expectedRev !== null && expectedRev !== current) {
        throw new Error(
          `Stale revision: expected ${expectedRev}, current ${current}`,
        );
      }
      const newRev = current + 1;
      map[key] = newRev;
      const files: { path: string; data: unknown }[] = [];
      const value = await work(files);
      files.push({ path: revisionsFile(), data: map });
      await commitFiles(files);
      return { value, newRev };
    });
  }

  /**
   * B21c: resolve a child's project link against the LIVE project index.
   * A caller's metadata can be stale (loaded before the project was
   * deleted); a persisted link must point at an existing project or be
   * absent, so no save can recreate a dangling association. An explicit
   * incoming `null`/`undefined` clears the link; an omitted incoming
   * value keeps the persisted one.
   */
  async function resolveProjectId(
    currentLink: string | null | undefined,
    incomingLink: string | null | undefined,
  ): Promise<string | undefined> {
    const candidate = incomingLink !== undefined ? incomingLink : currentLink;
    if (!candidate) return undefined;
    const projects = (await loadJson<ProjectMeta[]>("projects.json")) ?? [];
    return projects.some((p) => p.id === candidate) ? candidate : undefined;
  }

  /** Serialize a stored message back to the raw file shape: attachments
   * live under their legacy field name, and absent flags are omitted. */
  function storedMessageToRaw(m: StoredMessage): unknown {
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      ...(m.failed ? { failed: true } : {}),
      ...(m.incomplete ? { incomplete: m.incomplete } : {}),
      ...(m.attachmentsJson
        ? { fileAttachments: JSON.parse(m.attachmentsJson) }
        : {}),
    };
  }

  // ── Domain saves (update-only, one registry pass each) ──

  async function jsonTextSave(
    id: string,
    args: TextSaveArgs,
    expectedRev: number | null,
  ): Promise<number> {
    const { newRev } = await withRevBatched(
      "text",
      id,
      expectedRev,
      async () => {
        const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
        return texts.some((t) => t.id === id);
      },
      async (files) => {
        // B21b: the body, its version snapshot, the registry entry, and
        // the revision bump are ONE transaction — a failure between them
        // keeps the old state (including the revision).
        if (args.content !== undefined) {
          // Snapshot the persisted content being replaced — only when it
          // actually differs — decided here, not by the caller.
          const body = decodeDocumentBodyLenient(
            await loadJson<StoredBodyShape>(textFile(id)),
          );
          if (body !== null && body.content !== args.content.content) {
            const versions =
              (await loadJson<LegacyVersionShape[]>(versionsFile(id))) ?? [];
            versions.unshift({
              versionId: nextVersionId(),
              savedAt: args.meta.updatedAt,
              body,
            });
            files.push({
              path: versionsFile(id),
              data: versions.slice(0, MAX_VERSIONS),
            });
          }
          files.push({ path: textFile(id), data: args.content });
        }
        const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
        const current = texts.find((t) => t.id === id);
        const projectId = await resolveProjectId(
          current?.projectId,
          args.meta.projectId,
        );
        const updated = texts.map((t) =>
          t.id === id
            ? {
                ...t,
                ...args.meta,
                projectId,
                updatedAt: args.meta.updatedAt,
              }
            : t,
        );
        files.push({ path: "library.json", data: updated });
      },
    );
    return newRev;
  }

  async function jsonProjectSave(
    id: string,
    args: ProjectSaveArgs,
    expectedRev: number | null,
  ): Promise<number> {
    const { newRev } = await withRevBatched(
      "project",
      id,
      expectedRev,
      async () => {
        const projects = (await loadJson<ProjectMeta[]>("projects.json")) ?? [];
        return projects.some((p) => p.id === id);
      },
      async (files) => {
        // B21b: brief, registry entry, and revision are ONE transaction.
        if (args.brief !== undefined) {
          files.push({ path: briefFile(id), data: { content: args.brief } });
        }
        const projects = (await loadJson<ProjectMeta[]>("projects.json")) ?? [];
        const updated = projects.map((p) =>
          p.id === id
            ? { ...p, ...args.meta, updatedAt: args.meta.updatedAt }
            : p,
        );
        files.push({ path: "projects.json", data: updated });
      },
    );
    return newRev;
  }

  async function jsonThreadSave(
    id: string,
    args: ThreadSaveArgs,
    expectedRev: number | null,
  ): Promise<number> {
    const { newRev } = await withRevBatched(
      "thread",
      id,
      expectedRev,
      async () => {
        const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
        return threads.some((t) => t.id === id);
      },
      async (files) => {
        // B21b: messages, registry entry, and revision are ONE transaction.
        // Attachments are stored under their legacy field name.
        const messages = args.messages.map(storedMessageToRaw);
        files.push({
          path: threadFile(id),
          data: {
            messages,
            brief: args.briefJson ? JSON.parse(args.briefJson) : null,
          },
        });
        const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
        const current = threads.find((t) => t.id === id);
        const projectId = await resolveProjectId(
          current?.projectId,
          args.meta.projectId,
        );
        const updated = threads.map((t) =>
          t.id === id
            ? { ...t, ...args.meta, projectId, updatedAt: args.meta.updatedAt }
            : t,
        );
        files.push({ path: "threads.json", data: updated });
      },
    );
    return newRev;
  }

  /** Legacy files keep the raw ChatMessage shape. */
  function toStored(raw: unknown): StoredMessage | null {
    if (!raw || typeof raw !== "object") return null;
    const m = raw as Record<string, unknown>;
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = typeof m.content === "string" ? m.content : "";
    const timestamp = typeof m.timestamp === "string" ? m.timestamp : "";
    return {
      // Legacy rows have no stable id yet; the store migrates on load.
      id: typeof m.id === "string" && m.id ? m.id : null,
      role,
      content,
      timestamp,
      failed: m.failed === true,
      incomplete:
        m.incomplete === "interrupted" || m.incomplete === "truncated"
          ? m.incomplete
          : null,
      attachmentsJson: toJson(m.fileAttachments),
    };
  }

  function toStoredList(raw: unknown): StoredMessage[] {
    return Array.isArray(raw)
      ? raw.map(toStored).filter((m): m is StoredMessage => m !== null)
      : [];
  }

  // ── Canonical dataset export/replace (B21d) ──
  //
  // The browser backend must be able to produce and consume the SAME
  // canonical dump the desktop exports, so a backup file is portable
  // between the two. `assembleBrowserDump` reads every entity (replaying a
  // pending commit first); `dumpReplacement` converts a validated dump
  // back into the file set and reports every per-entity path the new
  // generation does not carry, so a restore can never inherit a body the
  // dump omitted.

  function unionIds(a: string[], b: string[]): string[] {
    return [...new Set([...a, ...b])];
  }

  /**
   * The canonical projection of a STORED body: values travel as stored
   * (an explicit `null` plainText stays null), while a pre-contract file
   * that never had format fields normalizes to markdown v1 with the
   * plain-text backfill the desktop migration produces.
   */
  function canonicalBodyShape(raw: StoredBodyShape | null | undefined): {
    content: string;
    contentFormat: DumpContentFormat | null;
    contentSchemaVersion: number | null;
    plainText: string | null;
  } | null {
    if (!raw || typeof raw.content !== "string") return null;
    if (!("contentFormat" in raw) && !("contentSchemaVersion" in raw)) {
      return {
        content: raw.content,
        contentFormat: "markdown",
        contentSchemaVersion: 1,
        plainText: raw.plainText ?? raw.content,
      };
    }
    const format = raw.contentFormat;
    if (format != null && format !== "markdown" && format !== "tiptap-json") {
      // The export must fail loudly, not silently relabel foreign content:
      // the production import parser would reject such a bundle anyway.
      throw new Error(
        `The stored dataset contains an unsupported document format (${format}). ` +
          "No backup file was written.",
      );
    }
    // Nulls heal to markdown v1 on restore (`apply_dump` COALESCEs the same
    // way); exporting them as that representation keeps the round trip
    // stable and both backends reading the SAME body.
    return {
      content: raw.content,
      contentFormat: format ?? "markdown",
      contentSchemaVersion: raw.contentSchemaVersion ?? 1,
      plainText: raw.plainText ?? null,
    };
  }

  async function assembleBrowserDump(): Promise<CanonicalDump> {
    // `readRevs` replays a pending commit before any file is read.
    const revMap = await readRevs();
    const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
    const projects = (await loadJson<ProjectMeta[]>("projects.json")) ?? [];
    const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
    const sources = (await loadJson<SourceMeta[]>("sources.json")) ?? [];
    const proposals = (await loadJson<DocumentProposal[]>("proposals.json")) ?? [];

    // The canonical dump row shapes ARE the wire shapes: reuse the same
    // converters the production read/write paths use, so a field added to
    // an entity can never drift between the two.
    const dump: CanonicalDump = {
      texts: texts.map((t) => textMetaToWire(t, revOf(revMap, "text", t.id))),
      textContents: [],
      textVersions: [],
      projects: projects.map((p) =>
        projectMetaToWire(p, revOf(revMap, "project", p.id)),
      ),
      projectBriefs: [],
      sources: sources.map((s) =>
        sourceToWire(s, revOf(revMap, "source", s.id)),
      ) as DumpSourceRow[],
      sourcePassages: [],
      proposals: proposals.map((p) => ({
        id: p.id,
        documentId: p.documentId,
        baseRev: p.baseRev,
        requestKind: p.requestKind,
        baseFragment: p.baseFragment,
        proposedFragment: p.proposedFragment,
        selFrom: p.selFrom ?? null,
        selTo: p.selTo ?? null,
        contextNote: p.contextNote ?? null,
        status: p.status,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
      threads: threads.map((t) => threadMetaToWire(t, revOf(revMap, "thread", t.id))),
      threadBriefs: [],
      messages: [],
    };

    for (const text of texts) {
      const body = canonicalBodyShape(
        await loadJson<StoredBodyShape>(textFile(text.id)),
      );
      if (body) {
        dump.textContents.push({ textId: text.id, ...body });
      }
      const versions =
        (await loadJson<LegacyVersionShape[]>(versionsFile(text.id))) ?? [];
      for (const entry of versions) {
        const stored =
          entry.body ??
          (entry.content !== undefined ? { content: entry.content } : null);
        const body = canonicalBodyShape(stored);
        if (!body) continue;
        dump.textVersions.push({
          textId: text.id,
          versionId: entry.versionId ?? null,
          savedAt: entry.savedAt,
          ...body,
          label: entry.label ?? null,
        });
      }
    }
    for (const project of projects) {
      const brief = await loadJson<{ content: string }>(briefFile(project.id));
      if (brief) {
        dump.projectBriefs.push({ projectId: project.id, content: brief.content });
      }
    }
    for (const thread of threads) {
      const raw = await loadJson<unknown>(threadFile(thread.id));
      const parsed = Array.isArray(raw)
        ? { messages: raw, brief: null as unknown }
        : ((raw as Record<string, unknown>) ?? {});
      toStoredList(parsed.messages).forEach((message, idx) => {
        dump.messages.push({ threadId: thread.id, idx, ...message });
      });
      // The desktop dump omits thread-brief rows that carry no brief.
      const brief = parsed.brief;
      if (brief !== undefined && brief !== null) {
        dump.threadBriefs.push({
          threadId: thread.id,
          briefJson: JSON.stringify(brief),
        });
      }
    }
    for (const source of sources) {
      const passages = (await loadJson<SourcePassage[]>(sourceFile(source.id))) ?? [];
      for (const passage of passages) {
        dump.sourcePassages.push({
          sourceId: source.id,
          id: passage.id,
          locator: passage.locator ?? null,
          content: passage.content,
        });
      }
    }
    return dump;
  }

  /** Convert a validated canonical dump into one replacement file batch. */
  async function dumpReplacement(dump: CanonicalDump): Promise<{
    files: { path: string; data: unknown }[];
    removals: string[];
  }> {
    // A leftover journal describes an INCOMING generation: replay it before
    // reading the current indexes, or the removals below would be computed
    // against a stale state.
    await replayPendingCommit();
    const files: { path: string; data: unknown }[] = [];
    const removals: string[] = [];
    const revMap: RevMap = {};
    for (const t of dump.texts) revMap[entityKey("text", t.id)] = t.rev;
    for (const p of dump.projects) revMap[entityKey("project", p.id)] = p.rev;
    for (const th of dump.threads) revMap[entityKey("thread", th.id)] = th.rev;
    for (const s of dump.sources) revMap[entityKey("source", s.id)] = s.rev;

    // Reuse the production wire converters (see assembleBrowserDump).
    files.push({ path: "library.json", data: dump.texts.map(textMetaFromWire) });
    files.push({
      path: "projects.json",
      data: dump.projects.map(projectMetaFromWire),
    });
    files.push({
      path: "threads.json",
      data: dump.threads.map(threadMetaFromWire),
    });
    files.push({ path: "sources.json", data: dump.sources.map(sourceFromWire) });
    files.push({
      path: "proposals.json",
      data: dump.proposals.map((p) => ({
        id: p.id,
        documentId: p.documentId,
        baseRev: p.baseRev,
        requestKind: p.requestKind,
        baseFragment: p.baseFragment,
        proposedFragment: p.proposedFragment,
        ...(p.selFrom != null ? { selFrom: p.selFrom } : {}),
        ...(p.selTo != null ? { selTo: p.selTo } : {}),
        ...(p.contextNote != null ? { contextNote: p.contextNote } : {}),
        status: p.status,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    });
    files.push({ path: revisionsFile(), data: revMap });

    const contents = new Map(dump.textContents.map((c) => [c.textId, c]));
    const versions = new Map<string, CanonicalDump["textVersions"]>();
    for (const v of dump.textVersions) {
      versions.set(v.textId, [...(versions.get(v.textId) ?? []), v]);
    }
    const briefs = new Map(dump.projectBriefs.map((b) => [b.projectId, b]));
    const threadBriefs = new Map(dump.threadBriefs.map((b) => [b.threadId, b]));
    const messages = new Map<string, CanonicalDump["messages"]>();
    for (const m of dump.messages) {
      messages.set(m.threadId, [...(messages.get(m.threadId) ?? []), m]);
    }
    const passages = new Map<string, CanonicalDump["sourcePassages"]>();
    for (const p of dump.sourcePassages) {
      passages.set(p.sourceId, [...(passages.get(p.sourceId) ?? []), p]);
    }

    const currentTextIds = ((await loadJson<LibraryTextMeta[]>("library.json")) ?? []).map(
      (t) => t.id,
    );
    const currentProjectIds = ((await loadJson<ProjectMeta[]>("projects.json")) ?? []).map(
      (p) => p.id,
    );
    const currentThreadIds = ((await loadJson<ThreadMeta[]>("threads.json")) ?? []).map(
      (t) => t.id,
    );
    const currentSourceIds = ((await loadJson<SourceMeta[]>("sources.json")) ?? []).map(
      (s) => s.id,
    );

    for (const id of unionIds(
      currentTextIds,
      dump.texts.map((t) => t.id),
    )) {
      const content = contents.get(id);
      if (content) {
        // Same defaults as `apply_dump`: a null format/schema restores as
        // markdown v1, so the browser and the desktop read the SAME body.
        files.push({
          path: textFile(id),
          data: {
            content: content.content,
            contentFormat: content.contentFormat ?? "markdown",
            contentSchemaVersion: content.contentSchemaVersion ?? 1,
            plainText: content.plainText,
          },
        });
      } else {
        removals.push(textFile(id));
      }
      const versionRows = versions.get(id);
      if (versionRows?.length) {
        files.push({
          path: versionsFile(id),
          data: versionRows.map((v) => ({
            versionId: v.versionId ?? nextVersionId(),
            savedAt: v.savedAt,
            body: {
              content: v.content,
              contentFormat: v.contentFormat ?? "markdown",
              contentSchemaVersion: v.contentSchemaVersion ?? 1,
              plainText: v.plainText,
            },
            ...(v.label ? { label: v.label } : {}),
          })),
        });
      } else {
        removals.push(versionsFile(id));
      }
    }
    for (const id of unionIds(
      currentProjectIds,
      dump.projects.map((p) => p.id),
    )) {
      const brief = briefs.get(id);
      if (brief) {
        files.push({ path: briefFile(id), data: { content: brief.content } });
      } else {
        removals.push(briefFile(id));
      }
    }
    const dumpThreadIds = new Set(dump.threads.map((t) => t.id));
    for (const id of unionIds(currentThreadIds, [...dumpThreadIds])) {
      if (!dumpThreadIds.has(id)) {
        removals.push(threadFile(id));
        continue;
      }
      const rows = [...(messages.get(id) ?? [])].sort((a, b) => a.idx - b.idx);
      const brief = threadBriefs.get(id);
      files.push({
        path: threadFile(id),
        data: {
          messages: rows.map((m) =>
            storedMessageToRaw({
              id: m.id,
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
              failed: m.failed,
              incomplete: m.incomplete,
              attachmentsJson: m.attachmentsJson,
            }),
          ),
          brief: brief?.briefJson ? JSON.parse(brief.briefJson) : null,
        },
      });
    }
    const dumpSourceIds = new Set(dump.sources.map((s) => s.id));
    for (const id of unionIds(currentSourceIds, [...dumpSourceIds])) {
      if (!dumpSourceIds.has(id)) {
        removals.push(sourceFile(id));
        continue;
      }
      files.push({
        path: sourceFile(id),
        data: (passages.get(id) ?? []).map((p) => ({
          id: p.id,
          ...(p.locator != null ? { locator: p.locator } : {}),
          content: p.content,
        })),
      });
    }
    return { files, removals };
  }

  return gateMutations({
    idle: repoIdle,
    search: async (query) => {
      // Browser dev: plain substring search over the localStorage files.
      await replayPendingCommit();
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const hits: SearchHit[] = [];
      const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
      for (const t of texts) {
        if (t.title.toLowerCase().includes(q)) {
          hits.push({ kind: "text", docId: t.id, title: t.title, excerpt: "" });
        } else {
          const body = decodeDocumentBodyLenient(
            await loadJson<StoredBodyShape>(textFile(t.id)),
          );
          const text = body ? body.plainText || body.content : "";
          const at = text.toLowerCase().indexOf(q);
          if (at >= 0) {
            hits.push({
              kind: "text",
              docId: t.id,
              title: t.title,
              excerpt: text.slice(Math.max(0, at - 40), at + 60),
            });
          }
        }
      }
      const projects = (await loadJson<ProjectMeta[]>("projects.json")) ?? [];
      for (const p of projects) {
        if (p.title.toLowerCase().includes(q)) {
          hits.push({ kind: "project", docId: p.id, title: p.title, excerpt: "" });
        } else {
          const body =
            (await loadJson<{ content: string }>(briefFile(p.id)))?.content ?? "";
          const at = body.toLowerCase().indexOf(q);
          if (at >= 0) {
            hits.push({
              kind: "project",
              docId: p.id,
              title: p.title,
              excerpt: body.slice(Math.max(0, at - 40), at + 60),
            });
          }
        }
      }
      const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
      for (const t of threads) {
        if (t.title.toLowerCase().includes(q)) {
          hits.push({ kind: "thread", docId: t.id, title: t.title, excerpt: "" });
        } else {
          const raw = await loadJson<unknown>(threadFile(t.id));
          const obj = Array.isArray(raw)
            ? { messages: raw }
            : ((raw as Record<string, unknown>) ?? {});
          const messages = Array.isArray(obj.messages) ? obj.messages : [];
          const matched = messages.find(
            (m) =>
              m &&
              typeof m === "object" &&
              typeof (m as { content?: unknown }).content === "string" &&
              ((m as { content: string }).content.toLowerCase().includes(q)),
          );
          if (matched) {
            hits.push({
              kind: "thread",
              docId: t.id,
              title: t.title,
              excerpt: (matched as { content: string }).content.slice(0, 100),
            });
          }
        }
      }
      return hits.slice(0, 25);
    },
    flushTextSaves: () => textSaver.flush(),
    flushProjectSaves: () => projectSaver.flush(),
    flushThreadSaves: () => threadSaver.flush(),
    drainTextSaves: () => textSaver.drain(),
    drainProjectSaves: () => projectSaver.drain(),
    drainThreadSaves: () => threadSaver.drain(),

    async textsList() {
      // F02: a leftover journal is an INCOMING generation; replay it before
      // reading the registry or a stale row would pair with a new body.
      await replayPendingCommit();
      const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
      if (!Array.isArray(texts)) throw new Error("The library index is corrupt.");
      const revMap = await readRevs();
      for (const t of texts) {
        revs.set(entityKey("text", t.id), revOf(revMap, "text", t.id));
      }
      return texts;
    },
    async textCreate(meta, body) {
      // Content first, registry second: a crash leaves an orphan body, not
      // a registry entry pointing at nothing. Serialized with every other
      // registry mutation so concurrent creates cannot lose rows.
      return enqueueRegistry(async () => {
        const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
        if (texts.some((t) => t.id === meta.id)) {
          throw new Error(`Text already exists: ${meta.id}`);
        }
        // B21b: the body and the registry entry are ONE transaction.
        // B21c: a create must not persist a dangling project link.
        // F06: the revision bump commits in the SAME envelope, so a failed
        // create can never leave an entity without its revision (or with
        // a revision naming an entity that does not exist).
        const projectId = await resolveProjectId(undefined, meta.projectId);
        const revMap = await readRevs();
        revMap[entityKey("text", meta.id)] = 0;
        await commitFiles([
          { path: textFile(meta.id), data: body },
          { path: "library.json", data: [{ ...meta, projectId }, ...texts] },
          { path: revisionsFile(), data: revMap },
        ]);
        revs.set(entityKey("text", meta.id), 0);
      });
    },
    textScheduleSave: (id, args) => textSaver.schedule(id, args),
    textSave: (id, args) => textSaver.saveNow(id, args),
    async textContent(id) {
      await replayPendingCommit();
      return decodeDocumentBody(await loadJson<StoredBodyShape>(textFile(id)));
    },
    async textVersions(id) {
      await replayPendingCommit();
      const raw = (await loadJson<LegacyVersionShape[]>(versionsFile(id))) ?? [];
      return raw.map((v) => ({
        versionId: v.versionId,
        savedAt: v.savedAt,
        body: versionFromLegacyEntry(v).body,
        ...(v.label ? { label: v.label } : {}),
      }));
    },
    async textSnapshot(id, label, now) {
      // Flush first: the snapshot must capture the newest draft.
      await textSaver.flush();
      const versionId = nextVersionId();
      return enqueueRegistry(async () => {
        const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
        if (!texts.some((t) => t.id === id)) {
          throw new Error(`Text not found: ${id}`);
        }
        const body = decodeDocumentBodyLenient(
          await loadJson<StoredBodyShape>(textFile(id)),
        );
        if (body === null) throw new Error(`Text has no content: ${id}`);
        const versions = (await loadJson<LegacyVersionShape[]>(versionsFile(id))) ?? [];
        versions.unshift({ versionId, savedAt: now, body, label });
        await saveJson(versionsFile(id), versions.slice(0, MAX_VERSIONS));
        return versionId;
      });
    },
    async textRestore(id, versionId) {
      // Flush the text's pending save so the snapshot reflects the cache.
      await textSaver.flush();
      const { value: result, newRev } = await withRevBatched(
        "text",
        id,
        null,
        async () => {
          const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
          return texts.some((t) => t.id === id);
        },
        async (files) => {
          const raw = (await loadJson<LegacyVersionShape[]>(versionsFile(id))) ?? [];
          const versions = raw.map(versionFromLegacyEntry);
          // The target is resolved HERE from its stable id — the caller
          // never supplies restore content.
          const target = versions.find((v) => v.versionId === versionId);
          if (!target) throw new Error(`Version not found: ${versionId}`);
          const current = decodeDocumentBodyLenient(
            await loadJson<StoredBodyShape>(textFile(id)),
          );
          if (current !== null && current.content !== target.body.content) {
            versions.unshift({
              versionId: nextVersionId(),
              savedAt: new Date().toISOString(),
              body: current,
            });
          }
          // B21b-4: snapshot history, restored body, registry metadata, and
          // the revision bump are ONE transaction.
          files.push({
            path: versionsFile(id),
            data: versions.slice(0, MAX_VERSIONS),
          });
          files.push({ path: textFile(id), data: target.body });
          const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
          const text = target.body.plainText || target.body.content;
          const snippet = text
            .split(/\s+/)
            .filter(Boolean)
            .join(" ")
            .slice(0, 180);
          const wordCountValue = text.split(/\s+/).filter(Boolean).length;
          const now = new Date().toISOString();
          const updated = texts.map((t) =>
            t.id === id
              ? {
                  ...t,
                  snippet,
                  wordCount: wordCountValue,
                  updatedAt: now,
                }
              : t,
          );
          files.push({ path: "library.json", data: updated });
          return {
            rev: 0, // replaced below with the withRevBatched bump result
            savedAt: target.savedAt,
            body: target.body,
            snippet,
            wordCount: wordCountValue,
            updatedAt: now,
          } satisfies TextRestoreResult;
        },
      );
      result.rev = newRev;
      revs.set(entityKey("text", id), newRev);
      return result;
    },
    async textDelete(id) {
      textSaver.cancel(id);
      const key = entityKey("text", id);
      await enqueue(key, async () => {
        await enqueueRegistry(async () => {
          const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
          const revMap = await readRevs();
          delete revMap[key];
          // F06: registry, revision, AND the payload removals are ONE
          // envelope — a failure anywhere leaves the complete old
          // generation (no dangling registry row, no orphaned body).
          await commitFiles(
            [
              {
                path: "library.json",
                data: texts.filter((t) => t.id !== id),
              },
              { path: revisionsFile(), data: revMap },
            ],
            [textFile(id), versionsFile(id)],
          );
        });
      });
      revs.delete(key);
      clearFailure(key);
    },

    async projectsList() {
      await replayPendingCommit();
      const projects = (await loadJson<ProjectMeta[]>("projects.json")) ?? [];
      if (!Array.isArray(projects)) {
        throw new Error("The project index is corrupt.");
      }
      const revMap = await readRevs();
      for (const p of projects) {
        revs.set(entityKey("project", p.id), revOf(revMap, "project", p.id));
      }
      return projects;
    },
    async projectCreate(meta) {
      return enqueueRegistry(async () => {
        const projects = (await loadJson<ProjectMeta[]>("projects.json")) ?? [];
        if (projects.some((p) => p.id === meta.id)) {
          throw new Error(`Project already exists: ${meta.id}`);
        }
        // F06: registry + revision commit together.
        const revMap = await readRevs();
        revMap[entityKey("project", meta.id)] = 0;
        await commitFiles([
          { path: "projects.json", data: [meta, ...projects] },
          { path: revisionsFile(), data: revMap },
        ]);
        revs.set(entityKey("project", meta.id), 0);
      });
    },
    projectScheduleSave: (id, args) => projectSaver.schedule(id, args),
    projectSave: (id, args) => projectSaver.saveNow(id, args),
    async projectBrief(id) {
      await replayPendingCommit();
      const data = await loadJson<{ content: string }>(briefFile(id));
      return data?.content ?? null;
    },
    async projectDelete(id) {
      projectSaver.cancel(id);
      const key = entityKey("project", id);
      const unlinked: { kind: EntityKind; id: string; rev: number }[] = [];
      await enqueue(key, async () => {
        // One domain operation: texts, conversations, and sources are
        // unlinked (they survive as standalone), the brief and the project
        // row are removed — nothing dangling remains.
        await enqueueRegistry(async () => {
          const projects = (await loadJson<ProjectMeta[]>("projects.json")) ?? [];
          const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
          const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
          const sources = (await loadJson<SourceMeta[]>("sources.json")) ?? [];
          const revMap = await readRevs();
          // B21c: the relationship change ADVANCES each child's revision
          // (it is a metadata change), so a stale client cannot save on
          // top of the pre-deletion association.
          const unlink = <T extends { id: string; projectId?: string | null }>(
            rows: T[],
            kind: EntityKind,
          ): T[] =>
            rows.map((row) => {
              if (row.projectId !== id) return row;
              const canonical = entityKey(kind, row.id);
              const rev = revOf(revMap, kind, row.id) + 1;
              delete revMap[row.id];
              revMap[canonical] = rev;
              unlinked.push({ kind, id: row.id, rev });
              return { ...row, projectId: undefined };
            });
          const nextTexts = unlink(texts, "text");
          const nextThreads = unlink(threads, "thread");
          const nextSources = unlink(sources, "source");
          delete revMap[key];
          // B21c: registry files, the child unlinks, and the revisions
          // commit as ONE transaction (the same envelope as the saves).
          // F06: the brief removal rides the SAME envelope — a failure can
          // never leave the project deleted with an orphaned brief (or the
          // brief deleted with the project still registered).
          await commitFiles(
            [
              { path: "projects.json", data: projects.filter((p) => p.id !== id) },
              { path: "library.json", data: nextTexts },
              { path: "threads.json", data: nextThreads },
              { path: "sources.json", data: nextSources },
              { path: revisionsFile(), data: revMap },
            ],
            [briefFile(id)],
          );
          // Advance the session cache and refresh waiting payloads in
          // place: a debounced child save must land its content without
          // recreating the removed link.
          applyUnlinkedChildren(unlinked, {
            text: textSaver,
            thread: threadSaver,
          });
        });
      });
      revs.delete(key);
      clearFailure(key);
    },

    // Sources (Phase 5.1): `sources.json` + one file per source.
    async sourcesList() {
      await replayPendingCommit();
      const sources = (await loadJson<SourceMeta[]>("sources.json")) ?? [];
      const revMap = await readRevs();
      for (const s of sources) {
        revs.set(entityKey("source", s.id), revOf(revMap, "source", s.id));
      }
      return sources;
    },
    async sourceGet(id) {
      await replayPendingCommit();
      const source = ((await loadJson<SourceMeta[]>("sources.json")) ?? []).find(
        (s) => s.id === id,
      );
      if (!source) return null;
      const passages = (await loadJson<SourcePassage[]>(sourceFile(id))) ?? [];
      const revMap = await readRevs();
      return { source, passages, rev: revOf(revMap, "source", id) };
    },
    async sourceCreate(source, passages) {
      return enqueueRegistry(async () => {
        const sources = (await loadJson<SourceMeta[]>("sources.json")) ?? [];
        if (sources.some((s) => s.id === source.id)) {
          throw new Error(`Source already exists: ${source.id}`);
        }
        // Dedup by content identity.
        if (sources.some((s) => s.contentHash === source.contentHash)) {
          throw new Error(
            `A source with identical content already exists (${source.title})`,
          );
        }
        // B21b: the passages and the registry entry are ONE transaction.
        // B21c: a stale caller cannot create a dangling project link.
        // F06: the revision bump joins the same envelope.
        const projectId = await resolveProjectId(undefined, source.projectId);
        const revMap = await readRevs();
        revMap[entityKey("source", source.id)] = 0;
        await commitFiles([
          { path: sourceFile(source.id), data: passages },
          { path: "sources.json", data: [{ ...source, projectId }, ...sources] },
          { path: revisionsFile(), data: revMap },
        ]);
        revs.set(entityKey("source", source.id), 0);
      });
    },
    async sourceSave(id, source, passages) {
      const { newRev } = await withRevBatched(
        "source",
        id,
        revs.get(entityKey("source", id)) ?? null,
        async () => {
          const sources = (await loadJson<SourceMeta[]>("sources.json")) ?? [];
          return sources.some((s) => s.id === id);
        },
        async (files) => {
          // B21b: registry, (optional) passages, and revision are ONE
          // transaction. B21c: a stale caller cannot restore a link to a
          // project that no longer exists.
          const sources = (await loadJson<SourceMeta[]>("sources.json")) ?? [];
          const current = sources.find((s) => s.id === id);
          const projectId = await resolveProjectId(
            current?.projectId,
            source.projectId,
          );
          files.push({
            path: "sources.json",
            data: sources.map((s) => (s.id === id ? { ...source, projectId } : s)),
          });
          // Omitted passages = metadata-only: the passages file is left as
          // it is. An explicit list (including []) replaces it.
          if (passages !== undefined) {
            files.push({ path: sourceFile(id), data: passages });
          }
        },
      );
      revs.set(entityKey("source", id), newRev);
      return newRev;
    },
    async sourceDelete(id) {
      const key = entityKey("source", id);
      await enqueueRegistry(async () => {
        const sources = (await loadJson<SourceMeta[]>("sources.json")) ?? [];
        const revMap = await readRevs();
        delete revMap[key];
        // F06: registry + revision + payload removal in ONE envelope.
        await commitFiles(
          [
            {
              path: "sources.json",
              data: sources.filter((s) => s.id !== id),
            },
            { path: revisionsFile(), data: revMap },
          ],
          [sourceFile(id)],
        );
      });
      revs.delete(key);
      clearFailure(key);
    },

    // Reviewable revision proposals (Phase 5.3): one file for all.
    async proposalsList(documentId) {
      await replayPendingCommit();
      const all = (await loadJson<DocumentProposal[]>("proposals.json")) ?? [];
      return all.filter((p) => p.documentId === documentId);
    },
    async proposalCreate(proposal) {
      return enqueueRegistry(async () => {
        const all = (await loadJson<DocumentProposal[]>("proposals.json")) ?? [];
        await saveJson("proposals.json", [proposal, ...all]);
      });
    },
    async proposalSetStatus(id, status) {
      return enqueueRegistry(async () => {
        const all = (await loadJson<DocumentProposal[]>("proposals.json")) ?? [];
        const next = all.map((p) =>
          p.id === id
            ? { ...p, status, updatedAt: new Date().toISOString() }
            : p,
        );
        if (!next.some((p) => p.id === id)) {
          throw new Error(`Proposal not found: ${id}`);
        }
        await saveJson("proposals.json", next);
      });
    },
    peekRev(kind, id) {
      return revs.get(entityKey(kind, id)) ?? null;
    },

    async exportDump() {
      return assembleBrowserDump();
    },
    async replaceDump(rawDump) {
      // The caller validates the raw payload with the production parser
      // (`parseBackupBundle`) before this runs, exactly as the desktop
      // restore trusts the validated dump it hands to `db_restore`.
      const dump = rawDump as CanonicalDump;
      return enqueueRegistry(async () => {
        const { files, removals } = await dumpReplacement(dump);
        await commitFiles(files, removals);
        // The cache can no longer describe the OLD dataset; the restore
        // caller resets session state and mounted stores re-list.
        revs.clear();
        return {
          texts: dump.texts.length,
          projects: dump.projects.length,
          threads: dump.threads.length,
          messages: dump.messages.length,
          versions: dump.textVersions.length,
          sources: dump.sources.length,
          sourcePassages: dump.sourcePassages.length,
        };
      });
    },

    async threadsList() {
      await replayPendingCommit();
      const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
      if (!Array.isArray(threads)) {
        throw new Error("The conversation index is corrupt.");
      }
      // Pre-mode files have no `mode`; normalize to "text" on read.
      const normalized = threads.map(threadMetaFromLegacyJson);
      const revMap = await readRevs();
      for (const t of normalized) {
        revs.set(entityKey("thread", t.id), revOf(revMap, "thread", t.id));
      }
      return normalized;
    },
    async threadCreate(meta) {
      return enqueueRegistry(async () => {
        const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
        if (threads.some((t) => t.id === meta.id)) {
          throw new Error(`Thread already exists: ${meta.id}`);
        }
        // B21c: a create must not persist a dangling project link.
        // F06: registry + revision commit together.
        const projectId = await resolveProjectId(undefined, meta.projectId);
        const revMap = await readRevs();
        revMap[entityKey("thread", meta.id)] = 0;
        await commitFiles([
          { path: "threads.json", data: [{ ...meta, projectId }, ...threads] },
          { path: revisionsFile(), data: revMap },
        ]);
        revs.set(entityKey("thread", meta.id), 0);
      });
    },
    async threadGet(id) {
      await replayPendingCommit();
      const raw = await loadJson<unknown>(threadFile(id));
      if (raw == null) return null;
      // Old files stored a bare message array; newer ones { messages, brief }.
      const obj = Array.isArray(raw)
        ? { messages: raw, brief: null }
        : ((raw as Record<string, unknown>) ?? {});
      const messages = toStoredList(obj.messages);
      const brief = obj.brief;
      const revMap = await readRevs();
      const rev = revOf(revMap, "thread", id);
      revs.set(entityKey("thread", id), rev);
      return {
        briefJson:
          brief === undefined || brief === null ? null : JSON.stringify(brief),
        messages,
        rev,
      };
    },
    threadScheduleSave: (id, args) => threadSaver.schedule(id, args),
    threadSave: (id, args) => threadSaver.saveNow(id, args),
    async threadAppendMessage(id, message, updatedAt) {
      // Flush the pending save first so the append cannot be overwritten.
      await threadSaver.flush();
      // The append is applied against the persisted thread (no expected
      // revision of its own); it bumps the revision so any debounced save
      // scheduled before it is rejected as stale.
      const { newRev } = await withRevBatched(
        "thread",
        id,
        null,
        async () => {
          const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
          return threads.some((t) => t.id === id);
        },
        async (files) => {
          const data = await loadJson<unknown>(threadFile(id));
          const obj = Array.isArray(data)
            ? { messages: data, brief: null }
            : ((data as Record<string, unknown>) ?? { messages: [], brief: null });
          const messages = toStoredList(obj.messages);
          messages.push(message);
          // B21b-4: the message file, the registry, and the revision bump
          // are ONE transaction.
          files.push({
            path: threadFile(id),
            data: {
              messages: messages.map(storedMessageToRaw),
              brief: (obj.brief ?? null) as unknown,
            },
          });
          const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
          const updated = threads.map((t) =>
            t.id === id ? { ...t, updatedAt } : t,
          );
          files.push({ path: "threads.json", data: updated });
        },
      );
      revs.set(entityKey("thread", id), newRev);
    },
    async threadRename(id, title, updatedAt) {
      await threadSaver.flush();
      const { newRev } = await withRevBatched(
        "thread",
        id,
        null,
        async () => {
          const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
          return threads.some((t) => t.id === id);
        },
        async (files) => {
          const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
          const updated = threads.map((t) =>
            t.id === id ? { ...t, title, updatedAt } : t,
          );
          files.push({ path: "threads.json", data: updated });
        },
      );
      revs.set(entityKey("thread", id), newRev);
    },
    async textSetState(id, patch, updatedAt) {
      await textSaver.flush();
      const { newRev } = await withRevBatched(
        "text",
        id,
        null,
        async () => {
          const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
          return texts.some((t) => t.id === id);
        },
        async (files) => {
          const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
          const updated = texts.map((t) =>
            t.id === id
              ? {
                  ...t,
                  archived: patch.archived ?? (t.archived ?? false),
                  pinned: patch.pinned ?? (t.pinned ?? false),
                  updatedAt,
                }
              : t,
          );
          files.push({ path: "library.json", data: updated });
        },
      );
      revs.set(entityKey("text", id), newRev);
    },
    async threadSetState(id, patch, updatedAt) {
      await threadSaver.flush();
      const { newRev } = await withRevBatched(
        "thread",
        id,
        null,
        async () => {
          const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
          return threads.some((t) => t.id === id);
        },
        async (files) => {
          const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
          const updated = threads.map((t) =>
            t.id === id
              ? {
                  ...t,
                  archived: patch.archived ?? (t.archived ?? false),
                  pinned: patch.pinned ?? (t.pinned ?? false),
                  updatedAt,
                }
              : t,
          );
          files.push({ path: "threads.json", data: updated });
        },
      );
      revs.set(entityKey("thread", id), newRev);
    },
    async threadReplaceMessage(id, messageId, content, incomplete, updatedAt) {
      await threadSaver.flush();
      const { newRev } = await withRevBatched(
        "thread",
        id,
        null,
        async () => {
          const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
          return threads.some((t) => t.id === id);
        },
        async (files) => {
          const data = await loadJson<unknown>(threadFile(id));
          const obj = Array.isArray(data)
            ? { messages: data, brief: null }
            : ((data as Record<string, unknown>) ?? { messages: [], brief: null });
          const messages = toStoredList(obj.messages);
          const index = messages.findIndex((m) => m.id === messageId);
          if (index === -1) throw new Error(`Message not found: ${messageId}`);
          messages[index] = { ...messages[index], content, incomplete };
          files.push({
            path: threadFile(id),
            data: {
              messages: messages.map(storedMessageToRaw),
              brief: (obj.brief ?? null) as unknown,
            },
          });
          const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
          const updated = threads.map((t) =>
            t.id === id ? { ...t, updatedAt } : t,
          );
          files.push({ path: "threads.json", data: updated });
        },
      );
      revs.set(entityKey("thread", id), newRev);
    },
    async threadDelete(id) {
      threadSaver.cancel(id);
      const key = entityKey("thread", id);
      await enqueue(key, async () => {
        await enqueueRegistry(async () => {
          const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
          const revMap = await readRevs();
          delete revMap[key];
          // F06: registry + revision + payload removal in ONE envelope.
          await commitFiles(
            [
              {
                path: "threads.json",
                data: threads.filter((t) => t.id !== id),
              },
              { path: revisionsFile(), data: revMap },
            ],
            [threadFile(id)],
          );
        });
      });
      revs.delete(key);
      clearFailure(key);
    },

    saveFailures: () => [...failureRegistry.values()],
    retrySave: (key) => resolveRetainedFailure(key, "retry"),
    resolveSaveFailure: (key, resolution) =>
      resolveRetainedFailure(key, resolution),
    saveState: repositorySaveState,
    subscribeSaveState: (listener) => {
      saveStateListeners.add(listener);
      return () => saveStateListeners.delete(listener);
    },
    resetSessionState: () => {
      revs.clear();
      failureRegistry.clear();
      notifySaveState();
    },
  });
}

// ──────────────────────────────────────────────
// Selected backend
// ──────────────────────────────────────────────

const sqliteRepo = createSqliteRepository();
const jsonRepo = createJsonRepository();

/** True when the repository is the SQLite backend (production app). */
export function isSqliteRepository(): boolean {
  return hasTauriFs();
}

/**
 * The active repository. Proxy-resolved per call so tests can flip the
 * environment between the SQLite and JSON backends.
 */
export const repo: Repository = new Proxy({} as Repository, {
  get(_target, prop: string) {
    const target: unknown = hasTauriFs() ? sqliteRepo : jsonRepo;
    const value = (target as Record<string, unknown>)[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});
