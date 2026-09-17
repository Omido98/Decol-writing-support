import { useAppStore } from "@/stores/useAppStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useDatasetGeneration } from "@/utils/datasetGeneration";
import LibraryReader from "@/components/library/LibraryReader";
import DocumentEditorView from "@/components/editor/DocumentEditorView";
import LibraryList from "@/components/library/LibraryList";
import ProjectDetail from "@/components/library/ProjectDetail";
import ProjectBriefView from "@/components/library/ProjectBriefView";
import ChatTab from "@/components/tabs/ChatTab";
import { Button } from "@/components/ui/button";
import { BookPlus, MessageSquarePlus } from "lucide-react";

/** The centre of the workspace: the manuscript, project brief, or
 * conversation — one focus at a time. Document edits run in the rich
 * editor (Phase 4) with its own session, drafts, and save discipline. */
export default function DocumentPane({
  onOpenSettings,
}: {
  /** Opens the real Settings dialog (owned by the workspace shell). */
  onOpenSettings: () => void;
}) {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const openText = useAppStore((s) => s.openText);
  const openProject = useAppStore((s) => s.openProject);
  const openBrief = useAppStore((s) => s.openBrief);
  const openNewDocument = useAppStore((s) => s.openNewDocument);
  // A dataset replacement (restore) must replace what is on screen, even
  // when the ids are identical: remount the pane on every generation bump.
  const datasetGeneration = useDatasetGeneration();

  const pane = (() => {
    switch (view.kind) {
      case "read":
        return (
          <LibraryReader
            id={view.id}
            onBack={() => setView({ kind: "list" })}
            onEdit={(id) => setView({ kind: "edit", id })}
          />
        );
      case "edit":
        return (
          <DocumentEditorView
            key={view.id ?? view.sessionId ?? "new"}
            id={view.id}
            sessionId={view.sessionId}
            projectId={view.projectId}
            initial={view.prefill}
            onBack={() =>
              view.id ? openText(view.id) : setView({ kind: "list" })
            }
            onSaved={(id) => openText(id)}
          />
        );
      case "project":
        return (
          <ProjectDetail
            // Keyed by project identity: switching projects fully resets
            // the edit-dialog state (no A → B leakage).
            key={view.id}
            id={view.id}
            onBack={() => setView({ kind: "list" })}
            onOpenText={openText}
            onEditText={(id) => setView({ kind: "edit", id })}
            onNewText={(projectId) => openNewDocument({ projectId })}
            onOpenBrief={openBrief}
          />
        );
      case "brief":
        return (
          <ProjectBriefView
            // Keyed by project identity: switching projects resets the
            // brief editor and cannot leak another project's draft.
            key={view.id}
            id={view.id}
            onBack={() => openProject(view.id)}
          />
        );
      case "discussion":
        return <ChatTab onOpenSettings={onOpenSettings} />;
      case "manage":
        // The full library surface: filters, bulk import/export, folders.
        return (
          <LibraryList
            onOpen={(id) => setView({ kind: "read", id })}
            onNew={(prefill) =>
              openNewDocument(
                prefill ? { prefill: { content: prefill.content } } : {},
              )
            }
            onOpenProject={(id) => setView({ kind: "project", id })}
          />
        );
      case "list":
      default:
        return <EmptyWorkspace />;
    }
  })();

  return (
    <div key={datasetGeneration} className="contents">
      {pane}
    </div>
  );
}

/** The document-centred empty state: teach, don't scold. */
function EmptyWorkspace() {
  const setView = useAppStore((s) => s.setView);
  const openDiscussion = useAppStore((s) => s.openDiscussion);
  const createText = useLibraryStore((s) => s.createText);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
      <p className="text-text-muted text-sm max-w-[48ch]">
        Select a project, document, or conversation from the navigator — or
        start something new.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          className="bg-primary hover:bg-primary/80 text-primary-foreground"
          onClick={() => {
            void createText().then((id) => setView({ kind: "edit", id }));
          }}
        >
          <BookPlus className="size-4 mr-1.5" />
          New blank document
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openDiscussion(null)}
        >
          <MessageSquarePlus className="size-4 mr-1.5" />
          Open the assistant
        </Button>
      </div>
    </div>
  );
}
