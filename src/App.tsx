import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";
import { useSettingsStore, accentWithContrast } from "@/stores/settingsStore";
import {
  bootstrapStorage,
  resolveConflict,
  type BootstrapResult,
} from "@/utils/bootstrap";
import {
  flushChatSave,
  flushComposerAttachments,
  hydrateComposerAttachments,
  useChatStore,
} from "@/stores/chatStore";
import { flushLibrarySave, useLibraryStore } from "@/stores/libraryStore";
import { flushProjectSave, useProjectStore } from "@/stores/projectStore";
import { flushDrafts, useDraftStore } from "@/stores/draftStore";
import { capturePendingEditorChanges } from "@/components/editor/useDocumentSession";
import { useAppStore } from "@/stores/useAppStore";
import {
  discardPreference,
  flushPreferences,
  preferenceFailures,
} from "@/utils/preferences";
import { repo } from "@/utils/repository";
import WorkspaceShell from "@/components/workspace/WorkspaceShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function flushPendingSaves() {
  // The latest editor document must reach the draft store BEFORE drafts
  // are flushed: the debounced projection may not have fired yet.
  capturePendingEditorChanges();
  void flushChatSave();
  void flushLibrarySave();
  void flushProjectSave();
}

/** Run every drain, collecting instead of swallowing failures. */
async function drainForExit(): Promise<string[]> {
  const failures: string[] = [];
  const domain = await Promise.allSettled([
    flushChatSave(),
    flushLibrarySave(),
    flushProjectSave(),
  ]);
  for (const result of domain) {
    if (result.status === "rejected") {
      failures.push(
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      );
    }
  }
  // The editor may hold changes newer than the debounced projection.
  capturePendingEditorChanges();
  try {
    await flushDrafts();
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }
  try {
    await flushComposerAttachments();
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }
  try {
    await flushPreferences();
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }
  return failures;
}

/** Explicitly throw every retained payload away, then let the exit run. */
function discardRetainedWork(): void {
  for (const failure of repo.saveFailures()) {
    void repo.resolveSaveFailure(failure.key, "discard");
  }
  for (const failure of preferenceFailures()) {
    discardPreference(failure.key);
  }
}

function App() {
  const theme = useSettingsStore((s) => s.theme);
  const accent = useSettingsStore((s) => s.accent);

  // Storage bootstrap: adopt legacy data and open the SQLite database
  // before any store loads. Failure is fatal to data access, so it is
  // surfaced instead of silently half-working. A completed migration can
  // still carry a recovery report (malformed/orphan material, conflicts).
  const [startupDone, setStartupDone] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapResult | null>(null);
  const [reportDismissed, setReportDismissed] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  /** Exit is blocked while work cannot be saved; the user decides. */
  const [exitFailures, setExitFailures] = useState<string[] | null>(null);
  const exitCtxRef = useRef<{
    retry: () => Promise<void>;
    forceDiscard: () => Promise<void>;
  }>({ retry: async () => {}, forceDiscard: async () => {} });

  const cancelledRef = useRef(false);

  /**
   * The startup sequence, in dependency order:
   * 1. storage bootstrap (legacy adoption + SQLite open);
   * 2. settings, recovery drafts, composer attachments;
   * 3. inventories (documents, projects, conversations);
   * 4. shell state LAST, so a restored conversation selection loads its
   *    owner through the single navigation action.
   * The workspace renders only after the whole sequence succeeded: empty
   * arrays must never be read as "no documents" while a load is pending,
   * and an inventory failure shows a Retry instead of a blank library.
   */
  const runStartup = () => {
    setStartupError(null);
    setStartupDone(false);
    void (async () => {
      try {
        const result = await bootstrapStorage();
        if (cancelledRef.current) return;
        setBootstrap(result);
        if (result.migration && !result.migration.completed) {
          // An incomplete legacy migration must never open an apparently
          // empty writable workspace: the startup screen lists the issues
          // and Retry re-attempts the migration after the input is fixed.
          const details = result.migration.issues
            .map((issue) => `${issue.path} (${issue.kind}): ${issue.detail}`)
            .join("; ");
          throw new Error(
            "The legacy data migration could not be completed, so the workspace was NOT opened. " +
              "The original files are untouched. " +
              details,
          );
        }
        await useSettingsStore.getState().loadSettings();
        await useDraftStore.getState().hydrate();
        await hydrateComposerAttachments();
        await useLibraryStore.getState().loadTexts();
        await useProjectStore.getState().loadProjects();
        await useChatStore.getState().loadThreadInventory();
        await useAppStore.getState().hydrateShell();
        if (cancelledRef.current) return;
        setStartupDone(true);
      } catch (err) {
        if (cancelledRef.current) return;
        setStartupError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  useEffect(() => {
    cancelledRef.current = false;
    runStartup();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flush debounced saves when the window closes, so the last edit is never lost
  useEffect(() => {
    window.addEventListener("beforeunload", flushPendingSaves);

    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const win = getCurrentWindow();
        const destroy = async () => {
          try {
            await win.destroy();
          } catch {
            // destroy can fail (e.g. denied permission); never strand the user
            await exit(0);
          }
        };
        const attemptExit = async () => {
          const failures = await drainForExit();
          if (failures.length === 0) {
            await destroy();
            return;
          }
          // Keep the app open: the retained work must not be lost silently.
          setExitFailures(failures);
        };
        exitCtxRef.current = {
          retry: attemptExit,
          forceDiscard: async () => {
            // Explicit user decision: throw the unsaved work away, exit.
            discardRetainedWork();
            setExitFailures(null);
            await destroy();
          },
        };
        unlisten = await win.onCloseRequested(async (event) => {
          event.preventDefault();
          await attemptExit();
        });
      } catch {
        // Not running inside Tauri (e.g. browser dev) — beforeunload covers it.
      }
    })();

    return () => {
      window.removeEventListener("beforeunload", flushPendingSaves);
      unlisten?.();
    };
  }, []);

  // Apply theme
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }, [theme]);

  // Apply accent colour (+ readable foreground)
  useEffect(() => {
    const root = document.documentElement;
    // The pair must MEET the contrast target: when the raw custom accent
    // cannot (mid-tone accents), the accent itself is adjusted so
    // text-on-accent stays readable everywhere it is used as a background.
    const { accent: safeAccent, foreground: fg } = accentWithContrast(accent);
    root.style.setProperty("--primary", safeAccent);
    root.style.setProperty("--primary-foreground", fg);
    root.style.setProperty("--ring", accent);
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-foreground", fg);
    root.style.setProperty("--chart-1", safeAccent);
    root.style.setProperty("--sidebar-primary", safeAccent);
    root.style.setProperty("--sidebar-primary-foreground", fg);
    root.style.setProperty("--sidebar-ring", safeAccent);
  }, [accent]);

  // Keep the app blank until the startup sequence finishes, so the theme
  // is applied before any content paints (prevents a light/dark flash on
  // cold start) and stores never race the database bootstrap.
  if (!startupDone && !startupError) {
    return <div className="h-screen w-screen bg-background" />;
  }

  if (startupError) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3 px-8 text-center">
        <p className="text-text-primary text-sm font-medium">
          The app could not finish starting up.
        </p>
        <p className="text-text-muted text-sm max-w-[60ch]">{startupError}</p>
        <p className="text-text-muted text-xs max-w-[60ch]">
          Your stored data was not modified: nothing was imported, replaced,
          or deleted. Fix the problem above (for example, check that the app
          data directory is writable), then retry.
        </p>
        <Button
          size="sm"
          className="bg-primary hover:bg-primary/80 text-primary-foreground"
          onClick={() => runStartup()}
        >
          Retry startup
        </Button>
      </div>
    );
  }

  // Recovery report: the migration completed but found material that needs
  // a human decision (malformed files, orphans, conflicting copies).
  const bootstrapIssues = bootstrap?.issues ?? [];
  const conflicts = bootstrapIssues.filter((i) => i.kind === "conflict");
  const otherIssues = [
    ...(bootstrap?.migration?.issues ?? []),
    ...bootstrapIssues.filter((i) => i.kind !== "conflict"),
  ];
  const reportIssues = [...conflicts, ...otherIssues];
  const showReport = reportIssues.length > 0 && !reportDismissed;

  /** Resolve one conflicting copy (D5): the user picks the winner
   * explicitly — both sides are destructive to the loser, so each choice
   * is confirmed. */
  const handleResolveConflict = async (
    path: string,
    winner: "native" | "browser",
  ) => {
    const label =
      winner === "browser"
        ? `Use the BROWSER copy for ${path}? Its records will be MERGED into the current data (the chosen copy wins for the records it contains); nothing is overwritten wholesale.`
        : `Keep the NATIVE file for ${path}? The browser copy will be deleted permanently.`;
    try {
      const confirmed = await ask(label, {
        title: "Resolve conflicting copies",
        kind: "warning",
      });
      if (!confirmed) return;
      const ok = await resolveConflict(path, winner);
      if (!ok) return;
      setConflictError(null);
      setBootstrap((b) =>
        b
          ? {
              ...b,
              issues: b.issues.filter(
                (i) => !(i.kind === "conflict" && i.path === path),
              ),
            }
          : b,
      );
    } catch (err) {
      setConflictError(
        `Resolving the conflict failed (nothing was changed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-background overflow-hidden">
      {/* Recovery report banner (legacy migration findings) */}
      {showReport && (
        <div
          role="alert"
          className="px-6 py-2 border-b border-border bg-surface-alt text-xs text-text-secondary flex items-start gap-3"
        >
          <div className="flex-1 min-w-0">
            <p className="font-medium text-text-primary">
              Recovery report — {reportIssues.length} item
              {reportIssues.length === 1 ? "" : "s"} from your old data files
              need{reportIssues.length === 1 ? "s" : ""} attention
            </p>
            {conflictError && (
              <p className="mt-1 text-destructive">{conflictError}</p>
            )}
            {/* Conflicting copies: the user picks the winner explicitly. */}
            {conflicts.map((issue) => (
              <div
                key={`conflict-${issue.path}`}
                className="mt-1 rounded-md border border-border bg-field px-2 py-1.5"
              >
                <p className="truncate">
                  <span className="font-mono">{issue.path}</span> (conflict):{" "}
                  {issue.detail}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleResolveConflict(issue.path, "browser")}
                  >
                    Use the browser copy
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleResolveConflict(issue.path, "native")}
                  >
                    Keep the native file
                  </Button>
                </div>
              </div>
            ))}
            <ul className="mt-1 list-disc list-inside space-y-0.5">
              {otherIssues.slice(0, 5).map((issue, i) => (
                <li key={`${issue.path}-${i}`} className="truncate">
                  <span className="font-mono">{issue.path}</span> ({issue.kind}):{" "}
                  {issue.detail}
                </li>
              ))}
              {otherIssues.length > 5 && (
                <li>… and {otherIssues.length - 5} more</li>
              )}
            </ul>
            <p className="mt-1 text-text-muted">
              Original files were kept in place; nothing was deleted without
              your explicit choice.
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 text-text-muted hover:text-text-primary"
            onClick={() => setReportDismissed(true)}
            aria-label="Dismiss recovery report"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* The document-centred workspace */}
      <WorkspaceShell />

      {/* Exit blocked: unsaved work must not be lost silently. */}
      <Dialog
        open={exitFailures !== null}
        onOpenChange={(open) => {
          if (!open) setExitFailures(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Some work could not be saved</DialogTitle>
            <DialogDescription>
              The app stays open so nothing is lost. Fix the problem and
              retry, or discard the listed work explicitly to exit.
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc list-inside text-xs text-text-secondary space-y-1 max-h-[30vh] overflow-y-auto">
            {exitFailures?.map((message, index) => (
              <li key={`${index}-${message}`}>{message}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExitFailures(null)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => void exitCtxRef.current.retry()}
            >
              Retry exit
            </Button>
            <Button
              variant="destructive"
              onClick={() => void exitCtxRef.current.forceDiscard()}
            >
              Discard work and exit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default App;
