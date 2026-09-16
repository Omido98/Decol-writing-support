import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
// Type augmentation: markdownName/renderMarkdown live on the extension
// config only when @tiptap/markdown's declarations are loaded.
import "@tiptap/markdown";
import { escapeHtmlAttr, escapeHtmlText } from "@/components/editor/markdownEscape";

// ──────────────────────────────────────────────
// Footnote reference node (Phase 5.4e part 2, B19)
// ──────────────────────────────────────────────
// An inline atom holding its own footnote content (plain text kept in
// attrs — the same survival pattern as the citation node).
//
// B19 made notes stable and faithful:
// - `id` is minted once at insertion and NEVER changes; labels are a
//   projection of document order (a plugin renumbers them after edits),
//   so deleting a middle note cannot leave duplicate labels.
// - Source-backed notes keep `sourceId`/`passageId`/`locator` alongside
//   the `text` they display. `text` is the display fallback: it is what
//   the note shows when the source record no longer exists.
// - The editor renders each note through a NodeView whose click-to-edit
//   popover writes the text back into the node (no window.prompt).

export interface FootnoteAttrs {
  /** Stable identity minted at insertion; never reused or renumbered. */
  id: string;
  /** Document-order marker (maintained by the renumbering plugin). */
  label: string;
  /** Display text — also the fallback when the source is gone. */
  text: string;
  /** Source record this note references, when source-backed. */
  sourceId?: string | null;
  /** The exact passage the locator points at, when source-backed. */
  passageId?: string | null;
  /** Human-readable passage locator (e.g. "¶ 3–4"). */
  locator?: string;
}

/** Mint a stable footnote identity. */
export function createFootnoteId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `fn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnote: {
      insertFootnote: (attrs: Partial<FootnoteAttrs>) => ReturnType;
    };
  }
}

// ──────────────────────────────────────────────
// Inline editing popover
// ──────────────────────────────────────────────

interface EditorHandle {
  element: HTMLElement;
  dismiss: () => void;
}

let openFootnoteEditor: EditorHandle | null = null;

/** Close any open footnote editor (test seam + one editor at a time). */
export function closeFootnoteEditor(): void {
  openFootnoteEditor?.dismiss();
  openFootnoteEditor = null;
}

function openFootnoteTextEditor(options: {
  anchor: HTMLElement;
  initialText: string;
  onSave: (text: string) => void;
}): EditorHandle {
  closeFootnoteEditor();

  const wrap = document.createElement("div");
  wrap.className = "footnote-editor";
  wrap.setAttribute("data-footnote-editor", "");
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-label", "Edit footnote");

  const input = document.createElement("textarea");
  input.className = "footnote-editor-input";
  input.setAttribute("aria-label", "Footnote text");
  input.rows = 3;
  input.value = options.initialText;

  const actions = document.createElement("div");
  actions.className = "footnote-editor-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save note";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  actions.append(save, cancel);
  wrap.append(input, actions);
  document.body.appendChild(wrap);

  const rect = options.anchor.getBoundingClientRect();
  wrap.style.position = "fixed";
  wrap.style.left = `${Math.max(8, rect.left)}px`;
  wrap.style.top = `${rect.bottom + 4}px`;
  wrap.style.zIndex = "60";

  let closed = false;
  const dismiss = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("mousedown", onOutside, true);
    wrap.remove();
    if (openFootnoteEditor?.element === wrap) openFootnoteEditor = null;
  };
  const commit = (): void => {
    const text = input.value;
    dismiss();
    options.onSave(text);
  };
  const onOutside = (event: MouseEvent): void => {
    const target = event.target as globalThis.Node | null;
    if (target && (wrap.contains(target) || options.anchor.contains(target))) {
      return;
    }
    dismiss();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      commit();
    }
  };

  input.addEventListener("keydown", onKey);
  save.addEventListener("click", commit);
  cancel.addEventListener("click", dismiss);
  document.addEventListener("mousedown", onOutside, true);
  input.focus();

  const handle: EditorHandle = { element: wrap, dismiss };
  openFootnoteEditor = handle;
  return handle;
}

/**
 * The relabel transaction for a state: rewrites every footnote label to
 * its 1-based document order, or null when the labels already match.
 */
function footnoteRelabelTransaction(
  state: EditorState,
): Transaction | null {
  const notes: { pos: number; node: ProseMirrorNode }[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name === "footnoteRef") notes.push({ pos, node });
  });
  const drift = notes.some(
    (entry, i) => String(entry.node.attrs.label ?? "") !== String(i + 1),
  );
  if (!drift) return null;
  const tr = state.tr;
  notes.forEach((entry, i) => {
    if (String(entry.node.attrs.label ?? "") === String(i + 1)) return;
    tr.setNodeMarkup(entry.pos, undefined, {
      ...entry.node.attrs,
      label: String(i + 1),
    });
  });
  return tr;
}

export const FootnoteRef = Node.create({
  name: "footnoteRef",
  inline: true,
  group: "inline",
  atom: true,

  // Markdown interchange: literal HTML carrying the content and its
  // provenance in data attributes — a footnote NEVER disappears from an
  // export and round-trips through import (parseHTML re-reads it).
  ...({
    markdownName: "footnoteRef",
    renderMarkdown: (node: { attrs?: Record<string, unknown> }) => {
      const label = String(node.attrs?.label ?? "");
      const attrs: string[] = ["data-footnote"];
      const add = (name: string, value: unknown): void => {
        const text = String(value ?? "");
        if (text) attrs.push(`${name}="${escapeHtmlAttr(text)}"`);
      };
      add("data-footnote-id", node.attrs?.id);
      add("data-footnote-text", node.attrs?.text);
      add("data-source-id", node.attrs?.sourceId);
      add("data-passage-id", node.attrs?.passageId);
      add("data-locator", node.attrs?.locator);
      // The marker text is escaped too: a label must not be able to close
      // the element early.
      return `<sup ${attrs.join(" ")}>${escapeHtmlText(label)}</sup>`;
    },
  } as object),

  addAttributes() {
    return {
      id: { default: null },
      label: { default: "" },
      text: { default: "" },
      sourceId: { default: null },
      passageId: { default: null },
      locator: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "sup[data-footnote]",
        getAttrs: (el) => {
          const element = el as HTMLElement;
          return {
            id: element.getAttribute("data-footnote-id"),
            label: element.textContent ?? "",
            text: element.getAttribute("data-footnote-text") ?? "",
            sourceId: element.getAttribute("data-source-id"),
            passageId: element.getAttribute("data-passage-id"),
            locator: element.getAttribute("data-locator") ?? "",
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "sup",
      mergeAttributes({
        "data-footnote": "",
        "data-footnote-id": node.attrs.id ?? "",
        "data-footnote-text": node.attrs.text ?? "",
        "data-source-id": node.attrs.sourceId ?? "",
        "data-passage-id": node.attrs.passageId ?? "",
        "data-locator": node.attrs.locator ?? "",
        class: "footnote-node",
      }),
      node.attrs.label ?? "",
    ];
  },

  renderText({ node }) {
    const label = node.attrs.label ?? "";
    const text = node.attrs.text ?? "";
    return text ? `[^${label}] ${text}` : `[^${label}]`;
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement("sup");
      dom.className = "footnote-node";
      dom.setAttribute("data-footnote", "");
      dom.setAttribute("spellcheck", "false");
      const marker = document.createElement("span");
      marker.className = "footnote-label";
      dom.appendChild(marker);

      const refresh = (updated: ProseMirrorNode): void => {
        const text = String(updated.attrs.text ?? "");
        marker.textContent = String(updated.attrs.label ?? "");
        dom.setAttribute("data-footnote-id", String(updated.attrs.id ?? ""));
        dom.title = text ? `${text} — click to edit` : "Click to edit footnote";
      };
      refresh(node);

      const saveText = (text: string): void => {
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, {
            ...current.attrs,
            text,
          }),
        );
      };

      const open = (event: Event): void => {
        event.preventDefault();
        event.stopPropagation();
        openFootnoteTextEditor({
          anchor: dom,
          initialText: String(current.attrs.text ?? ""),
          onSave: saveText,
        });
      };
      dom.addEventListener("click", open);

      return {
        dom,
        update: (updated: ProseMirrorNode) => {
          if (updated.type.name !== "footnoteRef") return false;
          current = updated;
          refresh(updated);
          return true;
        },
        stopEvent: (event: Event) =>
          event.type === "click" || event.type === "mousedown",
        ignoreMutation: () => true,
      };
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        // Document-order numbering (B19): whenever the document changes,
        // labels are rewritten to their 1-based position. Deleting a
        // middle note therefore can never leave duplicate or stale labels.
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          return footnoteRelabelTransaction(newState);
        },
        // F10: the INITIAL document was never a transaction, so a stored or
        // imported body with stale/duplicate labels would display (and
        // export) that way until the first edit. Normalize once when the
        // view is created, without adding an undo step.
        view: (editorView) => {
          queueMicrotask(() => {
            if (editorView.isDestroyed) return;
            const fix = footnoteRelabelTransaction(editorView.state);
            if (!fix) return;
            fix.setMeta("addToHistory", false);
            editorView.dispatch(fix);
          });
          return {};
        },
      }),
    ];
  },

  addCommands() {
    return {
      insertFootnote:
        (attrs: Partial<FootnoteAttrs>) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              id: attrs.id || createFootnoteId(),
              label: attrs.label ?? "",
              text: attrs.text ?? "",
              sourceId: attrs.sourceId ?? null,
              passageId: attrs.passageId ?? null,
              locator: attrs.locator ?? "",
            },
          }),
    };
  },
});

/** All footnotes in DOCUMENT ORDER (each is distinct — no dedup). */
export function collectFootnotes(
  doc: {
    descendants: (f: (node: { type: { name: string }; attrs: Record<string, unknown> }) => boolean | void) => void;
  },
): FootnoteAttrs[] {
  const out: FootnoteAttrs[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "footnoteRef") return;
    out.push({
      id: (node.attrs.id as string) ?? "",
      label: (node.attrs.label as string) ?? "",
      text: (node.attrs.text as string) ?? "",
      sourceId: (node.attrs.sourceId as string | null) ?? null,
      passageId: (node.attrs.passageId as string | null) ?? null,
      locator: (node.attrs.locator as string) ?? "",
    });
  });
  return out;
}

/**
 * All footnotes in a PLAIN ProseMirror-JSON tree: reader/DOCX paths have
 * no live Node API, so the `content` arrays are walked structurally.
 */
export function collectFootnotesFromJson(json: unknown): FootnoteAttrs[] {
  const out: FootnoteAttrs[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const n = node as {
      type?: unknown;
      attrs?: Record<string, unknown>;
      content?: unknown[];
    };
    if (n.type === "footnoteRef") {
      out.push({
        id: typeof n.attrs?.id === "string" ? n.attrs.id : "",
        label: typeof n.attrs?.label === "string" ? n.attrs.label : "",
        text: typeof n.attrs?.text === "string" ? n.attrs.text : "",
        sourceId:
          typeof n.attrs?.sourceId === "string" ? n.attrs.sourceId : null,
        passageId:
          typeof n.attrs?.passageId === "string" ? n.attrs.passageId : null,
        locator: typeof n.attrs?.locator === "string" ? n.attrs.locator : "",
      });
      return;
    }
    for (const child of n.content ?? []) walk(child);
  };
  walk(json);
  return out;
}

/** The next footnote label for a document (count + 1). The renumbering
 * plugin keeps labels equal to document order, so this cannot collide. */
export function nextFootnoteLabel(
  doc: Parameters<typeof collectFootnotes>[0],
): string {
  return String(collectFootnotes(doc).length + 1);
}
