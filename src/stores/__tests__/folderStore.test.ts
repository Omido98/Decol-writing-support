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

import { useFolderStore } from "@/stores/folderStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useChatStore } from "@/stores/chatStore";
import { fakeRepoState, resetFakeRepository } from "../../test/fakeRepository";
import { markdownDocument } from "@/utils/documentCodec";
import type { LibraryTextMeta, ThreadMeta } from "@/types";

function seedText(meta: LibraryTextMeta) {
  fakeRepoState.texts.set(meta.id, {
    meta,
    body: markdownDocument("body"),
    versions: [],
    rev: 0,
  });
}

function seedThread(meta: ThreadMeta) {
  fakeRepoState.threads.set(meta.id, {
    meta,
    briefJson: null,
    messages: [],
    rev: 0,
  });
}

beforeEach(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  resetFakeRepository();
  useFolderStore.setState({ folders: [], foldersLoaded: false });
  useLibraryStore.setState({ texts: [], textsLoaded: true, pendingAttachId: null });
  useChatStore.setState({
    threads: [],
    threadsLoaded: true,
    activeThreadId: null,
    threadLoaded: true,
    messages: [],
  });
});

describe("folderStore", () => {
  it("creates folders idempotently and loads them sorted", async () => {
    const first = await useFolderStore.getState().createFolder("", "Research");
    const again = await useFolderStore.getState().createFolder("", " Research ");
    expect(again.id).toBe(first.id);
    await useFolderStore.getState().createFolder("p-1", "Drafts");
    expect(useFolderStore.getState().folders).toHaveLength(2);
    // Loaded state is sorted by scope then name.
    expect(useFolderStore.getState().folders.map((f) => `${f.scope}|${f.name}`)).toEqual([
      "|Research",
      "p-1|Drafts",
    ]);
  });

  it("renames a folder and every item in its scope", async () => {
    seedText({
      id: "t-1",
      title: "Standalone draft",
      textType: "essay",
      folder: "Notes",
      createdAt: "t",
      updatedAt: "t",
    });
    seedThread({
      id: "c-1",
      title: "Standalone chat",
      mode: "text",
      folder: "Notes",
      createdAt: "t",
      updatedAt: "t",
    });
    // A project item with the same folder name must NOT move.
    seedThread({
      id: "c-2",
      title: "Project chat",
      mode: "text",
      projectId: "p-1",
      folder: "Notes",
      createdAt: "t",
      updatedAt: "t",
    });
    await useFolderStore.getState().createFolder("", "Notes");

    await useFolderStore.getState().renameFolder("", "Notes", "Archive");

    expect(fakeRepoState.texts.get("t-1")?.meta.folder).toBe("Archive");
    expect(fakeRepoState.threads.get("c-1")?.meta.folder).toBe("Archive");
    expect(fakeRepoState.threads.get("c-2")?.meta.folder).toBe("Notes");
    expect(useFolderStore.getState().folders[0].name).toBe("Archive");
    // The in-memory item stores were refreshed from the repository.
    expect(useLibraryStore.getState().texts[0].folder).toBe("Archive");
    expect(
      useChatStore.getState().threads.find((t) => t.id === "c-1")?.folder,
    ).toBe("Archive");
  });

  it("deletes a folder: its items move out, nothing is deleted", async () => {
    seedText({
      id: "t-1",
      title: "Filed draft",
      textType: "essay",
      folder: "Notes",
      createdAt: "t",
      updatedAt: "t",
    });
    seedThread({
      id: "c-1",
      title: "Filed chat",
      mode: "text",
      folder: "Notes",
      createdAt: "t",
      updatedAt: "t",
    });
    await useFolderStore.getState().createFolder("", "Notes");

    await useFolderStore.getState().deleteFolder("", "Notes");

    expect(fakeRepoState.folders.size).toBe(0);
    expect(fakeRepoState.texts.get("t-1")?.meta.folder).toBeUndefined();
    expect(fakeRepoState.threads.get("c-1")?.meta.folder).toBeUndefined();
    expect(fakeRepoState.texts.has("t-1")).toBe(true);
    expect(fakeRepoState.threads.has("c-1")).toBe(true);
    expect(useLibraryStore.getState().texts[0].folder).toBeUndefined();
    expect(useChatStore.getState().threads[0].folder).toBeUndefined();
  });
});
