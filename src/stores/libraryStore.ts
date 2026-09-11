import { create } from "zustand";
import type { LibraryTextMeta, TextTypeId, TextVersion } from "@/types";
import { saveJson, loadJson, deleteFile } from "@/utils/storage";
import { wordCount } from "@/utils/tokens";

// ──────────────────────────────────────────────
// File layout (inside the app data directory)
// ──────────────────────────────────────────────
// library.json               -> LibraryTextMeta[]
// text_<id>.json             -> { content: string }
// text_<id>.versions.json    -> TextVersion[] (newest first, capped)

/** Maximum number of version snapshots kept per text. */
const MAX_VERSIONS = 20;

function textFile(id: string): string {
  return `text_${id}.json`;
}

function versionsFile(id: string): string {
  return `text_${id}.versions.json`;
}

// ──────────────────────────────────────────────
// Debounced content saves (per text id)
// ──────────────────────────────────────────────

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingContent = new Map<string, string>();

function scheduleContentSave(id: string, content: string) {
  pendingContent.set(id, content);
  const existing = saveTimers.get(id);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    id,
    setTimeout(() => {
      saveTimers.delete(id);
      const value = pendingContent.get(id);
      pendingContent.delete(id);
      if (value !== undefined) void saveJson(textFile(id), { content: value });
    }, 400),
  );
}

/** Flush any pending debounced content saves (called on window close). */
export async function flushLibrarySave(): Promise<void> {
  const ids = [...saveTimers.keys()];
  for (const id of ids) {
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(id);
    const content = pendingContent.get(id);
    pendingContent.delete(id);
    if (content !== undefined) {
      await saveJson(textFile(id), { content });
    }
  }
}

// ──────────────────────────────────────────────
// Store interface
// ──────────────────────────────────────────────

export interface LibraryState {
  /** Metadata of all library texts, newest activity first. */
  texts: LibraryTextMeta[];
  /** Whether the text list has been loaded from disk. */
  textsLoaded: boolean;
  /** Id of a text the user asked to attach in the chat (cross-tab handoff). */
  pendingAttachId: string | null;

  /** Load the text list from disk. */
  loadTexts: () => Promise<void>;

  /** Create a text (optionally with initial title/type/folder/content) and return its id. */
  createText: (initial?: {
    title?: string;
    textType?: TextTypeId;
    folder?: string;
    content?: string;
  }) => Promise<string>;

  /** Update a text's metadata and/or content. Content changes take a version snapshot. */
  updateText: (
    id: string,
    patch: {
      title?: string;
      textType?: TextTypeId;
      folder?: string;
      content?: string;
    },
  ) => Promise<void>;

  /** Delete a text (metadata, content, and version history). */
  deleteText: (id: string) => Promise<void>;

  /** Load the full content of a text on demand. */
  loadTextContent: (id: string) => Promise<string>;

  /** Load the version history of a text, newest first. */
  loadVersions: (id: string) => Promise<TextVersion[]>;

  /** Restore a version's content; the current content is snapshotted first. */
  restoreVersion: (id: string, savedAt: string) => Promise<void>;

  /** Ask the chat tab to attach the given text to its next send. */
  requestAttach: (id: string) => void;

  /** Clear the cross-tab attach request. */
  clearPendingAttach: () => void;
}

// ──────────────────────────────────────────────
// In-memory content cache
// ──────────────────────────────────────────────
// Content on disk lags behind edits (saves are debounced), so version
// snapshots must never read from disk directly. The cache always holds the
// latest known content per text.

const contentCache = new Map<string, string>();

function contentDerivedMeta(content: string) {
  return {
    snippet: content.replace(/\s+/g, " ").trim().slice(0, 180),
    wordCount: wordCount(content),
  };
}

// ──────────────────────────────────────────────
// Version helpers
// ──────────────────────────────────────────────

async function readVersions(id: string): Promise<TextVersion[]> {
  return (await loadJson<TextVersion[]>(versionsFile(id))) ?? [];
}

async function pushVersion(id: string, content: string): Promise<void> {
  const versions = await readVersions(id);
  const snapshot: TextVersion = {
    savedAt: new Date().toISOString(),
    content,
  };
  await saveJson(versionsFile(id), [snapshot, ...versions].slice(0, MAX_VERSIONS));
}

// ──────────────────────────────────────────────
// Store implementation
// ──────────────────────────────────────────────

export const useLibraryStore = create<LibraryState>((set, get) => ({
  texts: [],
  textsLoaded: false,
  pendingAttachId: null,

  loadTexts: async () => {
    const texts = (await loadJson<LibraryTextMeta[]>("library.json")) ?? [];
    texts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    set({ texts, textsLoaded: true });
  },

  createText: async (initial = {}) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const content = initial.content ?? "";
    contentCache.set(id, content);
    const meta: LibraryTextMeta = {
      id,
      title: initial.title?.trim() || "Untitled text",
      textType: initial.textType ?? "other",
      ...(initial.folder !== undefined ? { folder: initial.folder } : {}),
      ...(content ? contentDerivedMeta(content) : {}),
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ texts: [meta, ...s.texts] }));
    await saveJson("library.json", get().texts);
    await saveJson(textFile(id), { content });
    return id;
  },

  updateText: async (id, patch) => {
    const metaChanged =
      patch.title !== undefined ||
      patch.textType !== undefined ||
      patch.folder !== undefined;

    set((s) => ({
      texts: s.texts.map((t) =>
        t.id === id
          ? {
              ...t,
              ...(patch.title !== undefined ? { title: patch.title } : {}),
              ...(patch.textType !== undefined
                ? { textType: patch.textType }
                : {}),
              ...(patch.folder !== undefined ? { folder: patch.folder } : {}),
              ...(patch.content !== undefined
                ? contentDerivedMeta(patch.content)
                : {}),
              updatedAt: new Date().toISOString(),
            }
          : t,
      ),
    }));

    if (metaChanged) {
      await saveJson("library.json", get().texts);
    }

    if (patch.content !== undefined) {
      // Snapshot the content being replaced, but only when it actually
      // differs: re-saving an unchanged text must not create versions.
      const current = await get().loadTextContent(id);
      if (patch.content !== current) {
        await pushVersion(id, current);
      }
      contentCache.set(id, patch.content);
      scheduleContentSave(id, patch.content);
    }
  },

  deleteText: async (id) => {
    set((s) => ({ texts: s.texts.filter((t) => t.id !== id) }));
    await saveJson("library.json", get().texts);
    await deleteFile(textFile(id));
    await deleteFile(versionsFile(id));
    contentCache.delete(id);
  },

  loadTextContent: async (id) => {
    const cached = contentCache.get(id);
    if (cached !== undefined) return cached;
    const data = await loadJson<{ content: string }>(textFile(id));
    const content = data?.content ?? "";
    contentCache.set(id, content);
    return content;
  },

  loadVersions: (id) => readVersions(id),

  restoreVersion: async (id, savedAt) => {
    const versions = await readVersions(id);
    const target = versions.find((v) => v.savedAt === savedAt);
    if (!target) return;

    // Snapshot the current content first, so restoring is lossless —
    // the user can always step back to what they had.
    const current = await get().loadTextContent(id);
    if (current !== target.content) {
      await pushVersion(id, current);
    }
    // Write directly (no second snapshot inside updateText).
    contentCache.set(id, target.content);
    set((s) => ({
      texts: s.texts.map((t) =>
        t.id === id
          ? {
              ...t,
              ...contentDerivedMeta(target.content),
              updatedAt: new Date().toISOString(),
            }
          : t,
      ),
    }));
    scheduleContentSave(id, target.content);
  },

  requestAttach: (id) => set({ pendingAttachId: id }),
  clearPendingAttach: () => set({ pendingAttachId: null }),
}));
