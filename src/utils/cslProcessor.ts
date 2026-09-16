// ============================================================
// CSL-processor bibliography (Phase 5.4e)
// ============================================================
// Formatted references come from a real CSL processor (citeproc-js —
// the reference implementation Zotero bundles), consuming the citation
// nodes' sourceId ground truth + the source records. The app NEVER
// invents citation details: a cited id with no source record is skipped
// (it cannot be formatted honestly), and absent fields stay absent.
//
// This module is the LIGHT facade (types, style list, name parsing, the
// formatting entry point). The heavy part (citeproc + the vendored style
// XMLs) lives in cslEngine.ts and is loaded only on demand, so the
// processor never costs bundle weight until a bibliography is formatted.

import type { SourceMeta } from "@/types";

export type CslStyleId = "apa" | "chicago-author-date" | "mla";

export interface CslStyleInfo {
  id: CslStyleId;
  label: string;
  /** The heading the style's reference list goes under. */
  sectionTitle: string;
}

export const CSL_STYLES: readonly CslStyleInfo[] = [
  { id: "apa", label: "APA (7th ed.)", sectionTitle: "References" },
  { id: "chicago-author-date", label: "Chicago (author-date)", sectionTitle: "Bibliography" },
  { id: "mla", label: "MLA (9th ed.)", sectionTitle: "Works Cited" },
] as const;

export function cslStyleInfo(id: CslStyleId): CslStyleInfo {
  return CSL_STYLES.find((s) => s.id === id) ?? CSL_STYLES[0];
}

export interface CslName {
  /** Family name (absent for a literal organization). */
  family?: string;
  given?: string;
  /** A literal organization name (CSL `literal`); a display string marks
   * one by wrapping it in braces: `{One-Name Organization}`. */
  literal?: string;
}

/** One item handed to the CSL processor (the fields our source model
 * can supply honestly; absent fields stay absent, and the item type comes
 * from the source's own bibliographic type — never invented as "book"). */
export interface CslBibItem {
  id: string;
  type: string;
  title?: string;
  author?: CslName[];
  issued?: { "date-parts": number[][] };
  DOI?: string;
  URL?: string;
  language?: string;
  "container-title"?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  page?: string;
  abstract?: string;
}

/** A piece of a formatted reference (real style output, not a guess). */
export interface FormattedRun {
  text: string;
  italic?: boolean;
  bold?: boolean;
}
export type FormattedEntry = FormattedRun[];

/**
 * Parse ONE display name into CSL name parts. "Family, Given" (one
 * comma — the citation convention) or "Given Family" (the last token is
 * the family name). A single token stays whole (organization names). A
 * name wrapped in braces (`{Organization}`) is a LITERAL organization.
 */
export function parseAuthorName(raw: string): CslName {
  const name = raw.trim();
  if (name.startsWith("{") && name.endsWith("}") && name.length > 2) {
    return { literal: name.slice(1, -1).trim() };
  }
  const comma = name.indexOf(",");
  if (comma > 0) {
    const family = name.slice(0, comma).trim();
    const given = name.slice(comma + 1).trim();
    return given ? { family, given } : { family };
  }
  const tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return { family: name };
  const family = tokens.pop() as string;
  return { family, given: tokens.join(" ") };
}

/**
 * Split an author list on "; " or " and " (the app's and BibTeX's
 * multi-author separators) OUTSIDE braces, so a literal organization name
 * containing those sequences stays one author. A bare ", " is never a
 * boundary because it is how "Family, Given" names are written.
 */
export function splitAuthorList(value: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const sep = /^(?:;\s*|\s+and\s+)/i.exec(value.slice(i));
      if (sep) {
        parts.push(buf);
        buf = "";
        i += sep[0].length - 1;
        continue;
      }
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Parse a display author string into CSL names.
 */
export function parseAuthors(author?: string): CslName[] {
  if (!author) return [];
  return splitAuthorList(author).map(parseAuthorName);
}

/** Build the CSL item a source record can honestly supply. */
export function cslItemFromSource(
  source: Pick<
    SourceMeta,
    | "title"
    | "author"
    | "year"
    | "doi"
    | "url"
    | "language"
    | "sourceType"
    | "containerTitle"
    | "publisher"
    | "volume"
    | "issue"
    | "pages"
    | "abstract"
  >,
  id: string,
): CslBibItem {
  const authors = parseAuthors(source.author);
  return {
    id,
    // The source's own type when known; "document" is the honest
    // fallback, never a more specific claim like "book".
    type: source.sourceType && /^[a-z][a-z-]*$/.test(source.sourceType)
      ? source.sourceType
      : "document",
    title: source.title,
    ...(authors.length ? { author: authors } : {}),
    ...(source.year && !Number.isNaN(Number(source.year))
      ? { issued: { "date-parts": [[Number(source.year)]] } }
      : {}),
    ...(source.doi ? { DOI: source.doi } : {}),
    ...(source.url ? { URL: source.url } : {}),
    ...(source.language ? { language: source.language } : {}),
    ...(source.containerTitle ? { "container-title": source.containerTitle } : {}),
    ...(source.publisher ? { publisher: source.publisher } : {}),
    ...(source.volume ? { volume: source.volume } : {}),
    ...(source.issue ? { issue: source.issue } : {}),
    ...(source.pages ? { page: source.pages } : {}),
    ...(source.abstract ? { abstract: source.abstract } : {}),
  };
}

/**
 * Format the cited sources into bibliography entries with the given CSL
 * style. Entries are style-SORTED (the processor decides — APA/MLA/
 * Chicago order their reference lists themselves) and returned as
 * structured runs (italic/bold preserved for editor/DOCX insertion).
 * Cited ids without a source record are skipped: nothing is invented.
 */
export async function formatBibliography(
  cited: { sourceId: string }[],
  sources: SourceMeta[],
  style: CslStyleId,
): Promise<FormattedEntry[]> {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const items: CslBibItem[] = [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const cite of cited) {
    if (seen.has(cite.sourceId)) continue;
    seen.add(cite.sourceId);
    const source = byId.get(cite.sourceId);
    if (!source) continue;
    ids.push(cite.sourceId);
    items.push(cslItemFromSource(source, cite.sourceId));
  }
  if (!ids.length) return [];
  const { runBibliography, parseEntryHtml } = await import("@/utils/cslEngine");
  return runBibliography(style, items, ids).map(parseEntryHtml);
}

/** Flatten an entry's runs to plain text (search/readout use). */
export function entryToText(entry: FormattedEntry): string {
  return entry.map((run) => run.text).join("");
}
