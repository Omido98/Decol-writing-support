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

interface ParsedFile {
  /** Original file name (used as the attachment title). */
  name: string;
  kind: string;
  /** Extracted plain text (markdown-ish tables for spreadsheets). */
  content: string;
  /** Word count of the extracted text (post-truncation). */
  wordCount: number;
}

/** The `accept` attribute value for the file input. */
export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",");

/** True when the file's extension is one we can extract. */
export function isSupportedUpload(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (UPLOAD_EXTENSIONS as readonly string[]).includes(ext);
}

function finish(name: string, kind: string, raw: string): ParsedFile {
  const content =
    raw.length > MAX_EXTRACT_CHARS
      ? raw.slice(0, MAX_EXTRACT_CHARS) + "\n\n[Document truncated]"
      : raw;
  return { name, kind, content, wordCount: raw.split(/\s+/).filter(Boolean).length };
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
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      parts.push(text);
    }
    return finish(name, "pdf", parts.join("\n").trim());
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
