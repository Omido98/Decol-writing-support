import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import BodyRecoveryState from "@/components/editor/BodyRecoveryState";
import {
  canonicalExtensions,
  richBodyProblem,
  validateRichPayload,
} from "@/components/editor/editorSchema";
import { richDocument, type DocumentBody } from "@/utils/documentCodec";
import type { Editor } from "@tiptap/react";

// ──────────────────────────────────────────────
// RichTextEditor (Phase 4.2, schema-guarded in B10)
// ──────────────────────────────────────────────
// The ProseMirror surface. The editor OWNS the manuscript while it is
// mounted; typing never round-trips through React state. Updates are
// debounced once here before they reach the session's draft projection.
//
// Every transaction additionally signals the session IMMEDIATELY and
// synchronously (`onSessionEdit`): the session marks itself dirty and
// retains the latest document, so a capture before navigation or before a
// persistence drain never depends on the debounce having fired.
//
// Content: a markdown body is parsed by @tiptap/markdown on mount (the
// validated conversion path); a rich body is validated against the
// canonical schema first. An invalid payload is NEVER handed to
// ProseMirror (which would silently drop unknown nodes and produce an
// empty document that Save could persist); it renders a recovery state
// with the raw bytes instead. The component is keyed by document id
// upstream — one editor instance per document, recreated when the
// identity changes, never by typing.

interface RichTextEditorProps {
  body: DocumentBody;
  docFontSize: number;
  /** IMMEDIATE per-transaction signal (session.markEdited): cheap, sync. */
  onSessionEdit: (doc: ProseMirrorNode) => void;
  /** Debounced draft projection (session.recordEdit). */
  onDraftEdit: (body: DocumentBody) => void;
  /** Debounced document-structure signal (outline, word count). */
  onDocChanged?: (editor: Editor) => void;
  onEditorReady: (editor: Editor | null) => void;
}

export default function RichTextEditor({
  body,
  docFontSize,
  onSessionEdit,
  onDraftEdit,
  onDocChanged,
  onEditorReady,
}: RichTextEditorProps) {
  const updateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const docChangedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionEdit = useRef(onSessionEdit);
  const draftEdit = useRef(onDraftEdit);
  const docChanged = useRef(onDocChanged);
  sessionEdit.current = onSessionEdit;
  draftEdit.current = onDraftEdit;
  docChanged.current = onDocChanged;

  const parsed = useMemo(() => {
    if (body.contentFormat === "markdown") {
      return { kind: "markdown" as const, content: body.content };
    }
    const result = validateRichPayload(body.content);
    return result.ok
      ? { kind: "rich" as const, content: result.json }
      : { kind: "invalid" as const, error: result.error };
  }, [body]);

  const editor = useEditor({
    extensions: canonicalExtensions(),
    content: parsed.kind === "invalid" ? undefined : parsed.content,
    contentType: parsed.kind === "markdown" ? "markdown" : "json",
    editable: parsed.kind !== "invalid",
    editorProps: {
      attributes: {
        class: "rich-doc",
        "aria-label": "Document text",
      },
    },
    onUpdate({ editor: current }) {
      // Synchronous: mark the session dirty and retain the latest document.
      // No serialization, no store write, no re-render here.
      sessionEdit.current(current.state.doc);
      // Debounce: typing stays local; the draft projection (and outline)
      // see the document twice a second at most.
      if (updateTimer.current) clearTimeout(updateTimer.current);
      updateTimer.current = setTimeout(() => {
        draftEdit.current(richDocument(current.getJSON()));
      }, 500);
      if (docChangedTimer.current) clearTimeout(docChangedTimer.current);
      docChangedTimer.current = setTimeout(() => {
        docChanged.current?.(current);
      }, 500);
    },
    onCreate({ editor: created }) {
      if (parsed.kind === "invalid") return;
      onEditorReady(created);
      // A brand-new empty document starts focused.
      if (created.isEmpty) {
        created.commands.focus("end");
      }
    },
    onDestroy() {
      onEditorReady(null);
    },
  });

  // Clear pending timers when unmounting. The LATEST document does not
  // live here — the session retains it and flushes it on unmount, so
  // clearing the debounce can never drop the only pending projection.
  useEffect(() => {
    return () => {
      if (updateTimer.current) clearTimeout(updateTimer.current);
      if (docChangedTimer.current) clearTimeout(docChangedTimer.current);
    };
  }, []);

  if (parsed.kind === "invalid") {
    return (
      <BodyRecoveryState
        error={richBodyProblem(body) ?? parsed.error}
        raw={body.content}
      />
    );
  }

  if (!editor) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-text-muted">Preparing the editor…</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto" data-testid="rich-doc-scroll">
      <div
        className="max-w-[720px] mx-auto px-6 py-8"
        style={{ fontSize: `${docFontSize}px` }}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
