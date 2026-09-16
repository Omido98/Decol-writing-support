// ============================================================
// Evaluation harness (Phase 5.5c)
// ============================================================
// A small representative-task set that measures what an "optimization"
// would silently degrade: meaning, voice, quotation fidelity, citation
// accuracy, completeness. This is the QUALITY GATE for any model
// substitution or context trimming — an optimization claim without a
// before/after run of this harness is not an optimization.
//
// Scoring is DETERMINISTIC and local (no second model judging another):
// quotations, terminology, citations, and numbers are exact string
// checks; meaning is a documented content-word RETENTION PROXY (an
// imperfect but stable measurement — the same yardstick before/after
// is what makes comparisons honest). The harness sends each task
// through the SAME instruction builder the proposal flow uses.

import { sendMessage, type ApiOutcome } from "@/utils/api";
import type { ApiConfig } from "@/stores/chatStore";
import {
  buildRevisionInstruction,
  REVISION_SYSTEM_PROMPT,
} from "@/services/revisionService";
import type { ProposalKind } from "@/types";

// ─────────────────────────────────────────────
// Task set (representative, fixed)
// ─────────────────────────────────────────────

export interface EvalTask {
  id: string;
  kind: ProposalKind;
  passage: string;
  expect: {
    /** Quoted spans that must appear VERBATIM in the output. */
    quotations?: string[];
    /** Names/terms that must survive (case-insensitive). */
    terminology?: string[];
    /** Author-date citation markers that must survive verbatim. */
    citations?: string[];
    /** Expected length direction of the replacement. */
    direction?: "shrink" | "preserve";
  };
}

export const EVAL_TASKS: EvalTask[] = [
  {
    id: "revise-en-quote",
    kind: "revise",
    passage:
      'The archive, as Achille Mbembe argues, "is not a passive repository of the past" (Mbembe, 2002), but an active site where power decides what counts as memory. Those who curate it shape the boundaries of the sayable.',
    expect: {
      quotations: ["is not a passive repository of the past"],
      citations: ["(Mbembe, 2002)"],
      terminology: ["Mbembe", "archive", "memory"],
      direction: "preserve",
    },
  },
  {
    id: "tighten-en",
    kind: "tighten",
    passage:
      "It is important to note, at the outset, that the question of land back is not merely a question of property transfers; rather, it is, in many respects and in a very real sense, a question of the usufruct rights of communities who have never actually ceased, in any meaningful sense, to exercise their own responsibilities toward the territories in question.",
    expect: {
      terminology: ["land back", "usufruct"],
      direction: "shrink",
    },
  },
  {
    id: "clarify-es",
    kind: "clarify",
    passage:
      "La colonialidad del poder no terminó con las independencias políticas: sigue organizando la producción del conocimiento. Quijano lo señalaba ya en 1992 (Quijano, 1992), aunque sus categorías todavía se traducen con dificultad.",
    expect: {
      citations: ["(Quijano, 1992)"],
      terminology: ["colonialidad del poder", "Quijano", "conocimiento"],
      direction: "preserve",
    },
  },
  {
    id: "revise-ar-names",
    kind: "revise",
    passage:
      'يتحدث إدوارد سعيد عن "الاستشراق" كخطاب للسلطة (Said, 1978). The point survives translation: knowledge of the Orient was produced FOR power, and the archive itself is not neutral. الأرشيف نفسه ليس محايداً.',
    expect: {
      quotations: ["الاستشراق"],
      citations: ["(Said, 1978)"],
      terminology: ["الاستشراق", "الأرشيف نفسه ليس محايداً"],
      direction: "preserve",
    },
  },
  {
    id: "comment-en",
    kind: "comment",
    passage:
      "Decolonizing a curriculum is not the addition of reading lists; it is the redistribution of authority over what counts as knowledge. A syllabus that adds names but keeps the same exam remains colonial in structure.",
    expect: {
      direction: "preserve",
    },
  },
  {
    id: "revise-numbers",
    kind: "revise",
    passage:
      'Between 1492 and 1550, the population of Hispaniola fell by more than 90 percent — what Bartolomé de las Casas witnessed he described as "la destrucción de las Indias" (Las Casas, 1552). Numbers like these are not rhetoric; they are the ledger.',
    expect: {
      quotations: ["la destrucción de las Indias"],
      citations: ["(Las Casas, 1552)"],
      terminology: ["1492", "1550", "90 percent", "Hispaniola", "Las Casas"],
      direction: "preserve",
    },
  },
];

// ─────────────────────────────────────────────
// Dimensions + report
// ─────────────────────────────────────────────

export type EvalDimensionId =
  | "meaning"
  | "voice"
  | "quotation"
  | "citations"
  | "completeness";

export interface EvalDimension {
  /** 0–1. */
  score: number;
  /** What moved the score (empty when perfect). */
  detail: string;
}

export interface EvalTaskResult {
  taskId: string;
  kind: ProposalKind;
  passed: boolean;
  /** Transport completeness of the sample (B16b/B22). Only `complete`
   * samples are scored; stopped/truncated/interrupted/failed responses are
   * reported unscored so a cut-off answer can never be credited as quality. */
  outcome: ApiOutcome;
  dimensions: Record<EvalDimensionId, EvalDimension>;
  output: string;
}

export interface EvalReport {
  /** Stable identity for THIS run; a later run never overwrites it. */
  runId: string;
  ranAt: string;
  model: string;
  results: EvalTaskResult[];
  /** True when the run was aborted; the report is partial and never "done". */
  cancelled: boolean;
  /** Tasks whose sample COMPLETED and was scored (quality samples). */
  scored: number;
  /** Tasks that produced no quality sample (stopped/cut off/failed). */
  unscored: number;
  /** Per-dimension mean across SCORED samples only (0–1). Averaging in
   * non-samples would report a cancelled run as a quality regression. */
  summary: Record<EvalDimensionId, number>;
}

/** What a passing task requires (the gate an optimization must keep). */
const MEANING_GATE = 0.6;

function dim(score: number, detail = ""): EvalDimension {
  return { score: Math.max(0, Math.min(1, score)), detail };
}

// ─────────────────────────────────────────────
// Scorers (pure, deterministic)
// ─────────────────────────────────────────────

/** Significant content words (letters only, length ≥ 4) of a text. */
export function contentWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
  return [...new Set(words)];
}

/**
 * True when the token survives in the output. Alphabetic words may match
 * inside longer words ("archive" in "archives" counts as retained);
 * NUMERIC tokens (years, counts) must match whole — 1492 inside 11492 is
 * a corrupted number, not a preserved one.
 */
function survives(token: string, outputTokens: Set<string>, haystack: string): boolean {
  if (/^\d+$/.test(token)) return outputTokens.has(token);
  return haystack.includes(token);
}

/**
 * MEANING — a documented LEXICAL RETENTION PROXY: the share of the
 * passage's significant content words that survive the replacement. It is
 * stable and cheap, not a semantic judge; the value is that the SAME
 * proxy measures before and after an optimization. The score IS the
 * retained ratio, so `score >= MEANING_GATE` means "at least the gate
 * share of content words survived".
 */
export function scoreMeaning(
  passage: string,
  output: string,
): EvalDimension {
  const words = contentWords(passage);
  if (words.length === 0) return dim(1);
  const haystack = output.toLowerCase();
  const outputTokens = new Set(
    output
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  const lost = words.filter((w) => !survives(w, outputTokens, haystack));
  return dim(
    (words.length - lost.length) / words.length,
    lost.length > 0 ? `content words lost: ${lost.slice(0, 6).join(", ")}` : "",
  );
}

/** VOICE — the task's terminology/names survive (case-insensitive;
 * numeric terms must match whole, like scoreMeaning). */
export function scoreVoice(
  task: EvalTask,
  output: string,
): EvalDimension {
  const terms = task.expect.terminology ?? [];
  if (terms.length === 0) return dim(1);
  const haystack = output.toLowerCase();
  const outputTokens = new Set(
    output
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  const kept = terms.filter((t) =>
    survives(t.toLowerCase(), outputTokens, haystack),
  );
  const lost = terms.filter(
    (t) => !survives(t.toLowerCase(), outputTokens, haystack),
  );
  return dim(
    kept.length / terms.length,
    lost.length > 0 ? `terminology lost: ${lost.join(", ")}` : "",
  );
}

/** QUOTATION FIDELITY — every quoted span appears VERBATIM. A comment
 * need not repeat the quote (not applicable → perfect). */
export function scoreQuotationFidelity(
  task: EvalTask,
  output: string,
): EvalDimension {
  if (task.kind === "comment") return dim(1);
  const quotes = task.expect.quotations ?? [];
  if (quotes.length === 0) return dim(1);
  const missing = quotes.filter((q) => !output.includes(q));
  return dim(
    (quotes.length - missing.length) / quotes.length,
    missing.length > 0
      ? `quotations not verbatim: ${missing.map((q) => `"${q}"`).join(", ")}`
      : "",
  );
}

/**
 * CITATION ACCURACY — the passage's citation markers survive verbatim
 * and NO new author-date marker is invented (the app never invents
 * citation details; neither may a revision).
 */
export function scoreCitations(
  task: EvalTask,
  output: string,
): EvalDimension {
  const citations = task.expect.citations ?? [];
  const replacement = task.kind !== "comment";
  const mustKeep = replacement ? citations : [];
  const kept = mustKeep.filter((c) => output.includes(c));
  // Author-date-shaped markers in the output (year inside parens).
  const invented = [...output.matchAll(/\([^()]*\d{4}[^()]*\)/g)]
    .map((m) => m[0])
    .filter((m) => !citations.includes(m) && !(m === output.trim()));
  let score = 1;
  const details: string[] = [];
  if (mustKeep.length > 0) {
    score *= kept.length / mustKeep.length;
    const missing = mustKeep.filter((c) => !output.includes(c));
    if (missing.length > 0) details.push(`citations lost: ${missing.join(", ")}`);
  }
  if (invented.length > 0) {
    score = Math.max(0, score - invented.length * 0.5);
    details.push(`citations invented: ${invented.join(", ")}`);
  }
  return dim(score, details.join("; "));
}

/** COMPLETENESS — the task was actually done: non-empty, no meta
 * preamble, no instruction echo, a no-op replacement fails, and the
 * expected length direction is honored. */
export function scoreCompleteness(
  task: EvalTask,
  output: string,
): EvalDimension {
  const problems: string[] = [];
  const trimmed = output.trim();
  if (!trimmed) return dim(0, "the request produced nothing");
  if (trimmed === task.passage.trim()) {
    problems.push("the output echoes the passage unchanged (no-op)");
  }
  if (/"""|Passage \(verbatim\)/.test(output)) {
    problems.push("the output echoes the instruction wrapper");
  }
  if (/^(here (is|'s)|sure|i('ve| have) |certainly|the (revised|tightened|clarified) )/i.test(trimmed)) {
    problems.push("the output starts with meta commentary");
  }
  if (task.kind === "comment" && trimmed.length < 80) {
    problems.push("the comment is too thin to be useful");
  }
  if (task.expect.direction === "shrink" && output.length > task.passage.length * 0.95) {
    problems.push("a tighten did not shrink the passage");
  }
  if (task.expect.direction === "preserve" && task.kind !== "comment") {
    if (output.length < task.passage.length * 0.3) {
      problems.push("the replacement lost most of the passage");
    } else if (output.length > task.passage.length * 2.5) {
      problems.push("the replacement ballooned beyond the passage");
    }
  }
  return dim(problems.length > 0 ? 0 : 1, problems.join("; "));
}

/** Score one output against its task (all five dimensions). */
export function scoreTask(task: EvalTask, output: string): EvalTaskResult {
  const dimensions: Record<EvalDimensionId, EvalDimension> = {
    meaning: scoreMeaning(task.passage, output),
    voice: scoreVoice(task, output),
    quotation: scoreQuotationFidelity(task, output),
    citations: scoreCitations(task, output),
    completeness: scoreCompleteness(task, output),
  };
  const passed =
    dimensions.quotation.score === 1 &&
    dimensions.citations.score === 1 &&
    dimensions.voice.score === 1 &&
    dimensions.completeness.score === 1 &&
    dimensions.meaning.score >= MEANING_GATE;
  return { taskId: task.id, kind: task.kind, passed, outcome: "complete", dimensions, output };
}

/**
 * A response that did not COMPLETE (stopped/truncated/interrupted/failed)
 * is not a sample of the model's quality: every dimension reads 0 with the
 * reason, so a cut-off run can never be reported as a completed result.
 * The output is kept for inspection.
 */
export function unscoredTask(
  task: EvalTask,
  output: string,
  outcome: Exclude<ApiOutcome, "complete">,
): EvalTaskResult {
  const detail =
    outcome === "failed"
      ? "not scored: the request failed"
      : outcome === "stopped"
        ? "not scored: the request was stopped"
        : `not scored: the response was ${outcome}`;
  const dimensions: Record<EvalDimensionId, EvalDimension> = {
    meaning: dim(0, detail),
    voice: dim(0, detail),
    quotation: dim(0, detail),
    citations: dim(0, detail),
    completeness: dim(0, detail),
  };
  return { taskId: task.id, kind: task.kind, passed: false, outcome, dimensions, output };
}

function mean(scores: number[]): number {
  // No scored samples means NO quality evidence — never a perfect score.
  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

let runSeq = 0;
function nextRunId(): string {
  runSeq += 1;
  return `eval-${Date.now().toString(36)}-${runSeq.toString(16)}`;
}

// ─────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────

/**
 * Run the full task set against the configured endpoint, using the SAME
 * instruction builder and system prompt as the proposal flow. Progress
 * is reported per task. An aborted `signal` stops scheduling FURTHER
 * tasks (the in-flight request follows the transport's stop semantics)
 * and marks the report `cancelled`: a cancelled run can never be
 * reported as Done, and its summary only covers the samples that
 * actually completed.
 */
export async function runEvaluation(options: {
  config: ApiConfig;
  onProgress?: (done: number, total: number, taskId: string) => void;
  signal?: AbortSignal;
}): Promise<EvalReport> {
  const results: EvalTaskResult[] = [];
  // F11: only an abort that PREVENTED a scheduled task marks the run
  // cancelled. An abort arriving after the final task finished leaves a
  // fully scored, complete report (it must not render "partial").
  let abortedEarly = false;
  for (let i = 0; i < EVAL_TASKS.length; i++) {
    if (options.signal?.aborted) {
      abortedEarly = true;
      break;
    }
    const task = EVAL_TASKS[i];
    options.onProgress?.(i, EVAL_TASKS.length, task.id);
    const result = await sendMessage(
      [
        {
          role: "user",
          content: buildRevisionInstruction(task.kind, task.passage),
          timestamp: new Date().toISOString(),
        },
      ],
      { ...options.config, webSearchEnabled: false },
      REVISION_SYSTEM_PROMPT,
      { signal: options.signal },
    );
    results.push(
      result.outcome === "complete"
        ? scoreTask(task, result.content.trim())
        : unscoredTask(task, result.content.trim(), result.outcome),
    );
  }
  const cancelled = abortedEarly;
  options.onProgress?.(
    cancelled ? results.length : EVAL_TASKS.length,
    EVAL_TASKS.length,
    "",
  );

  // Only COMPLETED responses are quality samples; averaging in unscored
  // zeros would report a cut-off run as a quality regression.
  const scored = results.filter((r) => r.outcome === "complete");
  const dimension = (id: EvalDimensionId) =>
    mean(scored.map((r) => r.dimensions[id].score));
  return {
    runId: nextRunId(),
    ranAt: new Date().toISOString(),
    model: options.config.model,
    results,
    cancelled,
    scored: scored.length,
    unscored: results.length - scored.length,
    summary: {
      meaning: dimension("meaning"),
      voice: dimension("voice"),
      quotation: dimension("quotation"),
      citations: dimension("citations"),
      completeness: dimension("completeness"),
    },
  };
}
