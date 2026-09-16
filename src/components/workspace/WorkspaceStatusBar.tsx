import { useEffect, useState } from "react";
import {
  PanelLeft,
  PanelRight,
  Focus,
  AlertTriangle,
  Check,
  CircleDashed,
  Activity,
} from "lucide-react";
import { useAppStore } from "@/stores/useAppStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useChatStore } from "@/stores/chatStore";
import { useDraftStore } from "@/stores/draftStore";
import { repo, type SaveFailure } from "@/utils/repository";
import {
  pendingPreferenceWrites,
  preferenceFailures,
  subscribePreferences,
} from "@/utils/preferences";
import { Button } from "@/components/ui/button";
import DiagnosticsDialog from "@/components/workspace/DiagnosticsDialog";
import SaveFailuresDialog from "@/components/workspace/SaveFailuresDialog";

/**
 * The workspace status bar: persistence readouts (mono, per the design
 * contract), library counts, and the panel/focus toggles. "Saved" appears
 * only when nothing is scheduled or in flight and no failure is retained.
 */
export default function WorkspaceStatusBar() {
  const navigatorCollapsed = useAppStore((s) => s.navigatorCollapsed);
  const inspectorCollapsed = useAppStore((s) => s.inspectorCollapsed);
  const focusMode = useAppStore((s) => s.focusMode);
  const toggleNavigator = useAppStore((s) => s.toggleNavigator);
  const toggleInspector = useAppStore((s) => s.toggleInspector);
  const toggleFocusMode = useAppStore((s) => s.toggleFocusMode);

  const texts = useLibraryStore((s) => s.texts.length);
  const projects = useProjectStore((s) => s.projects.length);
  const threads = useChatStore((s) => s.threads.length);
  const drafts = useDraftStore((s) => s.drafts);

  const [failures, setFailures] = useState<SaveFailure[]>(() =>
    repo.saveFailures(),
  );
  const [persistence, setPersistence] = useState(() => repo.saveState());
  const [prefFailures, setPrefFailures] = useState(() =>
    preferenceFailures(),
  );
  const [prefPending, setPrefPending] = useState(() =>
    pendingPreferenceWrites(),
  );
  const [failuresOpen, setFailuresOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  useEffect(() => {
    const unsubRepo = repo.subscribeSaveState(() => {
      setFailures(repo.saveFailures());
      setPersistence(repo.saveState());
    });
    const unsubPrefs = subscribePreferences(() => {
      setPrefFailures(preferenceFailures());
      setPrefPending(pendingPreferenceWrites());
    });
    return () => {
      unsubRepo();
      unsubPrefs();
    };
  }, []);

  const unsavedDrafts = Object.values(drafts).filter((d) => !d.savedAt).length;
  const failedCount = failures.length + prefFailures.length;
  const pendingWrites =
    persistence.scheduled + persistence.inFlight + prefPending;
  const persistenceLabel =
    failedCount > 0
      ? `${failedCount} failed save${failedCount === 1 ? "" : "s"} — retry needed`
      : unsavedDrafts > 0
        ? `Unsaved — ${unsavedDrafts} draft${unsavedDrafts === 1 ? "" : "s"}`
        : pendingWrites > 0
          ? `Saving — ${pendingWrites} write${pendingWrites === 1 ? "" : "s"} pending`
          : "Saved";

  return (
    <footer className="flex items-center gap-3 px-3 py-1 border-t border-border bg-background text-[11px] text-text-muted shrink-0 select-none">
      <span className="font-mono" aria-live="polite">
        {persistenceLabel === "Saved" ? (
          <span className="flex items-center gap-1">
            <Check className="size-3" />
            Saved
          </span>
        ) : failedCount > 0 ? (
          <button
            type="button"
            className="flex items-center gap-1 text-warning hover:underline"
            onClick={() => setFailuresOpen(true)}
            aria-label={`${failedCount} failed saves — review`}
          >
            <AlertTriangle className="size-3" />
            {persistenceLabel}
          </button>
        ) : (
          <span className="flex items-center gap-1">
            <CircleDashed className="size-3" />
            {persistenceLabel}
          </span>
        )}
      </span>
      <span className="font-mono">
        {texts} doc{texts === 1 ? "" : "s"} · {projects} project
        {projects === 1 ? "" : "s"} · {threads} conversation
        {threads === 1 ? "" : "s"}
      </span>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDiagnosticsOpen(true)}
        aria-label="Performance diagnostics"
        title="Performance diagnostics"
        className="h-6 px-2 text-[11px] text-text-secondary"
      >
        <Activity className="size-3.5" />
        Diagnostics
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={toggleNavigator}
        aria-pressed={!navigatorCollapsed}
        aria-label="Toggle navigator panel"
        title="Toggle navigator"
        className="h-6 px-2 text-[11px] text-text-secondary"
      >
        <PanelLeft className="size-3.5" />
        Navigator
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={toggleInspector}
        aria-pressed={!inspectorCollapsed}
        aria-label="Toggle inspector panel"
        title="Toggle inspector"
        className="h-6 px-2 text-[11px] text-text-secondary"
      >
        <PanelRight className="size-3.5" />
        Inspector
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={toggleFocusMode}
        aria-pressed={focusMode}
        aria-label="Toggle focus mode"
        title="Focus mode hides the side panels"
        className="h-6 px-2 text-[11px] text-text-secondary"
      >
        <Focus className="size-3.5" />
        Focus
      </Button>
      <SaveFailuresDialog
        open={failuresOpen}
        onOpenChange={setFailuresOpen}
        failures={failures}
        failedPreferences={prefFailures}
      />
      <DiagnosticsDialog
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
      />
    </footer>
  );
}
