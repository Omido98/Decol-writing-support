import { Node, mergeAttributes } from "@tiptap/core";
// Type augmentation: markdownName/renderMarkdown live on the extension
// config only when @tiptap/markdown's declarations are loaded.
import "@tiptap/markdown";
import { escapeHtmlAttr, escapeHtmlText } from "@/components/editor/markdownEscape";

// ──────────────────────────────────────────────
// Citation node (Phase 5.4b)
// ──────────────────────────────────────────────
// An inline atom referencing a SOURCE RECORD by id. It renders the
// author-date label; the sourceId keeps the link to the versioned source
// (survives restarts/backups through the document payload). Citations are
// user-inserted from their OWN sources — the AI never invents one.

export interface CitationAttrs {
  sourceId: string;
  label: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    citation: {
      insertCitation: (attrs: CitationAttrs) => ReturnType;
    };
  }
}

export const Citation = Node.create({
  name: "citation",
  inline: true,
  group: "inline",
  atom: true,

  // Markdown interchange: serialize as literal HTML (the manager keeps
  // HTML tokens on parse, and parseHTML below re-reads the span) — a
  // citation never disappears from an export. (The markdown config keys
  // are declared by @tiptap/markdown; asserted past the excess check.)
  ...({
    markdownName: "citation",
    renderMarkdown: (node: { attrs?: Record<string, unknown> }) => {
      const label = String(node.attrs?.label ?? "");
      const id = String(node.attrs?.sourceId ?? "");
      // Label text and the source-id attribute are escaped: a label is
      // arbitrary user/source text and must not be able to close the span
      // or inject attributes through the Markdown round-trip.
      return `<span data-citation data-source-id="${escapeHtmlAttr(id)}">${escapeHtmlText(label)}</span>`;
    },
  } as object),

  addAttributes() {
    return {
      sourceId: { default: null },
      label: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-citation]",
        getAttrs: (el) => ({
          sourceId: (el as HTMLElement).getAttribute("data-source-id"),
          label: (el as HTMLElement).textContent ?? "",
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "span",
      mergeAttributes({
        "data-citation": "",
        "data-source-id": node.attrs.sourceId,
        class: "citation-node",
      }),
      node.attrs.label ?? "",
    ];
  },

  renderText({ node }) {
    return node.attrs.label ?? "";
  },

  addCommands() {
    return {
      insertCitation:
        (attrs: CitationAttrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { sourceId: attrs.sourceId, label: attrs.label },
          }),
    };
  },
});

/** All citations in the document, in order (deduplicated by source id). */
export function collectCitations(
  doc: {
    descendants: (f: (node: { type: { name: string }; attrs: Record<string, unknown> }, pos: number) => boolean | void) => void;
  },
): { sourceId: string; label: string }[] {
  const seen = new Set<string>();
  const out: { sourceId: string; label: string }[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "citation") return;
    const id = node.attrs.sourceId as string | null;
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ sourceId: id, label: (node.attrs.label as string) ?? "" });
  });
  return out;
}


