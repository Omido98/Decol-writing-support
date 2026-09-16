// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import {
  FootnoteRef,
  closeFootnoteEditor,
  collectFootnotes,
  nextFootnoteLabel,
} from "@/components/editor/footnoteExtension";
import { plainTextFromProseMirror, richDocument } from "@/utils/documentCodec";

let editor: Editor | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  closeFootnoteEditor();
  editor?.destroy();
  editor = null;
  host?.remove();
  host = null;
});

function makeEditor(): Editor {
  return new Editor({ extensions: [StarterKit, FootnoteRef, Markdown], content: "" });
}

function makeMountedEditor(): Editor {
  host = document.createElement("div");
  document.body.appendChild(host);
  return new Editor({
    element: host,
    extensions: [StarterKit, FootnoteRef, Markdown],
    content: "",
  });
}

describe("footnote nodes (5.4e part 2, B19)", () => {
  it("inserts footnotes with sequential labels, stable ids, readable plain text, and locators", () => {
    editor = makeEditor();
    editor.commands.insertContent("<p>Coloniality persists.</p>");
    expect(nextFootnoteLabel(editor.state.doc)).toBe("1");
    editor.commands.insertFootnote({
      label: "1",
      text: "Quijano, Colonialidad, ¶ 3–4.",
    });
    expect(nextFootnoteLabel(editor.state.doc)).toBe("2");
    editor.commands.insertFootnote({ label: "2", text: "Personal note." });

    // Collected in document order (each footnote is distinct — no dedup).
    const notes = collectFootnotes(editor.state.doc);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({
      label: "1",
      text: "Quijano, Colonialidad, ¶ 3–4.",
    });
    expect(notes[1]).toMatchObject({ label: "2", text: "Personal note." });
    // Stable identity: distinct, non-empty ids minted per note.
    expect(notes[0].id).toBeTruthy();
    expect(notes[0].id).not.toBe(notes[1].id);

    // Plain text keeps the markers + content (search/readouts find them).
    const body = richDocument(editor.getJSON());
    expect(body.plainText).toContain("[^1] Quijano, Colonialidad, ¶ 3–4.");
    expect(body.plainText).toContain("[^2] Personal note.");
    expect(plainTextFromProseMirror(JSON.parse(body.content))).toContain(
      "[^1] Quijano, Colonialidad, ¶ 3–4.",
    );
  });

  it("survives a markdown export/reimport round-trip with its content and identity", () => {
    editor = makeEditor();
    editor.commands.insertContent("<p>The claim.</p>");
    editor.commands.insertFootnote({
      label: "1",
      text: 'See Césaire, <Une saison> & "notes", ¶ 7.',
    });
    const before = collectFootnotes(editor.state.doc);

    const md = editor.getMarkdown();
    // The footnote rides literal HTML with its content in a data attribute.
    expect(md).toContain("data-footnote");
    expect(md).toContain(`data-footnote-id="${before[0].id}"`);

    editor = makeEditor();
    editor.commands.setContent(md, { contentType: "markdown" });
    // Identity and text survive exactly (the id is not re-minted).
    expect(collectFootnotes(editor.state.doc)).toEqual(before);
  });

  it("keeps source provenance (source, passage, locator, fallback text) on the note", () => {
    editor = makeEditor();
    editor.commands.insertContent("<p>Claim.</p>");
    editor.commands.insertFootnote({
      id: "fn-1",
      label: "1",
      text: "Césaire, A. (1966). Une saison au Congo, ¶ 3–4.",
      sourceId: "s1",
      passageId: "passage-1",
      locator: "¶ 3–4",
    });

    const md = editor.getMarkdown();
    expect(md).toContain('data-source-id="s1"');
    expect(md).toContain('data-passage-id="passage-1"');
    expect(md).toContain('data-locator="¶ 3–4"');

    editor = makeEditor();
    editor.commands.setContent(md, { contentType: "markdown" });
    expect(collectFootnotes(editor.state.doc)).toEqual([
      {
        id: "fn-1",
        label: "1",
        text: "Césaire, A. (1966). Une saison au Congo, ¶ 3–4.",
        sourceId: "s1",
        passageId: "passage-1",
        locator: "¶ 3–4",
      },
    ]);
  });

  it("escapes both the carrier attribute and the marker text in markdown", () => {
    editor = makeEditor();
    editor.commands.insertContent("<p>The claim.</p>");
    // A hostile note and label: raw quotes would break the attribute, raw
    // angle brackets would inject markup into the literal HTML run.
    editor.commands.insertFootnote({
      label: '2 " <b>x</b>',
      text: 'Note "quoted" & </sup><script>alert(1)</script>',
    });

    const md = editor.getMarkdown();
    expect(md).toContain("&quot;");
    expect(md).toContain("&lt;script&gt;");
    expect(md).not.toContain("<script>");
    expect(md).not.toContain('data-footnote-text="Note "quoted"');

    editor = makeEditor();
    editor.commands.setContent(md, { contentType: "markdown" });
    // The text survives verbatim; the marker label is normalized to
    // document order by the renumbering plugin (hostile labels included).
    expect(collectFootnotes(editor.state.doc)).toEqual([
      {
        id: expect.any(String),
        label: "1",
        text: 'Note "quoted" & </sup><script>alert(1)</script>',
        sourceId: null,
        passageId: null,
        locator: "",
      },
    ]);
  });

  it("renumbers notes from document order so deleting one cannot leave duplicate labels", () => {
    editor = makeEditor();
    editor.commands.insertContent("<p>One</p>");
    editor.commands.insertFootnote({ label: "1", text: "First" });
    editor.commands.insertContent("<p>Two</p>");
    editor.commands.insertFootnote({ label: "2", text: "Second" });
    editor.commands.insertContent("<p>Three</p>");
    editor.commands.insertFootnote({ label: "3", text: "Third" });

    // Delete the FIRST note; the remaining notes renumber to 1..2.
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos < 0 && node.type.name === "footnoteRef") pos = p;
    });
    const target = editor.state.doc.nodeAt(pos);
    expect(target).toBeTruthy();
    editor
      .chain()
      .deleteRange({ from: pos, to: pos + target!.nodeSize })
      .run();

    const notes = collectFootnotes(editor.state.doc);
    expect(notes.map((n) => n.label)).toEqual(["1", "2"]);
    expect(notes.map((n) => n.text)).toEqual(["Second", "Third"]);
    // The next label cannot collide with an existing note.
    expect(nextFootnoteLabel(editor.state.doc)).toBe("3");
    editor.commands.insertFootnote({ label: "9", text: "Fourth" });
    expect(collectFootnotes(editor.state.doc).map((n) => n.label)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("normalizes stale and duplicate labels on load, without editing (F10)", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    editor = new Editor({
      element: host,
      extensions: [StarterKit, FootnoteRef, Markdown],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Claim" },
              {
                type: "footnoteRef",
                attrs: { id: "fn-a", label: "7", text: "First" },
              },
              { type: "text", text: " and" },
              {
                type: "footnoteRef",
                attrs: { id: "fn-b", label: "7", text: "Second" },
              },
            ],
          },
        ],
      },
    });

    // No edit happened: the load normalization must fix the stored labels.
    await waitFor(() => {
      expect(collectFootnotes(editor!.state.doc).map((n) => n.label)).toEqual([
        "1",
        "2",
      ]);
    });
    // The rendered markers show the normalized labels too.
    const markers = host.querySelectorAll(
      "sup.footnote-node .footnote-label",
    );
    expect([...markers].map((m) => m.textContent)).toEqual(["1", "2"]);
    // The next label stays collision-free after the normalization.
    expect(nextFootnoteLabel(editor.state.doc)).toBe("3");
  });

  it("edits a note's text through the marker's click-to-edit popover", () => {
    editor = makeMountedEditor();
    editor.commands.insertContent("<p>Claim</p>");
    editor.commands.insertFootnote({ label: "1", text: "Original note." });

    const marker = host!.querySelector("sup.footnote-node") as HTMLElement;
    expect(marker).toBeTruthy();
    expect(marker.title).toContain("Original note.");
    marker.click();

    const input = document.querySelector(
      "[data-footnote-editor] textarea",
    ) as HTMLTextAreaElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("Original note.");
    input.value = "Corrected note, ¶ 9.";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    expect(collectFootnotes(editor.state.doc)[0].text).toBe(
      "Corrected note, ¶ 9.",
    );
    // The marker is inspectable without opening the editor.
    expect(
      (host!.querySelector("sup.footnote-node") as HTMLElement).title,
    ).toContain("Corrected note, ¶ 9.");
    expect(document.querySelector("[data-footnote-editor]")).toBeNull();
  });

  it("lets Escape close the note editor without changing the text", () => {
    editor = makeMountedEditor();
    editor.commands.insertContent("<p>Claim</p>");
    editor.commands.insertFootnote({ label: "1", text: "Keep me." });

    (host!.querySelector("sup.footnote-node") as HTMLElement).click();
    const input = document.querySelector(
      "[data-footnote-editor] textarea",
    ) as HTMLTextAreaElement;
    input.value = "Discard me.";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(collectFootnotes(editor.state.doc)[0].text).toBe("Keep me.");
    expect(document.querySelector("[data-footnote-editor]")).toBeNull();
  });
});
