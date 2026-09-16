// ============================================================
// Performance marks (Phase 5.5)
// ============================================================
// A small in-memory ring buffer of performance marks for AI operations:
// time to first token, total duration, and request size (chars/tokens
// when known). Measurements only — no behavior depends on these values,
// and nothing leaves the process (local-first: no telemetry).

export interface PerfMark {
  kind: "ttft" | "duration" | "request-size" | "cancel-latency";
  /** Milliseconds (durations/latency) or characters (request-size). */
  value: number;
  at: string;
  detail?: string;
}

const RING_SIZE = 50;
const ring: PerfMark[] = [];

export function recordMark(mark: Omit<PerfMark, "at">): void {
  ring.push({ ...mark, at: new Date().toISOString() });
  if (ring.length > RING_SIZE) ring.shift();
}

/** Recent marks, newest first (diagnostics surface only). */
export function recentMarks(): PerfMark[] {
  return [...ring].reverse();
}

export function clearMarks(): void {
  ring.length = 0;
}

/** Time to first token: returns a stop function (idempotent). */
export function measureTtft(detail: string): (chars?: number) => number {
  const start = performance.now();
  let stopped = false;
  return (chars) => {
    if (stopped) return -1;
    stopped = true;
    const ms = performance.now() - start;
    recordMark({ kind: "ttft", value: Math.round(ms), detail, ...(chars != null ? {} : {}) });
    return ms;
  };
}

/** Abandoned stop markers are dropped after this long (F09). */
export const CANCEL_MARK_TTL_MS = 5 * 60_000;

/**
 * Stop requests awaiting their operation's settle, keyed by operation /
 * request id (F09): parallel conversations each keep their own marker, so
 * a second Stop can never overwrite the first one's timestamp.
 */
const cancelRequests = new Map<string, number>();

/** Mark the moment the user asked to stop one operation (Stop/Escape). */
export function markCancelRequested(key: string): void {
  const now = performance.now();
  // Piggyback on the write path: an operation that never settles must not
  // leave an accumulating marker behind.
  for (const [existing, at] of cancelRequests) {
    if (now - at > CANCEL_MARK_TTL_MS) cancelRequests.delete(existing);
  }
  cancelRequests.set(key, now);
}

/**
 * Record the latency between the stop request and the operation settling,
 * for that SAME operation id. Idempotent per key: the marker is consumed
 * by the first record, so a late duplicate or an unrelated abort produces
 * no bogus measurement. An abandoned marker past its TTL records nothing.
 */
export function recordCancelLatency(key: string, detail?: string): void {
  const at = cancelRequests.get(key);
  if (at == null) return;
  cancelRequests.delete(key);
  const now = performance.now();
  if (now - at > CANCEL_MARK_TTL_MS) return;
  recordMark({
    kind: "cancel-latency",
    value: Math.round(now - at),
    ...(detail ? { detail } : {}),
  });
}
