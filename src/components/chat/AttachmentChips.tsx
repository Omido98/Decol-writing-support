import { BookMarked, FileText, X } from "lucide-react";
import { textTypeLabel, type AttachedLibraryText } from "@/types";
import type { FileAttachment } from "@/stores/chatStore";

interface AttachmentChipsProps {
  /** Library texts attached to the next send. */
  attachedTexts?: AttachedLibraryText[];
  /** Removes an attached library text. */
  onRemoveAttachment?: (id: string) => void;
  /** Extracted text of uploaded documents on the next send. */
  fileAttachments?: FileAttachment[];
  /** Removes an uploaded document by name. */
  onRemoveFileAttachment?: (name: string) => void;
}

/**
 * The pending-attachment chips (library texts and uploaded documents)
 * shared by the composer and the empty-thread start panels.
 */
export default function AttachmentChips({
  attachedTexts = [],
  onRemoveAttachment,
  fileAttachments = [],
  onRemoveFileAttachment,
}: AttachmentChipsProps) {
  return (
    <>
      {attachedTexts.map((t) => (
        <span
          key={t.id}
          className="flex items-center gap-1.5 rounded-full bg-surface border border-border pl-2.5 pr-1 py-1 text-xs text-text-secondary max-w-[280px]"
        >
          <BookMarked className="size-3 shrink-0 text-primary" />
          <span className="truncate text-text-primary" title={t.title}>
            {t.title}
          </span>
          <span className="shrink-0 text-text-muted">
            {textTypeLabel(t.textType)}
          </span>
          {onRemoveAttachment && (
            <button
              type="button"
              onClick={() => onRemoveAttachment(t.id)}
              className="shrink-0 rounded-full p-0.5 hover:bg-border transition-colors"
              title={`Detach ${t.title}`}
              aria-label={`Detach ${t.title}`}
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {fileAttachments.map((f) => (
        <span
          key={f.name}
          className="flex items-center gap-1.5 rounded-full bg-surface border border-border pl-2.5 pr-1 py-1 text-xs text-text-secondary max-w-[280px]"
        >
          <FileText className="size-3 shrink-0 text-primary" />
          <span className="truncate text-text-primary" title={f.name}>
            {f.name}
          </span>
          <span className="shrink-0 text-text-muted">
            {(f.wordCount ?? 0).toLocaleString()} words
          </span>
          {onRemoveFileAttachment && (
            <button
              type="button"
              onClick={() => onRemoveFileAttachment(f.name)}
              className="shrink-0 rounded-full p-0.5 hover:bg-border transition-colors"
              title={`Remove ${f.name}`}
              aria-label={`Remove ${f.name}`}
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
    </>
  );
}
