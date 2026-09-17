// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
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

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

import ProjectNavigator from "@/components/workspace/ProjectNavigator";
import { useAppStore } from "@/stores/useAppStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useChatStore } from "@/stores/chatStore";
import { useFolderStore } from "@/stores/folderStore";
import { fakeRepoState, resetFakeRepository } from "@/test/fakeRepository";
import { markdownDocument } from "@/utils/documentCodec";
import type { FolderMeta, LibraryTextMeta, ThreadMeta } from "@/types";

function seedThread(meta: ThreadMeta) {
  fakeRepoState.threads.set(meta.id, {
    meta,
    briefJson: null,
    messages: [],
    rev: 0,
  });
}

function seedText(meta: LibraryTextMeta) {
  fakeRepoState.texts.set(meta.id, {
    meta,
    body: markdownDocument("body"),
    versions: [],
    rev: 0,
  });
}

function seedFolder(folder: FolderMeta) {
  fakeRepoState.folders.set(folder.id, folder);
}

beforeEach(() => {
  resetFakeRepository();
  useLibraryStore.setState({ texts: [], textsLoaded: true, pendingAttachId: null });
  useProjectStore.setState({
    projects: [],
    projectsLoaded: true,
    pendingBriefProjectId: null,
  });
  useChatStore.setState({
    threads: [],
    threadsLoaded: true,
    activeThreadId: null,
    threadLoaded: true,
    messages: [],
  });
  useFolderStore.setState({ folders: [], foldersLoaded: false });
  useAppStore.setState({ view: { kind: "list" }, actionError: null });
});

afterEach(() => cleanup());

describe("ProjectNavigator folders", () => {
  it("groups conversations by folder and moves one through the dialog", async () => {
    const loose: ThreadMeta = {
      id: "c-a",
      title: "Loose notes",
      mode: "text",
      createdAt: "t",
      updatedAt: "t",
    };
    const one: ThreadMeta = {
      id: "c-b",
      title: "Field notes",
      mode: "text",
      folder: "Research",
      createdAt: "t",
      updatedAt: "t",
    };
    const two: ThreadMeta = {
      id: "c-c",
      title: "Archive search",
      mode: "text",
      folder: "Research",
      createdAt: "t",
      updatedAt: "t",
    };
    for (const t of [loose, one, two]) seedThread(t);
    useChatStore.setState({ threads: [loose, one, two] });

    render(<ProjectNavigator />);

    // The folder groups its members (expanded by default) and the
    // ungrouped conversation stays in the flat list.
    expect(screen.getByText("Field notes")).toBeDefined();
    expect(screen.getByText("Archive search")).toBeDefined();
    expect(screen.getByText("Loose notes")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Move conversation Loose notes to a folder/i,
      }),
    );
    fireEvent.change(screen.getByLabelText("Folder name"), {
      target: { value: "Drafts" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Move$/ }));

    await waitFor(() =>
      expect(fakeRepoState.threads.get("c-a")?.meta.folder).toBe("Drafts"),
    );
  });

  it("groups texts and chats together in one folder", () => {
    seedText({
      id: "t-1",
      title: "Draft chapter",
      textType: "essay",
      folder: "Research",
      createdAt: "t",
      updatedAt: "t",
    });
    seedThread({
      id: "c-1",
      title: "Chat about chapter",
      mode: "text",
      folder: "Research",
      createdAt: "t",
      updatedAt: "t",
    });
    useLibraryStore.setState({
      texts: [...fakeRepoState.texts.values()].map((e) => e.meta),
      textsLoaded: true,
      pendingAttachId: null,
    });
    useChatStore.setState({
      threads: [...fakeRepoState.threads.values()].map((e) => e.meta),
    });

    render(<ProjectNavigator />);

    // Both rows live under the same folder (shown once, mixed).
    expect(screen.getByText("Draft chapter")).toBeDefined();
    expect(screen.getByText("Chat about chapter")).toBeDefined();
    expect(screen.getByRole("button", { name: /Rename folder Research/i })).toBeDefined();
  });

  it("creates a folder, drags a text in, renames it, and deletes it (contents move out)", async () => {
    const draft: LibraryTextMeta = {
      id: "t-1",
      title: "Loose draft",
      textType: "essay",
      createdAt: "t",
      updatedAt: "t",
    };
    seedText(draft);
    useLibraryStore.setState({
      texts: [draft],
      textsLoaded: true,
      pendingAttachId: null,
    });

    render(<ProjectNavigator />);

    // Create the folder through the real dialog.
    fireEvent.click(screen.getByRole("button", { name: /^New folder$/i }));
    fireEvent.change(screen.getByLabelText("Folder name"), {
      target: { value: "Essays" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
    await waitFor(() =>
      expect(
        [...fakeRepoState.folders.values()].some(
          (f) => f.scope === "" && f.name === "Essays",
        ),
      ).toBe(true),
    );

    // Drag the document row onto the folder row (state-based DnD; jsdom
    // has no DataTransfer implementation).
    const row = screen.getByText("Loose draft").closest("[draggable]")!;
    const folderRow = screen.getByRole("button", {
      name: /Rename folder Essays/i,
    }).parentElement!;
    fireEvent.dragStart(row);
    fireEvent.dragOver(folderRow);
    fireEvent.drop(folderRow);
    await waitFor(() =>
      expect(fakeRepoState.texts.get("t-1")?.meta.folder).toBe("Essays"),
    );

    // Rename the folder: the registry and the item both move.
    fireEvent.click(
      screen.getByRole("button", { name: /Rename folder Essays/i }),
    );
    fireEvent.change(screen.getByLabelText("Folder name"), {
      target: { value: "Archive" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    await waitFor(() =>
      expect(fakeRepoState.texts.get("t-1")?.meta.folder).toBe("Archive"),
    );
    expect(
      [...fakeRepoState.folders.values()].some(
        (f) => f.scope === "" && f.name === "Archive",
      ),
    ).toBe(true);

    // Delete the folder: the document moves out, nothing is deleted.
    fireEvent.click(
      screen.getByRole("button", { name: /Delete folder Archive/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Delete folder$/ }));
    await waitFor(() =>
      expect(fakeRepoState.texts.get("t-1")?.meta.folder).toBeUndefined(),
    );
    expect(fakeRepoState.texts.has("t-1")).toBe(true);
    expect(fakeRepoState.folders.size).toBe(0);
  });

  it("removes an item from its folder with the no-folder drop zone", async () => {
    const filed: LibraryTextMeta = {
      id: "t-2",
      title: "Filed draft",
      textType: "essay",
      folder: "Essays",
      createdAt: "t",
      updatedAt: "t",
    };
    seedText(filed);
    seedFolder({
      id: "fold-1",
      scope: "",
      name: "Essays",
      createdAt: "t",
      updatedAt: "t",
    });
    useLibraryStore.setState({
      texts: [filed],
      textsLoaded: true,
      pendingAttachId: null,
    });
    useFolderStore.setState({
      folders: [...fakeRepoState.folders.values()],
      foldersLoaded: true,
    });

    render(<ProjectNavigator />);

    const row = screen.getByText("Filed draft").closest("[draggable]")!;
    fireEvent.dragStart(row);
    // The strip only exists while dragging an item that has a folder.
    const strip = screen.getByText(/Drop here to remove from “Essays”/i);
    fireEvent.dragOver(strip);
    fireEvent.drop(strip);
    await waitFor(() =>
      expect(fakeRepoState.texts.get("t-2")?.meta.folder).toBeUndefined(),
    );
  });

  it("renames a project-linked conversation from the navigator", async () => {
    useProjectStore.setState({
      projects: [
        { id: "p-1", title: "Project", createdAt: "t", updatedAt: "t" },
      ],
      projectsLoaded: true,
      pendingBriefProjectId: null,
    });
    const briefChat: ThreadMeta = {
      id: "th-p",
      title: "Brief chat",
      mode: "project",
      projectId: "p-1",
      createdAt: "t",
      updatedAt: "t",
    };
    seedThread(briefChat);
    useChatStore.setState({
      threads: [briefChat],
      activeThreadId: "th-p",
      threadLoaded: true,
    });
    // Selecting the conversation auto-expands its project in the navigator.
    useAppStore.setState({ view: { kind: "discussion", id: "th-p" } });

    render(<ProjectNavigator />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /Rename conversation Brief chat/i,
      }),
    );
    fireEvent.change(screen.getByLabelText("Conversation title"), {
      target: { value: "Renamed brief chat" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));

    await waitFor(() =>
      expect(fakeRepoState.threads.get("th-p")?.meta.title).toBe(
        "Renamed brief chat",
      ),
    );
  });
});
