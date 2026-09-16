import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile, exists } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type { LibraryTextMeta, TextTypeId } from "@/types";
import { TEXT_TYPES } from "@/types";
import { useLibraryStore } from "@/stores/libraryStore";

// ──────────────────────────────────────────────
// Front matter (export format)
// ──────────────────────────────────────────────

/**
 * Fields OUR exporter writes. Import treats a leading `---` block as
 * application front matter ONLY when it carries one of these fields —
 * ordinary Markdown that merely begins with horizontal rules (a very
 * common document pattern) must survive import unchanged.
 */
const FRONT_MATTER_FIELDS = /^\/?(title|type|folder|created|updated):/;

/**
 * Serialize a text for export: a small YAML front-matter block with the
 * metadata, then the content. Import parses the same format, so an
 * exported file round-trips without losing metadata.
 */
export function serializeForExport(meta: LibraryTextMeta, content: string): string {
  const lines = [
    "---",
    `title: ${JSON.stringify(meta.title)}`,
    `type: ${meta.textType}`,
    ...(meta.folder ? [`folder: ${JSON.stringify(meta.folder)}`] : []),
    `created: ${meta.createdAt}`,
    `updated: ${meta.updatedAt}`,
    "---",
    "",
  ];
  return lines.join("\n") + content;
}

/** A text parsed from an imported file, ready for createText. */
export interface ParsedImport {
  title: string;
  textType: TextTypeId;
  folder?: string;
  content: string;
}

/** Parse an exported file's front matter back into import data. */
export function parseImport(
  raw: string,
  fallbackTitle: string,
): ParsedImport {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) {
    return { title: fallbackTitle, textType: "other", content: normalized };
  }

  // Not every opening `---` is OUR front matter: ordinary Markdown may
  // begin with horizontal rules (or foreign YAML). Only a block carrying
  // one of the exporter's own fields is parsed as metadata.
  if (!match[1].split("\n").some((line) => FRONT_MATTER_FIELDS.test(line))) {
    return { title: fallbackTitle, textType: "other", content: normalized };
  }

  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (kv) fields.set(kv[1], parseValue(kv[2].trim()));
  }

  const type = fields.get("type") as TextTypeId | undefined;
  const folder = fields.get("folder");
  return {
    title: fields.get("title")?.trim() || fallbackTitle,
    textType: TEXT_TYPES.some((t) => t.id === type) ? type! : "other",
    ...(folder ? { folder } : {}),
    content: normalized.slice(match[0].length),
  };
}

/** Parse a front-matter value: JSON strings (with escapes) or bare words. */
function parseValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

/** Derive a text title from a file name: extension stripped, underscores and dashes spaced. */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.(md|markdown|txt)$/i, "");
  const spaced = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return spaced || "Untitled text";
}

/** Windows reserved device names (case-insensitive, with or without extension). */
const WINDOWS_RESERVED_STEMS = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * File name for an exported text: slugified title + .md
 *
 * Unicode-aware: letters, digits, AND combining marks from any script
 * survive (a Latin-only slug turned every non-Latin title into the same
 * "text.md"). Splitting iterates CODE POINTS — surrogate pairs (e.g.
 * emoji) are never broken. Windows reserved device names get a prefix so
 * "con.md" cannot silently fail to write.
 */
export function exportFilename(title: string): string {
  // Lowercase first, then iterate CODE POINTS: surrogate pairs (emoji,
  // rare CJK) are never split, and combining marks survive the filter.
  const lowered = [...title.toLowerCase()].join("");
  const base =
    lowered
      .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "text";
  const slug = [...base].slice(0, 60).join("").replace(/-+$/, "") || "text";
  const reserved = WINDOWS_RESERVED_STEMS.has(slug);
  return `${reserved ? "_" : ""}${slug}.md`;
}

/** Word count lives in utils/tokens (shared with the library store). */
export { wordCount } from "@/utils/tokens";

// ──────────────────────────────────────────────
// Dialog-backed import / export
// ──────────────────────────────────────────────

/**
 * Ask the user for text files (.md / .txt / .markdown) and import each as a
 * library text into the given folder (or no folder). Returns how many texts
 * were imported.
 */
export async function importFiles(folder?: string): Promise<number> {
  const selection = await open({
    multiple: true,
    filters: [{ name: "Text files", extensions: ["md", "markdown", "txt"] }],
  });
  if (!selection) return 0;

  const paths = Array.isArray(selection) ? selection : [selection];
  let imported = 0;
  for (const path of paths) {
    try {
      const raw = await readTextFile(path);
      const filename = path.split(/[\\/]/).pop() ?? "";
      const parsed = parseImport(raw, titleFromFilename(filename));
      await useLibraryStore.getState().createText({
        ...parsed,
        ...(folder !== undefined ? { folder } : parsed.folder ? { folder: parsed.folder } : {}),
      });
      imported++;
    } catch {
      // Skip unreadable files; import the rest.
    }
  }
  return imported;
}

/** Export a single text as Markdown via a save dialog. True when saved. */
export async function exportText(
  meta: LibraryTextMeta,
  content: string,
): Promise<boolean> {
  const path = await save({
    defaultPath: exportFilename(meta.title),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) return false;
  // A single save dialog: the user explicitly chose (and may deliberately
  // overwrite) this path — plain write. Bulk export is exclusive instead.
  await writeTextFile(path, serializeForExport(meta, content));
  return true;
}

/** Per-file outcome of a bulk export. */
export interface BulkExportResult {
  /** Titles exported successfully. */
  exported: string[];
  /** Titles that failed, with the reason. */
  failed: { title: string; error: string }[];
}

/**
 * Exclusive write: the file is created only when it does not already
 * exist (Rust create_new), so overwriting an earlier export is impossible.
 * A genuine name collision is retried with a numbered name; anything else
 * propagates.
 */
async function writeTextFileExclusive(path: string, contents: string): Promise<void> {
  try {
    await invoke("export_write_exclusive", { path, contents });
  } catch (err) {
    const message = typeof err === "string" ? err : String(err);
    if (!/already exists/i.test(message)) {
      throw new Error(message);
    }
    throw new CollisionError(path);
  }
}

/** Signals "this exact name is taken" (retry with a numbered name). */
export class CollisionError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`A file named '${path.split(/[\\/]/).pop()}' already exists.`);
    this.name = "CollisionError";
    this.path = path;
  }
}

/** Export several texts as individual .md files into a chosen folder. */
export async function exportTexts(
  items: { meta: LibraryTextMeta; content: string }[],
): Promise<BulkExportResult> {
  const dir = await open({ directory: true });
  if (!dir || typeof dir !== "string") {
    return { exported: [], failed: [] };
  }

  const baseDir = dir.replace(/[\\/]+$/, "");
  const used = new Set<string>();
  const result: BulkExportResult = { exported: [], failed: [] };
  for (const item of items) {
    try {
      // Resolve collisions within the batch and against files already in
      // the folder — silent overwrites destroyed earlier exports.
      const preferred = exportFilename(item.meta.title);
      const path = await uniqueExportPath(baseDir, preferred, used);
      used.add(path.toLowerCase());
      await writeTextFileExclusive(path, serializeForExport(item.meta, item.content));
      result.exported.push(item.meta.title);
    } catch (err) {
      result.failed.push({
        title: item.meta.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/**
 * Find a path for `filename` that is neither batch-used nor already on
 * disk. `exists()` failures PROPAGATE: pretending the name was taken
 * produced endless numbered collisions; only a REAL taken name retries.
 */
async function uniqueExportPath(
  baseDir: string,
  filename: string,
  used: Set<string>,
): Promise<string> {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  let candidate = filename;
  for (let n = 2; ; n++) {
    const path = `${baseDir}/${candidate}`;
    if (used.has(path.toLowerCase())) {
      candidate = `${stem}-${n}${ext}`;
      continue;
    }
    const taken = await exists(path); // access-denied throws here, loudly
    if (!taken) return path;
    candidate = `${stem}-${n}${ext}`;
  }
}
