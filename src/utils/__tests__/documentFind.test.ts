import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import {
  collectTextRuns,
  findMatches,
  nextMatch,
  replaceMatches,
} from "@/utils/documentFind";

/** Minimal doc stand-in: descendants walks (node, pos) like ProseMirror. */
function fakeDoc(nodes: { text?: string; name?: string }[]): {
  descendants: (f: (n: { isText: boolean; text?: string; type: { name: string } }, pos: number) => boolean | void) => void;
} {
  return {
    descendants(f) {
      let pos = 0;
      for (const node of nodes) {
        const name = node.name ?? "text";
        if (name === "hardBreak") {
          f({ isText: false, type: { name: "hardBreak" } }, pos);
          pos += 1;
          continue;
        }
        const text = node.text ?? "";
        f({ isText: true, text, type: { name } }, pos);
        pos += text.length;
      }
    },
  };
}

describe("collectTextRuns", () => {
  it("merges adjacent text nodes into one run with per-character positions", () => {
    const runs = collectTextRuns(fakeDoc([{ text: "hello " }, { text: "world" }]));
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe("hello world");
    expect(runs[0].positions[0]).toBe(0);
    expect(runs[0].positions[10]).toBe(10); // 'd' of world
  });
});

describe("findMatches", () => {
  it("finds case-insensitive matches and maps to ranges", () => {
    const matches = findMatches(fakeDoc([{ text: "The Archive and the Archive" }]), "archive");
    expect(matches).toEqual([
      { from: 4, to: 11 },
      { from: 20, to: 27 },
    ]);
  });

  it("never matches across a hard break", () => {
    const matches = findMatches(
      fakeDoc([{ text: "spliced" }, { name: "hardBreak" }, { text: "words" }]),
      "splicedwords",
    );
    expect(matches).toEqual([]);
  });

  it("finds matches that cross adjacent text nodes", () => {
    const matches = findMatches(
      fakeDoc([{ text: "plain " }, { text: "bold" }]),
      "plain bold",
    );
    expect(matches).toEqual([{ from: 0, to: 10 }]);
  });

  it("returns nothing for an empty query", () => {
    expect(findMatches(fakeDoc([{ text: "text" }]), "")).toEqual([]);
  });
});

describe("nextMatch", () => {
  const matches = [
    { from: 0, to: 3 },
    { from: 10, to: 13 },
  ];

  it("advances to the next match at or after the position", () => {
    expect(nextMatch(matches, 5, true)).toEqual({ match: matches[1], index: 1 });
  });

  it("wraps around once past the last", () => {
    expect(nextMatch(matches, 15, true)).toEqual({ match: matches[0], index: 0 });
  });

  it("stops at the end when wrapping is off", () => {
    expect(nextMatch(matches, 15, false)).toBeNull();
  });
});

// ── B20a: real ProseMirror documents, Unicode folds, literal replace ──

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    text: {},
  },
});

function realDoc(text: string) {
  return schema.nodeFromJSON({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

describe("real ProseMirror documents (B20a)", () => {
  it("maps matches to real document positions", () => {
    const doc = realDoc("The Archive and the Archive");
    expect(findMatches(doc, "archive")).toEqual([
      { from: 5, to: 12 },
      { from: 21, to: 28 },
    ]);
  });

  it("keeps offsets correct when lowercasing changes length (İ)", () => {
    const doc = realDoc("İstanbul archive");
    // In the folded text 'İ' expands to two code units ("i" + combining
    // dot); the match must still point at the real "archive" characters.
    expect(findMatches(doc, "archive")).toEqual([{ from: 10, to: 17 }]);
    expect(findMatches(doc, "İstanbul")).toEqual([{ from: 1, to: 9 }]);
  });

  it("replaces literally through one transaction (no HTML parsing)", () => {
    const state = EditorState.create({ schema, doc: realDoc("Make this bold now") });
    const matches = findMatches(state.doc, "bold");
    expect(matches).toHaveLength(1);
    const next = state.apply(replaceMatches(state, matches, "<b>bold</b>"));
    // The markup-looking replacement is TEXT, not markup…
    expect(next.doc.textContent).toBe("Make this <b>bold</b> now");
    // …and it acquired no marks from the parse (there is no parse).
    let marked = 0;
    next.doc.descendants((node) => {
      if (node.isText && node.marks.length > 0) marked++;
    });
    expect(marked).toBe(0);
  });

  it("replaces every match from the end so positions stay valid", () => {
    const state = EditorState.create({
      schema,
      doc: realDoc("one two one two one"),
    });
    const matches = findMatches(state.doc, "one");
    expect(matches).toHaveLength(3);
    const next = state.apply(replaceMatches(state, matches, "1"));
    expect(next.doc.textContent).toBe("1 two 1 two 1");
  });
});
