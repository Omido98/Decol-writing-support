import { describe, it, expect } from "vitest";
import {
  collectSourceRefs,
  collectSourceRefsFromJson,
  missingSourceIds,
} from "@/utils/sourceRefs";

const docJson = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "First " },
        { type: "citation", attrs: { sourceId: "s1", label: "(One, 2001)" } },
        {
          type: "footnoteRef",
          attrs: { id: "fn-1", label: "1", text: "note", sourceId: "s2" },
        },
      ],
    },
    {
      type: "paragraph",
      content: [
        { type: "citation", attrs: { sourceId: "s1", label: "(One, 2001)" } },
        {
          type: "footnoteRef",
          attrs: { id: "fn-2", label: "2", text: "plain note" },
        },
      ],
    },
  ],
};

describe("source references (B19)", () => {
  it("collects citation AND footnote source ids in document order, deduplicated", () => {
    expect(collectSourceRefsFromJson(docJson)).toEqual([
      { sourceId: "s1" },
      { sourceId: "s2" },
    ]);
  });

  it("ignores atoms without a source id and unsupported payloads", () => {
    expect(collectSourceRefsFromJson({ type: "doc", content: [] })).toEqual([]);
    expect(collectSourceRefsFromJson(null)).toEqual([]);
    expect(
      collectSourceRefsFromJson({
        type: "doc",
        content: [
          {
            type: "footnoteRef",
            attrs: { id: "x", label: "1", text: "no source" },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("reads a live editor document the same way", () => {
    const fakeDoc = {
      descendants: (
        fn: (
          node: { type: { name: string }; attrs: Record<string, unknown> },
          pos: number,
        ) => void,
      ) => {
        fn({ type: { name: "citation" }, attrs: { sourceId: "s1" } }, 0);
        fn({ type: { name: "footnoteRef" }, attrs: { sourceId: "s2" } }, 5);
        fn({ type: { name: "footnoteRef" }, attrs: { sourceId: null } }, 9);
        fn({ type: { name: "text" }, attrs: {} }, 12);
      },
    };
    expect(collectSourceRefs(fakeDoc)).toEqual([
      { sourceId: "s1" },
      { sourceId: "s2" },
    ]);
  });

  it("reports ids whose source records no longer exist", () => {
    const refs = [{ sourceId: "s1" }, { sourceId: "gone" }];
    expect(missingSourceIds(refs, [{ id: "s1" }])).toEqual(["gone"]);
    expect(missingSourceIds(refs, [{ id: "s1" }, { id: "gone" }])).toEqual([]);
  });
});
