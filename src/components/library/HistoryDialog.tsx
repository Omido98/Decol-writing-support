import { useEffect, useState } from "react";
import { useLibraryStore } from "@/stores/libraryStore";
import { wordCount } from "@/utils/tokens";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { History, RotateCcw } from "lucide-react";

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
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const loadVersions = useLibraryStore((s) => s.loadVersions);
  const restoreVersion = useLibraryStore((s) => s.restoreVersion);

  const [versions, setVersions] = useState<
    { savedAt: string; content: string }[]
  >([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSelected(null);
    void loadVersions(id).then((v) => {
      if (!cancelled) setVersions(v);
    });
    return () => {
      cancelled = true;
    };
  }, [id, open, loadVersions]);

  const selectedVersion = versions.find((v) => v.savedAt === selected) ?? null;

  const handleRestore = async () => {
    if (!selected || restoring) return;
    setRestoring(true);
    await restoreVersion(id, selected);
    setRestoring(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
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
                key={v.savedAt}
                type="button"
                onClick={() => setSelected(v.savedAt)}
                className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center justify-between gap-3 ${
                  selected === v.savedAt
                    ? "bg-selection text-text-primary"
                    : "hover:bg-surface-alt text-text-secondary"
                }`}
              >
                <span>{formatDateTime(v.savedAt)}</span>
                <span className="text-[11px] text-text-muted shrink-0">
                  {wordCount(v.content)} words
                </span>
              </button>
            ))
          )}
        </div>

        {selectedVersion && (
          <div className="rounded-lg border border-border bg-surface-alt p-3 max-h-[200px] overflow-y-auto">
            <p className="text-xs [font-family:var(--font-doc)] leading-relaxed whitespace-pre-wrap text-text-secondary">
              {selectedVersion.content.slice(0, 2000)}
              {selectedVersion.content.length > 2000 ? "…" : ""}
            </p>
          </div>
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
