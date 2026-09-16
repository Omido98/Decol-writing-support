// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

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
}));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

import { invoke } from "@tauri-apps/api/core";
import WorkspaceShell, { fitPanels } from "@/components/workspace/WorkspaceShell";
import { useAppStore } from "@/stores/useAppStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useChatStore } from "@/stores/chatStore";
import { useDraftStore } from "@/stores/draftStore";
import { resetPreferenceState, setPref } from "@/utils/preferences";
import { fakeRepoState, resetFakeRepository } from "@/test/fakeRepository";
import { markdownDocument } from "@/utils/documentCodec";
import type { LibraryTextMeta } from "@/types";

const invokeMock = invoke as Mock;

/** The fake SQLite preferences table backing db_prefs_* calls. */
const prefsTable = new Map<string, string>();

const meta: LibraryTextMeta = {
  id: "doc1",
  title: "My essay",
  textType: "essay",
  createdAt: "c",
  updatedAt: "u",
};

beforeEach(async () => {
  prefsTable.clear();
  resetPreferenceState();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "db_prefs_get":
        return prefsTable.get(String(args.key)) ?? null;
      case "db_prefs_set":
        prefsTable.set(String(args.key), String(args.value));
        return null;
      case "db_prefs_get_all":
        return [...prefsTable.entries()].map(([key, value]) => ({ key, value }));
      default:
        return null;
    }
  });
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

  resetFakeRepository();
  fakeRepoState.texts.set("doc1", {
    meta,
    body: markdownDocument("stored body"),
    versions: [],
    rev: 0,
  });
  useLibraryStore.setState({ texts: [meta], textsLoaded: true, pendingAttachId: null });
  useProjectStore.setState({ projects: [], projectsLoaded: true, pendingBriefProjectId: null });
  useChatStore.setState({
    threads: [],
    threadsLoaded: true,
    activeThreadId: null,
    threadLoaded: true,
    messages: [],
    drafts: {},
    threadAttachments: {},
  });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  useAppStore.setState({
    navigatorCollapsed: false,
    inspectorCollapsed: false,
    inspectorView: "assistant",
    focusMode: false,
    view: { kind: "list" },
  });
  // jsdom is small: pretend the centre fits.
  Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
});

afterEach(() => {
  cleanup();
});

describe("WorkspaceShell", () => {
  it("shows the navigator, the empty-state document pane, and the inspector", async () => {
    render(<WorkspaceShell />);
    expect(screen.getByRole("navigation", { name: /navigator/i })).toBeDefined();
    expect(screen.getByText(/start something new/i)).toBeDefined();
    expect(screen.getByRole("tablist", { name: /inspector views/i })).toBeDefined();
  });

  it("selecting a document in the navigator opens it in the document pane", async () => {
    render(<WorkspaceShell />);
    // Exact match: the row's accessible name is the title alone (the
    // hover actions are "Pin document …"/"Archive document …").
    const row = await screen.findByRole("button", { name: "My essay" });
    fireEvent.click(row);
    await waitFor(() =>
      expect(useAppStore.getState().view).toEqual({ kind: "read", id: "doc1" }),
    );
    // The reader replaces the empty state.
    await screen.findByText(/stored body/i);
  });

  it("collapsing the inspector keeps the assistant mounted (state preserved)", async () => {
    render(<WorkspaceShell />);
    // The assistant view is mounted; collapse it.
    fireEvent.click(screen.getByRole("button", { name: /toggle inspector/i }));
    await waitFor(() =>
      expect(useAppStore.getState().inspectorCollapsed).toBe(true),
    );
    // The assistant tab still exists in the (now hidden) panel; re-expand.
    fireEvent.click(screen.getByRole("button", { name: /show inspector/i }));
    await waitFor(() =>
      expect(useAppStore.getState().inspectorCollapsed).toBe(false),
    );
  });

  it("switching inspector views never remounts the assistant", async () => {
    render(<WorkspaceShell />);
    const assistantTab = screen.getByRole("tab", { name: "Sources" });
    fireEvent.click(assistantTab);
    expect(useAppStore.getState().inspectorView).toBe("sources");
    // The assistant panel is hidden but present in the DOM.
    const assistantPanel = document.getElementById(
      "inspector-panel-assistant",
    );
    expect(assistantPanel).not.toBeNull();
    expect(assistantPanel!.className).toContain("hidden");
  });

  it("the layout persists: toggling a panel writes the shell preference", async () => {
    render(<WorkspaceShell />);
    fireEvent.click(screen.getByRole("button", { name: /toggle navigator/i }));
    await waitFor(() =>
      expect(useAppStore.getState().navigatorCollapsed).toBe(true),
    );
    const persisted = JSON.parse(prefsTable.get("workspace-shell") ?? "{}");
    expect(persisted.navigatorCollapsed).toBe(true);
  });

  it("focus mode hides both side panels", () => {
    useAppStore.setState({ focusMode: true });
    render(<WorkspaceShell />);
    expect(
      screen.queryByRole("navigation", { name: /navigator/i }),
    ).toBeNull();
    expect(screen.queryByRole("tablist", { name: /inspector/i })).toBeNull();
  });

  it("the status bar reports unsaved drafts", () => {
    useDraftStore.setState({
      drafts: {
        "text:doc1": {
          key: "text:doc1",
          kind: "text",
          entityId: "doc1",
          content: "draft",
          meta: null,
          savedAt: null,
          error: null,
          updatedAt: "now",
        },
      },
    });
    render(<WorkspaceShell />);
    expect(screen.getByText(/Unsaved/)).toBeDefined();
  });

  it("does not claim Saved while a preference write is pending", async () => {
    let release: (() => void) | null = null;
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "db_prefs_set") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return null;
        }
        return base(cmd, args);
      },
    );

    const write = setPref("settings", { theme: "dark" });
    render(<WorkspaceShell />);
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getByText(/Saving —/)).toBeDefined();

    release!();
    await write;
    await waitFor(() => expect(screen.getByText("Saved")).toBeDefined());
  });
});

// ── B20c: measured layout, drawers, keyboard resizing, panel state ──

describe("WorkspaceShell measured layout (B20c)", () => {
  const setWindowWidth = (px: number) =>
    Object.defineProperty(window, "innerWidth", { value: px, configurable: true });

  it("hides the inspector first (or both) from the real widths and panel sizes", () => {
    // Defaults at the three acceptance widths.
    expect(fitPanels(1200, false, false, 240, 360)).toEqual({
      hideNavigator: false,
      hideInspector: false,
    });
    expect(fitPanels(1080, false, false, 240, 360)).toEqual({
      hideNavigator: false,
      hideInspector: true,
    });
    expect(fitPanels(900, false, false, 240, 360)).toEqual({
      hideNavigator: false,
      hideInspector: true,
    });
    // Maximum panel widths consume the centre even at 1200.
    expect(fitPanels(1200, false, false, 360, 520)).toEqual({
      hideNavigator: false,
      hideInspector: true,
    });
    // Below the supported minimum both give way (inspector first).
    expect(fitPanels(700, false, false, 360, 520)).toEqual({
      hideNavigator: true,
      hideInspector: true,
    });
    // A user-collapsed panel is a rail, not a hole.
    expect(fitPanels(700, true, true, 360, 520)).toEqual({
      hideNavigator: false,
      hideInspector: false,
    });
  });

  it("keeps both panels inline at 1200px with default widths", () => {
    setWindowWidth(1200);
    render(<WorkspaceShell />);
    expect(
      screen.getByRole("navigation", { name: /workspace navigator/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("tablist", { name: /inspector views/i }),
    ).toBeDefined();
  });

  it("auto-hides the inspector at 1080px, keeps it mounted, and opens it as a drawer", async () => {
    setWindowWidth(1080);
    render(<WorkspaceShell />);

    // The inline navigator stays; the inspector folds to its rail.
    expect(
      screen.getByRole("navigation", { name: /workspace navigator/i }),
    ).toBeDefined();
    expect(
      screen.queryByRole("tablist", { name: /inspector views/i }),
    ).toBeNull();
    // …but it is still mounted (state preserved), just hidden.
    expect(
      screen.getByRole("tablist", {
        name: /inspector views/i,
        hidden: true,
      }),
    ).toBeDefined();

    // The rail is not a dead control: it opens the panel as a drawer.
    fireEvent.click(screen.getByRole("button", { name: /show inspector/i }));
    const drawer = await screen.findByRole("dialog", { name: "Inspector" });
    await waitFor(() =>
      expect(drawer.contains(document.activeElement)).toBe(true),
    );

    // Escape closes it and the rail returns.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /show inspector/i }),
    ).toBeDefined();
  });

  it("resizes both separators with the keyboard and persists the widths", async () => {
    render(<WorkspaceShell />);

    const navigatorHandle = screen.getByRole("separator", {
      name: /resize navigator/i,
    });
    expect(navigatorHandle.getAttribute("aria-valuenow")).toBe("240");
    fireEvent.keyDown(navigatorHandle, { key: "ArrowRight" });
    expect(useAppStore.getState().navigatorWidth).toBe(256);
    expect(
      screen
        .getByRole("separator", { name: /resize navigator/i })
        .getAttribute("aria-valuenow"),
    ).toBe("256");
    fireEvent.keyDown(navigatorHandle, { key: "ArrowLeft" });
    fireEvent.keyDown(navigatorHandle, { key: "ArrowLeft" });
    expect(useAppStore.getState().navigatorWidth).toBe(224);

    const inspectorHandle = screen.getByRole("separator", {
      name: /resize inspector/i,
    });
    expect(inspectorHandle.getAttribute("aria-valuenow")).toBe("360");
    fireEvent.keyDown(inspectorHandle, { key: "ArrowLeft" });
    expect(useAppStore.getState().inspectorWidth).toBe(376);
    fireEvent.keyDown(inspectorHandle, { key: "ArrowRight" });
    fireEvent.keyDown(inspectorHandle, { key: "ArrowRight" });
    expect(useAppStore.getState().inspectorWidth).toBe(344);

    await waitFor(() => {
      const persisted = JSON.parse(prefsTable.get("workspace-shell") ?? "{}");
      expect(persisted.navigatorWidth).toBe(224);
      expect(persisted.inspectorWidth).toBe(344);
    });
  });

  it("preserves navigator-local state across collapse and re-expand", async () => {
    useProjectStore.setState({
      projects: [{ id: "p1", title: "Thesis", createdAt: "c", updatedAt: "u" }],
      projectsLoaded: true,
    });
    render(<WorkspaceShell />);

    fireEvent.click(screen.getByRole("button", { name: /expand thesis/i }));
    expect(
      screen
        .getByRole("button", { name: /collapse thesis/i })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Brief" })).toBeDefined();

    // Collapse the whole navigator (the panel stays mounted, hidden).
    fireEvent.click(screen.getByRole("button", { name: /collapse navigator/i }));
    await waitFor(() =>
      expect(useAppStore.getState().navigatorCollapsed).toBe(true),
    );
    expect(screen.queryByRole("button", { name: "Brief" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /show navigator/i }));
    await waitFor(() =>
      expect(useAppStore.getState().navigatorCollapsed).toBe(false),
    );
    // The project is STILL expanded: local state survived the collapse.
    expect(
      screen
        .getByRole("button", { name: /collapse thesis/i })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Brief" })).toBeDefined();
  });

  it("marks the current row and wires the inspector tab pattern", async () => {
    render(<WorkspaceShell />);

    const row = await screen.findByRole("button", { name: "My essay" });
    fireEvent.click(row);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "My essay" })
          .getAttribute("aria-current"),
      ).toBe("true"),
    );

    const assistant = screen.getByRole("tab", { name: "Assistant" });
    const sources = screen.getByRole("tab", { name: "Sources" });
    expect(assistant.getAttribute("aria-controls")).toBe(
      "inspector-panel-assistant",
    );
    expect(assistant.getAttribute("tabindex")).toBe("0");
    expect(sources.getAttribute("tabindex")).toBe("-1");

    assistant.focus();
    fireEvent.keyDown(assistant, { key: "ArrowRight" });
    expect(useAppStore.getState().inspectorView).toBe("sources");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("tab", { name: "Sources" }),
      ),
    );
    expect(
      screen.getByRole("tab", { name: "Sources" }).getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Sources" }), {
      key: "End",
    });
    expect(useAppStore.getState().inspectorView).toBe("review");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Review" }), {
      key: "Home",
    });
    expect(useAppStore.getState().inspectorView).toBe("assistant");
  });
});
