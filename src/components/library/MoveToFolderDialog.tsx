import { useEffect, useMemo, useState } from "react";
import { useFolderStore } from "@/stores/folderStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useChatStore } from "@/stores/chatStore";
import { useProjectStore } from "@/stores/projectStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FolderOpen, FolderPlus } from "lucide-react";

/** Every folder name of one area: registry rows (so empty folders are
 * offered) plus names present on its documents and conversations. */
export function useFolderNames(scope: string): string[] {
  const registryFolders = useFolderStore((s) => s.folders);
  const texts = useLibraryStore((s) => s.texts);
  const threads = useChatStore((s) => s.threads);
  const projects = useProjectStore((s) => s.projects);
  return useMemo(() => {
    const projectIds = new Set(projects.map((p) => p.id));
    const scopeOf = (projectId?: string) =>
      projectId && projectIds.has(projectId) ? projectId : "";
    const names = new Set<string>();
    for (const f of registryFolders) {
      if (f.scope === scope) names.add(f.name);
    }
    for (const t of texts) {
      const name = t.folder?.trim();
      if (name && scopeOf(t.projectId) === scope) names.add(name);
    }
    for (const t of threads) {
      const name = t.folder?.trim();
      if (name && scopeOf(t.projectId) === scope) names.add(name);
    }
    return [...names].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }, [registryFolders, texts, threads, projects, scope]);
}

/** Sentinel for the "New folder…" row (a typed name, not a choice). */
const NEW_FOLDER = "__new-folder__";

/**
 * One move-to-folder dialog for every surface (navigator, library bulk
 * bar, project page): existing folders are LISTED and picked, and a new
 * folder can be created inline — no free-text name to mistype.
 */
export default function MoveToFolderDialog({
  open,
  onOpenChange,
  scope,
  currentFolder,
  onMove,
  itemLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The area whose folders are offered ("" = standalone, or a project id). */
  scope: string;
  /** Current folder of the target item(s), if any. */
  currentFolder?: string;
  /** Called with the chosen folder (null = remove from any folder). */
  onMove: (folder: string | null) => void | Promise<void>;
  /** e.g. “Field notes” — rendered in the dialog description. */
  itemLabel?: string;
}) {
  const folders = useFolderNames(scope);
  const current = currentFolder?.trim() || null;
  const [choice, setChoice] = useState<string | null>(current);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  // Seed the choice only when the dialog OPENS.
  useEffect(() => {
    if (!open) return;
    setChoice(current);
    setNewName("");
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A legacy folder name not in the registry is still a valid choice.
  const options = useMemo(
    () =>
      current && !folders.includes(current)
        ? [...folders, current].sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "base" }),
          )
        : folders,
    [folders, current],
  );

  const creating = choice === NEW_FOLDER;
  const targetFolder = creating ? newName.trim() : choice;
  const canConfirm = !busy && (!creating || targetFolder);

  const confirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    try {
      if (creating && targetFolder) {
        // The folder must exist in the navigator before anything lands in
        // it, so an empty folder is visible and renamable there.
        await useFolderStore.getState().createFolder(scope, targetFolder);
      }
      await onMove(targetFolder ? targetFolder : null);
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
          <DialogTitle>Move to folder</DialogTitle>
          <DialogDescription>
            {itemLabel ? `“${itemLabel}” — ` : ""}pick a folder, or create a
            new one. Folders hold documents and conversations together.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[260px] overflow-y-auto rounded-lg border border-border divide-y divide-border">
          <label className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-surface-alt transition-colors">
            <input
              type="radio"
              name="move-folder"
              checked={choice === null}
              onChange={() => setChoice(null)}
              className="accent-primary"
            />
            <span className="text-text-primary">No folder</span>
            {current && (
              <span className="text-[11px] text-text-muted">
                (remove from “{current}”)
              </span>
            )}
          </label>
          {options.map((name) => (
            <label
              key={name}
              className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-surface-alt transition-colors"
            >
              <input
                type="radio"
                name="move-folder"
                checked={choice === name}
                onChange={() => setChoice(name)}
                className="accent-primary"
              />
              <FolderOpen className="size-3.5 shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1 truncate text-text-primary">
                {name}
              </span>
            </label>
          ))}
          {options.length === 0 && (
            <p className="px-3 py-3 text-xs text-text-muted text-center">
              No folders in this area yet.
            </p>
          )}
        </div>

        <label className="flex items-center gap-2.5 text-sm cursor-pointer">
          <input
            type="radio"
            name="move-folder"
            checked={creating}
            onChange={() => setChoice(NEW_FOLDER)}
            className="accent-primary"
          />
          <FolderPlus className="size-3.5 shrink-0 text-text-muted" />
          <span className="shrink-0 text-text-primary">New folder</span>
          <Input
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              setChoice(NEW_FOLDER);
            }}
            onFocus={() => setChoice(NEW_FOLDER)}
            placeholder="Folder name…"
            aria-label="New folder name"
            className="h-8 bg-field flex-1"
          />
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-primary hover:bg-primary/80 text-primary-foreground"
            onClick={() => void confirm()}
            disabled={!canConfirm}
          >
            {choice === null && current ? "Remove from folder" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
