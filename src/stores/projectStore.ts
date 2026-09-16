import { create } from "zustand";
import type { ProjectMeta } from "@/types";
import { repo } from "@/utils/repository";
import { wordCount } from "@/utils/tokens";

// ──────────────────────────────────────────────
// Store interface
// ──────────────────────────────────────────────

export interface ProjectState {
  /** Metadata of all projects, newest activity first. */
  projects: ProjectMeta[];
  /** Whether the project list has been loaded from disk. */
  projectsLoaded: boolean;
  /** Project whose brief the chat should develop (cross-tab handoff). */
  pendingBriefProjectId: string | null;

  /** Load the project list from the repository. */
  loadProjects: () => Promise<void>;

  /**
   * Make sure the project list has been loaded before any mutation runs.
   * Mutating an uninitialized store overwrote the registry with an empty
   * one (the same cold-start hazard as the library).
   */
  ensureLoaded: () => Promise<void>;

  /** Reload everything from the repository after a backup restore. */
  resetForRestore: () => Promise<void>;

  /** Create a project (optionally with initial title/description/defaults) and return its id. */
  createProject: (initial?: {
    title?: string;
    description?: string;
    references?: string;
  }) => Promise<string>;

  /** Update a project's metadata (and brief meta when content is patched). */
  updateProject: (
    id: string,
    patch: {
      title?: string;
      description?: string;
      /** Pass null to clear a default; omit to leave it untouched. */
      defaultAudience?: ProjectMeta["defaultAudience"] | null;
      defaultTone?: ProjectMeta["defaultTone"] | null;
      defaultCitations?: ProjectMeta["defaultCitations"] | null;
      defaultLanguage?: string | null;
      references?: string;
      briefContent?: string;
    },
  ) => Promise<void>;

  /**
   * Delete a project in one domain operation: the brief is removed and its
   * texts/conversations are unlinked (they survive as standalone).
   */
  deleteProject: (id: string) => Promise<void>;

  /** Load the full brief content of a project on demand. */
  loadBriefContent: (id: string) => Promise<string>;

  /** Ask the chat tab to start a project-brief thread for the project. */
  requestBriefChat: (id: string) => void;

  /** Clear the cross-tab brief-chat request. */
  clearPendingBriefChat: () => void;
}

// ──────────────────────────────────────────────
// In-memory brief cache
// ──────────────────────────────────────────────

const briefCache = new Map<string, string>();

/** In-flight initialization, shared so concurrent mutations await one load. */
let loadPromise: Promise<void> | null = null;

function briefDerivedMeta(content: string) {
  return {
    briefWordCount: wordCount(content),
  };
}

/**
 * Flush pending debounced brief saves and wait until every repository
 * operation has settled (called on window close).
 */
export async function flushProjectSave(): Promise<void> {
  // Drain: fails visibly while earlier project writes are still retained.
  await repo.drainProjectSaves();
  await repo.idle();
}

// ──────────────────────────────────────────────
// Store implementation
// ──────────────────────────────────────────────

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  projectsLoaded: false,
  pendingBriefProjectId: null,

  loadProjects: async () => {
    const projects = await repo.projectsList();
    projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    set({ projects, projectsLoaded: true });
  },

  ensureLoaded: async () => {
    if (get().projectsLoaded) return;
    loadPromise ??= get()
      .loadProjects()
      .finally(() => {
        loadPromise = null;
      });
    await loadPromise;
  },

  resetForRestore: async () => {
    // The restore's maintenance barrier already reset the repository state
    // centrally; only caches are dropped here.
    briefCache.clear();
    loadPromise = null;
    set({ projects: [], projectsLoaded: false, pendingBriefProjectId: null });
    await get().loadProjects();
  },

  createProject: async (initial = {}) => {
    await get().ensureLoaded();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const meta: ProjectMeta = {
      id,
      title: initial.title?.trim() || "Untitled project",
      ...(initial.description?.trim() ? { description: initial.description.trim() } : {}),
      ...(initial.references?.trim() ? { references: initial.references.trim() } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await repo.projectCreate(meta);
    set((s) => ({ projects: [meta, ...s.projects] }));
    return id;
  },

  updateProject: async (id, patch) => {
    await get().ensureLoaded();
    const now = new Date().toISOString();

    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id
          ? {
              ...p,
              ...(patch.title !== undefined ? { title: patch.title } : {}),
              ...(patch.description !== undefined
                ? { description: patch.description }
                : {}),
              ...(patch.defaultAudience !== undefined
                ? patch.defaultAudience
                  ? { defaultAudience: patch.defaultAudience }
                  : { defaultAudience: undefined }
                : {}),
              ...(patch.defaultTone !== undefined
                ? patch.defaultTone
                  ? { defaultTone: patch.defaultTone }
                  : { defaultTone: undefined }
                : {}),
              ...(patch.defaultCitations !== undefined
                ? patch.defaultCitations
                  ? { defaultCitations: patch.defaultCitations }
                  : { defaultCitations: undefined }
                : {}),
              ...(patch.defaultLanguage !== undefined
                ? patch.defaultLanguage
                  ? { defaultLanguage: patch.defaultLanguage }
                  : { defaultLanguage: undefined }
                : {}),
              ...(patch.references !== undefined
                ? { references: patch.references }
                : {}),
              ...(patch.briefContent !== undefined
                ? briefDerivedMeta(patch.briefContent)
                : {}),
              updatedAt: now,
            }
          : p,
      ),
    }));

    const meta = get().projects.find((p) => p.id === id);
    if (!meta) return;

    if (patch.briefContent !== undefined) {
      // One domain save: metadata and brief commit together (debounced).
      briefCache.set(id, patch.briefContent);
      repo.projectScheduleSave(id, {
        meta,
        brief: patch.briefContent,
      });
    } else {
      // Metadata-only change, persisted immediately (acknowledged save).
      await repo.projectSave(id, { meta }).catch(() => {
        // Recorded in the repository's retryable failure registry.
      });
    }
  },

  deleteProject: async (id) => {
    await get().ensureLoaded();
    // The repository cancels the project's pending debounced brief save,
    // so it cannot recreate the file after deletion.
    await repo.projectDelete(id);
    briefCache.delete(id);
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
  },

  loadBriefContent: async (id) => {
    const cached = briefCache.get(id);
    if (cached !== undefined) return cached;
    const content = (await repo.projectBrief(id)) ?? "";
    briefCache.set(id, content);
    return content;
  },

  requestBriefChat: (id) => set({ pendingBriefProjectId: id }),
  clearPendingBriefChat: () => set({ pendingBriefProjectId: null }),
}));
