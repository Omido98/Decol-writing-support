// ============================================================
// Document format contract (Phase 4.1)
// ============================================================
// Every stored document body carries an explicit, versioned format:
//
//   contentFormat         "markdown" | "tiptap-json"
//   contentSchemaVersion  contract version this payload was written with
//   content               the AUTHORITATIVE payload (markdown source, or a
//                         ProseMirror document serialized to JSON text)
//   plainText             plain text derived from the payload at save time
//                         — used for search, snippets, word counts, and
//                         model context. Raw structured payloads are never
//                         used as manuscript prose.
//
// The document revision number is the text row's `rev` (optimistic
// concurrency, R2); history snapshots (R3) carry the same format fields.
//
// One authoritative copy per document: markdown and tiptap-json are
// formats of the SAME document, never two independently editable copies.
// Conversions (markdown → tiptap-json) are validated and reported; the
// original source is preserved (history snapshot + conversion report).

/** Contract version this build writes. */
export const CONTENT_SCHEMA_VERSION = 1;

/** The formats a stored document body can have. */
export type ContentFormat = "markdown" | "tiptap-json";

/**
 * A document body as it crosses the repository boundary.
 * `content` is always the authoritative payload for the declared format;
 * `plainText` is a derived, disposable projection.
 */
export interface DocumentBody {
  contentFormat: ContentFormat;
  contentSchemaVersion: number;
  /** Markdown source, or a ProseMirror document serialized to JSON text. */
  content: string;
  /** Derived plain text (search/context/word counts). */
  plainText: string;
}

/** Shape of a stored body row before normalization (fields optional on
 * anything written before the contract existed). */
export interface StoredBodyShape {
  content: string;
  contentFormat?: string | null;
  contentSchemaVersion?: number | null;
  plainText?: string | null;
}

/**
 * Reported whenever content is converted between formats (e.g. a legacy
 * markdown document opened in the rich editor). Kept with the document so
 * the conversion is auditable; the original source remains in history.
 */
export interface ConversionReport {
  from: ContentFormat;
  to: ContentFormat;
  /** ISO time of the conversion. */
  at: string;
  /** Constructs that could not be represented exactly in the target. */
  warnings: string[];
  /** True when the conversion preserved the full supported structure. */
  lossless: boolean;
}

// ──────────────────────────────────────────────
// Plain-text derivation
// ──────────────────────────────────────────────

/**
 * Deterministically derive plain text from a markdown source. Fidelity
 * target: snippets, search, word counts, and model context — not round
 * tripping. Structural syntax (markers, links, images, emphasis) is
 * stripped; text (including code and table cells) is kept.
 */
export function plainTextFromMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (!inFence && /^\s*(```|~~~)/.test(line)) {
      inFence = true;
      continue;
    }
    if (inFence) {
      // Close the fence; its content was already emitted verbatim.
      if (/^\s*(```|~~~)\s*$/.test(line)) inFence = false;
      else out.push(line);
      continue;
    }
    let l = line
      .replace(/^\s*\|/, " ") // leading table pipe
      .replace(/\|\s*$/, " ") // trailing table pipe
      .replace(/\|/g, " "); // remaining cell borders
    // Table separator rows (--- | ---) carry no text.
    if (/^\s*:?-{2,}[\s:-]*$/.test(l)) continue;
    l = l
      .replace(/^#{1,6}\s+/, "") // ATX headings
      .replace(/^\s*>\s?/, "") // blockquotes
      .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, "") // list items + tasks
      .replace(/^\s*\d+[.)]\s+/, ""); // ordered list items
    // Setext underlines and horizontal rules carry no text.
    if (/^\s*(={2,}|-{3,}|\*{3,}|_{3,})\s*$/.test(l)) continue;
    l = l
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1") // reference links → text
      .replace(/`([^`]*)`/g, "$1") // inline code
      .replace(/(\*\*\*|___)(?=\S)(.+?)(?<=\S)\1/g, "$2")
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
      .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2")
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1") // strikethrough
      .replace(/<[^>]+>/g, " ") // raw HTML tags
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Derive plain text from a ProseMirror document in JSON form WITHOUT a
 * schema: text nodes are collected; block boundaries (paragraphs,
 * headings, list items, table rows) become line breaks. Generic by design
 * — it must not depend on which node extensions are installed.
 */
export function plainTextFromProseMirror(doc: unknown): string {
  /** Separators BETWEEN the direct children of a container block. */
  const CHILD_SEPARATORS: Record<string, string> = {
    listItem: "\n",
    tableRow: "\n",
    tableHeader: " ",
    tableCell: " ",
  };
  /** Separators BETWEEN sibling text blocks (paragraphs, headings…). */
  const BLOCK_SEPARATOR = "\n\n";

  function isNode(
    n: unknown,
  ): n is { type: string; content?: unknown[]; text?: string; attrs?: { label?: string } } {
    return (
      typeof n === "object" &&
      n !== null &&
      typeof (n as { type?: unknown }).type === "string"
    );
  }

  const chunks: string[] = [];
  let inline: string[] = [];

  /** Close the currently open text block, prefixed with `sep`. */
  function flush(sep: string): void {
    const text = inline.join("");
    inline = [];
    if (text.trim() === "") return; // empty block: skip, keep no separator
    chunks.push(sep + text);
  }

  function walk(node: unknown, sep: string): void {
    if (typeof node === "string" || typeof node === "number") {
      inline.push(String(node));
      return;
    }
    if (!isNode(node)) return;
    if (typeof node.text === "string") {
      inline.push(node.text);
      return;
    }
    // Citation atoms carry their author-date label as the readable text.
    if (node.type === "citation") {
      const label = (node.attrs as { label?: string } | undefined)?.label;
      if (typeof label === "string") inline.push(label);
      return;
    }
    // Footnote atoms read as their marker + content (search/readouts keep
    // the footnote text findable).
    if (node.type === "footnoteRef") {
      const attrs = (node.attrs ?? {}) as { label?: string; text?: string };
      inline.push(
        attrs.text ? `[^${attrs.label}] ${attrs.text}` : `[^${attrs.label}]`,
      );
      return;
    }
    switch (node.type) {
      case "hardBreak":
        inline.push("\n");
        return;
      case "horizontalRule":
        flush(sep);
        return;
      case "paragraph":
      case "heading":
      case "codeBlock":
        for (const child of node.content ?? []) walk(child, sep);
        flush(sep);
        return;
      default: {
        // Container (doc, lists, quotes, tables, cells…): children decide
        // how they separate; a trailing inline run closes with `sep`.
        const childSep = CHILD_SEPARATORS[node.type] ?? sep;
        for (const child of node.content ?? []) walk(child, childSep);
        flush(sep);
      }
    }
  }

  walk(doc, BLOCK_SEPARATOR);
  flush("");
  return chunks.join("").trim();
}

// ──────────────────────────────────────────────
// Building bodies
// ──────────────────────────────────────────────

/** Wrap a markdown source as a contract-conformant document body. */
export function markdownDocument(source: string): DocumentBody {
  return {
    contentFormat: "markdown",
    contentSchemaVersion: CONTENT_SCHEMA_VERSION,
    content: source,
    plainText: plainTextFromMarkdown(source),
  };
}

/**
 * Wrap a ProseMirror document as a rich document body. The payload is the
 * serialized JSON text; plain text is derived structurally (never by
 * stringifying the payload).
 */
export function richDocument(doc: unknown): DocumentBody {
  return {
    contentFormat: "tiptap-json",
    contentSchemaVersion: CONTENT_SCHEMA_VERSION,
    content: JSON.stringify(doc),
    plainText: plainTextFromProseMirror(doc),
  };
}

// ──────────────────────────────────────────────
// Decoding stored bodies
// ──────────────────────────────────────────────

const KNOWN_FORMATS: ContentFormat[] = ["markdown", "tiptap-json"];

function isKnownFormat(value: string | null | undefined): value is ContentFormat {
  return typeof value === "string" && (KNOWN_FORMATS as string[]).includes(value);
}

/**
 * Derive plain text from a stored rich payload string without a schema.
 * Invalid JSON yields "" (the bytes are preserved; there are no valid
 * nodes to read). Serialized JSON must never stand in as manuscript prose.
 */
function plainTextFromRichContent(content: string): string {
  try {
    return plainTextFromProseMirror(JSON.parse(content));
  } catch {
    return "";
  }
}

/**
 * Normalize a stored body row into the contract. Rows written before the
 * contract (plain markdown, no format fields) decode as markdown v1.
 * A body written by an UNKNOWN format or a NEWER schema version fails
 * LOUDLY — silently relabeling foreign content would corrupt it; the
 * stored bytes stay untouched and a newer build can still read them.
 */
export function decodeDocumentBody(raw: StoredBodyShape | null | undefined): DocumentBody | null {
  if (raw == null) return null;
  if (typeof raw.content !== "string") return null;
  const format = raw.contentFormat ?? null;
  const schemaVersion = raw.contentSchemaVersion ?? null;
  if (format === null && schemaVersion === null) {
    // Pre-contract row: markdown, schema v1.
    return {
      contentFormat: "markdown",
      contentSchemaVersion: 1,
      content: raw.content,
      plainText: raw.plainText ?? plainTextFromMarkdown(raw.content),
    };
  }
  if (!isKnownFormat(format)) {
    throw new Error(
      `This document was written in an unsupported format (${format ?? "missing"}). ` +
        `Its content is preserved untouched; a newer version of this app is needed to open it.`,
    );
  }
  if (schemaVersion == null || schemaVersion > CONTENT_SCHEMA_VERSION) {
    throw new Error(
      `This document uses a newer content schema (v${schemaVersion ?? "?"}); ` +
        `this build supports up to v${CONTENT_SCHEMA_VERSION}. The content is preserved untouched.`,
    );
  }
  return {
    contentFormat: format,
    contentSchemaVersion: schemaVersion,
    content: raw.content,
    plainText:
      raw.plainText ??
      (format === "markdown"
        ? plainTextFromMarkdown(raw.content)
        : plainTextFromRichContent(raw.content)),
  };
}

/**
 * Best-effort decode for contexts that must never throw (history listing,
 * legacy readers): unsupported bodies degrade to an opaque markdown body
 * whose content is the ORIGINAL bytes — preserved, never reformatted.
 */
export function decodeDocumentBodyLenient(
  raw: StoredBodyShape | null | undefined,
): DocumentBody | null {
  try {
    return decodeDocumentBody(raw);
  } catch {
    if (raw == null || typeof raw.content !== "string") return null;
    return {
      contentFormat: "markdown",
      contentSchemaVersion: 1,
      content: raw.content,
      plainText: raw.plainText ?? raw.content,
    };
  }
}

/**
 * Text to DISPLAY/edit for a body in a surface that cannot render
 * structured payloads (transitional markdown editor/reader, plain-text
 * contexts): markdown → its source; rich → the derived plain text.
 */
export function displayTextFromBody(body: DocumentBody): string {
  return body.contentFormat === "markdown" ? body.content : body.plainText;
}

/**
 * Serialize a body for export/attachment contexts that consume markdown.
 * Markdown passes through untouched; rich bodies yield their plain text
 * until the full markdown serializer lands (4.3). Never returns serialized
 * ProseMirror JSON as manuscript prose.
 */
export function markdownFromBody(body: DocumentBody): string {
  return displayTextFromBody(body);
}
