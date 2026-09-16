import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ListTree, X } from "lucide-react";
import { Button } from "@/components/ui/button";

// ──────────────────────────────────────────────
// DocumentOutline (Phase 4.2)
// ──────────────────────────────────────────────
// Headings of the current document, refreshed on the debounced doc-change
// signal (never per keystroke). Clicking a heading moves the selection and
// scrolls the editor surface to it.

export interface OutlineHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  pos: number;
}

/** Extract headings from a ProseMirror document. */
export function collectHeadings(doc: Editor["state"]["doc"]): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return;
    const level = (node.attrs.level as number ?? 1) as OutlineHeading["level"];
    headings.push({ level, text: node.textContent.trim(), pos });
  });
  return headings;
}

export default function DocumentOutline({
  editor,
  headings,
  open,
  onClose,
}: {
  editor: Editor | null;
  headings: OutlineHeading[];
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;

  const jump = (heading: OutlineHeading) => {
    if (!editor) return;
    editor.commands.focus();
    editor.commands.setTextSelection({ from: heading.pos + 1, to: heading.pos + 1 });
    // Scroll the ProseMirror surface to the heading.
    try {
      const domAt = editor.view.domAtPos(heading.pos);
      const element =
        domAt.node instanceof HTMLElement
          ? domAt.node
          : domAt.node.parentElement;
      element?.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch {
      // A stale position (document changed since render): ignore.
    }
  };

  return (
    <aside
      aria-label="Document outline"
      className="w-60 shrink-0 border-l border-border bg-surface flex flex-col"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <ListTree className="size-4 text-text-secondary" />
        <span className="text-xs font-medium text-text-secondary flex-1">
          Outline
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close outline"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <nav className="flex-1 overflow-y-auto py-1">
        {headings.length === 0 ? (
          <p className="text-xs text-text-muted px-3 py-4">
            No headings yet. Use H1–H3 in the toolbar to structure the
            document.
          </p>
        ) : (
          headings.map((h, i) => (
            <button
              key={`${h.pos}-${i}`}
              type="button"
              onClick={() => jump(h)}
              className={`block w-full text-left px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-alt hover:text-text-primary truncate ${
                h.level <= 1 ? "font-semibold" : h.level === 2 ? "font-medium" : ""
              }`}
              style={{ paddingLeft: `${12 + (h.level - 1) * 12}px` }}
              title={h.text || "(untitled heading)"}
            >
              {h.text || "(untitled heading)"}
            </button>
          ))
        )}
      </nav>
    </aside>
  );
}

/** Hook: collect headings from the editor on an interval signal. */
export function useOutline(editor: Editor | null, refreshSignal: number) {
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      setHeadings([]);
      return;
    }
    setHeadings(collectHeadings(editor.state.doc));
  }, [editor, refreshSignal]);
  return headings;
}
