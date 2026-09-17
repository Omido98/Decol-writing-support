import { create } from "zustand";
import type { LibraryTextMeta, TextTypeId, TextVersion } from "@/types";
import { repo } from "@/utils/repository";
import { datasetGeneration } from "@/utils/datasetGeneration";
import { useDraftStore } from "@/stores/draftStore";
import {
  markdownDocument,
  type DocumentBody,
} from "@/utils/documentCodec";
import { wordCount } from "@/utils/tokens";

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

  /** Load the text list from the repository. */
  loadTexts: () => Promise<void>;

  /**
   * Make sure the text list has been loaded before any mutation runs.
   * Mutating an uninitialized store wrote an empty registry over the real
   * one (e.g. saving a chat reply on cold start wiped library.json).
   */
  ensureLoaded: () => Promise<void>;

  /**
   * Reload everything from the repository after a backup restore. Clears
   * the content caches — stale cached bodies otherwise overwrite restored
   * files on the next save and hide restored content behind old text.
   */
  resetForRestore: () => Promise<void>;

  /** Create a text (optionally with initial title/type/folder/project/content) and return its id.
   * Content is a markdown string or a full document body (the 4.1 contract). */
  createText: (initial?: {
    title?: string;
    textType?: TextTypeId;
    folder?: string;
    projectId?: string;
    content?: string | DocumentBody;
  }) => Promise<string>;

  /** Update a text's metadata and/or content. Content changes take a version snapshot. */
  updateText: (
    id: string,
    patch: {
      title?: string;
      textType?: TextTypeId;
      folder?: string;
      projectId?: string;
      content?: string | DocumentBody;
    },
  ) => Promise<void>;

  /** Delete a text (metadata, content, and version history). */
  deleteText: (id: string) => Promise<void>;

  /** Pin/archive a text (navigator organization, D3). Metadata-only. */
  setTextState: (
    id: string,
    patch: { archived?: boolean; pinned?: boolean },
  ) => Promise<void>;

  /** Load the full document body of a text on demand. */
  loadTextContent: (id: string) => Promise<DocumentBody>;

  /** Drop the cached optimistic body of a text (explicit discard): the
   * next load reads the persisted content again. */
  invalidateTextContent: (id: string) => void;

  /** Load the version history of a text, newest first. */
  loadVersions: (id: string) => Promise<TextVersion[]>;

  /** Take a user-named snapshot of the current content. */
  createSnapshot: (id: string, label: string) => Promise<void>;

  /** Restore a version's content; the current content is snapshotted first. */
  restoreVersion: (id: string, versionId: string) => Promise<void>;

  /** Ask the chat tab to attach the given text to its next send. */
  requestAttach: (id: string) => void;

  /** Clear the cross-tab attach request. */
  clearPendingAttach: () => void;
}

// ──────────────────────────────────────────────
// In-memory content cache
// ──────────────────────────────────────────────
// Content saves are debounced inside the repository, so version snapshots
// must never read from the repository directly. The cache always holds the
// latest known body per text. The store API takes markdown strings (every
// current producer writes markdown) and wraps them into the versioned
// document contract; rich bodies arrive as DocumentBody directly.

const contentCache = new Map<string, DocumentBody>();

/** Cache bound (5.5): long sessions must not grow the cache without
 * limit; the newest entries survive eviction (insertion-order recency). */
const CONTENT_CACHE_MAX = 40;

function cacheBody(id: string, body: DocumentBody): void {
  contentCache.delete(id);
  contentCache.set(id, body);
  if (contentCache.size > CONTENT_CACHE_MAX) {
    const oldest = contentCache.keys().next().value;
    if (oldest !== undefined) contentCache.delete(oldest);
  }
}

/** In-flight initialization, shared so concurrent mutations await one load. */
let loadPromise: Promise<void> | null = null;

/** Accept markdown strings or contract bodies; normalize to the contract. */
function normalizeBody(content: string | DocumentBody): DocumentBody {
  return typeof content === "string" ? markdownDocument(content) : content;
}

function contentDerivedMeta(body: DocumentBody) {
  return {
    snippet: body.plainText.replace(/\s+/g, " ").trim().slice(0, 180),
    wordCount: wordCount(body.plainText),
  };
}

/**
 * Flush pending debounced content saves and wait until every repository
 * operation has settled (called on window close). Awaiting the debounce
 * timers alone is not enough — writes already in flight must finish too.
 */
export async function flushLibrarySave(): Promise<void> {
  // Drain: fails visibly while earlier text writes are still retained.
  await repo.drainTextSaves();
  await repo.idle();
}

// ──────────────────────────────────────────────
// Store implementation
// ──────────────────────────────────────────────

export const useLibraryStore = create<LibraryState>((set, get) => ({
  texts: [],
  textsLoaded: false,
  pendingAttachId: null,

  loadTexts: async () => {
    const texts = await repo.textsList();
    texts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    set({ texts, textsLoaded: true });
  },

  ensureLoaded: async () => {
    if (get().textsLoaded) return;
    loadPromise ??= get()
      .loadTexts()
      .finally(() => {
        loadPromise = null;
      });
    await loadPromise;
  },

  resetForRestore: async () => {
    // The restore's maintenance barrier already drained pending saves,
    // discarded held pre-restore ones, and reset the repository state
    // centrally; here we only drop the caches so the restored dataset is
    // the source of truth (never flushed back).
    contentCache.clear();
    loadPromise = null;
    set({ texts: [], textsLoaded: false, pendingAttachId: null });
    await get().loadTexts();
  },

  createText: async (initial = {}) => {
    await get().ensureLoaded();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const body = normalizeBody(initial.content ?? "");
    cacheBody(id, body);
    const meta: LibraryTextMeta = {
      id,
      title: initial.title?.trim() || "Untitled text",
      textType: initial.textType ?? "other",
      ...(initial.folder !== undefined ? { folder: initial.folder } : {}),
      ...(initial.projectId ? { projectId: initial.projectId } : {}),
      ...(initial.content ? contentDerivedMeta(body) : {}),
      createdAt: now,
      updatedAt: now,
    };
    await repo.textCreate(meta, body);
    set((s) => ({ texts: [meta, ...s.texts] }));
    return id;
  },

  updateText: async (id, patch) => {
    await get().ensureLoaded();
    const now = new Date().toISOString();

    const nextBody = patch.content !== undefined ? normalizeBody(patch.content) : undefined;

    set((s) => ({
      texts: s.texts.map((t) =>
        t.id === id
          ? {
              ...t,
              ...(patch.title !== undefined ? { title: patch.title } : {}),
              ...(patch.textType !== undefined
                ? { textType: patch.textType }
                : {}),
              // The folder name is trimmed; an empty string means "no
              // folder" (the key is dropped rather than stored empty).
              ...(patch.folder !== undefined
                ? patch.folder.trim()
                  ? { folder: patch.folder.trim() }
                  : { folder: undefined }
                : {}),
              ...(patch.projectId !== undefined
                ? patch.projectId
                  ? { projectId: patch.projectId }
                  : { projectId: undefined }
                : {}),
              ...(nextBody ? contentDerivedMeta(nextBody) : {}),
              updatedAt: now,
            }
          : t,
      ),
    }));

    const meta = get().texts.find((t) => t.id === id);
    if (!meta) return;

    if (nextBody !== undefined) {
      // One domain save: metadata and body commit together. Whether the
      // replaced content is snapshotted is decided inside the save
      // transaction (by comparing persisted content).
      cacheBody(id, nextBody);
      repo.textScheduleSave(id, {
        meta,
        content: nextBody,
      });
    } else {
      // Metadata-only change, persisted immediately (acknowledged save).
      await repo.textSave(id, { meta }).catch(() => {
        // Recorded in the repository's retryable failure registry; the
        // acknowledged in-memory state stays and the user can retry.
      });
    }
  },

  deleteText: async (id) => {
    await get().ensureLoaded();
    // The repository cancels the text's pending debounced save, so it
    // cannot recreate the file after deletion.
    await repo.textDelete(id);
    contentCache.delete(id);
    set((s) => ({ texts: s.texts.filter((t) => t.id !== id) }));
  },

  /** Navigator organization (D3): pin/archive a text (metadata-only,
   * acknowledged repository op). */
  setTextState: async (id, patch) => {
    await get().ensureLoaded();
    const now = new Date().toISOString();
    await repo.textSetState(id, patch, now);
    set((s) => ({
      texts: s.texts.map((t) =>
        t.id === id
          ? {
              ...t,
              ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
              ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
              updatedAt: now,
            }
          : t,
      ),
    }));
  },

  loadTextContent: async (id) => {
    const cached = contentCache.get(id);
    if (cached !== undefined) return cached;
    const generation = datasetGeneration();
    let body = await repo.textContent(id);
    if (generation !== datasetGeneration()) {
      // The dataset was replaced while this read was in flight: the body
      // belongs to the previous generation. Re-read (and cache) the
      // restored one instead of repopulating stale content.
      body = await repo.textContent(id);
    }
    const resolved = body ?? markdownDocument("");
    cacheBody(id, resolved);
    return resolved;
  },

  invalidateTextContent: (id) => {
    contentCache.delete(id);
  },

  loadVersions: (id) => repo.textVersions(id),

  createSnapshot: async (id, label) => {
    await get().ensureLoaded();
    // The snapshot must capture the newest draft, so flush first (same
    // discipline as restore). No rev bump: content is unchanged.
    const trimmed = label.trim() || "Snapshot";
    await repo.textSnapshot(id, trimmed, new Date().toISOString());
  },

  restoreVersion: async (id, versionId) => {
    await get().ensureLoaded();
    // The backend resolves the target content from its stable version id,
    // snapshots the current content, and commits in one transaction. A
    // failed restore leaves the cache/displaying content untouched.
    const result = await repo.textRestore(id, versionId);
    cacheBody(id, result.body);
    // The restore is an explicit choice of the STORED version: a dirty
    // recovery draft from before it must not silently override the
    // restored content when the editor reopens. The draft is discarded
    // with the restore (HistoryDialog warns when one exists); the
    // replaced persisted content was snapshotted by the backend.
    useDraftStore.getState().clearDraft(`text:${id}`);
    set((s) => ({
      texts: s.texts.map((t) =>
        t.id === id
          ? {
              ...t,
              snippet: result.snippet,
              wordCount: result.wordCount,
              updatedAt: result.updatedAt,
            }
          : t,
      ),
    }));
  },

  requestAttach: (id) => set({ pendingAttachId: id }),
  clearPendingAttach: () => set({ pendingAttachId: null }),
}));
