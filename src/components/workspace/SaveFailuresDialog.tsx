import { useState } from "react";
import { repo, type SaveFailure } from "@/utils/repository";
import {
  discardPreference,
  flushPreferences,
} from "@/utils/preferences";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Retained save failures — including conversations that are not currently
 * open. Each entry offers the three real outcomes:
 * - Retry: re-attempt the retained revision (same revision expectation);
 * - Overwrite: resolve a STALE conflict by rebasing the retained payload
 *   onto the current revision (an explicit user choice);
 * - Discard: throw the retained payload away (also explicit).
 * Retained PREFERENCE writes (drafts, settings, attachments) are listed
 * too, with Retry (drain) and Discard.
 */
export default function SaveFailuresDialog({
  open,
  onOpenChange,
  failures,
  failedPreferences = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  failures: SaveFailure[];
  failedPreferences?: { key: string; message: string }[];
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusyKey(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Unsaved changes that failed to persist</DialogTitle>
          <DialogDescription>
            Each entry below keeps the exact payload that failed. Retry when
            the problem is fixed; overwrite to resolve a conflict against a
            newer stored revision; discard to throw the payload away.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="space-y-3">
          {failures.length === 0 && failedPreferences.length === 0 && (
            <p className="text-xs text-text-muted">
              Nothing is retained — every write is acknowledged.
            </p>
          )}
          {failures.map((failure) => (
            <div
              key={failure.key}
              className="rounded-md border border-border bg-surface-alt px-3 py-2 space-y-1.5"
            >
              <p className="text-xs text-text-primary">
                <span className="font-mono">{failure.key}</span>
                {failure.kind === "stale" ? " — conflict" : ""}
              </p>
              <p className="text-[11px] text-text-secondary break-words">
                {failure.message}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyKey === failure.key}
                  onClick={() =>
                    void run(failure.key, () => repo.retrySave(failure.key))
                  }
                >
                  Retry
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyKey === failure.key}
                  title="Write the retained payload over the newer stored revision"
                  onClick={() =>
                    void run(failure.key, () =>
                      repo.resolveSaveFailure(failure.key, "overwrite"),
                    )
                  }
                >
                  Overwrite
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyKey === failure.key}
                  onClick={() =>
                    void run(failure.key, () =>
                      repo.resolveSaveFailure(failure.key, "discard"),
                    )
                  }
                >
                  Discard
                </Button>
              </div>
            </div>
          ))}
          {failedPreferences.map((failure) => (
            <div
              key={`pref:${failure.key}`}
              className="rounded-md border border-border bg-surface-alt px-3 py-2 space-y-1.5"
            >
              <p className="text-xs text-text-primary">
                <span className="font-mono">preference:{failure.key}</span>
              </p>
              <p className="text-[11px] text-text-secondary break-words">
                {failure.message}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyKey === `pref:${failure.key}`}
                  onClick={() =>
                    void run(`pref:${failure.key}`, () => flushPreferences())
                  }
                >
                  Retry
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyKey === `pref:${failure.key}`}
                  onClick={() => discardPreference(failure.key)}
                >
                  Discard
                </Button>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
