import { AlertTriangle, Check, CircleAlert, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SessionSaveState } from "@/components/editor/useDocumentSession";

// ──────────────────────────────────────────────
// DocumentStatus (Phase 4.2)
// ──────────────────────────────────────────────
// The persistence readout: Saving / Saved / Unsaved / Failed. "Saved"
// means ACKNOWLEDGED (the repository commit completed) — never a guess.

export default function DocumentStatus({
  state,
}: {
  state: SessionSaveState;
}) {
  switch (state) {
    case "saving":
      return (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 text-xs text-text-secondary select-none"
        >
          <Loader2 className="size-3.5 animate-spin" />
          Saving…
        </span>
      );
    case "failed":
      return (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 text-xs text-warning select-none"
        >
          <AlertTriangle className="size-3.5" />
          Not saved
        </span>
      );
    case "unsaved":
      return (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 text-xs text-text-secondary select-none"
        >
          <CircleAlert className="size-3.5" />
          Unsaved
        </span>
      );
    case "saved":
    default:
      return (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 text-xs text-text-secondary select-none"
        >
          <Check className="size-3.5 text-primary" />
          Saved
        </span>
      );
  }
}

/** The failed-save banner: content retained, explicit retry/discard. */
export function SaveFailedBanner({
  message,
  onRetry,
  onDiscard,
}: {
  message: string;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 px-4 py-2 border-b border-border bg-surface-alt text-xs text-text-secondary shrink-0"
    >
      <AlertTriangle className="size-4 shrink-0 text-warning" />
      <span className="flex-1">
        {message} Your work is kept in the editor; retry or discard
        explicitly.
      </span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
      <Button size="sm" variant="ghost" onClick={onDiscard}>
        Discard draft
      </Button>
    </div>
  );
}
