// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Citation, collectCitations } from "@/components/editor/citationExtension";
import { plainTextFromProseMirror, richDocument } from "@/utils/documentCodec";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function makeEditor(): Editor {
  return new Editor({ extensions: [StarterKit, Citation, Markdown], content: "" });
}

describe("citation nodes", () => {
  it("insert, collect, and survive a markdown export/reimport round-trip", () => {
    editor = makeEditor();
    editor.commands.insertContent("<p>Scholars disagree.</p>");
    editor.commands.insertCitation({ sourceId: "s1", label: "(Césaire, 1966)" });

    // Collected by source id, in order.
    expect(collectCitations(editor.state.doc)).toEqual([
      { sourceId: "s1", label: "(Césaire, 1966)" },
    ]);

    // The rich body carries the node with its source id.
    const body = richDocument(editor.getJSON());
    expect(body.plainText).toContain("(Césaire, 1966)");
    expect(plainTextFromProseMirror(JSON.parse(body.content))).toContain(
      "(Césaire, 1966)",
    );

    // Markdown export keeps the citation as HTML → reimport restores it.
    const md = editor.getMarkdown();
    editor = makeEditor();
    editor.commands.setContent(md, { contentType: "markdown" });
    const cites = collectCitations(editor.state.doc);
    expect(cites).toEqual([{ sourceId: "s1", label: "(Césaire, 1966)" }]);
  });

  it("escapes labels and source ids in markdown so markup cannot break out", () => {
    editor = makeEditor();
    editor.commands.insertContent("<p>Claim.</p>");
    const label = 'He said "less than < this" & <em>that</em>';
    editor.commands.insertCitation({ sourceId: 's"1', label });

    const md = editor.getMarkdown();
    // The attribute and the element text are entity-escaped...
    expect(md).toContain('data-source-id="s&quot;1"');
    expect(md).toContain("&lt;em&gt;");
    // ...so the aggressive label cannot become real markup.
    expect(md).not.toContain("<em>");
    expect(md).not.toContain('data-source-id="s"1"');

    // The escaped form round-trips to the exact original label and id.
    editor = makeEditor();
    editor.commands.setContent(md, { contentType: "markdown" });
    expect(collectCitations(editor.state.doc)).toEqual([
      { sourceId: 's"1', label },
    ]);
  });
});
