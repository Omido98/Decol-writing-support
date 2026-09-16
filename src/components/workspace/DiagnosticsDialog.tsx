import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { clearMarks, recentMarks, type PerfMark } from "@/utils/perfLog";

/**
 * The performance diagnostics surface (Phase 5.5): the local ring
 * buffer of AI-operation marks, read-only. Nothing leaves the process.
 * Aggregates (mean TTFT / duration) back any future optimization claim.
 */
export default function DiagnosticsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Marks are module state, not reactive: capture on open / on refresh.
  const [marks, setMarks] = useState<PerfMark[]>([]);
  const refresh = () => setMarks(recentMarks());
  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const summary = useMemo(() => {
    const ttft = marks.filter((m) => m.kind === "ttft");
    const duration = marks.filter((m) => m.kind === "duration");
    const cancel = marks.filter((m) => m.kind === "cancel-latency");
    const mean = (list: PerfMark[]) =>
      list.length
        ? Math.round(list.reduce((sum, m) => sum + m.value, 0) / list.length)
        : null;
    return {
      count: marks.length,
      meanTtft: mean(ttft),
      ttftCount: ttft.length,
      meanDuration: mean(duration),
      durationCount: duration.length,
      meanCancel: mean(cancel),
      cancelCount: cancel.length,
    };
  }, [marks]);

  const fmtValue = (mark: PerfMark): string => {
    switch (mark.kind) {
      case "request-size":
        return `${mark.value.toLocaleString()} chars`;
      default:
        return `${mark.value.toLocaleString()} ms`;
    }
  };

  const fmtTime = (at: string): string => {
    const d = new Date(at);
    return Number.isNaN(d.getTime())
      ? at
      : d.toLocaleTimeString(undefined, { hour12: false });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Performance diagnostics</DialogTitle>
          <DialogDescription>
            Recent AI-operation measurements (last 50, local only — nothing
            leaves this device). Measured, not estimated: time to first
            token, total duration, request size, cancellation latency.
          </DialogDescription>
        </DialogHeader>

        <div className="font-mono text-[11px] text-text-secondary flex flex-wrap gap-x-4 gap-y-1 px-1">
          <span>{summary.count} mark{summary.count === 1 ? "" : "s"}</span>
          {summary.meanTtft != null && (
            <span>mean TTFT {summary.meanTtft} ms ({summary.ttftCount})</span>
          )}
          {summary.meanDuration != null && (
            <span>
              mean duration {summary.meanDuration} ms ({summary.durationCount})
            </span>
          )}
          {summary.meanCancel != null && (
            <span>
              mean cancel latency {summary.meanCancel} ms ({summary.cancelCount})
            </span>
          )}
        </div>

        <div className="max-h-[320px] overflow-y-auto border border-border rounded-md">
          {marks.length === 0 ? (
            <p className="px-3 py-4 text-xs text-text-muted">
              No marks yet — they appear as AI operations run.
            </p>
          ) : (
            <table className="w-full text-[11px] font-mono">
              <thead className="text-text-muted border-b border-border">
                <tr>
                  <th className="text-left px-2 py-1 font-medium">time</th>
                  <th className="text-left px-2 py-1 font-medium">kind</th>
                  <th className="text-right px-2 py-1 font-medium">value</th>
                  <th className="text-left px-2 py-1 font-medium">detail</th>
                </tr>
              </thead>
              <tbody>
                {marks.map((mark, i) => (
                  <tr key={`${mark.at}-${i}`} className="border-b border-border/50">
                    <td className="px-2 py-1 whitespace-nowrap">{fmtTime(mark.at)}</td>
                    <td className="px-2 py-1">{mark.kind}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">
                      {fmtValue(mark)}
                    </td>
                    <td className="px-2 py-1 text-text-muted max-w-[220px] truncate">
                      {mark.detail ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={refresh}>
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              clearMarks();
              refresh();
            }}
          >
            Clear
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
