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
import HistoryDialog from "@/components/library/HistoryDialog";
import { useLibraryStore } from "@/stores/libraryStore";
import { useDraftStore } from "@/stores/draftStore";
import { fakeRepoState, resetFakeRepository } from "@/test/fakeRepository";
import { markdownDocument } from "@/utils/documentCodec";
import type { LibraryTextMeta } from "@/types";

const invokeMock = invoke as Mock;

const meta: LibraryTextMeta = {
  id: "doc1",
  title: "My essay",
  textType: "essay",
  createdAt: "c",
  updatedAt: "u",
};

beforeEach(async () => {
  // Preferences (recovery drafts) go to the fake SQLite table.
  const prefs = new Map<string, string>();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "db_prefs_get":
        return prefs.get(String(args.key)) ?? null;
      case "db_prefs_set":
        prefs.set(String(args.key), String(args.value));
        return null;
      case "db_prefs_get_all":
        return [...prefs.entries()].map(([key, value]) => ({ key, value }));
      default:
        return null;
    }
  });
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

  resetFakeRepository();
  fakeRepoState.texts.set("doc1", {
    meta,
    body: markdownDocument("stored body"),
    versions: [
      { versionId: "v-old", savedAt: "2026-01-01T10:00:00.000Z", body: markdownDocument("older body") },
    ],
    rev: 0,
  });
  useLibraryStore.setState({
    texts: [meta],
    textsLoaded: true,
    pendingAttachId: null,
  });
  useDraftStore.setState({ drafts: {}, hydrated: false });
});

afterEach(() => {
  cleanup();
});

// LibraryEditor draft-navigation coverage moved to
// documentEditor.test.tsx (the rich editor's sessions); this file keeps
// the version-history restore refresh.
describe("HistoryDialog restore refresh", () => {
  it("restores a version and refreshes the holding views", async () => {
    const onRestored = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <HistoryDialog
        id="doc1"
        open
        onOpenChange={onOpenChange}
        onRestored={onRestored}
      />,
    );

    // The version list shows the snapshot row (date + word count).
    const versionRow = await screen.findByRole("button", { name: /words/ });
    fireEvent.click(versionRow);
    fireEvent.click(screen.getByRole("button", { name: /Restore version/i }));

    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    // The content was restored in the repository...
    expect(fakeRepoState.texts.get("doc1")?.body.content).toBe("older body");
    // ...and the dialog closed itself.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("warns about an unsaved draft and discards it with the restore (B12)", async () => {
    useDraftStore.setState({
      drafts: {
        "text:doc1": {
          key: "text:doc1",
          kind: "text",
          entityId: "doc1",
          content: "DRAFT EDITS",
          meta: null,
          savedAt: null,
          error: null,
          updatedAt: "u",
        },
      },
      hydrated: true,
    });
    render(
      <HistoryDialog
        id="doc1"
        open
        onOpenChange={() => {}}
        onRestored={() => {}}
      />,
    );

    expect(await screen.findByText(/unsaved edits/i)).toBeDefined();
    fireEvent.click(await screen.findByRole("button", { name: /words/ }));
    fireEvent.click(screen.getByRole("button", { name: /Restore version/i }));

    // The restore is explicit: the dirty draft no longer exists, so it
    // cannot silently override the restored content on reopen.
    await waitFor(() =>
      expect(useDraftStore.getState().drafts["text:doc1"]).toBeUndefined(),
    );
    expect(fakeRepoState.texts.get("doc1")?.body.content).toBe("older body");
  });
});
