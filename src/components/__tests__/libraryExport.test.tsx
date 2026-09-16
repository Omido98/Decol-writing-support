// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";

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
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
  exists: vi.fn(),
  BaseDirectory: { AppData: "AppData" },
}));

import JSZip from "jszip";
import LibraryReader from "@/components/library/LibraryReader";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSourceStore } from "@/stores/sourceStore";
import { fakeRepoState, resetFakeRepository } from "@/test/fakeRepository";
import { richDocument } from "@/utils/documentCodec";
import type { LibraryTextMeta, SourceMeta } from "@/types";

const meta: LibraryTextMeta = {
  id: "doc1",
  title: "The Archive Essay",
  textType: "essay",
  createdAt: "c",
  updatedAt: "u",
};

/** A rich manuscript with prose around a citation and a footnote. */
const richBody = richDocument({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Scholars disagree " },
        { type: "citation", attrs: { sourceId: "s1", label: "(Césaire, 1966)" } },
        { type: "text", text: " — yet the claim stands" },
        { type: "footnoteRef", attrs: { label: "1", text: "Quijano, ¶ 3–4." } },
        { type: "text", text: ". Archive: " },
        {
          type: "text",
          text: "the source",
          marks: [
            { type: "link", attrs: { href: "https://example.org/archive" } },
          ],
        },
        { type: "text", text: "." },
      ],
    },
  ],
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const source: SourceMeta = {
  id: "s1",
  title: "Une saison au Congo",
  author: "Césaire, Aimé",
  year: "1966",
  originalText: "Une saison au Congo",
  contentHash: "hash-s1",
  extractionStatus: "ready",
  includedInContext: true,
  verification: "unverified",
  createdAt: "c",
  updatedAt: "u",
};

function file(name: string) {
  return fakeRepoState.texts.get(name);
}

beforeEach(async () => {
  const prefs = new Map<string, string>();
  const invokeMock = (await import("@tauri-apps/api/core")).invoke as Mock;
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
  fakeRepoState.texts.set("doc1", { meta, body: richBody, versions: [], rev: 0 });
  useLibraryStore.setState({
    texts: [meta],
    textsLoaded: true,
    pendingAttachId: null,
  });
  // The content cache is module-level: tests that replace the body must not
  // leak into later tests (documented isolation land mine).
  useLibraryStore.getState().invalidateTextContent("doc1");
  useSourceStore.setState({ sources: [source], sourcesLoaded: true, jobs: {} });

  const dialog = await import("@tauri-apps/plugin-dialog");
  (dialog.save as Mock).mockReset();
  (dialog.open as Mock).mockReset();
  const fs = await import("@tauri-apps/plugin-fs");
  (fs.writeFile as Mock).mockReset();
  (fs.writeTextFile as Mock).mockReset();
  (fs.readTextFile as Mock).mockReset();
  (fs.exists as Mock).mockReset();
});

afterEach(() => {
  cleanup();
});

describe("LibraryReader citations and footnotes (B10)", () => {
  it("renders citation labels and footnote markers instead of raw HTML", async () => {
    render(<LibraryReader id="doc1" onBack={() => {}} onEdit={() => {}} />);

    // The citation label is visible prose, not a dropped node or raw tag.
    expect(await screen.findByText(/\(Césaire, 1966\)/)).toBeDefined();
    expect(await screen.findByText(/yet the claim stands/)).toBeDefined();
    // The footnote marker is rendered as a real superscript with its text
    // available (no raw `<sup …>` markup shown to the reader).
    const marker = await screen.findByTitle("Quijano, ¶ 3–4.");
    expect(marker.tagName).toBe("SUP");
    expect(marker.textContent).toBe("1");
    // B19: the full note text is inspectable in the reader's Notes list.
    const notes = await screen.findByLabelText("Footnotes");
    expect(within(notes).getByText("Quijano, ¶ 3–4.")).toBeDefined();
    // The document must not look empty.
    expect(screen.queryByText(/This text is empty/)).toBeNull();
  });

  it("exports DOCX through the actual button with citations, footnotes, and bibliography", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    (save as Mock).mockResolvedValue("C:\\tmp\\archive.docx");
    const { writeFile } = await import("@tauri-apps/plugin-fs");

    render(<LibraryReader id="doc1" onBack={() => {}} onEdit={() => {}} />);
    await screen.findByTitle("Quijano, ¶ 3–4.");

    screen.getByRole("button", { name: /Export as DOCX/i }).click();
    await waitFor(() => expect(writeFile).toHaveBeenCalled(), { timeout: 10000 });

    const [path, bytes] = (writeFile as Mock).mock.calls[0] as [string, Uint8Array];
    expect(path).toBe("C:\\tmp\\archive.docx");
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    const footnotesXml = await zip.file("word/footnotes.xml")!.async("string");

    // Prose survives around the citation atom, in order.
    expect(documentXml).toContain("Scholars disagree");
    expect(documentXml).toContain("yet the claim stands");
    expect(documentXml).toContain("(Césaire, 1966)");
    const prose = documentXml.indexOf("Scholars disagree");
    const cite = documentXml.indexOf("(Césaire, 1966)");
    const after = documentXml.indexOf("yet the claim stands");
    expect(prose).toBeGreaterThanOrEqual(0);
    expect(prose).toBeLessThan(cite);
    expect(cite).toBeLessThan(after);
    // The bibliography is generated from the document's own citations.
    expect(documentXml).toContain("Une saison au Congo");
    // Exactly ONE bibliography section is exported (empty sections and
    // duplicates are suppressed by the explicit append option).
    expect(countOccurrences(documentXml, "References")).toBe(1);
    // Real hyperlinks survive as relationships.
    const relsXml = await zip.file("word/_rels/document.xml.rels")!.async("string");
    expect(relsXml).toContain("https://example.org/archive");
    expect(relsXml).toContain('TargetMode="External"');
    // The footnote is a REAL DOCX footnote with its text.
    expect(footnotesXml).toContain("Quijano, ¶ 3–4.");
  });

  it("includes source-backed footnotes in the exported bibliography", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    (save as Mock).mockResolvedValue("C:\\tmp\\footnote-source.docx");
    const { writeFile } = await import("@tauri-apps/plugin-fs");

    file("doc1")!.body = richDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A claim" },
            {
              type: "footnoteRef",
              attrs: {
                id: "fn-s1",
                label: "1",
                text: "Césaire, locator ¶ 3.",
                sourceId: "s1",
                passageId: "p1",
                locator: "¶ 3",
              },
            },
          ],
        },
      ],
    });
    useLibraryStore.getState().invalidateTextContent("doc1");

    render(<LibraryReader id="doc1" onBack={() => {}} onEdit={() => {}} />);
    await screen.findByLabelText("Footnotes");
    screen.getByRole("button", { name: /Export as DOCX/i }).click();
    await waitFor(() => expect(writeFile).toHaveBeenCalled(), { timeout: 10000 });

    const [, bytes] = (writeFile as Mock).mock.calls[0] as [string, Uint8Array];
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    const footnotesXml = await zip.file("word/footnotes.xml")!.async("string");
    // The source behind the FOOTNOTE alone reaches the bibliography…
    expect(documentXml).toContain("Une saison au Congo");
    // …while the note keeps its own stored display text.
    expect(footnotesXml).toContain("Césaire, locator ¶ 3.");
    // Everything resolved: no unresolved-reference report.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports unresolved source references and keeps the stored footnote text", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    (save as Mock).mockResolvedValue("C:\\tmp\\unresolved.docx");
    const { writeFile } = await import("@tauri-apps/plugin-fs");

    file("doc1")!.body = richDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A claim" },
            {
              type: "footnoteRef",
              attrs: {
                id: "fn-gone",
                label: "1",
                text: "Fallback note, ¶ 2.",
                sourceId: "deleted-source",
                passageId: "p9",
                locator: "¶ 2",
              },
            },
          ],
        },
      ],
    });
    useLibraryStore.getState().invalidateTextContent("doc1");

    render(<LibraryReader id="doc1" onBack={() => {}} onEdit={() => {}} />);
    await screen.findByLabelText("Footnotes");
    screen.getByRole("button", { name: /Export as DOCX/i }).click();
    await waitFor(() => expect(writeFile).toHaveBeenCalled(), { timeout: 10000 });

    const report = await screen.findByRole("status");
    expect(report.textContent).toMatch(/unresolved reference/i);

    const [, bytes] = (writeFile as Mock).mock.calls[0] as [string, Uint8Array];
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    const footnotesXml = await zip.file("word/footnotes.xml")!.async("string");
    // Nothing is invented for the missing source: no bibliography entry…
    expect(documentXml).not.toContain("References");
    // …but the note's stored fallback text is preserved.
    expect(footnotesXml).toContain("Fallback note, ¶ 2.");
  });

  it("does not append a second bibliography when the document already has one", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    (save as Mock).mockResolvedValue("C:\\tmp\\existing-bib.docx");
    const { writeFile } = await import("@tauri-apps/plugin-fs");

    file("doc1")!.body = richDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See " },
            { type: "citation", attrs: { sourceId: "s1", label: "(Césaire, 1966)" } },
          ],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "References" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Césaire, A. (1966). Une saison au Congo." },
          ],
        },
      ],
    });
    useLibraryStore.getState().invalidateTextContent("doc1");

    render(<LibraryReader id="doc1" onBack={() => {}} onEdit={() => {}} />);
    await screen.findByText(/\(Césaire, 1966\)/);
    screen.getByRole("button", { name: /Export as DOCX/i }).click();
    await waitFor(() => expect(writeFile).toHaveBeenCalled(), { timeout: 10000 });

    const [, bytes] = (writeFile as Mock).mock.calls[0] as [string, Uint8Array];
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    // The author's bibliography section is the only one; the generated
    // one is suppressed through the explicit append option.
    expect(countOccurrences(documentXml, "References")).toBe(1);
    expect(documentXml).toContain("(Césaire, 1966)");
  });

  it("exports Markdown through the actual button keeping citation and footnote data", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    (save as Mock).mockResolvedValue("C:\\tmp\\archive.md");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");

    render(<LibraryReader id="doc1" onBack={() => {}} onEdit={() => {}} />);
    await screen.findByTitle("Quijano, ¶ 3–4.");

    screen.getByRole("button", { name: /Export as Markdown/i }).click();
    await waitFor(() => expect(writeTextFile).toHaveBeenCalled());

    const [path, contents] = (writeTextFile as Mock).mock.calls[0] as [string, string];
    expect(path).toBe("C:\\tmp\\archive.md");
    expect(contents).toContain("Scholars disagree");
    expect(contents).toContain("(Césaire, 1966)");
    expect(contents).toContain("data-citation");
    expect(contents).toContain("data-footnote");
    expect(contents).toContain("Quijano, ¶ 3–4.");
  });

  it("surfaces export failures and offers a Retry that succeeds", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    (save as Mock).mockRejectedValueOnce(new Error("disk full"));
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");

    render(<LibraryReader id="doc1" onBack={() => {}} onEdit={() => {}} />);
    await screen.findByTitle("Quijano, ¶ 3–4.");

    screen.getByRole("button", { name: /Export as Markdown/i }).click();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("disk full");
    expect(writeTextFile).not.toHaveBeenCalled();

    // Retry runs the SAME export again; now the dialog succeeds.
    (save as Mock).mockResolvedValue("C:\\tmp\\archive.md");
    screen.getByRole("button", { name: /^Retry$/i }).click();
    await waitFor(() => expect(writeTextFile).toHaveBeenCalled());
  });

  it("shows a recovery state for a schema-invalid rich body, preserving the raw bytes", async () => {
    const raw = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "kept prose" }] },
        { type: "futureWidget", attrs: { x: 1 } },
      ],
    });
    file("doc1")!.body = {
      contentFormat: "tiptap-json",
      contentSchemaVersion: 1,
      content: raw,
      plainText: "kept prose",
    };
    useLibraryStore.getState().invalidateTextContent("doc1");

    render(<LibraryReader id="doc1" onBack={() => {}} onEdit={() => {}} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/futureWidget|schema/i);
    // The raw bytes are visible, not silently swallowed into "empty".
    const rawView = document.querySelector("[data-testid=raw-body]");
    expect(rawView?.textContent).toContain("futureWidget");
    expect(screen.queryByText(/This text is empty/)).toBeNull();
  });
});
