import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useAppStore } from "@/stores/useAppStore";
import { useDraftStore } from "@/stores/draftStore";
import { useDocumentSession } from "@/components/editor/useDocumentSession";
import RichTextEditor from "@/components/editor/RichTextEditor";
import BodyRecoveryState from "@/components/editor/BodyRecoveryState";
import { richBodyProblem } from "@/components/editor/editorSchema";
import EditorToolbar from "@/components/editor/EditorToolbar";
import DocumentOutline, { useOutline } from "@/components/editor/DocumentOutline";
import DocumentStatus, { SaveFailedBanner } from "@/components/editor/DocumentStatus";
import FindReplaceBar from "@/components/editor/FindReplaceBar";
import { readoutFromDoc } from "@/components/editor/DocumentReadout";
import { collectSourceRefs, missingSourceIds } from "@/utils/sourceRefs";
import {
  createFootnoteId,
  nextFootnoteLabel,
} from "@/components/editor/footnoteExtension";
import { promptForLink } from "@/components/editor/linkCommand";
import { richDocument } from "@/utils/documentCodec";
import { CSL_STYLES, type CslStyleId } from "@/utils/cslProcessor";
import { requestProposal, setActiveEditor, clearActiveEditor, cancelProposalRequests } from "@/services/revisionService";
import { useSourceStore } from "@/stores/sourceStore";
import { repo } from "@/utils/repository";
import type { SourcePassage } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Save, TriangleAlert, Type, Quote, ListEnd, Superscript } from "lucide-react";
import { textTypeLabel, type TextTypeId } from "@/types";

const TEXT_TYPE_IDS: TextTypeId[] = [
  "essay",
  "article",
  "research-paper",
  "letter",
  "talk",
  "other",
];

// ──────────────────────────────────────────────
// DocumentEditorView (Phase 4.2)
// ──────────────────────────────────────────────
// The full document-centred edit surface: metadata header, toolbar,
// manuscript (rich editor), outline, find/replace, and persistence
// status. Backed by the document session (R6 drafts + R2 save
// discipline + the 4.1 document contract).

export default function DocumentEditorView({
  id,
  projectId,
  sessionId,
  initial,
  onBack,
  onSaved,
  editorRef,
}: {
  id: string | null;
  projectId?: string;
  /** Unique identity for an unsaved document (per new-document session). */
  sessionId?: string;
  initial?: { title?: string; content?: string };
  onBack: () => void;
  /** Called with the saved id after an acknowledged Save (new → open). */
  onSaved?: (id: string) => void;
  /** Observes the live editor instance (shortcuts, integrations, tests). */
  editorRef?: (editor: Editor | null) => void;
}) {
  const session = useDocumentSession({ id, projectId, sessionId, initial });
  const [editor, setEditor] = useState<Editor | null>(null);
  // A rich body that does not validate against the canonical schema is
  // shown in a recovery state; its bytes are never handed to ProseMirror
  // and Save is blocked so the original cannot be replaced by empty text.
  const bodyProblem = useMemo(
    () => (session.initialBody ? richBodyProblem(session.initialBody) : null),
    [session.initialBody],
  );
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [seedQuery, setSeedQuery] = useState<string | undefined>(undefined);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [docSize, setDocSize] = useState({ words: 0, characters: 0 });
  const docFontSize = useAppStore((s) => s.docFontSize);
  const setDocFontSize = useAppStore((s) => s.setDocFontSize);

  // A save that finishes after the user navigated away must not change
  // the route (late new-document callbacks would yank them elsewhere).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** The editor instance this view registered as active (B11): its destroy
   * clears only this exact registration. */
  const registeredEditorRef = useRef<Editor | null>(null);

  const headings = useOutline(editor, refreshSignal);

  const handleDocChanged = useCallback(() => {
    setRefreshSignal((n) => n + 1);
    if (editor && !editor.isDestroyed) {
      setDocSize(readoutFromDoc(editor.state.doc));
    }
  }, [editor]);

  const handleEditorReady = useCallback(
    (next: Editor | null) => {
      setEditor(next);
      // The registration carries the DOCUMENT identity (B11): a proposal
      // can only be created from — or applied to — the editor that is
      // showing exactly its document. The destroy path clears only its
      // OWN registration: a late destroy must not disarm a newer editor.
      if (next && id) {
        registeredEditorRef.current = next;
        setActiveEditor({
          documentId: id,
          editor: next,
          editVersion: session.getEditVersion,
        });
      } else {
        const registered = registeredEditorRef.current;
        registeredEditorRef.current = null;
        clearActiveEditor(registered);
      }
      editorRef?.(next);
      if (next && !next.isDestroyed) {
        setDocSize(readoutFromDoc(next.state.doc));
        setRefreshSignal((n) => n + 1);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editorRef, id, session.getEditVersion],
  );

  // Selection-driven AI revision: produces a reviewable PROPOSAL in the
  // Review panel — nothing applies automatically.
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const handleRequestRevision = useCallback(
    async (kind: "revise" | "tighten" | "clarify" | "comment") => {
      if (!id || revisionBusy) return;
      setRevisionBusy(true);
      setRevisionError(null);
      try {
        const result = await requestProposal({ documentId: id, kind });
        // A cancelled request is a user decision, not an error: no
        // banner, the Review panel simply keeps its pending proposals.
        if ("cancelled" in result) return;
      } catch (err) {
        setRevisionError(
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        setRevisionBusy(false);
      }
    },
    [id, revisionBusy],
  );

  const handleCancelRevision = useCallback(() => {
    if (!id) return;
    cancelProposalRequests(id);
  }, [id]);

  const handleSave = useCallback(async () => {
    // A schema-invalid body has no live editor and must not be replaced.
    if (bodyProblem || !editor || editor.isDestroyed) return;
    const snapshot = editor;
    const savedId = await session.save(() => richDocument(snapshot.getJSON()));
    // The user may have left while the save was in flight: a late
    // new-document callback must not change navigation.
    if (!aliveRef.current) return;
    // A NEW document that was just created: hand its id to the shell.
    if (savedId && savedId !== id) {
      onSaved?.(savedId);
    }
  }, [bodyProblem, editor, session, id, onSaved]);

  // Keyboard: Ctrl/Cmd+S save, Ctrl/Cmd+F find, Ctrl/Cmd+K link while the
  // manuscript has focus. IME-safe (isComposing); a modal layer owns its
  // own keyboard, so shortcuts never leak out of dialogs/popovers (B20a).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.shiftKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("[role='dialog'], [role='alertdialog']")) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        void handleSave();
        return;
      }
      if (key === "f") {
        e.preventDefault();
        const selection = editor?.state.selection;
        const selectedText =
          selection && !selection.empty
            ? (editor?.state.doc.textBetween(selection.from, selection.to, " ") ?? "")
            : undefined;
        setSeedQuery(selectedText || "");
        setFindOpen(true);
        return;
      }
      if (key === "k") {
        // Link insertion wins ONLY when the keystroke originated inside the
        // manuscript; the shell's palette handler ignores contenteditable
        // targets, so exactly one of the two acts on the chord.
        if (
          editor &&
          !editor.isDestroyed &&
          target &&
          editor.view.dom.contains(target)
        ) {
          e.preventDefault();
          promptForLink(editor);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, editor]);

  // A failed save retains the editable content: Retry / Discard banner.
  const draft = useDraftStore((s) => s.drafts[session.draftKey] ?? null);
  const discardDraft = useCallback(() => {
    // Explicit discard: the session flags the draft as thrown away BEFORE
    // navigation, so the editor's unmount capture cannot resurrect it.
    session.discard();
    // Reverting the rich editor to the persisted content requires a
    // reload; the parent shell reopens the document read view.
    onBack();
  }, [session, onBack]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header: back, title/type/folder/project, save, status */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0 flex-wrap">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          title="Back to the document"
          aria-label="Back to the document"
        >
          <ArrowLeft className="size-4 text-text-secondary" />
        </Button>
        <Input
          value={session.meta.title}
          onChange={(e) => session.setMeta({ title: e.target.value })}
          placeholder="Document title…"
          className="h-8 bg-field max-w-[340px] font-medium"
          aria-label="Document title"
        />
        <Select
          value={session.meta.textType}
          onValueChange={(v) => session.setMeta({ textType: (v ?? "other") as TextTypeId })}
        >
          <SelectTrigger className="h-8 bg-field w-36" aria-label="Document type">
            <SelectValue>{textTypeLabel(session.meta.textType)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TEXT_TYPE_IDS.map((t) => (
              <SelectItem key={t} value={t}>
                {textTypeLabel(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={session.meta.folder}
          onChange={(e) => session.setMeta({ folder: e.target.value })}
          placeholder="Folder (optional)"
          className="h-8 bg-field w-40"
          aria-label="Folder"
        />
        <div className="flex-1" />
        {/* Citations (5.4b): insert from YOUR sources; bibliography from
            the citations actually in the document. */}
        <CiteControls editorRef={() => editor} />
        <ManuscriptSizeControl value={docFontSize} onChange={setDocFontSize} />
        <div className="flex items-center gap-3">
          <DocumentStatus state={session.saveState} />
          <Button
            size="sm"
            className="bg-primary hover:bg-primary/80 text-primary-foreground"
            onClick={() => void handleSave()}
            disabled={
              session.saveState === "saving" ||
              session.initialBody == null ||
              bodyProblem != null
            }
          >
            <Save className="size-4 mr-1" />
            Save
          </Button>
        </div>
      </div>

      {/* Failed save: editable content retained; retry/discard. */}
      {draft?.error && (
        <SaveFailedBanner
          message={draft.error}
          onRetry={() => void handleSave()}
          onDiscard={discardDraft}
        />
      )}

      {/* Load failure: recoverable, retryable. */}
      {session.loadError && (
        <div
          role="alert"
          className="flex items-center gap-3 px-4 py-2 border-b border-border bg-surface-alt text-xs text-text-secondary shrink-0"
        >
          <TriangleAlert className="size-4 shrink-0 text-warning" />
          <span className="flex-1">{session.loadError}</span>
          <Button size="sm" variant="outline" onClick={session.retryLoad}>
            Retry load
          </Button>
        </div>
      )}

      {/* Conversion report: what the markdown → rich conversion changed. */}
      {session.conversion && !session.conversion.lossless && (
        <div
          role="status"
          className="flex items-start gap-3 px-4 py-2 border-b border-border bg-surface-alt text-xs text-text-secondary shrink-0"
        >
          <TriangleAlert className="size-4 shrink-0 text-warning mt-0.5" />
          <span className="flex-1">
            Converted from Markdown.
            {session.conversion.warnings.length > 0 && (
              <span>
                {" "}
                {session.conversion.warnings.join(" ")} The original text
                stays in this document's version history.
              </span>
            )}
          </span>
        </div>
      )}

      <EditorToolbar
        editor={editor ?? neverEditor}
        onOpenFind={() => {
          setSeedQuery(undefined);
          setFindOpen(true);
        }}
        onToggleOutline={() => setOutlineOpen((v) => !v)}
        outlineOpen={outlineOpen}
        onRequestRevision={id ? handleRequestRevision : undefined}
        revisionBusy={revisionBusy}
        onCancelRevision={id ? handleCancelRevision : undefined}
      />

      {revisionError && (
        <div
          role="alert"
          className="flex items-center gap-3 px-4 py-2 border-b border-border bg-surface-alt text-xs text-text-secondary shrink-0"
        >
          <TriangleAlert className="size-4 shrink-0 text-warning" />
          <span className="flex-1">{revisionError}</span>
          <Button variant="ghost" size="sm" onClick={() => setRevisionError(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {findOpen && editor && (
        <FindReplaceBar
          editor={editor}
          seedQuery={seedQuery}
          onClose={() => setFindOpen(false)}
        />
      )}

      {/* Manuscript + outline */}
      <div className="flex flex-1 min-h-0">
        {session.initialBody == null && !session.loadError ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-text-muted select-none">Loading…</p>
          </div>
        ) : session.initialBody && bodyProblem ? (
          <BodyRecoveryState
            error={bodyProblem}
            raw={session.initialBody.content}
            onRetry={session.retryLoad}
          />
        ) : session.initialBody ? (
          <RichTextEditor
            key={session.draftKey}
            body={session.initialBody}
            docFontSize={docFontSize}
            onSessionEdit={session.markEdited}
            onDraftEdit={session.recordEdit}
            onDocChanged={handleDocChanged}
            onEditorReady={handleEditorReady}
          />
        ) : null}
        <DocumentOutline
          editor={editor}
          headings={headings}
          open={outlineOpen}
          onClose={() => setOutlineOpen(false)}
        />
      </div>

      {/* Footer readout */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-t border-border shrink-0 text-[11px] text-text-muted select-none">
        <span>
          {docSize.words} words · {docSize.characters} characters
        </span>
        <div className="flex-1" />
        <span>Ctrl+S save · Ctrl+F find · Ctrl+Z undo</span>
      </div>
    </div>
  );
}

/** Placeholder editor for the toolbar before the real one is ready. */
const neverEditor = null as unknown as Editor;

/** Cite + bibliography controls (Phase 5.4b/5.4e). Citations reference
 * the user's OWN source records; the bibliography is generated by the
 * CSL processor (citeproc-js) from the citations actually in the
 * document — never invented, styled per the picked CSL style. */
function CiteControls({ editorRef }: { editorRef: () => Editor | null }) {
  const sources = useSourceStore((s) => s.sources);
  const cslStyle = useAppStore((s) => s.cslStyle);
  const setCslStyle = useAppStore((s) => s.setCslStyle);
  const [sourceId, setSourceId] = useState("");
  const [passageId, setPassageId] = useState("");
  const [passages, setPassages] = useState<SourcePassage[]>([]);
  const [bibBusy, setBibBusy] = useState(false);
  const [footBusy, setFootBusy] = useState(false);
  const [bibError, setBibError] = useState<string | null>(null);
  const [bibNotice, setBibNotice] = useState<string | null>(null);

  // The picked source's passages feed the locator picker (5.4e: source
  // locators ride footnotes; B19 keeps the passage id on the note too).
  useEffect(() => {
    setPassageId("");
    setPassages([]);
    if (!sourceId) return;
    let cancelled = false;
    void repo.sourceGet(sourceId).then((data) => {
      if (!cancelled) setPassages(data?.passages ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  const citationLabel = (s: { author?: string; year?: string; title: string }): string => {
    const parts: string[] = [];
    if (s.author) parts.push(s.author.split(/[;,]/)[0]);
    if (s.year) parts.push(s.year);
    return parts.length > 0 ? `(${parts.join(", ")})` : `(${s.title.slice(0, 24)})`;
  };

  const insertCitation = () => {
    const editor = editorRef();
    if (!editor || editor.isDestroyed || !sourceId) return;
    const source = sources.find((s) => s.id === sourceId);
    if (!source) return;
    editor.commands.focus();
    editor.commands.insertCitation({
      sourceId: source.id,
      label: citationLabel(source),
    });
  };

  const insertBibliography = async () => {
    const editor = editorRef();
    if (!editor || editor.isDestroyed || bibBusy) return;
    // B19: citations AND source-backed footnotes count as references.
    const refs = collectSourceRefs(editor.state.doc);
    if (refs.length === 0) return;
    setBibBusy(true);
    setBibError(null);
    setBibNotice(null);
    try {
      const { formatBibliography, cslStyleInfo } = await import("@/utils/cslProcessor");
      const missing = missingSourceIds(refs, sources);
      if (missing.length > 0) {
        setBibNotice(
          `${missing.length} reference${
            missing.length === 1 ? "" : "s"
          } point to sources that no longer exist; ${
            missing.length === 1 ? "it was" : "they were"
          } skipped.`,
        );
      }
      const entries = await formatBibliography(refs, sources, cslStyle);
      if (entries.length === 0) return;
      const sectionTitle = cslStyleInfo(cslStyle).sectionTitle;
      const inline = entries.map((entry) => ({
        type: "paragraph",
        content: entry.map((run) => ({
          type: "text",
          text: run.text,
          marks: [
            ...(run.italic ? [{ type: "italic" }] : []),
            ...(run.bold ? [{ type: "bold" }] : []),
          ],
        })),
      }));
      const end = editor.state.doc.content.size;
      editor
        .chain()
        .focus("end")
        .insertContentAt(end, {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: sectionTitle }],
            },
            ...inline,
          ],
        })
        .run();
    } catch (err) {
      setBibError(
        `Bibliography formatting failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBibBusy(false);
    }
  };

  const insertFootnote = async () => {
    const editor = editorRef();
    if (!editor || editor.isDestroyed || footBusy) return;
    setFootBusy(true);
    try {
      const label = nextFootnoteLabel(editor.state.doc);
      const passage = passages.find((p) => p.id === passageId);
      const locator = passage?.locator ?? "";
      let text = "";
      const source = sources.find((s) => s.id === sourceId);
      if (source) {
        // Style-consistent reference text from the processor + the passage
        // locator ("Césaire, A. (1966). Une saison au Congo, ¶ 3–4.").
        try {
          const { formatBibliography, entryToText } = await import("@/utils/cslProcessor");
          const [entry] = await formatBibliography([{ sourceId: source.id }], sources, cslStyle);
          let refText = entry ? entryToText(entry) : source.title;
          if (locator && refText.endsWith(".")) {
            refText = `${refText.slice(0, -1)}, ${locator}.`;
          } else if (locator) {
            refText = `${refText}, ${locator}`;
          }
          text = refText;
        } catch {
          text = source.title;
        }
      } else {
        const given = window.prompt("Footnote text:");
        if (!given) return;
        text = given;
      }
      editor.commands.focus();
      // B19: a stable id plus the source provenance ride the node; the
      // stored text is the display fallback if the source disappears.
      editor.commands.insertFootnote({
        id: createFootnoteId(),
        label,
        text,
        sourceId: source?.id ?? null,
        passageId: passage?.id ?? null,
        locator,
      });
    } finally {
      setFootBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Citations">
      {bibError && (
        <span role="alert" className="text-[11px] text-destructive max-w-[260px]">
          {bibError}
        </span>
      )}
      {bibNotice && (
        <span role="status" className="text-[11px] text-text-muted max-w-[260px]">
          {bibNotice}
        </span>
      )}
      <select
        value={cslStyle}
        onChange={(e) => setCslStyle((e.target.value ?? "apa") as CslStyleId)}
        className="h-8 rounded-md border border-border bg-field px-2 text-xs max-w-[150px]"
        aria-label="Citation style"
      >
        {CSL_STYLES.map((style) => (
          <option key={style.id} value={style.id}>
            {style.label}
          </option>
        ))}
      </select>
      <select
        value={sourceId}
        onChange={(e) => setSourceId(e.target.value)}
        className="h-8 rounded-md border border-border bg-field px-2 text-xs max-w-[180px]"
        aria-label="Source to cite"
      >
        <option value="">Cite…</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title.slice(0, 40)}
          </option>
        ))}
      </select>
      {passages.length > 0 && (
        <select
          value={passageId}
          onChange={(e) => setPassageId(e.target.value)}
          className="h-8 rounded-md border border-border bg-field px-2 text-xs max-w-[110px]"
          aria-label="Source locator"
        >
          <option value="">No locator</option>
          {passages.map((p, i) => (
            <option key={p.id || `${p.locator}-${i}`} value={p.id}>
              {p.locator || `Passage ${i + 1}`}
            </option>
          ))}
        </select>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={insertCitation}
        disabled={!sourceId}
        title="Insert citation at the cursor"
        aria-label="Insert citation"
      >
        <Quote className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void insertFootnote()}
        disabled={footBusy}
        title="Insert a footnote (style-consistent reference + locator when a source is picked)"
        aria-label="Insert footnote"
      >
        <Superscript className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void insertBibliography()}
        disabled={bibBusy}
        title="Insert a bibliography from the citations in this document (CSL processor)"
        aria-label="Insert bibliography"
      >
        <ListEnd className="size-3.5" />
      </Button>
    </div>
  );
}

/** Manuscript typography control (DESIGN.md: 18px default, user-adjustable). */
function ManuscriptSizeControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const step = (delta: number) => {
    onChange(Math.min(26, Math.max(14, value + delta)));
  };
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Text size">
      <Type className="size-3.5 text-text-muted" />
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => step(-1)}
        aria-label="Smaller text"
        title="Smaller text"
      >
        <span className="text-xs">A−</span>
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => step(1)}
        aria-label="Larger text"
        title="Larger text"
      >
        <span className="text-xs">A+</span>
      </Button>
    </div>
  );
}
