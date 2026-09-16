import { useCallback } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { promptForLink } from "@/components/editor/linkCommand";
import {
  Bold,
  Braces,
  Code,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Undo2,
} from "lucide-react";

// ──────────────────────────────────────────────
// EditorToolbar (Phase 4.2)
// ──────────────────────────────────────────────
// One row of document formatting commands. All buttons are real buttons
// (keyboard reachable); disabled state mirrors editor.can().

interface ToolbarProps {
  editor: Editor;
  onOpenFind: () => void;
  onToggleOutline: () => void;
  outlineOpen: boolean;
  /** Selection-driven revision request (Phase 5.3). */
  onRequestRevision?: (kind: "revise" | "tighten" | "clarify" | "comment") => void;
  revisionBusy?: boolean;
  onCancelRevision?: () => void;
}

export default function EditorToolbar({
  editor,
  onOpenFind,
  onToggleOutline,
  outlineOpen,
  onRequestRevision,
  revisionBusy,
  onCancelRevision,
}: ToolbarProps) {
  // Reactive selection state (re-renders on selection/doc changes).
  const state = useToolbarState(editor);

  const setLink = useCallback(() => {
    promptForLink(editor);
  }, [editor]);

  const insertTable = useCallback(() => {
    editor
      .chain()
      .focus()
      .insertTable({ rows: 2, cols: 3, withHeaderRow: true })
      .run();
  }, [editor]);

  const heading = (level: 1 | 2 | 3) => {
    editor.chain().focus().toggleHeading({ level }).run();
  };

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex items-center gap-0.5 px-4 py-1.5 border-b border-border shrink-0 flex-wrap bg-surface"
    >
      <ToolbarButton
        label="Bold (Ctrl+B)"
        active={state.bold}
        disabled={!state.canBold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Italic (Ctrl+I)"
        active={state.italic}
        disabled={!state.canItalic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Underline"
        active={state.underline}
        disabled={!state.canUnderline}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Strikethrough"
        active={state.strike}
        disabled={!state.canStrike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Inline code"
        active={state.code}
        disabled={!state.canCode}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <Code className="size-4" />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton
        label="Heading 1"
        active={state.h1}
        disabled={!state.canHeading}
        onClick={() => heading(1)}
      >
        <span className="text-xs font-semibold" aria-hidden>H1</span>
      </ToolbarButton>
      <ToolbarButton
        label="Heading 2"
        active={state.h2}
        disabled={!state.canHeading}
        onClick={() => heading(2)}
      >
        <span className="text-xs font-semibold" aria-hidden>H2</span>
      </ToolbarButton>
      <ToolbarButton
        label="Heading 3"
        active={state.h3}
        disabled={!state.canHeading}
        onClick={() => heading(3)}
      >
        <span className="text-xs font-semibold" aria-hidden>H3</span>
      </ToolbarButton>
      <ToolbarButton
        label="Body text"
        active={state.paragraph && !state.inBlockquote}
        disabled={!state.canHeading}
        onClick={() => editor.chain().focus().setParagraph().run()}
      >
        <span className="text-xs font-medium" aria-hidden>¶</span>
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton
        label="Bullet list"
        active={state.bulletList}
        disabled={!state.canList}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Numbered list"
        active={state.orderedList}
        disabled={!state.canList}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Quotation"
        active={state.inBlockquote}
        disabled={!state.canBlockquote}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Code block"
        active={state.codeBlock}
        disabled={!state.canCodeBlock}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        <Braces className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Insert table"
        active={state.inTable}
        disabled={!state.canTable}
        onClick={insertTable}
      >
        <TableIcon className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Link (Ctrl+K)"
        active={state.link}
        disabled={!state.canLink}
        onClick={setLink}
      >
        <Link2 className="size-4" />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton
        label="Undo (Ctrl+Z)"
        disabled={!state.canUndo}
        onClick={() => editor.chain().focus().undo().run()}
      >
        <Undo2 className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Redo (Ctrl+Shift+Z)"
        disabled={!state.canRedo}
        onClick={() => editor.chain().focus().redo().run()}
      >
        <Redo2 className="size-4" />
      </ToolbarButton>

      <div className="flex-1" />

      {/* Selection-driven AI revision (Phase 5.3): nothing applies without
          review — proposals land in the Review panel. */}
      <ReviseMenu
        disabled={!state.canLink || onRequestRevision == null}
        onRequestRevision={(kind) =>
          onRequestRevision ? onRequestRevision(kind) : undefined
        }
        busy={revisionBusy ?? false}
        onCancelRevision={onCancelRevision}
      />

      <Button
        variant="ghost"
        size="sm"
        onClick={onOpenFind}
        className="text-text-secondary"
        aria-label="Find and replace (Ctrl+F)"
      >
        Find
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggleOutline}
        aria-pressed={outlineOpen}
        className="text-text-secondary"
        aria-label="Toggle document outline"
      >
        Outline
      </Button>
    </div>
  );
}

function ToolbarButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`size-8 inline-flex items-center justify-center rounded-md text-text-secondary transition-colors
        hover:bg-surface-alt hover:text-text-primary disabled:opacity-40 disabled:pointer-events-none
        ${active ? "bg-selection text-text-primary" : ""}`}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-border mx-1.5" aria-hidden />;
}

/** The selection-driven revision menu (Revise/Tighten/Clarify/Comment).
 * While a request runs, it turns into the Cancel affordance. */
function ReviseMenu({
  disabled,
  onRequestRevision,
  busy,
  onCancelRevision,
}: {
  disabled: boolean;
  onRequestRevision: (kind: "revise" | "tighten" | "clarify" | "comment") => void;
  busy: boolean;
  onCancelRevision?: () => void;
}) {
  if (busy && onCancelRevision) {
    return (
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancelRevision}
          title="Cancel the running revision request"
        >
          <span className="text-text-secondary">Cancel…</span>
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {(
        [
          ["revise", "Revise"],
          ["tighten", "Tighten"],
          ["clarify", "Clarify"],
          ["comment", "Comment"],
        ] as const
      ).map(([kind, label]) => (
        <Button
          key={kind}
          variant="ghost"
          size="sm"
          disabled={disabled || busy}
          onClick={() => onRequestRevision(kind)}
          title={`${label} the selection — produces a reviewable proposal, nothing applies automatically`}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

/** Reactive toolbar state: selection marks + command availability. */
function useToolbarState(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) {
        return {
          bold: false,
          italic: false,
          underline: false,
          strike: false,
          code: false,
          h1: false,
          h2: false,
          h3: false,
          paragraph: false,
          bulletList: false,
          orderedList: false,
          inBlockquote: false,
          codeBlock: false,
          inTable: false,
          link: false,
          canBold: false,
          canItalic: false,
          canUnderline: false,
          canStrike: false,
          canCode: false,
          canHeading: false,
          canList: false,
          canBlockquote: false,
          canCodeBlock: false,
          canTable: false,
          canLink: false,
          canUndo: false,
          canRedo: false,
        };
      }
      const active = (name: string) => e.isActive(name);
      const can = (fn: () => boolean) => {
        try {
          return fn();
        } catch {
          return false;
        }
      };
      return {
        bold: active("bold"),
        italic: active("italic"),
        underline: active("underline"),
        strike: active("strike"),
        code: active("code"),
        h1: e.isActive("heading", { level: 1 }),
        h2: e.isActive("heading", { level: 2 }),
        h3: e.isActive("heading", { level: 3 }),
        paragraph: active("paragraph"),
        bulletList: active("bulletList"),
        orderedList: active("orderedList"),
        inBlockquote: active("blockquote"),
        codeBlock: active("codeBlock"),
        inTable: active("table"),
        link: active("link"),
        canBold: can(() => e.can().toggleBold()),
        canItalic: can(() => e.can().toggleItalic()),
        canUnderline: can(() => e.can().toggleUnderline()),
        canStrike: can(() => e.can().toggleStrike()),
        canCode: can(() => e.can().toggleCode()),
        canHeading: can(() => e.can().setParagraph()),
        canList: can(() => e.can().toggleBulletList()),
        canBlockquote: can(() => e.can().toggleBlockquote()),
        canCodeBlock: can(() => e.can().toggleCodeBlock()),
        canTable: can(() =>
          e.can().insertTable({ rows: 2, cols: 3, withHeaderRow: true }),
        ),
        canLink: can(() => e.can().setLink({ href: "" })),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      };
    },
  });
}
