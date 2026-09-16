import { describe, it, expect, vi, beforeEach } from "vitest";

// parseFile is replaced: the cache is what's under test (parse count).
const parseFileMock = vi.fn();
vi.mock("@/utils/fileParse", () => ({
  parseFile: (...args: unknown[]) => parseFileMock(...args),
}));

import { extractFromFile } from "@/services/sourceExtraction";

beforeEach(() => {
  parseFileMock.mockReset();
  parseFileMock.mockImplementation(async (file: File) => ({
    name: file.name,
    kind: "text",
    content: `parsed:${file.name}`,
    wordCount: 1,
  }));
});

describe("source extraction parse cache (5.5b)", () => {
  it("parses identical content once and re-derives passages with fresh ids", async () => {
    const a = new File(["same bytes"], "a.txt");
    const b = new File(["same bytes"], "b.txt");

    const first = await extractFromFile(a).promise;
    const second = await extractFromFile(b).promise;

    expect(parseFileMock).toHaveBeenCalledTimes(1);
    expect(first.text).toBe("parsed:a.txt");
    expect(second.text).toBe("parsed:a.txt");

    // Same material, but each source's passages keep their OWN row ids.
    expect(first.passages.length).toBeGreaterThan(0);
    expect(second.passages.map((p) => p.id)).not.toEqual(
      first.passages.map((p) => p.id),
    );
    // Locators/contents are the derived identity of the same bytes.
    expect(second.passages.map((p) => p.locator)).toEqual(
      first.passages.map((p) => p.locator),
    );
    expect(second.passages.map((p) => p.content)).toEqual(
      first.passages.map((p) => p.content),
    );
  });

  it("parses again for different content and evicts the oldest entries", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const file = new File([`content ${i}`], `f${i}.txt`);
      const outcome = await extractFromFile(file).promise;
      seen.add(outcome.text);
    }
    expect(parseFileMock).toHaveBeenCalledTimes(12);
    expect(seen.size).toBe(12);

    // The FIRST upload is long-evicted; the LAST is still cached.
    parseFileMock.mockClear();
    await extractFromFile(new File(["content 0"], "again.txt")).promise;
    expect(parseFileMock).toHaveBeenCalledTimes(1);
    parseFileMock.mockClear();
    await extractFromFile(new File(["content 11"], "again2.txt")).promise;
    expect(parseFileMock).not.toHaveBeenCalled();
  });
});
