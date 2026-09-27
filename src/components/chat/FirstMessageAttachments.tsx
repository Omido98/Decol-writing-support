import { useRef, type ChangeEvent } from "react";
import { BookMarked, Loader2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { UPLOAD_ACCEPT } from "@/utils/fileParse";
import AttachmentChips from "@/components/chat/AttachmentChips";
import type { AttachedLibraryText } from "@/types";
import type { FileAttachment } from "@/stores/chatStore";

interface FirstMessageAttachmentsProps {
  /** Library texts attached to the first message. */
  attachedTexts?: AttachedLibraryText[];
  /** Opens the attachment picker. */
  onOpenPicker?: () => void;
  /** Removes an attached library text. */
  onRemoveAttachment?: (id: string) => void;
  /** Extracted text of uploaded documents on the first message. */
  fileAttachments?: FileAttachment[];
  /** Handles chosen files (parse + attach). */
  onUploadFiles?: (files: FileList) => void;
  /** Removes an uploaded document by name. */
  onRemoveFileAttachment?: (name: string) => void;
  /** Whether an upload is currently being parsed. */
  uploadingFiles?: boolean;
  disabled?: boolean;
}

/**
 * Attachment controls for an empty thread: the user can pick library
 * texts and upload documents BEFORE the first message is sent. The
 * attachments live in the same per-thread slot the composer uses, so the
 * first send consumes them exactly like any later send.
 */
export default function FirstMessageAttachments({
  attachedTexts = [],
  onOpenPicker,
  onRemoveAttachment,
  fileAttachments = [],
  onUploadFiles,
  onRemoveFileAttachment,
  uploadingFiles = false,
  disabled = false,
}: FirstMessageAttachmentsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length && onUploadFiles) onUploadFiles(e.target.files);
    // Reset so choosing the same file again still fires a change event.
    e.target.value = "";
  };

  const hasChips = attachedTexts.length > 0 || fileAttachments.length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Label className="text-text-secondary text-xs">
          Texts and files for the first message (optional)
        </Label>
        <div className="flex items-center gap-1.5 shrink-0">
          {onUploadFiles && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={UPLOAD_ACCEPT}
                onChange={handleFileChange}
                className="hidden"
                aria-hidden="true"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || uploadingFiles}
                title="Upload Word, Excel, PDF, or text files"
              >
                {uploadingFiles ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Paperclip className="size-3.5" />
                )}
                Upload files
              </Button>
            </>
          )}
          {onOpenPicker && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenPicker}
              disabled={disabled}
              title="Attach a text from your library"
            >
              <BookMarked className="size-3.5" />
              Attach texts
            </Button>
          )}
        </div>
      </div>
      {hasChips && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <AttachmentChips
            attachedTexts={attachedTexts}
            onRemoveAttachment={onRemoveAttachment}
            fileAttachments={fileAttachments}
            onRemoveFileAttachment={onRemoveFileAttachment}
          />
        </div>
      )}
      <p className="text-xs text-text-muted">
        Included in the first message only — the chat never reads your library
        unless you attach it here.
      </p>
    </div>
  );
}
