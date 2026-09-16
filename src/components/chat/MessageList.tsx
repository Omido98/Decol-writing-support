import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useChatStore,
  messageKey,
  type ChatMessage,
} from "@/stores/chatStore";
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

/** Estimated row height before measurement, in px. */
const ROW_ESTIMATE_PX = 96;
/** Rows rendered beyond the viewport. */
const OVERSCAN = 6;
/** Distance from the bottom that still counts as "at the bottom", in px. */
const STICK_THRESHOLD_PX = 60;
/** Vertical padding of the list, in px (shared with the virtualizer). */
const LIST_PADDING_PX = 16;

/** Stable plugin/component identities for the markdown renderers. */
const REMARK_PLUGINS = [remarkGfm];

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

const MARKDOWN_COMPONENTS = { img: MarkdownImage };

type Row =
  | { kind: "message"; key: string; msg: ChatMessage }
  | { kind: "stream"; key: string };

type Feedback = "copied" | "saved" | "brief saved" | null;

interface MessageRowProps {
  msg: ChatMessage;
  rowKey: string;
  isUser: boolean;
  failed: boolean;
  cleanupPending: boolean;
  feedback: Feedback;
  showRegenerate: boolean;
  busy: boolean;
  onResend?: (key: string) => void;
  onRegenerate?: (key: string) => void;
  onCopy: (key: string, content: string) => void;
  onSaveToLibrary: (key: string, content: string) => void;
  onSaveAsBrief?: (key: string, content: string) => void;
  onDeslop: (key: string) => void;
}

/**
 * One conversation row. Memoized: streaming (which re-renders the list on
 * every delta) must never re-parse the markdown of unchanged messages.
 */
const MessageRow = memo(function MessageRow({
  msg,
  rowKey,
  isUser,
  failed,
  cleanupPending,
  feedback,
  showRegenerate,
  busy,
  onResend,
  onRegenerate,
  onCopy,
  onSaveToLibrary,
  onSaveAsBrief,
  onDeslop,
}: MessageRowProps) {
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      {failed && (
        <div className="flex flex-col gap-1 pr-2 justify-start">
          <button
            type="button"
            onClick={() => onResend?.(rowKey)}
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
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                components={MARKDOWN_COMPONENTS}
              >
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
          {showRegenerate && (
            <button
              type="button"
              onClick={() => onRegenerate?.(rowKey)}
              disabled={busy}
              className="text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
              title={msg.incomplete ? "Retry this answer" : "Regenerate answer"}
              aria-label={msg.incomplete ? "Retry answer" : "Regenerate answer"}
            >
              <RefreshCw className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onCopy(rowKey, msg.content)}
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
              onClick={() => onSaveAsBrief(rowKey, msg.content)}
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
            onClick={() => onSaveToLibrary(rowKey, msg.content)}
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
            onClick={() => onDeslop(rowKey)}
            disabled={busy}
            className="text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
            title={cleanupPending ? "Removing AI slop…" : "Remove AI slop"}
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
});

/**
 * Whether the scroll container has real layout (height > 0). jsdom has no
 * layout engine, and a hidden panel measures 0: both render the plain
 * list instead of a virtualized window over a zero-height viewport.
 */
function useHasLayout(ref: RefObject<HTMLDivElement | null>): boolean {
  const [hasLayout, setHasLayout] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const height = el.getBoundingClientRect().height || el.clientHeight;
      setHasLayout(height > 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return hasLayout;
}

function MessageList({
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
    setStickyToBottom(
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX,
    );
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

  const flashFeedback = useCallback(
    (id: string, setter: (v: string | null) => void) => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      setter(id);
      feedbackTimer.current = setTimeout(() => {
        setter(null);
        feedbackTimer.current = null;
      }, 1500);
    },
    [],
  );

  const handleCopy = useCallback(
    async (msgId: string, content: string) => {
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
    },
    [flashFeedback],
  );

  const handleSaveToLibrary = useCallback(
    async (msgId: string, content: string) => {
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
    },
    [flashFeedback, saveToProjectId],
  );

  const handleSaveAsBrief = useCallback(
    async (msgId: string, content: string) => {
      if (!content.trim() || !onSaveAsBrief) return;
      // Wait for the brief to actually land before confirming.
      await onSaveAsBrief(content);
      flashFeedback(msgId, setBriefSavedId);
    },
    [flashFeedback, onSaveAsBrief],
  );

  // Cleanup runs in the SHARED service: its admission guard makes a
  // duplicate cleanup impossible across full and compact surfaces, and
  // its abort signal cancels the request.
  const handleDeslop = useCallback((key: string) => {
    void cleanupMessage(key);
  }, []);

  // Rows = messages + the live operation's placeholder. Identity of the
  // array only changes when a message lands or an operation starts/stops —
  // never per stream delta.
  const showStreamRow = !!operation && operation.type !== "cleanup";
  const rows = useMemo<Row[]>(() => {
    const list: Row[] = messages.map((msg) => ({
      kind: "message",
      key: messageKey(msg),
      msg,
    }));
    if (showStreamRow) list.push({ kind: "stream", key: "__stream__" });
    return list;
  }, [messages, showStreamRow]);

  const hasLayout = useHasLayout(containerRef);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: OVERSCAN,
    paddingStart: LIST_PADDING_PX,
    paddingEnd: LIST_PADDING_PX,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const renderRow = (row: Row) => {
    if (row.kind === "stream") {
      return streamingOutput ? (
        <div className="flex justify-start">
          <div className="max-w-[75ch] rounded-lg bg-surface text-text-primary border border-border px-4 py-3 break-words">
            <div className="chat-markdown prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                components={MARKDOWN_COMPONENTS}
              >
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
      );
    }

    const msg = row.msg;
    const isUser = msg.role === "user";
    const failed = isUser && (msg.failed === true || failedKeys.has(row.key));
    const cleanupPending =
      operation?.type === "cleanup" &&
      operation.targetMessageId !== null &&
      operation.targetMessageId === (msg.id ?? null);
    const feedback: Feedback =
      copiedId === row.key
        ? "copied"
        : savedId === row.key
          ? "saved"
          : briefSavedId === row.key
            ? "brief saved"
            : null;
    const showRegenerate =
      messages[messages.length - 1] === msg || msg.incomplete !== undefined;

    return (
      <MessageRow
        msg={msg}
        rowKey={row.key}
        isUser={isUser}
        failed={failed}
        cleanupPending={cleanupPending}
        feedback={feedback}
        showRegenerate={showRegenerate}
        busy={busy}
        onResend={onResend}
        onRegenerate={onRegenerate}
        onCopy={handleCopy}
        onSaveToLibrary={handleSaveToLibrary}
        onSaveAsBrief={onSaveAsBrief ? handleSaveAsBrief : undefined}
        onDeslop={handleDeslop}
      />
    );
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto"
    >
      {hasLayout ? (
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full px-4 pb-4"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {renderRow(row)}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="pt-4">
          {rows.map((row) => (
            <div key={row.key} className="px-4 pb-4">
              {renderRow(row)}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="flex justify-center px-4 pb-4">
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

export default memo(MessageList);
