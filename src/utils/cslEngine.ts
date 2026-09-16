// ============================================================
// CSL engine adapter (Phase 5.4e) — HEAVY MODULE
// ============================================================
// citeproc-js + the vendored CSL style files and the en-US locale.
// Loaded ONLY when a bibliography is actually formatted (dynamic import
// from cslProcessor.ts), so the processor costs no bundle weight until
// then. Engines are cached per style; updateItems() scopes each
// formatting call to exactly the ids requested.

import CSL from "citeproc";
import apaStyle from "@/assets/csl/apa.csl?raw";
import chicagoStyle from "@/assets/csl/chicago-author-date.csl?raw";
import mlaStyle from "@/assets/csl/modern-language-association.csl?raw";
import localeEnUs from "@/assets/csl/locales-en-US.xml?raw";
import type { CslStyleId, CslBibItem, FormattedEntry, FormattedRun } from "@/utils/cslProcessor";

const STYLE_XML: Record<CslStyleId, string> = {
  apa: apaStyle,
  "chicago-author-date": chicagoStyle,
  mla: mlaStyle,
};

export type CslEngineLike = {
  updateItems: (ids: string[]) => void;
  // This build: [params, entryStrings] tuple. Some builds: {entries}.
  makeBibliography: () => [Record<string, unknown>, string[]] | { entries?: string[] } | undefined;
};

// The engine resolves items through sys.retrieveItem at formatting time;
// this holder makes the CURRENT call's items visible to every engine
// (formatting is synchronous — set → use → clear).
let activeItems: Map<string, CslBibItem> | null = null;

const engines = new Map<CslStyleId, CslEngineLike>();

function engineFor(style: CslStyleId): CslEngineLike {
  const cached = engines.get(style);
  if (cached) return cached;
  const sys = {
    // Only the bundled en-US locale exists; other languages fall back to
    // it (the app is en-US localised; other locales are a known gap).
    retrieveLocale: (lang: string) => (lang.startsWith("en") ? localeEnUs : undefined),
    retrieveItem: (id: string) => activeItems?.get(id),
    getAbbreviations: () => ({}),
  };
  const engine = new CSL.Engine(sys, STYLE_XML[style], "en-US");
  engines.set(style, engine);
  return engine;
}

/** Format the given items/ids through the processor; returns the raw
 * entry HTML blocks. */
export function runBibliography(
  style: CslStyleId,
  items: CslBibItem[],
  ids: string[],
): string[] {
  if (!ids.length) return [];
  const engine = engineFor(style);
  activeItems = new Map(items.map((item) => [item.id, item]));
  try {
    engine.updateItems(ids);
    const bib = engine.makeBibliography();
    if (!bib) return [];
    // This build returns a [params, entryStrings] tuple; the {entries}
    // shape is handled for newer builds. Both unpack honestly.
    const entries = Array.isArray(bib) ? bib[1] : bib.entries;
    return entries ?? [];
  } finally {
    activeItems = null;
  }
}

// ─────────────────────────────────────────────
// Entry HTML → structured runs
// ─────────────────────────────────────────────
// makeBibliography() emits HTML per entry: a `csl-entry` div; styles
// with hanging indents (MLA, Chicago) split it into `csl-left-inline`
// (the author) + `csl-right-inline` (the rest). The walk flattens the
// structure into runs, keeping i/em/b/strong as real formatting and
// unwrapping spans/links to their text.

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

export function parseEntryHtml(entryHtml: string): FormattedEntry {
  const dom = new DOMParser().parseFromString(entryHtml, "text/html");
  const runs: FormattedRun[] = [];
  const pushText = (text: string, fmt: { italic?: boolean; bold?: boolean }): void => {
    if (!text) return;
    const prev = runs[runs.length - 1];
    if (prev && !!prev.italic === !!fmt.italic && !!prev.bold === !!fmt.bold) {
      prev.text += text;
      return;
    }
    runs.push({ text, ...(fmt.italic ? { italic: true } : {}), ...(fmt.bold ? { bold: true } : {}) });
  };
  const walk = (node: Node, fmt: { italic?: boolean; bold?: boolean }): void => {
    if (node.nodeType === TEXT_NODE) {
      pushText(node.textContent ?? "", fmt);
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") {
      pushText(" ", fmt);
      return;
    }
    const childFmt = {
      italic: fmt.italic || tag === "i" || tag === "em",
      bold: fmt.bold || tag === "b" || tag === "strong",
    };
    const children = Array.from(el.childNodes);
    children.forEach((child, i) => {
      const blockChild =
        child.nodeType === ELEMENT_NODE &&
        ["div", "p"].includes((child as Element).tagName.toLowerCase());
      // Block-level children of an entry (e.g. left/right inline) are
      // flattened with a single space so the text reads naturally.
      if (i > 0 && blockChild) pushText(" ", childFmt);
      walk(child, childFmt);
    });
  };
  for (const child of Array.from(dom.body.childNodes)) walk(child, {});
  return runs;
}
