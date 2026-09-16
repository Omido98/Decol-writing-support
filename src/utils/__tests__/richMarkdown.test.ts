// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { markdownFromRich, richFromMarkdown } from "@/utils/richMarkdown";
import { markdownDocument, richDocument } from "@/utils/documentCodec";

describe("markdownFromRich", () => {
  it("passes markdown bodies through untouched", () => {
    const body = markdownDocument("# Original\n\ntext with **bold**");
    expect(markdownFromRich(body)).toBe("# Original\n\ntext with **bold**");
  });

  it("serializes rich bodies through the editor's own serializer", () => {
    const body = richDocument({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "see " },
            { type: "text", text: "the source", marks: [{ type: "link", attrs: { href: "https://x.org" } }] },
          ],
        },
      ],
    });
    const md = markdownFromRich(body);
    expect(md).toContain("# Title");
    expect(md).toContain("[the source](https://x.org)");
  });

  it("shows a corrupt payload verbatim instead of crashing", () => {
    const md = markdownFromRich({
      contentFormat: "tiptap-json",
      contentSchemaVersion: 1,
      content: "{not json",
      plainText: "",
    });
    expect(md).toContain("```");
    expect(md).toContain("{not json");
  });
});

describe("richFromMarkdown", () => {
  it("parses markdown into a rich payload structurally", () => {
    const payload = richFromMarkdown("# H\n\n- a\n- b\n\n> quote");
    const json = JSON.parse(payload);
    expect(json.type).toBe("doc");
    const text = JSON.stringify(json);
    expect(text).toContain('"heading"');
    expect(text).toContain('"bulletList"');
    expect(text).toContain('"blockquote"');
  });
});

// ── B10: citation/footnote atoms survive the production conversions ──

const citationBody = {
  contentFormat: "tiptap-json" as const,
  contentSchemaVersion: 1,
  content: JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Scholars disagree " },
          { type: "citation", attrs: { sourceId: "s1", label: "(Césaire, 1966)" } },
          { type: "text", text: " — yet the claim stands" },
          { type: "footnoteRef", attrs: { label: "1", text: "Quijano, ¶ 3–4." } },
          { type: "text", text: "." },
        ],
      },
    ],
  }),
  plainText: "Scholars disagree (Césaire, 1966) — yet the claim stands",
};

describe("citation/footnote fidelity (B10)", () => {
  it("keeps citations and footnotes in the serialized markdown", () => {
    const md = markdownFromRich(citationBody);
    expect(md).toContain("Scholars disagree");
    expect(md).toContain("(Césaire, 1966)");
    expect(md).toContain("data-citation");
    expect(md).toContain("Quijano, ¶ 3–4.");
    expect(md).toContain("data-footnote");
    expect(md).toContain("yet the claim stands");
  });

  it("round-trips citations and footnotes through markdown and back", () => {
    const md = markdownFromRich(citationBody);
    const back = JSON.parse(richFromMarkdown(md));
    const text = JSON.stringify(back);
    expect(text).toContain('"citation"');
    expect(text).toContain('"footnoteRef"');
    expect(text).toContain("(Césaire, 1966)");
    expect(text).toContain("Quijano, ¶ 3–4.");
  });

  it("never turns a schema-invalid rich body into empty markdown", () => {
    // An unknown node from a newer build: the OLD conversion silently
    // produced an empty document (ProseMirror drops unknown JSON), which
    // the reader then showed as "This text is empty."
    const md = markdownFromRich({
      contentFormat: "tiptap-json",
      contentSchemaVersion: 1,
      content: JSON.stringify({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "kept prose" }] },
          { type: "futureWidget", attrs: { x: 1 } },
        ],
      }),
      plainText: "",
    });
    expect(md).toContain("kept prose");
    expect(md).toContain("futureWidget");
  });
});

describe("export → reimport fidelity (Phase 4 acceptance)", () => {
  it("a rich document round-trips through markdown export and reimport", () => {
    const original = markdownDocument(
      [
        "# Décoloniser l'archive — تقرير",
        "",
        "Intro with [a link](https://example.org) and *emphasis*.",
        "",
        "> A quotation — 你好",
        "",
        "- first",
        "- second",
        "",
        "| A | B |",
        "| --- | --- |",
        "| one | deux |",
      ].join("\n"),
    );

    // Simulate the editor's conversion (markdown → rich on open)…
    const richPayload = richFromMarkdown(original.content);
    const rich: Parameters<typeof markdownFromRich>[0] = {
      contentFormat: "tiptap-json",
      contentSchemaVersion: 1,
      content: richPayload,
      plainText: original.plainText,
    };

    // …export (save → export path)…
    const exported = markdownFromRich(rich);

    // …and reimport (a fresh markdown document opened again).
    const reimported = richFromMarkdown(exported);
    const reopened: Parameters<typeof markdownFromRich>[0] = {
      contentFormat: "tiptap-json",
      contentSchemaVersion: 1,
      content: reimported,
      plainText: "",
    };

    // The structural round-trip is stable: export(reimport(x)) == export(x).
    expect(markdownFromRich(reopened)).toBe(exported);
    // And the constructs survive.
    expect(exported).toContain("# Décoloniser l'archive — تقرير");
    expect(exported).toContain("> A quotation — 你好");
    expect(exported).toContain("- first");
    expect(exported).toMatch(/\| one\s+\| deux\s+\|/);
  });
});
