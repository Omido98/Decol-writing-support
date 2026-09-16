import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useDraftStore, flushDrafts } from "@/stores/draftStore";
import { useAppStore } from "@/stores/useAppStore";
import { repo } from "@/utils/repository";
import {
  AUDIENCES,
  CITATION_STYLES,
  TONES,
  audienceLabel,
  citationLabel,
  textTypeLabel,
  toneLabel,
  type AudienceId,
  type CitationId,
  type ToneId,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  ArrowLeft,
  BookPlus,
  BookOpenCheck,
  Check,
  FolderInput,
  Pencil,
  Save,
  Trash2,
} from "lucide-react";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function ProjectDetail({
  id,
  onBack,
  onOpenText,
  onEditText,
  onNewText,
}: {
  id: string;
  onBack: () => void;
  onOpenText: (id: string) => void;
  onEditText: (id: string) => void;
  onNewText: (projectId: string) => void;
}) {
  const project = useProjectStore((s) => s.projects.find((p) => p.id === id) ?? null);
  const updateProject = useProjectStore((s) => s.updateProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const requestBriefChat = useProjectStore((s) => s.requestBriefChat);
  const texts = useLibraryStore((s) => s.texts);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const [briefContent, setBriefContent] = useState<string | null>(null);
  const [editingBrief, setEditingBrief] = useState(false);
  const [briefDraft, setBriefDraft] = useState("");
  const [briefSaved, setBriefSaved] = useState(false);
  const [briefSaving, setBriefSaving] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Draft session: the brief draft lives OUT of component state, so
  // switching projects/tabs keeps it and a restart recovers it.
  const briefKey = `project-brief:${id}`;
  const brief = useDraftStore((s) => s.drafts[briefKey] ?? null);
  const setDraft = useDraftStore((s) => s.setDraft);
  const markError = useDraftStore((s) => s.markError);
  const clearDraft = useDraftStore((s) => s.clearDraft);

  // Edit dialog fields
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [defaultAudience, setDefaultAudience] = useState<string>("none");
  const [defaultTone, setDefaultTone] = useState<string>("none");
  // "none" is a REAL citation option ("No citations"), so "not set" needs
  // its own sentinel — sharing them made "No citations" unpersistable.
  const [defaultCitations, setDefaultCitations] = useState<string>("__unset__");
  const [defaultLanguage, setDefaultLanguage] = useState("");
  const [references, setReferences] = useState("");

  const memberTexts = texts
    .filter((t) => t.projectId === id)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  // Load the brief once per project; drafts hydrate at startup.
  useEffect(() => {
    void useDraftStore.getState().hydrate();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBriefContent(null);
    void useProjectStore.getState().loadBriefContent(id).then((content) => {
      if (!cancelled) setBriefContent(content);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-text-muted text-sm">This project no longer exists.</p>
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4 mr-1" />
          Back to library
        </Button>
      </div>
    );
  }

  const openEditDialog = () => {
    setTitle(project.title);
    setDescription(project.description ?? "");
    setDefaultAudience(project.defaultAudience ?? "none");
    setDefaultTone(project.defaultTone ?? "none");
    setDefaultCitations(project.defaultCitations ?? "__unset__");
    setDefaultLanguage(project.defaultLanguage ?? "");
    setReferences(project.references ?? "");
    setEditOpen(true);
  };

  const handleSaveMeta = async () => {
    await updateProject(id, {
      title: title.trim() || project.title,
      description: description.trim(),
      defaultAudience: defaultAudience === "none" ? null : (defaultAudience as AudienceId),
      defaultTone: defaultTone === "none" ? null : (defaultTone as ToneId),
      defaultCitations:
        defaultCitations === "__unset__"
          ? null
          : (defaultCitations as CitationId),
      defaultLanguage: defaultLanguage.trim() || null,
      references: references.trim(),
    });
    setEditOpen(false);
  };

  const startEditingBrief = () => {
    // The recovered draft (typed in an earlier session or before unmount)
    // wins over the stored brief.
    setBriefDraft(brief?.content ?? briefContent ?? "");
    setEditingBrief(true);
  };

  const handleSaveBrief = async () => {
    // Capture the submitted revision: typing while the save is in flight
    // must stay dirty, and only the acknowledged revision is cleared.
    const submitted = briefDraft;
    setBriefSaving(true);
    try {
      await updateProject(id, { briefContent: submitted });
      // Acknowledged save: flush the debounced brief saves to disk before
      // reporting "Saved".
      await repo.flushProjectSaves();
      await repo.idle();
      const current = useDraftStore.getState().drafts[briefKey];
      const superseded = current != null && current.content !== submitted;
      if (!superseded) {
        clearDraft(briefKey);
        setEditingBrief(false);
      }
      await flushDrafts();
      setBriefContent(submitted);
      setBriefSaved(true);
      setTimeout(() => setBriefSaved(false), 1500);
    } catch (err) {
      // Keep newer typing untouched; record the failed revision exactly
      // when nothing newer was typed meanwhile.
      const current = useDraftStore.getState().drafts[briefKey];
      const unchanged = current == null || current.content === submitted;
      markError(
        briefKey,
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
        unchanged ? { content: submitted } : undefined,
      );
      await flushDrafts();
    } finally {
      setBriefSaving(false);
    }
  };

  const discardBriefDraft = () => {
    clearDraft(briefKey);
    setBriefDraft(briefContent ?? "");
    setEditingBrief(false);
  };

  const handleDeleteProject = async () => {
    // One domain operation: texts AND conversations are unlinked (they
    // survive as standalone) while the project and its brief are removed.
    await deleteProject(id);
    setConfirmDelete(false);
    onBack();
  };

  const defaultsLine = [
    project.defaultAudience ? audienceLabel(project.defaultAudience) : null,
    project.defaultTone ? toneLabel(project.defaultTone) : null,
    project.defaultCitations ? citationLabel(project.defaultCitations) : null,
    project.defaultLanguage,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border shrink-0 flex-wrap">
        <Button variant="ghost" size="icon-sm" onClick={onBack} title="Back to library" aria-label="Back to library">
          <ArrowLeft className="size-4 text-text-secondary" />
        </Button>
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-text-primary truncate">{project.title}</span>
          <span className="shrink-0 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/30 text-[11px] font-medium text-text-primary">
            Project
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" onClick={openEditDialog}>
            <Pencil className="size-4 mr-1 text-text-secondary" />
            Edit details
          </Button>
          <Button
            size="sm"
            className="bg-primary hover:bg-primary/80 text-primary-foreground"
            onClick={() => onNewText(id)}
          >
            <BookPlus className="size-4 mr-1" />
            New text in project
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setConfirmDelete(true)}
            title="Delete project"
            aria-label="Delete project"
          >
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
          {project.description && (
            <p className="text-sm text-text-secondary">{project.description}</p>
          )}
          {defaultsLine && (
            <p className="text-xs text-text-muted">
              Defaults: {defaultsLine}
            </p>
          )}

          {/* Project brief */}
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-text-primary">
                Project brief
              </h2>
              <div className="flex items-center gap-1">
                {editingBrief ? (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setEditingBrief(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="bg-primary hover:bg-primary/80 text-primary-foreground"
                      onClick={() => void handleSaveBrief()}
                    >
                      {briefSaved ? (
                        <Check className="size-4 mr-1" />
                      ) : (
                        <Save className="size-4 mr-1" />
                      )}
                      {briefSaving ? "Saving…" : briefSaved ? "Saved" : "Save brief"}
                    </Button>
                    {editingBrief && (
                      <Button variant="ghost" size="sm" onClick={discardBriefDraft}>
                        Discard
                      </Button>
                    )}
                  </>
                ) : (
                  <Button variant="outline" size="sm" onClick={startEditingBrief}>
                    <Pencil className="size-4 mr-1" />
                    {briefContent?.trim() ? "Edit brief" : "Write brief"}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    requestBriefChat(id);
                    setActiveTab("chat");
                  }}
                  title="Starts a project-brief conversation in the chat"
                >
                  <BookOpenCheck className="size-4 mr-1 text-text-secondary" />
                  Ask the chat
                </Button>
              </div>
            </div>
            {editingBrief ? (
              <>
                {brief?.error && (
                  <div
                    role="alert"
                    className="mb-2 flex items-center gap-3 rounded-lg border border-border bg-surface-alt px-3 py-2 text-xs text-text-secondary"
                  >
                    <span className="flex-1">{brief.error} Your text is kept; retry or discard explicitly.</span>
                    <Button size="sm" variant="outline" onClick={() => void handleSaveBrief()}>
                      Retry
                    </Button>
                    <Button size="sm" variant="ghost" onClick={discardBriefDraft}>
                      Discard draft
                    </Button>
                  </div>
                )}
                <Textarea
                  value={briefDraft}
                  onChange={(e) => {
                    setBriefDraft(e.target.value);
                    setDraft(briefKey, "project-brief", id, { content: e.target.value });
                  }}
                  placeholder="Purpose, audience, planned texts, structure, topics, voice, citations, must include, must avoid…"
                  className="bg-field min-h-[280px] resize-y [font-family:var(--font-doc)]"
                />
              </>
            ) : briefContent == null ? (
              <p className="text-text-muted text-sm">Loading…</p>
            ) : briefContent.trim() ? (
              <div className="rounded-lg border border-border bg-surface px-5 py-4">
                <div className="doc-markdown prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {briefContent}
                  </ReactMarkdown>
                </div>
              </div>
            ) : (
              <p className="text-sm text-text-muted italic">
                No project brief yet. Write it here, or develop one with the
                chat agent in Project mode — the agent interviews you and
                drafts the brief, then you save it to this project.
              </p>
            )}
          </section>

          {/* Texts of the project */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-text-primary">
              Texts ({memberTexts.length})
            </h2>
            {memberTexts.length === 0 ? (
              <p className="text-sm text-text-muted">
                No texts in this project yet. Use “New text in project” or
                move an existing text here from the library.
              </p>
            ) : (
              <div className="grid gap-2">
                {memberTexts.map((t) => (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenText(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenText(t.id);
                      }
                    }}
                    className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 cursor-pointer hover:border-primary/40 transition-colors text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-text-primary truncate">
                          {t.title}
                        </span>
                        <span className="shrink-0 px-2 py-0.5 rounded-full bg-surface-alt border border-border text-[11px] font-medium text-text-secondary">
                          {textTypeLabel(t.textType)}
                        </span>
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] text-text-muted select-none">
                      {t.wordCount ?? 0} words · {formatDate(t.updatedAt)}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditText(t.id);
                      }}
                      className="shrink-0 rounded p-1 hover:bg-border transition-colors"
                      title={`Edit ${t.title}`}
                      aria-label={`Edit ${t.title}`}
                    >
                      <Pencil className="size-3.5 text-text-secondary" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Edit project details */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>
              The defaults pre-fill the writing brief of texts started in this
              project. They can still be overridden per text.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="project-title">Title</Label>
              <Input
                id="project-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="bg-field"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-description">Description</Label>
              <Input
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One line on what the project is"
                className="bg-field"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Audience</Label>
                <Select value={defaultAudience} onValueChange={(v) => setDefaultAudience(v ?? "none")}>
                  <SelectTrigger className="w-full bg-field">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not set</SelectItem>
                    {AUDIENCES.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Tone</Label>
                <Select value={defaultTone} onValueChange={(v) => setDefaultTone(v ?? "none")}>
                  <SelectTrigger className="w-full bg-field">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not set</SelectItem>
                    {TONES.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Citations</Label>
                <Select value={defaultCitations} onValueChange={(v) => setDefaultCitations(v ?? "__unset__")}>
                  <SelectTrigger className="w-full bg-field">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unset__">Not set</SelectItem>
                    {CITATION_STYLES.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="project-language">Language</Label>
                <Input
                  id="project-language"
                  value={defaultLanguage}
                  onChange={(e) => setDefaultLanguage(e.target.value)}
                  placeholder="e.g. English"
                  className="bg-field"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-references">References</Label>
              <Textarea
                id="project-references"
                value={references}
                onChange={(e) => setReferences(e.target.value)}
                placeholder="Links, authors, books, theories the project builds on…"
                className="bg-field min-h-[96px] resize-y"
              />
              <p className="text-xs text-text-muted">
                Given to the chat agent as source material in every
                conversation of this project.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/80 text-primary-foreground"
              onClick={() => void handleSaveMeta()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete project */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{project.title}”?</DialogTitle>
            <DialogDescription>
              The project brief is deleted. Its{" "}
              {memberTexts.length === 1
                ? "text stays"
                : `${memberTexts.length} texts stay`}{" "}
              in the library as standalone text
              {memberTexts.length === 1 ? "" : "s"}. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteProject()}>
              <FolderInput className="size-4 mr-1" />
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
