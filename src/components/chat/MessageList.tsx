import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useChatStore, messageKey } from "@/stores/chatStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { cleanupMessage } from "@/services/chatSend";
import { useThreadFailedSends, useThreadOperation } from "@/components/chat/useThreadOperation";
import { cn } from "@/lib/utils";
import {
  Copy,
  Check,
  ArrowDown,
  RotateCcw,
  RefreshCw,
  Sparkles,
  Loader2,
  BookmarkPlus,
  FileText,
  FolderOpen,
  TriangleAlert,
} from "lucide-react";

function LoadingDots() {
  return (
    <div
      role="status"
      aria-label="Generating answer"
      className="flex items-center gap-1.5 px-4 py-3"
    >
      <span className="size-2 rounded-full bg-text-muted animate-bounce [animation-delay:0ms]" />
      <span className="size-2 rounded-full bg-text-muted animate-bounce [animation-delay:150ms]" />
      <span className="size-2 rounded-full bg-text-muted animate-bounce [animation-delay:300ms]" />
    </div>
  );
}

/**
 * Markdown images are rendered as their alt text + link, NOT as <img>:
 * rendering model-supplied markdown would make the webview fetch external
 * images automatically — a network call that bypasses every research/
 * network control the app enforces elsewhere.
 */
function MarkdownImage(props: { src?: string; alt?: string }) {
  const alt = props.alt?.trim() || "image";
  if (!props.src) return <span>{alt}</span>;
  return (
    <a
      href={props.src}
      target="_blank"
      rel="noreferrer noopener"
      className="text-primary underline break-all"
    >
      {alt} (external image — open link)
    </a>
  );
}

export default function MessageList({
  onResend,
  onRegenerate,
  saveToProjectId,
  onSaveAsBrief,
}: {
  /** Re-send a failed user message in place (no duplicate is created). */
  onResend?: (key: string) => void;
  /** Regenerate the latest assistant message, replacing it in place. */
  onRegenerate?: (key: string) => void;
  /** Project that "Save to Library" should file texts into, when any. */
  saveToProjectId?: string | null;
  /** Save an assistant reply as the linked project's brief (project threads).
   * The flash confirmation waits for the returned promise. */
  onSaveAsBrief?: (content: string) => void | Promise<void>;
}) {
  const messages = useChatStore((s) => s.messages);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const error = useChatStore((s) => s.error);
  // The OWNER's running operation drives every busy/streaming affordance:
  // another conversation's request never shows a spinner here, and this
  // conversation's buffer is rendered directly (navigation-independent).
  const operation = useThreadOperation(activeThreadId);
  const failedSends = useThreadFailedSends(activeThreadId);
  const busy = !!operation;
  const streamingOutput =
    operation && operation.type !== "cleanup" ? operation.output : "";
  // Fresh/retry failures are retained by the service; the overlay makes
  // them visible even when the store's message was never flagged (failure
  // landed while the owner was hidden).
  const failedKeys = new Set(failedSends.map((f) => f.messageKey));

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<{ role: "user" | "assistant"; timestamp: string } | null>(
    null,
  );
  const [stickyToBottom, setStickyToBottom] = useState(true);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [briefSavedId, setBriefSavedId] = useState<string | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-scroll to the bottom only while the user is already near the bottom,
  // so scrolling up to read is never hijacked — even during live streaming.
  // A newly sent user message always jumps to the bottom.
  useEffect(() => {
    const last = messages[messages.length - 1] ?? null;
    const isNewUserMessage =
      last?.role === "user" && lastMessageRef.current?.timestamp !== last.timestamp;
    lastMessageRef.current = last;

    if (isNewUserMessage || stickyToBottom) {
      bottomRef.current?.scrollIntoView({
        behavior: busy ? "auto" : "smooth",
      });
    }
  }, [messages, busy, streamingOutput, stickyToBottom]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    setStickyToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  const jumpToBottom = () => {
    setStickyToBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  };

  useEffect(() => {
    return () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    };
  }, []);

  const flashFeedback = (id: string, setter: (v: string | null) => void) => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setter(id);
    feedbackTimer.current = setTimeout(() => {
      setter(null);
      feedbackTimer.current = null;
    }, 1500);
  };

  const handleCopy = async (msgId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      // Clipboard unavailable — fall back to a textarea selection trick
      const ta = document.createElement("textarea");
      ta.value = content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    flashFeedback(msgId, setCopiedId);
  };

  const handleSaveToLibrary = async (msgId: string, content: string) => {
    if (!content.trim()) return;
    const chat = useChatStore.getState();
    const threadTitle = chat.threads.find((t) => t.id === chat.activeThreadId)
      ?.title;
    await useLibraryStore.getState().createText({
      title:
        threadTitle && threadTitle !== "Untitled conversation"
          ? threadTitle
          : "Saved from chat",
      // A conversation with a writing brief preserves its text type.
      textType: chat.brief?.textType ?? "other",
      ...(saveToProjectId ? { projectId: saveToProjectId } : {}),
      content,
    });
    flashFeedback(msgId, setSavedId);
  };

  const handleSaveAsBrief = async (msgId: string, content: string) => {
    if (!content.trim() || !onSaveAsBrief) return;
    // Wait for the brief to actually land before confirming.
    await onSaveAsBrief(content);
    flashFeedback(msgId, setBriefSavedId);
  };

  // Cleanup runs in the SHARED service: its admission guard makes a
  // duplicate cleanup impossible across full and compact surfaces, and
  // its abort signal cancels the request.
  const handleDeslop = (key: string) => {
    void cleanupMessage(key);
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
    >
      {messages.map((msg) => {
        const isUser = msg.role === "user";
        const key = messageKey(msg);
        const failed = isUser && (msg.failed === true || failedKeys.has(key));
        const cleanupPending =
          operation?.type === "cleanup" &&
          operation.targetMessageId !== null &&
          operation.targetMessageId === (msg.id ?? null);
        const feedback =
          copiedId === key
            ? "copied"
            : savedId === key
              ? "saved"
              : briefSavedId === key
                ? "brief saved"
                : null;
        return (
          <div
            key={key}
            className={cn(
              "flex",
              isUser ? "justify-end" : "justify-start",
            )}
          >
            {failed && (
              <div className="flex flex-col gap-1 pr-2 justify-start">
                <button
                  type="button"
                  onClick={() => onResend?.(key)}
                  disabled={busy}
                  className="text-destructive hover:text-destructive/80 transition-colors disabled:opacity-50"
                  title="Re-send message"
                  aria-label="Re-send message"
                >
                  <RotateCcw className="size-3.5" />
                </button>
              </div>
            )}

            <div
              className={cn(
                "whitespace-pre-wrap break-words",
                isUser
                  ? "max-w-[80%] rounded-lg px-4 py-3 text-sm leading-relaxed bg-primary text-primary-foreground"
                  : "max-w-[75ch] rounded-lg bg-surface text-text-primary border border-border px-4 py-3",
              )}
            >
              {isUser ? (
                <>
                  {msg.fileAttachments && msg.fileAttachments.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {msg.fileAttachments.map((f) => (
                        <span
                          key={f.name}
                          className="flex items-center gap-1 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[11px]"
                        >
                          <FileText className="size-3" />
                          {f.name}
                        </span>
                      ))}
                    </div>
                  )}
                  <p>{msg.content}</p>
                </>
              ) : (
                <>
                  <div className="chat-markdown prose prose-sm max-w-none dark:prose-invert">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: MarkdownImage }}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                  {msg.incomplete && (
                    <p
                      role="status"
                      className="mt-2 flex items-start gap-1.5 text-xs text-warning"
                    >
                      <TriangleAlert className="size-3.5 shrink-0 mt-0.5" />
                      {msg.incomplete === "truncated"
                        ? "Answer truncated — the model reached its output limit. Partial response."
                        : "Answer interrupted — partial response."}
                    </p>
                  )}
                </>
              )}
            </div>

            {!isUser && (
              <div className="flex flex-col gap-1 pl-2 justify-start">
                {(messages[messages.length - 1] === msg || msg.incomplete) && (
                  <button
                    type="button"
                    onClick={() => onRegenerate?.(key)}
                    disabled={busy}
                    className="text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
                    title={
                      msg.incomplete ? "Retry this answer" : "Regenerate answer"
                    }
                    aria-label={msg.incomplete ? "Retry answer" : "Regenerate answer"}
                  >
                    <RefreshCw className="size-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleCopy(key, msg.content)}
                  className="text-text-muted hover:text-text-primary transition-colors"
                  title={feedback === "copied" ? "Copied!" : "Copy"}
                  aria-label="Copy message"
                >
                  {feedback === "copied" ? (
                    <Check className="size-3.5 text-primary" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
                {onSaveAsBrief && (
                  <button
                    type="button"
                    onClick={() => handleSaveAsBrief(key, msg.content)}
                    className="text-text-muted hover:text-primary transition-colors"
                    title={
                      feedback === "brief saved"
                        ? "Saved as project brief!"
                        : "Save as project brief"
                    }
                    aria-label="Save as project brief"
                  >
                    {feedback === "brief saved" ? (
                      <Check className="size-3.5 text-primary" />
                    ) : (
                      <FolderOpen className="size-3.5" />
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleSaveToLibrary(key, msg.content)}
                  className="text-text-muted hover:text-text-primary transition-colors"
                  title={feedback === "saved" ? "Saved to Library!" : "Save to Library"}
                  aria-label="Save to Library"
                >
                  {feedback === "saved" ? (
                    <Check className="size-3.5 text-primary" />
                  ) : (
                    <BookmarkPlus className="size-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => handleDeslop(key)}
                  disabled={busy}
                  className="text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
                  title={
                    cleanupPending ? "Removing AI slop…" : "Remove AI slop"
                  }
                  aria-label="Remove AI slop"
                >
                  {cleanupPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {operation && operation.type !== "cleanup" ? (
        streamingOutput ? (
          <div className="flex justify-start">
            <div className="max-w-[75ch] rounded-lg bg-surface text-text-primary border border-border px-4 py-3 break-words">
              <div className="chat-markdown prose prose-sm max-w-none dark:prose-invert">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: MarkdownImage }}>
                  {streamingOutput}
                </ReactMarkdown>
              </div>
              <span
                className="inline-block w-2 h-4 align-middle bg-primary/70 animate-pulse ml-0.5"
                aria-hidden="true"
              />
            </div>
          </div>
        ) : (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg bg-surface text-text-primary border border-border">
              <LoadingDots />
            </div>
          </div>
        )
      ) : null}

      {error && (
        <div className="flex justify-center">
          <div className="bg-destructive/10 text-destructive text-sm rounded-lg px-4 py-2 border border-destructive/20 max-w-lg text-center">
            {error}
          </div>
        </div>
      )}

      <div ref={bottomRef} />

      {!stickyToBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="sticky bottom-0 mx-auto w-fit z-10 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary shadow-sm hover:text-text-primary transition-colors flex items-center gap-1.5"
          title="Jump to latest message"
          aria-label="Jump to latest message"
        >
          <ArrowDown className="size-3.5" />
          Latest
        </button>
      )}
    </div>
  );
}
