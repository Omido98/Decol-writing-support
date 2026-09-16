// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

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
}));

import { sendMessage } from "@/utils/api";
import {
  prepareChatRequest,
  resolveInstructionBoundary,
} from "@/services/chatPrepare";
import { sendChatMessage } from "@/services/chatSend";
import { useChatStore, messageKey, type ChatMessage } from "@/stores/chatStore";
import { useSourceStore } from "@/stores/sourceStore";
import { usePreparedPreview } from "@/components/chat/usePreparedPreview";
import { resetOperations } from "@/services/aiOperations";
import { fakeRepoState, resetFakeRepository } from "@/test/fakeRepository";
import type { ProjectMeta, SourceMeta, ThreadMeta } from "@/types";

const sendMessageMock = sendMessage as unknown as Mock;

const thread: ThreadMeta = {
  id: "th1",
  title: "Thread",
  mode: "text",
  createdAt: "c",
  updatedAt: "u",
};

function msg(
  role: "user" | "assistant",
  content: string,
  over: Partial<ChatMessage> = {},
): ChatMessage {
  return { role, content, timestamp: `t-${content.slice(0, 8)}`, ...over };
}

function setChat(messages: ChatMessage[], over: Record<string, unknown> = {}) {
  useChatStore.setState({
    threads: [thread],
    threadsLoaded: true,
    activeThreadId: "th1",
    threadLoaded: true,
    messages,
    drafts: {},
    threadAttachments: {},
    threadSourcePicks: {},
    brief: null,
    briefIncludedByThread: {},
    error: null,
    threadErrors: {},
    config: {
      ...useChatStore.getState().config,
      apiKey: "test-key",
      baseUrl: "http://localhost",
      model: "test-model",
    },
    ...over,
  });
}

function sourceMeta(id: string, title: string, included: boolean): SourceMeta {
  return {
    id,
    title,
    originalText: `${title} body`,
    contentHash: `hash-${id}`,
    extractionStatus: "ready",
    includedInContext: included,
    verification: "unverified",
    createdAt: "c",
    updatedAt: "u",
  };
}

const projectMeta: ProjectMeta = {
  id: "p1",
  title: "Project",
  createdAt: "c",
  updatedAt: "u",
};

beforeEach(() => {
  resetFakeRepository();
  resetOperations();
  sendMessageMock.mockReset();
  useSourceStore.setState({ sources: [], sourcesLoaded: false, jobs: {} });
  fakeRepoState.threads.set("th1", {
    meta: thread,
    briefJson: null,
    messages: [],
    rev: 0,
  });
});

describe("resolveInstructionBoundary (B14)", () => {
  it("fresh: instruction is the typed text and history is everything before it", () => {
    const messages = [msg("user", "q1"), msg("assistant", "a1")];
    const b = resolveInstructionBoundary(messages, "fresh", { text: " q2 " })!;
    expect(b.instruction).toBe("q2");
    expect(b.history).toHaveLength(2);
  });

  it("regenerate: the instruction is the user message, never the old answer", () => {
    const messages = [msg("user", "q1"), msg("assistant", "OLD ANSWER")];
    const b = resolveInstructionBoundary(messages, "regenerate", {
      regenerateKey: messageKey(messages[1]),
    })!;
    expect(b.instruction).toBe("q1");
    expect(b.history).toHaveLength(0);
  });

  it("retry: the instruction is the failed user message, history is before it", () => {
    const messages = [msg("user", "q1"), msg("user", "failed q", { failed: true })];
    const b = resolveInstructionBoundary(messages, "retry", {
      resendKey: messageKey(messages[1]),
    })!;
    expect(b.instruction).toBe("failed q");
    expect(b.history.map((m) => m.content)).toEqual(["q1"]);
  });
});

describe("prepared request (B14)", () => {
  it("fresh: preview manifest and transport payload are the same prepared object", async () => {
    setChat([msg("user", "earlier q"), msg("assistant", "earlier a")]);
    const prepared = await prepareChatRequest({
      kind: "fresh",
      text: "new question",
    });
    expect(prepared).not.toBeNull();
    expect(prepared!.wireMessages.map((m) => m.content)).toEqual([
      "earlier q",
      "earlier a",
      "new question",
    ]);
    // The wire messages ARE the compiled conversation (minus the system).
    expect(prepared!.wireMessages.map((m) => m.content)).toEqual(
      prepared!.compiled.messages.slice(1).map((m) => m.content),
    );

    sendMessageMock.mockResolvedValue({ content: "answer" });
    await sendChatMessage({ text: "new question" });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [wire, , system] = sendMessageMock.mock.calls[0] as [
      ChatMessage[],
      unknown,
      string,
    ];
    expect(system).toBe(prepared!.compiled.messages[0].content);
    expect(wire.map((m) => ({ role: m.role, content: m.content }))).toEqual(
      prepared!.wireMessages.map((m) => ({ role: m.role, content: m.content })),
    );
  });

  it("regenerate: the old assistant answer is nowhere in the request", async () => {
    setChat([msg("user", "original question"), msg("assistant", "OLD ANSWER")]);
    const prepared = await prepareChatRequest({
      kind: "regenerate",
      regenerateKey: messageKey(useChatStore.getState().messages[1]),
    });
    expect(prepared).not.toBeNull();
    expect(prepared!.instruction).toBe("original question");
    expect(prepared!.wireMessages.map((m) => m.content)).toEqual([
      "original question",
    ]);
    expect(
      prepared!.compiled.messages.some((m) => m.content.includes("OLD ANSWER")),
    ).toBe(false);
  });

  it("retry: the failed message rides as the instruction (not swallowed)", async () => {
    setChat([msg("user", "earlier"), msg("user", "failed q", { failed: true })]);
    const prepared = await prepareChatRequest({
      kind: "retry",
      resendKey: messageKey(useChatStore.getState().messages[1]),
    });
    expect(prepared!.instruction).toBe("failed q");
    expect(prepared!.wireMessages.map((m) => m.content)).toEqual([
      "earlier",
      "failed q",
    ]);
  });

  it("cold source loading is awaited before the payload is compiled", async () => {
    fakeRepoState.sources.set("s1", {
      meta: sourceMeta("s1", "Included source", true),
      passages: [],
      rev: 0,
    });
    setChat([msg("user", "q")]);
    expect(useSourceStore.getState().sourcesLoaded).toBe(false);

    const prepared = await prepareChatRequest({ kind: "fresh", text: "ask" });
    expect(prepared!.compiled.messages[0].content).toContain("Included source");
    expect(
      prepared!.compiled.manifest.some(
        (e) => e.kind === "source" && e.included && e.title === "Included source",
      ),
    ).toBe(true);
  });

  it("an explicit empty pick sends zero source content; undefined follows inclusion", async () => {
    fakeRepoState.sources.set("s1", {
      meta: sourceMeta("s1", "Included source", true),
      passages: [],
      rev: 0,
    });
    setChat([msg("user", "q")]);

    const dflt = await prepareChatRequest({ kind: "fresh", text: "ask" });
    expect(dflt!.compiled.messages[0].content).toContain("Included source");

    useChatStore.setState({ threadSourcePicks: { th1: [] } });
    const none = await prepareChatRequest({ kind: "fresh", text: "ask" });
    expect(none!.compiled.messages[0].content).not.toContain("Included source");
    const sourceEntries = none!.compiled.manifest.filter(
      (e) => e.kind === "source",
    );
    expect(sourceEntries.length).toBe(1);
    expect(sourceEntries[0].included).toBe(false);
    expect(sourceEntries[0].omittedReason).toMatch(/not picked/i);
  });

  it("pending uploads ride the fresh send and are disclosed in the manifest", async () => {
    setChat([msg("user", "q")]);
    useChatStore.setState({
      threadAttachments: {
        th1: {
          library: [],
          files: [
            {
              name: "notes.txt",
              kind: "text",
              content: "FILE CONTENT",
              wordCount: 2,
            },
          ],
        },
      },
    });

    const prepared = await prepareChatRequest({ kind: "fresh", text: "see file" });
    expect(prepared!.systemPrompt).toContain("FILE CONTENT");
    expect(prepared!.consumedAttachments.files.map((f) => f.name)).toEqual([
      "notes.txt",
    ]);
    expect(
      prepared!.compiled.manifest.some((e) =>
        e.title.includes("1 uploaded file"),
      ),
    ).toBe(true);
  });

  it("a changed project brief is part of the prepared system prompt", async () => {
    fakeRepoState.projects.set("p1", {
      meta: projectMeta,
      brief: "BRIEF CONTENT v2",
      rev: 0,
    });
    setChat([msg("user", "q")]);
    useChatStore.setState({
      threads: [{ ...thread, projectId: "p1" }],
    });

    const prepared = await prepareChatRequest({ kind: "fresh", text: "ask" });
    expect(prepared!.projectId).toBe("p1");
    expect(prepared!.compiled.messages[0].content).toContain("BRIEF CONTENT v2");
  });

  it("the preview hook compiles the same manifest the send prepares", async () => {
    setChat([msg("user", "q1"), msg("assistant", "a1")]);
    // Empty draft → the preview prepares the regenerate boundary.
    useChatStore.setState({ drafts: { th1: "" } });

    const { result } = renderHook(() => usePreparedPreview());
    await waitFor(() => expect(result.current).not.toBeNull());

    const prepared = await prepareChatRequest({
      kind: "regenerate",
      regenerateKey: messageKey(useChatStore.getState().messages[1]),
    });
    expect(result.current!.messages.map((m) => m.content)).toEqual(
      prepared!.compiled.messages.map((m) => m.content),
    );
    expect(result.current!.manifest.map((e) => e.title)).toEqual(
      prepared!.compiled.manifest.map((e) => e.title),
    );
  });
});
