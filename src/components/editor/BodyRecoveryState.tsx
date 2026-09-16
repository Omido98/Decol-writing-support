import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Copy, RotateCcw, TriangleAlert } from "lucide-react";

// ──────────────────────────────────────────────
// Body recovery state (B10)
// ──────────────────────────────────────────────
// Shown when a stored rich body cannot be opened against the canonical
// editor schema. The raw bytes stay visible and copyable; normal Save is
// blocked upstream so the invalid payload can never be replaced by empty
// content or by a code-block fallback.

export default function BodyRecoveryState({
  error,
  raw,
  onRetry,
}: {
  error: string;
  raw: string;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const handleCopy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(raw);
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      role="alert"
      className="flex-1 min-h-0 overflow-y-auto px-6 py-6"
      data-testid="body-recovery"
    >
      <div className="max-w-[720px] mx-auto flex flex-col gap-3">
        <div className="flex items-start gap-2 text-sm text-text-primary">
          <TriangleAlert className="size-4 shrink-0 mt-0.5 text-warning" />
          <div className="flex-1">
            <p className="font-medium">This document cannot be opened safely.</p>
            <p className="mt-1 text-text-secondary">{error}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleCopy}>
            {copied ? (
              <Check className="size-4 mr-1 text-primary" />
            ) : (
              <Copy className="size-4 mr-1" />
            )}
            Copy original data
          </Button>
          {onRetry && (
            <Button size="sm" variant="ghost" onClick={onRetry}>
              <RotateCcw className="size-4 mr-1" />
              Retry
            </Button>
          )}
        </div>
        <pre
          data-testid="raw-body"
          className="max-h-[55vh] overflow-auto rounded-md border border-border bg-surface-alt p-3 text-xs text-text-secondary whitespace-pre-wrap break-words"
        >
          {raw}
        </pre>
      </div>
    </div>
  );
}
