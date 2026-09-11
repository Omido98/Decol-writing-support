import { useEffect, useState } from "react";
import { useLibraryStore } from "@/stores/libraryStore";
import { textTypeLabel } from "@/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FolderInput, Search } from "lucide-react";

export default function AttachmentPicker({
  open,
  onOpenChange,
  selectedIds,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Attachment ids already on the message. */
  selectedIds: string[];
  /** Called with the full selection when the user confirms. */
  onConfirm: (ids: string[]) => void;
}) {
  const texts = useLibraryStore((s) => s.texts);
  const textsLoaded = useLibraryStore((s) => s.textsLoaded);
  const loadTexts = useLibraryStore((s) => s.loadTexts);

  const [draft, setDraft] = useState<Set<string>>(new Set(selectedIds));
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(new Set(selectedIds));
    setSearch("");
    if (!textsLoaded) void loadTexts();
    // selectedIds only seeds the draft when the picker opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, textsLoaded, loadTexts]);

  const filtered = texts.filter((t) =>
    search.trim()
      ? t.title.toLowerCase().includes(search.trim().toLowerCase())
      : true,
  );

  const toggle = (id: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Attach library texts</DialogTitle>
          <DialogDescription>
            Attached texts are included in the next message only — the chat
            never reads your library unless you attach it here.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-text-muted pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search texts…"
            aria-label="Search library texts"
            className="w-full rounded-md border border-border bg-field px-8 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-primary/50"
          />
        </div>

        <div className="max-h-[300px] overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {textsLoaded && texts.length === 0 ? (
            <p className="text-sm text-text-muted px-4 py-6 text-center">
              Your library is empty. Save texts from the chat or add them in
              the Library tab first.
            </p>
          ) : (
            filtered.map((t) => (
              <label
                key={t.id}
                className="flex items-center gap-3 px-4 py-2.5 text-sm cursor-pointer hover:bg-surface-alt transition-colors"
              >
                <Checkbox
                  checked={draft.has(t.id)}
                  onCheckedChange={() => toggle(t.id)}
                />
                <span className="min-w-0 flex-1 truncate text-text-primary">
                  {t.title}
                </span>
                <span className="shrink-0 text-[11px] text-text-muted flex items-center gap-1">
                  {t.folder && <FolderInput className="size-3" />}
                  {t.folder ? `${t.folder} · ` : ""}
                  {textTypeLabel(t.textType)}
                </span>
              </label>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-primary hover:bg-primary/80 text-primary-foreground"
            onClick={() => {
              onConfirm([...draft]);
              onOpenChange(false);
            }}
          >
            Attach {draft.size > 0 ? `(${draft.size})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
