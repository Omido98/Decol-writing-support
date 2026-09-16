// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  act,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
  writeFile: vi.fn(),
  exists: vi.fn(),
  BaseDirectory: { AppData: "AppData" },
}));

import LibraryReader from "@/components/library/LibraryReader";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { resetFakeRepository } from "@/test/fakeRepository";

beforeEach(() => {
  resetFakeRepository();
  useLibraryStore.setState({ texts: [], textsLoaded: true, pendingAttachId: null });
  useProjectStore.setState({
    projects: [],
    projectsLoaded: true,
    pendingBriefProjectId: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("LibraryReader when its text disappears", () => {
  it("keeps the hook order stable and shows the fallback instead of crashing", async () => {
    const id = await useLibraryStore
      .getState()
      .createText({ title: "Doomed text", content: "some body" });
    const onBack = vi.fn();
    render(<LibraryReader id={id} onBack={onBack} onEdit={vi.fn()} />);
    expect(await screen.findByText("Doomed text")).toBeDefined();

    // The text is deleted while the reader stays mounted (the store update
    // that used to trigger React's "fewer hooks than expected" crash).
    act(() => {
      useLibraryStore.setState({ texts: [] });
    });

    expect(screen.getByText(/no longer exists/i)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /back to library/i }));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });

  it("deleting through the reader's own confirmation leaves the fallback reachable", async () => {
    const id = await useLibraryStore
      .getState()
      .createText({ title: "Doomed text", content: "some body" });
    const onBack = vi.fn();
    render(<LibraryReader id={id} onBack={onBack} onEdit={vi.fn()} />);

    fireEvent.click(await screen.findByTitle("Delete text"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(useLibraryStore.getState().texts.some((t) => t.id === id)).toBe(false),
    );
    // The flow completes: the reader navigates back (and never blanked).
    await waitFor(() => expect(onBack).toHaveBeenCalled());
  });
});
