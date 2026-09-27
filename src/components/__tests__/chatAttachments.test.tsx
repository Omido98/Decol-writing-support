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

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

vi.mock("@/utils/api", () => ({
  sendMessage: vi.fn(),
  deslopText: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { sendMessage } from "@/utils/api";
import WorkspaceShell from "@/components/workspace/WorkspaceShell";
import { useAppStore } from "@/stores/useAppStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useChatStore } from "@/stores/chatStore";
import { useSourceStore } from "@/stores/sourceStore";
import { useDraftStore } from "@/stores/draftStore";
import { resetOperations } from "@/services/aiOperations";
import { fakeRepoState, resetFakeRepository } from "@/test/fakeRepository";
import { markdownDocument } from "@/utils/documentCodec";
import type { LibraryTextMeta, ThreadMeta } from "@/types";

const invokeMock = invoke as Mock;
const sendMessageMock = sendMessage as unknown as Mock;

// The workspace render plus real dialogs is heavy; under full-suite load the
// default 5s per-test budget is too tight.
vi.setConfig({ testTimeout: 20000 });

/** The fake SQLite preferences table backing db_prefs_* calls. */
const prefsTable = new Map<string, string>();

const threadA: ThreadMeta = {
  id: "th-a",
  title: "Conversation A",
  mode: "text",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
};

const docA: LibraryTextMeta = {
  id: "doc-a",
  title: "Field notes",
  textType: "other",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const docB: LibraryTextMeta = {
  id: "doc-b",
  title: "Archive paper",
  textType: "article",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-03T00:00:00.000Z",
};

function seedDocs(): void {
  for (const meta of [docA, docB]) {
    fakeRepoState.texts.set(meta.id, {
      meta,
      body: markdownDocument(`${meta.title} body`),
      versions: [],
      rev: 0,
    });
  }
}

function seedThreadWithMessage(): void {
  fakeRepoState.threads.set("th-a", {
    meta: threadA,
    briefJson: null,
    messages: [
      {
        id: "m-a",
        role: "assistant",
        content: "message-from-A",
        timestamp: "2026-02-01T00:00:00.000Z",
        failed: false,
        incomplete: null,
        attachmentsJson: null,
      },
    ],
    rev: 0,
  });
}

async function openPicker(): Promise<HTMLElement> {
  fireEvent.click(
    await screen.findByRole("button", { name: "Attach a library document" }),
  );
  return await screen.findByRole("dialog");
}

/** The checkbox of one picker row (by its text title). */
function checkboxFor(dialog: HTMLElement, title: string): HTMLElement {
  const label = within(dialog).getByText(title).closest("label");
  const box = label?.querySelector('[role="checkbox"]');
  if (!box) throw new Error(`No checkbox row for ${title}`);
  return box as HTMLElement;
}

beforeEach(() => {
  prefsTable.clear();
  invokeMock.mockReset();
  sendMessageMock.mockReset();
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
        default:
          return null;
      }
    },
  );
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

  resetFakeRepository();
  resetOperations();
  seedThreadWithMessage();
  seedDocs();
  useChatStore.setState({
    threads: [threadA],
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
  useLibraryStore.setState({
    texts: [docA, docB],
    textsLoaded: true,
    pendingAttachId: null,
  });
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
    view: { kind: "discussion", id: "th-a" },
    actionError: null,
  });
  Object.defineProperty(window, "innerWidth", {
    value: 1400,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("composer library attachments", () => {
  it("keeps every attached text and reopens the picker with them checked", async () => {
    render(<WorkspaceShell />);

    const dialog = await openPicker();
    fireEvent.click(checkboxFor(dialog, "Field notes"));
    fireEvent.click(checkboxFor(dialog, "Archive paper"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Attach (2)" }),
    );

    // Both chips land in the composer: neither async content load clobbered
    // the other with a stale snapshot.
    await screen.findByRole("button", { name: "Detach Field notes" });
    await screen.findByRole("button", { name: "Detach Archive paper" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const reopened = await openPicker();
    expect(
      checkboxFor(reopened, "Field notes").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      checkboxFor(reopened, "Archive paper").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("attaching works after the conversation loads behind an already-mounted chat", async () => {
    // The restored conversation is still loading when ChatTab first renders,
    // so its first render sees no active thread (the stale-render case that
    // used to make every attach a silent no-op).
    useChatStore.setState({
      activeThreadId: null,
      threadLoaded: true,
      messages: [],
    });
    render(<WorkspaceShell />);

    await act(async () => {
      await useChatStore.getState().switchThread("th-a");
    });

    const dialog = await openPicker();
    fireEvent.click(checkboxFor(dialog, "Field notes"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Attach (1)" }),
    );
    await screen.findByRole("button", { name: "Detach Field notes" });
  });

  it("the library Ask-the-chat handoff lands once a conversation is resolved", async () => {
    useChatStore.setState({
      activeThreadId: null,
      threadLoaded: true,
      messages: [],
    });
    useLibraryStore.setState({ pendingAttachId: "doc-a" });
    render(<WorkspaceShell />);

    await screen.findByRole("button", { name: "Detach Field notes" });
    expect(useLibraryStore.getState().pendingAttachId).toBeNull();
  });

  it("attaches to the first message from the empty-thread start panel", async () => {
    // A brand-new conversation: no messages yet, so the start panel (not
    // the composer) is the only attach surface.
    fakeRepoState.threads.set("th-a", {
      meta: threadA,
      briefJson: null,
      messages: [],
      rev: 0,
    });
    useChatStore.setState({ messages: [], threadAttachments: {} });
    sendMessageMock.mockResolvedValue({ content: "reply", outcome: "complete" });

    render(<WorkspaceShell />);

    fireEvent.click(await screen.findByRole("button", { name: "Attach texts" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(checkboxFor(dialog, "Field notes"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Attach (1)" }));
    await screen.findByRole("button", { name: "Detach Field notes" });
    expect(
      useChatStore.getState().getThreadAttachments("th-a").library.map((a) => a.id),
    ).toEqual(["doc-a"]);

    fireEvent.change(screen.getByPlaceholderText("What is the text about?"), {
      target: { value: "Decolonial essay" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start discussion" }));

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMessageMock.mock.calls[0][2]).toContain("Field notes body");
    await waitFor(() => expect(useChatStore.getState().messages).toHaveLength(2));
    expect(useChatStore.getState().getThreadAttachments("th-a").library).toEqual([]);
  });

  it("sets web search and deep research for the first message from the start panel", async () => {
    fakeRepoState.threads.set("th-a", {
      meta: threadA,
      briefJson: null,
      messages: [],
      rev: 0,
    });
    useChatStore.setState({ messages: [], threadAttachments: {} });
    sendMessageMock.mockResolvedValue({ content: "reply", outcome: "complete" });

    render(<WorkspaceShell />);

    const web = await screen.findByRole("button", { name: /web search/i });
    const deep = screen.getByRole("button", { name: /deep research/i });
    expect(web.getAttribute("aria-pressed")).toBe("true");
    expect(deep.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(web);
    expect(useChatStore.getState().config.webSearchEnabled).toBe(false);
    fireEvent.click(web);
    expect(useChatStore.getState().config.webSearchEnabled).toBe(true);

    fireEvent.click(deep);
    expect(useChatStore.getState().config.deepResearchEnabled).toBe(true);
    expect(useChatStore.getState().config.webSearchEnabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("What is the text about?"), {
      target: { value: "Decolonial essay" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start discussion" }));

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMessageMock.mock.calls[0][1]).toMatchObject({
      webSearchEnabled: true,
      deepResearchEnabled: true,
    });
  });

  it("shows the agent toggles in the project-brief start panel too", async () => {
    const projectThread = { ...threadA, mode: "project" as const };
    fakeRepoState.threads.set("th-a", {
      meta: projectThread,
      briefJson: null,
      messages: [],
      rev: 0,
    });
    useChatStore.setState({
      threads: [projectThread],
      messages: [],
      threadAttachments: {},
    });

    render(<WorkspaceShell />);

    await screen.findByText(/brief agent will ask about the project/i);
    expect(screen.getByRole("button", { name: /web search/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /deep research/i })).toBeDefined();
  });
});
