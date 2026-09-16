import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/utils/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/api")>();
  return { ...actual, sendMessage: vi.fn() };
});

import { sendMessage } from "@/utils/api";
import {
  EVAL_TASKS,
  runEvaluation,
  scoreMeaning,
  scoreTask,
  scoreVoice,
  type EvalTask,
} from "@/services/evalHarness";
import type { ApiConfig } from "@/stores/chatStore";

const sendMessageMock = sendMessage as Mock;

const config = { apiKey: "test-key", model: "test-model" } as ApiConfig;

beforeEach(() => {
  sendMessageMock.mockReset();
});

describe("evaluation scoring gates (B22)", () => {
  it("does not read 1492 as retained inside 11492 (numeric tokens are whole)", () => {
    const passage = "The archive records 1492 and the ledger.";
    expect(
      scoreMeaning(passage, "The archive records 1492 and the ledger.").score,
    ).toBe(1);
    const corrupted = scoreMeaning(
      passage,
      "The archive records 11492 and the ledger.",
    );
    expect(corrupted.score).toBeLessThan(1);
    expect(corrupted.detail).toContain("1492");
  });

  it("the meaning score IS the retention ratio; the gate is the pass bar", () => {
    const passage =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const half = scoreMeaning(passage, "alpha bravo charlie delta echo");
    expect(half.score).toBeCloseTo(0.5);
    const task: EvalTask = { id: "t", kind: "revise", passage, expect: {} };
    // 50% retention must NOT pass the 0.6 gate (the old curve scored it 0.67).
    expect(scoreTask(task, "alpha bravo charlie delta echo").passed).toBe(false);
    const keeper = scoreMeaning(
      passage,
      "alpha bravo charlie delta echo foxtrot golf",
    );
    expect(keeper.score).toBeCloseTo(0.7);
    expect(
      scoreTask(task, "alpha bravo charlie delta echo foxtrot golf").passed,
    ).toBe(true);
  });

  it("voice terminology matches numeric tokens whole too", () => {
    const task: EvalTask = {
      id: "t",
      kind: "revise",
      passage: "In 1492 the archive changed.",
      expect: { terminology: ["1492"] },
    };
    expect(scoreVoice(task, "In 11492 the archive changed.").score).toBe(0);
    expect(scoreVoice(task, "In 1492 the archive changed.").score).toBe(1);
  });
});

describe("evaluation runs (B22)", () => {
  it("does not score stopped samples and excludes them from the summary", async () => {
    let calls = 0;
    sendMessageMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? { content: "Mbembe archive memory", outcome: "complete" }
        : { content: "cut off", outcome: "stopped" };
    });

    const report = await runEvaluation({ config });

    expect(report.results).toHaveLength(EVAL_TASKS.length);
    expect(report.scored).toBe(1);
    expect(report.unscored).toBe(EVAL_TASKS.length - 1);
    // The one scored sample's voice score — NOT dragged down by zeros from
    // responses that were never quality samples.
    expect(report.summary.voice).toBe(
      report.results[0].dimensions.voice.score,
    );
  });

  it("stops scheduling tasks after cancellation and marks the report", async () => {
    const controller = new AbortController();
    let calls = 0;
    sendMessageMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) controller.abort();
      return { content: "partial", outcome: "stopped" };
    });

    const report = await runEvaluation({ config, signal: controller.signal });

    // No third request: aborted runs stop scheduling.
    expect(calls).toBe(2);
    expect(report.results).toHaveLength(2);
    expect(report.cancelled).toBe(true);
  });

  it("aborting after the final task still reports a complete run (F11)", async () => {
    const controller = new AbortController();
    let calls = 0;
    sendMessageMock.mockImplementation(async () => {
      calls += 1;
      if (calls === EVAL_TASKS.length) controller.abort();
      return { content: "rewritten passage", outcome: "complete" };
    });

    const report = await runEvaluation({ config, signal: controller.signal });

    // Every task ran and was scored; the abort arrived after the work was
    // done, so the report is complete — never "partial".
    expect(calls).toBe(EVAL_TASKS.length);
    expect(report.results).toHaveLength(EVAL_TASKS.length);
    expect(report.cancelled).toBe(false);
    expect(report.scored).toBe(EVAL_TASKS.length);
  });

  it("a run that scored nothing reports zeros, never 100%", async () => {
    sendMessageMock.mockResolvedValue({ content: "cut off", outcome: "failed" });
    const report = await runEvaluation({ config });
    expect(report.scored).toBe(0);
    expect(report.summary.meaning).toBe(0);
    expect(report.summary.completeness).toBe(0);
  });

  it("every run carries a distinct run id", async () => {
    sendMessageMock.mockResolvedValue({ content: "x", outcome: "stopped" });
    const first = await runEvaluation({ config });
    const second = await runEvaluation({ config });
    expect(first.runId).toBeTruthy();
    expect(second.runId).not.toBe(first.runId);
  });
});
