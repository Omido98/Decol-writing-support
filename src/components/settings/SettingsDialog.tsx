import { useState } from "react";
import { Check, Moon, Plus, Sun, Download, Upload } from "lucide-react";
import { save, open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  useSettingsStore,
  accentWithContrast,
} from "@/stores/settingsStore";
import {
  buildBackupBundle,
  parseBackupBundle,
  restoreBackupBundle,
} from "@/utils/backup";
import { useChatStore, flushChatSave } from "@/stores/chatStore";
import { invalidateAllOperations } from "@/services/aiOperations";
import { useLibraryStore, flushLibrarySave } from "@/stores/libraryStore";
import { useProjectStore, flushProjectSave } from "@/stores/projectStore";
import { useSourceStore } from "@/stores/sourceStore";
import { flushDrafts, resetDraftsForRestore } from "@/stores/draftStore";
import { capturePendingEditorChanges } from "@/components/editor/useDocumentSession";
import { useAppStore } from "@/stores/useAppStore";
import {
  discardPreference,
  flushPreferences,
  preferenceFailures,
} from "@/utils/preferences";
import { repo } from "@/utils/repository";
import { flushComposerAttachments } from "@/stores/chatStore";
import ApiConfigForm from "./ApiConfigForm";
import EvalReportView from "@/components/settings/EvalReportView";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const PRESET_ACCENTS = [
  { name: "Mint", value: "#34d399" },
  { name: "Emerald", value: "#4ade80" },
  { name: "Sky", value: "#93c5fd" },
  { name: "Blue", value: "#60a5fa" },
  { name: "Amber", value: "#fbbf24" },
  { name: "Orange", value: "#fb923c" },
  { name: "Rose", value: "#f87171" },
  { name: "Pink", value: "#f472b6" },
  { name: "Violet", value: "#a78bfa" },
  { name: "Stone", value: "#a8a094" },
  { name: "Deep Teal", value: "#0f6e5c" },
];

type UpdateStatus =
  | "idle"
  | "checking"
  | "none"
  | "available"
  | "downloading"
  | "failed";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsDialog({
  open,
  onOpenChange,
}: SettingsDialogProps) {
  const theme = useSettingsStore((s) => s.theme);
  const accent = useSettingsStore((s) => s.accent);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setAccent = useSettingsStore((s) => s.setAccent);

  const [showPalette, setShowPalette] = useState(false);

  const [backupStatus, setBackupStatus] = useState<string | null>(null);

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  /** The update is installed; only the restart (and its drain) is pending. */
  const [restartPending, setRestartPending] = useState(false);

  // ── Backup ──

  const handleExport = async () => {
    setBackupStatus(null);
    try {
      // buildBackupBundle drains pending saves inside its maintenance
      // barrier, so "Export immediately after Save includes that save".
      const bundle = await buildBackupBundle();
      const filePath = await save({
        defaultPath: `decol-writing-support-backup-${new Date()
          .toISOString()
          .slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      await writeTextFile(filePath, JSON.stringify(bundle, null, 2));
      const dump = (bundle.data ?? bundle.db ?? {}) as Record<string, unknown[]>;
      if (bundle.files) {
        setBackupStatus(
          `Backup exported (${Object.keys(bundle.files).length} files).`,
        );
      } else {
        setBackupStatus(
          `Backup exported (${(dump.texts as unknown[] | undefined)?.length ?? 0} documents, ` +
            `${(dump.projects as unknown[] | undefined)?.length ?? 0} projects, ` +
            `${(dump.threads as unknown[] | undefined)?.length ?? 0} conversations).`,
        );
      }
    } catch (err) {
      setBackupStatus(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleImport = async () => {
    setBackupStatus(null);
    try {
      const filePath = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      const raw = await readTextFile(String(filePath));
      const bundle = parseBackupBundle(raw);
      if (!bundle) {
        setBackupStatus("That file is not a valid Decol Writing Support backup.");
        return;
      }
      const count = Object.keys(bundle.files ?? {}).length;
      const confirmed = await ask(
        `This will overwrite all current conversations and settings with the contents of the backup${count > 0 ? ` (${count} files)` : ""}. This cannot be undone. Continue?`,
        { title: "Import backup", kind: "warning" },
      );
      if (!confirmed) return;
      // Exclusive restore: AI operations are aborted, new persistence is
      // blocked, pending saves are drained, a recovery snapshot of the
      // current data is written, and the restored dataset commits in one
      // transaction — all inside restoreBackupBundle.
      invalidateAllOperations();
      const counts = await restoreBackupBundle(bundle);
      // Reload every store so the restored data shows immediately; the
      // reload paths do NOT flush (pre-restore state must not come back).
      await useChatStore.getState().loadConfig();
      await useChatStore.getState().reloadAfterRestore();
      await useLibraryStore.getState().resetForRestore();
      await useProjectStore.getState().resetForRestore();
      await useSourceStore.getState().resetForRestore();
      await useSettingsStore.getState().loadSettings();
      // Recovery drafts and the shell layout describe the replaced
      // dataset too: reset them, then re-hydrate the restored state.
      resetDraftsForRestore();
      await useAppStore.getState().hydrateShell();
      if (counts.files !== undefined) {
        setBackupStatus(
          `Import complete — ${counts.files} file${counts.files === 1 ? "" : "s"} restored.`,
        );
      } else {
        const sources = counts.sources ?? 0;
        setBackupStatus(
          `Import complete — ${counts.texts} documents, ${counts.projects} projects, ` +
            `${counts.threads} conversations${sources > 0 ? `, ${sources} sources` : ""} restored.`,
        );
      }
    } catch (err) {
      setBackupStatus(
        `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // ── Updates ──

  const handleCheckForUpdates = async () => {
    setUpdateStatus("checking");
    setUpdateMessage(null);
    try {
      const found = await check();
      if (!found) {
        setUpdateStatus("none");
        return;
      }
      setUpdate(found);
      setUpdateStatus("available");
    } catch (err) {
      setUpdateStatus("failed");
      setUpdateMessage(
        err instanceof Error ? err.message : "Could not check for updates.",
      );
    }
  };

  const handleInstallUpdate = async () => {
    if (!update) return;
    setUpdateStatus("downloading");
    setUpdateMessage(null);
    try {
      await update.downloadAndInstall();
      setRestartPending(true);
      await completeRestart();
    } catch (err) {
      setUpdateStatus("failed");
      setUpdateMessage(
        err instanceof Error
          ? err.message
          : "The update failed to install. Try again later.",
      );
    }
  };

  /**
   * Restart, but only after every drain is acknowledged. A failure keeps
   * the app open with the retained work visible (Retry / explicit discard).
   */
  const completeRestart = async () => {
    setUpdateStatus("downloading");
    setUpdateMessage(null);
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
    // Latest editor changes first (the debounce may not have fired).
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
    if (failures.length > 0) {
      setUpdateStatus("failed");
      setRestartPending(true);
      setUpdateMessage(
        `The update is installed, but some work could not be saved; the app was NOT restarted. ${failures.join(" ")}`,
      );
      return;
    }
    await relaunch();
  };

  /** Explicit user decision: throw the retained work away, then restart. */
  const handleDiscardAndRestart = async () => {
    for (const failure of repo.saveFailures()) {
      repo.resolveSaveFailure(failure.key, "discard");
    }
    for (const failure of preferenceFailures()) {
      discardPreference(failure.key);
    }
    await relaunch();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Customize the appearance of the app, configure your AI provider,
            manage your data, and update the app.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* Theme */}
          <div className="space-y-2">
            <Label className="text-text-secondary text-xs">Theme</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={theme === "light" ? "default" : "outline"}
                onClick={() => setTheme("light")}
                className="justify-center"
              >
                <Sun className="size-4 mr-1.5" />
                Light
              </Button>
              <Button
                variant={theme === "dark" ? "default" : "outline"}
                onClick={() => setTheme("dark")}
                className="justify-center"
              >
                <Moon className="size-4 mr-1.5" />
                Dark
              </Button>
            </div>
          </div>

          {/* Accent colour */}
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Label className="text-text-secondary text-xs">
                Accent colour:
              </Label>
              <button
                type="button"
                title="Choose accent colour"
                aria-label="Choose accent colour"
                onClick={() => setShowPalette((v) => !v)}
                className="size-7 rounded-md border border-border shadow-sm transition-transform hover:scale-105"
                style={{ backgroundColor: accent }}
              />
            </div>

            {showPalette && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {PRESET_ACCENTS.map((c) => {
                  const selected = accent.toLowerCase() === c.value;
                  return (
                    <button
                      key={c.value}
                      type="button"
                      title={c.name}
                      aria-label={c.name}
                      onClick={() => setAccent(c.value)}
                      className={cn(
                        "size-7 rounded-md border transition-transform hover:scale-105",
                        selected
                          ? "border-foreground ring-2 ring-primary/50"
                          : "border-border",
                      )}
                      style={{ backgroundColor: c.value }}
                    >
                      {selected && (
                        <Check
                          className="size-3.5 mx-auto"
                          strokeWidth={3}
                          style={{ color: accentWithContrast(c.value).foreground }}
                        />
                      )}
                    </button>
                  );
                })}

                <label
                  title="Custom colour"
                  aria-label="Custom colour"
                  className={cn(
                    "flex items-center justify-center size-7 rounded-md border border-dashed cursor-pointer transition-transform hover:scale-105",
                    PRESET_ACCENTS.every((c) => accent.toLowerCase() !== c.value)
                      ? "border-foreground ring-2 ring-primary/50 bg-field"
                      : "border-border",
                  )}
                >
                  <input
                    type="color"
                    className="sr-only"
                    value={accent}
                    onChange={(e) => setAccent(e.target.value)}
                  />
                  <Plus className="size-3.5 text-text-secondary" />
                </label>
              </div>
            )}
          </div>

          {/* Backup & restore */}
          <div className="space-y-2">
            <Label className="text-text-secondary text-xs">
              Backup &amp; restore
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={() => void handleExport()}
                className="justify-center"
              >
                <Download className="size-4 mr-1.5" />
                Export data
              </Button>
              <Button
                variant="outline"
                onClick={() => void handleImport()}
                className="justify-center"
              >
                <Upload className="size-4 mr-1.5" />
                Import data
              </Button>
            </div>
            {/* Asset decision (B19, option b): backups are text-only. */}
            <p className="text-[11px] text-text-muted leading-snug">
              Backups preserve the extracted text of uploaded sources, not the
              original files. API keys are never included.
            </p>
            {backupStatus && (
              <p className="text-xs text-text-muted">{backupStatus}</p>
            )}
          </div>

          {/* API configuration */}
          <div className="space-y-2">
            <Label className="text-text-secondary text-xs">
              API configuration
            </Label>
            <ApiConfigForm />
          </div>

          {/* AI evaluation (5.5c): the quality gate for model/context changes */}
          <div className="space-y-2">
            <Label className="text-text-secondary text-xs">
              AI evaluation
            </Label>
            <EvalReportView />
          </div>

          {/* Updates */}
          <div className="space-y-2">
            <Label className="text-text-secondary text-xs">
              Software updates
            </Label>
            <Button
              variant="outline"
              onClick={() => void handleCheckForUpdates()}
              disabled={updateStatus === "checking" || updateStatus === "downloading"}
              className="justify-center w-full"
            >
              {updateStatus === "checking"
                ? "Checking…"
                : updateStatus === "available"
                  ? `Update to ${update?.version} available`
                  : "Check for updates"}
            </Button>
            {updateStatus === "available" && (
              <Button
                variant="default"
                onClick={() => void handleInstallUpdate()}
                className="justify-center w-full bg-primary hover:bg-primary/80 text-primary-foreground"
              >
                Download &amp; install
              </Button>
            )}
            {updateStatus === "downloading" && (
              <p className="text-xs text-text-muted">
                Downloading and installing the update… The app will restart
                when done.
              </p>
            )}
            {updateStatus === "none" && (
              <p className="text-xs text-text-muted">
                You are running the latest version.
              </p>
            )}
            {(updateStatus === "failed" || updateStatus === "idle") &&
              updateMessage && (
                <p className="text-xs text-destructive">{updateMessage}</p>
              )}
            {restartPending && updateStatus === "failed" && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => void completeRestart()}
                  className="justify-center"
                >
                  Retry restart
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void handleDiscardAndRestart()}
                  className="justify-center"
                >
                  Discard work and restart
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
