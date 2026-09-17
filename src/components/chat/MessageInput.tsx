import { useEffect, useRef, useCallback, type ChangeEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { BookMarked, FileText, FolderOpen, Globe, Loader2, Paperclip, Send, Square, Telescope, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTokenEstimate, TOKEN_WARN_THRESHOLD } from "@/utils/tokens";
import { UPLOAD_ACCEPT } from "@/utils/fileParse";
import type { AttachedLibraryText } from "@/types";
import type { FileAttachment } from "@/stores/chatStore";
import { textTypeLabel } from "@/types";

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  disabled?: boolean;
  /** Estimated input tokens the next send would consume (0 = unknown). */
  tokenEstimate?: number;
  /** Library texts attached to the next send. */
  attachedTexts?: AttachedLibraryText[];
  /** Opens the attachment picker. */
  onOpenPicker?: () => void;
  /** Removes an attached library text. */
  onRemoveAttachment?: (id: string) => void;
  /** Extracted text of uploaded documents on the next send. */
  fileAttachments?: FileAttachment[];
  /** Handles chosen files (parse + attach). */
  onUploadFiles?: (files: FileList) => void;
  /** Removes an uploaded document by name. */
  onRemoveFileAttachment?: (name: string) => void;
  /** Whether an upload is currently being parsed. */
  uploadingFiles?: boolean;
  /** The project this thread writes in, when any. */
  projectTitle?: string | null;
  /** Whether the project brief is included in the next send. */
  projectBriefIncluded?: boolean;
  /** Toggles project brief inclusion. */
  onToggleProjectBrief?: () => void;
  /** Whether web search is enabled for the next send. */
  webSearchEnabled?: boolean;
  /** Whether deep research is enabled for the next send. */
  deepResearchEnabled?: boolean;
  /** Toggles web search (applies to the next sends). */
  onToggleWebSearch?: () => void;
  /** Toggles deep research (applies to the next sends). */
  onToggleDeepResearch?: () => void;
}

export default function MessageInput({
  value,
  onChange,
  onSend,
  onStop,
  disabled = false,
  tokenEstimate = 0,
  attachedTexts = [],
  onOpenPicker,
  onRemoveAttachment,
  fileAttachments = [],
  onUploadFiles,
  onRemoveFileAttachment,
  uploadingFiles = false,
  projectTitle = null,
  projectBriefIncluded = true,
  onToggleProjectBrief,
  webSearchEnabled = true,
  deepResearchEnabled = false,
  onToggleWebSearch,
  onToggleDeepResearch,
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // While the AI is generating, the input is disabled and the send button
  // turns into a stop button.
  const isGenerating = !!onStop && disabled;

  const handleSend = useCallback(() => {
    if (!value.trim() || disabled) return;
    onSend();
  }, [value, disabled, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition (CJK input, diacritic toolbars): Enter confirms the
    // composition, it must NEVER send the message prematurely. The
    // compositionend event re-fires nothing; the next bare Enter sends.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length && onUploadFiles) onUploadFiles(e.target.files);
    // Reset so choosing the same file again still fires a change event.
    e.target.value = "";
  };

  // Auto-resize textarea (max 4 lines ≈ 4 * 1.5rem = 6rem ≈ 96px)
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 96) + "px";
  }, []);

  // The draft can change PROGRAMMATICALLY (thread switch restores a saved
  // draft, a send clears the input) without an onChange event — resize for
  // the new value, and shrink back when it becomes empty.
  useEffect(() => {
    autoResize();
  }, [value, autoResize]);

  const showToggles = !!onToggleWebSearch && !!onToggleDeepResearch;
  const hasChips =
    projectTitle != null ||
    attachedTexts.length > 0 ||
    fileAttachments.length > 0 ||
    showToggles;

  return (
    <div className="border-t border-border bg-background">
      {/* Agent toggles + project brief toggle + attached contexts */}
      {hasChips && (
        <div className="flex items-center gap-1.5 px-4 pt-3 flex-wrap">
          {onToggleWebSearch && (
            <button
              type="button"
              onClick={onToggleWebSearch}
              disabled={disabled}
              aria-pressed={webSearchEnabled}
              title={
                webSearchEnabled
                  ? "Web search is ON: the agent may search the web and fetch pages to check facts. Click to turn it off."
                  : "Web search is OFF: the agent answers without web tools. Click to turn it on (one search and up to 5 pages per turn)."
              }
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
                webSearchEnabled
                  ? "bg-primary/10 border-primary/40 text-text-primary"
                  : "bg-surface border-border text-text-muted",
              )}
            >
              <Globe
                className={cn(
                  "size-3 shrink-0",
                  webSearchEnabled ? "text-primary" : "text-text-muted",
                )}
              />
              Web search
            </button>
          )}
          {onToggleDeepResearch && (
            <button
              type="button"
              onClick={onToggleDeepResearch}
              disabled={disabled}
              aria-pressed={deepResearchEnabled}
              title={
                deepResearchEnabled
                  ? "Deep research is ON: multiple searches and many page fetches until key claims are verified (slower, more tokens). Click to turn it off."
                  : "Deep research is OFF. Click to research thoroughly: multiple searches with varied queries and many page fetches. Needs web search."
              }
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
                deepResearchEnabled
                  ? "bg-primary/10 border-primary/40 text-text-primary"
                  : "bg-surface border-border text-text-muted",
              )}
            >
              <Telescope
                className={cn(
                  "size-3 shrink-0",
                  deepResearchEnabled ? "text-primary" : "text-text-muted",
                )}
              />
              Deep research
            </button>
          )}
          {projectTitle != null && onToggleProjectBrief && (
            <button
              type="button"
              onClick={onToggleProjectBrief}
              disabled={disabled}
              title={
                projectBriefIncluded
                  ? "Project brief is included in the next send. Click to exclude it."
                  : "Project brief is excluded. Click to include it."
              }
              className={cn(
                "flex items-center gap-1.5 rounded-full border pl-2.5 pr-1 py-1 text-xs max-w-[280px] transition-colors disabled:opacity-50",
                projectBriefIncluded
                  ? "bg-primary/10 border-primary/40 text-text-primary"
                  : "bg-surface border-border text-text-muted line-through",
              )}
            >
              <FolderOpen
                className={cn(
                  "size-3 shrink-0",
                  projectBriefIncluded ? "text-primary" : "text-text-muted",
                )}
              />
              <span className="truncate">Brief: {projectTitle}</span>
              {!projectBriefIncluded && <X className="size-3 shrink-0" />}
            </button>
          )}
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
        </div>
      )}

      <div className="flex items-end gap-2 p-4">
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
              variant="outline"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || uploadingFiles}
              title="Upload Word or Excel files"
              aria-label="Upload Word or Excel files"
              className="shrink-0"
            >
              {uploadingFiles ? (
                <Loader2 className="size-4 animate-spin text-text-secondary" />
              ) : (
                <Paperclip className="size-4 text-text-secondary" />
              )}
            </Button>
          </>
        )}
        {onOpenPicker && (
          <Button
            variant="outline"
            size="icon"
            onClick={onOpenPicker}
            disabled={disabled}
            title="Attach library texts"
            aria-label="Attach library texts"
            className="shrink-0"
          >
            <BookMarked className="size-4 text-text-secondary" />
          </Button>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            // Defer height reset to ensure DOM is updated
            requestAnimationFrame(autoResize);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type your message… (Enter to send, Shift+Enter for new line)"
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none rounded-lg border border-border bg-field text-text-primary px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-primary/50 placeholder:text-text-muted disabled:opacity-50 max-h-[96px] hover:border-primary/30"
        />
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Button
            onClick={isGenerating ? onStop : handleSend}
            disabled={!isGenerating && !value.trim()}
            size="icon"
            className={
              isGenerating
                ? "bg-destructive hover:bg-destructive/80 text-white"
                : "bg-primary hover:bg-primary/80 text-primary-foreground"
            }
            aria-label={isGenerating ? "Stop generating" : "Send message"}
            title={isGenerating ? "Stop generating" : "Send message"}
          >
            {isGenerating ? (
              <Square className="size-4 fill-current" />
            ) : (
              <Send className="size-4" />
            )}
          </Button>
          {tokenEstimate > 0 && (
            <span
              className={cn(
                "text-[10px] leading-none select-none font-mono",
                tokenEstimate > TOKEN_WARN_THRESHOLD
                  ? "text-warning"
                  : "text-text-muted",
              )}
              title="Estimated input tokens for this request"
            >
              {formatTokenEstimate(tokenEstimate)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
