import { describe, it, expect, beforeEach } from "vitest";
import type { ApiConfig } from "@/stores/chatStore";
import {
  startOperation,
  getOperation,
  appendOutput,
  settleOperation,
  abortOperation,
  isStaleOperation,
  invalidateAllOperations,
  activeOperationForThread,
  admitOperation,
  rememberFailedSend,
  getFailedSend,
  takeFailedSend,
  failedSendsForThread,
  forgetFailedSendsForThread,
  resetOperations,
  listOperations,
  MAX_RETAINED_OPERATIONS,
  MAX_RETAINED_FAILURES,
} from "@/services/aiOperations";
import type { PreparedChatRequest } from "@/services/chatPrepare";
import { bumpDatasetGeneration } from "@/utils/backup";

const config: ApiConfig = {
  provider: "zen",
  baseUrl: "https://opencode.ai/zen/v1",
  apiKey: "K1",
  model: "m",
  reasoningEffort: null,
  webSearchEnabled: true,
  deepResearchEnabled: false,
  systemPromptMode: "standard",
  customSystemPrompt: "",
  lastBrief: null,
  keychainAccount: null,
  sessionKeyOnly: false,
};

const history = [
  { id: "u1", role: "user" as const, content: "question", timestamp: "t1" },
];

beforeEach(() => {
  resetOperations();
});

describe("aiOperations", () => {
  it("gives every operation a unique request id and an owner", () => {
    const a = startOperation({ type: "chat", threadId: "thA", config, systemPrompt: "s", history });
    const b = startOperation({ type: "chat", threadId: "thB", config, systemPrompt: "s", history });
    expect(a.id).not.toBe(b.id);
    expect(a.threadId).toBe("thA");
    expect(b.threadId).toBe("thB");
    expect(a.status).toBe("running");
  });

  it("snapshots the request context (later store changes do not leak in)", () => {
    const op = startOperation({
      type: "chat",
      threadId: "thA",
      config,
      systemPrompt: "prompt-v1",
      history,
    });
    config.apiKey = "changed";
    expect(op.config.apiKey).toBe("K1");
    expect(op.systemPrompt).toBe("prompt-v1");
    expect(op.history[0].content).toBe("question");
    // Retrying replays the recorded context, not the live store.
    expect(op.history).not.toBe(history);
  });

  it("keeps the output buffer independent of navigation", () => {
    const op = startOperation({ type: "chat", threadId: "thA", config, systemPrompt: "s", history });
    appendOutput(op, "partial ");
    appendOutput(op, "answer");
    expect(op.output).toBe("partial answer");
    // The buffer survives: navigation is a UI concern, not the op's.
    expect(getOperation(op.id)?.output).toBe("partial answer");
  });

  it("settlement is terminal: the first call wins, later events are ignored", () => {
    const op = startOperation({ type: "chat", threadId: "thA", config, systemPrompt: "s", history });
    expect(settleOperation(op.id, "completed")).not.toBeNull();
    // A late event cannot settle it again or change the status.
    expect(settleOperation(op.id, "failed")).toBeNull();
    appendOutput(op, "LATE");
    expect(getOperation(op.id)?.output).toBe("");
    expect(getOperation(op.id)?.status).toBe("completed");
  });

  it("cleanup operations are abortable and cannot interleave with chat", () => {
    const cleanup = startOperation({ type: "cleanup", threadId: "thA", config, systemPrompt: "", history: [] });
    const chat = startOperation({ type: "chat", threadId: "thA", config, systemPrompt: "s", history });
    abortOperation(cleanup.id);
    expect(getOperation(cleanup.id)?.controller.signal.aborted).toBe(true);
    // The chat operation is untouched by the cleanup's abort.
    expect(getOperation(chat.id)?.controller.signal.aborted).toBe(false);
    // Both are still running until their requests settle; the thread's
    // active operation is one of them.
    expect(activeOperationForThread("thA")).toBeDefined();
    expect(
      listOperations().filter((o) => !o.settled).map((o) => o.id),
    ).toEqual([cleanup.id, chat.id]);
  });

  it("a restore invalidates running operations and marks them stale", () => {
    const op = startOperation({ type: "chat", threadId: "thA", config, systemPrompt: "s", history });
    bumpDatasetGeneration();
    expect(isStaleOperation(op)).toBe(true);
    invalidateAllOperations();
    expect(getOperation(op.id)?.status).toBe("aborted");
    expect(getOperation(op.id)?.controller.signal.aborted).toBe(true);
    // A late completion cannot commit: settle returns null.
    expect(settleOperation(op.id, "completed")).toBeNull();
  });

  it("regeneration carries its target message id", () => {
    const op = startOperation({
      type: "regenerate",
      threadId: "thA",
      targetMessageId: "msg-9",
      config,
      systemPrompt: "s",
      history,
    });
    expect(op.targetMessageId).toBe("msg-9");
    expect(listOperations()).toHaveLength(1);
  });

  it("records the stable user-message id on the operation", () => {
    const op = startOperation({
      type: "chat",
      threadId: "thA",
      userMessageId: "u-7",
      config,
      systemPrompt: "s",
      history,
    });
    expect(op.userMessageId).toBe("u-7");
  });

  it("terminal records keep no credentials", () => {
    const op = startOperation({
      type: "chat",
      threadId: "thA",
      config: { ...config, apiKey: "SECRET" },
      systemPrompt: "s",
      history,
    });
    settleOperation(op.id, "completed");
    expect(getOperation(op.id)?.config.apiKey).toBe("");
    // Aborted (invalidated) records are stripped too.
    const aborted = startOperation({
      type: "chat",
      threadId: "thB",
      config: { ...config, apiKey: "SECRET" },
      systemPrompt: "s",
      history,
    });
    invalidateAllOperations();
    expect(getOperation(aborted.id)?.config.apiKey).toBe("");
  });

  it("bounds finished-operation retention and never evicts a running one", () => {
    const running = startOperation({
      type: "chat",
      threadId: "thRunning",
      config,
      systemPrompt: "s",
      history,
    });
    for (let i = 0; i < MAX_RETAINED_OPERATIONS + 5; i++) {
      const op = startOperation({
        type: "chat",
        threadId: `th-${i}`,
        config,
        systemPrompt: "s",
        history,
      });
      settleOperation(op.id, "completed");
    }
    const retained = listOperations();
    expect(retained).toHaveLength(MAX_RETAINED_OPERATIONS + 1);
    expect(getOperation(running.id)?.status).toBe("running");
    expect(getOperation(running.id)?.output).toBe("");
  });

  it("admits at most one running operation per conversation (across callers)", () => {
    const first = admitOperation({
      type: "chat",
      threadId: "thA",
      config,
      systemPrompt: "s",
      history,
    });
    expect(first).not.toBeNull();
    expect(
      admitOperation({
        type: "cleanup",
        threadId: "thA",
        config,
        systemPrompt: "",
        history: [],
      }),
    ).toBeNull();
    // Other conversations are unaffected.
    expect(
      admitOperation({
        type: "chat",
        threadId: "thB",
        config,
        systemPrompt: "s",
        history,
      }),
    ).not.toBeNull();
    // Settlement frees the conversation.
    settleOperation(first!.id, "completed");
    expect(
      admitOperation({
        type: "chat",
        threadId: "thA",
        config,
        systemPrompt: "s",
        history,
      }),
    ).not.toBeNull();
  });

  it("retains a failed send's prepared snapshot, scoped to its thread", () => {
    const request = {
      kind: "fresh",
      threadId: "thA",
      instruction: "original question",
      config,
    } as unknown as PreparedChatRequest;
    rememberFailedSend({
      threadId: "thA",
      userMessageId: "u-1",
      messageKey: "k-1",
      request,
      error: "provider exploded",
    });
    expect(failedSendsForThread("thA")).toHaveLength(1);
    expect(failedSendsForThread("thB")).toHaveLength(0);
    expect(getFailedSend("thA", "k-1")?.request.instruction).toBe(
      "original question",
    );
    expect(getFailedSend("thA", "k-1")?.userMessageId).toBe("u-1");

    // Consumption is one-shot: Retry replays it exactly once.
    expect(takeFailedSend("thA", "k-1")?.request.instruction).toBe(
      "original question",
    );
    expect(getFailedSend("thA", "k-1")).toBeUndefined();
    expect(takeFailedSend("thA", "k-1")).toBeUndefined();
  });

  it("strips raw credentials from retained failure snapshots (F07)", () => {
    const request = {
      kind: "fresh",
      threadId: "thA",
      instruction: "original question",
      config: { ...config, apiKey: "SECRET" },
    } as unknown as PreparedChatRequest;
    rememberFailedSend({
      threadId: "thA",
      userMessageId: "u-1",
      messageKey: "k-1",
      request,
      error: "provider exploded",
    });
    const retained = getFailedSend("thA", "k-1")!;
    expect(retained.request.config.apiKey).toBe("");
    // The caller's object is not mutated; the request itself is intact.
    expect(request.config.apiKey).toBe("SECRET");
    expect(retained.request.instruction).toBe("original question");
  });

  it("bounds retained failures and evicts the oldest (F07)", () => {
    const make = (n: number) => ({
      threadId: "thA",
      userMessageId: null,
      messageKey: `k-${n}`,
      request: {
        threadId: "thA",
        instruction: `q${n}`,
      } as unknown as PreparedChatRequest,
      error: "e",
    });
    for (let i = 1; i <= MAX_RETAINED_FAILURES + 3; i++) {
      rememberFailedSend(make(i));
    }
    expect(failedSendsForThread("thA")).toHaveLength(MAX_RETAINED_FAILURES);
    expect(getFailedSend("thA", "k-1")).toBeUndefined();
    expect(getFailedSend("thA", "k-2")).toBeUndefined();
    expect(getFailedSend("thA", "k-3")).toBeUndefined();
    expect(
      getFailedSend("thA", `k-${MAX_RETAINED_FAILURES + 3}`),
    ).toBeDefined();

    // Re-remembering an existing failure refreshes its position: a live
    // failure the user can still retry is never the one evicted.
    rememberFailedSend(make(1));
    expect(failedSendsForThread("thA")).toHaveLength(MAX_RETAINED_FAILURES);
    expect(getFailedSend("thA", "k-1")).toBeDefined();
  });

  it("forgets one conversation's failures on deletion, and all on restore", () => {
    const request = { threadId: "thA" } as unknown as PreparedChatRequest;
    rememberFailedSend({ threadId: "thA", userMessageId: null, messageKey: "k", request, error: "e" });
    rememberFailedSend({ threadId: "thB", userMessageId: null, messageKey: "k", request, error: "e" });
    forgetFailedSendsForThread("thA");
    expect(failedSendsForThread("thA")).toHaveLength(0);
    expect(failedSendsForThread("thB")).toHaveLength(1);

    invalidateAllOperations();
    expect(failedSendsForThread("thB")).toHaveLength(0);
  });
});
