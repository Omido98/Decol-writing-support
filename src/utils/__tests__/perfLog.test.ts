import { describe, it, expect, vi } from "vitest";
import {
  recordMark,
  recentMarks,
  clearMarks,
  measureTtft,
  markCancelRequested,
  recordCancelLatency,
  CANCEL_MARK_TTL_MS,
} from "@/utils/perfLog";

describe("perfLog (5.5)", () => {
  it("records marks newest-first", () => {
    clearMarks();
    recordMark({ kind: "ttft", value: 120 });
    recordMark({ kind: "duration", value: 900, detail: "completed" });
    const marks = recentMarks();
    expect(marks[0].kind).toBe("duration");
    expect(marks[1].kind).toBe("ttft");
    expect(marks[0].at).toBeTruthy();
  });

  it("the ring buffer stays bounded", () => {
    clearMarks();
    for (let i = 0; i < 60; i++) recordMark({ kind: "request-size", value: i });
    expect(recentMarks().length).toBe(50);
    // Newest survived; oldest evicted.
    expect(recentMarks()[0].value).toBe(59);
  });

  it("TTFT measures once", () => {
    clearMarks();
    const stop = measureTtft("op-1");
    const first = stop(10);
    expect(first).toBeGreaterThanOrEqual(0);
    const second = stop();
    expect(second).toBe(-1); // idempotent
    expect(recentMarks().some((m) => m.kind === "ttft" && m.detail === "op-1")).toBe(true);
  });

  it("cancel latency is attributed per operation (F09)", () => {
    clearMarks();
    // Without a marked stop request nothing is recorded — for ANY key.
    recordCancelLatency("op-1", "send th-1");
    expect(recentMarks()).toHaveLength(0);

    // Two operations stopped in sequence (parallel conversations) each
    // record their OWN latency: the second Stop must not overwrite the
    // first marker.
    markCancelRequested("op-1");
    markCancelRequested("op-2");
    recordCancelLatency("op-2", "send th-2");
    recordCancelLatency("op-1", "send th-1");
    const marks = recentMarks();
    expect(marks).toHaveLength(2);
    expect(marks.map((m) => m.detail).sort()).toEqual([
      "send th-1",
      "send th-2",
    ]);

    // Each stop request produces exactly one measurement (idempotent).
    recordCancelLatency("op-1", "send th-1");
    recordCancelLatency("op-2", "send th-2");
    expect(recentMarks()).toHaveLength(2);
  });

  it("a stop that never settles leaves no stale marker (F09)", () => {
    clearMarks();
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      markCancelRequested("never-settles");
      // A record for a DIFFERENT operation is a no-op: an abandoned marker
      // is never misattributed.
      recordCancelLatency("other", "send other");
      expect(recentMarks()).toHaveLength(0);

      // Markers expire: after the TTL an abandoned one can no longer
      // produce a measurement, and a new stop prunes it from the map.
      vi.advanceTimersByTime(CANCEL_MARK_TTL_MS + 1_000);
      markCancelRequested("fresh");
      recordCancelLatency("fresh", "send fresh");
      recordCancelLatency("never-settles", "send never");
      const latencies = recentMarks().filter(
        (m) => m.kind === "cancel-latency",
      );
      expect(latencies).toHaveLength(1);
      expect(latencies[0].detail).toBe("send fresh");
    } finally {
      vi.useRealTimers();
    }
  });
});
