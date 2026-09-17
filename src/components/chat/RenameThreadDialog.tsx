import { useEffect, useState } from "react";
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

interface RenameThreadDialogProps {
  /** The conversation being renamed; null keeps the dialog closed. */
  thread: { id: string; title: string } | null;
  onClose: () => void;
  /** Persists the new title. Empty/whitespace titles are ignored. */
  onRename: (id: string, title: string) => Promise<void>;
}

/**
 * The one rename surface for conversations: shared by the navigator rows
 * and the in-chat title, so both behave identically.
 */
export default function RenameThreadDialog({
  thread,
  onClose,
  onRename,
}: RenameThreadDialogProps) {
  const [title, setTitle] = useState(thread?.title ?? "");

  // A different conversation (or a fresh open) seeds the field from its
  // current title; edits are never carried between conversations.
  useEffect(() => {
    setTitle(thread?.title ?? "");
  }, [thread?.id, thread?.title]);

  const submit = () => {
    if (!thread) return;
    void onRename(thread.id, title).then(() => onClose());
  };

  return (
    <Dialog open={thread !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogDescription>
            Renaming does not touch the messages.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Conversation title"
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="bg-primary hover:bg-primary/80 text-primary-foreground"
            onClick={submit}
          >
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
