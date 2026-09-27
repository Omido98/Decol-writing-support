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

import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/chatStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { fakeRepoState, resetFakeRepository } from "../../test/fakeRepository";
import { markdownDocument } from "@/utils/documentCodec";
import type { LibraryTextMeta } from "@/types";

const doc: LibraryTextMeta = {
  id: "doc-1",
  title: "Extractivism notes",
  textType: "essay",
  projectId: "p-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

beforeEach(() => {
  resetFakeRepository();
  fakeRepoState.texts.set(doc.id, {
    meta: doc,
    body: markdownDocument("body"),
    versions: [],
    rev: 0,
  });
  useChatStore.setState({
    threads: [],
    threadsLoaded: true,
    activeThreadId: null,
    threadLoaded: true,
    messages: [],
    drafts: {},
    threadAttachments: {},
    error: null,
    threadErrors: {},
  });
  useLibraryStore.setState({
    texts: [doc],
    textsLoaded: true,
    pendingAttachId: null,
  });
  useAppStore.setState({
    view: { kind: "list" },
    actionError: null,
  });
});

describe("chatAboutText", () => {
  it("starts a new conversation linked to the document's project, named after it, pre-attached", async () => {
    await useAppStore.getState().chatAboutText(doc.id);

    const chat = useChatStore.getState();
    expect(chat.threads).toHaveLength(1);
    const thread = chat.threads[0];
    expect(thread.title).toBe(doc.title);
    expect(thread.mode).toBe("text");
    expect(thread.projectId).toBe("p-1");
    // The document rides the first send; the user still writes the message.
    expect(useLibraryStore.getState().pendingAttachId).toBe(doc.id);
    expect(useAppStore.getState().view).toEqual({
      kind: "discussion",
      id: thread.id,
    });
    // The title is persisted, not only in memory.
    expect(fakeRepoState.threads.get(thread.id)?.meta.title).toBe(doc.title);
  });

  it("reports a document that no longer exists instead of a dead click", async () => {
    await useAppStore.getState().chatAboutText("missing-doc");

    expect(useAppStore.getState().actionError).toMatch(/no longer exists/i);
    expect(useChatStore.getState().threads).toHaveLength(0);
    expect(useAppStore.getState().view).toEqual({ kind: "list" });
  });
});
