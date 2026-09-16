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

const windowMock = vi.hoisted(() => ({
  closeHandler: null as
    | ((event: { preventDefault: () => void }) => Promise<void>)
    | null,
  destroy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (
      handler: (event: { preventDefault: () => void }) => Promise<void>,
    ) => {
      windowMock.closeHandler = handler;
      return () => {};
    },
    destroy: windowMock.destroy,
  }),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  exit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(true),
  save: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

vi.mock("@/utils/bootstrap", () => ({
  bootstrapStorage: vi.fn(),
  resolveConflict: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import App from "@/App";
import { bootstrapStorage } from "@/utils/bootstrap";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/chatStore";
import { useDraftStore } from "@/stores/draftStore";
import { resetPreferenceState } from "@/utils/preferences";
import {
  fakeRepository,
  fakeRepoState,
  resetFakeRepository,
} from "@/test/fakeRepository";
import { markdownDocument } from "@/utils/documentCodec";
import type { StoredMessage } from "@/utils/repository";
import type { LibraryTextMeta, ThreadMeta } from "@/types";

const invokeMock = invoke as Mock;
const bootstrapMock = bootstrapStorage as Mock;

const prefsTable = new Map<string, string>();

const docMeta: LibraryTextMeta = {
  id: "doc1",
  title: "My startup essay",
  textType: "essay",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

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

beforeEach(() => {
  prefsTable.clear();
  resetPreferenceState();
  windowMock.closeHandler = null;
  windowMock.destroy.mockClear();
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
        default:
          return null;
      }
    },
  );
  bootstrapMock.mockReset();
  bootstrapMock.mockResolvedValue({
    migration: null,
    issues: [],
    adopted: 0,
  });
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

  resetFakeRepository();
  fakeRepoState.texts.set("doc1", {
    meta: docMeta,
    body: markdownDocument("stored body"),
    versions: [],
    rev: 0,
  });
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

  // Store singletons carry state between tests: reset to a cold shape.
  useAppStore.setState({
    navigatorCollapsed: false,
    inspectorCollapsed: false,
    inspectorView: "assistant",
    focusMode: false,
    view: { kind: "list" },
  });
  useChatStore.setState({
    threads: [],
    threadsLoaded: false,
    activeThreadId: null,
    threadLoaded: true,
    messages: [],
    configLoaded: false,
    drafts: {},
    threadAttachments: {},
  });
  Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
});

afterEach(() => {
  cleanup();
});

describe("app startup (B02)", () => {
  it("cold startup hydrates settings, drafts, shell, and the inventories", async () => {
    render(<App />);
    // Blank until the startup sequence has loaded the inventories: an
    // empty array must never paint as "no documents".
    expect(screen.queryByText("My startup essay")).toBeNull();

    expect(await screen.findByText("My startup essay")).toBeDefined();
    // Conversations come from the same awaited inventory.
    expect(screen.getByText("Conversation A")).toBeDefined();
    expect(screen.getByText("Conversation B")).toBeDefined();
    expect(useChatStore.getState().threadsLoaded).toBe(true);
  });

  it("an inventory failure shows Retry; retry recovers the workspace", async () => {
    const listSpy = vi
      .spyOn(fakeRepository, "textsList")
      .mockRejectedValueOnce(new Error("registry unreadable"));
    render(<App />);

    const retry = await screen.findByRole("button", { name: /retry startup/i });
    expect(screen.getByText(/registry unreadable/i)).toBeDefined();
    listSpy.mockRestore();

    fireEvent.click(retry);
    expect(await screen.findByText("My startup essay")).toBeDefined();
  });

  it("restores the persisted conversation selection and loads its owner", async () => {    prefsTable.set(
      "workspace-shell",
      JSON.stringify({
        navigatorCollapsed: false,
        inspectorCollapsed: false,
        inspectorView: "assistant",
        focusMode: false,
        view: { kind: "discussion", id: "th-b" },
      }),
    );
    // The view is NOT pre-set: hydrateShell must restore it AND load the
    // requested owner through the single navigation action.
    render(<App />);

    await waitFor(() =>
      expect(useAppStore.getState().view).toEqual({
        kind: "discussion",
        id: "th-b",
      }),
    );
    await waitFor(() =>
      expect(useChatStore.getState().activeThreadId).toBe("th-b"),
    );
    expect(useChatStore.getState().threadLoaded).toBe(true);
    expect(useChatStore.getState().messages[0]?.content).toBe("message-from-B");
  });

  it("an incomplete legacy migration never opens the workspace, and retry recovers", async () => {
    bootstrapMock
      .mockResolvedValueOnce({
        migration: {
          completed: false,
          alreadyOpen: false,
          counts: { texts: 0, projects: 0, threads: 0, messages: 0, versions: 0 },
          issues: [
            {
              path: "library.json",
              kind: "malformed",
              detail: "broken JSON",
            },
          ],
          archivedDir: null,
        },
        issues: [],
        adopted: 0,
      })
      .mockResolvedValue({ migration: null, issues: [], adopted: 0 });

    render(<App />);
    expect(
      await screen.findByText(/could not finish starting up/i),
    ).toBeDefined();
    expect(screen.getByText(/library\.json \(malformed\)/)).toBeDefined();
    // The workspace did NOT open (no apparently empty writable dataset).
    expect(screen.queryByText("My startup essay")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /retry startup/i }));
    expect(await screen.findByText("My startup essay")).toBeDefined();
  });

  it("a failed exit drain keeps the app open with retry/discard choices", async () => {
    render(<App />);
    await screen.findByText("My startup essay");

    // Preference persistence fails; an unsaved draft exists.
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "db_prefs_set") throw new Error("disk gone");
        return base(cmd, args);
      },
    );
    useDraftStore.getState().setDraft("text:doc1", "text", "doc1", {
      content: "unsaved work",
    });

    const event = { preventDefault: vi.fn() };
    expect(windowMock.closeHandler).not.toBeNull();
    await act(async () => {
      await windowMock.closeHandler!(event);
    });

    // Exit was prevented and the window was NOT destroyed.
    expect(event.preventDefault).toHaveBeenCalled();
    expect(
      await screen.findByText(/Some work could not be saved/i),
    ).toBeDefined();
    expect(windowMock.destroy).not.toHaveBeenCalled();

    // Explicit discard is the only way the retained work exits.
    fireEvent.click(
      screen.getByRole("button", { name: /discard work and exit/i }),
    );
    await waitFor(() => expect(windowMock.destroy).toHaveBeenCalled());
  });
});
