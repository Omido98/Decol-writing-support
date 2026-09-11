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

import {
  writeTextFile,
  readTextFile,
  remove,
} from "@tauri-apps/plugin-fs";
import { useLibraryStore, flushLibrarySave } from "@/stores/libraryStore";
import type { LibraryTextMeta } from "@/types";

const writeMock = writeTextFile as Mock;
const readMock = readTextFile as Mock;
const removeMock = remove as Mock;

/** Simulate the disk: readTextFile serves what writeTextFile stored. */
function useFakeDisk() {
  const files = new Map<string, string>();
  writeMock.mockImplementation(
    async (path: string, content: string) => void files.set(path, content),
  );
  readMock.mockImplementation(async (path: string) => {
    const content = files.get(path);
    if (content === undefined) throw new Error("not found");
    return content;
  });
  removeMock.mockImplementation(
    async (path: string) => void files.delete(path),
  );
  return files;
}

beforeEach(async () => {
  await flushLibrarySave();
  vi.clearAllMocks();
  for (const key of Object.keys(storage)) delete storage[key];
  useLibraryStore.setState({
    texts: [],
    textsLoaded: false,
    pendingAttachId: null,
  });
});

describe("libraryStore", () => {
  it("creates a text with defaults and derived snippet/word count", async () => {
    useFakeDisk();
    const id = await useLibraryStore.getState().createText({
      title: "  My Essay  ",
      content: "First words of the essay body.",
    });

    const texts = useLibraryStore.getState().texts;
    expect(texts).toHaveLength(1);
    const meta = texts[0];
    expect(meta.id).toBe(id);
    expect(meta.title).toBe("My Essay");
    expect(meta.textType).toBe("other");
    expect(meta.wordCount).toBe(6);
    expect(meta.snippet).toBe("First words of the essay body.");

    const contentFile = writeMock.mock.calls.find(
      ([path]) => path === `text_${id}.json`,
    );
    expect(JSON.parse(contentFile![1])).toEqual({
      content: "First words of the essay body.",
    });
  });

  it("takes a version snapshot only when content actually changes", async () => {
    const files = useFakeDisk();
    const id = await useLibraryStore.getState().createText({
      title: "T",
      content: "v1",
    });

    // Unchanged content: no snapshot.
    await useLibraryStore.getState().updateText(id, { content: "v1" });
    let versions = JSON.parse(files.get(`text_${id}.versions.json`) ?? "[]");
    expect(versions).toHaveLength(0);

    // Changed content: snapshots the replaced content.
    await useLibraryStore.getState().updateText(id, { content: "v2" });
    versions = JSON.parse(files.get(`text_${id}.versions.json`) ?? "[]");
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe("v1");
  });

  it("caps version history at 20 entries", async () => {
    const files = useFakeDisk();
    const id = await useLibraryStore.getState().createText({
      title: "T",
      content: "v0",
    });
    for (let i = 1; i <= 25; i++) {
      await useLibraryStore.getState().updateText(id, { content: `v${i}` });
    }
    const versions = JSON.parse(files.get(`text_${id}.versions.json`) ?? "[]");
    expect(versions).toHaveLength(20);
    expect(versions[0].content).toBe("v24");
  });

  it("restores a version losslessly: current content is snapshotted first", async () => {
    useFakeDisk();
    const id = await useLibraryStore.getState().createText({
      title: "T",
      content: "original",
    });
    await useLibraryStore.getState().updateText(id, { content: "edited" });
    const versions = await useLibraryStore.getState().loadVersions(id);
    const originalSnapshot = versions.find(
      (v) => v.content === "original",
    );
    expect(originalSnapshot).toBeDefined();

    await useLibraryStore
      .getState()
      .restoreVersion(id, originalSnapshot!.savedAt);

    expect(await useLibraryStore.getState().loadTextContent(id)).toBe(
      "original",
    );
    // "edited" was snapshotted during the restore, so nothing is lost.
    const after = await useLibraryStore.getState().loadVersions(id);
    expect(after.some((v) => v.content === "edited")).toBe(true);
  });

  it("deleteText removes metadata, content, and versions", async () => {
    const files = useFakeDisk();
    const id = await useLibraryStore.getState().createText({
      title: "T",
      content: "body",
    });
    await useLibraryStore.getState().updateText(id, { content: "body2" });
    await useLibraryStore.getState().deleteText(id);

    expect(useLibraryStore.getState().texts).toHaveLength(0);
    expect(files.has(`text_${id}.json`)).toBe(false);
    expect(files.has(`text_${id}.versions.json`)).toBe(false);
  });

  it("loadTexts sorts newest-updated first", async () => {
    const files = useFakeDisk();
    const older: LibraryTextMeta = {
      id: "a",
      title: "Old",
      textType: "essay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const newer: LibraryTextMeta = {
      id: "b",
      title: "New",
      textType: "article",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    files.set("library.json", JSON.stringify([older, newer]));

    await useLibraryStore.getState().loadTexts();
    expect(useLibraryStore.getState().texts.map((t) => t.id)).toEqual([
      "b",
      "a",
    ]);
    expect(useLibraryStore.getState().textsLoaded).toBe(true);
  });

  it("flushes pending debounced content saves", async () => {
    const files = useFakeDisk();
    const id = await useLibraryStore.getState().createText({
      title: "T",
      content: "before",
    });
    await useLibraryStore.getState().updateText(id, { content: "after" });
    // The content save is debounced; flush must persist it.
    await flushLibrarySave();
    expect(JSON.parse(files.get(`text_${id}.json`) ?? "{}")).toEqual({
      content: "after",
    });
  });

  it("hands off an attach request between tabs", () => {
    useLibraryStore.getState().requestAttach("t1");
    expect(useLibraryStore.getState().pendingAttachId).toBe("t1");
    useLibraryStore.getState().clearPendingAttach();
    expect(useLibraryStore.getState().pendingAttachId).toBeNull();
  });
});
