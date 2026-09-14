import { describe, it, expect } from "vitest";
import {
  isSupportedUpload,
  parseFile,
  MAX_EXTRACT_CHARS,
} from "@/utils/fileParse";

describe("fileParse", () => {
  it("accepts supported extensions and rejects others", () => {
    expect(isSupportedUpload("report.docx")).toBe(true);
    expect(isSupportedUpload("data.XLSX")).toBe(true);
    expect(isSupportedUpload("table.csv")).toBe(true);
    expect(isSupportedUpload("notes.txt")).toBe(true);
    expect(isSupportedUpload("notes.md")).toBe(true);
    expect(isSupportedUpload("scan.pdf")).toBe(true);
    expect(isSupportedUpload("image.png")).toBe(false);
    expect(isSupportedUpload("old.doc")).toBe(false);
  });

  it("extracts plain text files with word counts", async () => {
    const file = new File(["Two words here."], "notes.txt", {
      type: "text/plain",
    });
    const parsed = await parseFile(file);
    expect(parsed.kind).toBe("text");
    expect(parsed.name).toBe("notes.txt");
    expect(parsed.content).toBe("Two words here.");
    expect(parsed.wordCount).toBe(3);
  });

  it("parses csv as text with the csv kind", async () => {
    const file = new File(["a,b\n1,2"], "table.csv", { type: "text/csv" });
    const parsed = await parseFile(file);
    expect(parsed.kind).toBe("csv");
    expect(parsed.content).toBe("a,b\n1,2");
  });

  it("throws for unsupported file types", async () => {
    const file = new File([new Uint8Array([0, 1, 2])], "image.png", {
      type: "image/png",
    });
    await expect(parseFile(file)).rejects.toThrow(/Unsupported/);
  });

  it("truncates oversized extractions with a notice", async () => {
    const long = "word ".repeat(MAX_EXTRACT_CHARS + 100);
    const file = new File([long], "big.txt", { type: "text/plain" });
    const parsed = await parseFile(file);
    expect(parsed.content.endsWith("[Document truncated]")).toBe(true);
    expect(parsed.content.length).toBeLessThan(long.length);
  });

  it("renders each sheet of a workbook as a labelled csv block", async () => {
    // Build a real workbook in memory via the bundled xlsx package.
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]),
      "Sheet1",
    );
    const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = new File([buffer], "data.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const parsed = await parseFile(file);
    expect(parsed.kind).toBe("xlsx");
    expect(parsed.content).toContain("## Sheet1");
    expect(parsed.content).toContain("a,b");
    expect(parsed.content).toContain("1,2");
  });
});
