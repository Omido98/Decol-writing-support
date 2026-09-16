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

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

import { useLibraryStore, flushLibrarySave } from "@/stores/libraryStore";
import { fakeRepoState, resetFakeRepository } from "../../test/fakeRepository";
import { markdownDocument } from "@/utils/documentCodec";
import type { LibraryTextMeta } from "@/types";

/** Seed the fake repository with one existing text. */
function seedText(id: string, title: string, content: string): void {
  const now = "2026-01-01T00:00:00.000Z";
  fakeRepoState.texts.set(id, {
    meta: {
      id,
      title,
      textType: "essay",
      createdAt: now,
      updatedAt: now,
    },
    body: markdownDocument(content),
    versions: [],
    rev: 0,
  });
}

beforeEach(async () => {
  await flushLibrarySave();
  for (const key of Object.keys(storage)) delete storage[key];
  resetFakeRepository();
  useLibraryStore.setState({
    texts: [],
    textsLoaded: false,
    pendingAttachId: null,
  });
});

describe("libraryStore", () => {
  it("creates a text with defaults and derived snippet/word count", async () => {
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

    expect(fakeRepoState.texts.get(id)?.body.content).toBe(
      "First words of the essay body.",
    );
  });

  it("takes a version snapshot only when content actually changes", async () => {
    const id = await useLibraryStore.getState().createText({
      title: "T",
      content: "v1",
    });

    // Unchanged content: no snapshot.
    await useLibraryStore.getState().updateText(id, { content: "v1" });
    expect(fakeRepoState.texts.get(id)!.versions).toHaveLength(0);

    // Changed content: snapshots the replaced content.
    await useLibraryStore.getState().updateText(id, { content: "v2" });
    const versions = fakeRepoState.texts.get(id)!.versions;
    expect(versions).toHaveLength(1);
    expect(versions[0].body.content).toBe("v1");
  });

  it("caps version history at 20 entries", async () => {
    const id = await useLibraryStore.getState().createText({
      title: "T",
      content: "v0",
    });
    for (let i = 1; i <= 25; i++) {
      await useLibraryStore.getState().updateText(id, { content: `v${i}` });
    }
    const versions = fakeRepoState.texts.get(id)!.versions;
    expect(versions).toHaveLength(20);
    expect(versions[0].body.content).toBe("v24");
  });

  it("takes a named snapshot of the current content on demand", async () => {
    const id = await useLibraryStore.getState().createText({
      title: "T",
      content: "version one",
    });
    await useLibraryStore.getState().updateText(id, { content: "version two" });

    await useLibraryStore.getState().createSnapshot(id, "before restructure");

    const versions = await useLibraryStore.getState().loadVersions(id);
    const snap = versions.find((v) => v.label === "before restructure");
    expect(snap).toBeDefined();
    expect(snap!.body.content).toBe("version two");
  });

  it("restores a version losslessly: current content is snapshotted first", async () => {
    const id = await useLibraryStore.getState().createText({
      title: "T",
      content: "original",
    });
    await useLibraryStore.getState().updateText(id, { content: "edited" });
    const versions = await useLibraryStore.getState().loadVersions(id);
    const originalSnapshot = versions.find((v) => v.body.content === "original");
    expect(originalSnapshot).toBeDefined();

    await useLibraryStore.getState().restoreVersion(id, originalSnapshot!.versionId);

    expect((await useLibraryStore.getState().loadTextContent(id)).content).toBe(
      "original",
    );
    // "edited" was snapshotted during the restore, so nothing is lost.
    const after = await useLibraryStore.getState().loadVersions(id);
    expect(after.some((v) => v.body.content === "edited")).toBe(true);
  });

  it("restoreVersion persists the metadata change", async () => {
    const id = await useLibraryStore.getState().createText({
      title: "T",
      content: "original",
    });
    await useLibraryStore.getState().updateText(id, { content: "edited" });
    const versions = await useLibraryStore.getState().loadVersions(id);
    const original = versions.find((v) => v.body.content === "original")!;

    await useLibraryStore.getState().restoreVersion(id, original.versionId);

    const meta = fakeRepoState.texts.get(id)!.meta;
    expect(meta.snippet).toBe("original");
    expect(meta.updatedAt).toBe(useLibraryStore.getState().texts[0].updatedAt);
  });

  it("deleteText removes metadata, content, and versions", async () => {
    const id = await useLibraryStore.getState().createText({
      title: "T",
      content: "body",
    });
    await useLibraryStore.getState().updateText(id, { content: "body2" });
    await useLibraryStore.getState().deleteText(id);

    expect(useLibraryStore.getState().texts).toHaveLength(0);
    expect(fakeRepoState.texts.has(id)).toBe(false);
  });

  it("loading the text list first, then mutating, keeps existing texts", async () => {
    seedText("e1", "Existing", "existing body");

    // Cold start: save straight to the library without visiting it first.
    await useLibraryStore.getState().createText({ title: "From chat" });

    expect([...fakeRepoState.texts.keys()]).toContain("e1");
    expect(useLibraryStore.getState().texts).toHaveLength(2);
  });

  it("loadTexts sorts newest-updated first", async () => {
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
    fakeRepoState.texts.set("a", { meta: older, body: markdownDocument(""), versions: [], rev: 0 });
    fakeRepoState.texts.set("b", { meta: newer, body: markdownDocument(""), versions: [], rev: 0 });

    await useLibraryStore.getState().loadTexts();
    expect(useLibraryStore.getState().texts.map((t) => t.id)).toEqual([
      "b",
      "a",
    ]);
    expect(useLibraryStore.getState().textsLoaded).toBe(true);
  });

  it("flushLibrarySave resolves and leaves no pending saves", async () => {
    const id = await useLibraryStore.getState().createText({
      title: "T",
      content: "before",
    });
    await useLibraryStore.getState().updateText(id, { content: "after" });
    await flushLibrarySave();
    expect(fakeRepoState.texts.get(id)?.body.content).toBe("after");
  });

  it("hands off an attach request between tabs", () => {
    useLibraryStore.getState().requestAttach("t1");
    expect(useLibraryStore.getState().pendingAttachId).toBe("t1");
    useLibraryStore.getState().clearPendingAttach();
    expect(useLibraryStore.getState().pendingAttachId).toBeNull();
  });
});
