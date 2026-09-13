import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useLibraryStore } from "@/stores/libraryStore";
import { useAppStore } from "@/stores/useAppStore";
import { exportText } from "@/utils/libraryIo";
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
  History,
  Pencil,
  Trash2,
} from "lucide-react";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const [content, setContent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    void loadTextContent(id).then((text) => {
      if (!cancelled) setContent(text);
    });
    return () => {
      cancelled = true;
    };
  }, [id, loadTextContent]);

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

  const handleCopy = async () => {
    if (content == null) return;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  const handleExport = async () => {
    if (content == null) return;
    await exportText(meta, content);
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
          {meta.folder && (
            <span className="shrink-0 px-2 py-0.5 rounded-full bg-surface-alt border border-border text-[11px] font-medium text-text-secondary">
              {meta.folder}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon-sm" onClick={() => void handleCopy()} title={copied ? "Copied!" : "Copy text"} aria-label="Copy text">
            {copied ? <Check className="size-4 text-green-400" /> : <Copy className="size-4 text-text-secondary" />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => void handleExport()} title="Export as Markdown" aria-label="Export as Markdown">
            <Download className="size-4 text-text-secondary" />
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

      {/* Document */}
      <div className="flex-1 overflow-y-auto">
        <article className="max-w-[768px] mx-auto px-6 py-8">
          {content == null ? (
            <p className="text-text-muted text-sm">Loading…</p>
          ) : content.trim() ? (
            <div className="doc-markdown prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-text-muted text-sm italic">
              This text is empty. Use Edit to add content.
            </p>
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
      />
    </div>
  );
}
