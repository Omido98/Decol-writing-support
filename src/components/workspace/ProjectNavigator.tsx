import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
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
  Trash2,
} from "lucide-react";
import { useAppStore } from "@/stores/useAppStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useChatStore } from "@/stores/chatStore";
import { useFolderStore } from "@/stores/folderStore";
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
import type { FolderMeta, LibraryTextMeta, ThreadMeta } from "@/types";

/** The drag payload a navigator row sets (and a drop target reads). */
const DRAG_MIME = "application/x-dws-nav-item";

interface DragItem {
  kind: "text" | "thread";
  id: string;
  /** The area the row belongs to: "" (standalone) or a project id. */
  scope: string;
  folder?: string;
}

/** A folder group inside one area: mixed texts and conversations. */
interface FolderGroup {
  name: string;
  texts: LibraryTextMeta[];
  threads: ThreadMeta[];
}

/** Pinned rows first; within each group the recency order is preserved. */
function pinnedFirst<T extends { pinned?: boolean }>(list: T[]): T[] {
  return [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

/**
 * Every folder of one area: registry rows (so empty folders show and can
 * be created) plus names only present on items (legacy/editor-typed
 * folders). Members are the unarchived items carrying the name.
 */
function folderGroupsFor(
  registry: FolderMeta[],
  scope: string,
  texts: LibraryTextMeta[],
  threads: ThreadMeta[],
): FolderGroup[] {
  const names = new Set<string>();
  for (const f of registry) {
    if (f.scope === scope) names.add(f.name);
  }
  for (const t of texts) {
    const name = t.folder?.trim();
    if (name) names.add(name);
  }
  for (const t of threads) {
    const name = t.folder?.trim();
    if (name) names.add(name);
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((name) => ({
      name,
      texts: pinnedFirst(texts.filter((t) => t.folder?.trim() === name)),
      threads: pinnedFirst(threads.filter((t) => t.folder?.trim() === name)),
    }));
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

/** A small hover action on a row or folder (move / rename / delete / new). */
function RowAction({
  label,
  title,
  onClick,
  icon,
  alwaysVisible = false,
}: {
  label: string;
  title: string;
  onClick: () => void;
  icon: ReactNode;
  alwaysVisible?: boolean;
}) {
  return (
    <button
      type="button"
      className={`shrink-0 rounded p-0.5 hover:bg-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
        alwaysVisible
          ? ""
          : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
      }`}
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
 * Folders are shared per area (standalone area and each project): a
 * folder holds texts and conversations together, can be created, renamed,
 * and deleted, and rows can be dragged in and out.
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
  const updateText = useLibraryStore((s) => s.updateText);
  const projects = useProjectStore((s) => s.projects);
  const createProject = useProjectStore((s) => s.createProject);

  const threads = useChatStore((s) => s.threads);
  const createThread = useChatStore((s) => s.createThread);
  const setThreadState = useChatStore((s) => s.setThreadState);
  const renameThread = useChatStore((s) => s.renameThread);
  const setThreadFolder = useChatStore((s) => s.setThreadFolder);

  const registryFolders = useFolderStore((s) => s.folders);
  const ensureFolders = useFolderStore((s) => s.ensureLoaded);
  const createFolder = useFolderStore((s) => s.createFolder);
  const renameFolder = useFolderStore((s) => s.renameFolder);
  const deleteFolder = useFolderStore((s) => s.deleteFolder);

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Folder groups are expanded by default; only the collapsed ones are
   * tracked, so moving an item into a folder never hides it. */
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(
    null,
  );

  // ── Drag & drop state ──
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // ── Folder dialogs ──
  const [newFolderScope, setNewFolderScope] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [folderRename, setFolderRename] = useState<{
    scope: string;
    name: string;
    value: string;
  } | null>(null);
  const [folderDelete, setFolderDelete] = useState<{
    scope: string;
    name: string;
    texts: number;
    threads: number;
  } | null>(null);

  // ── Move dialog (texts and conversations) ──
  const [moveTarget, setMoveTarget] = useState<{
    kind: "text" | "thread";
    id: string;
    title: string;
    folder?: string;
    scope: string;
  } | null>(null);
  const [moveFolder, setMoveFolder] = useState("");

  const projectIds = useMemo(
    () => new Set(projects.map((p) => p.id)),
    [projects],
  );

  /** The area a row belongs to: "" or a LIVE project id (a dead project
   * link counts as standalone, exactly like the list filters). */
  const scopeOf = (projectId?: string): string =>
    projectId && projectIds.has(projectId) ? projectId : "";

  useEffect(() => {
    void ensureFolders();
  }, [ensureFolders]);

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

  // ── Item actions ──

  const handleNewDocument = async (scope = "") => {
    const id = await createText(scope ? { projectId: scope } : {});
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

  const handleNewTextInFolder = async (scope: string, name: string) => {
    const id = await createText({
      ...(scope ? { projectId: scope } : {}),
      folder: name,
    });
    openText(id);
    setView({ kind: "edit", id });
  };

  const handleNewDiscussionInFolder = async (scope: string, name: string) => {
    try {
      const id = await createThread();
      if (scope) {
        await useChatStore.getState().setThreadMode("text", scope);
      }
      await setThreadFolder(id, name);
      openDiscussion(id);
    } catch (err) {
      setActionError(
        `Could not start a conversation: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // ── Folder actions ──

  const handleCreateFolder = async () => {
    if (newFolderScope === null) return;
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await createFolder(newFolderScope, name);
      setNewFolderScope(null);
      setNewFolderName("");
    } catch (err) {
      setActionError(
        `Could not create the folder: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  const handleRenameFolder = async () => {
    if (!folderRename) return;
    const value = folderRename.value.trim();
    if (!value || value === folderRename.name) {
      setFolderRename(null);
      return;
    }
    try {
      await renameFolder(folderRename.scope, folderRename.name, value);
      setFolderRename(null);
    } catch (err) {
      setActionError(
        `Could not rename the folder: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  const handleDeleteFolder = async () => {
    if (!folderDelete) return;
    try {
      await deleteFolder(folderDelete.scope, folderDelete.name);
      setFolderDelete(null);
    } catch (err) {
      setActionError(
        `Could not delete the folder: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // ── Move (dialog + drag & drop) ──

  const moveItem = async (item: DragItem, folder: string | null) => {
    if (item.kind === "text") {
      await updateText(item.id, { folder: folder ?? "" });
    } else {
      await setThreadFolder(item.id, folder);
    }
  };

  const openMoveDialog = (
    kind: "text" | "thread",
    item: { id: string; title: string; folder?: string },
    scope: string,
  ) => {
    setMoveFolder(item.folder ?? "");
    setMoveTarget({
      kind,
      id: item.id,
      title: item.title,
      ...(item.folder ? { folder: item.folder } : {}),
      scope,
    });
  };

  /** `null` removes the item from its folder; otherwise the typed name
   * applies (empty = no folder). */
  const submitMove = async (folderOverride?: string | null) => {
    if (!moveTarget) return;
    const folder =
      folderOverride === null ? "" : (folderOverride ?? moveFolder).trim();
    try {
      await moveItem(
        { kind: moveTarget.kind, id: moveTarget.id, scope: moveTarget.scope },
        folder || null,
      );
    } catch (err) {
      setActionError(
        `Could not move the item: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    setMoveTarget(null);
    setMoveFolder("");
  };

  // ── Drag & drop handlers ──

  const readDrag = (e: DragEvent): DragItem | null => {
    try {
      const raw = e.dataTransfer?.getData?.(DRAG_MIME);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as DragItem;
      if (
        (parsed.kind === "text" || parsed.kind === "thread") &&
        typeof parsed.id === "string" &&
        typeof parsed.scope === "string"
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  };

  const beginDrag = (item: DragItem) => (e: DragEvent) => {
    e.dataTransfer?.setData?.(DRAG_MIME, JSON.stringify(item));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    setDragging(item);
  };

  const endDrag = () => {
    setDragging(null);
    setDropTarget(null);
  };

  /** Drop props for a folder row (same area only). */
  const folderDropProps = (scope: string, name: string) => {
    const key = `folder::${scope}::${name}`;
    return {
      onDragOver: (e: DragEvent) => {
        if (!dragging || dragging.scope !== scope) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        setDropTarget(key);
      },
      onDragLeave: () =>
        setDropTarget((current) => (current === key ? null : current)),
      onDrop: (e: DragEvent) => {
        const item = readDrag(e) ?? dragging;
        setDragging(null);
        setDropTarget(null);
        if (!item || item.scope !== scope || item.folder === name) return;
        e.preventDefault();
        void moveItem(item, name).catch((err) =>
          setActionError(
            `Could not move the item: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      },
    };
  };

  /** Drop props for the "no folder" strip of one area. */
  const noFolderDropProps = (scope: string) => {
    const key = `nofolder::${scope}`;
    return {
      onDragOver: (e: DragEvent) => {
        if (!dragging || dragging.scope !== scope) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        setDropTarget(key);
      },
      onDragLeave: () =>
        setDropTarget((current) => (current === key ? null : current)),
      onDrop: (e: DragEvent) => {
        const item = readDrag(e) ?? dragging;
        setDragging(null);
        setDropTarget(null);
        if (!item || item.scope !== scope || !item.folder) return;
        e.preventDefault();
        void moveItem(item, null).catch((err) =>
          setActionError(
            `Could not move the item: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      },
    };
  };

  // ── Lists ──

  // Archived rows leave the main lists; they live in the Archived section.
  const archivedTexts = texts.filter((t) => t.archived);
  const archivedThreads = threads.filter((t) => t.archived);
  const archivedCount = archivedTexts.length + archivedThreads.length;

  const activeTextId =
    view.kind === "read" || view.kind === "edit" ? view.id : null;
  const activeThreadId =
    view.kind === "discussion" ? (view.id ?? null) : null;

  /** The folder names offered by the move dialog for one area. */
  const folderNamesFor = (scope: string): string[] =>
    folderGroupsFor(
      registryFolders,
      scope,
      texts.filter((t) => scopeOf(t.projectId) === scope),
      threads.filter((t) => scopeOf(t.projectId) === scope),
    ).map((g) => g.name);

  const renderTextRow = (t: LibraryTextMeta, scope: string) => (
    <div
      key={t.id}
      draggable
      onDragStart={beginDrag({
        kind: "text",
        id: t.id,
        scope,
        ...(t.folder ? { folder: t.folder } : {}),
      })}
      onDragEnd={endDrag}
      className={`${rowClass(activeTextId === t.id)} group`}
    >
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
      <RowAction
        label={`Move document ${t.title} to a folder`}
        title={t.folder ? `In folder “${t.folder}” — move` : "Move to folder"}
        onClick={() => openMoveDialog("text", t, scope)}
        icon={
          <FolderInput className={`size-3 ${t.folder ? "text-primary" : ""}`} />
        }
      />
    </div>
  );

  const renderThreadRow = (t: ThreadMeta, scope: string) => (
    <div
      key={t.id}
      draggable
      onDragStart={beginDrag({
        kind: "thread",
        id: t.id,
        scope,
        ...(t.folder ? { folder: t.folder } : {}),
      })}
      onDragEnd={endDrag}
      className={`${rowClass(activeThreadId === t.id)} group`}
    >
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
        onClick={() => openMoveDialog("thread", t, scope)}
        icon={
          <FolderInput className={`size-3 ${t.folder ? "text-primary" : ""}`} />
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

  /** The "drag out of the folder" strip, visible only while dragging an
   * item that currently sits in a folder of this area. */
  const renderNoFolderZone = (scope: string) => {
    if (!dragging || dragging.scope !== scope || !dragging.folder) return null;
    const active = dropTarget === `nofolder::${scope}`;
    return (
      <div
        {...noFolderDropProps(scope)}
        className={`mx-2 mb-1 rounded-md border border-dashed px-2 py-1.5 text-[11px] text-center transition-colors ${
          active
            ? "border-primary bg-primary/10 text-text-primary"
            : "border-border text-text-muted"
        }`}
      >
        Drop here to remove from “{dragging.folder}”
      </div>
    );
  };

  const renderFolderGroup = (scope: string, group: FolderGroup) => {
    const key = `${scope}::${group.name}`;
    const collapsed = collapsedFolders.has(key);
    const count = group.texts.length + group.threads.length;
    const isDrop = dropTarget === `folder::${scope}::${group.name}`;
    return (
      <div key={key}>
        <div
          {...folderDropProps(scope, group.name)}
          className={`flex items-center gap-1 group rounded-md transition-colors ${
            isDrop ? "ring-2 ring-primary/60 bg-primary/5" : ""
          }`}
        >
          <button
            type="button"
            className="flex-1 flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-text-secondary hover:bg-surface-alt hover:text-text-primary transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-expanded={!collapsed}
            aria-controls={`folder-${key}-children`}
            onClick={() => toggleFolder(key)}
            title={group.name}
          >
            {collapsed ? (
              <ChevronRight className="size-3 shrink-0" />
            ) : (
              <ChevronDown className="size-3 shrink-0" />
            )}
            <FolderOpen className="size-3.5 shrink-0" />
            <span className="truncate font-medium">{group.name}</span>
            <span className="shrink-0 text-[10px] text-text-muted">{count}</span>
          </button>
          <RowAction
            label={`New document in ${group.name}`}
            title={`New document in “${group.name}”`}
            onClick={() => void handleNewTextInFolder(scope, group.name)}
            icon={<BookPlus className="size-3" />}
          />
          <RowAction
            label={`New conversation in ${group.name}`}
            title={`New conversation in “${group.name}”`}
            onClick={() => void handleNewDiscussionInFolder(scope, group.name)}
            icon={<MessageSquarePlus className="size-3" />}
          />
          <RowAction
            label={`Rename folder ${group.name}`}
            title="Rename folder"
            onClick={() =>
              setFolderRename({ scope, name: group.name, value: group.name })
            }
            icon={<Pencil className="size-3" />}
          />
          <RowAction
            label={`Delete folder ${group.name}`}
            title="Delete folder"
            onClick={() =>
              setFolderDelete({
                scope,
                name: group.name,
                texts: group.texts.length,
                threads: group.threads.length,
              })
            }
            icon={<Trash2 className="size-3" />}
          />
        </div>
        {!collapsed && (
          <div
            id={`folder-${key}-children`}
            className="ml-4 border-l border-border pl-2 space-y-0.5"
          >
            {count === 0 ? (
              <p className="px-2 py-1 text-[11px] text-text-muted italic">
                Empty — drag texts or chats here.
              </p>
            ) : (
              <>
                {group.texts.map((t) => renderTextRow(t, scope))}
                {group.threads.map((t) => renderThreadRow(t, scope))}
              </>
            )}
          </div>
        )}
      </div>
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
        const projectTexts = texts.filter(
          (t) => t.projectId === project.id && !t.archived,
        );
        const projectThreads = threads.filter(
          (t) => t.projectId === project.id && !t.archived,
        );
        const groups = folderGroupsFor(
          registryFolders,
          project.id,
          projectTexts,
          projectThreads,
        );
        const looseTexts = pinnedFirst(
          projectTexts.filter((t) => !t.folder?.trim()),
        );
        const looseThreads = pinnedFirst(
          projectThreads.filter((t) => !t.folder?.trim()),
        );
        const isProjectActive =
          view.kind === "project" && view.id === project.id;
        const isBriefActive =
          view.kind === "brief" && view.id === project.id;
        return (
          <div key={project.id}>
            <div className={`${rowClass(isProjectActive)} group`}>
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
              <RowAction
                label={`New folder in ${project.title}`}
                title="New folder"
                onClick={() => {
                  setNewFolderScope(project.id);
                  setNewFolderName("");
                }}
                icon={<FolderPlus className="size-3" />}
              />
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
                {renderNoFolderZone(project.id)}
                {groups.map((g) => renderFolderGroup(project.id, g))}
                {looseTexts.map((t) => renderTextRow(t, project.id))}
                {looseThreads.map((t) => renderThreadRow(t, project.id))}
              </div>
            )}
          </div>
        );
      })}

      {/* Standalone folders (shared by documents and conversations) */}
      <div className="flex items-center justify-between px-2 pt-3 pb-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary select-none">
          Folders
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            setNewFolderScope("");
            setNewFolderName("");
          }}
          title="New folder"
          aria-label="New folder"
          className="size-5"
        >
          <FolderPlus className="size-3.5" />
        </Button>
      </div>
      {renderNoFolderZone("")}
      {(() => {
        const standaloneTexts = texts.filter(
          (t) => scopeOf(t.projectId) === "" && !t.archived,
        );
        const standaloneThreads = threads.filter(
          (t) => scopeOf(t.projectId) === "" && !t.archived,
        );
        const groups = folderGroupsFor(
          registryFolders,
          "",
          standaloneTexts,
          standaloneThreads,
        );
        if (groups.length === 0) {
          return (
            <p className="px-2 pb-1 text-[11px] text-text-muted">
              No folders yet — create one, then drag documents or
              conversations in.
            </p>
          );
        }
        return groups.map((g) => renderFolderGroup("", g));
      })()}

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
      {pinnedFirst(
        texts.filter((t) => scopeOf(t.projectId) === "" && !t.archived && !t.folder?.trim()),
      ).map((t) => renderTextRow(t, ""))}

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
      {pinnedFirst(
        threads.filter((t) => scopeOf(t.projectId) === "" && !t.archived && !t.folder?.trim()),
      ).map((t) => renderThreadRow(t, ""))}

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

      {/* Create a folder (standalone area or a project) */}
      <Dialog
        open={newFolderScope !== null}
        onOpenChange={(o) => {
          if (!o) {
            setNewFolderScope(null);
            setNewFolderName("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Folders hold documents and conversations together. Drag items
              in and out at any time.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="Folder name…"
            aria-label="Folder name"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateFolder();
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setNewFolderScope(null);
                setNewFolderName("");
              }}
            >
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/80 text-primary-foreground"
              onClick={() => void handleCreateFolder()}
              disabled={!newFolderName.trim()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename a folder */}
      <Dialog
        open={folderRename !== null}
        onOpenChange={(o) => !o && setFolderRename(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
            <DialogDescription>
              Every document and conversation in the folder keeps its place.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={folderRename?.value ?? ""}
            onChange={(e) =>
              setFolderRename((r) =>
                r ? { ...r, value: e.target.value } : r,
              )
            }
            aria-label="Folder name"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRenameFolder();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderRename(null)}>
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/80 text-primary-foreground"
              onClick={() => void handleRenameFolder()}
              disabled={!folderRename?.value.trim()}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete a folder (contents move out, nothing is deleted) */}
      <Dialog
        open={folderDelete !== null}
        onOpenChange={(o) => !o && setFolderDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{folderDelete?.name}”?</DialogTitle>
            <DialogDescription>
              {folderDelete && folderDelete.texts + folderDelete.threads > 0
                ? `Folder “${folderDelete.name}” will be removed. Its ${
                    folderDelete.texts
                  } document${folderDelete.texts === 1 ? "" : "s"} and ${
                    folderDelete.threads
                  } conversation${
                    folderDelete.threads === 1 ? "" : "s"
                  } move out — nothing is deleted.`
                : "The empty folder will be removed."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteFolder()}>
              Delete folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move an item into a folder (keyboard-accessible path) */}
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
            <DialogTitle>Move to folder</DialogTitle>
            <DialogDescription>
              “{moveTarget?.title}” moves to the folder. Leave the name empty
              to remove it from its folder.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={moveFolder}
            onChange={(e) => setMoveFolder(e.target.value)}
            placeholder="Folder name…"
            list="navigator-folders"
            aria-label="Folder name"
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitMove();
            }}
          />
          <datalist id="navigator-folders">
            {(moveTarget ? folderNamesFor(moveTarget.scope) : []).map((f) => (
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
