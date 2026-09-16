import { describe, it, expect, vi, beforeEach } from "vitest";

const storage: Record<string, string> = {};

vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => {
    storage[key] = String(value);
  },
  removeItem: (key: string) => {
    delete storage[key];
  },
  clear: () => {
    for (const key of Object.keys(storage)) delete storage[key];
  },
  key: (index: number) => Object.keys(storage)[index] ?? null,
  get length() {
    return Object.keys(storage).length;
  },
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

import { useSourceStore } from "@/stores/sourceStore";
import { fakeRepository, fakeRepoState, resetFakeRepository } from "@/test/fakeRepository";
import { contentIdentity } from "@/types";
import { derivePassages } from "@/services/sourceExtraction";
import { finishPages } from "@/utils/fileParse";

beforeEach(() => {
  const invokeMock = vi.mocked(
    (async () => null) as unknown as { mockReset: () => void },
  );
  void invokeMock;
  resetFakeRepository();
  useSourceStore.setState({ sources: [], sourcesLoaded: false, jobs: {} });
});

describe("sourceStore", () => {
  it("adds a source with a content-identity hash and preserves the original text", async () => {
    const { id, duplicate } = await useSourceStore.getState().addSource({
      title: "Une saison au Congo",
      author: "Aimé Césaire",
      year: "1966",
      language: "French",
      text: "Le texte original — أطروحة.",
    });
    expect(duplicate).toBe(false);

    const entry = fakeRepoState.sources.get(id);
    expect(entry).toBeDefined();
    expect(entry!.meta.originalText).toBe("Le texte original — أطروحة.");
    expect(entry!.meta.contentHash).toBe(
      await contentIdentity("Le texte original — أطروحة."),
    );
    expect(entry!.meta.includedInContext).toBe(true);
    expect(entry!.meta.verification).toBe("unverified");
    expect(entry!.meta.extractionStatus).toBe("ready");
  });

  it("deduplicates by content identity, never by title or file name", async () => {
    await useSourceStore.getState().addSource({
      title: "First title",
      text: "identical bytes",
    });
    const second = await useSourceStore.getState().addSource({
      title: "Different title",
      text: "identical bytes",
    });
    expect(second.duplicate).toBe(true);
    expect(useSourceStore.getState().sources).toHaveLength(1);
    expect(useSourceStore.getState().sources[0].title).toBe("First title");

    // Different content with the same title is NOT a duplicate.
    const third = await useSourceStore.getState().addSource({
      title: "First title",
      text: "different bytes",
    });
    expect(third.duplicate).toBe(false);
    expect(useSourceStore.getState().sources).toHaveLength(2);
  });

  it("extracts uploaded files in the background with locators and asset ref", async () => {
    const file = new File(
      ["First paragraph here.\n\nSecond paragraph follows.\n\nThird one."],
      "interview-notes.txt",
      { type: "text/plain" },
    );
    const jobId = await useSourceStore.getState().addSourceFromFile(file);
    expect(jobId).toBeTruthy();

    await vi.waitFor(
      () => {
        const job = useSourceStore.getState().jobs[jobId];
        expect(job?.status).toBe("done");
      },
      { timeout: 5000 },
    );

    const sources = useSourceStore.getState().sources;
    expect(sources).toHaveLength(1);
    expect(sources[0].assetRef).toBe("interview-notes.txt");
    expect(sources[0].extractionStatus).toBe("ready");
    expect(sources[0].originalText).toContain("Third one.");
    expect(sources[0].contentHash).not.toHaveLength(0);
  });

  it("a cancelled extraction never writes anything", async () => {
    // A large body keeps the parse busy for at least one tick.
    const file = new File(["chunk".repeat(5000)], "big.txt", {
      type: "text/plain",
    });
    const jobId = await useSourceStore.getState().addSourceFromFile(file);
    useSourceStore.getState().cancelExtraction(jobId);

    await vi.waitFor(
      () => {
        expect(useSourceStore.getState().jobs[jobId]?.status).toBe("cancelled");
      },
      { timeout: 5000 },
    );
    // The discarded result never became a source.
    expect(useSourceStore.getState().sources).toHaveLength(0);
    expect(fakeRepoState.sources.size).toBe(0);
  });

  it("toggles context inclusion and updates verification without losing data", async () => {
    const { id } = await useSourceStore.getState().addSource({
      title: "Source",
      text: "body",
    });
    await useSourceStore.getState().setIncluded(id, false);
    await useSourceStore.getState().setVerification(id, "quote_matched");

    const meta = useSourceStore.getState().sources.find((s) => s.id === id)!;
    expect(meta.includedInContext).toBe(false);
    expect(meta.verification).toBe("quote_matched");
    expect(meta.originalText).toBe("body");
    // Persisted in the fake repository.
    expect(fakeRepoState.sources.get(id)!.meta.verification).toBe("quote_matched");
  });

  it("metadata/inclusion/verification edits keep the source's passages intact (B13)", async () => {
    const { id } = await useSourceStore.getState().addSource({
      title: "Two-passage source",
      text: "first block\n\nsecond block",
      passages: [
        { id: "p1", locator: "¶ 1", content: "first block" },
        { id: "p2", locator: "¶ 2", content: "second block" },
      ],
    });
    await useSourceStore.getState().setIncluded(id, false);
    await useSourceStore.getState().setVerification(id, "quote_matched");
    await useSourceStore.getState().updateSource(id, { notes: "checked" });

    // Reload from the repository: ids, locators, and content survive.
    const data = await fakeRepository.sourceGet(id);
    expect(data!.passages.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(data!.passages.map((p) => p.locator)).toEqual(["¶ 1", "¶ 2"]);
    expect(data!.passages[0].content).toBe("first block");
    expect(data!.source.includedInContext).toBe(false);
    expect(data!.source.verification).toBe("quote_matched");
    expect(data!.source.notes).toBe("checked");
  });

  it("an explicit empty passage list intentionally clears them (B13)", async () => {
    const { id } = await useSourceStore.getState().addSource({
      title: "S",
      text: "body",
      passages: [{ id: "p1", locator: "¶ 1", content: "block" }],
    });
    await fakeRepository.sourceSave(id, fakeRepoState.sources.get(id)!.meta, []);
    expect((await fakeRepository.sourceGet(id))!.passages).toEqual([]);
  });

  it("failed metadata saves surface instead of acknowledging success (B13)", async () => {
    const { id } = await useSourceStore.getState().addSource({
      title: "S",
      text: "body",
    });
    fakeRepoState.nextError = new Error("disk gone");
    await expect(
      useSourceStore.getState().setIncluded(id, false),
    ).rejects.toThrow(/disk gone/);
    // The in-memory source was not acknowledged as saved.
    expect(
      useSourceStore.getState().sources.find((s) => s.id === id)!.includedInContext,
    ).toBe(true);
  });

  it("an empty extraction is a failed job, not an empty ready source (B13)", async () => {
    const file = new File([""], "empty.txt", { type: "text/plain" });
    const jobId = await useSourceStore.getState().addSourceFromFile(file);
    await vi.waitFor(
      () => expect(useSourceStore.getState().jobs[jobId]?.status).toBe("failed"),
      { timeout: 5000 },
    );
    expect(useSourceStore.getState().sources).toHaveLength(0);
    expect(fakeRepoState.sources.size).toBe(0);
  });

  it("distinct files with equal truncated prefixes remain distinguishable (B13)", async () => {
    // > MAX_EXTRACT_CHARS identical prefix: both extractions truncate to
    // the SAME text. Only the file bytes tell them apart.
    const prefix = "word ".repeat(12_000);
    const fileA = new File([prefix + "AAAA"], "a.txt", { type: "text/plain" });
    const fileB = new File([prefix + "BBBB"], "b.txt", { type: "text/plain" });
    const jobA = await useSourceStore.getState().addSourceFromFile(fileA);
    await vi.waitFor(
      () => expect(useSourceStore.getState().jobs[jobA]?.status).toBe("done"),
      { timeout: 5000 },
    );
    const jobB = await useSourceStore.getState().addSourceFromFile(fileB);
    await vi.waitFor(
      () => expect(useSourceStore.getState().jobs[jobB]?.status).toBe("done"),
      { timeout: 5000 },
    );

    const sources = useSourceStore.getState().sources;
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map((s) => s.contentHash)).size).toBe(2);
  });

  it("a restore during extraction discards the old job and its source (B13)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bytes = new TextEncoder().encode("late body\n\nmore").buffer;
    const file = {
      name: "late.txt",
      arrayBuffer: () => gate.then(() => bytes),
    } as unknown as File;

    const jobId = await useSourceStore.getState().addSourceFromFile(file);
    expect(useSourceStore.getState().jobs[jobId]?.status).toBe("extracting");

    // The dataset is replaced while the extraction is still running.
    await useSourceStore.getState().resetForRestore();
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Nothing from the old dataset reappears — not even the job row.
    expect(useSourceStore.getState().jobs[jobId]).toBeUndefined();
    expect(useSourceStore.getState().sources).toHaveLength(0);
    expect(fakeRepoState.sources.size).toBe(0);
  });

  it("cancelling before parsing discards the result (cancel during hashing) (B13)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bytes = new TextEncoder().encode("body").buffer;
    const file = {
      name: "cancel-me.txt",
      arrayBuffer: () => gate.then(() => bytes),
    } as unknown as File;

    const jobId = await useSourceStore.getState().addSourceFromFile(file);
    useSourceStore.getState().cancelExtraction(jobId);
    release();
    await vi.waitFor(
      () =>
        expect(useSourceStore.getState().jobs[jobId]?.status).toBe("cancelled"),
      { timeout: 5000 },
    );
    expect(useSourceStore.getState().sources).toHaveLength(0);
    expect(fakeRepoState.sources.size).toBe(0);
  });

  it("deleting a source removes it from the repository", async () => {
    const { id } = await useSourceStore.getState().addSource({
      title: "Source",
      text: "body",
    });
    await useSourceStore.getState().deleteSource(id);
    expect(useSourceStore.getState().sources).toHaveLength(0);
    expect(fakeRepoState.sources.has(id)).toBe(false);
  });
});

// ── B18: bibliographic identity and retained metadata ──

describe("bibliographic identity and metadata (B18)", () => {
  it("deduplicates by normalized DOI identity, not the reference line", async () => {
    const first = await useSourceStore.getState().addSource({
      title: "Territorio y conocimiento",
      doi: "https://doi.org/10.1000/ABC",
      text: "Colectivo Abya Yala (2019) Territorio y conocimiento",
    });
    expect(first.duplicate).toBe(false);
    expect(fakeRepoState.sources.get(first.id)!.meta.contentHash).toBe(
      "doi:10.1000/abc",
    );

    // The same work through a different formatted reference line (and a
    // different resolver prefix/case) is the same source.
    const second = await useSourceStore.getState().addSource({
      title: "Territorio y conocimiento",
      doi: "doi: 10.1000/abc",
      text: "A DIFFERENT formatted reference line",
    });
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(useSourceStore.getState().sources).toHaveLength(1);
  });

  it("fills ABSENT metadata on a duplicate without overwriting existing values", async () => {
    const first = await useSourceStore.getState().addSource({
      title: "Décoloniser la méthode",
      doi: "10.1000/xyz",
      author: "Tuhiwai Smith, Linda",
      text: "reference line",
    });
    // The second import carries metadata the first record does not have.
    const second = await useSourceStore.getState().addSource({
      title: "Décoloniser la méthode",
      doi: "10.1000/xyz",
      author: "IGNORED, overwrite attempt",
      sourceType: "book",
      publisher: "Zed Books",
      abstract: "Abstract.",
      text: "another reference line",
    });
    expect(second.duplicate).toBe(true);
    expect(second.merged).toBe(true);
    const stored = useSourceStore.getState().sources.find((s) => s.id === first.id)!;
    // Existing author wins; absent type/publisher/abstract are filled.
    expect(stored.author).toBe("Tuhiwai Smith, Linda");
    expect(stored.sourceType).toBe("book");
    expect(stored.publisher).toBe("Zed Books");
    expect(stored.abstract).toBe("Abstract.");
    expect(fakeRepoState.sources.get(first.id)!.meta.publisher).toBe("Zed Books");
  });

  it("retains the full bibliography metadata through add and edit", async () => {
    const { id } = await useSourceStore.getState().addSource({
      title: "Historia y colonialidad",
      author: "{Colectivo Abya Yala}; Quijano, Aníbal",
      year: "2019",
      doi: "10.1/x",
      sourceType: "article-journal",
      containerTitle: "Tabula Rasa",
      publisher: "Universidad Colegio Mayor",
      volume: "31",
      issue: "2",
      pages: "101-120",
      abstract: "Un resumen largo.",
      notes: "nota",
      translation: "María Pérez",
      text: "reference line",
    });
    const stored = useSourceStore.getState().sources.find((s) => s.id === id)!;
    expect(stored.sourceType).toBe("article-journal");
    expect(stored.containerTitle).toBe("Tabula Rasa");
    expect(stored.publisher).toBe("Universidad Colegio Mayor");
    expect(stored.volume).toBe("31");
    expect(stored.issue).toBe("2");
    expect(stored.pages).toBe("101-120");
    expect(stored.abstract).toBe("Un resumen largo.");
    expect(stored.author).toBe("{Colectivo Abya Yala}; Quijano, Aníbal");
    expect(fakeRepoState.sources.get(id)!.meta.abstract).toBe("Un resumen largo.");

    await useSourceStore
      .getState()
      .updateSource(id, { abstract: "Corregido.", pages: "121-140" });
    const updated = useSourceStore.getState().sources.find((s) => s.id === id)!;
    expect(updated.abstract).toBe("Corregido.");
    expect(updated.pages).toBe("121-140");
    // The edit persisted before acknowledging.
    expect(fakeRepoState.sources.get(id)!.meta.abstract).toBe("Corregido.");
  });
});

// ── B13: real page boundaries and locators for paginated sources ──

describe("paginated extraction (B13)", () => {
  it("keeps real page boundaries and page locators", () => {
    const parsed = finishPages("book.pdf", "pdf", [
      "Page one text.",
      "Page two text.",
      "Page three.",
    ]);
    expect(parsed.pages?.map((p) => p.number)).toEqual([1, 2, 3]);
    const { passages } = derivePassages(parsed.content, parsed.pages);
    expect(passages.map((p) => p.locator)).toEqual(["p. 1", "p. 2", "p. 3"]);
    expect(passages.map((p) => p.content)).toEqual([
      "Page one text.",
      "Page two text.",
      "Page three.",
    ]);
  });

  it("truncation keeps only the kept pages' ranges (the marker is not a passage)", () => {
    const big = "x".repeat(30_000);
    const parsed = finishPages("big.pdf", "pdf", [big, big]);
    expect(parsed.content).toContain("[Document truncated]");
    expect(parsed.pages!.length).toBe(2);
    const { passages } = derivePassages(parsed.content, parsed.pages);
    expect(passages[0].locator).toBe("p. 1");
    expect(passages[1].locator).toBe("p. 2");
    expect(passages[1].content).not.toContain("[Document truncated]");
  });
});
