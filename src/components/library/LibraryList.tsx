import { useEffect, useState } from "react";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { exportTexts, importFiles } from "@/utils/libraryIo";
import { markdownFromRich } from "@/utils/richMarkdown";
import { textTypeLabel, type LibraryTextMeta } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BookPlus,
  CheckSquare,
  Download,
  FileInput,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Loader2,
  Search,
  Trash2,
  X,
} from "lucide-react";

type TypeFilter = "all" | (typeof TEXT_TYPE_IDS)[number];
/**
 * Folder filters: sentinel values ("all" / "none") are encoded SEPARATELY
 * from concrete folders — a concrete folder always travels as
 * `folder:<name>`, so a folder literally called "none" or "all" remains
 * selectable and usable.
 */
type FolderFilter = "all" | "none" | `folder:${string}`;
type ProjectFilter = "all" | "standalone" | string;
type SortOrder = "recent" | "title" | "created";

const TEXT_TYPE_IDS = [
  "essay",
  "article",
  "research-paper",
  "letter",
  "talk",
  "other",
] as const;

const TYPE_FILTER_LABELS: Record<TypeFilter, string> = {
  all: "All types",
  essay: "Essays",
  article: "Articles",
  "research-paper": "Research papers",
  letter: "Letters",
  talk: "Talks",
  other: "Other",
};

const SORT_LABELS: Record<SortOrder, string> = {
  recent: "Recently updated",
  created: "Newest first",
  title: "Title A–Z",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function LibraryList({
  onOpen,
  onNew,
  onOpenProject,
}: {
  onOpen: (id: string) => void;
  onNew: (prefill?: { content: string }) => void;
  onOpenProject: (id: string) => void;
}) {
  const texts = useLibraryStore((s) => s.texts);
  const projects = useProjectStore((s) => s.projects);
  const projectsLoaded = useProjectStore((s) => s.projectsLoaded);
  const loadProjects = useProjectStore((s) => s.loadProjects);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("recent");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveFolder, setMoveFolder] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectTarget, setProjectTarget] = useState<string>("standalone");
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!projectsLoaded) void loadProjects();
  }, [projectsLoaded, loadProjects]);

  const handleCreateProject = async () => {
    const id = await useProjectStore.getState().createProject({
      title: newProjectTitle,
      description: newProjectDescription,
    });
    setCreateProjectOpen(false);
    setNewProjectTitle("");
    setNewProjectDescription("");
    onOpenProject(id);
  };

  const folders = [
    ...new Set(
      texts.map((t) => t.folder).filter((f): f is string => !!f),
    ),
  ].sort();

  const filtered = texts
    .filter((t) => {
      if (
        search.trim() &&
        !`${t.title} ${t.snippet ?? ""}`
          .toLowerCase()
          .includes(search.trim().toLowerCase())
      ) {
        return false;
      }
      if (typeFilter !== "all" && t.textType !== typeFilter) return false;
      if (folderFilter === "none") {
        // "No folder" matches texts without a folder.
        if (t.folder) return false;
      } else if (folderFilter !== "all" && t.folder !== folderFilter.slice("folder:".length)) {
        return false;
      }
      if (projectFilter === "standalone" && t.projectId) return false;
      if (
        projectFilter !== "all" &&
        projectFilter !== "standalone" &&
        t.projectId !== projectFilter
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortOrder === "title") return a.title.localeCompare(b.title);
      if (sortOrder === "created") return a.createdAt < b.createdAt ? 1 : -1;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const projectStats = (projectId: string) => {
    const members = texts.filter((t) => t.projectId === projectId);
    return {
      count: members.length,
      words: members.reduce((sum, t) => sum + (t.wordCount ?? 0), 0),
    };
  };

  const showProjects = projectFilter === "all";

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const handleNew = async () => {
    // Paste-anywhere: if the clipboard holds text, open the editor
    // pre-filled with it. Falls back to an empty editor.
    try {
      const clip = await navigator.clipboard.readText();
      if (clip.trim()) {
        onNew({ content: clip });
        return;
      }
    } catch {
      // Clipboard unavailable — plain empty editor.
    }
    onNew();
  };

  const handleImport = async () => {
    setImporting(true);
    // Only a CONCRETE folder selection (encoded `folder:<name>`) pre-assigns
    // imported texts; the sentinels ("all"/"none") never match a real
    // folder name.
    const folder = folderFilter.startsWith("folder:")
      ? folderFilter.slice("folder:".length)
      : undefined;
    await importFiles(folder);
    setImporting(false);
  };

  const handleDeleteSelected = async () => {
    for (const id of selected) {
      await useLibraryStore.getState().deleteText(id);
    }
    setConfirmDelete(false);
    exitSelection();
  };

  const handleExportSelected = async () => {
    setExporting(true);
    const store = useLibraryStore.getState();
    const items: { meta: LibraryTextMeta; content: string }[] = [];
    for (const id of selected) {
      const meta = store.texts.find((t) => t.id === id);
      if (meta) {
        // Exports go through the editor's own markdown serializer:
        // markdown bodies pass through untouched, rich bodies keep their
        // structure (headings, lists, tables, links).
        const body = await store.loadTextContent(id);
        items.push({ meta, content: markdownFromRich(body) });
      }
    }
    await exportTexts(items);
    setExporting(false);
    exitSelection();
  };

  const handleMoveSelected = async () => {
    const folder = moveFolder.trim();
    for (const id of selected) {
      await useLibraryStore.getState().updateText(id, { folder });
    }
    setMoveOpen(false);
    setMoveFolder("");
    exitSelection();
  };

  const handleProjectSelected = async () => {
    for (const id of selected) {
      await useLibraryStore
        .getState()
        .updateText(id, { projectId: projectTarget === "standalone" ? "" : projectTarget });
    }
    setProjectOpen(false);
    exitSelection();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border shrink-0 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-text-muted pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search texts…"
            className="pl-8 bg-field h-9"
            aria-label="Search texts"
          />
        </div>
        <div className="flex items-center gap-2 ml-auto">
          {selecting ? (
            <Button variant="outline" size="sm" onClick={exitSelection}>
              <X className="size-4 mr-1" />
              Cancel
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelecting(true)}
              disabled={texts.length === 0}
            >
              <CheckSquare className="size-4 mr-1" />
              Select
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void handleImport()}>
            {importing ? (
              <Loader2 className="size-4 mr-1 animate-spin" />
            ) : (
              <FileInput className="size-4 mr-1" />
            )}
            Import
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCreateProjectOpen(true)}
            title="Create a new project"
          >
            <FolderPlus className="size-4 mr-1" />
            New project
          </Button>
          <Button
            size="sm"
            className="bg-primary hover:bg-primary/80 text-primary-foreground"
            onClick={() => void handleNew()}
          >
            <BookPlus className="size-4 mr-1" />
            New text
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 px-6 py-2 border-b border-border shrink-0 flex-wrap">
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
          <SelectTrigger className="w-[150px] h-8 bg-surface text-xs" aria-label="Filter by type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TYPE_FILTER_LABELS) as TypeFilter[]).map((id) => (
              <SelectItem key={id} value={id}>
                {TYPE_FILTER_LABELS[id]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={projectFilter}
          onValueChange={(v) => setProjectFilter(v as ProjectFilter)}
        >
          <SelectTrigger className="w-[170px] h-8 bg-surface text-xs" aria-label="Filter by project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            <SelectItem value="standalone">Standalone texts</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="truncate max-w-[160px] block">{p.title}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={folderFilter}
          onValueChange={(v) => setFolderFilter(v as FolderFilter)}
        >
          <SelectTrigger className="w-[140px] h-8 bg-surface text-xs" aria-label="Filter by folder">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All folders</SelectItem>
            <SelectItem value="none">No folder</SelectItem>
            {folders.map((folder) => (
              <SelectItem key={folder} value={`folder:${folder}`}>
                {folder}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as SortOrder)}>
          <SelectTrigger className="w-[170px] h-8 bg-surface text-xs" aria-label="Sort order">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABELS) as SortOrder[]).map((id) => (
              <SelectItem key={id} value={id}>
                {SORT_LABELS[id]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Bulk action bar */}
      {selecting && selected.size > 0 && (
        <div className="flex items-center gap-2 px-6 py-2 border-b border-border bg-surface-alt shrink-0 flex-wrap">
          <span className="text-xs text-text-secondary mr-2">
            {selected.size} selected
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMoveOpen(true)}
          >
            <FolderInput className="size-4 mr-1" />
            Move to folder
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const first = [...selected]
                .map((id) => texts.find((t) => t.id === id))
                .find((t) => !!t);
              setProjectTarget(first?.projectId ?? "standalone");
              setProjectOpen(true);
            }}
          >
            <FolderOpen className="size-4 mr-1" />
            Project
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleExportSelected()}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="size-4 mr-1 animate-spin" />
            ) : (
              <Download className="size-4 mr-1" />
            )}
            Export
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive border-destructive/40 hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="size-4 mr-1" />
            Delete
          </Button>
        </div>
      )}

      {/* Cards */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* Projects section */}
        {showProjects && projects.length > 0 && (
          <div className="max-w-4xl mx-auto mb-6">
            <div className="grid gap-3">
              {projects.map((p) => {
                const stats = projectStats(p.id);
                return (
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenProject(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenProject(p.id);
                      }
                    }}
                    className="flex items-start gap-3 rounded-lg border border-border bg-surface px-5 py-4 cursor-pointer hover:border-primary/40 transition-colors text-left"
                  >
                    <FolderOpen className="size-5 mt-0.5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-text-primary truncate max-w-full">
                          {p.title}
                        </span>
                        <span className="shrink-0 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/30 text-[11px] font-medium text-text-primary">
                          Project
                        </span>
                      </div>
                      {p.description && (
                        <p className="mt-1 text-sm text-text-secondary line-clamp-1">
                          {p.description}
                        </p>
                      )}
                      <p className="mt-1.5 text-[11px] text-text-muted select-none">
                        {stats.count} text{stats.count === 1 ? "" : "s"} ·{" "}
                        {stats.words.toLocaleString()} words
                        {p.briefWordCount
                          ? ` · brief ${p.briefWordCount.toLocaleString()} words`
                          : " · no brief yet"}{" "}
                        · updated {formatDate(p.updatedAt)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-text-primary text-lg font-semibold">
              {texts.length === 0 ? "Your library is empty" : "No texts match"}
            </p>
            <p className="text-text-muted text-sm mt-2 max-w-md">
              {texts.length === 0
                ? "Save a text from the chat with the bookmark button, paste one in with New text, or import a file."
                : "Try a different search, type, project, or folder filter."}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 max-w-4xl mx-auto">
            {filtered.map((t) => {
              const project = t.projectId ? projectById.get(t.projectId) : null;
              return (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => (selecting ? toggleSelected(t.id) : onOpen(t.id))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selecting ? toggleSelected(t.id) : onOpen(t.id);
                    }
                  }}
                  className="flex items-start gap-3 rounded-lg border border-border bg-surface px-5 py-4 cursor-pointer hover:border-primary/40 transition-colors text-left"
                >
                  {selecting && (
                    <Checkbox
                      checked={selected.has(t.id)}
                      onCheckedChange={() => toggleSelected(t.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1"
                      aria-label={`Select ${t.title}`}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-text-primary truncate max-w-full">
                        {t.title}
                      </span>
                      <span className="shrink-0 px-2 py-0.5 rounded-full bg-surface-alt border border-border text-[11px] font-medium text-text-secondary">
                        {textTypeLabel(t.textType)}
                      </span>
                      {project && (
                        <span className="shrink-0 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/30 text-[11px] font-medium text-text-primary flex items-center gap-1 max-w-[200px]">
                          <FolderOpen className="size-3 shrink-0" />
                          <span className="truncate">{project.title}</span>
                        </span>
                      )}
                      {t.folder && (
                        <span className="shrink-0 px-2 py-0.5 rounded-full bg-surface-alt border border-border text-[11px] font-medium text-text-secondary flex items-center gap-1">
                          <FolderInput className="size-3" />
                          {t.folder}
                        </span>
                      )}
                    </div>
                    {t.snippet && (
                      <p className="mt-1.5 text-sm text-text-secondary line-clamp-2 [font-family:var(--font-doc)]">
                        {t.snippet}
                      </p>
                    )}
                    <p className="mt-1.5 text-[11px] text-text-muted select-none">
                      {t.wordCount ?? 0} words · updated {formatDate(t.updatedAt)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {selected.size === 1 ? "text" : `${selected.size} texts`}?
            </DialogTitle>
            <DialogDescription>
              This permanently deletes the selected text
              {selected.size === 1 ? "" : "s"}, including version history. It
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteSelected()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move to folder */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to folder</DialogTitle>
            <DialogDescription>
              One level of organization. Leave empty to remove the selected
              text{selected.size === 1 ? "" : "s"} from any folder.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={moveFolder}
            onChange={(e) => setMoveFolder(e.target.value)}
            placeholder="Folder name…"
            list="library-folders"
            className="bg-field"
          />
          <datalist id="library-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/80 text-primary-foreground"
              onClick={() => void handleMoveSelected()}
            >
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create project */}
      <Dialog open={createProjectOpen} onOpenChange={setCreateProjectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A project groups texts that share an audience, voice, and
              background. You can develop its brief with the chat agent in
              Project mode.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-project-title">Title</Label>
              <Input
                id="new-project-title"
                value={newProjectTitle}
                onChange={(e) => setNewProjectTitle(e.target.value)}
                placeholder="e.g. Essays on extractivism"
                className="bg-field"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newProjectTitle.trim()) {
                    void handleCreateProject();
                  }
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-project-description">Description (optional)</Label>
              <Input
                id="new-project-description"
                value={newProjectDescription}
                onChange={(e) => setNewProjectDescription(e.target.value)}
                placeholder="One line on what the project is"
                className="bg-field"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateProjectOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/80 text-primary-foreground"
              onClick={() => void handleCreateProject()}
              disabled={!newProjectTitle.trim()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign to project */}
      <Dialog open={projectOpen} onOpenChange={setProjectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Project membership</DialogTitle>
            <DialogDescription>
              Move the selected text
              {selected.size === 1 ? "" : "s"} into a project, or make them
              standalone. Project texts build on their project&apos;s brief.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="project-target">Project</Label>
            <Select value={projectTarget} onValueChange={(v) => setProjectTarget(v ?? "standalone")}>
              <SelectTrigger id="project-target" className="w-full bg-field">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standalone">Standalone (no project)</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="truncate max-w-[320px] block">{p.title}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProjectOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/80 text-primary-foreground"
              onClick={() => void handleProjectSelected()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
