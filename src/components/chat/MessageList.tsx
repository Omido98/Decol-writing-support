import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useChatStore, messageKey } from "@/stores/chatStore";
import { cn } from "@/lib/utils";
import {
  Copy,
  Check,
  ArrowDown,
  RotateCcw,
  RefreshCw,
} from "lucide-react";

function LoadingDots() {
  return (
    <div className="flex items-center gap-1.5 px-4 py-3">
      <span className="size-2 rounded-full bg-text-muted animate-bounce [animation-delay:0ms]" />
      <span className="size-2 rounded-full bg-text-muted animate-bounce [animation-delay:150ms]" />
      <span className="size-2 rounded-full bg-text-muted animate-bounce [animation-delay:300ms]" />
    </div>
  );
}

export default function MessageList({
  onResend,
  onRegenerate,
}: {
  /** Re-send a failed user message in place (no duplicate is created). */
  onResend?: (key: string) => void;
  /** Regenerate the latest assistant message, replacing it in place. */
  onRegenerate?: (key: string) => void;
}) {
  const messages = useChatStore((s) => s.messages);
  const isSending = useChatStore((s) => s.isSending);
  const streamingText = useChatStore((s) => s.streamingText);
  const error = useChatStore((s) => s.error);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<{ role: "user" | "assistant"; timestamp: string } | null>(
    null,
  );
  const [stickyToBottom, setStickyToBottom] = useState(true);

  const [copiedId, setCopiedId] = useState<string | null>(null);
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
        behavior: isSending ? "auto" : "smooth",
      });
    }
  }, [messages, isSending, streamingText, stickyToBottom]);

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

  if (messages.length === 0 && !isSending) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md space-y-4">
          <p className="text-text-muted text-sm">
            Send a message to start the conversation. The AI is your writing
            partner for decolonial and anti-colonial texts — drafting,
            revising, and rethinking together with you.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
    >
      {messages.map((msg) => {
        const isUser = msg.role === "user";
        const key = messageKey(msg);
        const feedback = copiedId === key ? "copied" : null;
        return (
          <div
            key={key}
            className={cn(
              "flex",
              isUser ? "justify-end" : "justify-start",
            )}
          >
            {isUser && msg.failed && (
              <div className="flex flex-col gap-1 pr-2 justify-start">
                <button
                  type="button"
                  onClick={() => onResend?.(key)}
                  disabled={isSending}
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
                <p>{msg.content}</p>
              ) : (
                <div className="chat-markdown prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              )}
            </div>

            {!isUser && (
              <div className="flex flex-col gap-1 pl-2 justify-start">
                {messages[messages.length - 1] === msg && (
                  <button
                    type="button"
                    onClick={() => onRegenerate?.(key)}
                    disabled={isSending}
                    className="text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
                    title="Regenerate answer"
                    aria-label="Regenerate answer"
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
                    <Check className="size-3.5 text-green-400" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {isSending && streamingText ? (
        <div className="flex justify-start">
          <div className="max-w-[75ch] rounded-lg bg-surface text-text-primary border border-border px-4 py-3 break-words">
            <div className="chat-markdown prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {streamingText}
              </ReactMarkdown>
            </div>
            <span
              className="inline-block w-2 h-4 align-middle bg-primary/70 animate-pulse ml-0.5"
              aria-hidden="true"
            />
          </div>
        </div>
      ) : isSending ? (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-lg bg-surface text-text-primary border border-border">
            <LoadingDots />
          </div>
        </div>
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
