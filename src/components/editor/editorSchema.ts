import { Editor, type Content, type Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { Citation } from "@/components/editor/citationExtension";
import { FootnoteRef } from "@/components/editor/footnoteExtension";
import type { DocumentBody } from "@/utils/documentCodec";
import { plainTextFromProseMirror } from "@/utils/documentCodec";

// ──────────────────────────────────────────────
// Canonical editor schema (B10)
// ──────────────────────────────────────────────
// ONE extension list defines what a rich document can contain. The editor,
// the reader/markdown conversions, and DOCX preparation all build their
// ProseMirror instances from this factory — a node missing from one path
// (previously Citation/FootnoteRef in the headless conversions) silently
// erased that content from exports and the reader.

/** Fresh extension list for an editor instance (extensions are stateless
 * enough to share, but the factory keeps the set explicit in one place). */
export function canonicalExtensions(): Extensions {
  return [StarterKit, TableKit, Citation, FootnoteRef, Markdown];
}

let headless: Editor | null = null;

/** A shared, never-focused editor used for conversions and schema
 * validation. Calls are synchronous; one instance is safe and cheap. */
export function canonicalHeadlessEditor(): Editor {
  if (!headless || headless.isDestroyed) {
    headless = new Editor({ extensions: canonicalExtensions(), content: "" });
  }
  return headless;
}

export type RichValidation =
  | { ok: true; json: Content; plainText: string }
  | { ok: false; error: string };

/**
 * Validate rich document JSON against the canonical schema (not just
 * JSON.parse). Unknown node/mark types, malformed payloads, and content
 * that violates the schema are reported instead of being silently
 * replaced with an empty document by ProseMirror's permissive parser.
 */
export function validateRichJson(json: unknown): RichValidation {
  try {
    const schema = canonicalHeadlessEditor().schema;
    const doc = schema.nodeFromJSON(json);
    if (doc.type.name !== "doc") {
      return {
        ok: false,
        error: `the payload is a "${doc.type.name}" node, not a document`,
      };
    }
    // nodeFromJSON does not check the content expression; check() does.
    doc.check();
    const normalized = doc.toJSON();
    return {
      ok: true,
      json: normalized,
      plainText: plainTextFromProseMirror(normalized),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Validate a stored rich payload string; JSON syntax errors are reported
 * like schema errors (the raw bytes are always preserved by callers). */
export function validateRichPayload(payload: string): RichValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, error: "the payload is not valid JSON" };
  }
  return validateRichJson(parsed);
}

/**
 * Why a body cannot be opened in the rich editor, or null when it can.
 * Markdown bodies always open (their conversion is handled by the editor).
 */
export function richBodyProblem(body: DocumentBody): string | null {
  if (body.contentFormat !== "tiptap-json") return null;
  const result = validateRichPayload(body.content);
  if (result.ok) return null;
  return (
    `This document's rich data cannot be opened with this version ` +
    `(${result.error}). Its stored content is preserved untouched and ` +
    `Save is disabled so nothing can overwrite it.`
  );
}
