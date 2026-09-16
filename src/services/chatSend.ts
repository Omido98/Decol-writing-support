import { useChatStore, messageKey } from "@/stores/chatStore";
import { sendMessage, deslopText } from "@/utils/api";
import {
  admitOperation,
  activeOperationForThread,
  appendOutput,
  getFailedSend,
  isStaleOperation,
  rememberFailedSend,
  settleOperation,
  takeFailedSend,
  type FailedSendRecord,
} from "@/services/aiOperations";
import {
  prepareChatRequest,
  type ChatOperationKind,
  type PreparedChatRequest,
} from "@/services/chatPrepare";
import { loadCredential } from "@/utils/keychain";
import { recordMark, measureTtft, recordCancelLatency } from "@/utils/perfLog";
import type { IncompleteReason } from "@/types";
import type { ChatMessage, FileAttachment } from "@/stores/chatStore";

/**
 * The chat-send pipeline, shared by every chat surface (the full
 * discussion view and the compact assistant): preparation happens ONCE
 * (chatPrepare) and the transport sends exactly that prepared object —
 * the same one the preview renders. The operation service owns the
 * lifetime; commits go to the OWNER thread regardless of what is
 * currently visible, and each conversation admits at most one running
 * operation.
 *
 * Identity (B15): the user message gets a stable id BEFORE insertion and
 * the operation records it. A failed send retains its exact prepared
 * request; Retry replays that snapshot instead of re-preparing against
 * whatever settings/history exist later.
 */

export interface SendChatOptions {
  text?: string;
  /** Existing failed user message to send again in place. */
  resendKey?: string;
  /** Existing assistant message to generate anew (replace on success). */
  regenerateKey?: string;
  files?: FileAttachment[];
}

/** Preparation in flight per conversation: a second click in the same
 * thread must not start another preparation (other threads are free). */
const preparingThreads = new Set<string>();

/**
 * F07: a retained failure never holds a raw credential. Retry re-resolves
 * it from the profile's keychain account (the config carries provider +
 * endpoint, which is the account identity); when it cannot be resolved —
 * the key was forgotten, the credential was session-only, or the keychain
 * is unavailable — the retry fails visibly instead of sending
 * unauthenticated.
 */
async function resolveRetainedCredential(
  record: FailedSendRecord,
): Promise<PreparedChatRequest | null> {
  const { config } = record.request;
  if (config.apiKey) return record.request; // defensive: legacy record
  let key: string | null = null;
  try {
    key = await loadCredential(config.provider, config.baseUrl);
  } catch {
    key = null;
  }
  if (!key) return null;
  return { ...record.request, config: { ...config, apiKey: key } };
}

export async function sendChatMessage(opts: SendChatOptions = {}): Promise<void> {
  const kind: ChatOperationKind = opts.regenerateKey
    ? "regenerate"
    : opts.resendKey
      ? "retry"
      : "fresh";

  const initial = useChatStore.getState();
  const threadId = initial.activeThreadId;
  if (!threadId || !initial.threadLoaded || preparingThreads.has(threadId)) {
    return;
  }
  // Admission BEFORE any await: one running operation per conversation.
  if (activeOperationForThread(threadId)) return;

  // Retry: prefer the retained snapshot of the request that failed —
  // never a re-preparation from current state. Its credential is
  // re-resolved from the keychain (F07) before the request can run.
  let request: PreparedChatRequest | null = null;
  let replaying = false;
  if (kind === "retry" && opts.resendKey) {
    const retained = getFailedSend(threadId, opts.resendKey);
    if (retained) {
      const resolved = await resolveRetainedCredential(retained);
      if (!resolved) {
        useChatStore
          .getState()
          .setThreadError(
            threadId,
            "The saved API key for this retry could not be resolved. " +
              "Re-enter it in Settings, then try again.",
          );
        return;
      }
      request = resolved;
      replaying = true;
    }
  }

  if (!request) {
    preparingThreads.add(threadId);
    try {
      request = await prepareChatRequest({
        kind,
        text: opts.text,
        resendKey: opts.resendKey,
        regenerateKey: opts.regenerateKey,
        files: opts.files,
      });
    } catch (err) {
      useChatStore
        .getState()
        .setThreadError(
          threadId,
          err instanceof Error ? err.message : String(err),
        );
      return;
    } finally {
      preparingThreads.delete(threadId);
    }
  }
  if (!request) return;

  // Ownership across the preparation awaits: never send into another
  // conversation, and never start a second operation in the owner.
  const store = useChatStore.getState();
  if (store.activeThreadId !== threadId || !store.threadLoaded) return;
  if (activeOperationForThread(threadId)) return;

  const now = new Date().toISOString();

  // Fresh sends mint the stable message id BEFORE insertion; retries use
  // the existing message's id; regenerations record the user message
  // that produced the replaced reply.
  let userMessageId: string | null = null;
  let userMessageKey: string | null = null;
  let fresh: ChatMessage | null = null;
  if (kind === "fresh") {
    const instructionMessage =
      request.wireMessages[request.wireMessages.length - 1];
    fresh = {
      id: crypto.randomUUID(),
      role: "user",
      content: request.instruction,
      timestamp: instructionMessage?.timestamp ?? now,
      ...(request.consumedAttachments.files.length > 0
        ? { fileAttachments: request.consumedAttachments.files }
        : {}),
    };
    userMessageId = fresh.id ?? null;
    userMessageKey = messageKey(fresh);
  } else if (kind === "retry") {
    userMessageKey = opts.resendKey ?? null;
    const target = store.messages.find(
      (m) => messageKey(m) === opts.resendKey,
    );
    userMessageId = target?.id ?? null;
  } else if (opts.regenerateKey) {
    const index = store.messages.findIndex(
      (m) => messageKey(m) === opts.regenerateKey,
    );
    for (let i = index - 1; i >= 0; i--) {
      if (store.messages[i].role === "user") {
        userMessageId = store.messages[i].id ?? null;
        break;
      }
    }
  }

  // A failed fresh/retry retains its EXACT prepared request for Retry and
  // flags the owner's message in place when visible (hidden owners keep
  // the retained failure and surface it when opened). Shared by the
  // transport-error and thrown-error paths below.
  const retainFailure = (error: string): void => {
    if (kind !== "regenerate" && userMessageKey) {
      rememberFailedSend({
        threadId,
        userMessageId,
        messageKey: userMessageKey,
        request,
        error,
      });
      const s = useChatStore.getState();
      if (s.activeThreadId === threadId) {
        s.updateMessage(userMessageKey, (m) => ({ ...m, failed: true }));
      }
    }
    useChatStore.getState().setThreadError(threadId, error);
  };

  const op = admitOperation({
    type: kind === "regenerate" ? "regenerate" : kind === "retry" ? "retry" : "chat",
    threadId,
    targetMessageId: opts.resendKey ?? opts.regenerateKey ?? null,
    userMessageId,
    config: request.config,
    // The wire conversation IS the prepared one (history + instruction);
    // the system prompt is the compiled system message.
    systemPrompt: request.compiled.messages[0].content,
    history: request.wireMessages,
    consumedAttachments: request.consumedAttachments,
  });
  if (!op) return; // lost the admission race: nothing was inserted

  // Commit the accepted send: insert the user message / clear the failed
  // marker, and consume the retained snapshot (it lives on the operation
  // from here on).
  if (kind === "fresh" && fresh) {
    useChatStore.getState().setDraft("");
    useChatStore.getState().addMessage(fresh);
  } else if (kind === "retry" && opts.resendKey) {
    // A re-send clears the failed marker immediately so the button
    // disappears while the request is in flight.
    useChatStore
      .getState()
      .updateMessage(opts.resendKey, (m) => ({ ...m, failed: false }));
  }
  if (replaying && opts.resendKey) takeFailedSend(threadId, opts.resendKey);

  op.compiled = request.compiled;
  if (useChatStore.getState().activeThreadId === threadId) {
    useChatStore.getState().setError(null);
  }

  try {
    // Measurements (5.5): time to first token + total duration + request
    // size. Diagnostics only — nothing depends on them.
    const requestChars = request.compiled.messages.reduce(
      (n, m) => n + m.content.length,
      0,
    );
    recordMark({
      kind: "request-size",
      value: requestChars,
      detail: `≈${request.compiled.tokenEstimate} tokens`,
    });
    const stopTtft = measureTtft(`send ${threadId}`);
    const sendStart = performance.now();

    const result = await sendMessage(
      op.history,
      op.config,
      op.systemPrompt,
      {
        signal: op.controller.signal,
        onDelta: (chunk) => {
          // The operation's buffer is authoritative (navigation-
          // independent); every visible surface renders IT, not a global
          // mirror of whichever thread happened to be on screen.
          stopTtft(chunk.length);
          appendOutput(op, chunk);
        },
      },
    );
    recordMark({
      kind: "duration",
      value: Math.round(performance.now() - sendStart),
      detail: result.outcome,
    });
    if (result.outcome === "stopped") {
      // Measured from the Stop click (abortOperation) to this settle,
      // keyed by the operation id (parallel sends keep their own marks).
      recordCancelLatency(op.id, `send ${threadId}`);
    }

    // Terminal settlement — the FIRST settle call wins; ownership is
    // re-checked before every commit below.
    const settled = settleOperation(
      op.id,
      result.outcome === "failed"
        ? "failed"
        : result.outcome === "stopped"
          ? "stopped"
          : "completed",
    );
    if (!settled) return; // settled elsewhere (e.g. invalidated)
    if (isStaleOperation(op)) return; // dataset restored/deleted away

    // B16b: an incomplete-but-usable answer (interrupted/truncated) is
    // COMMITTED with its marker instead of being discarded — the partial
    // must survive the live stream ending or navigating away. Only a
    // failure with no usable content keeps the user message failed and
    // retains the request for Retry.
    const incomplete: IncompleteReason | null =
      result.outcome === "interrupted" || result.outcome === "truncated"
        ? result.outcome
        : null;
    const answeredPartial =
      incomplete !== null && Boolean(op.output.trim() || result.content.trim());

    if (result.error && !answeredPartial) {
      // Retain the EXACT prepared request for Retry.
      retainFailure(result.error);
    } else if (result.stopped) {
      // User stopped mid-answer: keep whatever the OPERATION's buffer
      // holds (never a display buffer cleared by navigation). A service
      // note (e.g. an interrupted research batch) may carry the only text.
      const partial = op.output.trim() ? op.output : result.content;
      if (partial.trim()) {
        const committed = await useChatStore.getState().commitToOwner(
          threadId,
          kind === "regenerate"
            ? { kind: "replace", messageId: opts.regenerateKey!, content: partial }
            : { kind: "append", content: partial },
        );
        if (!committed) return; // owner deleted/restored away
      }
    } else {
      // The operation's buffer is authoritative for streamed text; a
      // non-streamed/mocked transport delivers the text in result.content.
      const text = incomplete !== null && op.output.trim() ? op.output : result.content;
      const committed = await useChatStore.getState().commitToOwner(
        threadId,
        kind === "regenerate"
          ? {
              kind: "replace",
              messageId: opts.regenerateKey!,
              content: text,
              ...(incomplete ? { incomplete } : {}),
            }
          : {
              kind: "append",
              content: text,
              ...(incomplete ? { incomplete } : {}),
            },
      );
      if (!committed) return; // owner deleted/restored away
      // The marker explains the message; the banner explains why.
      if (incomplete && result.error) {
        useChatStore.getState().setThreadError(threadId, result.error);
      }
    }
    // Library attachments apply to the send that used them: clear ONLY
    // the attachments this request consumed (kept on error so a retry
    // reuses them).
    if (!result.error) {
      useChatStore
        .getState()
        .clearThreadAttachments(threadId, op.consumedAttachments);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const settled = settleOperation(op.id, "failed");
    if (settled) retainFailure(message);
  }
}

/**
 * The "Remove AI slop" cleanup for one assistant message, owned by the
 * shared service (B15): at most one cleanup per conversation ACROSS
 * surfaces, the request travels with the operation's abort signal, and
 * the cleaned reply commits to the owner thread even after navigation.
 */
export async function cleanupMessage(key: string): Promise<void> {
  const s = useChatStore.getState();
  const threadId = s.activeThreadId;
  if (!threadId || !s.threadLoaded) return;
  const target = s.messages.find((m) => messageKey(m) === key);
  if (!target || target.role !== "assistant" || !target.content.trim()) return;

  const op = admitOperation({
    type: "cleanup",
    threadId,
    targetMessageId: target.id ?? null,
    config: s.config,
    systemPrompt: "",
    history: [],
  });
  if (!op) return; // a running operation already owns this conversation

  useChatStore.getState().setThreadError(threadId, null);
  let status: "completed" | "failed" | "stopped" | "aborted" = "completed";
  try {
    const result = await deslopText(target.content, op.config, {
      signal: op.controller.signal,
    });
    if (result.error) {
      status = "failed";
      useChatStore.getState().setThreadError(threadId, result.error);
      return;
    }
    if (result.stopped) {
      // An aborted cleanup must not append a half-cleaned reply.
      status = "stopped";
      return;
    }
    const cleaned = result.content.trim();
    // "No changes needed." is a sentinel, not a reply.
    if (!cleaned || /^no changes needed\.?$/i.test(cleaned)) return;
    if (isStaleOperation(op)) {
      status = "aborted";
      return;
    }
    // Commit to the owner regardless of what is visible now.
    await useChatStore
      .getState()
      .commitToOwner(threadId, { kind: "append", content: cleaned });
  } catch (err) {
    status = "failed";
    useChatStore
      .getState()
      .setThreadError(
        threadId,
        err instanceof Error ? err.message : String(err),
      );
  } finally {
    settleOperation(op.id, status);
  }
}
