import { describe, it, expect } from "vitest";
import {
  serializeForExport,
  parseImport,
  titleFromFilename,
  exportFilename,
} from "@/utils/libraryIo";
import type { LibraryTextMeta } from "@/types";

const meta: LibraryTextMeta = {
  id: "t1",
  title: "On Epistemic Violence",
  textType: "essay",
  folder: "Book project",
  wordCount: 12,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-02T12:00:00.000Z",
};

describe("export -> import round trip", () => {
  it("preserves title, type, and folder through serialize + parse", () => {
    const exported = serializeForExport(
      meta,
      "Body of the essay.\n\nSecond paragraph.",
    );
    const parsed = parseImport(exported, "fallback");

    expect(parsed.title).toBe("On Epistemic Violence");
    expect(parsed.textType).toBe("essay");
    expect(parsed.folder).toBe("Book project");
    expect(parsed.content).toBe("Body of the essay.\n\nSecond paragraph.");
  });

  it("handles titles containing quotes and newlines in content", () => {
    const tricky: LibraryTextMeta = {
      ...meta,
      title: 'The "Other" & History',
      folder: undefined,
    };
    const exported = serializeForExport(tricky, "Line one\nLine two");
    const parsed = parseImport(exported, "fallback");
    expect(parsed.title).toBe('The "Other" & History');
    expect(parsed.folder).toBeUndefined();
    expect(parsed.content).toBe("Line one\nLine two");
  });

  it("parses plain text without front matter as-is", () => {
    const parsed = parseImport("Just some notes.", "fallback");
    expect(parsed.title).toBe("fallback");
    expect(parsed.textType).toBe("other");
    expect(parsed.content).toBe("Just some notes.");
  });

  it("maps unknown type values to other", () => {
    const raw = serializeForExport(meta, "body").replace(
      "type: essay",
      "type: manifesto",
    );
    expect(parseImport(raw, "fallback").textType).toBe("other");
  });
});

describe("titleFromFilename", () => {
  it("strips known extensions and spaces separators", () => {
    expect(titleFromFilename("my_essay-draft.md")).toBe("my essay draft");
    expect(titleFromFilename("Notes.txt")).toBe("Notes");
    expect(titleFromFilename("chapter one.markdown")).toBe("chapter one");
  });

  it("falls back to Untitled text for empty names", () => {
    expect(titleFromFilename(".md")).toBe("Untitled text");
  });
});

describe("exportFilename", () => {
  it("slugifies the title", () => {
    expect(exportFilename("On Epistemic Violence!")).toBe(
      "on-epistemic-violence.md",
    );
  });

  it("caps length and handles symbol-only titles", () => {
    expect(exportFilename("!!!")).toBe("text.md");
    const long = exportFilename("x".repeat(100));
    expect(long).toBe(`${"x".repeat(60)}.md`);
  });
});
