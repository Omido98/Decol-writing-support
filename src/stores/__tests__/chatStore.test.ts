import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

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

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  remove: vi.fn(),
  BaseDirectory: { AppData: 22 },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((msg: unknown) => void) | null = null;
  },
}));

import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useChatStore, messageKey, flushChatSave } from "@/stores/chatStore";
import { defaultBrief } from "@/utils/brief";

const writeTextFileMock = writeTextFile as Mock;

beforeEach(async () => {
  // Drain any debounced thread save left over from the previous test so a
  // stale timer cannot fire into the next test's assertions.
  await flushChatSave();
  vi.clearAllMocks();
  for (const key of Object.keys(storage)) delete storage[key];
  useChatStore.setState({
    messages: [],
    brief: null,
    activeThreadId: null,
    threadLoaded: true,
    streamingText: "",
    error: null,
    isSending: false,
    drafts: {},
    config: { ...useChatStore.getState().config, lastBrief: null },
  });
});

describe("messageKey", () => {
  it("distinguishes messages with the same content by timestamp", () => {
    const a = messageKey({ timestamp: "t1", content: "hello world" });
    const b = messageKey({ timestamp: "t2", content: "hello world" });
    expect(a).not.toBe(b);
  });

  it("distinguishes messages with the same timestamp by content", () => {
    const a = messageKey({ timestamp: "t1", content: "aaa" });
    const b = messageKey({ timestamp: "t1", content: "bbb" });
    expect(a).not.toBe(b);
  });
});

describe("updateMessage", () => {
  it("replaces the message matching the key", () => {
    useChatStore.setState({ activeThreadId: "app-1" });
    const msg = {
      role: "user" as const,
      content: "Hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    useChatStore.getState().addMessage(msg);

    useChatStore.getState().updateMessage(messageKey(msg), (m) => ({
      ...m,
      failed: true,
    }));

    expect(useChatStore.getState().messages).toEqual([{ ...msg, failed: true }]);
  });

  it("clears a failed flag when a message is re-sent", () => {
    useChatStore.setState({ activeThreadId: "app-1" });
    const msg = {
      role: "user" as const,
      content: "Hello",
      timestamp: "2026-01-01T00:00:00.000Z",
      failed: true,
    };
    useChatStore.getState().addMessage(msg);

    useChatStore.getState().updateMessage(messageKey(msg), (m) => ({
      ...m,
      failed: false,
    }));

    expect(useChatStore.getState().messages[0].failed).toBe(false);
  });

  it("leaves other messages untouched", () => {
    useChatStore.setState({ activeThreadId: "app-1" });
    const user = {
      role: "user" as const,
      content: "Hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const assistant = {
      role: "assistant" as const,
      content: "Hi there",
      timestamp: "2026-01-01T00:00:01.000Z",
    };
    useChatStore.getState().addMessage(user);
    useChatStore.getState().addMessage(assistant);

    useChatStore.getState().updateMessage(messageKey(assistant), (m) => ({
      ...m,
      content: "Regenerated answer",
    }));

    const [u, a] = useChatStore.getState().messages;
    expect(u).toEqual(user);
    expect(a.content).toBe("Regenerated answer");
  });

  it("does nothing when no message matches the key", () => {
    useChatStore.setState({ activeThreadId: "app-1" });
    const msg = {
      role: "user" as const,
      content: "Hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    useChatStore.getState().addMessage(msg);

    useChatStore.getState().updateMessage("no-such-key", (m) => ({
      ...m,
      failed: true,
    }));

    expect(useChatStore.getState().messages[0].failed).toBeUndefined();
  });
});

describe("thread persistence", () => {
  it("saves the failed flag with the thread on flush", async () => {
    useChatStore.setState({ activeThreadId: "app-1" });
    const msg = {
      role: "user" as const,
      content: "Hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    useChatStore.getState().addMessage(msg);
    useChatStore.getState().updateMessage(messageKey(msg), (m) => ({
      ...m,
      failed: true,
    }));

    await flushChatSave();

    expect(writeTextFileMock).toHaveBeenCalled();
    const threadSave = writeTextFileMock.mock.calls.find(
      ([path]) => path === "chat_app-1.json",
    );
    expect(threadSave).toBeDefined();
    expect(JSON.parse(threadSave![1])).toEqual({
      messages: [{ ...msg, failed: true }],
      brief: null,
    });
  });
});

describe("writing brief persistence", () => {
  it("saves setBrief changes with the thread file", async () => {
    useChatStore.setState({ activeThreadId: "app-1" });
    const brief = defaultBrief();
    brief.topic = "Test topic";
    useChatStore.getState().setBrief(brief);
    await flushChatSave();

    const threadSave = writeTextFileMock.mock.calls.find(
      ([path]) => path === "chat_app-1.json",
    );
    expect(threadSave).toBeDefined();
    expect(JSON.parse(threadSave![1])).toEqual({ messages: [], brief });
  });

  it("migrates old bare-array thread files (brief becomes null)", async () => {
    storage["dws:chat_app-2.json"] = JSON.stringify([
      { role: "user", content: "Hi", timestamp: "t" },
    ]);
    useChatStore.setState({
      activeThreadId: null,
      threads: [
        { id: "app-2", title: "x", createdAt: "t", updatedAt: "t" },
      ],
      threadsLoaded: true,
    });
    await useChatStore.getState().switchThread("app-2");

    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().brief).toBeNull();
  });

  it("loads the brief stored with a thread", async () => {
    const brief = defaultBrief();
    brief.topic = "Loaded topic";
    storage["dws:chat_app-3.json"] = JSON.stringify({ messages: [], brief });
    useChatStore.setState({
      activeThreadId: null,
      threads: [
        { id: "app-3", title: "x", createdAt: "t", updatedAt: "t" },
      ],
      threadsLoaded: true,
    });
    await useChatStore.getState().switchThread("app-3");

    expect(useChatStore.getState().brief).toEqual(brief);
  });

  it("seeds a new thread with the last brief from config", async () => {
    const lastBrief = defaultBrief();
    lastBrief.topic = "Default topic";
    useChatStore.setState({
      config: { ...useChatStore.getState().config, lastBrief },
    });

    await useChatStore.getState().createThread();

    expect(useChatStore.getState().brief?.topic).toBe("Default topic");
    expect(useChatStore.getState().messages).toEqual([]);
  });
});