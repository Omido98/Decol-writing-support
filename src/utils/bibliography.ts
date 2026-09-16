// ============================================================
// Bibliography interchange (Phase 5.4; identity/metadata in B18)
// ============================================================
// BibTeX, RIS, and CSL JSON import/export for the source model. Imports
// create SOURCE RECORDS (no text material is invented — the original text
// is the formatted reference itself); exports serialize every source.
// Nothing here invents citation details: absent fields stay absent, and
// EVERY format (BibTeX, RIS, CSL JSON) SKIPS an entry without a title
// instead of importing a fabricated "Untitled source" placeholder (F11).
//
// Multi-author display strings join with "; " so the CSL processor can
// tell author boundaries apart from "Family, Given" commas; a literal
// organization is wrapped in braces (`{One-Name Organization}`), matching
// BibTeX's `{{Organization}}` convention and CSL's `literal` names.

import type { SourceInput } from "@/stores/sourceStore";
import { parseAuthors, splitAuthorList, type CslName } from "@/utils/cslProcessor";

/** The subset of a source record every interchange format carries. */
export interface BibliographySource {
  title: string;
  author?: string;
  year?: string;
  doi?: string;
  url?: string;
  language?: string;
  translation?: string;
  notes?: string;
  sourceType?: string;
  containerTitle?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  abstract?: string;
}

// ──────────────────────────────────────────────
// BibTeX
// ──────────────────────────────────────────────

/** Entry kind → CSL type. Unknown kinds are "document", never a guess. */
const CSL_FROM_BIB: Record<string, string> = {
  article: "article-journal",
  book: "book",
  inbook: "chapter",
  incollection: "chapter",
  inproceedings: "paper-conference",
  conference: "paper-conference",
  proceedings: "book",
  phdthesis: "thesis",
  mastersthesis: "thesis",
  techreport: "report",
  report: "report",
  unpublished: "manuscript",
  manual: "book",
  online: "webpage",
  electronic: "webpage",
  www: "webpage",
  misc: "document",
};

/** CSL type → BibTeX entry kind (the closest supported kind). */
const BIB_FROM_CSL: Record<string, string> = {
  "article-journal": "article",
  "article-magazine": "article",
  "article-newspaper": "article",
  book: "book",
  chapter: "incollection",
  "paper-conference": "inproceedings",
  thesis: "phdthesis",
  report: "techreport",
  webpage: "misc",
  interview: "misc",
  manuscript: "unpublished",
  document: "misc",
};

/** Characters the serializer escapes (our parser decodes exactly these). */
const DECODABLE_ESCAPES = new Set(["{", "}", "&", "%", "$", "#", "_", "\\"]);

/** Escape a value for a braced BibTeX field. */
export function escapeBibValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([{}&%$#_])/g, "\\$1");
}

/** Decode the escapes `escapeBibValue` writes (unknown TeX escapes stay). */
function decodeBibEscapes(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length && DECODABLE_ESCAPES.has(value[i + 1])) {
      out += value[i + 1];
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Remove BibTeX group braces while keeping escaped braces intact. */
function stripGroupBraces(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\") {
      out += ch;
      if (i + 1 < value.length) {
        out += value[i + 1];
        i++;
      }
      continue;
    }
    if (ch !== "{" && ch !== "}") out += ch;
  }
  return out;
}

/** Strip braces/TeX noise and decode our escapes (no TeX decoding). */
function stripBibNoise(value: string): string {
  return decodeBibEscapes(stripGroupBraces(value)).replace(/\s+/g, " ").trim();
}

/** Parse a .bib file into source inputs (one per entry). */
export function parseBibTeX(raw: string): SourceInput[] {
  const entries: SourceInput[] = [];
  // Entry boundaries: @type{ ... } with nested braces.
  const entryRe = /@(\w+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(raw)) !== null) {
    const kind = match[1].toLowerCase();
    if (kind === "comment" || kind === "preamble" || kind === "string") continue;
    const start = match.index + match[0].length;
    const end = matchBrace(raw, start - 1);
    if (end < 0) break;
    const body = raw.slice(start, end);
    const entry = parseBibEntry(kind, body);
    if (entry) entries.push(entry);
    entryRe.lastIndex = end;
  }
  return entries;
}

/** Find the matching close brace for the brace at `open` (escape-aware:
 * `\{`/`\}` are literal characters, not grouping). */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** One BibTeX author part → display form (braced part = literal org). */
function bibAuthorToDisplay(part: string): string {
  const trimmed = part.trim();
  if (trimmed.startsWith("{") && matchBrace(trimmed, 0) === trimmed.length - 1) {
    return `{${stripBibNoise(trimmed.slice(1, -1))}}`;
  }
  return stripBibNoise(trimmed);
}

function parseBibEntry(kind: string, body: string): SourceInput | null {
  // First token = citation key, then comma-separated field = value pairs.
  // Values stay RAW here (braces and escapes intact) so author literals
  // and escaped braces survive; use sites clean them.
  const comma = body.indexOf(",");
  const fields = new Map<string, string>();
  const rest = comma >= 0 ? body.slice(comma + 1) : body;
  const fieldRe = /(\w+)\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(rest)) !== null) {
    const name = m[1].toLowerCase();
    const i = m.index + m[0].length;
    let value = "";
    if (rest[i] === "{") {
      const close = matchBrace(rest, i);
      if (close < 0) break;
      value = rest.slice(i + 1, close);
      fieldRe.lastIndex = close + 1;
    } else if (rest[i] === '"') {
      const close = rest.indexOf('"', i + 1);
      if (close < 0) break;
      value = rest.slice(i + 1, close);
      fieldRe.lastIndex = close + 1;
    } else {
      const bare = /^[^,}]*/.exec(rest.slice(i))![0];
      value = bare.trim();
      fieldRe.lastIndex = i + bare.length;
    }
    fields.set(name, value);
  }
  const raw = (key: string): string | undefined => fields.get(key);
  const clean = (key: string): string | undefined => {
    const value = raw(key);
    if (value == null) return undefined;
    const cleaned = stripBibNoise(value);
    return cleaned || undefined;
  };

  // F11: no title = no source record. RIS and CSL JSON skip title-less
  // entries the same way; a placeholder title would be an invented
  // citation detail (and the source text IS the formatted reference).
  const rawTitle = clean("title");
  if (!rawTitle) return null;
  const title = rawTitle;
  const authorValue = raw("author") ?? raw("editor");
  const author = authorValue
    ? splitAuthorList(authorValue).map(bibAuthorToDisplay).filter(Boolean).join("; ")
    : undefined;
  const year = clean("year");
  const doi = clean("doi");
  const url = clean("url");
  const language = clean("language");
  const translation = clean("translator");
  const notes = clean("note");
  const abstract = clean("abstract");
  const containerTitle =
    clean("journal") ?? clean("journaltitle") ?? clean("booktitle");
  const publisher = clean("publisher") ?? clean("institution") ?? clean("school");
  const volume = clean("volume");
  const issue = clean("number") ?? clean("issue");
  const pages = clean("pages");
  const sourceType = CSL_FROM_BIB[kind] ?? "document";

  return {
    title,
    ...(author ? { author } : {}),
    ...(year ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(url ? { url } : {}),
    ...(language ? { language } : {}),
    ...(translation ? { translation } : {}),
    ...(notes ? { notes } : {}),
    ...(abstract ? { abstract } : {}),
    ...(containerTitle ? { containerTitle } : {}),
    ...(publisher ? { publisher } : {}),
    ...(volume ? { volume } : {}),
    ...(issue ? { issue } : {}),
    ...(pages ? { pages } : {}),
    sourceType,
    text: formattedReference({ title, ...(author ? { author } : {}), ...(year ? { year } : {}) }),
  };
}

/** A human-readable reference line (also the imported source's text). */
export function formattedReference(source: {
  title: string;
  author?: string;
  year?: string;
}): string {
  const parts: string[] = [];
  if (source.author) parts.push(source.author);
  if (source.year) parts.push(`(${source.year})`);
  parts.push(source.title);
  return parts.join(" ");
}

/** One CSL name → BibTeX author part (family-first, the BibTeX
 * convention; literal orgs keep their braces). */
function cslNameToBibAuthor(name: CslName): string {
  if (name.literal) return `{${escapeBibValue(name.literal)}}`;
  const family = name.family ?? "";
  return name.given ? `${family}, ${name.given}` : family;
}

/** Serialize source records to BibTeX. Values are escaped, and duplicate
 * citation keys are made unique (never overwriting an earlier entry). */
export function serializeBibTeX(sources: BibliographySource[]): string {
  const keys = uniqueCitationKeys(sources);
  const entries = sources.map((s, i) => {
    const fields: string[] = [];
    if (s.author) {
      fields.push(
        `author = {${parseAuthors(s.author)
          .map(cslNameToBibAuthor)
          .join(" and ")}}`,
      );
    }
    fields.push(`title = {${escapeBibValue(s.title)}}`);
    if (s.year) fields.push(`year = {${escapeBibValue(s.year)}}`);
    if (s.containerTitle) {
      const journalLike = /^article-/.test(s.sourceType ?? "");
      fields.push(
        `${journalLike ? "journal" : "booktitle"} = {${escapeBibValue(s.containerTitle)}}`,
      );
    }
    if (s.publisher) fields.push(`publisher = {${escapeBibValue(s.publisher)}}`);
    if (s.volume) fields.push(`volume = {${escapeBibValue(s.volume)}}`);
    if (s.issue) fields.push(`number = {${escapeBibValue(s.issue)}}`);
    if (s.pages) fields.push(`pages = {${escapeBibValue(s.pages)}}`);
    if (s.doi) fields.push(`doi = {${escapeBibValue(s.doi)}}`);
    if (s.url) fields.push(`url = {${escapeBibValue(s.url)}}`);
    if (s.language) fields.push(`language = {${escapeBibValue(s.language)}}`);
    if (s.notes) fields.push(`note = {${escapeBibValue(s.notes)}}`);
    if (s.abstract) fields.push(`abstract = {${escapeBibValue(s.abstract)}}`);
    if (s.translation) {
      fields.push(`translator = {${escapeBibValue(s.translation)}}`);
    }
    const kind = BIB_FROM_CSL[s.sourceType ?? ""] ?? "misc";
    return `@${kind}{${keys[i]},\n${fields.map((f) => `  ${f}`).join(",\n")}\n}`;
  });
  return entries.join("\n\n") + "\n";
}

/** A citation-key base derived from the first author, year, and title. */
function bibKey(s: { title: string; author?: string; year?: string }): string {
  const firstAuthor = splitAuthorList(s.author ?? "")
    .map((p) => p.replace(/[{}]/g, ""))
    .filter(Boolean)[0];
  const word =
    (firstAuthor ?? "source")
      .split(/[;\s,]+/)
      .filter(Boolean)[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "source";
  const slug = s.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 30);
  return `${word}${s.year ?? ""}${slug || "source"}`;
}

/** Unique citation keys for an export (suffixes collisions, keeps order).
 * EMITTED keys are tracked, not just base keys (F11): a suffixed key like
 * `x-2` is itself taken, so a later entry whose natural base is `x-2`
 * cannot silently reuse it. Distinct DOIs with equal titles/authors can
 * never collide. */
function uniqueCitationKeys(sources: BibliographySource[]): string[] {
  const emitted = new Set<string>();
  return sources.map((s) => {
    const base = bibKey(s);
    let candidate = base;
    let n = 1;
    while (emitted.has(candidate)) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    emitted.add(candidate);
    return candidate;
  });
}

// ──────────────────────────────────────────────
// RIS
// ──────────────────────────────────────────────

/** RIS TY → CSL type. */
const CSL_FROM_RIS: Record<string, string> = {
  JOUR: "article-journal",
  MGZN: "article-magazine",
  NEWS: "article-newspaper",
  BOOK: "book",
  CHAP: "chapter",
  CONF: "paper-conference",
  CPAPER: "paper-conference",
  THES: "thesis",
  RPRT: "report",
  ELEC: "webpage",
  WEB: "webpage",
  GEN: "document",
  MANSCPT: "manuscript",
};

/** CSL type → RIS TY. */
const RIS_FROM_CSL: Record<string, string> = {
  "article-journal": "JOUR",
  "article-magazine": "MGZN",
  "article-newspaper": "NEWS",
  book: "BOOK",
  chapter: "CHAP",
  "paper-conference": "CONF",
  thesis: "THES",
  report: "RPRT",
  webpage: "ELEC",
  interview: "GEN",
  manuscript: "MANSCPT",
  document: "GEN",
};

/** Parse a .ris file into source inputs (one per ER-terminated record). */
export function parseRIS(raw: string): SourceInput[] {
  const entries: SourceInput[] = [];
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const fields = new Map<string, string[]>();
  let seen = false;
  const build = (): SourceInput | null => {
    const first = (k: string) => fields.get(k)?.[0];
    const joined = (k: string) => {
      const list = (fields.get(k) ?? []).map((v) => v.trim()).filter(Boolean);
      return list.length ? list.join(" ") : undefined;
    };
    const title = (first("TI") ?? first("T1"))?.trim();
    if (!title) return null;
    const authors = [...(fields.get("AU") ?? []), ...(fields.get("A1") ?? [])]
      .map((a) => stripBibNoise(a))
      .filter(Boolean)
      .join("; ");
    const author = authors || undefined;
    const year = (first("PY") ?? first("Y1"))?.slice(0, 4);
    const startPage = first("SP")?.trim();
    const endPage = first("EP")?.trim();
    const pages = startPage
      ? endPage
        ? `${startPage}-${endPage}`
        : startPage
      : undefined;
    const sourceType = CSL_FROM_RIS[first("TY") ?? ""] ?? "document";
    return {
      title: stripBibNoise(title),
      ...(author ? { author } : {}),
      ...(year ? { year } : {}),
      ...(first("DO") ? { doi: first("DO")!.trim() } : {}),
      ...(first("UR") ? { url: first("UR")!.trim() } : {}),
      ...(first("LA") ? { language: first("LA")!.trim() } : {}),
      ...(joined("AB") ? { abstract: joined("AB") } : {}),
      ...(joined("N1") ? { notes: joined("N1") } : {}),
      ...(first("JO") ?? first("JF") ?? first("T2") ?? first("BT")
        ? { containerTitle: (first("JO") ?? first("JF") ?? first("T2") ?? first("BT"))!.trim() }
        : {}),
      ...(first("PB") ? { publisher: first("PB")!.trim() } : {}),
      ...(first("VL") ? { volume: first("VL")!.trim() } : {}),
      ...(first("IS") ? { issue: first("IS")!.trim() } : {}),
      ...(pages ? { pages } : {}),
      sourceType,
      text: formattedReference({
        title: stripBibNoise(title),
        ...(author ? { author } : {}),
        ...(year ? { year } : {}),
      }),
    };
  };
  for (const line of lines) {
    const m = /^([A-Z][A-Z0-9])  - ?(.*)$/.exec(line);
    if (!m) continue;
    const tag = m[1];
    if (tag === "TY") {
      const building = build();
      if (building) entries.push(building);
      fields.clear();
      fields.set("TY", [m[2].trim()]);
      seen = true;
      continue;
    }
    if (tag === "ER") {
      const entry = build();
      if (entry) entries.push(entry);
      fields.clear();
      seen = false;
      continue;
    }
    if (!seen) continue;
    const list = fields.get(tag) ?? [];
    list.push(m[2].trim());
    fields.set(tag, list);
  }
  const trailing = build();
  if (trailing) entries.push(trailing);
  return entries;
}

/** RIS values are single-line by format: newlines become spaces. */
function risValue(value: string): string {
  return value.replace(/\r?\n+/g, " ").trim();
}

/** Serialize source records to RIS (notes and abstracts symmetric). */
export function serializeRIS(sources: BibliographySource[]): string {
  const records = sources.map((s) => {
    const lines = [
      `TY  - ${RIS_FROM_CSL[s.sourceType ?? ""] ?? "GEN"}`,
      `TI  - ${risValue(s.title)}`,
    ];
    for (const a of parseAuthors(s.author)) {
      const name = a.literal ?? [a.family, a.given].filter(Boolean).join(", ");
      if (name) lines.push(`AU  - ${risValue(name)}`);
    }
    if (s.year) lines.push(`PY  - ${risValue(s.year)}`);
    if (s.containerTitle) lines.push(`JO  - ${risValue(s.containerTitle)}`);
    if (s.publisher) lines.push(`PB  - ${risValue(s.publisher)}`);
    if (s.volume) lines.push(`VL  - ${risValue(s.volume)}`);
    if (s.issue) lines.push(`IS  - ${risValue(s.issue)}`);
    if (s.pages) {
      const dash = s.pages.indexOf("-");
      if (dash > 0) {
        lines.push(`SP  - ${risValue(s.pages.slice(0, dash))}`);
        lines.push(`EP  - ${risValue(s.pages.slice(dash + 1))}`);
      } else {
        lines.push(`SP  - ${risValue(s.pages)}`);
      }
    }
    if (s.abstract) lines.push(`AB  - ${risValue(s.abstract)}`);
    if (s.notes) lines.push(`N1  - ${risValue(s.notes)}`);
    if (s.doi) lines.push(`DO  - ${risValue(s.doi)}`);
    if (s.url) lines.push(`UR  - ${risValue(s.url)}`);
    if (s.language) lines.push(`LA  - ${risValue(s.language)}`);
    lines.push("ER  - ");
    return lines.join("\n");
  });
  return records.join("\n") + "\n";
}

// ──────────────────────────────────────────────
// CSL JSON (Zotero interoperability, Phase 5.4d)
// ──────────────────────────────────────────────
// Zotero's explicit 'CSL JSON' export format. Import: one source per
// RECOGNIZABLE item (a CSL item has a type and a title — unrelated JSON
// never becomes an invented source). Export: every source as a CSL item.

/** One CSL name object → the app's display string. */
function cslAuthorToDisplay(person: unknown): string | null {
  if (!person || typeof person !== "object") return null;
  const p = person as {
    family?: unknown;
    given?: unknown;
    literal?: unknown;
    name?: unknown;
  };
  const literal =
    typeof p.literal === "string" && p.literal.trim()
      ? p.literal.trim()
      : typeof p.name === "string" && p.name.trim()
        ? p.name.trim()
        : null;
  if (literal) return `{${literal}}`;
  const family = typeof p.family === "string" ? p.family.trim() : "";
  const given = typeof p.given === "string" ? p.given.trim() : "";
  if (given) return family ? `${family}, ${given}` : given;
  return family || null;
}

/** A string field from a CSL item (numbers are stringified). */
function cslStr(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function parseCslJson(raw: string): SourceInput[] {
  let items: unknown;
  try {
    items = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const entries: SourceInput[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    // Recognition gate: a CSL item carries a type and a real title.
    // Anything else is NOT imported (no invented sources).
    const type = cslStr(it.type);
    const title = cslStr(it.title);
    if (!type || !title) continue;
    const people = Array.isArray(it.author) ? it.author : [];
    const author =
      people.map(cslAuthorToDisplay).filter((v): v is string => v !== null).join("; ") ||
      undefined;
    const dateParts = (it.issued as { "date-parts"?: unknown } | undefined)?.[
      "date-parts"
    ];
    const first = Array.isArray(dateParts) && Array.isArray(dateParts[0])
      ? (dateParts[0] as unknown[])
      : [];
    const year =
      first[0] != null && Number.isFinite(Number(first[0]))
        ? String(Number(first[0]))
        : cslStr((it.issued as { literal?: unknown } | undefined)?.literal)?.slice(0, 4);
    const notes =
      cslStr(it.note) ??
      (Array.isArray(it.note)
        ? it.note
            .map((n) => cslStr(n))
            .filter((v): v is string => v !== undefined)
            .join(" ") || undefined
        : undefined);
    entries.push({
      title,
      ...(author ? { author } : {}),
      ...(year ? { year } : {}),
      ...(cslStr(it.DOI) ? { doi: cslStr(it.DOI)! } : {}),
      ...(cslStr(it.URL) ? { url: cslStr(it.URL)! } : {}),
      ...(cslStr(it.language) ? { language: cslStr(it.language)! } : {}),
      ...(cslStr(it.abstract) ? { abstract: cslStr(it.abstract)! } : {}),
      ...(notes ? { notes } : {}),
      ...(cslStr(it["container-title"])
        ? { containerTitle: cslStr(it["container-title"])! }
        : {}),
      ...(cslStr(it.publisher) ? { publisher: cslStr(it.publisher)! } : {}),
      ...(cslStr(it.volume) ? { volume: cslStr(it.volume)! } : {}),
      ...(cslStr(it.issue) ? { issue: cslStr(it.issue)! } : {}),
      ...(cslStr(it.page) ? { pages: cslStr(it.page)! } : {}),
      sourceType: /^[a-z][a-z-]*$/.test(type) ? type : "document",
      text: formattedReference({ title, ...(author ? { author } : {}), ...(year ? { year } : {}) }),
    });
  }
  return entries;
}

/** One CSL name part back to structured CSL JSON. */
function cslNameToCslJson(name: CslName): Record<string, string> {
  if (name.literal) return { literal: name.literal };
  return { family: name.family ?? "", ...(name.given ? { given: name.given } : {}) };
}

export function serializeCslJson(sources: BibliographySource[]): string {
  const keys = uniqueCitationKeys(sources);
  const items = sources.map((s, i) => {
    const authors = parseAuthors(s.author);
    const type = (s.sourceType ?? "").trim().toLowerCase();
    return {
      type: /^[a-z][a-z-]*$/.test(type) ? type : "document",
      id: keys[i],
      title: s.title,
      ...(authors.length ? { author: authors.map(cslNameToCslJson) } : {}),
      ...(s.year && !Number.isNaN(Number(s.year))
        ? { issued: { "date-parts": [[Number(s.year)]] } }
        : {}),
      ...(s.doi ? { DOI: s.doi } : {}),
      ...(s.url ? { URL: s.url } : {}),
      ...(s.language ? { language: s.language } : {}),
      ...(s.containerTitle ? { "container-title": s.containerTitle } : {}),
      ...(s.publisher ? { publisher: s.publisher } : {}),
      ...(s.volume ? { volume: s.volume } : {}),
      ...(s.issue ? { issue: s.issue } : {}),
      ...(s.pages ? { page: s.pages } : {}),
      ...(s.abstract ? { abstract: s.abstract } : {}),
      ...(s.notes ? { note: s.notes } : {}),
    };
  });
  return JSON.stringify(items, null, 2) + String.fromCharCode(10);
}
