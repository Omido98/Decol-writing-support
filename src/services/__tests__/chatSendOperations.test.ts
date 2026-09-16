// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { waitFor } from "@testing-library/react";

const storage: Record<string, string> = {};

vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => {
    storage[key] = String(value);
  },
  removeItem: (key: string) => {
    delete storage[key];
  },
  clear: () => {
    for (const key of Object.keys(storage)) delete storage[key];
  },
  key: (index: number) => Object.keys(storage)[index] ?? null,
  get length() {
    return Object.keys(storage).length;
  },
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
  exists: vi.fn(),
  BaseDirectory: { AppData: "AppData" },
}));

vi.mock("@/utils/api", () => ({
  sendMessage: vi.fn(),
  deslopText: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { sendMessage, deslopText, type ApiResponse } from "@/utils/api";
import { sendChatMessage, cleanupMessage } from "@/services/chatSend";
import { useChatStore, messageKey, type ApiConfig, type ChatMessage } from "@/stores/chatStore";
import {
  abortOperation,
  activeOperationForThread,
  failedSendsForThread,
  getFailedSend,
  listOperations,
  resetOperations,
} from "@/services/aiOperations";
import { resetFakeRepository, fakeRepoState } from "@/test/fakeRepository";
import { useSourceStore } from "@/stores/sourceStore";
import { clearMarks, recentMarks } from "@/utils/perfLog";
import type { ThreadMeta } from "@/types";

const sendMessageMock = sendMessage as unknown as Mock;
const deslopTextMock = deslopText as unknown as Mock;
const invokeMock = invoke as Mock;

const threads: Record<string, ThreadMeta> = {
  "th-a": { id: "th-a", title: "A", mode: "text", createdAt: "c", updatedAt: "u" },
  "th-b": { id: "th-b", title: "B", mode: "text", createdAt: "c", updatedAt: "u" },
};

function seed() {
  resetFakeRepository();
  resetOperations();
  sendMessageMock.mockReset();
  deslopTextMock.mockReset();
  useSourceStore.setState({ sources: [], sourcesLoaded: false, jobs: {} });
  for (const meta of Object.values(threads)) {
    fakeRepoState.threads.set(meta.id, {
      meta,
      briefJson: null,
      messages: [],
      rev: 0,
    });
  }
  useChatStore.setState({
    threads: Object.values(threads),
    threadsLoaded: true,
    activeThreadId: "th-a",
    threadLoaded: true,
    messages: [],
    drafts: {},
    threadAttachments: {},
    threadSourcePicks: {},
    brief: null,
    briefIncludedByThread: {},
    error: null,
    threadErrors: {},
    config: {
      ...useChatStore.getState().config,
      apiKey: "K1",
      baseUrl: "http://localhost",
      model: "model-1",
    },
  });
}

beforeEach(() => {
  seed();
});

describe("sendChatMessage identity and failure retention (B15)", () => {
  it("a fresh failure flags the message, records its stable id, and exposes Retry", async () => {
    sendMessageMock.mockResolvedValue({ content: "", error: "provider exploded", outcome: "failed" });
    await sendChatMessage({ text: "hello there" });

    const s = useChatStore.getState();
    expect(s.messages).toHaveLength(1);
    const msg = s.messages[0];
    expect(msg.role).toBe("user");
    // The id was minted BEFORE insertion and is recorded on the operation.
    expect(msg.id).toEqual(expect.any(String));
    expect(msg.failed).toBe(true);
    expect(s.error).toBe("provider exploded");

    const record = getFailedSend("th-a", messageKey(msg));
    expect(record).toBeDefined();
    expect(record!.userMessageId).toBe(msg.id);
    expect(record!.request.instruction).toBe("hello there");

    const op = listOperations().find((o) => o.type === "chat");
    expect(op?.userMessageId).toBe(msg.id);
    expect(op?.targetMessageId).toBeNull();
  });

  it("Retry replays the failed request snapshot, not current settings or history", async () => {
    sendMessageMock.mockResolvedValueOnce({ content: "", error: "boom" });
    await sendChatMessage({ text: "original question" });
    const failed = useChatStore.getState().messages[0];
    const key = messageKey(failed);

    // F07: the retained snapshot holds no raw credential.
    expect(getFailedSend("th-a", key)!.request.config.apiKey).toBe("");

    // Settings and conversation change after the failure.
    useChatStore.setState({
      config: { ...useChatStore.getState().config, apiKey: "K2", model: "model-2" },
    });
    useChatStore.getState().addMessage({
      role: "assistant",
      content: "later unrelated reply",
      timestamp: new Date().toISOString(),
    });

    // Restart-like re-resolution: the profile's credential lives in the
    // keychain, not in the retained snapshot.
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "keyring_get" ? "K1" : null,
    );

    sendMessageMock.mockResolvedValueOnce({ content: "the answer" });
    await sendChatMessage({ resendKey: key });

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    const [wire, config] = sendMessageMock.mock.calls[1] as [
      ChatMessage[],
      ApiConfig,
      string,
    ];
    expect(config.model).toBe("model-1");
    expect(config.apiKey).toBe("K1");
    expect(wire.map((m) => m.content)).toEqual(["original question"]);
    expect(wire.some((m) => m.content.includes("unrelated"))).toBe(false);

    // The retained failure was consumed; the reply landed.
    expect(getFailedSend("th-a", key)).toBeUndefined();
    expect(
      useChatStore.getState().messages.some((m) => m.content === "the answer"),
    ).toBe(true);
  });

  it("a Retry whose credential cannot be resolved fails visibly without sending (F07)", async () => {
    sendMessageMock.mockResolvedValueOnce({ content: "", error: "boom" });
    await sendChatMessage({ text: "original question" });
    const key = messageKey(useChatStore.getState().messages[0]);

    // No keychain entry (forgotten key, or a session-only credential that
    // was never persisted).
    invokeMock.mockImplementation(async () => null);

    await sendChatMessage({ resendKey: key });
    // No request left the app; the failure is a normal thread error.
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().error).toContain("could not be resolved");
    // The snapshot stays retained: fixing the key allows another Retry.
    expect(getFailedSend("th-a", key)).toBeDefined();
  });

  it("a failure landing after navigation stays discoverable and does not leak into the other conversation", async () => {
    let resolveSend!: (value: ApiResponse) => void;
    sendMessageMock.mockImplementation(
      () =>
        new Promise<ApiResponse>((resolve) => {
          resolveSend = resolve;
        }),
    );

    const sendPromise = sendChatMessage({ text: "A question" });
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));

    await useChatStore.getState().switchThread("th-b");
    expect(useChatStore.getState().activeThreadId).toBe("th-b");

    resolveSend({ content: "", error: "A failed", outcome: "failed" });
    await sendPromise;

    // No cross-thread banner: B is not the failing owner.
    expect(useChatStore.getState().error).toBeNull();
    // The failure is retained for A only.
    expect(failedSendsForThread("th-a")).toHaveLength(1);
    expect(failedSendsForThread("th-b")).toHaveLength(0);

    // Opening A surfaces the retained failure and its error banner.
    await useChatStore.getState().switchThread("th-a");
    const stored = useChatStore.getState().messages.find((m) => m.role === "user");
    expect(
      failedSendsForThread("th-a").some(
        (f) => f.messageKey === messageKey(stored!),
      ),
    ).toBe(true);
    expect(useChatStore.getState().error).toBe("A failed");
  });

  it("an interrupted response with usable text commits the partial as a marked assistant message", async () => {
    sendMessageMock.mockResolvedValue({
      content: "the half-written answer",
      error: "connection reset mid-stream",
      outcome: "interrupted",
      truncated: true,
    });
    await sendChatMessage({ text: "a question" });

    const s = useChatStore.getState();
    const assistant = s.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe("the half-written answer");
    expect(assistant!.incomplete).toBe("interrupted");
    // A usable partial landed: the user message is NOT flagged failed and
    // no failure snapshot is retained.
    const user = s.messages.find((m) => m.role === "user");
    expect(user!.failed).not.toBe(true);
    expect(failedSendsForThread("th-a")).toHaveLength(0);
    // The error is still explained to the user.
    expect(s.error).toContain("connection reset");

    // The marker survives navigation: switching away and back reloads the
    // thread through the repository (production persistence path).
    await useChatStore.getState().switchThread("th-b");
    await useChatStore.getState().switchThread("th-a");
    const reloaded = useChatStore
      .getState()
      .messages.find((m) => m.role === "assistant");
    expect(reloaded?.content).toBe("the half-written answer");
    expect(reloaded?.incomplete).toBe("interrupted");
  });

  it("a truncated response commits the partial marked truncated", async () => {
    sendMessageMock.mockResolvedValue({
      content: "cut off mid-sentence",
      outcome: "truncated",
      truncated: true,
      finishReason: "length",
    });
    await sendChatMessage({ text: "write a long answer" });

    const assistant = useChatStore
      .getState()
      .messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("cut off mid-sentence");
    expect(assistant?.incomplete).toBe("truncated");
  });

  it("an interrupted partial committed while the owner is hidden keeps its marker on return", async () => {
    let resolveSend!: (value: ApiResponse) => void;
    sendMessageMock.mockImplementation(
      () =>
        new Promise<ApiResponse>((resolve) => {
          resolveSend = resolve;
        }),
    );

    const sendPromise = sendChatMessage({ text: "A question" });
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await useChatStore.getState().switchThread("th-b");

    resolveSend({
      content: "partial while hidden",
      outcome: "interrupted",
      truncated: true,
      error: "cut",
    });
    await sendPromise;

    // The hidden commit goes through the repository (production path),
    // carrying the marker on the stored row.
    const stored = fakeRepoState.threads
      .get("th-a")!
      .messages.find((m) => m.role === "assistant");
    expect(stored?.content).toBe("partial while hidden");
    expect(stored?.incomplete).toBe("interrupted");

    await useChatStore.getState().switchThread("th-a");
    const visible = useChatStore
      .getState()
      .messages.find((m) => m.role === "assistant");
    expect(visible?.incomplete).toBe("interrupted");
  });

  it("a stopped response whose only content is the service note still commits it", async () => {
    sendMessageMock.mockResolvedValue({
      content: "[Research was interrupted before any results were returned.]\n\n",
      stopped: true,
      outcome: "stopped",
    });
    await sendChatMessage({ text: "research this" });

    const assistant = useChatStore
      .getState()
      .messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toContain("Research was interrupted");
    expect(assistant?.incomplete).toBeUndefined();
  });

  it("a stopped send records cancellation latency from the stop request (B22)", async () => {
    clearMarks();
    sendMessageMock.mockImplementation(
      (
        _history: unknown,
        _config: unknown,
        _system: unknown,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise<ApiResponse>((resolve) => {
          options?.signal?.addEventListener("abort", () =>
            resolve({ content: "half", stopped: true, outcome: "stopped" }),
          );
        }),
    );
    void sendChatMessage({ text: "A question" });
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));

    const running = listOperations().find((o) => o.type === "chat");
    expect(running).toBeDefined();
    abortOperation(running!.id);

    await waitFor(() =>
      expect(
        recentMarks().some(
          (m) => m.kind === "cancel-latency" && m.detail === "send th-a",
        ),
      ).toBe(true),
    );
  });

  it("busy state is scoped to the owner conversation", async () => {
    sendMessageMock.mockImplementation(() => new Promise(() => {}));
    void sendChatMessage({ text: "A question" });
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));

    expect(activeOperationForThread("th-a")).toBeDefined();
    await useChatStore.getState().switchThread("th-b");
    expect(activeOperationForThread("th-b")).toBeUndefined();
    await useChatStore.getState().switchThread("th-a");
    expect(activeOperationForThread("th-a")).toBeDefined();
  });
});

describe("cleanupMessage admission and cancellation (B15)", () => {
  function seedAssistant(content = "sloppy draft") {
    useChatStore.setState({
      messages: [
        {
          id: "a-1",
          role: "assistant",
          content,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  }

  it("two surfaces cannot start duplicate cleanup; the request carries the operation signal", async () => {
    seedAssistant();
    let capturedSignal: AbortSignal | undefined;
    deslopTextMock.mockImplementation(
      (_draft: string, _config: ApiConfig, options?: { signal?: AbortSignal }) =>
        new Promise<ApiResponse>((resolve) => {
          capturedSignal = options?.signal;
          options?.signal?.addEventListener("abort", () =>
            resolve({ content: "half", stopped: true, outcome: "stopped" }),
          );
        }),
    );

    const first = cleanupMessage("a-1");
    await waitFor(() => expect(deslopTextMock).toHaveBeenCalledTimes(1));
    // The second surface's click must not start another request.
    await cleanupMessage("a-1");
    expect(deslopTextMock).toHaveBeenCalledTimes(1);

    const running = listOperations().find((o) => o.type === "cleanup");
    expect(running).toBeDefined();
    expect(capturedSignal).toBe(running!.controller.signal);
    abortOperation(running!.id);
    expect(capturedSignal?.aborted).toBe(true);

    await first;
    // An aborted cleanup appends no partial reply.
    expect(
      useChatStore.getState().messages.map((m) => m.content),
    ).toEqual(["sloppy draft"]);
  });

  it("cleanup cannot interleave with a running chat operation in the same conversation", async () => {
    sendMessageMock.mockImplementation(() => new Promise(() => {}));
    void sendChatMessage({ text: "question" });
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));

    useChatStore.getState().addMessage({
      role: "assistant",
      content: "sloppy draft",
      timestamp: new Date().toISOString(),
    });
    const assistant = useChatStore
      .getState()
      .messages.find((m) => m.role === "assistant")!;

    await cleanupMessage(messageKey(assistant));
    expect(deslopTextMock).not.toHaveBeenCalled();
  });

  it("a completed cleanup appends exactly one cleaned reply to the owner", async () => {
    seedAssistant();
    deslopTextMock.mockResolvedValue({ content: "cleaned draft" });
    await cleanupMessage("a-1");
    expect(
      useChatStore
        .getState()
        .messages.filter((m) => m.role === "assistant")
        .map((m) => m.content),
    ).toEqual(["sloppy draft", "cleaned draft"]);
  });
});
