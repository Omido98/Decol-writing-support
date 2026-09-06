import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatStore, messageKey, type ChatMessage } from "@/stores/chatStore";
import { sendMessage } from "@/utils/api";
import { buildSystemPrompt } from "@/utils/systemPrompt";
import { estimateTokens } from "@/utils/tokens";
import ChatSettings from "@/components/chat/ChatSettings";
import MessageList from "@/components/chat/MessageList";
import MessageInput from "@/components/chat/MessageInput";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MessageSquarePlus, Settings, Trash2 } from "lucide-react";

interface ChatTabProps {
  /** Opens the general Settings dialog (used to configure the API). */
  onOpenSettings: () => void;
}

export default function ChatTab({ onOpenSettings }: ChatTabProps) {
  // ── Stores ──
  const configLoaded = useChatStore((s) => s.configLoaded);
  const config = useChatStore((s) => s.config);
  const loadConfig = useChatStore((s) => s.loadConfig);

  const threads = useChatStore((s) => s.threads);
  const threadsLoaded = useChatStore((s) => s.threadsLoaded);
  const loadThreads = useChatStore((s) => s.loadThreads);
  const createThread = useChatStore((s) => s.createThread);
  const deleteThread = useChatStore((s) => s.deleteThread);

  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const threadLoaded = useChatStore((s) => s.threadLoaded);
  const switchThread = useChatStore((s) => s.switchThread);
  const addMessage = useChatStore((s) => s.addMessage);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const isSending = useChatStore((s) => s.isSending);
  const setIsSending = useChatStore((s) => s.setIsSending);
  const setError = useChatStore((s) => s.setError);
  const setStreamingText = useChatStore((s) => s.setStreamingText);
  const inputValue = useChatStore(
    (s) => s.drafts[s.activeThreadId ?? ""] ?? "",
  );
  const setDraft = useChatStore((s) => s.setDraft);
  const messages = useChatStore((s) => s.messages);

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;

  // Live estimate of the input tokens the next send would consume
  // (system prompt + conversation history + typed draft).
  const tokenEstimate = useMemo(() => {
    const prompt = buildSystemPrompt({
      mode: config.systemPromptMode ?? "standard",
      customPrompt: config.customSystemPrompt ?? "",
    });
    const historyText = messages.map((m) => m.content).join("\n");
    return estimateTokens(`${prompt}\n${historyText}\n${inputValue}`);
  }, [
    messages,
    inputValue,
    config.systemPromptMode,
    config.customSystemPrompt,
  ]);

  // ── Input state ──
  const [showConfig, setShowConfig] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Aborts the in-flight generation (used by the Stop button / Escape).
  const controllerRef = useRef<AbortController | null>(null);

  // ── Load on mount ──
  useEffect(() => {
    if (!configLoaded) loadConfig();
  }, [configLoaded, loadConfig]);

  // ── Load the thread list (and pick up where the last session left off) ──
  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  // ── Stop generation (Stop button / Escape key) ──
  const handleStop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isSending) {
        e.preventDefault();
        handleStop();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSending, handleStop]);

  // ── Send a message to the chat ──
  // Three modes:
  // - default: `text` is added as a new user message and sent.
  // - `resendKey`: an existing failed user message is sent again in place
  //   (no duplicate is created; the failed marker is cleared on the way out).
  // - `regenerateKey`: the given assistant message is dropped from the
  //   request history and generated anew; on success it is replaced in
  //   place, and on failure the old reply is kept.
  const sendText = useCallback(
    async (
      opts: {
        text?: string;
        resendKey?: string;
        regenerateKey?: string;
      } = {},
    ) => {
      const isResend = !!opts.resendKey;
      const isRegenerate = !!opts.regenerateKey;

      if (isSending || !activeThreadId) return;

      let trimmed = "";
      if (isResend || isRegenerate) {
        const store = useChatStore.getState();
        const target = store.messages.find(
          (m) => messageKey(m) === (opts.resendKey ?? opts.regenerateKey),
        );
        if (!target || !target.content.trim()) return;
        trimmed = target.content.trim();
      } else {
        trimmed = (opts.text ?? "").trim();
      }
      if (!trimmed) return;

      // Clear the input only for a freshly typed send; re-sends and
      // regenerations reuse a message that is already in the thread.
      if (!isResend && !isRegenerate) {
        setDraft("");
      }

      // A re-send clears the failed marker immediately so the button
      // disappears while the request is in flight.
      if (isResend) {
        updateMessage(opts.resendKey!, (m) => ({ ...m, failed: false }));
      }

      // Add the user message only for a fresh send; re-sends reuse the
      // message already in the thread, regenerations keep the old reply
      // until the new one is ready.
      let userMsg: ChatMessage | null = null;
      if (!isResend && !isRegenerate) {
        userMsg = {
          role: "user",
          content: trimmed,
          timestamp: new Date().toISOString(),
        };
        addMessage(userMsg);
      }

      // Send to API
      const controller = new AbortController();
      controllerRef.current = controller;
      setStreamingText("");
      setIsSending(true);
      setError(null);

      const currentConfig = useChatStore.getState().config;
      const systemPrompt = buildSystemPrompt({
        mode: currentConfig.systemPromptMode ?? "standard",
        customPrompt: currentConfig.customSystemPrompt ?? "",
      });

      const threadAtSend = useChatStore.getState().activeThreadId;
      const { messages } = useChatStore.getState();
      // A regeneration drops the old reply from the history so the model
      // answers afresh; the stored message itself stays until replaced.
      const history = isRegenerate
        ? messages.filter((m) => messageKey(m) !== opts.regenerateKey)
        : messages;
      const result = await sendMessage(
        history,
        currentConfig,
        systemPrompt,
        {
          signal: controller.signal,
          onDelta: (chunk) => {
            // Only render text while still in the thread it was sent from.
            if (useChatStore.getState().activeThreadId === threadAtSend) {
              setStreamingText((prev) => prev + chunk);
            }
          },
        },
      );

      // Drop the reply if the user switched threads while it was in flight
      if (useChatStore.getState().activeThreadId !== threadAtSend) {
        setIsSending(false);
        setStreamingText("");
        controllerRef.current = null;
        return;
      }

      if (result.error) {
        // The user's message did not land: flag it so it can be re-sent in
        // place. A regeneration keeps the old reply untouched.
        if (!isRegenerate) {
          const failedKey = opts.resendKey ?? (userMsg ? messageKey(userMsg) : null);
          if (failedKey) {
            updateMessage(failedKey, (m) => ({ ...m, failed: true }));
          }
        }
        setError(result.error);
        setIsSending(false);
        setStreamingText("");
      } else if (result.stopped) {
        // User stopped mid-answer: keep whatever was generated so far.
        const partial = useChatStore.getState().streamingText;
        if (partial.trim()) {
          if (isRegenerate) {
            updateMessage(opts.regenerateKey!, (m) => ({ ...m, content: partial }));
          } else {
            addMessage({
              role: "assistant",
              content: partial,
              timestamp: new Date().toISOString(),
            });
          }
        }
        setStreamingText("");
        setIsSending(false);
      } else {
        if (isRegenerate) {
          updateMessage(opts.regenerateKey!, (m) => ({ ...m, content: result.content }));
        } else {
          addMessage({
            role: "assistant",
            content: result.content,
            timestamp: new Date().toISOString(),
          });
        }
        setStreamingText("");
        setIsSending(false);
      }
      controllerRef.current = null;
    },
    [
      isSending,
      activeThreadId,
      addMessage,
      updateMessage,
      setIsSending,
      setError,
      setStreamingText,
      setDraft,
    ],
  );

  // ── Handle send ──
  const handleSend = useCallback(() => {
    void sendText({ text: inputValue });
  }, [inputValue, sendText]);

  // ── Handle thread deletion ──
  const handleDeleteThread = useCallback(() => {
    if (!activeThreadId) return;
    void deleteThread(activeThreadId);
    setConfirmDelete(false);
  }, [activeThreadId, deleteThread]);

  // ── Show loading state while restoring config ──
  if (!configLoaded || !threadsLoaded) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <p className="text-text-muted">Loading chat…</p>
      </div>
    );
  }

  // ── Show chat agent settings (web search + prompt) when explicitly opened ──
  if (showConfig) {
    return (
      <ChatSettings
        onDone={() => setShowConfig(false)}
        onOpenSettings={onOpenSettings}
      />
    );
  }

  // ── No API key yet: explain and offer to configure ──
  if (!config.apiKey) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <p className="text-text-primary text-lg font-semibold">
          Connect your AI provider
        </p>
        <p className="text-text-muted text-sm mt-2 max-w-md">
          The chat assistant needs an API key to work. You can use OpenCode
          Zen, Anthropic, OpenAI, or any OpenAI-compatible endpoint. Your key
          is stored securely in your system&apos;s keychain and never leaves
          your computer.
        </p>
        <Button
          className="bg-primary hover:bg-primary/80 text-primary-foreground mt-6"
          onClick={onOpenSettings}
        >
          <Settings className="size-4 mr-1.5" />
          Configure API
        </Button>
      </div>
    );
  }

  // ── Show loading state while restoring the thread ──
  if (!threadLoaded) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <p className="text-text-muted">Loading conversation…</p>
      </div>
    );
  }

  // ── Chat interface ──
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Thread switcher */}
          <Select
            value={activeThreadId ?? undefined}
            onValueChange={(v) => void switchThread(v)}
          >
            <SelectTrigger
              className="min-w-0 max-w-[420px] flex-1 bg-transparent border-transparent shadow-none hover:bg-surface data-[size=default]:h-8"
              aria-label="Switch conversation"
            >
              <SelectValue>
                <span className="truncate text-base font-semibold text-text-primary">
                  {activeThread?.title ?? "Untitled conversation"}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {threads.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  <span className="truncate max-w-[360px] block">{t.title}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void createThread()}
            title="New conversation"
            aria-label="New conversation"
            disabled={isSending}
          >
            <MessageSquarePlus className="size-4 text-text-secondary" />
          </Button>
          <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <DialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Delete conversation"
                  aria-label="Delete conversation"
                  disabled={isSending}
                >
                  <Trash2 className="size-4 text-text-secondary" />
                </Button>
              }
            />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete conversation?</DialogTitle>
                <DialogDescription>
                  This will permanently delete the current conversation and
                  all of its messages. It cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
                <Button variant="destructive" onClick={handleDeleteThread}>
                  Delete
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setShowConfig(true)}
            title="Chat agent settings"
            aria-label="Chat agent settings"
          >
            <Settings className="size-4 text-text-secondary" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <MessageList
        onResend={(key) => void sendText({ resendKey: key })}
        onRegenerate={(key) => void sendText({ regenerateKey: key })}
      />

      {/* Input */}
      <MessageInput
        value={inputValue}
        onChange={setDraft}
        onSend={handleSend}
        onStop={handleStop}
        disabled={isSending}
        tokenEstimate={tokenEstimate}
      />
    </div>
  );
}
