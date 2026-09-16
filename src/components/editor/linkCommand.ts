import type { Editor } from "@tiptap/react";

// ──────────────────────────────────────────────
// The ONE link insertion flow (B20a)
// ──────────────────────────────────────────────
// The toolbar's Link button and the editor's Ctrl/Cmd+K shortcut must do
// the same thing; before B20a the toolbar advertised Ctrl+K while the
// shell's command palette actually owned that chord.

/** Prompt for a URL (empty removes the link) and apply it at the
 * selection through the editor's own chain. */
export function promptForLink(editor: Editor): void {
  const previous = (editor.getAttributes("link").href as string) ?? "";
  const url = window.prompt("Link URL (empty to remove)", previous);
  if (url === null) return;
  if (url.trim() === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  editor
    .chain()
    .focus()
    .extendMarkRange("link")
    .setLink({ href: url.trim() })
    .run();
}
