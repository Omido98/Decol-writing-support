import { create } from "zustand";
import type { FolderMeta } from "@/types";
import { repo } from "@/utils/repository";
import { useLibraryStore } from "@/stores/libraryStore";
import { useChatStore } from "@/stores/chatStore";

/**
 * The navigator folder registry (schema v16): one flat folder list per
 * scope ("" = standalone area, a project id = that project). Membership
 * lives in the items' `folder` name, so the displayed folders are the
 * union of these rows and the names actually present on items.
 */
export interface FolderState {
  folders: FolderMeta[];
  foldersLoaded: boolean;

  /** Load the registry from the repository. */
  loadFolders: () => Promise<void>;
  /** Make sure the registry has been loaded before any mutation runs. */
  ensureLoaded: () => Promise<void>;
  /** Reload from the repository after a backup restore. */
  resetForRestore: () => Promise<void>;

  /** Create a folder (idempotent on scope+name); returns the stored row. */
  createFolder: (scope: string, name: string) => Promise<FolderMeta>;
  /** Rename a folder and every item in it. */
  renameFolder: (
    scope: string,
    oldName: string,
    newName: string,
  ) => Promise<void>;
  /** Delete a folder; its items move OUT (names cleared), nothing deleted. */
  deleteFolder: (scope: string, name: string) => Promise<void>;
}

let loadPromise: Promise<void> | null = null;

/** Case-insensitive name order, grouped by scope. */
function sortFolders(folders: FolderMeta[]): FolderMeta[] {
  return [...folders].sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** The folder change touched items on the backend: refresh the two item
 * inventories so the navigator and every list agree with it. */
async function refreshInventories(): Promise<void> {
  await Promise.all([
    useLibraryStore.getState().loadTexts(),
    useChatStore.getState().loadThreadInventory(),
  ]);
}

export const useFolderStore = create<FolderState>((set, get) => ({
  folders: [],
  foldersLoaded: false,

  loadFolders: async () => {
    const folders = await repo.foldersList();
    set({ folders: sortFolders(folders), foldersLoaded: true });
  },

  ensureLoaded: async () => {
    if (get().foldersLoaded) return;
    loadPromise ??= get()
      .loadFolders()
      .finally(() => {
        loadPromise = null;
      });
    await loadPromise;
  },

  resetForRestore: async () => {
    // The restore's maintenance barrier reset the repository state
    // centrally; here the cache is dropped and re-read.
    loadPromise = null;
    set({ folders: [], foldersLoaded: false });
    await get().loadFolders();
  },

  createFolder: async (scope, name) => {
    await get().ensureLoaded();
    const now = new Date().toISOString();
    const created = await repo.folderCreate({
      id: crypto.randomUUID(),
      scope,
      name: name.trim(),
      createdAt: now,
      updatedAt: now,
    });
    set((s) => ({
      folders: s.folders.some((f) => f.id === created.id)
        ? s.folders
        : sortFolders([...s.folders, created]),
    }));
    return created;
  },

  renameFolder: async (scope, oldName, newName) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    const now = new Date().toISOString();
    await repo.folderRename(scope, oldName, trimmed, now);
    set((s) => ({
      folders: sortFolders(
        s.folders.map((f) =>
          f.scope === scope && f.name === oldName
            ? { ...f, name: trimmed, updatedAt: now }
            : f,
        ),
      ),
    }));
    await refreshInventories();
  },

  deleteFolder: async (scope, name) => {
    await repo.folderDelete(scope, name);
    set((s) => ({
      folders: s.folders.filter(
        (f) => !(f.scope === scope && f.name === name),
      ),
    }));
    await refreshInventories();
  },
}));
