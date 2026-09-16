import { useCallback } from "react";
import { useChatStore, type FileAttachment } from "@/stores/chatStore";
import { usePreparedPreview } from "@/components/chat/usePreparedPreview";
import WhatWillBeSent from "@/components/chat/WhatWillBeSent";
import MessageInput from "@/components/chat/MessageInput";
import type { AttachedLibraryText } from "@/types";
import { cn } from "@/lib/utils";

interface ChatComposerProps {
  /** Sends the current draft (the composer owns the draft text). */
  onSend: (text: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  /** Narrow inspector styling for the manifest panel. */
  compact?: boolean;
  /** Library texts attached to the next send. */
  attachedTexts?: AttachedLibraryText[];
  onOpenPicker?: () => void;
  onRemoveAttachment?: (id: string) => void;
  /** Extracted text of uploaded documents on the next send. */
  fileAttachments?: FileAttachment[];
  onUploadFiles?: (files: FileList) => void;
  onRemoveFileAttachment?: (name: string) => void;
  uploadingFiles?: boolean;
  projectTitle?: string | null;
  projectBriefIncluded?: boolean;
  onToggleProjectBrief?: () => void;
}

/**
 * The chat input surface: draft state, the prepared-request manifest, and
 * the send pipeline's UI. The draft subscription lives HERE (not in the
 * tab) so typing re-renders only this subtree — never the message list,
 * which is expensive to re-render as a conversation grows.
 */
export default function ChatComposer({
  onSend,
  onStop,
  disabled = false,
  compact = false,
  attachedTexts,
  onOpenPicker,
  onRemoveAttachment,
  fileAttachments,
  onUploadFiles,
  onRemoveFileAttachment,
  uploadingFiles,
  projectTitle,
  projectBriefIncluded,
  onToggleProjectBrief,
}: ChatComposerProps) {
  const value = useChatStore((s) => s.drafts[s.activeThreadId ?? ""] ?? "");
  const setDraft = useChatStore((s) => s.setDraft);
  // The manifest and the send share ONE prepared request (B14). The
  // compile is debounced inside the hook so a keystroke never walks the
  // whole history + sources.
  const previewContext = usePreparedPreview();

  const handleSend = useCallback(() => {
    onSend(value);
  }, [onSend, value]);

  return (
    <>
      {previewContext && (
        <details
          className={cn("shrink-0", compact ? "px-3 border-t border-border" : "px-4 sm:px-6")}
        >
          <summary
            className={cn(
              "cursor-pointer select-none text-text-muted hover:text-text-secondary",
              compact ? "py-1 text-[10px]" : "text-[11px]",
            )}
          >
            What will be sent? ≈ {previewContext.tokenEstimate.toLocaleString()} tokens
          </summary>
          <div
            className={cn(
              "rounded-lg border border-border bg-surface-alt",
              compact ? "mb-2 p-2" : "mt-2 mb-2 p-3",
            )}
          >
            <WhatWillBeSent compiled={previewContext} />
          </div>
        </details>
      )}
      <MessageInput
        value={value}
        onChange={setDraft}
        onSend={handleSend}
        onStop={onStop}
        disabled={disabled}
        tokenEstimate={previewContext?.tokenEstimate ?? 0}
        attachedTexts={attachedTexts}
        onOpenPicker={onOpenPicker}
        onRemoveAttachment={onRemoveAttachment}
        fileAttachments={fileAttachments}
        onUploadFiles={onUploadFiles}
        onRemoveFileAttachment={onRemoveFileAttachment}
        uploadingFiles={uploadingFiles}
        projectTitle={projectTitle}
        projectBriefIncluded={projectBriefIncluded}
        onToggleProjectBrief={onToggleProjectBrief}
      />
    </>
  );
}
