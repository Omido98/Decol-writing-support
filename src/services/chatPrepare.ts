import {
  useChatStore,
  messageKey,
  type ApiConfig,
  type ChatMessage,
  type FileAttachment,
} from "@/stores/chatStore";
import { useProjectStore } from "@/stores/projectStore";
import { useSourceStore } from "@/stores/sourceStore";
import { collectReferences } from "@/utils/references";
import {
  buildSystemPrompt,
  buildProjectBriefPrompt,
} from "@/utils/systemPrompt";
import {
  compileContext,
  applySourcePicks,
  type CompiledContext,
  type ContextSourceInput,
} from "@/services/contextCompiler";
import type { ConsumedAttachments } from "@/services/aiOperations";
import type { ThreadMode } from "@/types";

// ──────────────────────────────────────────────
// Prepared chat request (B14)
// ──────────────────────────────────────────────
// ONE builder resolves everything a send needs — instruction/history
// boundary, project brief, library/library attachments, pending uploads,
// and the source scope with the per-thread pick — and compiles the
// provider payload + manifest together. The transport sends EXACTLY the
// prepared object; the preview renders EXACTLY its compiled manifest.
// Fresh/retry/regenerate have distinct boundary rules:
//   fresh       instruction = typed text, history = current messages
//   retry       instruction = the failed user message, history = before it
//   regenerate  instruction = the user message BEFORE the reply,
//               history = before that message (the old answer is never
//               compiled as a new instruction)
// The store is re-read AFTER every await (source hydration, brief load):
// a cold load or a navigation can never leave the payload disagreeing
// with the manifest.

export type ChatOperationKind = "fresh" | "retry" | "regenerate";

export interface PrepareChatInput {
  kind: ChatOperationKind;
  /** fresh: the typed text. */
  text?: string;
  /** retry: key of the failed user message to send again. */
  resendKey?: string;
  /** regenerate: key of the assistant message to replace. */
  regenerateKey?: string;
  /** Pending uploads for a fresh send (defaults to the thread's slot). */
  files?: FileAttachment[];
}

export interface PreparedChatRequest {
  kind: ChatOperationKind;
  threadId: string;
  mode: ThreadMode;
  projectId: string | null;
  /** The instruction actually sent (last user message on the wire). */
  instruction: string;
  /** Prior conversation only (the instruction is NOT included). */
  history: ChatMessage[];
  /** The full wire conversation: history + the instruction. */
  wireMessages: ChatMessage[];
  /** Realized base system prompt (before sources/manuscript are appended). */
  systemPrompt: string;
  /** The payload + manifest; `compiled.messages[0]` is the wire system. */
  compiled: CompiledContext;
  consumedAttachments: ConsumedAttachments;
  config: ApiConfig;
}

/**
 * The instruction/history boundary for one operation. Returns null when
 * the operation cannot be prepared (no text, missing target, empty
 * instruction).
 */
export function resolveInstructionBoundary(
  messages: ChatMessage[],
  kind: ChatOperationKind,
  keys: { text?: string; resendKey?: string; regenerateKey?: string },
): { instruction: string; history: ChatMessage[]; target?: ChatMessage } | null {
  if (kind === "fresh") {
    const instruction = (keys.text ?? "").trim();
    if (!instruction) return null;
    return { instruction, history: [...messages] };
  }
  const key = kind === "retry" ? keys.resendKey : keys.regenerateKey;
  if (!key) return null;
  const index = messages.findIndex((m) => messageKey(m) === key);
  if (index < 0) return null;

  if (kind === "retry") {
    const target = messages[index];
    if (target.role !== "user" || !target.content.trim()) return null;
    return {
      instruction: target.content.trim(),
      history: messages.slice(0, index),
      target,
    };
  }

  // Regenerate: the old assistant answer is replaced; the instruction is
  // the user message that produced it (NEVER the answer itself).
  let userIndex = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0 || !messages[userIndex].content.trim()) return null;
  return {
    instruction: messages[userIndex].content.trim(),
    history: messages.slice(0, userIndex),
    target: messages[userIndex],
  };
}

/** Source inputs in scope for a thread (project-linked or standalone). */
export function scopedSourceInputs(
  sources: {
    id: string;
    title: string;
    originalText: string;
    includedInContext: boolean;
    projectId?: string;
  }[],
  projectId: string | null,
): ContextSourceInput[] {
  return sources
    .filter((s) => (projectId ? s.projectId === projectId : !s.projectId))
    .map((s) => ({
      id: s.id,
      title: s.title,
      content: s.originalText,
      included: s.includedInContext,
    }));
}

/** Build the prepared request, or null when it cannot be prepared. */
export async function prepareChatRequest(
  input: PrepareChatInput,
): Promise<PreparedChatRequest | null> {
  const initial = useChatStore.getState();
  const threadId = initial.activeThreadId;
  if (!threadId || !initial.threadLoaded) return null;

  const boundary = resolveInstructionBoundary(initial.messages, input.kind, {
    text: input.text,
    resendKey: input.resendKey,
    regenerateKey: input.regenerateKey,
  });
  if (!boundary) return null;

  const snapshotThread = initial.threads.find((t) => t.id === threadId);
  const mode: ThreadMode = snapshotThread?.mode ?? "text";
  const projectId = snapshotThread?.projectId ?? null;
  const slot = initial.getThreadAttachments(threadId);
  const pendingFiles =
    input.kind === "fresh" ? (input.files ?? slot.files) : [];
  // Uploads that ride with the instruction (a fresh composer upload or the
  // attachments of the message being retried/regenerated).
  const rideFiles =
    input.kind === "fresh"
      ? pendingFiles
      : (boundary.target?.fileAttachments ?? []);

  // ── Hydrate first, then RE-READ: a cold source load must be included ──
  await useSourceStore.getState().ensureLoaded();
  const afterSources = useChatStore.getState();
  if (afterSources.activeThreadId !== threadId) return null;
  const threadNow =
    afterSources.threads.find((t) => t.id === threadId) ?? snapshotThread;
  const modeNow: ThreadMode = threadNow?.mode ?? mode;
  const projectIdNow = threadNow?.projectId ?? projectId;

  const project = projectIdNow
    ? useProjectStore.getState().projects.find((p) => p.id === projectIdNow)
    : null;

  // The brief is loaded (cached) for text threads that include it.
  let projectBriefContent: string | null = null;
  if (
    modeNow !== "project" &&
    projectIdNow &&
    (afterSources.briefIncludedByThread[projectIdNow] ?? true)
  ) {
    projectBriefContent =
      (await useProjectStore.getState().loadBriefContent(projectIdNow)) || null;
  }

  // Re-read once more after the awaited brief load.
  const state = useChatStore.getState();
  if (state.activeThreadId !== threadId) return null;

  const uploadedFiles = [
    ...boundary.history.flatMap((m) => m.fileAttachments ?? []),
    ...rideFiles,
  ];
  const attachedTexts = slot.library.map(({ title, textType, content }) => ({
    title,
    textType,
    content,
  }));

  const baseSystemPrompt =
    modeNow === "project"
      ? buildProjectBriefPrompt({
          references: project?.references ?? null,
          attachedTexts,
          uploadedFiles,
        })
      : buildSystemPrompt({
          mode: state.config.systemPromptMode ?? "standard",
          customPrompt: state.config.customSystemPrompt ?? "",
          deepResearch: state.config.deepResearchEnabled ?? false,
          brief: state.brief,
          attachedTexts,
          projectBriefContent,
          uploadedFiles,
          references: collectReferences(threadNow, project),
        });

  // Sources: re-read AFTER hydration; undefined pick = panel inclusion,
  // [] = explicitly none.
  const sources = applySourcePicks(
    scopedSourceInputs(useSourceStore.getState().sources, projectIdNow),
    state.threadSourcePicks[threadId],
  );

  const compiled = compileContext({
    systemPrompt: baseSystemPrompt,
    history: boundary.history.map((m) => ({ role: m.role, content: m.content })),
    instruction: boundary.instruction,
    sources,
    attachments: {
      textCount: slot.library.length,
      fileCount: uploadedFiles.length,
    },
    model: state.config.model,
  });

  const instructionTimestamp = new Date().toISOString();
  const wireMessages: ChatMessage[] = compiled.messages
    .slice(1)
    .map((m, i) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
      timestamp: boundary.history[i]?.timestamp ?? instructionTimestamp,
    }));

  return {
    kind: input.kind,
    threadId,
    mode: modeNow,
    projectId: projectIdNow,
    instruction: boundary.instruction,
    history: boundary.history.map((m) => ({ ...m })),
    wireMessages,
    systemPrompt: baseSystemPrompt,
    compiled,
    consumedAttachments: {
      library: slot.library.map((a) => a.id),
      files: rideFiles,
    },
    config: { ...state.config },
  };
}
