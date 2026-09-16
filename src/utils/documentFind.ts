// ============================================================
// Find / replace over a ProseMirror document (Phase 4.2, B20a)
// ============================================================
// Plain-text search across the whole document, independent of node
// boundaries: text is collected as runs, matches map to [from, to)
// positions in the current document. Pure functions over the editor
// state so they are unit-testable without a mounted editor.

import type { EditorState, Transaction } from "@tiptap/pm/state";

export interface TextRun {
  /** Concatenated text of the run. */
  text: string;
  /** Document position of the run's start. */
  from: number;
  /** Per-character document positions (run[i] is the i-th character). */
  positions: number[];
}

export interface TextMatch {
  from: number;
  to: number;
}

interface DocLike {
  descendants(
    f: (
      node: { isText: boolean; text?: string; type: { name: string } },
      pos: number,
    ) => boolean | void,
  ): void;
}

/** Collect text runs (per textblock) with their document positions. */
export function collectTextRuns(doc: DocLike): TextRun[] {
  const runs: TextRun[] = [];
  let current: TextRun | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText) {
      // Any non-text node (paragraph, heading, cell, break…) is a run
      // barrier: matches never span blocks or structured nodes.
      current = null;
      return;
    }
    if (typeof node.text !== "string" || node.text.length === 0) return;
    // The pos passed to descendants for a text node is its start.
    for (let i = 0; i < node.text.length; i++) {
      const at = pos + i;
      if (!current) {
        current = { text: "", from: at, positions: [] };
        runs.push(current);
      }
      current.text += node.text[i];
      current.positions.push(at);
    }
  });
  return runs;
}

interface FoldedText {
  /** The lowercased text searched against. */
  text: string;
  /** For each folded character, its index in the ORIGINAL string — null
   * when folding kept a 1:1 length (offsets are then identical). */
  map: number[] | null;
}

/**
 * Case-fold for searching while keeping a way back to original offsets.
 * When lowercasing changes length (İ lowercases to "i" + combining dot),
 * a per-character map is built so match offsets still land on the real
 * characters instead of drifting (B20a).
 */
function foldForSearch(value: string): FoldedText {
  const lowered = value.toLowerCase();
  if (lowered.length === value.length) return { text: lowered, map: null };
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const part = value[i].toLowerCase();
    for (let k = 0; k < part.length; k++) {
      chars.push(part[k]);
      map.push(i);
    }
  }
  return { text: chars.join(""), map };
}

/**
 * All matches of `query` (literal text, not regex). Case-insensitive by
 * default; adjacent runs join so matches crossing node boundaries (e.g.
 * bold inside a sentence) are still found, with blocks and hard breaks
 * acting as match barriers.
 */
export function findMatches(
  doc: DocLike,
  query: string,
  options?: { caseSensitive?: boolean },
): TextMatch[] {
  const caseSensitive = options?.caseSensitive === true;
  const needle = caseSensitive ? query : foldForSearch(query).text;
  if (!needle) return [];
  const matches: TextMatch[] = [];
  for (const run of collectTextRuns(doc)) {
    const folded: FoldedText = caseSensitive
      ? { text: run.text, map: null }
      : foldForSearch(run.text);
    const haystack = folded.text;
    let at = haystack.indexOf(needle);
    while (at >= 0) {
      const startIndex = folded.map ? folded.map[at] : at;
      const lastIndex = at + needle.length - 1;
      const endIndex = folded.map ? folded.map[lastIndex] : lastIndex;
      matches.push({
        from: run.positions[startIndex],
        to: run.positions[endIndex] + 1,
      });
      at = haystack.indexOf(needle, at + needle.length);
    }
  }
  return matches;
}

/**
 * One transaction replacing every match with `replacement`, applied from
 * the END so earlier positions stay valid. `tr.insertText` inserts the
 * string as LITERAL text — a replacement like `<b>bold</b>` is never
 * parsed as markup (B20a).
 */
export function replaceMatches(
  state: EditorState,
  matches: TextMatch[],
  replacement: string,
): Transaction {
  const tr = state.tr;
  for (let i = matches.length - 1; i >= 0; i--) {
    tr.insertText(replacement, matches[i].from, matches[i].to);
  }
  return tr;
}

/**
 * The next match at or after `fromPos` (wrapping around the document
 * once). Returns the same list entry the caller can highlight.
 */
export function nextMatch(
  matches: TextMatch[],
  fromPos: number,
  wrap: boolean,
): { match: TextMatch; index: number } | null {
  if (matches.length === 0) return null;
  const at = matches.findIndex((m) => m.from >= fromPos);
  if (at >= 0) return { match: matches[at], index: at };
  return wrap ? { match: matches[0], index: 0 } : null;
}
