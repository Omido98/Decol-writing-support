import { useRef, useState } from "react";
import { useChatStore } from "@/stores/chatStore";
import { Button } from "@/components/ui/button";
import type {
  EvalDimensionId,
  EvalReport,
} from "@/services/evalHarness";

/**
 * The AI evaluation runner (Phase 5.5c): runs the representative-task
 * set through the CONFIGURED model and reports the five quality
 * dimensions. This is the gate for any model substitution or context
 * trimming — an optimization claim must be backed by a before/after of
 * this report. Real requests are sent (tokens are spent).
 */

const DIMENSION_LABELS: Record<EvalDimensionId, string> = {
  // The meaning score is lexical retention, not a semantic judgment.
  meaning: "Meaning (proxy)",
  voice: "Voice",
  quotation: "Quotations",
  citations: "Citations",
  completeness: "Completeness",
};

const pct = (score: number): string => `${Math.round(score * 100)}%`;

export default function EvalReportView() {
  const config = useChatStore((s) => s.config);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [progress, setProgress] = useState("");
  const [report, setReport] = useState<EvalReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  /** Ownership token: an older run may never overwrite a newer one. */
  const runSeq = useRef(0);

  const hasKey = Boolean(config.apiKey);

  const run = async () => {
    if (!hasKey || status === "running") return;
    setStatus("running");
    setError(null);
    setProgress("Starting…");
    const runId = ++runSeq.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const { runEvaluation } = await import("@/services/evalHarness");
      const result = await runEvaluation({
        config,
        signal: controller.signal,
        onProgress: (done, total, taskId) =>
          setProgress(`Task ${done + (taskId ? 1 : 0)} of ${total}${taskId ? ` — ${taskId}` : ""}`),
      });
      if (runSeq.current !== runId) return; // a newer run owns the view
      setReport(result);
      if (result.cancelled) {
        setStatus("failed");
        setError("Evaluation cancelled — the report below is partial.");
      } else {
        setStatus("done");
      }
    } catch (err) {
      if (runSeq.current !== runId) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus("failed");
    } finally {
      if (runSeq.current === runId) controllerRef.current = null;
    }
  };

  const cancel = () => {
    controllerRef.current?.abort();
    setStatus("failed");
    setError("Evaluation cancelled.");
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={() => void run()}
          disabled={!hasKey || status === "running"}
          className="justify-center flex-1"
        >
          {status === "running" ? "Evaluating…" : "Run AI evaluation"}
        </Button>
        {status === "running" && (
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        )}
      </div>
      <p className="text-xs text-text-muted">
        {hasKey
          ? "Runs a small representative-task set through the configured model and measures lexical meaning retention (a proxy, not a semantic verdict), voice, quotation fidelity, citation accuracy, and completeness. Only completed responses are scored. Real requests are sent. Run this before and after any model change — an optimization without a before/after report is not an optimization."
          : "Configure an API key first — the evaluation sends real requests."}
      </p>

      {status === "running" && (
        <p className="text-xs font-mono text-text-secondary" aria-live="polite">
          {progress}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}

      {report && (
        <div className="space-y-2 pt-1">
          <div className="grid grid-cols-5 gap-1 text-center font-mono text-[11px]">
            {(Object.keys(DIMENSION_LABELS) as EvalDimensionId[]).map((id) => {
              const score = report.summary[id];
              return (
                <div key={id} className="rounded-md border border-border px-1 py-1.5">
                  <div className="text-text-muted">{DIMENSION_LABELS[id]}</div>
                  <div
                    className={
                      score >= 1
                        ? "text-primary"
                        : score >= 0.6
                          ? "text-warning"
                          : "text-destructive"
                    }
                  >
                    {pct(score)}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="font-mono text-[11px] text-text-muted">
            {report.model} · {report.results.filter((r) => r.passed).length}/
            {report.results.length} tasks passed · {report.scored} scored ·{" "}
            {report.unscored} not scored
          </p>
          <ul className="space-y-1 text-xs">
            {report.results
              .filter((r) => !r.passed)
              .map((r) => (
                <li key={r.taskId} className="text-text-secondary">
                  <span className="font-mono">{r.taskId}</span>{" "}
                  {Object.entries(r.dimensions)
                    .filter(([, d]) => d.detail)
                    .map(([, d]) => d.detail)
                    .join(" · ")}
                  {/* A report is evidence: the actual output is reviewable. */}
                  {r.output && (
                    <details className="mt-0.5">
                      <summary className="cursor-pointer text-text-muted">
                        output
                      </summary>
                      <pre className="whitespace-pre-wrap break-words pt-1 text-[11px]">
                        {r.output}
                      </pre>
                    </details>
                  )}
                </li>
              ))}
            {report.results.every((r) => r.passed) && (
              <li className="text-primary">All tasks passed.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
