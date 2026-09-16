import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";
import {
  findMatches,
  nextMatch,
  replaceMatches,
  type TextMatch,
} from "@/utils/documentFind";

// ──────────────────────────────────────────────
// FindReplaceBar (Phase 4.2)
// ──────────────────────────────────────────────
// Literal, case-optional find/replace over the current editor document.
// Navigation wraps once; replacement writes a ProseMirror transaction
// (undoable like any other edit). Matches never span block boundaries.

interface FindReplaceBarProps {
  editor: Editor;
  onClose: () => void;
  /** Seed the query from the current selection (Ctrl+F). */
  seedQuery?: string;
}

export default function FindReplaceBar({
  editor,
  onClose,
  seedQuery,
}: FindReplaceBarProps) {
  const [query, setQuery] = useState(seedQuery ?? "");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matchInfo, setMatchInfo] = useState<{ at: number; total: number } | null>(null);
  const queryInputRef = useRef<HTMLInputElement>(null);

  const computeMatches = (): TextMatch[] =>
    findMatches(editor.state.doc, query, { caseSensitive });

  /** Highlight a match WITHOUT stealing focus from the Find inputs: the
   * selection is set through a transaction, not `editor.commands.focus()`
   * (B20a — typing Enter repeatedly must never pull the caret out). */
  const focusCurrent = (match: TextMatch) => {
    editor.commands.setTextSelection({ from: match.from, to: match.to });
    try {
      const domAt = editor.view.domAtPos(match.from);
      const element =
        domAt.node instanceof HTMLElement ? domAt.node : domAt.node.parentElement;
      element?.scrollIntoView({ block: "center" });
    } catch {
      // stale position: ignore
    }
  };

  const findNext = (fromPos?: number) => {
    if (!query) return;
    const matches = computeMatches();
    const at =
      fromPos ?? (editor.state.selection.empty ? editor.state.selection.from : editor.state.selection.to);
    const next = nextMatch(matches, at, true);
    if (next) {
      setMatchInfo({ at: next.index + 1, total: matches.length });
      focusCurrent(next.match);
    } else {
      setMatchInfo(matches.length > 0 ? { at: 1, total: matches.length } : { at: 0, total: 0 });
    }
  };

  const findPrevious = () => {
    if (!query) return;
    const matches = computeMatches();
    if (matches.length === 0) {
      setMatchInfo({ at: 0, total: 0 });
      return;
    }
    const at = editor.state.selection.from;
    const before = matches.filter((m) => m.to <= at);
    const target = before.length > 0 ? before[before.length - 1] : matches[matches.length - 1];
    setMatchInfo({ at: matches.indexOf(target) + 1, total: matches.length });
    focusCurrent(target);
  };

  const replaceCurrent = () => {
    if (!query) return;
    const matches = computeMatches();
    if (matches.length === 0) return;
    const { from, to } = editor.state.selection;
    const current = matches.find((m) => m.from === from && m.to === to);
    if (current) {
      // Literal text insertion (B20a): a replacement containing markup is
      // inserted as text, never parsed as HTML/JSON.
      editor.view.dispatch(replaceMatches(editor.state, [current], replacement));
    }
    // Move to the next match after replacing (or after skipping).
    findNext(editor.state.selection.to);
    queryInputRef.current?.focus();
  };

  const replaceAll = () => {
    if (!query) return;
    const matches = computeMatches();
    if (matches.length === 0) return;
    // One transaction, replacements applied from the end (positions stay
    // valid), each inserted as LITERAL text.
    editor.view.dispatch(replaceMatches(editor.state, matches, replacement));
    // The document changed: matches are stale until the next search.
    setMatchInfo(null);
    queryInputRef.current?.focus();
  };

  // Ctrl+F again with a selection seeds the query.
  useEffect(() => {
    if (seedQuery != null) setQuery(seedQuery);
  }, [seedQuery]);

  return (
    <div
      role="search"
      aria-label="Find and replace"
      className="px-4 py-2 border-b border-border bg-surface-alt shrink-0"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          ref={queryInputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setMatchInfo(null);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) findPrevious();
              else findNext();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Find…"
          className="h-8 bg-field w-52"
          aria-label="Find text"
          autoFocus
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setCaseSensitive((v) => !v)}
          onMouseDown={(e) => e.preventDefault()}
          aria-pressed={caseSensitive}
          title="Match case"
          aria-label="Match case"
        >
          <CaseSensitive className="size-4 text-text-secondary" />
        </Button>
        <span className="text-[11px] text-text-muted min-w-14" aria-live="polite">
          {query
            ? matchInfo
              ? `${matchInfo.at} of ${matchInfo.total}`
              : "press Enter"
            : ""}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={findPrevious}
          onMouseDown={(e) => e.preventDefault()}
          aria-label="Previous match"
          title="Previous (Shift+Enter)"
        >
          <ChevronUp className="size-4 text-text-secondary" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => findNext()}
          onMouseDown={(e) => e.preventDefault()}
          aria-label="Next match"
          title="Next (Enter)"
        >
          <ChevronDown className="size-4 text-text-secondary" />
        </Button>
        <div className="w-px h-5 bg-border mx-1" aria-hidden />
        <Input
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Replace with…"
          className="h-8 bg-field w-52"
          aria-label="Replace with"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={replaceCurrent}
          onMouseDown={(e) => e.preventDefault()}
          disabled={!query}
        >
          Replace
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={replaceAll}
          onMouseDown={(e) => e.preventDefault()}
          disabled={!query}
        >
          Replace all
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close find and replace">
          <X className="size-4 text-text-secondary" />
        </Button>
      </div>
    </div>
  );
}
