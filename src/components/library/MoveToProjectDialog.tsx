import { useEffect, useState } from "react";
import { useProjectStore } from "@/stores/projectStore";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FolderOpen } from "lucide-react";

/**
 * One move-to-project dialog for every surface: standalone and every
 * project are LISTED and picked (no drag across navigator areas — which
 * is deliberately not allowed — and no detour through the library list).
 */
export default function MoveToProjectDialog({
  open,
  onOpenChange,
  currentProjectId,
  onMove,
  itemLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current project of the target item(s); undefined = standalone. */
  currentProjectId?: string;
  /** Called with the chosen project (null = standalone). */
  onMove: (projectId: string | null) => void | Promise<void>;
  /** e.g. “Field notes” — rendered in the dialog description. */
  itemLabel?: string;
}) {
  const projects = useProjectStore((s) => s.projects);
  const [choice, setChoice] = useState<string | null>(
    currentProjectId ?? null,
  );
  const [busy, setBusy] = useState(false);

  // Seed the choice only when the dialog OPENS.
  useEffect(() => {
    if (!open) return;
    setChoice(currentProjectId ?? null);
    setBusy(false);
  }, [open, currentProjectId]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onMove(choice);
      onOpenChange(false);
    } catch {
      // The caller surfaces the failure; the dialog stays open for retry.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to project</DialogTitle>
          <DialogDescription>
            {itemLabel ? `“${itemLabel}” — ` : ""}documents in a project build
            on its brief and share its sources.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[260px] overflow-y-auto rounded-lg border border-border divide-y divide-border">
          <label className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-surface-alt transition-colors">
            <input
              type="radio"
              name="move-project"
              checked={choice === null}
              onChange={() => setChoice(null)}
              className="accent-primary"
            />
            <span className="text-text-primary">Standalone (no project)</span>
          </label>
          {projects.map((p) => (
            <label
              key={p.id}
              className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-surface-alt transition-colors"
            >
              <input
                type="radio"
                name="move-project"
                checked={choice === p.id}
                onChange={() => setChoice(p.id)}
                className="accent-primary"
              />
              <FolderOpen className="size-3.5 shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1 truncate text-text-primary">
                {p.title}
              </span>
            </label>
          ))}
          {projects.length === 0 && (
            <p className="px-3 py-3 text-xs text-text-muted text-center">
              No projects yet — create one from the navigator first.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-primary hover:bg-primary/80 text-primary-foreground"
            onClick={() => void confirm()}
            disabled={busy}
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
