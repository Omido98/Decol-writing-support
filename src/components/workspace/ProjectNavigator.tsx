import { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  BookMarked,
  BookPlus,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  FolderPlus,
  FolderOpen,
  MessageSquarePlus,
  Notebook,
  Pencil,
  Pin,
} from "lucide-react";
import { useAppStore } from "@/stores/useAppStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useChatStore } from "@/stores/chatStore";
import { useThreadFailedSends } from "@/components/chat/useThreadOperation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Pinned rows first; within each group the recency order is preserved. */
function pinnedFirst<T extends { pinned?: boolean }>(list: T[]): T[] {
  return [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

/** Hover actions on a navigator row: pin toggle + archive. Pinned rows
 * keep their pin button visible; the keyboard surfaces them too
 * (`focus-visible` + `group-focus-within`, B20c). */
function RowFlagActions({
  pinned,
  label,
  onTogglePin,
  onArchive,
}: {
  pinned: boolean;
  label: string;
  onTogglePin: () => void;
  onArchive: () => void;
}) {
  return (
    <span className="shrink-0 flex items-center gap-0.5">
      <button
        type="button"
        className={`shrink-0 rounded p-0.5 hover:bg-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
          pinned
            ? "opacity-100 text-primary"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
        aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
        title={pinned ? "Unpin" : "Pin"}
      >
        <Pin className="size-3" />
      </button>
      <button
        type="button"
        className="shrink-0 rounded p-0.5 hover:bg-border transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={(e) => {
          e.stopPropagation();
          onArchive();
        }}
        aria-label={`Archive ${label}`}
        title="Archive"
      >
        <Archive className="size-3" />
      </button>
    </span>
  );
}

/**
 * A failed send retained by the operation service (B15) — visible from
 * the navigator even when the conversation is not open, so a failure that
 * landed while the owner was hidden stays discoverable.
 */
function ThreadFailureBadge({ threadId }: { threadId: string }) {
  const failed = useThreadFailedSends(threadId);
  if (failed.length === 0) return null;
  const label =
    failed.length === 1
      ? "A send failed in this conversation — open it to retry"
      : `${failed.length} sends failed in this conversation — open it to retry`;
  return (
    <span className="shrink-0 flex items-center" title={label} role="img" aria-label={label}>
      <CircleAlert className="size-3 text-destructive" />
    </span>
  );
}

/**
 * The workspace navigator: projects (with their brief, documents, and
 * discussions), standalone documents, and standalone conversations.
 * Selection drives the workspace view; the selection itself persists.
 */
export default function ProjectNavigator() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const openProject = useAppStore((s) => s.openProject);
  const openBrief = useAppStore((s) => s.openBrief);
  const openText = useAppStore((s) => s.openText);
  const openDiscussion = useAppStore((s) => s.openDiscussion);

  const texts = useLibraryStore((s) => s.texts);
  const createText = useLibraryStore((s) => s.createText);
  const projects = useProjectStore((s) => s.projects);
  const createProject = useProjectStore((s) => s.createProject);

  const threads = useChatStore((s) => s.threads);
  const createThread = useChatStore((s) => s.createThread);
  const setThreadState = useChatStore((s) => s.setThreadState);
  const setTextState = useLibraryStore((s) => s.setTextState);
  const setActionError = useAppStore((s) => s.setActionError);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(
    null,
  );
  const renameThread = useChatStore((s) => s.renameThread);

  // Auto-expand the project that owns the current view.
  useEffect(() => {
    const projectId =
      view.kind === "project" || view.kind === "brief"
        ? view.id
        : (view.kind === "read" || view.kind === "edit") && view.id
          ? texts.find((t) => t.id === view.id)?.projectId
          : view.kind === "discussion" && view.id
            ? threads.find((t) => t.id === view.id)?.projectId
            : null;
    if (projectId) {
      setExpanded((prev) => new Set(prev).add(projectId));
    }
  }, [view, texts, threads]);

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleNewDocument = async () => {
    const id = await createText({});
    openText(id);
    setView({ kind: "edit", id });
  };

  const handleNewProject = async () => {
    const id = await createProject({});
    openProject(id);
  };

  const handleNewDiscussion = async () => {
    try {
      const id = await createThread();
      openDiscussion(id);
    } catch (err) {
      setActionError(
        `Could not start a conversation: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // Archived rows leave the main lists; they live in the Archived section.
  const standaloneTexts = pinnedFirst(
    texts.filter((t) => !t.projectId && !t.archived),
  );
  const standaloneThreads = pinnedFirst(
    threads.filter(
      (t) =>
        (!t.projectId || !projects.some((p) => p.id === t.projectId)) &&
        !t.archived,
    ),
  );
  const archivedTexts = texts.filter((t) => t.archived);
  const archivedThreads = threads.filter((t) => t.archived);
  const archivedCount = archivedTexts.length + archivedThreads.length;

  const rowClass = (active: boolean) =>
    `w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors flex items-center gap-2 cursor-pointer ${
      active
        ? "bg-selection text-text-primary"
        : "text-text-secondary hover:bg-surface-alt hover:text-text-primary"
    }`;

  const activeTextId = view.kind === "read" || view.kind === "edit" ? view.id : null;
  const activeThreadId =
    view.kind === "discussion" ? (view.id ?? null) : null;

  return (
    <nav
      aria-label="Workspace navigator"
      className="h-full overflow-y-auto px-2 py-3 space-y-1"
    >
      {/* Projects */}
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary select-none">
          Projects
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void handleNewProject()}
          title="New project"
          aria-label="New project"
          className="size-5"
        >
          <FolderPlus className="size-3.5" />
        </Button>
      </div>
      {projects.map((project) => {
        const isOpen = expanded.has(project.id);
        // Archived rows leave the project's lists (the Archived section
        // at the bottom holds them with restore actions).
        const projectTexts = pinnedFirst(
          texts.filter((t) => t.projectId === project.id && !t.archived),
        );
        const projectThreads = pinnedFirst(
          threads.filter((t) => t.projectId === project.id && !t.archived),
        );
        const isProjectActive =
          view.kind === "project" && view.id === project.id;
        const isBriefActive =
          view.kind === "brief" && view.id === project.id;
        return (
          <div key={project.id}>
            <div className={rowClass(isProjectActive)}>
              <button
                type="button"
                className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label={`${isOpen ? "Collapse" : "Expand"} ${project.title}`}
                aria-expanded={isOpen}
                aria-controls={`project-${project.id}-children`}
                onClick={() => toggleExpanded(project.id)}
              >
                {isOpen ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
              </button>
              <button
                type="button"
                className="flex-1 truncate text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-current={isProjectActive ? "true" : undefined}
                onClick={() => openProject(project.id)}
                title={project.title}
              >
                {project.title}
              </button>
            </div>
            {isOpen && (
              <div
                id={`project-${project.id}-children`}
                className="ml-4 border-l border-border pl-2 space-y-0.5"
              >
                {/* Brief */}
                <button
                  type="button"
                  className={rowClass(isBriefActive)}
                  aria-current={isBriefActive ? "true" : undefined}
                  onClick={() => openBrief(project.id)}
                >
                  <Notebook className="size-3.5 shrink-0" />
                  <span className="truncate">Brief</span>
                </button>
                {projectTexts.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={rowClass(activeTextId === t.id)}
                    aria-current={activeTextId === t.id ? "true" : undefined}
                    onClick={() => openText(t.id)}
                    title={t.title}
                  >
                    <BookMarked className="size-3.5 shrink-0" />
                    <span className="truncate">{t.title}</span>
                  </button>
                ))}
                {projectThreads.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={rowClass(activeThreadId === t.id)}
                    aria-current={activeThreadId === t.id ? "true" : undefined}
                    onClick={() => openDiscussion(t.id)}
                    title={t.title}
                  >
                    <FolderOpen className="size-3.5 shrink-0" />
                    <span className="truncate">{t.title}</span>
                    <ThreadFailureBadge threadId={t.id} />
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Standalone documents — New blank and Paste-as-new are separate
          actions on purpose. */}
      <div className="flex items-center justify-between px-2 pt-3 pb-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary select-none">
          Documents
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              void navigator.clipboard
                .readText()
                .then((clip) =>
                  createText({
                    title: "Pasted note",
                    ...(clip.trim() ? { content: clip } : {}),
                  }),
                )
                .then((id) => {
                  if (id) openText(id);
                  setView({ kind: "edit", id });
                })
                .catch(() => {
                  // Clipboard unavailable: a blank document, honestly labelled.
                  void createText({ title: "Pasted note" }).then((id) => {
                    if (id) openText(id);
                    setView({ kind: "edit", id });
                  });
                });
            }}
            title="Paste as new document"
            aria-label="Paste as new document"
            className="size-5"
          >
            <ClipboardList className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void handleNewDocument()}
            title="New blank document"
            aria-label="New blank document"
            className="size-5"
          >
            <BookPlus className="size-3.5" />
          </Button>
        </div>
      </div>
      {standaloneTexts.map((t) => (
        <div key={t.id} className={`${rowClass(activeTextId === t.id)} group`}>
          <button
            type="button"
            className="flex-1 flex items-center gap-2 min-w-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-current={activeTextId === t.id ? "true" : undefined}
            onClick={() => openText(t.id)}
            title={t.title}
          >
            <BookMarked className="size-3.5 shrink-0" />
            <span className="truncate">{t.title}</span>
          </button>
          <RowFlagActions
            pinned={!!t.pinned}
            label={`document ${t.title}`}
            onTogglePin={() => void setTextState(t.id, { pinned: !t.pinned })}
            onArchive={() => void setTextState(t.id, { archived: true })}
          />
        </div>
      ))}

      {/* Standalone conversations */}
      <div className="flex items-center justify-between px-2 pt-3 pb-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary select-none">
          Conversations
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void handleNewDiscussion()}
          title="New conversation"
          aria-label="New conversation"
          className="size-5"
        >
          <MessageSquarePlus className="size-3.5" />
        </Button>
      </div>
      {standaloneThreads.map((t) => (
        <div key={t.id} className={`${rowClass(activeThreadId === t.id)} group`}>
          <button
            type="button"
            className="flex-1 flex items-center gap-2 min-w-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-current={activeThreadId === t.id ? "true" : undefined}
            onClick={() => openDiscussion(t.id)}
            title={t.title}
          >
            <FolderOpen className="size-3.5 shrink-0" />
            <span className="truncate">{t.title}</span>
            <ThreadFailureBadge threadId={t.id} />
          </button>
          <RowFlagActions
            pinned={!!t.pinned}
            label={`conversation ${t.title}`}
            onTogglePin={() => void setThreadState(t.id, { pinned: !t.pinned })}
            onArchive={() => void setThreadState(t.id, { archived: true })}
          />
          <button
            type="button"
            className="shrink-0 rounded p-0.5 hover:bg-border transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={(e) => {
              e.stopPropagation();
              setRenaming({ id: t.id, title: t.title });
            }}
            aria-label={`Rename conversation ${t.title}`}
            title="Rename"
          >
            <Pencil className="size-3" />
          </button>
        </div>
      ))}

      {/* Archived (D3): out of the main lists, restorable, never automatic. */}
      {archivedCount > 0 && (
        <div className="pt-3">
          <button
            type="button"
            className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-secondary select-none hover:text-text-primary"
            onClick={() => setArchivedOpen((v) => !v)}
            aria-expanded={archivedOpen}
          >
            {archivedOpen ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            Archived ({archivedCount})
          </button>
          {archivedOpen && (
            <div className="ml-2 space-y-0.5">
              {archivedTexts.map((t) => (
                <div
                  key={t.id}
                  className={`${rowClass(activeTextId === t.id)} group`}
                >
                  <button
                    type="button"
                    className="flex-1 flex items-center gap-2 min-w-0 opacity-75 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    aria-current={activeTextId === t.id ? "true" : undefined}
                    onClick={() => openText(t.id)}
                    title={t.title}
                  >
                    <BookMarked className="size-3.5 shrink-0" />
                    <span className="truncate">{t.title}</span>
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 hover:bg-border transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={(e) => {
                      e.stopPropagation();
                      void setTextState(t.id, { archived: false });
                    }}
                    aria-label={`Restore ${t.title}`}
                    title="Restore to the documents list"
                  >
                    <ArchiveRestore className="size-3" />
                  </button>
                </div>
              ))}
              {archivedThreads.map((t) => (
                <div
                  key={t.id}
                  className={`${rowClass(activeThreadId === t.id)} group`}
                >
                  <button
                    type="button"
                    className="flex-1 flex items-center gap-2 min-w-0 opacity-75 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    aria-current={activeThreadId === t.id ? "true" : undefined}
                    onClick={() => openDiscussion(t.id)}
                    title={t.title}
                  >
                    <FolderOpen className="size-3.5 shrink-0" />
                    <span className="truncate">{t.title}</span>
                    <ThreadFailureBadge threadId={t.id} />
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 hover:bg-border transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={(e) => {
                      e.stopPropagation();
                      void setThreadState(t.id, { archived: false });
                    }}
                    aria-label={`Restore ${t.title}`}
                    title="Restore to the conversations list"
                  >
                    <ArchiveRestore className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Rename conversation */}
      <Dialog
        open={renaming !== null}
        onOpenChange={(o) => !o && setRenaming(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription>
              Renaming does not touch the messages.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renaming?.title ?? ""}
            onChange={(e) =>
              setRenaming((r) => (r ? { ...r, title: e.target.value } : r))
            }
            aria-label="Conversation title"
            onKeyDown={(e) => {
              if (e.key === "Enter" && renaming) {
                void renameThread(renaming.id, renaming.title).then(() =>
                  setRenaming(null),
                );
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/80 text-primary-foreground"
              onClick={() => {
                if (renaming) {
                  void renameThread(renaming.id, renaming.title).then(() =>
                    setRenaming(null),
                  );
                }
              }}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </nav>
  );
}
