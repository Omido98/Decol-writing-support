import { estimateTokens } from "@/utils/tokens";
import type { SourceMeta } from "@/types";

// ──────────────────────────────────────────────
// Context compiler (Phase 5.2)
// ──────────────────────────────────────────────
// ONE compiler builds the provider payload AND the manifest the UI
// shows. There is no second, approximate preview: every chat surface
// calls this function with the same inputs the send will use, and the
// "What will be sent?" panel renders the returned manifest verbatim.

export interface ContextHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ContextSourceInput {
  /** Source record id. */
  id: string;
  title: string;
  /** The plain-text material that would actually be sent. */
  content: string;
  /** User-controlled inclusion (SourcesPanel checkbox). */
  included: boolean;
  /** Character range included (locators for the manifest). */
  range?: { from: number; to: number };
  /** Overrides the default omission wording (per-send picking). */
  omittedReason?: string;
}

export interface ManifestEntry {
  /** What the entry is in the payload. */
  kind:
    | "system"
    | "brief"
    | "manuscript"
    | "history"
    | "instruction"
    | "source";
  /** Display label. */
  title: string;
  /** Stable id when the entry corresponds to a record (source id). */
  id?: string;
  /** Whether the material is part of the payload. */
  included: boolean;
  /** Character counts of the full vs included material. */
  fullChars: number;
  includedChars: number;
  /** Token estimate of the INCLUDED material. */
  tokenEstimate: number;
  /** Why material was omitted or cut (truncation is never silent). */
  omittedReason?: string;
}

export interface CompiledContext {
  /** The ACTUAL provider payload (system first, then history). */
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  /** The manifest rendered verbatim by "What will be sent?". */
  manifest: ManifestEntry[];
  /** Total token estimate across included entries. */
  tokenEstimate: number;
  /** The requested output budget (tokens), when known. */
  outputBudget?: number;
  /** Model identity the request targets. */
  model?: string;
}

export interface CompileOptions {
  /** The realized system prompt (already contains brief/references/attachments). */
  systemPrompt: string;
  /** Prior conversation (oldest first). */
  history: ContextHistoryMessage[];
  /** The message being sent now. */
  instruction: string;
  /** Explicitly selected sources (inclusion per user control). */
  sources?: ContextSourceInput[];
  /** Current manuscript, when a document is the working context. */
  manuscript?: { title: string; plainText: string };
  /** Attachment counts carried in the system prompt (disclosure). */
  attachments?: { textCount: number; fileCount: number };
  /** Model the request targets (manifest only). */
  model?: string;
  /** Requested output budget in tokens (manifest only). */
  outputBudget?: number;
}

/**
 * Compile the context for one AI operation. Sources are appended to the
 * system prompt under a clear heading when their user-controlled
 * inclusion flag is set; excluded sources appear in the manifest as
 * omitted (never silently dropped). Manuscript context is truncated to a
 * bounded prefix when large, with the cut reported in the manifest.
 */
export function compileContext(options: CompileOptions): CompiledContext {
  const {
    systemPrompt,
    history,
    instruction,
    sources,
    manuscript,
    attachments,
    model,
    outputBudget,
  } = options;
  const manifest: ManifestEntry[] = [];

  const entry = (
    e: Omit<ManifestEntry, "tokenEstimate" | "includedChars"> & {
      includedText: string;
    },
  ): ManifestEntry => {
    const { includedText, ...rest } = e;
    const entry: ManifestEntry = {
      ...rest,
      includedChars: rest.included ? includedText.length : 0,
      tokenEstimate: rest.included ? estimateTokens(includedText) : 0,
    };
    manifest.push(entry);
    return entry;
  };

  entry({
    kind: "system",
    title: "Writing-partner instructions (including brief and references)",
    included: true,
    fullChars: systemPrompt.length,
    includedText: systemPrompt,
  });

  // Attachments disclosed in the system prompt (counts, not content).
  if (attachments && (attachments.textCount > 0 || attachments.fileCount > 0)) {
    entry({
      kind: "system",
      title: `Attachments in the system prompt (${attachments.textCount} library ${
        attachments.textCount === 1 ? "text" : "texts"
      }, ${attachments.fileCount} uploaded ${
        attachments.fileCount === 1 ? "file" : "files"
      })`,
      included: true,
      fullChars: 0,
      includedText: "",
    });
  }

  // Sources: explicit selection, honoring the user's inclusion flag.
  const includedSourceParts: string[] = [];
  for (const source of sources ?? []) {
    const range = source.range ?? { from: 0, to: source.content.length };
    const material = source.content.slice(range.from, range.to);
    const fullChars = source.content.length;
    if (!source.included) {
      entry({
        kind: "source",
        title: source.title,
        id: source.id,
        included: false,
        fullChars,
        omittedReason: source.omittedReason ?? "Excluded from context (your choice in Sources).",
        includedText: "",
      });
      continue;
    }
    includedSourceParts.push(`### ${source.title}\n\n${material}`);
    entry({
      kind: "source",
      title: source.title,
      id: source.id,
      included: true,
      fullChars,
      includedText: material,
      ...(range.from > 0 || range.to < source.content.length
        ? { omittedReason: "Only the selected range is sent." }
        : {}),
    });
  }

  // Manuscript: bounded prefix, cut reported.
  const MANUSCRIPT_MAX_CHARS = 12_000;
  let manuscriptIncluded = "";
  if (manuscript) {
    const cut = manuscript.plainText.length > MANUSCRIPT_MAX_CHARS;
    manuscriptIncluded = manuscript.plainText.slice(0, MANUSCRIPT_MAX_CHARS);
    entry({
      kind: "manuscript",
      title: manuscript.title,
      included: true,
      fullChars: manuscript.plainText.length,
      includedText: manuscriptIncluded,
      ...(cut
        ? {
            omittedReason: `Only the first ${MANUSCRIPT_MAX_CHARS.toLocaleString()} characters of the manuscript are sent; the rest stays on disk.`,
          }
        : {}),
    });
  }

  // History: every prior message is part of the conversation boundary.
  for (const message of history) {
    entry({
      kind: "history",
      title: message.role === "user" ? "Your earlier message" : "Earlier assistant reply",
      included: true,
      fullChars: message.content.length,
      includedText: message.content,
    });
  }

  entry({
    kind: "instruction",
    title: "Your instruction now",
    included: true,
    fullChars: instruction.length,
    includedText: instruction,
  });

  // Assemble the actual payload: system (+ included sources) → history →
  // instruction.
  let systemContent = systemPrompt;
  if (includedSourceParts.length > 0) {
    systemContent += `\n\n## Sources the writer selected for this request\n\n${includedSourceParts.join("\n\n")}`;
  }
  if (manuscript) {
    systemContent += `\n\n## The document being worked on: ${manuscript.title}\n\n${manuscriptIncluded}`;
  }

  const messages: CompiledContext["messages"] = [
    { role: "system", content: systemContent },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: instruction },
  ];

  const tokenEstimate = manifest.reduce((sum, m) => sum + m.tokenEstimate, 0);
  return {
    messages,
    manifest,
    tokenEstimate,
    ...(outputBudget !== undefined ? { outputBudget } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/** Source inputs for a send: included sources of the project (or all). */
export function sourcesForContext(
  sources: SourceMeta[],
  passages?: { id: string; content: string }[],
): ContextSourceInput[] {
  return sources.map((s) => ({
    id: s.id,
    title: s.title,
    content: s.originalText,
    included: s.includedInContext,
    ...(passages ? {} : {}),
  }));
}

/**
 * Per-send source picking (D4): when the user picked specific sources
 * for a thread, the pick REPLACES the inclusion decision until reset —
 * picked sources ride (the more recent explicit act, visibly), unpicked
 * ones are omitted with an exact reason. `undefined` means "no pick"
 * (follow the Sources panel inclusion flags); an EMPTY array is an
 * explicit "send no sources" and omits every source. Shared by the send
 * path and the preview so the manifest can never disagree with the
 * request.
 */
export function applySourcePicks(
  scoped: ContextSourceInput[],
  pickedIds?: string[],
): ContextSourceInput[] {
  if (pickedIds === undefined) return scoped;
  const picked = new Set(pickedIds);
  return scoped.map((s) =>
    picked.has(s.id)
      ? { ...s, included: true, omittedReason: undefined }
      : { ...s, included: false, omittedReason: "Not picked for this send." },
  );
}
