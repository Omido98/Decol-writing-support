import { useEffect, useState } from "react";
import { useLibraryStore } from "@/stores/libraryStore";
import { useDraftStore } from "@/stores/draftStore";
import { wordCount } from "@/utils/tokens";
import { displayTextFromBody } from "@/utils/documentCodec";
import type { TextVersion } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Camera, History, RotateCcw, TriangleAlert } from "lucide-react";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function HistoryDialog({
  id,
  open,
  onOpenChange,
  onRestored,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a version was restored, so views holding the document
   * content can reload it (the reader keeps its own copy). */
  onRestored?: () => void;
}) {
  const loadVersions = useLibraryStore((s) => s.loadVersions);
  const restoreVersion = useLibraryStore((s) => s.restoreVersion);
  /** A dirty recovery draft would be discarded by a restore: say so. */
  const dirtyDraft = useDraftStore((s) => {
    const draft = s.drafts[`text:${id}`];
    return draft && draft.savedAt == null ? draft : null;
  });

  const [versions, setVersions] = useState<TextVersion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [snapshotting, setSnapshotting] = useState(false);

  const refreshVersions = () => {
    void loadVersions(id).then((v) => setVersions(v));
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSelected(null);
    setSnapshotLabel("");
    void loadVersions(id).then((v) => {
      if (!cancelled) setVersions(v);
    });
    return () => {
      cancelled = true;
    };
  }, [id, open, loadVersions]);

  const handleSnapshot = async () => {
    if (snapshotting) return;
    setSnapshotting(true);
    try {
      await useLibraryStore.getState().createSnapshot(id, snapshotLabel);
      setSnapshotLabel("");
      refreshVersions();
    } finally {
      setSnapshotting(false);
    }
  };

  const selectedVersion = versions.find((v) => v.versionId === selected) ?? null;
  const selectedDisplay = selectedVersion ? displayTextFromBody(selectedVersion.body) : null;

  const handleRestore = async () => {
    if (!selected || restoring) return;
    setRestoring(true);
    try {
      await restoreVersion(id, selected);
      onRestored?.();
    } finally {
      setRestoring(false);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4 text-text-secondary" />
            Version history
          </DialogTitle>
          <DialogDescription>
            A snapshot is taken every time content is saved (up to 20).
            Restoring snapshots the current version first, so you can always
            step back.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[280px] overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {versions.length === 0 ? (
            <p className="text-sm text-text-muted px-4 py-6 text-center">
              No versions yet — they appear after the first content change.
            </p>
          ) : (
            versions.map((v) => (
              <button
                key={v.versionId}
                type="button"
                onClick={() => setSelected(v.versionId)}
                className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center justify-between gap-3 ${
                  selected === v.versionId
                    ? "bg-selection text-text-primary"
                    : "hover:bg-surface-alt text-text-secondary"
                }`}
              >
                <span className="min-w-0 truncate">
                  {v.label && (
                    <span className="inline-flex items-center gap-1 mr-2 px-1.5 py-0.5 rounded bg-primary/10 border border-primary/30 text-[10px] text-text-primary align-middle">
                      <Camera className="size-2.5" />
                      {v.label}
                    </span>
                  )}
                  {formatDateTime(v.savedAt)}
                </span>
                <span className="text-[11px] text-text-muted shrink-0">
                  {wordCount(displayTextFromBody(v.body))} words
                </span>
              </button>
            ))
          )}
        </div>

        {selectedVersion && selectedDisplay != null && (
          <div className="rounded-lg border border-border bg-surface-alt p-3 max-h-[200px] overflow-y-auto">
            <p className="text-xs [font-family:var(--font-doc)] leading-relaxed whitespace-pre-wrap text-text-secondary">
              {selectedDisplay.slice(0, 2000)}
              {selectedDisplay.length > 2000 ? "…" : ""}
            </p>
          </div>
        )}

        {/* Named snapshot: capture the current content with a label. */}
        <div className="flex items-center gap-2">
          <Input
            value={snapshotLabel}
            onChange={(e) => setSnapshotLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSnapshot();
              }
            }}
            placeholder="Snapshot name (e.g. submitted draft)…"
            className="h-8 bg-field flex-1"
            aria-label="Snapshot name"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleSnapshot()}
            disabled={snapshotting}
          >
            <Camera className="size-3.5 mr-1" />
            {snapshotting ? "Snapshotting…" : "Save snapshot"}
          </Button>
        </div>

        {dirtyDraft && (
          <p
            role="status"
            className="text-[11px] text-warning flex items-start gap-1.5"
          >
            <TriangleAlert className="size-3.5 shrink-0 mt-0.5" />
            <span>
              This text has unsaved edits. Restoring a version discards
              them; the version being replaced is snapshotted first.
            </span>
          </p>
        )}

        <div className="flex justify-end">
          <Button
            size="sm"
            className="bg-primary hover:bg-primary/80 text-primary-foreground"
            onClick={() => void handleRestore()}
            disabled={!selected || restoring}
          >
            <RotateCcw className="size-4 mr-1" />
            {restoring ? "Restoring…" : "Restore version"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
