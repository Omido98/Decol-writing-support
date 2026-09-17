// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
  within,
} from "@testing-library/react";

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

// Count markdown parses: a keystroke must never re-parse the conversation.
const markdownState = vi.hoisted(() => ({ renders: 0 }));

vi.mock("react-markdown", () => ({
  default: (props: { children?: unknown }) => {
    markdownState.renders += 1;
    return <div data-testid="markdown-row">{String(props.children ?? "")}</div>;
  },
}));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

import { invoke } from "@tauri-apps/api/core";
import WorkspaceShell from "@/components/workspace/WorkspaceShell";
import { useAppStore } from "@/stores/useAppStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useChatStore } from "@/stores/chatStore";
import { useSourceStore } from "@/stores/sourceStore";
import { useDraftStore } from "@/stores/draftStore";
import { rememberFailedSend, resetOperations } from "@/services/aiOperations";
import type { PreparedChatRequest } from "@/services/chatPrepare";
import {
  fakeRepository,
  fakeRepoState,
  resetFakeRepository,
} from "@/test/fakeRepository";
import type { StoredMessage, ThreadData } from "@/utils/repository";
import type { SourceMeta, ThreadMeta } from "@/types";

const invokeMock = invoke as Mock;

/** The fake SQLite preferences table backing db_prefs_* calls. */
const prefsTable = new Map<string, string>();

const threadA: ThreadMeta = {
  id: "th-a",
  title: "Conversation A",
  mode: "text",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
};

const threadB: ThreadMeta = {
  id: "th-b",
  title: "Conversation B",
  mode: "text",
  createdAt: "2026-02-02T00:00:00.000Z",
  updatedAt: "2026-02-02T00:00:00.000Z",
};

const storedMessage = (id: string, content: string): StoredMessage => ({
  id,
  role: "assistant",
  content,
  timestamp: "2026-02-01T00:00:00.000Z",
  failed: false,
  incomplete: null,
  attachmentsJson: null,
});

const sourceMeta = (id: string): SourceMeta => ({
  id,
  title: `Source ${id}`,
  originalText: "source body",
  contentHash: `hash-${id}`,
  extractionStatus: "ready",
  includedInContext: true,
  verification: "unverified",
  createdAt: "c",
  updatedAt: "u",
});

function seedThreads(): void {
  fakeRepoState.threads.set("th-a", {
    meta: threadA,
    briefJson: null,
    messages: [storedMessage("m-a", "message-from-A")],
    rev: 0,
  });
  fakeRepoState.threads.set("th-b", {
    meta: threadB,
    briefJson: null,
    messages: [storedMessage("m-b", "message-from-B")],
    rev: 0,
  });
  useChatStore.setState({
    threads: [threadB, threadA],
    threadsLoaded: true,
    activeThreadId: "th-a",
    threadLoaded: true,
    messages: [
      {
        id: "m-a",
        role: "assistant",
        content: "message-from-A",
        timestamp: "2026-02-01T00:00:00.000Z",
      },
    ],
    drafts: {},
    threadAttachments: {},
    configLoaded: true,
    error: null,
    threadErrors: {},
  });
  useChatStore.setState({
    config: { ...useChatStore.getState().config, apiKey: "test-key" },
  });
}

beforeEach(() => {
  prefsTable.clear();
  markdownState.renders = 0;
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    async (cmd: string, args: Record<string, unknown>) => {
      switch (cmd) {
        case "db_prefs_get":
          return prefsTable.get(String(args.key)) ?? null;
        case "db_prefs_set":
          prefsTable.set(String(args.key), String(args.value));
          return null;
        case "db_prefs_get_all":
          return [...prefsTable.entries()].map(([key, value]) => ({ key, value }));
        case "zen_list_models":
          return [];
        case "zen_fetch_zen_pricing":
          return [];
        default:
          return null;
      }
    },
  );
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

  resetFakeRepository();
  resetOperations();
  seedThreads();
  useLibraryStore.setState({ texts: [], textsLoaded: true, pendingAttachId: null });
  useProjectStore.setState({
    projects: [],
    projectsLoaded: true,
    pendingBriefProjectId: null,
  });
  useSourceStore.setState({ sources: [], sourcesLoaded: true, jobs: {} });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  useAppStore.setState({
    navigatorCollapsed: false,
    inspectorCollapsed: false,
    inspectorView: "assistant",
    focusMode: false,
    view: { kind: "list" },
    actionError: null,
  });
  Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
});

afterEach(() => {
  cleanup();
});

describe("conversation navigation (B02)", () => {
  it("selecting B from A makes route, messages, active thread, and next send owner all B", async () => {
    render(<WorkspaceShell />);
    fireEvent.click(screen.getByRole("button", { name: "Conversation B" }));

    await waitFor(() =>
      expect(useAppStore.getState().view).toEqual({
        kind: "discussion",
        id: "th-b",
      }),
    );
    await waitFor(() =>
      expect(useChatStore.getState().activeThreadId).toBe("th-b"),
    );
    // Visible messages flipped with the route — never a mix of A and B
    // (the full view and the compact assistant both show B).
    expect((await screen.findAllByText("message-from-B")).length).toBeGreaterThan(0);
    expect(screen.queryAllByText("message-from-A")).toHaveLength(0);
    // The next send reads exactly this owner and history.
    expect(useChatStore.getState().threadLoaded).toBe(true);
    expect(useChatStore.getState().messages[0]?.content).toBe("message-from-B");
  });

  it("disables composing until the requested conversation is loaded", async () => {
    const originalGet = fakeRepository.threadGet.bind(fakeRepository);
    let releaseB: ((value: ThreadData | null) => void) | null = null;
    const spy = vi
      .spyOn(fakeRepository, "threadGet")
      .mockImplementation((id: string) => {
        if (id === "th-b") {
          return new Promise<ThreadData | null>((resolve) => {
            releaseB = resolve;
          });
        }
        return originalGet(id);
      });

    render(<WorkspaceShell />);
    fireEvent.click(screen.getByRole("button", { name: "Conversation B" }));

    // The route and owner are already B, but B is not loaded yet: the
    // previous conversation must not be visible and no composer may accept
    // input into it.
    await waitFor(() =>
      expect(useChatStore.getState().activeThreadId).toBe("th-b"),
    );
    expect(useChatStore.getState().threadLoaded).toBe(false);
    expect(screen.getAllByText(/loading conversation/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText("message-from-A")).toHaveLength(0);
    expect(screen.queryByRole("textbox")).toBeNull();

    releaseB!({
      briefJson: null,
      messages: [storedMessage("m-b", "message-from-B")],
      rev: 0,
    });
    expect((await screen.findAllByText("message-from-B")).length).toBeGreaterThan(0);
    expect(useChatStore.getState().threadLoaded).toBe(true);
    spy.mockRestore();
  });

  it("renders the real ChatTab without unstable-snapshot warnings", async () => {
    // Sources make ChatTab's scoped-source derivation run on every store
    // update: a filtering selector would return a new array per snapshot.
    useSourceStore.setState({
      sources: [sourceMeta("s1"), sourceMeta("s2")],
      sourcesLoaded: true,
    });
    useAppStore.setState({ view: { kind: "discussion", id: "th-a" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<WorkspaceShell />);
      expect(
        (await screen.findAllByText("message-from-A")).length,
      ).toBeGreaterThan(0);
      // Prove the FULL ChatTab (not just the compact assistant) rendered:
      // its conversation switcher is unique to the full view.
      expect(screen.getByLabelText(/switch conversation/i)).toBeDefined();
      // Let pending effects/store traffic settle.
      await waitFor(() => expect(useChatStore.getState().threadsLoaded).toBe(true));
      const unstable = errorSpy.mock.calls.filter((call) =>
        call.some(
          (arg) =>
            typeof arg === "string" && arg.includes("getSnapshot should be cached"),
        ),
      );
      expect(unstable).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a dangling conversation id falls back to a real owner", async () => {
    render(<WorkspaceShell />);
    // A restored/deleted selection reaches the route through the single
    // navigation action; the requested owner no longer exists.
    act(() => useAppStore.getState().openDiscussion("th-deleted"));
    await waitFor(() =>
      expect(useAppStore.getState().view).toEqual({
        kind: "discussion",
        id: "th-b",
      }),
    );
    expect((await screen.findAllByText("message-from-B")).length).toBeGreaterThan(0);
  });

  it("a failed send in a hidden conversation is discoverable from the navigator", async () => {
    // The failure landed in B while the user was elsewhere: the retained
    // failure marks B's navigator row without opening the conversation.
    rememberFailedSend({
      threadId: "th-b",
      userMessageId: "u-b",
      messageKey: "k-b",
      request: {} as unknown as PreparedChatRequest,
      error: "provider exploded",
    });
    render(<WorkspaceShell />);
    expect(
      await screen.findByRole("img", {
        name: /send failed in this conversation/i,
      }),
    ).toBeDefined();
    // The failure belongs to B only; A's row carries no badge.
    expect(
      screen.getAllByRole("img", {
        name: /send failed in this conversation/i,
      }),
    ).toHaveLength(1);
  });

  it("a failed conversation creation is reported instead of a dead click", async () => {
    // Fresh state: no conversations exist yet, so the click must create one.
    useChatStore.setState({
      threads: [],
      threadsLoaded: true,
      activeThreadId: null,
      threadLoaded: true,
      messages: [],
      error: null,
      threadErrors: {},
    });
    const spy = vi
      .spyOn(fakeRepository, "threadCreate")
      .mockRejectedValue(new Error("the database is unreachable"));
    try {
      render(<WorkspaceShell />);
      const navigator = screen.getByRole("navigation", {
        name: "Workspace navigator",
      });
      fireEvent.click(
        within(navigator).getByRole("button", { name: "New conversation" }),
      );
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("the database is unreachable");
    } finally {
      spy.mockRestore();
    }
  });

  it("Configure API opens the real Settings dialog instead of navigating away", async () => {
    useChatStore.setState({
      config: { ...useChatStore.getState().config, apiKey: "" },
    });
    useAppStore.setState({ view: { kind: "discussion", id: "th-a" } });
    render(<WorkspaceShell />);

    fireEvent.click(await screen.findByRole("button", { name: /configure api/i }));
    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText(/backup & restore/i)).toBeDefined();
    // The workspace stayed on the conversation (no empty-list navigation).
    expect(useAppStore.getState().view).toEqual({
      kind: "discussion",
      id: "th-a",
    });
  });

  it("typing in a composer never re-parses the conversation rows", async () => {
    // Both chat surfaces (full discussion + compact assistant) are mounted;
    // typing into either must not re-render the message list — the draft
    // lives in the composer, and the rows are memoized.
    useAppStore.setState({ view: { kind: "discussion", id: "th-a" } });
    render(<WorkspaceShell />);
    expect(
      (await screen.findAllByText("message-from-A")).length,
    ).toBeGreaterThanOrEqual(2);
    const baseline = markdownState.renders;
    expect(baseline).toBeGreaterThan(0);

    const boxes = screen.getAllByRole("textbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      fireEvent.change(box, { target: { value: "typing a long message" } });
    }
    expect((boxes[0] as HTMLTextAreaElement).value).toBe("typing a long message");
    expect((boxes[1] as HTMLTextAreaElement).value).toBe("typing a long message");
    // Zero re-parses: unchanged rows never re-render on a keystroke.
    expect(markdownState.renders).toBe(baseline);
  });

  it("chat agent settings scroll, discard on Back, and persist on Save", async () => {
    useAppStore.setState({ view: { kind: "discussion", id: "th-a" } });
    render(<WorkspaceShell />);
    expect(
      (await screen.findAllByText("message-from-A")).length,
    ).toBeGreaterThan(0);

    const openSettings = () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Chat agent settings" }),
      );
    openSettings();

    // The tall form (prompts + actions) sits inside a scroll container:
    // the shell's main pane is overflow-hidden, so without this the
    // custom prompt and Save are unreachable below the fold.
    const readOnlyLabel = screen.getByText("Standard prompt (read-only)");
    expect(readOnlyLabel.closest(".overflow-y-auto")).not.toBeNull();

    // A draft edit then Back: the pane closes and nothing is written.
    const before = useChatStore.getState().config.customSystemPrompt;
    const customBox = () =>
      screen.getByPlaceholderText(
        /write your own instructions/i,
      ) as HTMLTextAreaElement;
    fireEvent.change(customBox(), { target: { value: "discarded draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText(/switch conversation/i)).toBeDefined();
    await waitFor(() =>
      expect(useChatStore.getState().config.customSystemPrompt).toBe(before),
    );
    expect(useChatStore.getState().config.customSystemPrompt).not.toBe(
      "discarded draft",
    );

    // Reopening reads the saved config again — the draft never leaked.
    openSettings();
    expect(customBox().value).toBe(before);

    // Save persists and closes.
    fireEvent.change(customBox(), { target: { value: "kept prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(useChatStore.getState().config.customSystemPrompt).toBe(
        "kept prompt",
      ),
    );
    expect(screen.getByLabelText(/switch conversation/i)).toBeDefined();
  });
});
