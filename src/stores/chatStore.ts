import { create } from "zustand";
import type {
  AttachedLibraryText,
  IncompleteReason,
  ThreadMeta,
  ThreadMode,
  WritingBrief,
} from "@/types";
import {
  forgetFailedSendsForThread,
  invalidateAllOperations,
} from "@/services/aiOperations";
import { repo, type StoredMessage } from "@/utils/repository";
import { loadJson } from "@/utils/storage";
import { getPref, setPref } from "@/utils/preferences";
import {
  credentialAccount,
  loadCredential,
  deleteCredential,
  deleteProfileCredential,
  loadProfileCredential,
  saveProfileCredential,
  loadLegacyKey,
  deleteLegacyKey,
  readLegacyPlaintextKey,
  stripLegacyPlaintextKey,
} from "@/utils/keychain";
import {
  inferProviderFromBaseUrl,
  isKnownProviderId,
  getProvider,
  type ProviderId,
} from "@/utils/providers";
import {
  PROFILES_PREF,
  defaultProfileName,
  isSameEndpoint,
  makeProfile,
  normalizeProfileName,
  pickDefaultProfile,
  sanitizeProfiles,
  uniqueProfileName,
  type CredentialProfile,
} from "@/utils/profiles";

// ──────────────────────────────────────────────
// Chat message type (lighter than the full Message type)
// ──────────────────────────────────────────────

/** Extracted text of an uploaded document, saved with the message. */
export interface FileAttachment {
  name: string;
  kind: string;
  content: string;
  /** Word count of the extracted text. */
  wordCount?: number;
}

export interface ChatMessage {
  /** Stable message identity (assigned on create/migration; persists). */
  id?: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /** True when the send failed (no reply landed); shows a re-send action. */
  failed?: boolean;
  /** Why an assistant reply is incomplete (partial response preserved,
   * B16b). Never set when the answer completed. */
  incomplete?: IncompleteReason;
  /** Extracted text of documents uploaded with this message. */
  fileAttachments?: FileAttachment[];
}

/**
 * Stable identity key for a message, used by action buttons and re-sends.
 * Uses the stable id once present; falls back to the legacy key for
 * messages that have not been migrated yet.
 */
export function messageKey(msg: {
  id?: string;
  timestamp: string;
  content: string;
}): string {
  return msg.id ?? msg.timestamp + msg.content.slice(0, 40);
}

// ──────────────────────────────────────────────
// API configuration
// ──────────────────────────────────────────────

export interface ApiConfig {
  /** Which LLM provider this config targets (determines endpoint & auth).
   * A flattened view of the ACTIVE profile. */
  provider: ProviderId;
  baseUrl: string;
  /** In-memory only. The persisted config never carries the key: it is
   * stored in the OS keychain under the active profile's account, or — when
   * the keychain is unavailable — kept session-only. */
  apiKey: string;
  model: string;
  reasoningEffort: string | null;
  /** Whether the chat agent may use web search / page fetch tools. */
  webSearchEnabled: boolean;
  /** Whether the chat agent researches thoroughly (more searches/fetches per turn). */
  deepResearchEnabled: boolean;
  /** Which system prompt the chat agent uses. */
  systemPromptMode: "standard" | "custom";
  /** The user's custom prompt, used when systemPromptMode is "custom". */
  customSystemPrompt: string;
  /** The last submitted writing brief, used as the default for new threads. */
  lastBrief: WritingBrief | null;
  /** Credential reference (NOT the secret): the keychain account holding
   * the active profile's key. Null when no credential is stored. */
  keychainAccount: string | null;
  /** True when the key could NOT be stored securely and only lives in
   * memory for this session (secure storage unavailable). */
  sessionKeyOnly: boolean;
  /** The active profile's identity: which saved key this config sends with. */
  activeProfileId: string | null;
}

export const ZEN_DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

const defaultApiConfig: ApiConfig = {
  provider: "zen",
  baseUrl: ZEN_DEFAULT_BASE_URL,
  apiKey: "",
  model: "deepseek-v4-flash-free",
  reasoningEffort: null,
  webSearchEnabled: true,
  deepResearchEnabled: false,
  systemPromptMode: "standard",
  customSystemPrompt: "",
  lastBrief: null,
  keychainAccount: null,
  sessionKeyOnly: false,
  activeProfileId: null,
};

/** Why a `saveConnection` was refused (the UI explains it in place). */
export type SaveConnectionResult =
  | { ok: true; sessionKeyOnly: boolean; profileId: string }
  | { ok: false; reason: "empty-name" | "duplicate-name" | "no-key" | "unknown-profile" };

/** The fields `setConfig` may change: credentials and the active profile are
 * owned by `saveConnection`/`activateProfile`, never by a generic merge. */
export type ConfigFields = Omit<
  Partial<ApiConfig>,
  "apiKey" | "keychainAccount" | "sessionKeyOnly" | "activeProfileId" | "provider" | "baseUrl"
>;

/** The profile list holds account REFERENCES only, never secrets. */
function persistProfiles(profiles: CredentialProfile[]): Promise<void> {
  return setPref(PROFILES_PREF, profiles);
}

/**
 * The flattened config VIEW of one active profile: every consumer (the send
 * path, the evaluations, the chat header) keeps reading provider/endpoint/
 * key/model exactly as before, and they always describe the active profile.
 */
function flattenProfile(
  base: ApiConfig,
  profile: CredentialProfile,
  key: string | null,
  sessionKeyOnly: boolean,
  model: string,
): ApiConfig {
  return {
    ...base,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model,
    apiKey: key ?? "",
    keychainAccount: key != null && !sessionKeyOnly ? profile.account : null,
    sessionKeyOnly,
    activeProfileId: profile.id,
  };
}

// ──────────────────────────────────────────────
// Thread helpers
// ──────────────────────────────────────────────

/** Field labels composeBriefMessage writes, matched exactly. */
const BRIEF_FIELD_RE =
  /^(Topic|Background|Type of text|Audience|Tone|Citations|Length|Language|Must include|Must avoid):\s*(.*)$/i;

/** Derive a thread title from its first user message. */
function titleFromMessage(content: string): string {
  const lines = content.trim().split(/\r?\n/);
  // A structured brief opens with a "Writing Brief:" header followed by
  // field labels — useless as a title. Prefer the topic, then the first
  // line that is not a brief field (usually the actual request).
  let start = 0;
  if (/^writing brief:?$/i.test(lines[0]?.trim() ?? "")) {
    start = 1;
    let topic: string | null = null;
    while (start < lines.length) {
      const match = BRIEF_FIELD_RE.exec(lines[start].trim());
      if (!match) break;
      if (match[1].toLowerCase() === "topic" && match[2]) topic = match[2];
      start++;
    }
    if (topic) return shortenTitle(topic);
    while (start < lines.length && !lines[start].trim()) start++;
  }
  const firstLine = lines[start]?.trim() ?? "";
  return shortenTitle(firstLine);
}

function shortenTitle(text: string): string {
  if (!text) return "Untitled conversation";
  if (text.length <= 60) return text;
  return text.slice(0, 60).trimEnd() + "…";
}

/** Sequence guard for async thread loads (see switchThread). */
let threadLoadSeq = 0;
/** In-flight thread-list load: concurrent callers share one run. */
let threadsLoadPromise: Promise<void> | null = null;

// ──────────────────────────────────────────────
// Thread persistence (debounced whole-thread saves live in the repository)
// ──────────────────────────────────────────────

/** Map a store message to its persisted shape. */
function messageToStored(m: ChatMessage): StoredMessage {
  return {
    id: m.id ?? null,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
    failed: m.failed === true,
    incomplete: m.incomplete ?? null,
    attachmentsJson: m.fileAttachments ? JSON.stringify(m.fileAttachments) : null,
  };
}

/** Map a persisted message back to the store shape. */
function storedToMessage(m: StoredMessage): ChatMessage {
  const msg: ChatMessage = {
    // Migration: rows without a stable id get one (order/content unchanged);
    // the next whole-thread save persists it.
    id: m.id ?? crypto.randomUUID(),
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
  };
  if (m.failed) msg.failed = true;
  if (m.incomplete === "interrupted" || m.incomplete === "truncated") {
    msg.incomplete = m.incomplete;
  }
  if (m.attachmentsJson) {
    try {
      msg.fileAttachments = JSON.parse(m.attachmentsJson);
    } catch {
      // Corrupt attachments: drop them rather than the message.
    }
  }
  return msg;
}

/** Parse a stored writing brief; null when absent or corrupt. */
function parseBriefJson(briefJson: string): WritingBrief | null {
  try {
    const brief = JSON.parse(briefJson) as WritingBrief;
    return brief && typeof brief === "object" ? brief : null;
  } catch {
    return null;
  }
}

/**
 * Schedule the current thread's debounced save. The repository coalesces
 * saves per thread id and flushes them on switch/close; metadata, brief,
 * and messages always commit as one transaction.
 */
function scheduleThreadSave() {
  const s = useChatStore.getState();
  const threadId = s.activeThreadId;
  if (!threadId) return;
  const meta = s.threads.find((t) => t.id === threadId) ?? {
    // The active thread should always have metadata; synthesize a row if
    // the state was set up without one, so saves never silently no-op.
    id: threadId,
    title: "Untitled conversation",
    mode: "text",
    createdAt: s.messages[0]?.timestamp ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  repo.threadScheduleSave(threadId, {
    meta,
    briefJson: s.brief ? JSON.stringify(s.brief) : null,
    messages: s.messages.map(messageToStored),
  });
}

/** Flush any pending thread save (called on window close). */
export async function flushChatSave(): Promise<void> {
  // Drain: fails visibly while earlier conversation writes are retained.
  await repo.drainThreadSaves();
  await repo.idle();
}

// ──────────────────────────────────────────────
// Store interface
// ──────────────────────────────────────────────

interface ChatState {
  /** Chat messages of the active thread */
  messages: ChatMessage[];
  /** The writing brief of the active thread (settled answers). */
  brief: WritingBrief | null;
  /** Whether config has been loaded from disk */
  configLoaded: boolean;
  /** The named credential profiles (no secrets; the keys live in the OS
   * keychain under each profile's account). */
  profiles: CredentialProfile[];
  /** Error banner of the ACTIVE thread (see threadErrors for hidden ones). */
  error: string | null;
  /** Per-thread error banners: switching conversations restores that
   * conversation's own error instead of showing another thread's. */
  threadErrors: Record<string, string>;

  /** Unsent message drafts, keyed by thread id. Kept in memory so switching
   * threads does not wipe what the user is typing. */
  drafts: Record<string, string>;

  /** Composer attachments per thread (library texts + uploaded files), so
   * navigation cannot migrate an attachment into another conversation. */
  threadAttachments: Record<
    string,
    { library: AttachedLibraryText[]; files: FileAttachment[] }
  >;

  /** Whether a project's brief is included in sends of its text threads
   * (per project id; default true). Shared by every chat surface. */
  briefIncludedByThread: Record<string, boolean>;
  toggleBriefInclude: (projectId: string) => void;

  /** Per-thread source PICK for sends (D4): when set, ONLY these sources
   * ride the next send (the default project-scope/inclusion behavior is
   * overridden; the manifest reports the omission exactly). In-memory
   * per-thread state, like briefIncludedByThread. */
  threadSourcePicks: Record<string, string[]>;
  setThreadSourcePick: (threadId: string, sourceIds: string[]) => void;
  clearThreadSourcePick: (threadId: string) => void;

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
  /** Set (or clear) the writing brief of the active thread and persist it. */
  setBrief: (brief: WritingBrief | null) => void;
  /**
   * Set the mode (and optional project link) of the active thread and
   * persist it. Only possible while the thread has no messages yet.
   */
  setThreadMode: (mode: ThreadMode, projectId?: string) => Promise<void>;
  /**
   * Set (or clear) the free-text references of the active thread and
   * persist them in threads.json.
   */
  setThreadReferences: (references: string) => Promise<void>;

  // Thread actions
  /** Load the conversation inventory without selecting or creating one. */
  loadThreadInventory: () => Promise<void>;
  /** Load the thread list from disk; repair an active thread that vanished. */
  loadThreads: () => Promise<void>;
  /** Reload all threads from disk after a backup restore, discarding the
   * currently loaded conversation (its in-memory copy predates the restore). */
  reloadAfterRestore: () => Promise<void>;
  /** Create a new empty thread, make it active, and return its id. */
  createThread: () => Promise<string>;
  /** Delete a thread (messages + metadata). Creates a new thread if it was active. */
  deleteThread: (id: string) => Promise<void>;
  /** Rename a thread (metadata-only: safe for unloaded conversations). */
  renameThread: (id: string, title: string) => Promise<void>;
  /** Pin/archive a conversation (navigator organization, D3). */
  setThreadState: (
    id: string,
    patch: { archived?: boolean; pinned?: boolean },
  ) => Promise<void>;
  /** Move a conversation to a folder (null = no folder). Metadata-only:
   * safe for unloaded conversations. */
  setThreadFolder: (id: string, folder: string | null) => Promise<void>;
  /** Switch the active thread. Resolves true when the requested owner was
   * found and loaded (or the load was superseded by a newer navigation);
   * false when no such thread exists, so callers can fall back. */
  switchThread: (threadId: string | null) => Promise<boolean>;

  // Config actions
  /** Merge the given NON-credential fields into the stored config and
   * persist. Credentials and the active profile are owned by
   * `saveConnection`/`activateProfile`, so a plain merge can never attach a
   * key to a profile it was not typed for. */
  setConfig: (cfg: ConfigFields) => Promise<void>;
  loadConfig: () => Promise<void>;
  /** Mark config as not yet configured (e.g. user clicks Edit) */
  resetConfig: () => void;
  /**
   * The one credential write path: upsert a profile (by id, or a new one)
   * with its key, and make it the active profile. An empty `apiKey` on an
   * existing profile keeps the stored key; a profile whose provider/endpoint
   * the caller CHANGED is stored as a NEW profile, because a key must never
   * follow a profile to a different endpoint.
   */
  saveConnection: (input: {
    profileId?: string | null;
    name: string;
    provider: ProviderId;
    baseUrl: string;
    apiKey: string;
    model?: string;
  }) => Promise<SaveConnectionResult>;
  /** Switch the active profile: resolve ITS key, mirror it into the config. */
  activateProfile: (id: string, model?: string) => Promise<boolean>;
  /** Rename a profile. */
  renameProfile: (id: string, name: string) => Promise<boolean>;
  /** Delete a profile and its stored credential. The last remaining profile
   * cannot be deleted; deleting the active one activates another. */
  deleteProfile: (id: string) => Promise<boolean>;
  /** Delete one profile's stored key, keeping the profile itself. */
  forgetProfileKey: (id: string) => Promise<void>;
  /** Forget the ACTIVE profile's stored credential (its keychain entry is
   * deleted, the in-memory key cleared, the stripped config persisted). */
  forgetCredential: () => Promise<void>;

  // Sending state
  /** Set (or clear) the active thread's error banner. */
  setError: (error: string | null) => void;
  /** Set (or clear) one thread's error; only writes the visible `error`
   * when that thread is the active one (B15). */
  setThreadError: (threadId: string, error: string | null) => void;
  /** Save the unsent message draft for the current thread. */
  setDraft: (value: string) => void;
  /** Commit an assistant reply to a thread that is no longer loaded
   * (generation finished after the user switched conversations). */
  appendAssistantToThread: (
    threadId: string,
    content: string,
    incomplete?: IncompleteReason,
  ) => Promise<void>;
  /** Commit an operation's result to its OWNER thread regardless of the
   * currently visible conversation: in-memory when the owner is active,
   * a repository append/replace otherwise. Returns false when the owner
   * no longer exists (deleted or restored away). */
  commitToOwner: (
    threadId: string,
    commit:
      | { kind: "append"; content: string; incomplete?: IncompleteReason }
      | {
          kind: "replace";
          messageId: string;
          content: string;
          incomplete?: IncompleteReason;
        },
  ) => Promise<boolean>;
  /** Replace a message by STABLE ID (regeneration) in the active thread.
   * `incomplete` null/undefined clears any previous marker. */
  replaceMessageById: (
    messageId: string,
    content: string,
    incomplete?: IncompleteReason | null,
  ) => void;
  /** Per-thread composer attachments. */
  getThreadAttachments: (
    threadId: string,
  ) => { library: AttachedLibraryText[]; files: FileAttachment[] };
  setThreadAttachments: (
    threadId: string,
    patch: {
      library?: AttachedLibraryText[];
      files?: FileAttachment[];
    },
  ) => void;
  /**
   * Functional update of one thread's composer attachments. The updater
   * receives the CURRENT stored slot, so async writers (content loads,
   * parses) can never overwrite each other with a stale snapshot.
   */
  updateThreadAttachments: (
    threadId: string,
    updater: (prev: ThreadAttachments) => ThreadAttachments,
  ) => void;
  /** Drop attachments a completed request consumed (only those). */
  clearThreadAttachments: (
    threadId: string,
    consumed: { library: string[]; files: FileAttachment[] },
  ) => void;
}

// ──────────────────────────────────────────────
// Store implementation
// ──────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  brief: null,
  configLoaded: false,
  profiles: [],
  error: null,
  threadErrors: {},
  drafts: {},
  threadAttachments: {},
  briefIncludedByThread: {},
  threadSourcePicks: {},

  config: { ...defaultApiConfig },

  threads: [],
  threadsLoaded: false,

  activeThreadId: null,
  threadLoaded: true,

  // ── Messages ──

  addMessage: (msg) => {
    // Stable identity: every stored message gets an id once.
    const stored: ChatMessage = { id: msg.id ?? crypto.randomUUID(), ...msg };
    set((s) => ({ messages: [...s.messages, stored] }));
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
    // One debounced domain save carries the new message and the touched
    // metadata together; no separate metadata write that could land
    // without (or ahead of) the messages.
    scheduleThreadSave();
  },

  updateMessage: (key, updater) => {
    set((s) => ({
      messages: s.messages.map((m) => (messageKey(m) === key ? updater(m) : m)),
    }));
    scheduleThreadSave();
  },

  setBrief: (brief) => {
    set({ brief });
    scheduleThreadSave();
  },

  setThreadMode: async (mode, projectId) => {
    const s = get();
    if (!s.activeThreadId || s.messages.length > 0) return;
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === state.activeThreadId
          ? {
              ...t,
              mode,
              ...(projectId ? { projectId } : { projectId: undefined }),
              updatedAt: new Date().toISOString(),
            }
          : t,
      ),
    }));
    // Part of the thread's next debounced domain save — no separate
    // metadata write that could commit without the messages.
    scheduleThreadSave();
  },

  setThreadReferences: async (references) => {
    const s = get();
    if (!s.activeThreadId) return;
    const value = references.trim();
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === state.activeThreadId
          ? { ...t, references: value || undefined, updatedAt: new Date().toISOString() }
          : t,
      ),
    }));
    scheduleThreadSave();
  },

  // ── Threads ──

  loadThreadInventory: async () => {
    const threads = await repo.threadsList();
    threads.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    set({ threads, threadsLoaded: true });
  },

  loadThreads: async () => {
    // Concurrent callers (startup + the chat views) share one run so two
    // "no threads yet" observations cannot each create a thread.
    threadsLoadPromise ??= (async () => {
      await get().loadThreadInventory();

      // The active thread may have been removed (e.g. after a restore) or
      // never set: fall back to the most recent thread, or create one.
      const s = get();
      if (s.activeThreadId && s.threads.some((t) => t.id === s.activeThreadId)) {
        return;
      }
      if (s.threads.length > 0) {
        await get().switchThread(s.threads[0].id);
      } else {
        await get().createThread();
      }
    })().finally(() => {
      threadsLoadPromise = null;
    });
    await threadsLoadPromise;
  },

  reloadAfterRestore: async () => {
    // The restore's maintenance barrier already drained pending saves,
    // discarded held pre-restore ones, and reset the repository state
    // centrally — flushing here could write pre-restore state back.
    // Running AI operations are invalidated: a pre-restore completion can
    // never commit into the restored dataset.
    invalidateAllOperations();
    const threads = await repo.threadsList();
    threads.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    // The loaded conversation's in-memory messages predate the restore.
    set({
      threads,
      threadsLoaded: true,
      activeThreadId: null,
      messages: [],
      brief: null,
      threadLoaded: true,
      error: null,
      threadErrors: {},
      threadAttachments: {},
      threadSourcePicks: {},
      drafts: {},
    });
    // The restore discarded the pre-restore attachments: the persisted
    // composer state must not resurrect them.
    void setPref(ATTACHMENT_PREF_KEY, {}).catch(() => {});
    if (threads.length > 0) {
      await get().switchThread(threads[0].id);
    } else {
      await get().createThread();
    }
  },

  createThread: async () => {
    // Persist the outgoing thread's pending changes before replacing it.
    await repo.flushThreadSaves().catch(() => {
      // Failures stay retained in the repository for retry.
    });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const meta: ThreadMeta = {
      id,
      title: "Untitled conversation",
      mode: "text",
      createdAt: now,
      updatedAt: now,
    };
    // Creation is distinct from update: the row exists from now on, and
    // later saves are update-only (a deleted thread is never recreated).
    await repo.threadCreate(meta);
    set((s) => ({
      threads: [meta, ...s.threads],
      messages: [],
      brief: s.config.lastBrief ?? null,
      activeThreadId: id,
      threadLoaded: true,
      error: null,
    }));
    return id;
  },

  deleteThread: async (id) => {
    // The repository cancels the thread's pending debounced save, so the
    // deleted thread cannot resurrect through it.
    await repo.threadDelete(id);
    // Retained failed sends of a deleted conversation are meaningless:
    // their retry snapshot can never commit again.
    forgetFailedSendsForThread(id);
    const threads = get().threads.filter((t) => t.id !== id);
    set({ threads });

    const s = get();
    if (s.activeThreadId === id) {
      const { drafts, threadAttachments, threadSourcePicks, threadErrors } = s;
      delete drafts[id];
      delete threadAttachments[id];
      delete threadSourcePicks[id];
      delete threadErrors[id];
      scheduleAttachmentPersist(threadAttachments);
      set({ drafts, threadAttachments, threadSourcePicks, threadErrors });
      if (threads.length > 0) {
        await get().switchThread(threads[0].id);
      } else {
        await get().createThread();
      }
    } else {
      set((state) => {
        if (
          !(id in state.threadAttachments) &&
          !(id in state.threadSourcePicks) &&
          !(id in state.threadErrors)
        ) {
          return {};
        }
        const threadAttachments = { ...state.threadAttachments };
        const threadSourcePicks = { ...state.threadSourcePicks };
        const threadErrors = { ...state.threadErrors };
        delete threadAttachments[id];
        delete threadSourcePicks[id];
        delete threadErrors[id];
        scheduleAttachmentPersist(threadAttachments);
        return { threadAttachments, threadSourcePicks, threadErrors };
      });
    }
  },

  renameThread: async (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();
    await repo.threadRename(id, trimmed, now);
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === id ? { ...t, title: trimmed, updatedAt: now } : t,
      ),
    }));
  },

  /** Navigator organization (D3): pin/archive a conversation (metadata-only). */
  setThreadState: async (id, patch) => {
    const now = new Date().toISOString();
    await repo.threadSetState(id, patch, now);
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === id
          ? {
              ...t,
              ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
              ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
              updatedAt: now,
            }
          : t,
      ),
    }));
  },

  /** Move a conversation to a folder (metadata-only; null clears it). */
  setThreadFolder: async (id, folder) => {
    const normalized = folder?.trim() || null;
    const now = new Date().toISOString();
    await repo.threadSetFolder(id, normalized, now);
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === id
          ? {
              ...t,
              ...(normalized ? { folder: normalized } : { folder: undefined }),
              updatedAt: now,
            }
          : t,
      ),
    }));
  },

  switchThread: async (threadId) => {
    const current = get();
    if (current.activeThreadId === threadId && current.threadLoaded) {
      return true;
    }
    // Enter the loading state SYNCHRONOUSLY, before any await: the
    // workspace route may already point at the requested owner, and the
    // visible messages/composer must not keep showing the previous one.
    // Errors are per-thread: the requested owner's banner is restored,
    // never the previous conversation's.
    set({
      threadLoaded: false,
      activeThreadId: threadId,
      error: threadId ? (current.threadErrors[threadId] ?? null) : null,
    });
    // Persist the outgoing thread's pending changes before replacing it.
    // A failed flush stays retained in the repository for retry; it must
    // not strand the user on the current conversation.
    await repo.flushThreadSaves().catch(() => {});
    if (!threadId) {
      set({ messages: [], brief: null, threadLoaded: true });
      return true;
    }
    // Guard against out-of-order loads: selecting B then C must never let
    // B's slower load replace C's messages.
    const loadSeq = ++threadLoadSeq;
    const data = await repo.threadGet(threadId);
    if (loadSeq !== threadLoadSeq || get().activeThreadId !== threadId) {
      // A newer navigation owns the state now: report success only when
      // THIS request's owner ended up loaded; otherwise the caller's
      // fallback (thread list) applies.
      return get().activeThreadId === threadId;
    }
    if (!data) {
      // The requested owner does not exist (deleted or restored away).
      // Do NOT present an empty LOADED conversation under its id: the
      // loading state set above stays, so the caller's fallback (the
      // navigation action's thread-list selection) loads a real owner
      // instead of rendering a phantom empty chat (F10).
      return false;
    }
    set({
      messages: data.messages.map(storedToMessage),
      brief: data.briefJson ? parseBriefJson(data.briefJson) : null,
      threadLoaded: true,
    });
    return true;
  },

  // ── Config ──

  setConfig: async (cfg) => {
    // Non-credential fields only (the type forbids credentials and the
    // active profile): the one canonical writer for those is
    // `saveConnection`/`activateProfile`.
    const next = { ...get().config, ...cfg };
    set({ config: next });
    const { apiKey: _stripped, ...persistable } = next;
    await setPref("config", persistable);
  },

  loadConfig: async () => {
    // Preferences live in the SQLite table (migrated from config.json on
    // first load); the legacy file remains the fallback for old installs.
    let data = await getPref<ApiConfig>("config").catch(() => null);
    let legacyFileMigrated = false;
    if (data == null) {
      try {
        const legacy = await loadJson<ApiConfig>("config.json");
        if (legacy) {
          data = legacy;
          legacyFileMigrated = true;
          const { apiKey: _dropped, ...persistable } = legacy;
          void setPref("config", persistable).catch(() => {});
        }
      } catch {
        // Unreadable legacy file: start from defaults (the recovery
        // report path covers data loss).
      }
    }
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
    }

    // ── Profiles ────────────────────────────────────────────
    // A pre-profiles install has none: seed profile #1 from its config and
    // MOVE the credential into that profile's own account (verified write
    // first, old copy removed second — recoverability before cleanup).
    let profiles = sanitizeProfiles(
      await getPref(PROFILES_PREF).catch(() => null),
    );
    let seeded: { id: string; key: string | null; sessionOnly: boolean } | null =
      null;
    if (profiles.length === 0) {
      const provider = data?.provider ?? defaultApiConfig.provider;
      const baseUrl = data?.baseUrl ?? defaultApiConfig.baseUrl;
      let profile = makeProfile(getProvider(provider).label, provider, baseUrl);
      const endpointAccount = credentialAccount(provider, baseUrl);
      let key: string | null = null;
      let sessionOnly = false;
      // 1. The endpoint-keyed account (reading it also migrates a PRE-B17b
      //    all-lowercase account forward).
      const endpointKey = await loadCredential(provider, baseUrl);
      if (endpointKey) {
        if (await saveProfileCredential(profile.account, endpointKey)) {
          key = endpointKey;
          await deleteCredential(provider, baseUrl);
        } else {
          // The new account could not be written: keep the profile pointed
          // at the account where the key demonstrably still lives.
          profile = { ...profile, account: endpointAccount };
          key = endpointKey;
        }
      }
      // 2. The pre-R7 shared keychain entry and legacy plaintext, gated on
      //    provenance (see below).
      const declaredAccount =
        typeof data?.keychainAccount === "string" && data.keychainAccount
          ? data.keychainAccount
          : null;
      // Provenance: the persisted account reference records where the
      // session's key was stored. When it points at ANOTHER account (the
      // provider/endpoint were edited without re-saving, or a restore
      // brought a different profile), legacy shared/plaintext keys are NOT
      // migrated into this profile.
      const provenanceOk =
        declaredAccount == null || declaredAccount === endpointAccount;
      if (key == null && provenanceOk) {
        const legacy = await loadLegacyKey();
        const plaintext = await readLegacyPlaintextKey();
        const candidate = legacy ?? plaintext;
        if (candidate) {
          if (await saveProfileCredential(profile.account, candidate)) {
            key = candidate;
            if (legacy === candidate) await deleteLegacyKey();
            // F12: strip the plaintext file ONLY when it held the key that
            // was just stored. A different key in that file belongs to
            // another profile (or is a stale copy) and must survive.
            if (plaintext === candidate) await stripLegacyPlaintextKey();
          } else if (plaintext === candidate) {
            // Keychain unusable: session-only from the legacy file, which
            // stays untouched (recoverability).
            key = candidate;
            sessionOnly = true;
          }
        }
      }
      // 3. A config.json that still carried its own plaintext key.
      if (key == null && legacyFileMigrated && data?.apiKey) {
        key = data.apiKey;
        sessionOnly = true;
      }
      profiles = [profile];
      seeded = { id: profile.id, key, sessionOnly };
      await persistProfiles(profiles);
    }

    // The active profile is the remembered one, else the most recently
    // used. Its record is authoritative for provider/endpoint: the config
    // is only the flattened VIEW of it, so an unsaved edit in the settings
    // form cannot survive a restart as a half-applied connection.
    const active = pickDefaultProfile(profiles, data?.activeProfileId);
    if (!active) {
      set({
        config: { ...defaultApiConfig },
        profiles: [],
        configLoaded: true,
      });
      return;
    }
    // Resolve ONLY the active profile's key into memory. Every other
    // profile's secret is read by Rust, on request, and never crosses into
    // the webview.
    const key =
      seeded && seeded.id === active.id
        ? seeded.key
        : await loadProfileCredential(active.account);
    const sessionOnly = seeded && seeded.id === active.id ? seeded.sessionOnly : false;
    const base: ApiConfig = data ?? { ...defaultApiConfig };
    const nextConfig: ApiConfig = {
      ...base,
      provider: active.provider,
      baseUrl: active.baseUrl,
      model: base.model || active.lastModel || getProvider(active.provider).defaultModel,
      apiKey: key ?? "",
      keychainAccount: key != null && !sessionOnly ? active.account : null,
      sessionKeyOnly: sessionOnly,
      activeProfileId: active.id,
      reasoningEffort: base.reasoningEffort ?? null,
      webSearchEnabled: base.webSearchEnabled ?? true,
      deepResearchEnabled: base.deepResearchEnabled ?? false,
      systemPromptMode: base.systemPromptMode ?? "standard",
      customSystemPrompt: base.customSystemPrompt ?? "",
      lastBrief: base.lastBrief ?? null,
    };
    set({ config: nextConfig, profiles, configLoaded: true });
    const { apiKey: _stripped, ...persistable } = nextConfig;
    if (JSON.stringify(persistable) !== JSON.stringify(data)) {
      await setPref("config", persistable);
    }
  },

  resetConfig: () => {
    set({
      config: { ...defaultApiConfig },
      profiles: [],
      configLoaded: false,
    });
  },

  saveConnection: async (input) => {
    const { profiles, config } = get();
    const provider = input.provider;
    const baseUrl = input.baseUrl.trim() || getProvider(provider).defaultBaseUrl;
    const existing = input.profileId
      ? (profiles.find((p) => p.id === input.profileId) ?? null)
      : null;
    if (input.profileId && !existing) {
      return { ok: false, reason: "unknown-profile" };
    }
    // A profile whose provider/endpoint the caller CHANGED is stored as a
    // NEW profile: its key belongs to the old endpoint and must never
    // follow it to a different one. The new profile is auto-named (the
    // caller's name belongs to the profile that keeps the old endpoint),
    // which is also what the settings form shows.
    const moved =
      existing != null && !isSameEndpoint(existing, { provider, baseUrl });
    const target = existing && !moved ? existing : null;
    const typedName = moved ? "" : normalizeProfileName(input.name);
    if (typedName) {
      if (
        profiles.some(
          (p) => p.id !== target?.id && p.name.toLowerCase() === typedName.toLowerCase(),
        )
      ) {
        return { ok: false, reason: "duplicate-name" };
      }
    }
    // A profile the caller did not name gets the provider's label, made
    // unique rather than refused.
    const name =
      typedName ||
      uniqueProfileName(
        target ? target.name : defaultProfileName(provider),
        profiles.filter((p) => p.id !== target?.id),
      );
    const typed = input.apiKey.trim();
    if (!typed && !target) return { ok: false, reason: "no-key" };

    const profile: CredentialProfile = target
      ? { ...target, name, baseUrl }
      : makeProfile(name, provider, baseUrl);
    const model = input.model?.trim() || target?.lastModel || config.model;
    let key = typed;
    let sessionKeyOnly = false;
    if (typed) {
      if (await saveProfileCredential(profile.account, typed)) {
        // The keychain copy is verified: legacy plaintext copies of THIS
        // key can now be removed (recoverability was preserved until here).
        // A legacy entry holding a DIFFERENT profile's key stays.
        const legacy = await loadLegacyKey();
        if (legacy === typed) await deleteLegacyKey();
        const legacyFile = await readLegacyPlaintextKey();
        if (legacyFile === typed) await stripLegacyPlaintextKey();
      } else {
        // Secure storage unavailable: session-only credential.
        sessionKeyOnly = true;
      }
    } else {
      // No key typed: keep whatever this profile already has stored.
      key = (await loadProfileCredential(profile.account)) ?? "";
    }
    const stamped = { ...profile, lastModel: model, lastUsedAt: Date.now() };
    const nextProfiles = target
      ? profiles.map((p) => (p.id === target.id ? stamped : p))
      : [...profiles, stamped];
    const nextConfig = flattenProfile(config, stamped, key, sessionKeyOnly, model);
    set({ profiles: nextProfiles, config: nextConfig });
    await persistProfiles(nextProfiles);
    const { apiKey: _stripped, ...persistable } = nextConfig;
    await setPref("config", persistable);
    return { ok: true, sessionKeyOnly, profileId: stamped.id };
  },

  activateProfile: async (id, model) => {
    const { profiles, config } = get();
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return false;
    const key = await loadProfileCredential(profile.account);
    const resolvedModel =
      model?.trim() ||
      profile.lastModel ||
      getProvider(profile.provider).defaultModel;
    const nextProfiles = profiles.map((p) =>
      p.id === id ? { ...p, lastModel: resolvedModel, lastUsedAt: Date.now() } : p,
    );
    const nextConfig = flattenProfile(
      config,
      profile,
      key,
      false,
      resolvedModel,
    );
    set({ profiles: nextProfiles, config: nextConfig });
    await persistProfiles(nextProfiles);
    const { apiKey: _stripped, ...persistable } = nextConfig;
    await setPref("config", persistable);
    return true;
  },

  renameProfile: async (id, name) => {
    const { profiles } = get();
    const target = profiles.find((p) => p.id === id);
    if (!target) return false;
    const next = normalizeProfileName(name);
    if (!next) return false;
    if (
      profiles.some(
        (p) => p.id !== id && p.name.toLowerCase() === next.toLowerCase(),
      )
    ) {
      return false;
    }
    const nextProfiles = profiles.map((p) => (p.id === id ? { ...p, name: next } : p));
    set({ profiles: nextProfiles });
    await persistProfiles(nextProfiles);
    return true;
  },

  deleteProfile: async (id) => {
    const { profiles, config } = get();
    const target = profiles.find((p) => p.id === id);
    // The last profile cannot go: an app with no key is not a state the
    // user can recover from inside the app.
    if (!target || profiles.length <= 1) return false;
    await deleteProfileCredential(target.account);
    const remaining = profiles.filter((p) => p.id !== id);
    set({ profiles: remaining });
    await persistProfiles(remaining);
    if (config.activeProfileId === id) {
      const replacement = pickDefaultProfile(remaining);
      if (replacement) await get().activateProfile(replacement.id);
    }
    return true;
  },

  forgetProfileKey: async (id) => {
    const { profiles, config } = get();
    const target = profiles.find((p) => p.id === id);
    if (!target) return;
    await deleteProfileCredential(target.account);
    // Forgetting another profile's key must leave the active one alone
    // (we do not know the other profile's secret, so nothing else is
    // touched).
    if (config.activeProfileId !== id) return;
    // F12: legacy copies are only attributable to the ACTIVE profile's
    // in-memory key.
    if (config.apiKey) {
      const legacy = await loadLegacyKey();
      if (legacy === config.apiKey) await deleteLegacyKey();
      const plaintext = await readLegacyPlaintextKey();
      if (plaintext === config.apiKey) await stripLegacyPlaintextKey();
    }
    const next = {
      ...config,
      apiKey: "",
      keychainAccount: null,
      sessionKeyOnly: false,
    };
    set({ config: next });
    const { apiKey: _stripped, ...persistable } = next;
    await setPref("config", persistable);
  },

  forgetCredential: async () => {
    const { config } = get();
    if (!config.activeProfileId) return;
    await get().forgetProfileKey(config.activeProfileId);
  },

  // ── Sending state ──

  setError: (error) => {
    // The active thread's banner IS that thread's entry in threadErrors —
    // one canonical writer (setThreadError) maintains both.
    const threadId = get().activeThreadId;
    if (threadId) get().setThreadError(threadId, error);
    else set({ error });
  },

  setThreadError: (threadId, error) =>
    set((s) => {
      const threadErrors = { ...s.threadErrors };
      if (error) threadErrors[threadId] = error;
      else delete threadErrors[threadId];
      return {
        threadErrors,
        ...(s.activeThreadId === threadId ? { error } : {}),
      };
    }),

  setDraft: (value) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [get().activeThreadId ?? ""]: value,
      },
    })),

  appendAssistantToThread: async (threadId, content, incomplete) => {
    const now = new Date().toISOString();
    // The repository flushes the thread's pending save first, then appends
    // atomically, so the appended reply cannot be overwritten.
    await repo.threadAppendMessage(
      threadId,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content,
        timestamp: now,
        failed: false,
        incomplete: incomplete ?? null,
        attachmentsJson: null,
      },
      now,
    );
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, updatedAt: now } : t,
      ),
    }));
  },

  replaceMessageById: (messageId, content, incomplete) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId
          ? { ...m, content, incomplete: incomplete ?? undefined }
          : m,
      ),
    }));
    scheduleThreadSave();
  },

  commitToOwner: async (threadId, commit) => {
    const s = get();
    // Ownership checks BEFORE every terminal update: a deleted owner or a
    // dataset restored away invalidates the operation's commit.
    if (!s.threads.some((t) => t.id === threadId)) return false;
    const now = new Date().toISOString();
    if (s.activeThreadId === threadId && s.threadLoaded) {
      if (commit.kind === "append") {
        s.addMessage({
          role: "assistant",
          content: commit.content,
          timestamp: now,
          ...(commit.incomplete ? { incomplete: commit.incomplete } : {}),
        });
      } else {
        s.replaceMessageById(
          commit.messageId,
          commit.content,
          commit.incomplete ?? null,
        );
      }
      return true;
    }
    // The owner is not visible: commit through the repository so the
    // reply lands on the persisted thread (append is atomic; replace
    // targets the stable message id).
    if (commit.kind === "append") {
      await get().appendAssistantToThread(
        threadId,
        commit.content,
        commit.incomplete,
      );
    } else {
      await repo.threadReplaceMessage(
        threadId,
        commit.messageId,
        commit.content,
        commit.incomplete ?? null,
        now,
      );
      set((state) => ({
        threads: state.threads.map((t) =>
          t.id === threadId ? { ...t, updatedAt: now } : t,
        ),
      }));
    }
    return true;
  },

  getThreadAttachments: (threadId) =>
    get().threadAttachments[threadId] ?? { library: [], files: [] },

  toggleBriefInclude: (projectId) =>
    set((s) => ({
      briefIncludedByThread: {
        ...s.briefIncludedByThread,
        [projectId]: !(s.briefIncludedByThread[projectId] ?? true),
      },
    })),

  setThreadSourcePick: (threadId, sourceIds) =>
    set((s) => ({
      // An EXPLICIT empty pick is meaningful: "send no sources". It lasts
      // until clearThreadSourcePick (undefined = follow the Sources panel).
      threadSourcePicks: { ...s.threadSourcePicks, [threadId]: [...sourceIds] },
    })),

  clearThreadSourcePick: (threadId) =>
    set((s) => {
      if (!(threadId in s.threadSourcePicks)) return {};
      const { [threadId]: _drop, ...rest } = s.threadSourcePicks;
      return { threadSourcePicks: rest };
    }),

  setThreadAttachments: (threadId, patch) =>
    set((s) => {
      const existing = s.threadAttachments[threadId] ?? {
        library: [],
        files: [],
      };
      const threadAttachments = {
        ...s.threadAttachments,
        [threadId]: {
          library: patch.library ?? existing.library,
          files: patch.files ?? existing.files,
        },
      };
      scheduleAttachmentPersist(threadAttachments);
      return { threadAttachments };
    }),

  updateThreadAttachments: (threadId, updater) =>
    set((s) => {
      const existing = s.threadAttachments[threadId] ?? {
        library: [],
        files: [],
      };
      const next = updater(existing);
      if (next === existing) return {};
      const threadAttachments = { ...s.threadAttachments, [threadId]: next };
      scheduleAttachmentPersist(threadAttachments);
      return { threadAttachments };
    }),

  clearThreadAttachments: (threadId, consumed) =>
    set((s) => {
      const existing = s.threadAttachments[threadId];
      if (!existing) return {};
      const threadAttachments = {
        ...s.threadAttachments,
        [threadId]: {
          library: existing.library.filter(
            (a) => !consumed.library.includes(a.id),
          ),
          files: existing.files.filter(
            (f) => !consumed.files.some((c) => c.name === f.name),
          ),
        },
      };
      scheduleAttachmentPersist(threadAttachments);
      return { threadAttachments };
    }),
}));

// ──────────────────────────────────────────────
// Composer attachment persistence (R8 note, D2)
// ──────────────────────────────────────────────
// Unsent composer attachments survive RESTARTS the way drafts do: they
// persist through the preferences table (debounced; flushed by the
// shutdown/relaunch drains). Attachments are application state, never
// domain data. Extracted texts can be large, so persistence is BOUNDED:
// threads whose extracted text exceeds the budget are kept in memory for
// the session but not persisted (the message history itself still
// carries whatever was actually sent).

export type ThreadAttachments = {
  library: AttachedLibraryText[];
  files: FileAttachment[];
};

/** Total extracted-text characters persisted (a memory bound, not a feature). */
const ATTACHMENT_PERSIST_CHAR_BUDGET = 512_000;

const ATTACHMENT_PREF_KEY = "composer-attachments";

let attachmentPersistTimer: ReturnType<typeof setTimeout> | null = null;
/** The last preference write this store STARTED (fired debounce). */
let attachmentPersistChain: Promise<void> = Promise.resolve();
let attachmentsHydrated = false;

function attachmentChars(entry: ThreadAttachments): number {
  return (
    entry.library.reduce((sum, a) => sum + a.content.length, 0) +
    entry.files.reduce((sum, f) => sum + f.content.length, 0)
  );
}

function scheduleAttachmentPersist(map: Record<string, ThreadAttachments>) {
  if (attachmentPersistTimer) clearTimeout(attachmentPersistTimer);
  attachmentPersistTimer = setTimeout(() => {
    attachmentPersistTimer = null;
    persistAttachmentsNow(map);
  }, 300);
}

function persistAttachmentsNow(map: Record<string, ThreadAttachments>): void {
  // Keep within the budget: skip oversized threads (largest first), never
  // silently truncate the CONTENT itself.
  const budget = ATTACHMENT_PERSIST_CHAR_BUDGET;
  const entries = Object.entries(map)
    .map(([id, entry]) => ({ id, entry, chars: attachmentChars(entry) }))
    .sort((a, b) => a.chars - b.chars);
  const kept: Record<string, ThreadAttachments> = {};
  let total = 0;
  for (const { id, entry, chars } of entries) {
    if (total + chars > budget) continue;
    kept[id] = entry;
    total += chars;
  }
  attachmentPersistChain = setPref(ATTACHMENT_PREF_KEY, kept).catch(() => {
    // A failed persistence write keeps the in-memory attachments and
    // retains the payload in the preference layer; a drain surfaces it.
  });
}

/** Hydrate persisted composer attachments (call once at startup). */
export async function hydrateComposerAttachments(): Promise<void> {
  if (attachmentsHydrated) return;
  attachmentsHydrated = true;
  let persisted: Record<string, ThreadAttachments> | null = null;
  try {
    persisted = await getPref<Record<string, ThreadAttachments>>(
      ATTACHMENT_PREF_KEY,
    );
  } catch {
    persisted = null; // unreadable: start clean
  }
  if (persisted) {
    useChatStore.setState({ threadAttachments: persisted });
  }
}

/** Test seam: forget the hydrated flag (a later hydrate re-reads prefs). */
export function resetComposerAttachmentHydration(): void {
  attachmentsHydrated = false;
}

/**
 * Flush the pending attachment persistence (part of the shutdown and
 * relaunch drains: a restart must restore unsent composer attachments).
 * Waits for a write that ALREADY started, not only a pending debounce.
 */
export async function flushComposerAttachments(): Promise<void> {
  if (attachmentPersistTimer) {
    clearTimeout(attachmentPersistTimer);
    attachmentPersistTimer = null;
    persistAttachmentsNow(useChatStore.getState().threadAttachments);
  }
  await attachmentPersistChain;
}
