import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { LibraryTextMeta, TextTypeId } from "@/types";
import { TEXT_TYPES } from "@/types";
import { useLibraryStore } from "@/stores/libraryStore";

// ──────────────────────────────────────────────
// Front matter (export format)
// ──────────────────────────────────────────────

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

/** File name for an exported text: slugified title + .md */
export function exportFilename(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "text";
  return `${slug}.md`;
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
  await writeTextFile(path, serializeForExport(meta, content));
  return true;
}

/** Export several texts as individual .md files into a chosen folder. */
export async function exportTexts(
  items: { meta: LibraryTextMeta; content: string }[],
): Promise<number> {
  const dir = await open({ directory: true });
  if (!dir || typeof dir !== "string") return 0;

  let exported = 0;
  for (const item of items) {
    try {
      const path = `${dir.replace(/[\\/]+$/, "")}/${exportFilename(item.meta.title)}`;
      await writeTextFile(path, serializeForExport(item.meta, item.content));
      exported++;
    } catch {
      // Skip files that fail to write; export the rest.
    }
  }
  return exported;
}
