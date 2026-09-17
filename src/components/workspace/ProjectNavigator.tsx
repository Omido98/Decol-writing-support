import { useEffect, useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  BookMarked,
  BookPlus,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  FolderInput,
  FolderOpen,
  FolderPlus,
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
import RenameThreadDialog from "@/components/chat/RenameThreadDialog";
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
import type { ThreadMeta } from "@/types";

/** Pinned rows first; within each group the recency order is preserved. */
function pinnedFirst<T extends { pinned?: boolean }>(list: T[]): T[] {
  return [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

/**
 * Group conversations by their one-level folder: pinned-first ungrouped
 * rows, then folders alphabetically with pinned-first rows inside. Empty
 * folder names ("  ") count as no folder.
 */
function groupByFolder<T extends { folder?: string; pinned?: boolean }>(
  items: T[],
): {
  ungrouped: T[];
  folders: { name: string; items: T[] }[];
} {
  const ungrouped: T[] = [];
  const byFolder = new Map<string, T[]>();
  for (const item of items) {
    const name = item.folder?.trim();
    if (!name) {
      ungrouped.push(item);
      continue;
    }
    const list = byFolder.get(name) ?? [];
    list.push(item);
    byFolder.set(name, list);
  }
  const folders = [...byFolder.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => ({ name, items: pinnedFirst(list) }));
  return { ungrouped: pinnedFirst(ungrouped), folders };
}

const rowClass = (active: boolean) =>
  `w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors flex items-center gap-2 cursor-pointer ${
    active
      ? "bg-selection text-text-primary"
      : "text-text-secondary hover:bg-surface-alt hover:text-text-primary"
  }`;

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

/** A small hover action on a conversation row (move / rename). */
function RowAction({
  label,
  title,
  onClick,
  icon,
}: {
  label: string;
  title: string;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      className="shrink-0 rounded p-0.5 hover:bg-border transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      title={title}
    >
      {icon}
    </button>
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
 * Conversations group by their one-level folder at both levels (inside
 * projects and standalone); selection drives the workspace view.
 */
export default function ProjectNavigator() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const openProject = useAppStore((s) => s.openProject);
  const openBrief = useAppStore((s) => s.openBrief);
  const openText = useAppStore((s) => s.openText);
  const openDiscussion = useAppStore((s) => s.openDiscussion);
  const setActionError = useAppStore((s) => s.setActionError);

  const texts = useLibraryStore((s) => s.texts);
  const createText = useLibraryStore((s) => s.createText);
  const setTextState = useLibraryStore((s) => s.setTextState);
  const projects = useProjectStore((s) => s.projects);
  const createProject = useProjectStore((s) => s.createProject);

  const threads = useChatStore((s) => s.threads);
  const createThread = useChatStore((s) => s.createThread);
  const setThreadState = useChatStore((s) => s.setThreadState);
  const renameThread = useChatStore((s) => s.renameThread);
  const setThreadFolder = useChatStore((s) => s.setThreadFolder);

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Folder groups are expanded by default; only the collapsed ones are
   * tracked, so moving a conversation into a folder never hides it. */
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [moveTarget, setMoveTarget] = useState<{
    id: string;
    title: string;
    folder?: string;
  } | null>(null);
  const [moveFolder, setMoveFolder] = useState("");

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

  const toggleFolder = (key: string) =>
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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

  const handleNewDiscussionInFolder = async (folder: string) => {
    try {
      const id = await createThread();
      await setThreadFolder(id, folder);
      openDiscussion(id);
    } catch (err) {
      setActionError(
        `Could not start a conversation: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  const openMoveDialog = (thread: ThreadMeta) => {
    setMoveFolder(thread.folder ?? "");
    setMoveTarget({
      id: thread.id,
      title: thread.title,
      ...(thread.folder ? { folder: thread.folder } : {}),
    });
  };

  /** `null` removes the conversation from its folder; otherwise the
   * typed folder name applies (empty = no folder). */
  const submitMove = async (folderOverride?: string | null) => {
    if (!moveTarget) return;
    const folder =
      folderOverride === null ? "" : (folderOverride ?? moveFolder);
    await setThreadFolder(moveTarget.id, folder.trim() || null);
    setMoveTarget(null);
    setMoveFolder("");
  };

  // Archived rows leave the main lists; they live in the Archived section.
  const standaloneTexts = pinnedFirst(
    texts.filter((t) => !t.projectId && !t.archived),
  );
  const standaloneThreads = threads.filter(
    (t) =>
      (!t.projectId || !projects.some((p) => p.id === t.projectId)) &&
      !t.archived,
  );
  const archivedTexts = texts.filter((t) => t.archived);
  const archivedThreads = threads.filter((t) => t.archived);
  const archivedCount = archivedTexts.length + archivedThreads.length;

  /** Every known conversation folder, for the move dialog's suggestions. */
  const folderSuggestions = [
    ...new Set(
      threads
        .map((t) => t.folder?.trim())
        .filter((f): f is string => !!f),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const activeTextId = view.kind === "read" || view.kind === "edit" ? view.id : null;
  const activeThreadId =
    view.kind === "discussion" ? (view.id ?? null) : null;

  /** One conversation row with its full hover actions. */
  const renderThreadRow = (t: ThreadMeta) => (
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
      <RowAction
        label={`Move conversation ${t.title} to a folder`}
        title={t.folder ? `In folder “${t.folder}” — move` : "Move to folder"}
        onClick={() => openMoveDialog(t)}
        icon={
          <FolderInput
            className={`size-3 ${t.folder ? "text-primary" : ""}`}
          />
        }
      />
      <RowAction
        label={`Rename conversation ${t.title}`}
        title="Rename"
        onClick={() => setRenaming({ id: t.id, title: t.title })}
        icon={<Pencil className="size-3" />}
      />
    </div>
  );

  /** Ungrouped conversations, then the folder groups (expanded unless
   * the user collapsed them). `scope` keeps folder keys unique between
   * the standalone list and each project. */
  const renderThreadGroups = (items: ThreadMeta[], scope: string) => {
    const { ungrouped, folders } = groupByFolder(items);
    return (
      <>
        {ungrouped.map(renderThreadRow)}
        {folders.map(({ name, items: members }) => {
          const key = `${scope}::${name}`;
          const collapsed = collapsedFolders.has(key);
          return (
            <div key={key}>
              <div className="flex items-center gap-1 group">
                <button
                  type="button"
                  className="flex-1 flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-text-secondary hover:bg-surface-alt hover:text-text-primary transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  aria-expanded={!collapsed}
                  aria-controls={`folder-${key}-children`}
                  onClick={() => toggleFolder(key)}
                  title={name}
                >
                  {collapsed ? (
                    <ChevronRight className="size-3 shrink-0" />
                  ) : (
                    <ChevronDown className="size-3 shrink-0" />
                  )}
                  <FolderOpen className="size-3.5 shrink-0" />
                  <span className="truncate font-medium">{name}</span>
                  <span className="shrink-0 text-[10px] text-text-muted">
                    {members.length}
                  </span>
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 hover:bg-border transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => void handleNewDiscussionInFolder(name)}
                  aria-label={`New conversation in ${name}`}
                  title={`New conversation in “${name}”`}
                >
                  <MessageSquarePlus className="size-3" />
                </button>
              </div>
              {!collapsed && (
                <div
                  id={`folder-${key}-children`}
                  className="ml-4 border-l border-border pl-2 space-y-0.5"
                >
                  {members.map(renderThreadRow)}
                </div>
              )}
            </div>
          );
        })}
      </>
    );
  };

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
        const projectThreads = threads.filter(
          (t) => t.projectId === project.id && !t.archived,
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
                {renderThreadGroups(projectThreads, project.id)}
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

      {/* Standalone conversations, grouped by folder */}
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
      {renderThreadGroups(standaloneThreads, "standalone")}

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
                  <RowAction
                    label={`Rename conversation ${t.title}`}
                    title="Rename"
                    onClick={() => setRenaming({ id: t.id, title: t.title })}
                    icon={<Pencil className="size-3" />}
                  />
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

      {/* Move a conversation into a folder (or out of one) */}
      <Dialog
        open={moveTarget !== null}
        onOpenChange={(o) => {
          if (!o) {
            setMoveTarget(null);
            setMoveFolder("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move conversation to folder</DialogTitle>
            <DialogDescription>
              “{moveTarget?.title}” moves to the folder. Its messages are
              untouched. Leave the name empty to remove it from its folder.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={moveFolder}
            onChange={(e) => setMoveFolder(e.target.value)}
            placeholder="Folder name…"
            list="conversation-folders"
            aria-label="Conversation folder"
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitMove();
            }}
          />
          <datalist id="conversation-folders">
            {folderSuggestions.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <DialogFooter>
            {moveTarget?.folder && (
              <Button variant="ghost" onClick={() => void submitMove(null)}>
                Remove from folder
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                setMoveTarget(null);
                setMoveFolder("");
              }}
            >
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/80 text-primary-foreground"
              onClick={() => void submitMove()}
            >
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename conversation (shared with the in-chat title action) */}
      <RenameThreadDialog
        thread={renaming}
        onClose={() => setRenaming(null)}
        onRename={renameThread}
      />
    </nav>
  );
}
