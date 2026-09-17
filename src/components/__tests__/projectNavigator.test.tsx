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
import { fakeRepoState, resetFakeRepository } from "@/test/fakeRepository";
import type { ThreadMeta } from "@/types";

function seedThread(meta: ThreadMeta) {
  fakeRepoState.threads.set(meta.id, {
    meta,
    briefJson: null,
    messages: [],
    rev: 0,
  });
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
  useAppStore.setState({ view: { kind: "list" }, actionError: null });
});

afterEach(() => cleanup());

describe("ProjectNavigator conversation folders", () => {
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
    fireEvent.change(screen.getByLabelText("Conversation folder"), {
      target: { value: "Drafts" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Move$/ }));

    await waitFor(() =>
      expect(fakeRepoState.threads.get("c-a")?.meta.folder).toBe("Drafts"),
    );
    await waitFor(() => expect(screen.getByText("Loose notes")).toBeDefined());
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
