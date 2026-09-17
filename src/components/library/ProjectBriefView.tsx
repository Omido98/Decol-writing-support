import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useProjectStore } from "@/stores/projectStore";
import { useDraftStore, flushDrafts } from "@/stores/draftStore";
import { useAppStore } from "@/stores/useAppStore";
import { repo } from "@/utils/repository";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeft, BookOpenCheck, Check, Pencil, Save } from "lucide-react";

/**
 * The project brief as its OWN view: read the full brief, edit it, or ask
 * the chat agent to develop it. The project page (ProjectDetail) lists the
 * brief as a collapsed row that opens this view.
 */
export default function ProjectBriefView({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const project = useProjectStore((s) => s.projects.find((p) => p.id === id) ?? null);
  const updateProject = useProjectStore((s) => s.updateProject);
  const requestBriefChat = useProjectStore((s) => s.requestBriefChat);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setView = useAppStore((s) => s.setView);

  const [briefContent, setBriefContent] = useState<string | null>(null);
  const [editingBrief, setEditingBrief] = useState(false);
  const [briefDraft, setBriefDraft] = useState("");
  const [briefSaved, setBriefSaved] = useState(false);
  const [briefSaving, setBriefSaving] = useState(false);
  // Renaming the project (the brief carries its title) from the view the
  // title is read in — no detour through the project's Edit details.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");

  // Draft session: the brief draft lives OUT of component state, so
  // switching projects/tabs keeps it and a restart recovers it.
  const briefKey = `project-brief:${id}`;
  const brief = useDraftStore((s) => s.drafts[briefKey] ?? null);
  const setDraft = useDraftStore((s) => s.setDraft);
  const markError = useDraftStore((s) => s.markError);
  const clearDraft = useDraftStore((s) => s.clearDraft);

  // Load the brief once per project (cached).
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
        <Button
          variant="outline"
          size="sm"
          onClick={() => setView({ kind: "list" })}
        >
          <ArrowLeft className="size-4 mr-1" />
          Back to library
        </Button>
      </div>
    );
  }

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

  const handleRenameProject = async () => {
    const trimmed = renameTitle.trim();
    if (!trimmed || trimmed === project.title) {
      setRenameOpen(false);
      return;
    }
    await updateProject(id, { title: trimmed });
    setRenameOpen(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border shrink-0 flex-wrap">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          title="Back to project"
          aria-label="Back to project"
        >
          <ArrowLeft className="size-4 text-text-secondary" />
        </Button>
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-text-primary truncate">
            {project.title}
          </span>
          <button
            type="button"
            onClick={() => {
              setRenameTitle(project.title);
              setRenameOpen(true);
            }}
            className="shrink-0 rounded p-1 hover:bg-border transition-colors"
            title="Rename the project (the brief carries its title)"
            aria-label="Rename project"
          >
            <Pencil className="size-3.5 text-text-secondary" />
          </button>
          <span className="shrink-0 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/30 text-[11px] font-medium text-text-primary">
            Brief
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
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
              <Button variant="ghost" size="sm" onClick={discardBriefDraft}>
                Discard
              </Button>
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

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
          {editingBrief ? (
            <>
              {brief?.error && (
                <div
                  role="alert"
                  className="mb-2 flex items-center gap-3 rounded-lg border border-border bg-surface-alt px-3 py-2 text-xs text-text-secondary"
                >
                  <span className="flex-1">
                    {brief.error} Your text is kept; retry or discard explicitly.
                  </span>
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
        </div>
      </div>

      {/* Rename the project (the brief is identified by its title) */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>
              The project brief is identified by this title everywhere.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameTitle}
            onChange={(e) => setRenameTitle(e.target.value)}
            aria-label="Project title"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRenameProject();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/80 text-primary-foreground"
              onClick={() => void handleRenameProject()}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
