import { useState } from "react";
import { useLibraryStore } from "@/stores/libraryStore";
import { exportTexts, importFiles } from "@/utils/libraryIo";
import { textTypeLabel, type LibraryTextMeta } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BookPlus,
  CheckSquare,
  Download,
  FileInput,
  FolderInput,
  Loader2,
  Search,
  Trash2,
  X,
} from "lucide-react";

type TypeFilter = "all" | (typeof TEXT_TYPE_IDS)[number];
type FolderFilter = "all" | "none" | string;

const TEXT_TYPE_IDS = [
  "essay",
  "article",
  "research-paper",
  "letter",
  "talk",
  "other",
] as const;

const TYPE_CHIP_LABELS: Record<TypeFilter, string> = {
  all: "All",
  essay: "Essays",
  article: "Articles",
  "research-paper": "Research papers",
  letter: "Letters",
  talk: "Talks",
  other: "Other",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function LibraryList({
  onOpen,
  onNew,
}: {
  onOpen: (id: string) => void;
  onNew: (prefill?: { content: string }) => void;
}) {
  const texts = useLibraryStore((s) => s.texts);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveFolder, setMoveFolder] = useState("");
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const folders = [
    ...new Set(
      texts.map((t) => t.folder).filter((f): f is string => !!f),
    ),
  ].sort();

  const filtered = texts.filter((t) => {
    if (
      search.trim() &&
      !`${t.title} ${t.snippet ?? ""}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
    ) {
      return false;
    }
    if (typeFilter !== "all" && t.textType !== typeFilter) return false;
    if (folderFilter === "none" && t.folder) return false;
    if (typeof folderFilter === "string" && folderFilter !== "all" && t.folder !== folderFilter) {
      return false;
    }
    return true;
  });

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const handleNew = async () => {
    // Paste-anywhere: if the clipboard holds text, open the editor
    // pre-filled with it. Falls back to an empty editor.
    try {
      const clip = await navigator.clipboard.readText();
      if (clip.trim()) {
        onNew({ content: clip });
        return;
      }
    } catch {
      // Clipboard unavailable — plain empty editor.
    }
    onNew();
  };

  const handleImport = async () => {
    setImporting(true);
    await importFiles(
      typeof folderFilter === "string" && folderFilter !== "all"
        ? folderFilter
        : undefined,
    );
    setImporting(false);
  };

  const handleDeleteSelected = async () => {
    for (const id of selected) {
      await useLibraryStore.getState().deleteText(id);
    }
    setConfirmDelete(false);
    exitSelection();
  };

  const handleExportSelected = async () => {
    setExporting(true);
    const store = useLibraryStore.getState();
    const items: { meta: LibraryTextMeta; content: string }[] = [];
    for (const id of selected) {
      const meta = store.texts.find((t) => t.id === id);
      if (meta) {
        items.push({ meta, content: await store.loadTextContent(id) });
      }
    }
    await exportTexts(items);
    setExporting(false);
    exitSelection();
  };

  const handleMoveSelected = async () => {
    const folder = moveFolder.trim();
    for (const id of selected) {
      await useLibraryStore.getState().updateText(id, { folder });
    }
    setMoveOpen(false);
    setMoveFolder("");
    exitSelection();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border shrink-0 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-text-muted pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search texts…"
            className="pl-8 bg-field h-9"
            aria-label="Search texts"
          />
        </div>
        <div className="flex items-center gap-2 ml-auto">
          {selecting ? (
            <Button variant="outline" size="sm" onClick={exitSelection}>
              <X className="size-4 mr-1" />
              Cancel
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelecting(true)}
              disabled={texts.length === 0}
            >
              <CheckSquare className="size-4 mr-1" />
              Select
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void handleImport()}>
            {importing ? (
              <Loader2 className="size-4 mr-1 animate-spin" />
            ) : (
              <FileInput className="size-4 mr-1" />
            )}
            Import
          </Button>
          <Button
            size="sm"
            className="bg-primary hover:bg-primary/80 text-primary-foreground"
            onClick={() => void handleNew()}
          >
            <BookPlus className="size-4 mr-1" />
            New text
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-1.5 px-6 py-2 border-b border-border shrink-0 flex-wrap">
        {(Object.keys(TYPE_CHIP_LABELS) as TypeFilter[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTypeFilter(id)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors select-none ${
              typeFilter === id
                ? "bg-primary text-primary-foreground"
                : "bg-surface text-text-secondary hover:bg-border hover:text-text-primary"
            }`}
          >
            {TYPE_CHIP_LABELS[id]}
          </button>
        ))}
        <span className="mx-2 h-4 w-px bg-border" aria-hidden="true" />
        <button
          type="button"
          onClick={() => setFolderFilter("all")}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors select-none flex items-center gap-1 ${
            folderFilter === "all"
              ? "bg-primary text-primary-foreground"
              : "bg-surface text-text-secondary hover:bg-border hover:text-text-primary"
          }`}
        >
          All folders
        </button>
        {folders.map((folder) => (
          <button
            key={folder}
            type="button"
            onClick={() => setFolderFilter(folder)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors select-none flex items-center gap-1 ${
              folderFilter === folder
                ? "bg-primary text-primary-foreground"
                : "bg-surface text-text-secondary hover:bg-border hover:text-text-primary"
            }`}
          >
            <FolderInput className="size-3" />
            {folder}
          </button>
        ))}
      </div>

      {/* Bulk action bar */}
      {selecting && selected.size > 0 && (
        <div className="flex items-center gap-2 px-6 py-2 border-b border-border bg-surface-alt shrink-0 flex-wrap">
          <span className="text-xs text-text-secondary mr-2">
            {selected.size} selected
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMoveOpen(true)}
          >
            <FolderInput className="size-4 mr-1" />
            Move to folder
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleExportSelected()}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="size-4 mr-1 animate-spin" />
            ) : (
              <Download className="size-4 mr-1" />
            )}
            Export
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive border-destructive/40 hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="size-4 mr-1" />
            Delete
          </Button>
        </div>
      )}

      {/* Cards */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-text-primary text-lg font-semibold">
              {texts.length === 0 ? "Your library is empty" : "No texts match"}
            </p>
            <p className="text-text-muted text-sm mt-2 max-w-md">
              {texts.length === 0
                ? "Save a text from the chat with the bookmark button, paste one in with New text, or import a file."
                : "Try a different search, type, or folder filter."}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 max-w-4xl mx-auto">
            {filtered.map((t) => (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => (selecting ? toggleSelected(t.id) : onOpen(t.id))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selecting ? toggleSelected(t.id) : onOpen(t.id);
                  }
                }}
                className="flex items-start gap-3 rounded-lg border border-border bg-surface px-5 py-4 cursor-pointer hover:border-primary/40 transition-colors text-left"
              >
                {selecting && (
                  <Checkbox
                    checked={selected.has(t.id)}
                    onCheckedChange={() => toggleSelected(t.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-1"
                    aria-label={`Select ${t.title}`}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-text-primary truncate max-w-full">
                      {t.title}
                    </span>
                    <span className="shrink-0 px-2 py-0.5 rounded-full bg-surface-alt border border-border text-[11px] font-medium text-text-secondary">
                      {textTypeLabel(t.textType)}
                    </span>
                    {t.folder && (
                      <span className="shrink-0 px-2 py-0.5 rounded-full bg-surface-alt border border-border text-[11px] font-medium text-text-secondary flex items-center gap-1">
                        <FolderInput className="size-3" />
                        {t.folder}
                      </span>
                    )}
                  </div>
                  {t.snippet && (
                    <p className="mt-1.5 text-sm text-text-secondary line-clamp-2 [font-family:var(--font-doc)]">
                      {t.snippet}
                    </p>
                  )}
                  <p className="mt-1.5 text-[11px] text-text-muted select-none">
                    {t.wordCount ?? 0} words · updated {formatDate(t.updatedAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {selected.size === 1 ? "text" : `${selected.size} texts`}?
            </DialogTitle>
            <DialogDescription>
              This permanently deletes the selected text
              {selected.size === 1 ? "" : "s"}, including version history. It
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteSelected()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move to folder */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to folder</DialogTitle>
            <DialogDescription>
              One level of organization. Leave empty to remove the selected
              text{selected.size === 1 ? "" : "s"} from any folder.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={moveFolder}
            onChange={(e) => setMoveFolder(e.target.value)}
            placeholder="Folder name…"
            list="library-folders"
            className="bg-field"
          />
          <datalist id="library-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/80 text-primary-foreground"
              onClick={() => void handleMoveSelected()}
            >
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
