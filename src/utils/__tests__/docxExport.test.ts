// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
  buildDocx,
  hasBibliographyHeading,
} from "@/utils/docxExport";
import { markdownDocument } from "@/utils/documentCodec";
import type { DocumentBody } from "@/utils/documentCodec";

/** A rich body from raw ProseMirror-JSON content nodes. */
function richJson(content: unknown[]): DocumentBody {
  return {
    contentFormat: "tiptap-json",
    contentSchemaVersion: 1,
    content: JSON.stringify({ type: "doc", content }),
    plainText: "",
  };
}

async function readDocxParts(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  return {
    document: await zip.file("word/document.xml")!.async("string"),
    numbering: await zip.file("word/numbering.xml")!.async("string"),
    rels: await zip.file("word/_rels/document.xml.rels")!.async("string"),
    footnotes: zip.file("word/footnotes.xml")
      ? await zip.file("word/footnotes.xml")!.async("string")
      : null,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("buildDocx (Phase 5.4c)", () => {
  it("builds a non-trivial DOCX preserving structure + bibliography", async () => {
    const body = markdownDocument(
      [
        "# Décoloniser l'archive — تقرير",
        "",
        "A paragraph with **bold**, *italic*, and [a link](https://example.org).",
        "",
        "> A quotation — 你好",
        "",
        "- first item",
        "- second item",
        "",
        "1. ordered one",
        "2. ordered two",
        "",
        "| A | B |",
        "| --- | --- |",
        "| one | deux |",
      ].join("\n"),
    );

    const buffer = await buildDocx({
      title: "The Report",
      body,
      bibliography: [
        // CSL processor output: structured runs (real italics survive).
        [
          { text: "Césaire, A. (1966). " },
          { text: "Une saison au Congo", italic: true },
          { text: ". — doi:10.1000/a" },
        ],
      ],
      bibliographyTitle: "References",
    });
    // A DOCX is a ZIP: it must be a real, non-trivial archive.
    expect(buffer.byteLength).toBeGreaterThan(2000);
    // The zip local-file header magic.
    expect(Array.from(buffer.slice(0, 2))).toEqual([0x50, 0x4b]);
  });

  it("accepts a rich body directly", async () => {
    const buffer = await buildDocx({
      title: "Rich",
      body: {
        contentFormat: "tiptap-json",
        contentSchemaVersion: 1,
        content: JSON.stringify({
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
          ],
        }),
        plainText: "Hello",
      },
      bibliography: [],
    });
    expect(buffer.byteLength).toBeGreaterThan(2000);
  });

  it("exports footnotes as real DOCX footnotes (numbered by order)", async () => {
    const buffer = await buildDocx({
      title: "With footnotes",
      body: {
        contentFormat: "tiptap-json",
        contentSchemaVersion: 1,
        content: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "The claim" },
                {
                  type: "footnoteRef",
                  attrs: { label: "1", text: "Quijano, ¶ 3–4." },
                },
                { type: "text", text: " and more" },
                {
                  type: "footnoteRef",
                  attrs: { label: "2", text: "A second note." },
                },
              ],
            },
          ],
        }),
        plainText: "The claim and more",
      },
      bibliography: [],
    });
    expect(Array.from(buffer.slice(0, 2))).toEqual([0x50, 0x4b]);
    // A real footnotes part ships in the archive (ZIP stores entry names
    // as plain bytes, so the part name is directly greppable).
    expect(buffer.toString("latin1")).toContain("footnotes.xml");
  });
});

// ──────────────────────────────────────────────
// B19: DOCX fidelity (lists, links, quotes, spans, bibliography)
// ──────────────────────────────────────────────

describe("buildDocx structure fidelity (B19)", () => {
  it("exports lists recursively with nesting, start values, and separate numbering instances", async () => {
    const body = richJson([
      {
        type: "orderedList",
        attrs: { start: 1, type: null },
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "First" }] },
              {
                type: "orderedList",
                attrs: { start: 1, type: "a" },
                content: [
                  {
                    type: "listItem",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "Nested one" }],
                      },
                    ],
                  },
                  {
                    type: "listItem",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "Nested two" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Second" }] },
            ],
          },
        ],
      },
      {
        type: "orderedList",
        attrs: { start: 3, type: "1" },
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Third" }] },
            ],
          },
        ],
      },
    ]);
    const { document: xml, numbering } = await readDocxParts(
      await buildDocx({ title: "Lists", body, bibliography: [] }),
    );

    // Nesting: the nested items carry level 1 in document order.
    expect(xml).toContain('<w:ilvl w:val="1"/>');
    const first = xml.indexOf("First");
    const nestedOne = xml.indexOf("Nested one");
    const nestedTwo = xml.indexOf("Nested two");
    const second = xml.indexOf("Second");
    expect(first).toBeLessThan(nestedOne);
    expect(nestedOne).toBeLessThan(nestedTwo);
    expect(nestedTwo).toBeLessThan(second);

    // The nested list's own type reaches the abstract numbering.
    expect(numbering).toContain('w:numFmt w:val="decimal"');
    expect(numbering).toContain('w:numFmt w:val="lowerLetter"');

    // Separate numbering instances: the two top-level lists do not share
    // a concrete numbering id, so the second starts at its own value.
    const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(
      (m) => m[1],
    );
    expect(numIds.length).toBeGreaterThanOrEqual(4);
    expect(new Set(numIds).size).toBe(2);
    const startOverrides = [
      ...numbering.matchAll(/<w:startOverride w:val="(\d+)"\/>/g),
    ].map((m) => Number(m[1]));
    expect(startOverrides).toContain(3);
  });

  it("exports hyperlinks as real relationship-backed links in text order", async () => {
    const body = richJson([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "See " },
          {
            type: "text",
            text: "the archive",
            marks: [
              {
                type: "link",
                attrs: { href: "https://example.org/archive", target: "_blank" },
              },
            ],
          },
          { type: "text", text: " now." },
        ],
      },
    ]);
    const { document: xml, rels } = await readDocxParts(
      await buildDocx({ title: "Links", body, bibliography: [] }),
    );

    expect(xml).toContain("<w:hyperlink");
    const see = xml.indexOf("See ");
    const link = xml.indexOf("the archive");
    const now = xml.indexOf(" now.");
    expect(see).toBeGreaterThanOrEqual(0);
    expect(see).toBeLessThan(link);
    expect(link).toBeLessThan(now);
    // The URL is a real external relationship, not dangling text.
    expect(rels).toContain("https://example.org/archive");
    expect(rels).toContain('TargetMode="External"');
  });

  it("preserves quotation paragraph boundaries, indentation, and tables inside quotations", async () => {
    const body = richJson([
      {
        type: "blockquote",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Quote one" }] },
          { type: "paragraph", content: [{ type: "text", text: "Quote two" }] },
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    attrs: { colspan: 1, rowspan: 1 },
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "Quoted cell" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const { document: xml } = await readDocxParts(
      await buildDocx({ title: "Quotes", body, bibliography: [] }),
    );

    const one = xml.indexOf("Quote one");
    const two = xml.indexOf("Quote two");
    const cell = xml.indexOf("Quoted cell");
    expect(one).toBeGreaterThanOrEqual(0);
    expect(one).toBeLessThan(two);
    expect(two).toBeLessThan(cell);
    // Two separate quote paragraphs, each indented; the table survived.
    expect(countOccurrences(xml, "<w:p>")).toBeGreaterThanOrEqual(2);
    expect(xml).toContain('<w:ind w:left="720"');
    expect(xml).toContain("<w:tbl>");
  });

  it("exports merged table cells with grid spans and vertical merges", async () => {
    const body = richJson([
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { colspan: 2, rowspan: 1 },
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Wide" }],
                  },
                ],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 2 },
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Tall" }],
                  },
                ],
              },
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1 },
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "A" }] },
                ],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1 },
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "B" }] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const { document: xml } = await readDocxParts(
      await buildDocx({ title: "Merged", body, bibliography: [] }),
    );

    expect(xml).toContain('<w:gridSpan w:val="2"/>');
    expect(xml).toContain('<w:vMerge w:val="restart"/>');
  });

  it("skips an empty bibliography section entirely", async () => {
    const body = richJson([
      { type: "paragraph", content: [{ type: "text", text: "Only prose." }] },
    ]);
    const { document: xml } = await readDocxParts(
      await buildDocx({ title: "No refs", body, bibliography: [] }),
    );
    expect(xml).toContain("Only prose.");
    expect(xml).not.toContain("Bibliography");
    expect(xml).not.toContain("References");
  });

  it("appends the generated bibliography only when asked to", async () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "References" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Césaire, A. (1966)." }],
        },
      ],
    };
    const body = richJson(json.content as unknown[]);
    const entries = [[{ text: "Césaire, A. (1966). " }, { text: "Une saison", italic: true }]];

    expect(hasBibliographyHeading(json, "References")).toBe(true);
    expect(hasBibliographyHeading(json, "Works Cited")).toBe(false);

    const skipped = await readDocxParts(
      await buildDocx({
        title: "Existing",
        body,
        bibliography: entries,
        bibliographyTitle: "References",
        appendBibliography: false,
      }),
    );
    expect(countOccurrences(skipped.document, "References")).toBe(1);

    const appended = await readDocxParts(
      await buildDocx({
        title: "Generated",
        body,
        bibliography: entries,
        bibliographyTitle: "References",
      }),
    );
    // Default is to append — but the caller can and does suppress it.
    expect(countOccurrences(appended.document, "References")).toBe(2);
  });

  it("keeps a source-backed footnote's fallback text even when its source is gone", async () => {
    const body = richJson([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Claim" },
          {
            type: "footnoteRef",
            attrs: {
              id: "fn-1",
              label: "1",
              text: "Quijano, ¶ 3–4.",
              sourceId: "deleted-source",
              passageId: "passage-1",
              locator: "¶ 3–4",
            },
          },
        ],
      },
    ]);
    const { footnotes } = await readDocxParts(
      await buildDocx({ title: "Fallback", body, bibliography: [] }),
    );
    expect(footnotes).toContain("Quijano, ¶ 3–4.");
  });
});
