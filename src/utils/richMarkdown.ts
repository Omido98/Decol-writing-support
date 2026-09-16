import type { DocumentBody } from "@/utils/documentCodec";
import {
  canonicalHeadlessEditor,
  validateRichPayload,
} from "@/components/editor/editorSchema";

// ──────────────────────────────────────────────
// Rich ↔ markdown conversion utilities (Phase 4.3, repaired in B10)
// ──────────────────────────────────────────────
// Conversion runs through the SAME canonical extensions the editor uses
// (see editorSchema.ts), so export, import, the reader, DOCX preparation,
// and the editor can never disagree about what a document may contain —
// including citation and footnote atoms. One headless editor instance is
// reused; it is never focused (no DOM view needed).

/**
 * Markdown for export/display of a rich body: the editor's own serializer
 * output (structure-preserving). Markdown bodies pass through untouched.
 *
 * A payload that fails schema validation (unknown nodes from a newer
 * build, corrupt JSON) is shown VERBATIM in a code block — the previous
 * behavior let ProseMirror silently drop unknown content and return an
 * empty document, which presented a non-empty manuscript as empty.
 */
export function markdownFromRich(body: DocumentBody): string {
  if (body.contentFormat === "markdown") return body.content;
  const valid = validateRichPayload(body.content);
  if (!valid.ok) {
    return "```\n" + body.content + "\n```";
  }
  const editor = canonicalHeadlessEditor();
  editor.commands.setContent(valid.json, { errorOnInvalidContent: true });
  return editor.getMarkdown();
}

/**
 * Parse markdown into a serialized rich payload (the tiptap-json content
 * string) through the editor's own parser.
 */
export function richFromMarkdown(markdown: string): string {
  const editor = canonicalHeadlessEditor();
  editor.commands.setContent(markdown, { contentType: "markdown" });
  return JSON.stringify(editor.getJSON());
}
