// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
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
  exists: vi.fn(),
  BaseDirectory: { AppData: "AppData" },
}));

import SourcesPanel from "@/components/workspace/SourcesPanel";
import { useSourceStore } from "@/stores/sourceStore";
import { fakeRepoState, resetFakeRepository } from "@/test/fakeRepository";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";

beforeEach(() => {
  resetFakeRepository();
  useSourceStore.setState({ sources: [], sourcesLoaded: true, jobs: {} });
  vi.mocked(open).mockReset();
  vi.mocked(readTextFile).mockReset();
});

afterEach(() => {
  cleanup();
});

describe("SourcesPanel persistence errors (B13)", () => {
  it("shows a metadata save failure instead of acknowledging success", async () => {
    const { id } = await useSourceStore.getState().addSource({
      title: "Two-passage source",
      text: "first block\n\nsecond block",
      passages: [
        { id: "p1", locator: "¶ 1", content: "first block" },
        { id: "p2", locator: "¶ 2", content: "second block" },
      ],
    });

    render(<SourcesPanel />);
    const include = await screen.findByRole("checkbox", {
      name: /Include .* in AI context/i,
    });

    fakeRepoState.nextError = new Error("disk gone");
    include.click();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("disk gone");

    // The source (and its passages) are unchanged.
    expect(
      useSourceStore.getState().sources.find((s) => s.id === id)!.includedInContext,
    ).toBe(true);
    expect(useSourceStore.getState().sources).toHaveLength(1);
  });

  it("keeps the passages after a successful inclusion toggle and reload", async () => {
    const { id } = await useSourceStore.getState().addSource({
      title: "Two-passage source",
      text: "first block\n\nsecond block",
      passages: [
        { id: "p1", locator: "¶ 1", content: "first block" },
        { id: "p2", locator: "¶ 2", content: "second block" },
      ],
    });
    render(<SourcesPanel />);
    const include = await screen.findByRole("checkbox", {
      name: /Include .* in AI context/i,
    });
    include.click();
    await waitFor(() =>
      expect(
        useSourceStore.getState().sources.find((s) => s.id === id)!
          .includedInContext,
      ).toBe(false),
    );
    const stored = fakeRepoState.sources.get(id)!;
    expect(stored.passages.map((p) => p.id)).toEqual(["p1", "p2"]);
  });
});

describe("source metadata editing and reporting (B18)", () => {
  it("edits the retained bibliography metadata through the real controls", async () => {
    const { id } = await useSourceStore.getState().addSource({
      title: "Historia y colonialidad",
      author: "Quijano, Aníbal",
      doi: "10.1/x",
      text: "reference line",
    });
    render(<SourcesPanel />);
    // Expand the row, then the metadata editor.
    fireEvent.click(await screen.findByText("Historia y colonialidad"));
    fireEvent.click(
      await screen.findByRole("button", { name: /Edit metadata of/ }),
    );
    fireEvent.change(screen.getByLabelText("Edit abstract"), {
      target: { value: "Un resumen." },
    });
    fireEvent.change(screen.getByLabelText("Edit type"), {
      target: { value: "article-journal" },
    });
    fireEvent.change(screen.getByLabelText("Edit container"), {
      target: { value: "Tabula Rasa" },
    });
    fireEvent.change(screen.getByLabelText("Edit pages"), {
      target: { value: "10-20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));

    await waitFor(() => {
      const stored = useSourceStore
        .getState()
        .sources.find((s) => s.id === id)!;
      expect(stored.abstract).toBe("Un resumen.");
      expect(stored.sourceType).toBe("article-journal");
      expect(stored.containerTitle).toBe("Tabula Rasa");
      expect(stored.pages).toBe("10-20");
    });
    // The write landed in the repository, and the editor closed on success.
    expect(fakeRepoState.sources.get(id)!.meta.abstract).toBe("Un resumen.");
    expect(screen.queryByLabelText("Edit abstract")).toBeNull();
  });

  it("reports imported and duplicate/merge counts from a real import", async () => {
    // An existing source already owns the DOI in the import file.
    await useSourceStore.getState().addSource({
      title: "Décoloniser la méthode",
      doi: "10.1000/dup",
      text: "existing",
    });
    vi.mocked(open).mockResolvedValue("C:/tmp/refs.bib");
    vi.mocked(readTextFile).mockResolvedValue(`
@book{new1,
  title = {Peau noire, masques blancs},
  author = {Fanon, Frantz},
  year = {1952}
}
@book{dup1,
  title = {Décoloniser la méthode},
  doi = {10.1000/DUP},
  author = {Tuhiwai Smith, Linda},
  year = {1999},
  publisher = {Zed Books}
}`);
    render(<SourcesPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Import bibliography" }),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Imported 1 source");
    expect(status.textContent).toContain("1 duplicate skipped");
    expect(status.textContent).toContain("1 merged missing metadata");
    // The duplicate kept the existing record and received the new metadata.
    const sources = useSourceStore.getState().sources;
    expect(sources).toHaveLength(2);
    const duplicate = sources.find((s) => s.doi === "10.1000/dup")!;
    expect(duplicate.publisher).toBe("Zed Books");
    expect(duplicate.author).toBe("Tuhiwai Smith, Linda");
  });
});
