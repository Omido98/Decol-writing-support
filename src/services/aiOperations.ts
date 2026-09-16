import { datasetGeneration } from "@/utils/backup";
import { markCancelRequested } from "@/utils/perfLog";
import type { ApiConfig, ChatMessage, FileAttachment } from "@/stores/chatStore";
import type { CompiledContext } from "@/services/contextCompiler";
import type { PreparedChatRequest } from "@/services/chatPrepare";

/**
 * AI operation service: the single owner of every AI operation's lifetime
 * (chat sends, retries, regenerations, cleanup passes). Operations live
 * OUTSIDE React components — navigation, remounts, and dataset restores
 * cannot lose or misplace them.
 *
 * Every operation carries:
 * - a request id;
 * - the owning thread/document it commits to;
 * - the user message it sends (fresh/retry) and the target message it
 *   replaces (regeneration) or re-sends;
 * - the dataset generation at start (stale after a restore);
 * - an immutable snapshot of configuration and request context;
 * - an independent output buffer (never cleared by navigation);
 * - its own abort controller and a terminal status.
 *
 * Terminal settlement is idempotent: every event after settlement is
 * ignored. Callers check `isStaleOperation` before every commit. Terminal
 * records keep NO credentials, and finished records are bounded.
 *
 * Failed sends keep their exact prepared request in a retained-failure
 * registry so Retry replays the snapshot instead of re-preparing it from
 * whatever settings/history exist later. The registry is in-memory but
 * navigation-independent; it is cleared by dataset invalidation (restore)
 * and when its thread is deleted.
 */

export type AiOperationType = "chat" | "retry" | "regenerate" | "cleanup" | "proposal";

export type AiOperationStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "aborted";

/** The attachments a request consumes (cleared only for these). */
export interface ConsumedAttachments {
  /** Library text ids attached to this send. */
  library: string[];
  /** Parsed uploaded files attached to this send. */
  files: FileAttachment[];
}

export interface AiOperation {
  id: string;
  type: AiOperationType;
  /** Owning conversation this operation commits to. */
  threadId: string;
  /** Owning document (manuscript operations, Phase 5). */
  documentId: string | null;
  /** Message the operation replaces (regenerate) or re-sends (retry). */
  targetMessageId: string | null;
  /** Stable id of the user message this operation sends (fresh/retry). */
  userMessageId: string | null;
  /** Dataset generation captured at start; stale after a restore. */
  generation: number;
  /** Immutable context snapshot used by the request. Terminal records
   * have their credential removed (see settleOperation). */
  config: ApiConfig;
  systemPrompt: string;
  history: ChatMessage[];
  consumedAttachments: ConsumedAttachments;
  controller: AbortController;
  /** Independent output buffer — navigation never clears this. */
  output: string;
  status: AiOperationStatus;
  /** Terminal guard: true once the operation settled. */
  settled: boolean;
  /** The compiled context this request sends (manifest + payload, 5.2). */
  compiled?: CompiledContext;
}

/** Finished operations retained for inspection before the oldest are
 * evicted; running operations are never evicted. */
export const MAX_RETAINED_OPERATIONS = 20;

const operations = new Map<string, AiOperation>();
const listeners = new Set<() => void>();
let operationsRevision = 0;

function notify(): void {
  operationsRevision += 1;
  for (const listener of listeners) listener();
}

/** Monotonic operation revision (useSyncExternalStore snapshots). */
export function operationsVersion(): number {
  return operationsRevision;
}

/** Subscribe to operation lifecycle changes (for UI mirrors). */
export function subscribeOperations(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Drop the oldest finished operations beyond the retention bound. */
function evictFinishedOperations(): void {
  const finished = [...operations.values()].filter((op) => op.settled);
  const excess = finished.length - MAX_RETAINED_OPERATIONS;
  for (let i = 0; i < excess; i++) operations.delete(finished[i].id);
}

export function startOperation(init: {
  type: AiOperationType;
  threadId: string;
  documentId?: string | null;
  targetMessageId?: string | null;
  userMessageId?: string | null;
  config: ApiConfig;
  systemPrompt: string;
  history: ChatMessage[];
  consumedAttachments?: ConsumedAttachments;
}): AiOperation {
  const op: AiOperation = {
    id: crypto.randomUUID(),
    type: init.type,
    threadId: init.threadId,
    documentId: init.documentId ?? null,
    targetMessageId: init.targetMessageId ?? null,
    userMessageId: init.userMessageId ?? null,
    generation: datasetGeneration(),
    config: { ...init.config },
    systemPrompt: init.systemPrompt,
    // Snapshot the context: the request replays exactly this, regardless
    // of later navigation or edits.
    history: init.history.map((m) => ({
      ...m,
      fileAttachments: m.fileAttachments?.map((f) => ({ ...f })),
    })),
    consumedAttachments: {
      library: [...(init.consumedAttachments?.library ?? [])],
      files: (init.consumedAttachments?.files ?? []).map((f) => ({ ...f })),
    },
    controller: new AbortController(),
    output: "",
    status: "running",
    settled: false,
  };
  operations.set(op.id, op);
  notify();
  return op;
}

/**
 * Admission guard shared by every chat surface: at most ONE running
 * operation per conversation. A second click (or a second surface) gets
 * null instead of a duplicate request. Returns the started operation.
 */
export function admitOperation(
  init: Parameters<typeof startOperation>[0],
): AiOperation | null {
  if (activeOperationForThread(init.threadId)) return null;
  return startOperation(init);
}

export function getOperation(id: string): AiOperation | undefined {
  return operations.get(id);
}

/** The running operation of a thread, when one exists. */
export function activeOperationForThread(
  threadId: string,
): AiOperation | undefined {
  for (const op of operations.values()) {
    if (!op.settled && op.threadId === threadId) return op;
  }
  return undefined;
}

/** Append to the operation's own output buffer (navigation-independent). */
export function appendOutput(op: AiOperation, chunk: string): void {
  if (op.settled) return;
  op.output += chunk;
  notify();
}

/** Abort a running operation (Stop button / Escape). */
export function abortOperation(id: string): void {
  const op = operations.get(id);
  if (op && !op.settled) {
    // Diagnostics: the settle handler records cancel-latency from here,
    // keyed by THIS operation (parallel conversations keep their own).
    markCancelRequested(op.id);
    op.controller.abort();
  }
  notify();
}

/**
 * Settle an operation terminal-state. Idempotent: the first call wins and
 * every later event (including late deltas) is ignored. Credentials never
 * outlive the request: the terminal record's config key is cleared.
 * Returns the operation when THIS call settled it, null when it was
 * already settled.
 */
export function settleOperation(
  id: string,
  status: Exclude<AiOperationStatus, "running">,
): AiOperation | null {
  const op = operations.get(id);
  if (!op || op.settled) return null;
  op.settled = true;
  op.status = status;
  op.config = { ...op.config, apiKey: "" };
  evictFinishedOperations();
  notify();
  return op;
}

/** True when the owner vanished: the thread was deleted or the dataset
 * was restored away after the operation started. */
export function isStaleOperation(op: AiOperation): boolean {
  return op.generation !== datasetGeneration();
}

/**
 * Invalidate everything: running operations are aborted and marked
 * terminal (dataset restore / shutdown). Their commits are dropped by the
 * stale-generation check. Retained failed-send snapshots describe the
 * replaced dataset and are dropped with them.
 */
export function invalidateAllOperations(): void {
  for (const op of operations.values()) {
    if (!op.settled) {
      op.settled = true;
      op.status = "aborted";
      op.controller.abort();
      op.config = { ...op.config, apiKey: "" };
    }
  }
  failedSends.clear();
  notify();
  notifyFailedSends();
}

/** Finished operations (kept so their results can be inspected/tests). */
export function listOperations(): AiOperation[] {
  return [...operations.values()];
}

/** Test seam: forget every operation and retained failure. */
export function resetOperations(): void {
  operations.clear();
  failedSends.clear();
  notify();
  notifyFailedSends();
}

// ──────────────────────────────────────────────
// Retained failed sends (B15)
// ──────────────────────────────────────────────

/** A failed send's exact prepared request, retained for Retry so the
 * replay is byte-identical to the request that failed (no re-preparation
 * against later settings or history). */
export interface FailedSendRecord {
  threadId: string;
  /** Stable id of the failed user message (null for legacy rows). */
  userMessageId: string | null;
  /** The message key the Retry action uses (stable id or fallback key). */
  messageKey: string;
  request: PreparedChatRequest;
  error: string;
}

const failedSends = new Map<string, FailedSendRecord>();
const failedSendListeners = new Set<() => void>();
let failedSendsRevision = 0;

/** Retained failures are bounded: the oldest are evicted (F07). */
export const MAX_RETAINED_FAILURES = 20;

function failedSendKey(threadId: string, messageKey: string): string {
  return `${threadId}\u0000${messageKey}`;
}

/** Drop the oldest retained failures beyond the bound. */
function evictFailedSends(): void {
  const excess = failedSends.size - MAX_RETAINED_FAILURES;
  if (excess <= 0) return;
  for (const key of [...failedSends.keys()].slice(0, excess)) {
    failedSends.delete(key);
  }
}

function notifyFailedSends(): void {
  failedSendsRevision += 1;
  for (const listener of failedSendListeners) listener();
}

/** Monotonic failed-send revision (changes only when a failure is
 * remembered, replayed, or forgotten — not on every stream delta). */
export function failedSendsVersion(): number {
  return failedSendsRevision;
}

export function subscribeFailedSends(cb: () => void): () => void {
  failedSendListeners.add(cb);
  return () => failedSendListeners.delete(cb);
}

/** Retain a failed send for Retry (replaces any earlier record for the
 * same thread + message key). F07: the retained request never holds a raw
 * credential — Retry re-resolves the key from the profile's keychain
 * account — and the registry is bounded (oldest evicted first). */
export function rememberFailedSend(record: FailedSendRecord): void {
  const key = failedSendKey(record.threadId, record.messageKey);
  // Re-insert so the newest failure is the last entry (eviction order).
  failedSends.delete(key);
  failedSends.set(key, {
    ...record,
    request: {
      ...record.request,
      config: { ...record.request.config, apiKey: "" },
    },
  });
  evictFailedSends();
  notifyFailedSends();
  notify();
}

/** Look up a retained failure without consuming it. */
export function getFailedSend(
  threadId: string,
  messageKey: string,
): FailedSendRecord | undefined {
  return failedSends.get(failedSendKey(threadId, messageKey));
}

/** Consume a retained failure (Retry replays it exactly once). */
export function takeFailedSend(
  threadId: string,
  messageKey: string,
): FailedSendRecord | undefined {
  const key = failedSendKey(threadId, messageKey);
  const record = failedSends.get(key);
  if (record) {
    failedSends.delete(key);
    notifyFailedSends();
  }
  return record;
}

/** Every retained failure of a conversation (navigation-independent). */
export function failedSendsForThread(threadId: string): FailedSendRecord[] {
  const prefix = `${threadId}\u0000`;
  const records: FailedSendRecord[] = [];
  for (const [key, record] of failedSends) {
    if (key.startsWith(prefix)) records.push(record);
  }
  return records;
}

/** Drop a conversation's retained failures (thread deletion). */
export function forgetFailedSendsForThread(threadId: string): void {
  const prefix = `${threadId}\u0000`;
  let changed = false;
  for (const key of [...failedSends.keys()]) {
    if (key.startsWith(prefix)) {
      failedSends.delete(key);
      changed = true;
    }
  }
  if (changed) {
    notifyFailedSends();
    notify();
  }
}
