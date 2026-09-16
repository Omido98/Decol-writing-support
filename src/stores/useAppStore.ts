import { create } from "zustand";
import { getPref, setPref } from "@/utils/preferences";
import { useChatStore } from "@/stores/chatStore";
import type { CslStyleId } from "@/utils/cslProcessor";

/**
 * Workspace state: the document-centred shell's view selection, panel
 * layout, and focus mode. Everything persists (per session) through the
 * preferences store, so returning to the app restores the workspace as it
 * was left.
 */

export type InspectorView = "assistant" | "sources" | "review";

export type WorkspaceView =
  | { kind: "list" }
  | { kind: "manage" }
  | { kind: "read"; id: string }
  | {
      kind: "edit";
      id: string | null;
      /**
       * Unique identity for an UNSAVED document (session draft key).
       * Every new-document view gets its own; two unsaved documents can
       * never share `text:new`.
       */
      sessionId?: string;
      projectId?: string;
      prefill?: { content: string; title?: string; folder?: string };
    }
  | { kind: "project"; id: string }
  | { kind: "discussion"; id?: string | null };

export interface ShellState {
  navigatorCollapsed: boolean;
  inspectorCollapsed: boolean;
  /** Panel widths in px (drag-resizable; clamped). */
  navigatorWidth: number;
  inspectorWidth: number;
  inspectorView: InspectorView;
  focusMode: boolean;
  view: WorkspaceView;
  /** Manuscript font size in px (DESIGN.md: 18px default, user-adjustable). */
  docFontSize: number;
  /** Citation style for bibliography generation (5.4e). */
  cslStyle: CslStyleId;
}

/** Width clamps for the resizable panels. */
export const NAVIGATOR_WIDTH_RANGE = [180, 360] as const;
export const INSPECTOR_WIDTH_RANGE = [280, 520] as const;

interface AppState extends ShellState {
  /** Legacy tab id, derived from the workspace view (compatibility for
   * components that ask "am I in the library or the chat?"). */
  activeTab: "library" | "chat";
  setActiveTab: (tab: "library" | "chat") => void;

  setView: (view: WorkspaceView) => void;
  /** Open a project's page. */
  openProject: (id: string) => void;
  /** Open a document (read view). */
  openText: (id: string) => void;
  /** Open the editor. Saved documents pass the id; a new document gets a
   * fresh session identity so its unsaved draft is its own. */
  openDocument: (options?: {
    id?: string;
    projectId?: string;
    prefill?: { content: string; title?: string; folder?: string };
  }) => void;
  /** Open an unsaved new document (fresh session identity). */
  openNewDocument: (options?: {
    projectId?: string;
    prefill?: { content: string; title?: string; folder?: string };
  }) => void;
  /** Open a conversation; loads its thread when the id is known. */
  openDiscussion: (id: string | null) => void;

  setInspectorView: (view: InspectorView) => void;
  toggleNavigator: () => void;
  toggleInspector: () => void;
  toggleFocusMode: () => void;
  setNavigatorWidth: (px: number) => void;
  setInspectorWidth: (px: number) => void;
  setDocFontSize: (px: number) => void;
  setCslStyle: (style: CslStyleId) => void;

  hydrateShell: () => Promise<void>;
}

const SHELL_PREF_KEY = "workspace-shell";

const DEFAULT_STATE: ShellState = {
  navigatorCollapsed: false,
  inspectorCollapsed: false,
  navigatorWidth: 240,
  inspectorWidth: 360,
  inspectorView: "assistant",
  focusMode: false,
  view: { kind: "list" },
  docFontSize: 18,
  cslStyle: "apa",
};

/** Manuscript size clamps (px). */
export const DOC_FONT_SIZE_RANGE = [14, 26] as const;

function persistShell(state: ShellState) {
  void setPref(SHELL_PREF_KEY, {
    navigatorCollapsed: state.navigatorCollapsed,
    inspectorCollapsed: state.inspectorCollapsed,
    // B20c: both drag/keyboard-resized panel widths persist too.
    navigatorWidth: state.navigatorWidth,
    inspectorWidth: state.inspectorWidth,
    inspectorView: state.inspectorView,
    focusMode: state.focusMode,
    view: state.view,
    docFontSize: state.docFontSize,
    cslStyle: state.cslStyle,
  }).catch(() => {
    // A failed shell write keeps the in-memory layout; the next change
    // retries.
  });
}

export const useAppStore = create<AppState>((set, get) => ({
  ...DEFAULT_STATE,
  activeTab: "chat",

  setActiveTab: (tab) => {
    // Legacy handoffs ("go to the chat tab") map onto workspace views and
    // go through the single conversation navigation action.
    if (tab === "chat") {
      get().openDiscussion(null);
    } else {
      set({ view: { kind: "list" } });
    }
  },

  setView: (view) => {
    set({ view });
    persistShell(get());
  },

  openProject: (id) => get().setView({ kind: "project", id }),
  openText: (id) => get().setView({ kind: "read", id }),

  openDocument: (options = {}) => {
    if (options.id) {
      get().setView({ kind: "edit", id: options.id });
      return;
    }
    get().openNewDocument(options);
  },

  openNewDocument: (options = {}) => {
    get().setView({
      kind: "edit",
      id: null,
      sessionId: crypto.randomUUID(),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.prefill ? { prefill: options.prefill } : {}),
    });
  },

  /**
   * The ONE conversation navigation action. Every surface (navigator,
   * palette, in-chat switcher, restored shell state) goes through it, so the
   * workspace route and the loaded chat owner can never disagree:
   * - the route updates immediately (the navigator highlight follows) and
   *   the requested owner is loaded into the chat store;
   * - composing stays disabled until that load finishes (`threadLoaded`);
   * - an owner that no longer exists (deleted, restored away) falls back
   *   through the thread list, and the route adopts what the fallback
   *   selected;
   * - `null` means "open the assistant": the current owner is adopted, or
   *   the normal thread startup picks/creates one.
   */
  openDiscussion: (id) => {
    const chat = useChatStore.getState();
    if (id == null) {
      if (chat.activeThreadId) {
        get().setView({ kind: "discussion", id: chat.activeThreadId });
        return;
      }
      // The thread list decides (newest existing, or a fresh thread).
      void chat.loadThreads().then(() => {
        const active = useChatStore.getState().activeThreadId;
        get().setView({ kind: "discussion", id: active });
      });
      return;
    }
    get().setView({ kind: "discussion", id });
    void chat.switchThread(id).then((found) => {
      if (found) return;
      void chat.loadThreads().then(() => {
        const active = useChatStore.getState().activeThreadId;
        if (active !== id) get().setView({ kind: "discussion", id: active });
      });
    });
  },

  setInspectorView: (inspectorView) => {
    set({ inspectorView, inspectorCollapsed: false });
    persistShell(get());
  },
  toggleNavigator: () => {
    set((s) => ({ navigatorCollapsed: !s.navigatorCollapsed }));
    persistShell(get());
  },
  toggleInspector: () => {
    set((s) => ({ inspectorCollapsed: !s.inspectorCollapsed }));
    persistShell(get());
  },
  toggleFocusMode: () => {
    set((s) => ({ focusMode: !s.focusMode }));
    persistShell(get());
  },
  setNavigatorWidth: (px) => {
    const [min, max] = NAVIGATOR_WIDTH_RANGE;
    set({ navigatorWidth: Math.min(max, Math.max(min, Math.round(px))) });
    persistShell(get());
  },
  setInspectorWidth: (px) => {
    const [min, max] = INSPECTOR_WIDTH_RANGE;
    set({ inspectorWidth: Math.min(max, Math.max(min, Math.round(px))) });
    persistShell(get());
  },
  setDocFontSize: (px) => {
    const [min, max] = DOC_FONT_SIZE_RANGE;
    set({ docFontSize: Math.min(max, Math.max(min, Math.round(px))) });
    persistShell(get());
  },
  setCslStyle: (cslStyle) => {
    set({ cslStyle });
    persistShell(get());
  },

  hydrateShell: async () => {
    try {
      const persisted = await getPref<ShellState>(SHELL_PREF_KEY);
      if (persisted) {
        set({
          navigatorCollapsed: persisted.navigatorCollapsed ?? false,
          inspectorCollapsed: persisted.inspectorCollapsed ?? false,
          navigatorWidth: persisted.navigatorWidth ?? 240,
          inspectorWidth: persisted.inspectorWidth ?? 360,
          inspectorView: persisted.inspectorView ?? "assistant",
          focusMode: persisted.focusMode ?? false,
          view: persisted.view ?? { kind: "list" },
          docFontSize: persisted.docFontSize ?? 18,
          cslStyle: persisted.cslStyle ?? "apa",
        });
        // A restored conversation selection must LOAD its owner through the
        // single navigation action, not merely restore the route.
        const view = persisted.view ?? DEFAULT_STATE.view;
        if (view.kind === "discussion") {
          get().openDiscussion(view.id ?? null);
        }
      }
    } catch {
      // Unreadable shell state: defaults.
    }
  },
}));
