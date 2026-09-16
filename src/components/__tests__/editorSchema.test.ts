// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  richBodyProblem,
  validateRichJson,
  validateRichPayload,
} from "@/components/editor/editorSchema";
import { richDocument } from "@/utils/documentCodec";

const validDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Prose " },
        { type: "citation", attrs: { sourceId: "s1", label: "(Smith, 1999)" } },
        { type: "footnoteRef", attrs: { label: "1", text: "A note." } },
      ],
    },
  ],
};

describe("canonical rich validation (B10)", () => {
  it("accepts a valid document and derives its plain text", () => {
    const result = validateRichJson(validDoc);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plainText).toContain("Prose (Smith, 1999)");
      expect(result.plainText).toContain("[^1] A note.");
    }
  });

  it("rejects unknown node types instead of silently dropping them", () => {
    const result = validateRichJson({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "kept" }] },
        { type: "futureWidget" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/futureWidget/i);
  });

  it("rejects unknown mark types", () => {
    const result = validateRichJson({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "styled",
              marks: [{ type: "futureHighlight" }],
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/futureHighlight/i);
  });

  it("rejects content that violates the schema", () => {
    const result = validateRichJson({
      type: "doc",
      content: [{ type: "text", text: "bare inline text at block level" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects payloads that are not a document", () => {
    const result = validateRichJson({
      type: "paragraph",
      content: [{ type: "text", text: "not a doc" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a document/i);
  });

  it("reports JSON syntax errors", () => {
    const result = validateRichPayload("{not json");
    expect(result.ok).toBe(false);
  });

  it("richBodyProblem explains why a stored body cannot open", () => {
    const body = richDocument(validDoc);
    expect(richBodyProblem(body)).toBeNull();
    const broken = {
      ...richDocument({ type: "doc", content: [{ type: "futureWidget" }] }),
    };
    const problem = richBodyProblem(broken);
    expect(problem).toMatch(/preserved/i);
    expect(problem).toMatch(/Save is disabled/i);
  });
});
