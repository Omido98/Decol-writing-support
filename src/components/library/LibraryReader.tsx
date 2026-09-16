import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useAppStore } from "@/stores/useAppStore";
import { exportText } from "@/utils/libraryIo";
import { markdownFromRich, richFromMarkdown } from "@/utils/richMarkdown";
import type { DocumentBody } from "@/utils/documentCodec";
import { rehypeSourceAtoms } from "@/components/library/sourceAtoms";
import BodyRecoveryState from "@/components/editor/BodyRecoveryState";
import { richBodyProblem } from "@/components/editor/editorSchema";
import { collectFootnotesFromJson } from "@/components/editor/footnoteExtension";
import { collectSourceRefsFromJson, missingSourceIds } from "@/utils/sourceRefs";
import { textTypeLabel } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import HistoryDialog from "@/components/library/HistoryDialog";
import {
  ArrowLeft,
  BookOpenCheck,
  Check,
  Copy,
  Download,
  FileDown,
  FolderOpen,
  History,
  Pencil,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function readErrorMessage(err: unknown): string {
  return `The text could not be loaded: ${
    err instanceof Error ? err.message : String(err)
  }`;
}

export default function LibraryReader({
  id,
  onBack,
  onEdit,
}: {
  id: string;
  onBack: () => void;
  onEdit: (id: string) => void;
}) {
  const meta = useLibraryStore((s) => s.texts.find((t) => t.id === id) ?? null);
  const loadTextContent = useLibraryStore((s) => s.loadTextContent);
  const requestAttach = useLibraryStore((s) => s.requestAttach);
  const deleteText = useLibraryStore((s) => s.deleteText);
  const projects = useProjectStore((s) => s.projects);
  const projectsLoaded = useProjectStore((s) => s.projectsLoaded);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const [body, setBody] = useState<DocumentBody | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The failed reader action, replayed by the error banner's Retry. */
  const retryExportRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!projectsLoaded) void loadProjects();
  }, [projectsLoaded, loadProjects]);

  useEffect(() => {
    let cancelled = false;
    setBody(null);
    setLoadError(null);
    void loadTextContent(id)
      .then((loaded) => {
        if (!cancelled) setBody(loaded);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(readErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, loadTextContent]);

  /** Reload the document body (e.g. after a version restore or a failure). */
  const reloadContent = () => {
    setLoadError(null);
    setBody(null);
    void loadTextContent(id)
      .then((loaded) => setBody(loaded))
      .catch((err) => setLoadError(readErrorMessage(err)));
  };

  /**
   * Run a reader action with a visible failure state and a Retry that
   * repeats exactly the failed action (silent unhandled rejections hid
   * every export failure before).
   */
  const runExport = async (label: string, action: () => Promise<void>) => {
    setExportError(null);
    try {
      await action();
    } catch (err) {
      retryExportRef.current = () => void runExport(label, action);
      setExportError(
        `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  if (!meta) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-text-muted text-sm">This text no longer exists.</p>
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4 mr-1" />
          Back to library
        </Button>
      </div>
    );
  }

  /**
   * What the reader shows: markdown bodies render their source; rich
   * bodies render through the editor's own serializer (structure kept).
   */
  const displayMarkdown = body
    ? body.contentFormat === "markdown"
      ? body.content
      : markdownFromRich(body)
    : null;
  /** A rich body the canonical schema cannot open is shown with its raw
   * bytes preserved instead of the silent empty document. */
  const bodyProblem = useMemo(
    () => (body ? richBodyProblem(body) : null),
    [body],
  );

  /** The document's JSON tree, computed once: the reader notes list, the
   * source-reference report, and the DOCX heading check all read it. */
  const documentJson = useMemo(() => {
    if (!body || bodyProblem) return null;
    try {
      return body.contentFormat === "tiptap-json"
        ? (JSON.parse(body.content) as unknown)
        : (JSON.parse(richFromMarkdown(body.content)) as unknown);
    } catch {
      return null;
    }
  }, [body, bodyProblem]);

  /** Reader footnote list (B19): every note's text is inspectable in the
   * article itself instead of only through the marker's hover title. */
  const footnotes = useMemo(
    () => (documentJson ? collectFootnotesFromJson(documentJson) : []),
    [documentJson],
  );

  const handleCopy = async () => {
    if (displayMarkdown == null) return;
    await navigator.clipboard.writeText(displayMarkdown);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  const handleExport = async () => {
    if (displayMarkdown == null) return;
    await exportText(meta, displayMarkdown);
  };

  /** DOCX export (5.4c/5.4e, B19): supported structure + the bibliography
   * the CSL processor formats from the document's own citations AND
   * source-backed footnotes. When the document already carries a
   * bibliography section (inserted in the editor), the generated one is
   * not appended again. */
  const handleExportDocx = async () => {
    if (body == null) return;
    const problem = richBodyProblem(body);
    if (problem) throw new Error(problem);
    const { buildDocx, hasBibliographyHeading } = await import(
      "@/utils/docxExport"
    );
    const { formatBibliography, cslStyleInfo } = await import("@/utils/cslProcessor");
    const { useSourceStore } = await import("@/stores/sourceStore");
    const sources = useSourceStore.getState().sources;
    const cslStyle = useAppStore.getState().cslStyle;
    const styleInfo = cslStyleInfo(cslStyle);
    // References are collected from the JSON TREE: citation atoms and
    // source-backed footnote atoms alike (B19).
    const refs = documentJson ? collectSourceRefsFromJson(documentJson) : [];
    const missing = missingSourceIds(refs, sources);
    setExportNotice(
      missing.length > 0
        ? `Exported with ${missing.length} unresolved reference${
            missing.length === 1 ? "" : "s"
          }: the referenced source record${
            missing.length === 1 ? " does" : "s do"
          } not exist anymore, so ${
            missing.length === 1 ? "it was" : "they were"
          } skipped in the bibliography (the stored text was kept).`
        : null,
    );
    const bibliography = await formatBibliography(refs, sources, cslStyle);
    const buffer = await buildDocx({
      title: meta.title,
      body,
      bibliography,
      bibliographyTitle: styleInfo.sectionTitle,
      appendBibliography: documentJson
        ? !hasBibliographyHeading(documentJson, styleInfo.sectionTitle)
        : true,
    });
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: `${meta.title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60) || "document"}.docx`,
      filters: [{ name: "Word document", extensions: ["docx"] }],
    });
    if (!path) return;
    await writeFile(path, new Uint8Array(buffer));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border shrink-0 flex-wrap">
        <Button variant="ghost" size="icon-sm" onClick={onBack} title="Back to library" aria-label="Back to library">
          <ArrowLeft className="size-4 text-text-secondary" />
        </Button>
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-text-primary truncate">{meta.title}</span>
          <span className="shrink-0 px-2 py-0.5 rounded-full bg-surface-alt border border-border text-[11px] font-medium text-text-secondary">
            {textTypeLabel(meta.textType)}
          </span>
          {meta.projectId && (
            <span className="shrink-0 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/30 text-[11px] font-medium text-text-primary flex items-center gap-1 max-w-[200px]">
              <FolderOpen className="size-3 shrink-0" />
              <span className="truncate">
                {projects.find((p) => p.id === meta.projectId)?.title ?? "Project"}
              </span>
            </span>
          )}
          {meta.folder && (
            <span className="shrink-0 px-2 py-0.5 rounded-full bg-surface-alt border border-border text-[11px] font-medium text-text-secondary">
              {meta.folder}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon-sm" onClick={() => void runExport("Copy", handleCopy)} title={copied ? "Copied!" : "Copy text"} aria-label="Copy text">
            {copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4 text-text-secondary" />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => void runExport("Markdown export", handleExport)} title="Export as Markdown" aria-label="Export as Markdown">
            <Download className="size-4 text-text-secondary" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => void runExport("DOCX export", handleExportDocx)} title="Export as DOCX" aria-label="Export as DOCX">
            <FileDown className="size-4 text-text-secondary" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setHistoryOpen(true)} title="Version history" aria-label="Version history">
            <History className="size-4 text-text-secondary" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              requestAttach(id);
              setActiveTab("chat");
            }}
            title="Attach to the next chat message"
          >
            <BookOpenCheck className="size-4 mr-1 text-text-secondary" />
            Ask the chat
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onEdit(id)}>
            <Pencil className="size-4 mr-1 text-text-secondary" />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setConfirmDelete(true)}
            title="Delete text"
            aria-label="Delete text"
          >
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Failed reader/export action: visible, retryable. */}
      {exportError && (
        <div
          role="alert"
          className="flex items-center gap-3 px-6 py-2 border-b border-border bg-surface-alt text-xs text-text-secondary shrink-0"
        >
          <TriangleAlert className="size-4 shrink-0 text-warning" />
          <span className="flex-1">{exportError}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => retryExportRef.current?.()}
          >
            <RotateCcw className="size-3.5 mr-1" />
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setExportError(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {/* Non-fatal export report (B19): unresolved source references. */}
      {exportNotice && (
        <div
          role="status"
          className="flex items-center gap-3 px-6 py-2 border-b border-border bg-surface-alt text-xs text-text-secondary shrink-0"
        >
          <TriangleAlert className="size-4 shrink-0 text-warning" />
          <span className="flex-1">{exportNotice}</span>
          <Button size="sm" variant="ghost" onClick={() => setExportNotice(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {/* Document */}
      <div className="flex-1 overflow-y-auto">
        <article className="max-w-[768px] mx-auto px-6 py-8">
          {loadError ? (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-md border border-border bg-surface-alt p-3 text-xs text-text-secondary"
            >
              <TriangleAlert className="size-4 shrink-0 text-warning" />
              <span className="flex-1">{loadError}</span>
              <Button size="sm" variant="outline" onClick={reloadContent}>
                Retry
              </Button>
            </div>
          ) : bodyProblem ? (
            <BodyRecoveryState
              error={bodyProblem}
              raw={body?.content ?? ""}
              onRetry={reloadContent}
            />
          ) : displayMarkdown == null ? (
            <p className="text-text-muted text-sm">Loading…</p>
          ) : displayMarkdown.trim() ? (
            <div className="doc-markdown prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSourceAtoms]}
              >
                {displayMarkdown}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-text-muted text-sm italic">
              This text is empty. Use Edit to add content.
            </p>
          )}
          {/* Footnote list (B19): note text is inspectable in the reader,
              not only through the marker's hover title. */}
          {!bodyProblem && footnotes.length > 0 && (
            <section
              aria-label="Footnotes"
              className="mt-10 border-t border-border pt-4"
            >
              <h2 className="mb-2 text-sm font-semibold text-text-primary">
                Notes
              </h2>
              <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-text-secondary">
                {footnotes.map((note, i) => (
                  <li
                    key={note.id || `note-${i}`}
                    id={note.id ? `footnote-${note.id}` : undefined}
                    value={i + 1}
                  >
                    {note.text}
                  </li>
                ))}
              </ol>
            </section>
          )}
          <p className="mt-10 text-[11px] text-text-muted select-none">
            {meta.wordCount ?? 0} words · created {formatDate(meta.createdAt)} ·
            updated {formatDate(meta.updatedAt)}
          </p>
        </article>
      </div>

      {/* Delete confirmation */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{meta.title}”?</DialogTitle>
            <DialogDescription>
              This permanently deletes the text, including its version
              history. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                await deleteText(id);
                setConfirmDelete(false);
                onBack();
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <HistoryDialog
        id={id}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onRestored={reloadContent}
      />
    </div>
  );
}
