// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import FindReplaceBar from "@/components/editor/FindReplaceBar";

let editor: Editor | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
  host?.remove();
  host = null;
});

/** A REAL Tiptap editor mounted in the DOM (production view path). */
function mountEditor(html: string): Editor {
  host = document.createElement("div");
  document.body.appendChild(host);
  editor = new Editor({
    element: host,
    extensions: [StarterKit, Markdown],
    content: html,
  });
  return editor;
}

describe("FindReplaceBar (B20a)", () => {
  it("keeps focus in Find while Enter navigates and never mutates the manuscript", () => {
    const ed = mountEditor("<p>one two one two one</p>");
    render(<FindReplaceBar editor={ed} onClose={() => {}} />);
    const input = screen.getByLabelText("Find text") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "one" } });

    const before = JSON.stringify(ed.state.doc.toJSON());
    for (let i = 0; i < 3; i++) {
      fireEvent.keyDown(input, { key: "Enter" });
    }

    // Repeated navigation is read-only…
    expect(JSON.stringify(ed.state.doc.toJSON())).toBe(before);
    // …and the caret stays where the user is typing.
    expect(document.activeElement).toBe(input);
    // The document selection did follow the matches (not left at the top).
    expect(ed.state.selection.from).toBeGreaterThan(1);
  });

  it("inserts an HTML-looking replacement as literal text through Replace all", () => {
    const ed = mountEditor("<p>Keep this bold word</p>");
    render(<FindReplaceBar editor={ed} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Find text"), {
      target: { value: "bold" },
    });
    fireEvent.change(screen.getByLabelText("Replace with"), {
      target: { value: "<b>bold</b>" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));

    expect(ed.state.doc.textContent).toBe("Keep this <b>bold</b> word");
    let marked = 0;
    ed.state.doc.descendants((node) => {
      if (node.isText && node.marks.length > 0) marked++;
    });
    expect(marked).toBe(0);
  });

  it("replaces the selected match with Replace", () => {
    const ed = mountEditor("<p>bold word</p>");
    render(<FindReplaceBar editor={ed} onClose={() => {}} />);
    const input = screen.getByLabelText("Find text");
    fireEvent.change(input, { target: { value: "bold" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(screen.getByLabelText("Replace with"), {
      target: { value: "strong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    expect(ed.state.doc.textContent).toBe("strong word");
  });

  it("closes from the Replace input with Escape", () => {
    const ed = mountEditor("<p>text</p>");
    const onClose = vi.fn();
    render(<FindReplaceBar editor={ed} onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText("Replace with"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from the Find input with Escape", () => {
    const ed = mountEditor("<p>text</p>");
    const onClose = vi.fn();
    render(<FindReplaceBar editor={ed} onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText("Find text"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
