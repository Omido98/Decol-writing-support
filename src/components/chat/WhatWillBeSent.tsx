import { compileContext, type CompileOptions } from "@/services/contextCompiler";

// ──────────────────────────────────────────────
// WhatWillBeSent (Phase 5.2)
// ──────────────────────────────────────────────
// The pre-send manifest panel. It RENDERS the compiler's output — the
// same compileContext call the send itself makes — never an approximate
// reconstruction.

export { compileContext, type CompileOptions };

export default function WhatWillBeSent({
  compiled,
}: {
  compiled: ReturnType<typeof compileContext>;
}) {
  return (
    <div className="text-xs space-y-1.5" data-testid="what-will-be-sent">
      <p className="font-medium text-text-primary">
        What will be sent — about {compiled.tokenEstimate.toLocaleString()} tokens
        {compiled.model ? ` · model: ${compiled.model}` : ""}
      </p>
      <ul className="space-y-1">
        {compiled.manifest.map((entry, i) => (
          <li
            key={`${entry.kind}-${entry.id ?? i}`}
            className={`flex items-start gap-2 ${entry.included ? "" : "opacity-60"}`}
          >
            <span
              className={`mt-1 size-1.5 rounded-full shrink-0 ${
                entry.included ? "bg-primary" : "bg-border"
              }`}
              aria-hidden
            />
            <span className="min-w-0">
              <span className="text-text-secondary">{entry.title}</span>
              <span className="text-text-muted">
                {entry.included
                  ? ` — ${entry.includedChars.toLocaleString()} chars ≈ ${entry.tokenEstimate.toLocaleString()} tokens`
                  : " — omitted"}
              </span>
              {entry.omittedReason && (
                <span className="block text-text-muted">{entry.omittedReason}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-text-muted">
        The conversation so far and your instruction are always sent;
        sources follow your inclusion choices in the Sources panel, unless
        a per-conversation pick overrides them (until you reset it).
      </p>
    </div>
  );
}
