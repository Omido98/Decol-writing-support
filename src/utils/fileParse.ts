// ──────────────────────────────────────────────
// Client-side document text extraction for chat uploads
// ──────────────────────────────────────────────
// Word (.docx), Excel (.xlsx/.xls/.csv), and PDF files carry real text,
// so extraction is lossless — no OCR involved. The binary file itself is
// never persisted; only the extracted text travels with the chat message.
// The parsers are lazy: they only load on the first upload, keeping
// startup light.

/**
 * URL of the pdf.js worker, resolved by Vite as a bundled asset. Imported
 * statically (it is only a URL string); the pdf.js library itself loads
 * lazily on the first PDF upload.
 */
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** Hard cap on extracted text per file, so one upload cannot drown the context. */
export const MAX_EXTRACT_CHARS = 50_000;

/** File kinds the uploader accepts (also drives the input's accept filter). */
const UPLOAD_EXTENSIONS = ["docx", "xlsx", "xls", "csv", "txt", "md", "pdf"] as const;

/** Character range of one kept page inside the extracted content. */
export interface ParsedPageRange {
  /** 1-based page number (a REAL locator, not a display guess). */
  number: number;
  /** Start offset (inclusive) in `content`. */
  start: number;
  /** End offset (exclusive) in `content`. */
  end: number;
}

interface ParsedFile {
  /** Original file name (used as the attachment title). */
  name: string;
  kind: string;
  /** Extracted plain text (markdown-ish tables for spreadsheets). */
  content: string;
  /** Word count of the RETAINED text (what the model will see). */
  wordCount: number;
  /** Word count before truncation, when the document was cut. */
  originalWordCount?: number;
  /** Set when extraction could not read everything (scanned PDF, truncation). */
  warning?: string;
  /** Page ranges for paginated material (PDF): real page locators. */
  pages?: ParsedPageRange[];
}

/** The `accept` attribute value for the file input. */
export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",");

/** True when the file's extension is one we can extract. */
export function isSupportedUpload(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (UPLOAD_EXTENSIONS as readonly string[]).includes(ext);
}

function finish(name: string, kind: string, raw: string): ParsedFile {
  if (raw.length > MAX_EXTRACT_CHARS) {
    const content =
      raw.slice(0, MAX_EXTRACT_CHARS) + "\n\n[Document truncated]";
    return {
      name,
      kind,
      content,
      wordCount: content.split(/\s+/).filter(Boolean).length,
      originalWordCount: raw.split(/\s+/).filter(Boolean).length,
      warning: `Only the first ${MAX_EXTRACT_CHARS.toLocaleString()} characters were kept.`,
    };
  }
  return {
    name,
    kind,
    content: raw,
    wordCount: raw.split(/\s+/).filter(Boolean).length,
  };
}

/**
 * Finish PAGINATED material (PDF): pages are joined with blank lines and
 * capped at the extract limit, and the content ranges of the kept pages
 * are returned as REAL page locators. A cut inside a page keeps the part
 * that fits and reports truncation; pages after the cut are excluded.
 */
export function finishPages(
  name: string,
  kind: string,
  pages: string[],
): ParsedFile {
  let content = "";
  const ranges: ParsedPageRange[] = [];
  let truncated = false;
  const raw = pages.join("\n\n");
  for (let i = 0; i < pages.length; i++) {
    const separator = content.length > 0 ? "\n\n" : "";
    const addition = separator + pages[i];
    if (content.length + addition.length > MAX_EXTRACT_CHARS) {
      const room = MAX_EXTRACT_CHARS - content.length - separator.length;
      if (room > 0) {
        const start = content.length + separator.length;
        content += separator + pages[i].slice(0, room);
        ranges.push({ number: i + 1, start, end: content.length });
      }
      truncated = true;
      break;
    }
    const start = content.length + separator.length;
    content += addition;
    ranges.push({ number: i + 1, start, end: content.length });
  }
  if (truncated) content += "\n\n[Document truncated]";
  const originalWordCount = truncated
    ? raw.split(/\s+/).filter(Boolean).length
    : undefined;
  return {
    name,
    kind,
    content,
    wordCount: content.split(/\s+/).filter(Boolean).length,
    ...(originalWordCount != null ? { originalWordCount } : {}),
    ...(truncated
      ? {
          warning: `Only the first ${MAX_EXTRACT_CHARS.toLocaleString()} characters were kept.`,
        }
      : {}),
    pages: ranges,
  };
}

/** Extract text from a Word (.docx) file. */
async function parseDocx(name: string, buffer: ArrayBuffer): Promise<ParsedFile> {
  const { extractRawText } = await import("mammoth");
  const result = await extractRawText({ arrayBuffer: buffer });
  return finish(name, "docx", result.value);
}

/** Extract text from a PDF, page by page. */
async function parsePdf(name: string, buffer: ArrayBuffer): Promise<ParsedFile> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  // pdf.js transfers the buffer to its worker (detaching it); the caller
  // never reuses it, so a view is enough.
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  const doc = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      pages.push(text);
    }
    const raw = pages.join("\n\n").trim();
    // An empty extraction on a multi-page PDF means a scanned/image-only
    // document — report it explicitly instead of attaching an empty file.
    if (!raw && doc.numPages > 0) {
      return {
        name,
        kind: "pdf",
        content: "",
        wordCount: 0,
        warning:
          "No extractable text found — this PDF looks scanned or image-only (no OCR), so it cannot be attached usefully.",
      };
    }
    // Page boundaries and ranges survive into the content: real locators.
    return finishPages(name, "pdf", pages.map((p) => p.trim()));
  } finally {
    await loadingTask.destroy();
  }
}

/** Extract every sheet of a workbook as a labelled CSV block. */
async function parseSpreadsheet(
  name: string,
  buffer: ArrayBuffer,
): Promise<ParsedFile> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "array" });
  const parts: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    parts.push(`## ${sheetName}`);
    parts.push(XLSX.utils.sheet_to_csv(sheet).trim());
    parts.push("");
  }
  return finish(name, "xlsx", parts.join("\n").trim());
}

/** Extract text from an uploaded file. Throws when the kind is unsupported or parsing fails. */
export async function parseFile(file: File): Promise<ParsedFile> {
  const name = file.name;
  if (!isSupportedUpload(name)) {
    throw new Error(`Unsupported file type: ${name}`);
  }
  const ext = name.split(".").pop()!.toLowerCase();
  const buffer = await file.arrayBuffer();

  if (ext === "docx") return parseDocx(name, buffer);
  if (ext === "xlsx" || ext === "xls") return parseSpreadsheet(name, buffer);
  if (ext === "pdf") return parsePdf(name, buffer);

  // csv / txt / md: plain text
  const kind = ext === "csv" ? "csv" : "text";
  const text = new TextDecoder().decode(buffer);
  return finish(name, kind, text);
}
