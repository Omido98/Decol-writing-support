// ──────────────────────────────────────────────
// Client-side document text extraction for chat uploads
// ──────────────────────────────────────────────
// Word (.docx) and Excel (.xlsx/.xls/.csv) files carry real text, so
// extraction is lossless — no OCR involved. The binary file itself is
// never persisted; only the extracted text travels with the chat message.
// The parsers are lazy: they only load on the first upload, keeping
// startup light.

/** Hard cap on extracted text per file, so one upload cannot drown the context. */
export const MAX_EXTRACT_CHARS = 50_000;

/** File kinds the uploader accepts (also drives the input's accept filter). */
const UPLOAD_EXTENSIONS = ["docx", "xlsx", "xls", "csv", "txt", "md"] as const;

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

  // csv / txt / md: plain text
  const kind = ext === "csv" ? "csv" : "text";
  const text = new TextDecoder().decode(buffer);
  return finish(name, kind, text);
}
