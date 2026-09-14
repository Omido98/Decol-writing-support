import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatStore, messageKey, type ChatMessage, type FileAttachment } from "@/stores/chatStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { sendMessage } from "@/utils/api";
import {
  buildSystemPrompt,
  buildProjectBriefPrompt,
  composeProjectStartMessage,
} from "@/utils/systemPrompt";
import { parseFile } from "@/utils/fileParse";
import { estimateTokens } from "@/utils/tokens";
import ChatSettings from "@/components/chat/ChatSettings";
import MessageList from "@/components/chat/MessageList";
import MessageInput from "@/components/chat/MessageInput";
import AttachmentPicker from "@/components/library/AttachmentPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import type {
  AttachedLibraryText,
  ProjectMeta,
  ThreadMeta,
  ThreadMode,
  WritingBrief,
} from "@/types";
import { composeBriefMessage, defaultBrief } from "@/utils/brief";
import {
  BookMarked,
  ClipboardList,
  FolderOpen,
  MessageSquarePlus,
  PencilLine,
  Settings,
  Trash2,
} from "lucide-react";
import BriefForm from "@/components/chat/BriefForm";

interface ChatTabProps {
  /** Opens the general Settings dialog (used to configure the API). */
  onOpenSettings: () => void;
}

/**
 * Collect the reference entries for a thread: its own free-text
 * references plus, when linked, its project's. Used for both the token
 * estimate and the actual send, so the two always agree.
 */
function collectReferences(
  thread: ThreadMeta | null | undefined,
  project: ProjectMeta | null | undefined,
): { source: string; content: string }[] {
  const refs: { source: string; content: string }[] = [];
  const threadRefs = thread?.references?.trim();
  if (threadRefs) {
    refs.push({
      source: "References for this text (provided before the chat started)",
      content: threadRefs,
    });
  }
  const projectRefs = project?.references?.trim();
  if (projectRefs) {
    refs.push({
      source: `References of project “${project!.title}”`,
      content: projectRefs,
    });
  }
  return refs;
}

/** Empty-thread picker: what should this conversation do? */
function ModePicker({ onPick }: { onPick: (mode: ThreadMode) => void }) {
  const modes: { id: ThreadMode; icon: typeof BookMarked; title: string; body: string }[] = [
    {
      id: "text",
      icon: BookMarked,
      title: "Write a text",
      body: "Draft, revise, or extend a single text — standalone or inside a project.",
    },
    {
      id: "project",
      icon: FolderOpen,
      title: "Develop a project brief",
      body: "Define a project: purpose, audience, structure, and the brief its texts share.",
    },
  ];
  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto space-y-4">
        <p className="text-text-muted text-sm">What are we working on?</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {modes.map(({ id, icon: Icon, title, body }) => (
            <button
              key={id}
              type="button"
              onClick={() => void onPick(id)}
              className="flex flex-col items-start gap-2 rounded-lg border border-border bg-surface px-5 py-4 text-left cursor-pointer hover:border-primary/40 transition-colors"
            >
              <Icon className="size-5 text-primary" />
              <span className="font-semibold text-text-primary">{title}</span>
              <span className="text-sm text-text-secondary">{body}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
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
  const brief = useChatStore((s) => s.brief);
  const setBrief = useChatStore((s) => s.setBrief);
  const setThreadMode = useChatStore((s) => s.setThreadMode);
  const setConfig = useChatStore((s) => s.setConfig);
  const isSending = useChatStore((s) => s.isSending);
  const setIsSending = useChatStore((s) => s.setIsSending);
  const setError = useChatStore((s) => s.setError);
  const setStreamingText = useChatStore((s) => s.setStreamingText);
  const inputValue = useChatStore(
    (s) => s.drafts[s.activeThreadId ?? ""] ?? "",
  );
  const setDraft = useChatStore((s) => s.setDraft);
  const messages = useChatStore((s) => s.messages);

  // ── Projects ──
  const projects = useProjectStore((s) => s.projects);
  const projectsLoaded = useProjectStore((s) => s.projectsLoaded);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const pendingBriefProjectId = useProjectStore((s) => s.pendingBriefProjectId);
  const clearPendingBriefChat = useProjectStore((s) => s.clearPendingBriefChat);

  // ── Library attachments (applied to the next send only) ──
  const pendingAttachId = useLibraryStore((s) => s.pendingAttachId);
  const libraryTexts = useLibraryStore((s) => s.texts);
  const libraryTextsLoaded = useLibraryStore((s) => s.textsLoaded);
  const clearPendingAttach = useLibraryStore((s) => s.clearPendingAttach);
  const [attachments, setAttachments] = useState<AttachedLibraryText[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  // ── Uploaded documents (extracted text, applied to the next send) ──
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;
  const threadMode: ThreadMode = activeThread?.mode ?? "text";
  const isProjectThread = threadMode === "project";
  const threadProjectId = activeThread?.projectId ?? null;
  const threadProject = threadProjectId
    ? (projects.find((p) => p.id === threadProjectId) ?? null)
    : null;
  /** Derived empty-thread choice: which project the text belongs to. */
  const textProjectChoice = threadProjectId ?? "standalone";

  // ── Project brief inclusion toggle (text threads in a project) ──
  const [briefIncludedByThread, setBriefIncludedByThread] = useState<
    Record<string, boolean>
  >({});
  const projectBriefIncluded = threadProjectId
    ? (briefIncludedByThread[threadProjectId] ?? true)
    : false;

  // The project brief content itself (loaded on demand).
  const [projectBriefContent, setProjectBriefContent] = useState<string>("");

  // Drop attachments whose underlying text was deleted in the library.
  useEffect(() => {
    if (!libraryTextsLoaded) return;
    setAttachments((prev) =>
      prev.filter((a) => libraryTexts.some((t) => t.id === a.id)),
    );
  }, [libraryTexts, libraryTextsLoaded]);

  /** Load and add a library text as an attachment (idempotent). */
  const addAttachment = useCallback(async (id: string) => {
    if (!useLibraryStore.getState().textsLoaded) {
      await useLibraryStore.getState().loadTexts();
    }
    const store = useLibraryStore.getState();
    const meta = store.texts.find((t) => t.id === id);
    if (!meta) return;
    const content = await store.loadTextContent(id);
    setAttachments((prev) =>
      prev.some((a) => a.id === id)
        ? prev
        : [
            ...prev,
            { id: meta.id, title: meta.title, textType: meta.textType, content },
          ],
    );
  }, []);

  // Consume the "Ask the chat" handoff from the library tab.
  useEffect(() => {
    if (!pendingAttachId) return;
    const id = pendingAttachId;
    clearPendingAttach();
    void addAttachment(id);
  }, [pendingAttachId, clearPendingAttach, addAttachment]);

  const handleAttachmentsConfirmed = useCallback(
    (ids: string[]) => {
      for (const id of ids) void addAttachment(id);
      // Also drop attachments the user unchecked in the picker.
      setAttachments((prev) => prev.filter((a) => ids.includes(a.id)));
    },
    [addAttachment],
  );

  // ── File uploads: extract text, keep it for the next send ──
  const handleUploadFiles = useCallback(async (files: FileList) => {
    setUploadingFiles(true);
    for (const file of Array.from(files)) {
      try {
        const parsed = await parseFile(file);
        setFileAttachments((prev) =>
          prev.some((f) => f.name === parsed.name)
            ? prev
            : [
                ...prev,
                {
                  name: parsed.name,
                  kind: parsed.kind,
                  content: parsed.content,
                  wordCount: parsed.wordCount,
                },
              ],
        );
      } catch (err) {
        setError(
          err instanceof Error
            ? `Could not read ${file.name}: ${err.message}`
            : `Could not read ${file.name}.`,
        );
      }
    }
    setUploadingFiles(false);
  }, [setError]);

  // ── Live estimate of the input tokens the next send would consume ──
  const threadFiles = useMemo(
    () => messages.flatMap((m) => m.fileAttachments ?? []),
    [messages],
  );

  /** Reference entries for the active thread: its own + the project's. */
  const activeReferences = useMemo(
    () => collectReferences(activeThread, threadProject),
    [activeThread, threadProject],
  );

  const tokenEstimate = useMemo(() => {
    const prompt = isProjectThread
      ? buildProjectBriefPrompt({
          references: threadProject?.references ?? null,
        })
      : buildSystemPrompt({
          mode: config.systemPromptMode ?? "standard",
          customPrompt: config.customSystemPrompt ?? "",
          deepResearch: config.deepResearchEnabled ?? false,
          brief,
          attachedTexts: attachments.map(({ title, textType, content }) => ({
            title,
            textType,
            content,
          })),
          projectBriefContent:
            threadProjectId && projectBriefIncluded ? projectBriefContent : null,
          uploadedFiles: threadFiles,
          references: activeReferences,
        });
    const historyText = messages.map((m) => m.content).join("\n");
    return estimateTokens(`${prompt}\n${historyText}\n${inputValue}`);
  }, [
    messages,
    inputValue,
    isProjectThread,
    config.systemPromptMode,
    config.customSystemPrompt,
    config.deepResearchEnabled,
    brief,
    attachments,
    threadProjectId,
    projectBriefIncluded,
    projectBriefContent,
    threadFiles,
    activeReferences,
    threadProject,
  ]);

  // ── Input state ──
  const [showConfig, setShowConfig] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ── Writing brief (edit dialog for a started thread) ──
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefDraft, setBriefDraft] = useState<WritingBrief | null>(null);

  // ── Text-mode start: project selection is derived (textProjectChoice) ──
  // Free-text references the user gives before the text thread starts.
  const [startReferences, setStartReferences] = useState("");

  // ── Project-mode start: seed form ──
  const [projectChoice, setProjectChoice] = useState<string>("__new__");
  const [seedTitle, setSeedTitle] = useState("");
  const [seedDescription, setSeedDescription] = useState("");
  const [seedIdeas, setSeedIdeas] = useState("");
  const [seedReferences, setSeedReferences] = useState("");

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

  // ── Load the project list (for pickers and chips) ──
  useEffect(() => {
    if (!projectsLoaded) void loadProjects();
  }, [projectsLoaded, loadProjects]);

  // ── Consume the "develop this project's brief" handoff ──
  useEffect(() => {
    if (!pendingBriefProjectId) return;
    const projectId = pendingBriefProjectId;
    clearPendingBriefChat();
    void (async () => {
      // The thread picker restores the newest thread on mount; start a
      // fresh one so the handoff lands in an empty thread.
      await createThread();
      await setThreadMode("project", projectId);
    })();
  }, [pendingBriefProjectId, clearPendingBriefChat, createThread, setThreadMode]);

  // ── Load the linked project's brief when it changes ──
  useEffect(() => {
    let cancelled = false;
    if (!threadProjectId) {
      setProjectBriefContent("");
      return;
    }
    void useProjectStore
      .getState()
      .loadBriefContent(threadProjectId)
      .then((content) => {
        if (!cancelled) setProjectBriefContent(content);
      });
    return () => {
      cancelled = true;
    };
  }, [threadProjectId]);

  // ── Reset per-thread input state when switching threads ──
  useEffect(() => {
    setFileAttachments([]);
    setProjectChoice(activeThread?.projectId ?? "__new__");
    setSeedTitle("");
    setSeedDescription("");
    setSeedIdeas("");
    setStartReferences("");
    setSeedReferences("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  // ── Prefill the seed references when an existing project is chosen ──
  useEffect(() => {
    if (projectChoice === "__new__") {
      setSeedReferences("");
      return;
    }
    const project = projects.find((p) => p.id === projectChoice);
    setSeedReferences(project?.references ?? "");
  }, [projectChoice, projects]);

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
        files?: FileAttachment[];
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
      // until the new one is ready. Uploaded documents travel with it.
      let userMsg: ChatMessage | null = null;
      if (!isResend && !isRegenerate) {
        const files = opts.files ?? fileAttachments;
        userMsg = {
          role: "user",
          content: trimmed,
          timestamp: new Date().toISOString(),
          ...(files.length > 0 ? { fileAttachments: files } : {}),
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
      const state = useChatStore.getState();
      const sendThread = state.threads.find((t) => t.id === state.activeThreadId);
      const sendMode: ThreadMode = sendThread?.mode ?? "text";
      const sendProjectId = sendThread?.projectId ?? null;

      let systemPrompt: string;
      const sendProject = sendProjectId
        ? useProjectStore
            .getState()
            .projects.find((p) => p.id === sendProjectId)
        : null;
      if (sendMode === "project") {
        systemPrompt = buildProjectBriefPrompt({
          references: sendProject?.references ?? null,
        });
      } else {
        let sendBriefContent = "";
        if (sendProjectId && (briefIncludedByThread[sendProjectId] ?? true)) {
          sendBriefContent = await useProjectStore
            .getState()
            .loadBriefContent(sendProjectId);
        }
        systemPrompt = buildSystemPrompt({
          mode: currentConfig.systemPromptMode ?? "standard",
          customPrompt: currentConfig.customSystemPrompt ?? "",
          deepResearch: currentConfig.deepResearchEnabled ?? false,
          brief: state.brief,
          attachedTexts: attachments.map(({ title, textType, content }) => ({
            title,
            textType,
            content,
          })),
          projectBriefContent: sendBriefContent || null,
          uploadedFiles: state.messages.flatMap((m) => m.fileAttachments ?? []),
          references: collectReferences(sendThread, sendProject),
        });
      }

      const threadAtSend = useChatStore.getState().activeThreadId;
      const { messages: messagesAtSend } = useChatStore.getState();
      // A regeneration drops the old reply from the history so the model
      // answers afresh; the stored message itself stays until replaced.
      const history = isRegenerate
        ? messagesAtSend.filter((m) => messageKey(m) !== opts.regenerateKey)
        : messagesAtSend;
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
      // Library attachments apply to the send that used them: clear them
      // once the request landed (kept on error so a retry reuses them).
      if (!result.error) {
        setAttachments([]);
        setFileAttachments([]);
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
      attachments,
      fileAttachments,
      briefIncludedByThread,
    ],
  );

  // ── Handle send ──
  const handleSend = useCallback(() => {
    void sendText({ text: inputValue });
  }, [inputValue, sendText]);

  // ── Start a text thread from the writing brief ──
  // The composed brief becomes the first (structured) user message; the
  // brief is also remembered as the default for new threads.
  const handleStart = useCallback(async () => {
    const b = brief ?? defaultBrief();
    if (!b.topic.trim() || isSending) return;
    // Persist the start-panel references on the thread before the first
    // send, so the send picks them up from the thread metadata.
    if (startReferences.trim()) {
      await useChatStore.getState().setThreadReferences(startReferences);
    }
    void setConfig({ lastBrief: b });
    void sendText({ text: composeBriefMessage(b) });
  }, [brief, isSending, sendText, setConfig, startReferences]);

  // ── Save an edited brief mid-thread ──
  const handleBriefSave = useCallback(() => {
    if (!briefDraft) return;
    setBrief(briefDraft);
    void setConfig({ lastBrief: briefDraft });
    setBriefOpen(false);
  }, [briefDraft, setBrief, setConfig]);

  // ── Text mode: link the thread to the chosen project (or standalone) ──
  const handleTextProjectChange = useCallback(
    async (choice: string) => {
      if (choice === "standalone") {
        await setThreadMode("text");
        return;
      }
      await setThreadMode("text", choice);
      // Pre-fill the writing brief with the project's settled defaults.
      const project = useProjectStore
        .getState()
        .projects.find((p) => p.id === choice);
      if (project) {
        const current = useChatStore.getState().brief ?? defaultBrief();
        setBrief({
          ...current,
          ...(project.defaultAudience ? { audience: project.defaultAudience } : {}),
          ...(project.defaultTone ? { tone: project.defaultTone } : {}),
          ...(project.defaultCitations
            ? { citations: project.defaultCitations }
            : {}),
          ...(project.defaultLanguage ? { language: project.defaultLanguage } : {}),
        });
      }
    },
    [setThreadMode, setBrief],
  );

  // ── Project mode: start the brief agent ──
  const handleProjectStart = useCallback(async () => {
    if (isSending) return;
    let projectId: string | null = null;
    if (projectChoice === "__new__") {
      const title = seedTitle.trim();
      if (!title) return;
      projectId = await useProjectStore.getState().createProject({
        title,
        ...(seedReferences.trim() ? { references: seedReferences } : {}),
      });
    } else {
      projectId = projectChoice;
      // Only overwrite the project's references when the user typed
      // something; an untouched box keeps the stored value.
      if (seedReferences.trim()) {
        await useProjectStore.getState().updateProject(projectId, {
          references: seedReferences.trim(),
        });
      }
    }
    const project = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId);
    await setThreadMode("project", projectId);
    let text = composeProjectStartMessage({
      title: seedTitle.trim() || project?.title || "",
      description: seedDescription,
      ideas: seedIdeas,
    });
    // Refining an existing brief: show the agent the current draft.
    if (projectChoice !== "__new__" && project) {
      const existing = await useProjectStore.getState().loadBriefContent(project.id);
      if (existing.trim()) {
        text += `\n\nCurrent draft of the project brief (refine, don't restart):\n${existing}`;
      }
    }
    void sendText({ text });
  }, [isSending, projectChoice, seedTitle, seedDescription, seedIdeas, seedReferences, setThreadMode, sendText]);

  // ── Save an assistant reply as the linked project's brief ──
  const handleSaveAsBrief = useCallback(
    async (content: string) => {
      if (!threadProjectId) return;
      await useProjectStore.getState().updateProject(threadProjectId, {
        briefContent: content,
      });
      setProjectBriefContent(content);
    },
    [threadProjectId],
  );

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

  const emptyThread = messages.length === 0;
  const modeDecided = !!activeThread?.mode;

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
                  <span className="truncate max-w-[360px] block">
                    {t.mode === "project" ? "[Brief] " : ""}
                    {t.title}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!isProjectThread && threadProject && (
            <span
              className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-alt border border-border text-[11px] font-medium text-text-secondary max-w-[180px]"
              title={`Texts build on the brief of project “${threadProject.title}”`}
            >
              <FolderOpen className="size-3" />
              <span className="truncate">{threadProject.title}</span>
            </span>
          )}
          {isProjectThread && (
            <span
              className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/40 text-[11px] font-medium text-text-primary max-w-[200px]"
              title="This conversation develops a project brief"
            >
              <FolderOpen className="size-3 text-primary" />
              <span className="truncate">Project brief</span>
            </span>
          )}
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
          {!isProjectThread && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setBriefDraft(brief ?? defaultBrief());
                setBriefOpen(true);
              }}
              title="Edit writing brief"
              aria-label="Edit writing brief"
              disabled={isSending}
            >
              <ClipboardList className="size-4 text-text-secondary" />
            </Button>
          )}
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

      {/* Empty thread: mode picker or mode-specific start panels */}
      {emptyThread && !modeDecided ? (
        <ModePicker onPick={(mode) => void setThreadMode(mode)} />
      ) : emptyThread && isProjectThread ? (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-2xl mx-auto space-y-4">
            <p className="text-text-muted text-sm">
              The brief agent will ask about the project&apos;s purpose,
              audience, planned texts, structure, and style, then draft the
              brief. Tell it what you already know:
            </p>
            <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <div className="space-y-1.5">
                <Label htmlFor="project-choice">Project</Label>
                <Select
                  value={projectChoice}
                  onValueChange={(v) => setProjectChoice(v ?? "__new__")}
                >
                  <SelectTrigger className="w-full bg-field" aria-label="Project">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__new__">New project…</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="truncate max-w-[320px] block">
                          {p.title}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {projectChoice === "__new__" && (
                <div className="space-y-1.5">
                  <Label htmlFor="project-seed-title">Working title</Label>
                  <Input
                    id="project-seed-title"
                    value={seedTitle}
                    onChange={(e) => setSeedTitle(e.target.value)}
                    placeholder="e.g. Essays on extractivism"
                    className="bg-field"
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="project-seed-description">What it is about</Label>
                <Input
                  id="project-seed-description"
                  value={seedDescription}
                  onChange={(e) => setSeedDescription(e.target.value)}
                  placeholder="One line on the project's purpose or occasion"
                  className="bg-field"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="project-seed-ideas">Ideas and direction so far (optional)</Label>
                <Textarea
                  id="project-seed-ideas"
                  value={seedIdeas}
                  onChange={(e) => setSeedIdeas(e.target.value)}
                  placeholder="Topics, structure, audience, anything already decided…"
                  className="bg-field min-h-[72px] resize-y"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="project-seed-references">References (optional)</Label>
                <Textarea
                  id="project-seed-references"
                  value={seedReferences}
                  onChange={(e) => setSeedReferences(e.target.value)}
                  placeholder="Links, authors, books, theories the project builds on…"
                  className="bg-field min-h-[72px] resize-y"
                />
                <p className="text-xs text-text-muted">
                  Saved with the project and given to the agent in every
                  conversation of this project.
                </p>
              </div>
              <Button
                className="bg-primary hover:bg-primary/80 text-primary-foreground"
                onClick={() => void handleProjectStart()}
                disabled={isSending || (projectChoice === "__new__" && !seedTitle.trim())}
              >
                <PencilLine className="size-4 mr-1.5" />
                Start discussion
              </Button>
            </div>
          </div>
        </div>
      ) : emptyThread ? (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-2xl mx-auto space-y-4">
            <p className="text-text-muted text-sm">
              Fill in the writing brief to start. The agent treats these
              answers as settled, discusses a plan with you, and drafts only
              after you approve.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="text-project-choice">Project (optional)</Label>
              <Select
                value={textProjectChoice}
                onValueChange={(v) => void handleTextProjectChange(v ?? "standalone")}
              >
                <SelectTrigger
                  id="text-project-choice"
                  className="w-full bg-field"
                  aria-label="Project this text belongs to"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standalone">Standalone text</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="truncate max-w-[320px] block">
                        {p.title}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {textProjectChoice !== "standalone" && threadProject?.description?.trim() && (
                <p className="text-xs text-text-muted">
                  {threadProject.description}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="text-references">References (optional)</Label>
              <Textarea
                id="text-references"
                value={startReferences}
                onChange={(e) => setStartReferences(e.target.value)}
                placeholder="Links, authors, books, theories this text should draw on…"
                className="bg-field min-h-[72px] resize-y"
              />
              <p className="text-xs text-text-muted">
                Paste sources, names, or links. The agent grounds the text in
                them and reads linked pages before relying on them.
                {threadProject?.references?.trim()
                  ? " The project's references are included automatically."
                  : ""}
              </p>
            </div>
            <BriefForm
              brief={brief ?? defaultBrief()}
              onChange={setBrief}
              onSubmit={handleStart}
              submitLabel="Start discussion"
              busy={isSending}
            />
          </div>
        </div>
      ) : (
        <>
          {/* Messages */}
          <MessageList
            onResend={(key) => void sendText({ resendKey: key })}
            onRegenerate={(key) => void sendText({ regenerateKey: key })}
            saveToProjectId={threadProjectId}
            onSaveAsBrief={
              isProjectThread ? (content) => void handleSaveAsBrief(content) : undefined
            }
          />

          {/* Input */}
          <MessageInput
            value={inputValue}
            onChange={setDraft}
            onSend={handleSend}
            onStop={handleStop}
            disabled={isSending}
            tokenEstimate={tokenEstimate}
            attachedTexts={attachments}
            onOpenPicker={() => setPickerOpen(true)}
            onRemoveAttachment={(id) =>
              setAttachments((prev) => prev.filter((a) => a.id !== id))
            }
            fileAttachments={fileAttachments}
            onUploadFiles={(files) => void handleUploadFiles(files)}
            onRemoveFileAttachment={(name) =>
              setFileAttachments((prev) => prev.filter((f) => f.name !== name))
            }
            uploadingFiles={uploadingFiles}
            projectTitle={
              !isProjectThread && threadProject ? threadProject.title : null
            }
            projectBriefIncluded={projectBriefIncluded}
            onToggleProjectBrief={
              threadProjectId
                ? () =>
                    setBriefIncludedByThread((prev) => ({
                      ...prev,
                      [threadProjectId]: !(prev[threadProjectId] ?? true),
                    }))
                : undefined
            }
          />
        </>
      )}

      <AttachmentPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selectedIds={attachments.map((a) => a.id)}
        onConfirm={handleAttachmentsConfirmed}
        projectId={threadProjectId ?? undefined}
      />

      {/* Edit the writing brief of a started thread */}
      <Dialog open={briefOpen} onOpenChange={setBriefOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit writing brief</DialogTitle>
            <DialogDescription>
              These answers are given to the agent as settled. Changes apply
              to the rest of this conversation.
            </DialogDescription>
          </DialogHeader>
          {briefDraft && (
            <BriefForm
              brief={briefDraft}
              onChange={setBriefDraft}
              onSubmit={handleBriefSave}
              submitLabel="Save brief"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
