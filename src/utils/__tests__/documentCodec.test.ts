import { describe, expect, it } from "vitest";
import {
  CONTENT_SCHEMA_VERSION,
  decodeDocumentBody,
  decodeDocumentBodyLenient,
  displayTextFromBody,
  markdownDocument,
  markdownFromBody,
  plainTextFromMarkdown,
  plainTextFromProseMirror,
  richDocument,
} from "@/utils/documentCodec";

describe("plainTextFromMarkdown", () => {
  it("strips structural syntax but keeps text", () => {
    const md = [
      "# Heading one",
      "",
      "Some **bold**, *italic*, `code` and [a link](https://example.com).",
      "",
      "> A quotation line.",
      "",
      "- first item",
      "- second item",
      "  1. nested ordered",
      "",
      "---",
    ].join("\n");
    const text = plainTextFromMarkdown(md);
    expect(text).toContain("Heading one");
    expect(text).toContain("Some bold, italic, code and a link.");
    expect(text).toContain("A quotation line.");
    expect(text).toContain("first item");
    expect(text).toContain("nested ordered");
    expect(text).not.toContain("#");
    expect(text).not.toContain("**");
    expect(text).not.toContain("https://example.com");
    expect(text).not.toContain(">");
    expect(text).not.toContain("---");
  });

  it("keeps code fence content verbatim", () => {
    const md = "before\n```rust\nfn main() { }\n```\nafter";
    const text = plainTextFromMarkdown(md);
    expect(text).toContain("fn main() { }");
    expect(text).toContain("before");
    expect(text).toContain("after");
    expect(text).not.toContain("```");
  });

  it("reduces tables to cell text", () => {
    const md = "| A | B |\n| --- | --- |\n| one | two |";
    const text = plainTextFromMarkdown(md);
    expect(text).toContain("A");
    expect(text).toContain("B");
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).not.toContain("|");
    expect(text).not.toContain("---");
  });

  it("keeps task list labels and images as alt text", () => {
    const text = plainTextFromMarkdown("- [x] done task\n![a figure](img.png)");
    expect(text).toContain("done task");
    expect(text).toContain("a figure");
    expect(text).not.toContain("img.png");
  });

  it("keeps unicode text intact", () => {
    const md = "## Décolonisation — أطروحة\n\n« Vous êtes tous les enfants de Dieu »";
    const text = plainTextFromMarkdown(md);
    expect(text).toContain("Décolonisation — أطروحة");
    expect(text).toContain("« Vous êtes tous les enfants de Dieu »");
  });
});

describe("plainTextFromProseMirror", () => {
  it("collects block text with paragraph breaks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello ", marks: [{ type: "bold" }] },
            { type: "text", text: "world" },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
          ],
        },
      ],
    };
    const text = plainTextFromProseMirror(doc);
    expect(text).toBe("Title\n\nHello world\none\ntwo");
  });

  it("handles hardBreaks, blockquotes, tables, and unicode", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "line one" },
                { type: "hardBreak" },
                { type: "text", text: "line two — 你好" },
              ],
            },
          ],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "text", text: "H1" }] },
                { type: "tableCell", content: [{ type: "text", text: "C1" }] },
              ],
            },
          ],
        },
      ],
    };
    const text = plainTextFromProseMirror(doc);
    expect(text).toContain("line one\nline two — 你好");
    expect(text).toContain("H1\nC1");
  });
});

describe("document bodies", () => {
  it("markdownDocument carries the contract fields and derived plain text", () => {
    const body = markdownDocument("# Hi\n\nSome *text*.");
    expect(body.contentFormat).toBe("markdown");
    expect(body.contentSchemaVersion).toBe(CONTENT_SCHEMA_VERSION);
    expect(body.content).toBe("# Hi\n\nSome *text*.");
    expect(body.plainText).toBe("Hi\n\nSome text.");
  });

  it("richDocument serializes the payload and derives plain text structurally", () => {
    const body = richDocument({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Rich body" }] }],
    });
    expect(body.contentFormat).toBe("tiptap-json");
    expect(body.content).toBe(
      JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Rich body" }] }],
      }),
    );
    expect(body.plainText).toBe("Rich body");
    // The serialized payload must never masquerade as plain text.
    expect(body.plainText).not.toContain("contentFormat");
  });
});

describe("decodeDocumentBody", () => {
  it("decodes pre-contract rows (no format fields) as markdown v1", () => {
    const body = decodeDocumentBody({ content: "plain legacy body" });
    expect(body).toEqual({
      contentFormat: "markdown",
      contentSchemaVersion: 1,
      content: "plain legacy body",
      plainText: "plain legacy body",
    });
  });

  it("decodes full contract rows", () => {
    const body = decodeDocumentBody({
      content: "{}",
      contentFormat: "tiptap-json",
      contentSchemaVersion: CONTENT_SCHEMA_VERSION,
      plainText: "text",
    });
    expect(body?.contentFormat).toBe("tiptap-json");
    expect(body?.plainText).toBe("text");
  });

  it("rejects unknown formats loudly", () => {
    expect(() =>
      decodeDocumentBody({
        content: "foreign",
        contentFormat: "notion-export",
        contentSchemaVersion: 1,
        plainText: null,
      }),
    ).toThrow(/unsupported format/);
  });

  it("rejects newer schema versions loudly", () => {
    expect(() =>
      decodeDocumentBody({
        content: "future",
        contentFormat: "markdown",
        contentSchemaVersion: CONTENT_SCHEMA_VERSION + 1,
        plainText: null,
      }),
    ).toThrow(/newer content schema/);
  });

  it("returns null for missing bodies", () => {
    expect(decodeDocumentBody(null)).toBeNull();
    expect(decodeDocumentBody(undefined)).toBeNull();
  });

  it("derives plain text from rich nodes when the row has none (B10)", () => {
    const content = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Derived prose " },
            { type: "citation", attrs: { sourceId: "s1", label: "(Smith, 1999)" } },
          ],
        },
      ],
    });
    const body = decodeDocumentBody({
      content,
      contentFormat: "tiptap-json",
      contentSchemaVersion: 1,
      plainText: null,
    });
    expect(body?.plainText).toBe("Derived prose (Smith, 1999)");
    // Serialized JSON must never masquerade as readable plain text.
    expect(body?.plainText).not.toContain('"type"');
    expect(body?.plainText).not.toContain("contentFormat");
  });

  it("keeps the content untouched when rich plain text cannot be derived", () => {
    const body = decodeDocumentBody({
      content: "{not json",
      contentFormat: "tiptap-json",
      contentSchemaVersion: 1,
      plainText: null,
    });
    expect(body?.content).toBe("{not json");
    expect(body?.plainText).toBe("");
  });

  it("lenient decode degrades unsupported bodies to preserved markdown", () => {
    const body = decodeDocumentBodyLenient({
      content: "foreign-bytes",
      contentFormat: "notion-export",
      contentSchemaVersion: 1,
      plainText: null,
    });
    expect(body?.content).toBe("foreign-bytes");
  });
});

describe("display/export projections", () => {
  it("markdown bodies display their source", () => {
    const body = markdownDocument("# Title\n\ntext");
    expect(displayTextFromBody(body)).toBe("# Title\n\ntext");
    expect(markdownFromBody(body)).toBe("# Title\n\ntext");
  });

  it("rich bodies display derived plain text, never the payload", () => {
    const body = richDocument({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Only text" }] }],
    });
    expect(displayTextFromBody(body)).toBe("Only text");
    expect(markdownFromBody(body)).not.toContain('"type"');
  });
});
