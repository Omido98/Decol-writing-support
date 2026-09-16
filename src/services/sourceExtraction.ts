import { parseFile, type ParsedPageRange } from "@/utils/fileParse";
import type { SourcePassage } from "@/types";

// ──────────────────────────────────────────────
// Source extraction (Phase 5.1)
// ──────────────────────────────────────────────
// Background extraction of source text from uploaded files. Tasks are
// cancellable: a cancelled task's result is DISCARDED (never written),
// and the abort signal is checked at the boundaries. Original text is
// preserved verbatim; passages are derived blocks with locators.

/** How many passages a source may carry before truncation is reported. */
const MAX_PASSAGES = 40;
/** Approximate passage length (characters). */
const PASSAGE_CHARS = 2400;

export interface ExtractionOutcome {
  text: string;
  /** SHA-256 of the uploaded FILE's bytes. Durable identity of the upload,
   * separate from the (possibly truncated) extracted text: distinct files
   * with identical truncated prefixes stay distinguishable. */
  fileHash: string;
  /** Passages derived from the text (locators refer to block ranges). */
  passages: SourcePassage[];
  /** True when the material was cut (truncation reported, never silent). */
  truncated: boolean;
  truncationNote?: string;
  originalWordCount?: number;
}

export interface ExtractionHandle {
  promise: Promise<ExtractionOutcome>;
  cancel: () => void;
}

/**
 * Derive passages from extracted text. Paginated material (PDF) keeps its
 * PAGE boundaries: one passage per page with a REAL page locator ("p. 7").
 * Everything else is batched by blank-line blocks with paragraph locators.
 */
export function derivePassages(
  text: string,
  pages?: ParsedPageRange[],
): { passages: SourcePassage[]; truncated: boolean } {
  if (pages && pages.length > 0) {
    const passages: SourcePassage[] = [];
    for (const page of pages) {
      if (passages.length >= MAX_PASSAGES) return { passages, truncated: true };
      const body = text.slice(page.start, page.end).trim();
      if (!body) continue;
      passages.push({
        id: crypto.randomUUID(),
        locator: `p. ${page.number}`,
        content: body,
      });
    }
    return { passages, truncated: false };
  }

  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const passages: SourcePassage[] = [];
  let buffer: string[] = [];
  let bufferChars = 0;
  let startBlock = 1;
  let endBlock = 0;
  const flush = () => {
    if (buffer.length === 0) return;
    endBlock = startBlock + buffer.length - 1;
    passages.push({
      id: crypto.randomUUID(),
      locator:
        buffer.length > 1 ? `¶ ${startBlock}–${endBlock}` : `¶ ${startBlock}`,
      content: buffer.join("\n\n"),
    });
    startBlock = endBlock + 1;
    buffer = [];
    bufferChars = 0;
  };
  for (const block of blocks) {
    if (passages.length >= MAX_PASSAGES) return { passages, truncated: true };
    buffer.push(block);
    bufferChars += block.length;
    if (bufferChars >= PASSAGE_CHARS) flush();
  }
  flush();
  return { passages, truncated: false };
}

/**
 * Extract text from a file in the background. `cancel()` aborts: the
 * promise resolves to a CANCELLED marker the caller must check (or the
 * rejection is swallowed and the job simply ends) — a cancelled task
 * never writes anything.
 *
 * Parses are CACHED by the file bytes' content identity (bounded,
 * recency-evicted): re-uploading the same content skips the re-parse.
 * Only the parsed TEXT is cached — passages are re-derived per use,
 * because their row ids are per-source identity.
 */
const PARSE_CACHE_LIMIT = 10;
const parseCache = new Map<string, Awaited<ReturnType<typeof parseFile>>>();

async function bytesIdentity(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function extractFromFile(file: File): ExtractionHandle {
  const controller = new AbortController();
  const promise = (async (): Promise<ExtractionOutcome> => {
    const bytes = await file.arrayBuffer();
    if (controller.signal.aborted) {
      throw Object.assign(new Error("cancelled"), { cancelled: true });
    }
    const hash = await bytesIdentity(bytes);
    let parsed = parseCache.get(hash);
    if (parsed) {
      // Recency refresh.
      parseCache.delete(hash);
      parseCache.set(hash, parsed);
    } else {
      parsed = await parseFile(file);
      if (controller.signal.aborted) {
        throw Object.assign(new Error("cancelled"), { cancelled: true });
      }
      parseCache.set(hash, parsed);
      while (parseCache.size > PARSE_CACHE_LIMIT) {
        const oldest = parseCache.keys().next().value;
        if (oldest === undefined) break;
        parseCache.delete(oldest);
      }
    }
    const { passages, truncated } = derivePassages(parsed.content, parsed.pages);
    const parserTruncated = parsed.content.includes("[Document truncated]");
    const outcome: ExtractionOutcome = {
      text: parsed.content,
      fileHash: hash,
      passages,
      truncated: truncated || parserTruncated,
      ...(parserTruncated || parsed.warning
        ? { truncationNote: parsed.warning ?? "The document exceeded the parser's size limit; only part was read." }
        : truncated
          ? { truncationNote: `More than ${MAX_PASSAGES} passages; the rest is preserved in the original text.` }
          : {}),
      ...(parsed.originalWordCount != null
        ? { originalWordCount: parsed.originalWordCount }
        : {}),
    };
    return outcome;
  })();
  return {
    promise,
    cancel: () => controller.abort(),
  };
}
