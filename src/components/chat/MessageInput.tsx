import { useRef, useCallback, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { BookMarked, Send, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTokenEstimate, TOKEN_WARN_THRESHOLD } from "@/utils/tokens";
import type { AttachedLibraryText } from "@/types";
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
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // While the AI is generating, the input is disabled and the send button
  // turns into a stop button.
  const isGenerating = !!onStop && disabled;

  const handleSend = useCallback(() => {
    if (!value.trim() || disabled) return;
    onSend();
  }, [value, disabled, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea (max 4 lines ≈ 4 * 1.5rem = 6rem ≈ 96px)
  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 96) + "px";
  }, []);

  return (
    <div className="border-t border-border bg-background">
      {/* Attached library texts */}
      {attachedTexts.length > 0 && (
        <div className="flex items-center gap-1.5 px-4 pt-3 flex-wrap">
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
        </div>
      )}

      <div className="flex items-end gap-2 p-4">
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
            requestAnimationFrame(handleInput);
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
                  ? "text-amber-500"
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
