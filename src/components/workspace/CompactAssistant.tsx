import { useEffect, useState } from "react";
import { useChatStore } from "@/stores/chatStore";
import { useAppStore } from "@/stores/useAppStore";
import { sendChatMessage } from "@/services/chatSend";
import { abortOperation } from "@/services/aiOperations";
import { useThreadOperation } from "@/components/chat/useThreadOperation";
import { usePreparedPreview } from "@/components/chat/usePreparedPreview";
import WhatWillBeSent from "@/components/chat/WhatWillBeSent";
import MessageList from "@/components/chat/MessageList";
import MessageInput from "@/components/chat/MessageInput";
import { Button } from "@/components/ui/button";
import { MessageSquarePlus } from "lucide-react";

/**
 * The inspector's compact assistant: the same conversation, drafts, and
 * send pipeline as the full discussion view — in a narrow column. Starts
 * a conversation when none is active.
 */
export default function CompactAssistant() {
  const threadsLoaded = useChatStore((s) => s.threadsLoaded);
  const loadThreads = useChatStore((s) => s.loadThreads);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const threadLoaded = useChatStore((s) => s.threadLoaded);
  const error = useChatStore((s) => s.error);
  const setError = useChatStore((s) => s.setError);
  const configLoaded = useChatStore((s) => s.configLoaded);
  const loadConfig = useChatStore((s) => s.loadConfig);
  // Busy state belongs to THIS conversation's operation, not to whatever
  // request happens to be running elsewhere (B15).
  const operation = useThreadOperation(activeThreadId);
  const busy = !!operation;
  const openDiscussion = useAppStore((s) => s.openDiscussion);

  const [configuring, setConfiguring] = useState(false);

  useEffect(() => {
    if (!configLoaded) void loadConfig();
    if (!threadsLoaded) void loadThreads();
  }, [configLoaded, loadConfig, threadsLoaded, loadThreads]);

  const draftValue = useChatStore(
    (s) => s.drafts[s.activeThreadId ?? ""] ?? "",
  );
  const setDraft = useChatStore((s) => s.setDraft);
  // The same prepared request the send uses: the compact surface
  // discloses context, sources, and attachments too (B14).
  const previewContext = usePreparedPreview();

  if (configuring) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
        <p className="text-xs text-text-muted max-w-[32ch]">
          The API is configured in Settings — the assistant here uses the
          same configuration.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setConfiguring(false)}
        >
          Back
        </Button>
      </div>
    );
  }

  if (!threadsLoaded) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <p className="text-text-muted text-sm">Loading…</p>
      </div>
    );
  }

  // The visible conversation must belong to the REQUESTED owner: while a
  // switch loads, the previous thread's messages are never shown here.
  if (!threadLoaded) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <p className="text-text-muted text-sm">Loading conversation…</p>
      </div>
    );
  }

  if (!activeThreadId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
        <p className="text-xs text-text-muted max-w-[32ch]">
          No conversation yet. Start one to work with the writing partner.
        </p>
        <Button
          size="sm"
          className="bg-primary hover:bg-primary/80 text-primary-foreground"
          onClick={() => {
            void useChatStore
              .getState()
              .createThread()
              .then((id) => openDiscussion(id));
          }}
        >
          <MessageSquarePlus className="size-4 mr-1.5" />
          New conversation
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 flex flex-col">
        <MessageList
          onResend={(key) => void sendChatMessage({ resendKey: key })}
          onRegenerate={(key) =>
            void sendChatMessage({ regenerateKey: key })
          }
        />
      </div>
      {previewContext && (
        <details className="px-3 border-t border-border shrink-0">
          <summary className="cursor-pointer select-none py-1 text-[10px] text-text-muted hover:text-text-secondary">
            What will be sent? ≈ {previewContext.tokenEstimate.toLocaleString()} tokens
          </summary>
          <div className="mb-2 rounded-lg border border-border bg-surface-alt p-2">
            <WhatWillBeSent compiled={previewContext} />
          </div>
        </details>
      )}
      {error && (
        <div
          role="alert"
          className="px-3 py-1.5 border-t border-destructive/40 text-[11px] text-destructive flex items-center justify-between gap-2 shrink-0"
        >
          <span className="truncate">{error}</span>
          <button
            type="button"
            className="shrink-0 underline"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="shrink-0">
        <MessageInput
          value={draftValue}
          onChange={setDraft}
          onSend={() => void sendChatMessage({ text: draftValue })}
          onStop={operation ? () => abortOperation(operation.id) : undefined}
          disabled={busy || !threadLoaded}
        />
      </div>
      <div className="px-3 py-1 border-t border-border shrink-0">
        <button
          type="button"
          className="text-[10px] text-text-muted hover:text-text-primary underline select-none"
          onClick={() => openDiscussion(activeThreadId)}
        >
          Open the full conversation view
        </button>
      </div>
    </div>
  );
}
