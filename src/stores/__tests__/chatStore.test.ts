import { describe, it, expect, vi, beforeEach } from "vitest";

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
  mkdir: vi.fn(),
  BaseDirectory: { AppData: 22 },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((msg: unknown) => void) | null = null;
  },
}));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

import {
  useChatStore,
  messageKey,
  flushChatSave,
  flushComposerAttachments,
  hydrateComposerAttachments,
  resetComposerAttachmentHydration,
} from "@/stores/chatStore";
import {
  fakeRepoState,
  resetFakeRepository,
} from "../../test/fakeRepository";
import { defaultBrief } from "@/utils/brief";

beforeEach(async () => {
  // Drain any debounced thread save left over from the previous test so a
  // stale timer cannot fire into the next test's assertions.
  await flushChatSave();
  for (const key of Object.keys(storage)) delete storage[key];
  resetFakeRepository();
  useChatStore.setState({
    messages: [],
    brief: null,
    activeThreadId: null,
    threadLoaded: true,
    error: null,
    threadErrors: {},
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
    const assistant = {
      role: "assistant" as const,
      content: "Hi there",
      timestamp: "2026-01-01T00:00:01.000Z",
    };
    useChatStore.getState().addMessage(msg);
    useChatStore.getState().addMessage(assistant);

    // Keys come from the STORE's messages (which now carry stable ids).
    const [, storedAssistant] = useChatStore.getState().messages;
    expect(storedAssistant.id).toEqual(expect.any(String));
    useChatStore.getState().updateMessage(messageKey(storedAssistant), (m) => ({
      ...m,
      content: "Regenerated answer",
    }));

    const [u, a] = useChatStore.getState().messages;
    expect(u.content).toBe("Hello");
    expect(u.id).toEqual(expect.any(String));
    expect(a.content).toBe("Regenerated answer");
    expect(a.id).toBe(storedAssistant.id);
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
    const now = "2026-01-01T00:00:00.000Z";
    // Mid-session state: the thread row already exists on disk.
    const meta = {
      id: "app-1",
      title: "Chat",
      mode: "text" as const,
      createdAt: now,
      updatedAt: now,
    };
    fakeRepoState.threads.set("app-1", {
      meta,
      briefJson: null,
      messages: [],
      rev: 0,
    });
    useChatStore.setState({ activeThreadId: "app-1", threads: [meta] });
    const msg = {
      role: "user" as const,
      content: "Hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    useChatStore.getState().addMessage(msg);
    const stored = useChatStore.getState().messages[0];
    useChatStore.getState().updateMessage(messageKey(stored), (m) => ({
      ...m,
      failed: true,
    }));

    await flushChatSave();

    const entry = fakeRepoState.threads.get("app-1");
    expect(entry).toBeDefined();
    expect(entry!.messages).toHaveLength(1);
    expect(entry!.messages[0].failed).toBe(true);
    expect(entry!.messages[0].content).toBe("Hello");
  });

  it("flushes the outgoing thread when switching conversations", async () => {
    const store = useChatStore.getState();
    await store.loadThreads();
    const first = useChatStore.getState().activeThreadId;
    useChatStore.getState().addMessage({
      role: "user",
      content: "Only in this thread",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    // Switch away before the debounce fires; the flush must persist the
    // outgoing thread.
    await useChatStore.getState().switchThread(null);
    await flushChatSave();
    const entry = first ? fakeRepoState.threads.get(first) : null;
    expect(entry).toBeDefined();
    expect(entry!.messages.map((m) => m.content)).toContain(
      "Only in this thread",
    );
  });

  it("a switch to a vanished owner leaves no phantom empty conversation (F10)", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    fakeRepoState.threads.set("alive", {
      meta: { id: "alive", title: "Alive", mode: "text", createdAt: now, updatedAt: now },
      briefJson: null,
      messages: [
        { id: "m1", role: "user", content: "existing question", timestamp: "t1", failed: false, incomplete: null, attachmentsJson: null },
      ],
      rev: 0,
    });
    useChatStore.setState({
      threads: [
        { id: "alive", title: "Alive", mode: "text", createdAt: now, updatedAt: now },
        { id: "gone", title: "Gone", mode: "text", createdAt: now, updatedAt: now },
      ],
    });
    await useChatStore.getState().switchThread("alive");
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual([
      "existing question",
    ]);

    // The owner is deleted while the navigator still lists it: the load
    // finds nothing and must NOT present an empty LOADED conversation
    // under the missing id.
    fakeRepoState.threads.delete("gone");
    const found = await useChatStore.getState().switchThread("gone");
    expect(found).toBe(false);
    const s = useChatStore.getState();
    expect(s.threadLoaded).toBe(false);
    expect(s.messages.map((m) => m.content)).toEqual(["existing question"]);

    // The caller's fallback (loadThreads) finds and loads a real owner.
    await useChatStore.getState().loadThreads();
    const after = useChatStore.getState();
    expect(after.threadLoaded).toBe(true);
    expect(after.activeThreadId).toBe("alive");
  });

  it("assigns stable message ids and migrates old rows without reordering", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    fakeRepoState.threads.set("app-9", {
      meta: { id: "app-9", title: "Chat", mode: "text", createdAt: now, updatedAt: now },
      briefJson: null,
      // Legacy rows: no ids yet.
      messages: [
        { id: null, role: "user", content: "first", timestamp: "t1", failed: false, incomplete: null, attachmentsJson: null },
        { id: null, role: "assistant", content: "second", timestamp: "t2", failed: false, incomplete: null, attachmentsJson: null },
      ],
      rev: 0,
    });
    await useChatStore.getState().switchThread("app-9");
    const migrated = useChatStore.getState().messages;
    // Every message has an id now; order and content are unchanged.
    expect(migrated.map((m) => m.content)).toEqual(["first", "second"]);
    expect(migrated.every((m) => typeof m.id === "string" && m.id)).toBe(true);
    // The next save persists the ids (roundtrip keeps them stable).
    useChatStore.getState().updateMessage(migrated[0].id!, (m) => m);
    await flushChatSave();
    const stored = fakeRepoState.threads.get("app-9")!.messages;
    expect(stored.map((m) => m.id)).toEqual(migrated.map((m) => m.id));
    await useChatStore.getState().switchThread(null);
    await useChatStore.getState().switchThread("app-9");
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(
      migrated.map((m) => m.id),
    );
  });

  it("commitToOwner updates the intended message exactly once after navigation", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    fakeRepoState.threads.set("own", {
      meta: { id: "own", title: "Chat", mode: "text", createdAt: now, updatedAt: now },
      briefJson: null,
      messages: [
        { id: "msg-1", role: "assistant", content: "old reply", timestamp: "t1", failed: false, incomplete: null, attachmentsJson: null },
      ],
      rev: 0,
    });
    useChatStore.setState({
      threads: [{ id: "own", title: "Chat", mode: "text", createdAt: now, updatedAt: now }],
    });
    await useChatStore.getState().switchThread("own");
    const before = useChatStore.getState().messages.map((m) => m.id);

    // The user navigates away; the regeneration lands afterwards.
    await useChatStore.getState().switchThread(null);
    const committed = await useChatStore
      .getState()
      .commitToOwner("own", { kind: "replace", messageId: before[0]!, content: "regenerated" });
    expect(committed).toBe(true);
    const entry = fakeRepoState.threads.get("own")!;
    expect(entry.messages[0].content).toBe("regenerated");
    expect(entry.messages).toHaveLength(1); // exactly once

    // Committing to a deleted owner is refused.
    await useChatStore.getState().deleteThread("own");
    const gone = await useChatStore
      .getState()
      .commitToOwner("own", { kind: "append", content: "late" });
    expect(gone).toBe(false);
  });

  it("appends a completed operation's buffer to a hidden owner thread", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    fakeRepoState.threads.set("own", {
      meta: { id: "own", title: "Chat", mode: "text", createdAt: now, updatedAt: now },
      briefJson: null,
      messages: [],
      rev: 0,
    });
    useChatStore.setState({
      threads: [{ id: "own", title: "Chat", mode: "text", createdAt: now, updatedAt: now }],
    });
    await useChatStore.getState().switchThread("own");
    await useChatStore.getState().switchThread(null);

    const committed = await useChatStore
      .getState()
      .commitToOwner("own", { kind: "append", content: "buffered answer" });
    expect(committed).toBe(true);
    const entry = fakeRepoState.threads.get("own")!;
    expect(entry.messages.map((m) => m.content)).toEqual(["buffered answer"]);
    expect(entry.messages[0].id).toEqual(expect.any(String));
  });

  it("attachments stay in their own conversation (no migration mid-parse)", async () => {
    const store = useChatStore.getState();
    await store.loadThreads();
    const threadA = useChatStore.getState().activeThreadId!;
    useChatStore.getState().setThreadAttachments(threadA, {
      files: [{ name: "doc.txt", kind: "text/plain", content: "parsed" }],
    });
    // Navigate to B while A's parse was still running: B has no files.
    await useChatStore.getState().switchThread(null);
    await useChatStore.getState().createThread();
    const threadB = useChatStore.getState().activeThreadId!;
    expect(useChatStore.getState().getThreadAttachments(threadB).files).toEqual([]);
    // The parse result (starting in A) landed in A's slot, not B's.
    expect(useChatStore.getState().getThreadAttachments(threadA).files).toHaveLength(1);

    // Clearing only the CONSUMED attachments leaves the rest.
    useChatStore.getState().setThreadAttachments(threadA, {
      files: [
        { name: "doc.txt", kind: "text/plain", content: "parsed" },
        { name: "other.txt", kind: "text/plain", content: "kept" },
      ],
    });
    useChatStore.getState().clearThreadAttachments(threadA, {
      library: [],
      files: [{ name: "doc.txt", kind: "text/plain", content: "parsed" }],
    });
    expect(
      useChatStore.getState().getThreadAttachments(threadA).files.map((f) => f.name),
    ).toEqual(["other.txt"]);
  });

  it("loads messages and the stored brief for the active thread", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    fakeRepoState.threads.set("app-2", {
      meta: {
        id: "app-2",
        title: "Chat",
        mode: "text",
        createdAt: now,
        updatedAt: now,
      },
      briefJson: JSON.stringify(defaultBrief()),
      messages: [
        {
          id: null,
          role: "user",
          content: "Hello",
          timestamp: "t1",
          failed: false,
          incomplete: null,
          attachmentsJson: null,
        },
      ],
      rev: 0,
    });
    useChatStore.setState({
      threads: [
        { id: "app-2", title: "Chat", mode: "text", createdAt: now, updatedAt: now },
      ],
    });

    await useChatStore.getState().switchThread("app-2");

    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0].content).toBe("Hello");
    expect(useChatStore.getState().brief).not.toBeNull();
  });

  it("appends an assistant reply to a thread that is not loaded", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    fakeRepoState.threads.set("app-3", {
      meta: {
        id: "app-3",
        title: "Chat",
        mode: "text",
        createdAt: now,
        updatedAt: now,
      },
      briefJson: null,
      messages: [
        {
          id: null,
          role: "user",
          content: "Question",
          timestamp: "t1",
          failed: false,
          incomplete: null,
          attachmentsJson: null,
        },
      ],
      rev: 0,
    });

    await useChatStore
      .getState()
      .appendAssistantToThread("app-3", "Late answer");

    const entry = fakeRepoState.threads.get("app-3")!;
    expect(entry.messages).toHaveLength(2);
    expect(entry.messages[1].role).toBe("assistant");
    expect(entry.messages[1].content).toBe("Late answer");
  });
});

describe("thread titles", () => {
  function firstUserMessage(content: string) {
    return {
      role: "user" as const,
      content,
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }

  function titleAfterMessage(content: string): string {
    useChatStore.setState({
      activeThreadId: "app-1",
      threads: [
        {
          id: "app-1",
          title: "Untitled conversation",
          mode: "text",
          createdAt: "t",
          updatedAt: "t",
        },
      ],
    });
    useChatStore.getState().addMessage(firstUserMessage(content));
    return useChatStore.getState().threads[0].title;
  }

  it("titles a plain question from its first line", () => {
    expect(titleAfterMessage("How do I structure an essay?\nmore text")).toBe(
      "How do I structure an essay?",
    );
  });

  it("titles a structured brief from its Topic field, not the header", () => {
    const title = titleAfterMessage(
      [
        "Writing Brief:",
        "Topic: Land back movements",
        "Background: Academic article",
        "Audience: Academic researchers",
        "",
        "Draft an introduction.",
      ].join("\n"),
    );
    expect(title).toBe("Land back movements");
  });

  it("falls back to the request text when the brief has no topic", () => {
    const title = titleAfterMessage(
      [
        "Writing Brief:",
        "Background: some context",
        "",
        "Outline: an essay about water rights",
      ].join("\n"),
    );
    expect(title).toBe("Outline: an essay about water rights");
  });
});

describe("composer attachment persistence (D2)", () => {
  beforeEach(async () => {
    // Exercise the browser (localStorage) preference path, as the
    // draftStore persistence tests do.
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    await flushComposerAttachments();
    resetComposerAttachmentHydration();
    useChatStore.setState({ threadAttachments: {} });
  });

  it("persists attachments through the debounce and hydrates them into a fresh store", async () => {
    useChatStore.getState().setThreadAttachments("t1", {
      files: [{ name: "a.txt", kind: "text", content: "extracted text" }],
      library: [{ id: "lib1", title: "T", textType: "essay", content: "body" }],
    });
    await flushComposerAttachments();
    expect(storage["dws:pref:composer-attachments"]).toContain("extracted text");

    // A "restart": wipe the in-memory map, hydrate from the prefs.
    useChatStore.setState({ threadAttachments: {} });
    await hydrateComposerAttachments();
    const restored = useChatStore.getState().getThreadAttachments("t1");
    expect(restored.files[0].name).toBe("a.txt");
    expect(restored.library[0].id).toBe("lib1");
  });

  it("persisted attachments follow consumption and deletion", async () => {
    const set = useChatStore.getState().setThreadAttachments;
    set("t1", {
      files: [
        { name: "a.txt", kind: "text", content: "one" },
        { name: "b.txt", kind: "text", content: "two" },
      ],
      library: [],
    });
    // A send consumed one of the two files: only the rest survives.
    useChatStore.getState().clearThreadAttachments("t1", {
      library: [],
      files: [{ name: "a.txt", kind: "text", content: "one" }],
    });
    await flushComposerAttachments();
    useChatStore.setState({ threadAttachments: {} });
    await hydrateComposerAttachments();
    expect(
      useChatStore.getState().getThreadAttachments("t1").files.map((f) => f.name),
    ).toEqual(["b.txt"]);

    // Deleting the thread drops its persisted attachments.
    const id = await useChatStore.getState().createThread();
    useChatStore.getState().setThreadAttachments(id, {
      files: [{ name: "c.txt", kind: "text", content: "three" }],
      library: [],
    });
    await useChatStore.getState().deleteThread(id);
    await flushComposerAttachments();
    expect(storage["dws:pref:composer-attachments"]).not.toContain(id);
  });

  it("oversized attachments stay in memory but are not persisted (bounded)", async () => {
    const huge = "x".repeat(600_000);
    useChatStore.getState().setThreadAttachments("t-big", {
      files: [{ name: "big.pdf", kind: "pdf", content: huge }],
      library: [],
    });
    useChatStore.getState().setThreadAttachments("t-small", {
      files: [{ name: "s.txt", kind: "text", content: "small" }],
      library: [],
    });
    await flushComposerAttachments();
    // In-memory still works (the session is unaffected).
    expect(
      useChatStore.getState().getThreadAttachments("t-big").files[0].name,
    ).toBe("big.pdf");
    // The persisted set keeps the small thread, skips the oversized one.
    const persisted = JSON.parse(
      storage["dws:pref:composer-attachments"],
    ) as Record<string, unknown>;
    expect(persisted["t-small"]).toBeDefined();
    expect(persisted["t-big"]).toBeUndefined();
  });

  it("a restore discards persisted attachments", async () => {
    useChatStore.getState().setThreadAttachments("t1", {
      files: [{ name: "a.txt", kind: "text", content: "pre-restore" }],
      library: [],
    });
    await flushComposerAttachments();
    await useChatStore.getState().reloadAfterRestore();
    await flushComposerAttachments();
    const persisted = JSON.parse(
      storage["dws:pref:composer-attachments"] ?? "{}",
    ) as Record<string, unknown>;
    expect(persisted["t1"]).toBeUndefined();
  });
});
