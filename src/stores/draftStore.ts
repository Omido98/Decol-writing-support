import { create } from "zustand";
import { getPref, setPref } from "@/utils/preferences";

/**
 * Recoverable draft sessions, kept OUT of component state.
 *
 * Manuscript and project-brief drafts survive switching tabs/documents,
 * closing panels, and app restarts. A draft records what the user typed
 * last, whether it has been acknowledged as persisted (explicit Save), and
 * the last save error (retryable; discarding is always explicit).
 *
 * Drafts are application state, not domain data: they persist through the
 * preferences table (never into backups of manuscripts).
 */

/** Where a draft belongs: a library text or a project brief. */
export type DraftKind = "text" | "project-brief";

export interface DraftSession {
  key: string; // `${kind}:${entityId}` (or `text:new` before first save)
  kind: DraftKind;
  entityId: string | null;
  content: string;
  /** Editor metadata (title/type/folder/project) as typed by the user. */
  meta: Record<string, unknown> | null;
  /**
   * True when this record exists only to carry a save error and never
   * claimed a body (F03): recovery must fall back to the stored document
   * instead of treating `content: ""` as an intentionally emptied one.
   * Absent on legacy persisted drafts (treated as false).
   */
  errorOnly?: boolean;
  /** When the last acknowledged persistence happened (null = unsaved). */
  savedAt: string | null;
  /** Last save error; null when the draft is clean or was saved. */
  error: string | null;
  updatedAt: string;
}

interface DraftState {
  drafts: Record<string, DraftSession>;
  /** Whether persisted drafts have been hydrated (start of session). */
  hydrated: boolean;

  /** Load persisted recovery drafts (call once at startup). */
  hydrate: () => Promise<void>;
  /** Record the user's latest typing for a draft session. */
  setDraft: (
    key: string,
    kind: DraftKind,
    entityId: string | null,
    patch: { content?: string; meta?: Record<string, unknown> | null },
  ) => void;
  /** The draft for a key, when one exists. */
  getDraft: (key: string) => DraftSession | null;
  /** Acknowledge persistence of a draft (explicit Save succeeded). */
  markSaved: (key: string) => void;
  /** Record a failed save for the draft (retryable). The exact attempted
   * payload can be supplied so recovery keeps the manuscript that failed;
   * without it, already-typed content is preserved untouched. */
  markError: (
    key: string,
    message: string,
    patch?: { content?: string; meta?: Record<string, unknown> | null },
  ) => void;
  /** Explicitly throw a draft away (user choice; never automatic). */
  clearDraft: (key: string) => void;
}

/** The persisted shape (same as DraftSession, plain JSON). */
type PersistedDrafts = Record<string, DraftSession>;

const DRAFTS_PREF_KEY = "recovery-drafts";

let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** The last preference write this store STARTED (fired debounce). */
let persistChain: Promise<void> = Promise.resolve();

function persistDrafts(drafts: PersistedDrafts): void {
  persistChain = setPref(DRAFTS_PREF_KEY, drafts).catch(() => {
    // A failed recovery-draft write keeps the in-memory draft and retains
    // the payload in the preference layer; a drain surfaces it.
  });
}

function schedulePersist(drafts: PersistedDrafts) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistDrafts(drafts);
  }, 300);
}

export const useDraftStore = create<DraftState>((set, get) => ({
  drafts: {},
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    let persisted: PersistedDrafts | null = null;
    try {
      persisted = await getPref<PersistedDrafts>(DRAFTS_PREF_KEY);
    } catch {
      persisted = null; // unreadable recovery drafts: start clean
    }
    set({ drafts: persisted ?? {}, hydrated: true });
  },

  setDraft: (key, kind, entityId, patch) => {
    set((s) => {
      const existing = s.drafts[key];
      const draft: DraftSession = {
        key,
        kind,
        entityId,
        content: patch.content ?? existing?.content ?? "",
        meta: patch.meta !== undefined ? patch.meta : (existing?.meta ?? null),
        // A supplied content projection (even an empty one) is a body
        // claim; a metadata-only update keeps the previous claim.
        errorOnly:
          patch.content !== undefined
            ? false
            : existing?.errorOnly === true,
        savedAt: null, // new typing invalidates prior acknowledgment
        error: existing?.error ?? null,
        updatedAt: new Date().toISOString(),
      };
      const drafts = { ...s.drafts, [key]: draft };
      schedulePersist(drafts);
      return { drafts };
    });
  },

  getDraft: (key) => get().drafts[key] ?? null,

  markSaved: (key) => {
    set((s) => {
      const existing = s.drafts[key];
      if (!existing) return {};
      const draft: DraftSession = {
        ...existing,
        savedAt: new Date().toISOString(),
        error: null,
      };
      const drafts = { ...s.drafts, [key]: draft };
      schedulePersist(drafts);
      return { drafts };
    });
  },

  markError: (key, message, patch) => {
    set((s) => {
      const existing = s.drafts[key];
      // A failure is ALWAYS recorded, even without prior typing (an
      // explicit Save can fail on a document whose draft was never
      // written): the status must never claim "Saved" after a failure.
      const idPart = key.split(":")[1];
      // A record fabricated without a body (and without an existing body
      // claim) is error-only: it must never masquerade as an intentionally
      // emptied document (F03).
      const errorOnly =
        patch?.content !== undefined
          ? false
          : existing == null
            ? true
            : existing.errorOnly === true;
      const draft: DraftSession = {
        key,
        kind: key.startsWith("project-brief:") ? "project-brief" : "text",
        entityId: existing?.entityId ?? (idPart === "new" ? null : idPart ?? null),
        // The attempted payload when the caller could not have newer text;
        // otherwise the already-typed content stays untouched.
        content: patch?.content ?? existing?.content ?? "",
        meta:
          patch?.meta !== undefined ? patch.meta : (existing?.meta ?? null),
        errorOnly,
        savedAt: null,
        error: message,
        updatedAt: new Date().toISOString(),
      };
      const drafts = { ...s.drafts, [key]: draft };
      schedulePersist(drafts);
      return { drafts };
    });
  },

  clearDraft: (key) => {
    set((s) => {
      if (!(key in s.drafts)) return {};
      const drafts = { ...s.drafts };
      delete drafts[key];
      schedulePersist(drafts);
      return { drafts };
    });
  },
}));

/**
 * Drop every recovery draft after a dataset replacement: they describe the
 * dataset that no longer exists. The restore's privileged drain already
 * awaited in-flight writes; this only clears the in-memory sessions.
 */
export function resetDraftsForRestore(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  useDraftStore.setState({ drafts: {}, hydrated: true });
}

/**
 * Flush the pending recovery-draft persistence (part of the shutdown and
 * relaunch drains: a restart must restore the last typed draft). Waits for
 * a write that ALREADY started as well, not only for a pending debounce.
 */
export async function flushDrafts(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    persistDrafts(useDraftStore.getState().drafts);
  }
  await persistChain;
}
