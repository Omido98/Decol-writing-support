import { create } from "zustand";
import type { ProjectMeta } from "@/types";
import { saveJson, loadJson, deleteFile } from "@/utils/storage";
import { wordCount } from "@/utils/tokens";

// ──────────────────────────────────────────────
// File layout (inside the app data directory)
// ──────────────────────────────────────────────
// projects.json        -> ProjectMeta[]
// project_<id>.json    -> { content: string }  (the brief)

function briefFile(id: string): string {
  return `project_${id}.json`;
}

// ──────────────────────────────────────────────
// Debounced brief saves (per project id)
// ──────────────────────────────────────────────

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingBrief = new Map<string, string>();

function scheduleBriefSave(id: string, content: string) {
  pendingBrief.set(id, content);
  const existing = saveTimers.get(id);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    id,
    setTimeout(() => {
      saveTimers.delete(id);
      const value = pendingBrief.get(id);
      pendingBrief.delete(id);
      if (value !== undefined) void saveJson(briefFile(id), { content: value });
    }, 400),
  );
}

/** Flush any pending debounced brief saves (called on window close). */
export async function flushProjectSave(): Promise<void> {
  const ids = [...saveTimers.keys()];
  for (const id of ids) {
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(id);
    const content = pendingBrief.get(id);
    pendingBrief.delete(id);
    if (content !== undefined) {
      await saveJson(briefFile(id), { content });
    }
  }
}

// ──────────────────────────────────────────────
// In-memory brief cache
// ──────────────────────────────────────────────

const briefCache = new Map<string, string>();

function briefDerivedMeta(content: string) {
  return {
    briefWordCount: wordCount(content),
  };
}

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

  /** Load the project list from disk. */
  loadProjects: () => Promise<void>;

  /** Create a project (optionally with initial title/description/defaults) and return its id. */
  createProject: (initial?: {
    title?: string;
    description?: string;
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
      briefContent?: string;
    },
  ) => Promise<void>;

  /**
   * Delete a project. The brief is removed; the caller is responsible for
   * unlinking the project's texts first (they become standalone).
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
// Store implementation
// ──────────────────────────────────────────────

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  projectsLoaded: false,
  pendingBriefProjectId: null,

  loadProjects: async () => {
    const projects = (await loadJson<ProjectMeta[]>("projects.json")) ?? [];
    projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    set({ projects, projectsLoaded: true });
  },

  createProject: async (initial = {}) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const meta: ProjectMeta = {
      id,
      title: initial.title?.trim() || "Untitled project",
      ...(initial.description?.trim() ? { description: initial.description.trim() } : {}),
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ projects: [meta, ...s.projects] }));
    await saveJson("projects.json", get().projects);
    return id;
  },

  updateProject: async (id, patch) => {
    const metaChanged =
      patch.title !== undefined ||
      patch.description !== undefined ||
      patch.defaultAudience !== undefined ||
      patch.defaultTone !== undefined ||
      patch.defaultCitations !== undefined ||
      patch.defaultLanguage !== undefined ||
      patch.briefContent !== undefined;

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
              ...(patch.briefContent !== undefined
                ? briefDerivedMeta(patch.briefContent)
                : {}),
              updatedAt: new Date().toISOString(),
            }
          : p,
      ),
    }));

    if (metaChanged) {
      await saveJson("projects.json", get().projects);
    }

    if (patch.briefContent !== undefined) {
      briefCache.set(id, patch.briefContent);
      scheduleBriefSave(id, patch.briefContent);
    }
  },

  deleteProject: async (id) => {
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
    await saveJson("projects.json", get().projects);
    await deleteFile(briefFile(id));
    briefCache.delete(id);
  },

  loadBriefContent: async (id) => {
    const cached = briefCache.get(id);
    if (cached !== undefined) return cached;
    const data = await loadJson<{ content: string }>(briefFile(id));
    const content = data?.content ?? "";
    briefCache.set(id, content);
    return content;
  },

  requestBriefChat: (id) => set({ pendingBriefProjectId: id }),
  clearPendingBriefChat: () => set({ pendingBriefProjectId: null }),
}));
