import { create } from "zustand";
import type { ThreadMeta } from "@/types";
import { saveJson, loadJson, deleteFile } from "@/utils/storage";
import {
  deleteApiKeyFromKeychain,
  loadApiKeyFromKeychain,
  saveApiKeyToKeychain,
} from "@/utils/keychain";
import {
  inferProviderFromBaseUrl,
  isKnownProviderId,
  type ProviderId,
} from "@/utils/providers";

// ──────────────────────────────────────────────
// Chat message type (lighter than the full Message type)
// ──────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /** True when the send failed (no reply landed); shows a re-send action. */
  failed?: boolean;
}

/**
 * Stable identity key for a message, used by action buttons and re-sends.
 * Matches the key the UI computes for each rendered message.
 */
export function messageKey(msg: { timestamp: string; content: string }): string {
  return msg.timestamp + msg.content.slice(0, 40);
}

// ──────────────────────────────────────────────
// API configuration
// ──────────────────────────────────────────────

export interface ApiConfig {
  /** Which LLM provider this config targets (determines endpoint & auth). */
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: string | null;
  /** Whether the chat agent may use web search / page fetch tools. */
  webSearchEnabled: boolean;
  /** Which system prompt the chat agent uses. */
  systemPromptMode: "standard" | "custom";
  /** The user's custom prompt, used when systemPromptMode is "custom". */
  customSystemPrompt: string;
}

export const ZEN_DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

const defaultApiConfig: ApiConfig = {
  provider: "zen",
  baseUrl: ZEN_DEFAULT_BASE_URL,
  apiKey: "",
  model: "deepseek-v4-flash-free",
  reasoningEffort: null,
  webSearchEnabled: false,
  systemPromptMode: "standard",
  customSystemPrompt: "",
};

// ──────────────────────────────────────────────
// Thread helpers
// ──────────────────────────────────────────────

function threadFile(id: string): string {
  return `chat_${id}.json`;
}

/** Derive a thread title from its first user message. */
function titleFromMessage(content: string): string {
  const firstLine = content.trim().split(/\r?\n/, 1)[0].trim();
  if (firstLine.length <= 60) return firstLine || "Untitled conversation";
  return firstLine.slice(0, 60).trimEnd() + "…";
}

// ──────────────────────────────────────────────
// Debounced thread save
// ──────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingThreadId: string | null = null;
let pendingSnapshot: ChatMessage[] = [];

/** Write the current thread to disk, debounced. */
function scheduleThreadSave() {
  const s = useChatStore.getState();
  const threadId = s.activeThreadId;
  if (!threadId) return;
  pendingThreadId = threadId;
  pendingSnapshot = [...s.messages];
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await saveJson(threadFile(pendingThreadId!), pendingSnapshot);
  }, 400);
}

function cancelPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/** Flush any pending debounced thread save immediately (called on window close). */
export async function flushChatSave(): Promise<void> {
  if (saveTimer && pendingThreadId) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const threadId = pendingThreadId;
    pendingThreadId = null;
    await saveJson(threadFile(threadId), pendingSnapshot);
  }
}

// ──────────────────────────────────────────────
// Store interface
// ──────────────────────────────────────────────

interface ChatState {
  /** Chat messages of the active thread */
  messages: ChatMessage[];
  /** Whether config has been loaded from disk */
  configLoaded: boolean;
  /** Whether the API is currently processing a request */
  isSending: boolean;
  /** Last error message, if any */
  error: string | null;
  /** Text of the assistant message currently being generated (live stream). */
  streamingText: string;

  /** Unsent message drafts, keyed by thread id. Kept in memory so switching
   * threads does not wipe what the user is typing. */
  drafts: Record<string, string>;

  /** API configuration */
  config: ApiConfig;

  /** Metadata of all saved threads, newest activity first */
  threads: ThreadMeta[];
  /** Whether the thread list has been loaded from disk */
  threadsLoaded: boolean;

  /** Thread whose chat is currently loaded (null = none) */
  activeThreadId: string | null;
  /** Whether the current thread has finished loading from disk */
  threadLoaded: boolean;

  // Message actions
  addMessage: (msg: ChatMessage) => void;
  /** Replace a message by key (e.g. clear a failed flag, swap a regenerated reply). */
  updateMessage: (
    key: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;

  // Thread actions
  /** Load the thread list from disk; repair an active thread that vanished. */
  loadThreads: () => Promise<void>;
  /** Create a new empty thread, make it active, and return its id. */
  createThread: () => Promise<string>;
  /** Delete a thread (messages + metadata). Creates a new thread if it was active. */
  deleteThread: (id: string) => Promise<void>;
  /** Switch the active thread */
  switchThread: (threadId: string | null) => Promise<void>;

  // Config actions
  /** Merge the given fields into the stored config and persist the result. */
  setConfig: (cfg: Partial<ApiConfig>) => Promise<void>;
  loadConfig: () => Promise<void>;
  /** Mark config as not yet configured (e.g. user clicks Edit) */
  resetConfig: () => void;

  // Sending state
  setIsSending: (sending: boolean) => void;
  setError: (error: string | null) => void;
  /** Set the live-streamed assistant text (string, or updater for appends). */
  setStreamingText: (
    updater: string | ((prev: string) => string),
  ) => void;
  /** Save the unsent message draft for the current thread. */
  setDraft: (value: string) => void;
}

// ──────────────────────────────────────────────
// Store implementation
// ──────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  configLoaded: false,
  isSending: false,
  error: null,
  streamingText: "",
  drafts: {},

  config: { ...defaultApiConfig },

  threads: [],
  threadsLoaded: false,

  activeThreadId: null,
  threadLoaded: true,

  // ── Messages ──

  addMessage: (msg) => {
    set((s) => ({ messages: [...s.messages, msg] }));
    // Title the thread after its first user message, and touch updatedAt
    // so the thread list stays newest-first.
    const now = new Date().toISOString();
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === s.activeThreadId
          ? {
              ...t,
              updatedAt: now,
              title:
                msg.role === "user" &&
                (t.title === "Untitled conversation" || !t.title)
                  ? titleFromMessage(msg.content)
                  : t.title,
            }
          : t,
      ),
    }));
    void saveJson("threads.json", get().threads);
    scheduleThreadSave();
  },

  updateMessage: (key, updater) => {
    set((s) => ({
      messages: s.messages.map((m) => (messageKey(m) === key ? updater(m) : m)),
    }));
    scheduleThreadSave();
  },

  // ── Threads ──

  loadThreads: async () => {
    const threads = (await loadJson<ThreadMeta[]>("threads.json")) ?? [];
    threads.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    set({ threads, threadsLoaded: true });

    // The active thread may have been removed (e.g. after a restore) or
    // never set: fall back to the most recent thread, or create one.
    const s = get();
    if (s.activeThreadId && threads.some((t) => t.id === s.activeThreadId)) {
      return;
    }
    if (threads.length > 0) {
      await get().switchThread(threads[0].id);
    } else {
      await get().createThread();
    }
  },

  createThread: async () => {
    cancelPendingSave();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const meta: ThreadMeta = {
      id,
      title: "Untitled conversation",
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({
      threads: [meta, ...s.threads],
      messages: [],
      activeThreadId: id,
      threadLoaded: true,
      streamingText: "",
    }));
    await saveJson("threads.json", get().threads);
    return id;
  },

  deleteThread: async (id) => {
    cancelPendingSave();
    await deleteFile(threadFile(id));
    const threads = get().threads.filter((t) => t.id !== id);
    set({ threads });
    await saveJson("threads.json", threads);

    const s = get();
    if (s.activeThreadId === id) {
      const { drafts } = s;
      delete drafts[id];
      set({ drafts });
      if (threads.length > 0) {
        await get().switchThread(threads[0].id);
      } else {
        await get().createThread();
      }
    }
  },

  switchThread: async (threadId) => {
    const current = get();
    if (current.activeThreadId === threadId && current.threadLoaded) {
      return;
    }
    cancelPendingSave();
    if (!threadId) {
      set({
        messages: [],
        activeThreadId: null,
        threadLoaded: true,
        streamingText: "",
      });
      return;
    }
    set({
      threadLoaded: false,
      activeThreadId: threadId,
      streamingText: "",
    });
    const data = await loadJson<ChatMessage[]>(threadFile(threadId));
    set({ messages: data ?? [], threadLoaded: true });
  },

  // ── Config ──

  setConfig: async (cfg) => {
    const next = { ...get().config, ...cfg };
    set({ config: next });
    // Store the key in BOTH the OS keychain and config.json, so the config
    // survives even when the keychain is unavailable or fails to read back.
    // The keychain is still preferred when loading (see loadConfig).
    if (cfg.apiKey) {
      await saveApiKeyToKeychain(cfg.apiKey);
    } else {
      // Key cleared: remove any stale keychain entry so an old key cannot
      // resurface on the next launch.
      await deleteApiKeyFromKeychain();
    }
    await saveJson("config.json", next);
  },

  loadConfig: async () => {
    const data = await loadJson<ApiConfig>("config.json");
    // Prefer a key stored in the OS keychain over the one in the file.
    const keychainKey = await loadApiKeyFromKeychain();
    if (data) {
      // Migrate the old, non-existent endpoint to the real OpenCode Zen URL
      if (
        data.baseUrl &&
        data.baseUrl.includes("api.opencode.ai") &&
        !data.baseUrl.includes("opencode.ai/zen")
      ) {
        data.baseUrl = ZEN_DEFAULT_BASE_URL;
      }
      // Infer the provider from the stored base URL when it's missing
      if (!isKnownProviderId(data.provider)) {
        data.provider = inferProviderFromBaseUrl(data.baseUrl);
      }
      set({
        config: {
          ...data,
          apiKey: keychainKey ?? data.apiKey ?? "",
          reasoningEffort: data.reasoningEffort ?? null,
          webSearchEnabled: data.webSearchEnabled ?? false,
          systemPromptMode: data.systemPromptMode ?? "standard",
          customSystemPrompt: data.customSystemPrompt ?? "",
        },
        configLoaded: true,
      });
    } else {
      set({
        config: { ...defaultApiConfig, apiKey: keychainKey ?? "" },
        configLoaded: true,
      });
    }
  },
  resetConfig: () => {
    set({ config: { ...defaultApiConfig }, configLoaded: false });
  },

  // ── Sending state ──

  setIsSending: (sending) => set({ isSending: sending }),
  setError: (error) => set({ error }),
  setStreamingText: (updater) =>
    set((s) => ({
      streamingText:
        typeof updater === "function"
          ? (updater as (prev: string) => string)(s.streamingText)
          : updater,
    })),
  setDraft: (value) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [get().activeThreadId ?? ""]: value,
      },
    })),
}));
