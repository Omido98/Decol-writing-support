import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { wordCount as countWords } from "@/utils/tokens";

// ──────────────────────────────────────────────
// Document readouts (Phase 4.2)
// ──────────────────────────────────────────────
// Words + characters for the current editor document, derived from the
// ProseMirror document (never from a serialized payload). Refreshed with
// the debounced doc-change signal, like the outline.

export function readoutFromDoc(doc: Editor["state"]["doc"]) {
  const text = doc.textBetween(0, doc.content.size, "\n", " ");
  return { words: countWords(text), characters: text.length };
}

export function useDocumentReadout(
  editor: Editor | null,
  refreshSignal: number,
): { words: number; characters: number } {
  const [readout, setReadout] = useState({ words: 0, characters: 0 });
  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      setReadout({ words: 0, characters: 0 });
      return;
    }
    setReadout(readoutFromDoc(editor.state.doc));
  }, [editor, refreshSignal]);
  return readout;
}
