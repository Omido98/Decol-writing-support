// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  formatBibliography,
  entryToText,
  parseAuthorName,
  parseAuthors,
  cslItemFromSource,
  CSL_STYLES,
  cslStyleInfo,
  type FormattedEntry,
  type CslStyleId,
} from "@/utils/cslProcessor";
import type { SourceMeta } from "@/types";

function source(id: string, over: Partial<SourceMeta> = {}): SourceMeta {
  return {
    id,
    title: "Untitled",
    originalText: "text",
    contentHash: `hash-${id}`,
    extractionStatus: "ready",
    includedInContext: false,
    verification: "unverified",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const CONGO = source("s1", {
  title: "Une saison au Congo",
  author: "Aimé Césaire",
  year: "1966",
});
const PEAU = source("s2", {
  title: "Peau noire, masques blancs",
  author: "Frantz Fanon",
  year: "1952",
});

function texts(entries: FormattedEntry[]): string[] {
  return entries.map(entryToText);
}

describe("formatBibliography (citeproc-js, 5.4e)", () => {
  it("formats entries with the real APA style: surnames, initials, year, italic title", async () => {
    const entries = await formatBibliography(
      [{ sourceId: "s1" }],
      [CONGO],
      "apa",
    );
    expect(entries).toHaveLength(1);
    const text = entryToText(entries[0]);
    // APA 7: Césaire, A. (1966). Une saison au Congo.
    expect(text).toContain("Césaire, A.");
    expect(text).toContain("(1966)");
    expect(text).toContain("Une saison au Congo");
    // The book title carries real italics (not a hand-rolled guess).
    const italic = entries[0].filter((r) => r.italic).map((r) => r.text).join("");
    expect(italic).toContain("Une saison au Congo");
  });

  it("orders entries by the style's own sort (alphabetical), not citation order", async () => {
    const entries = await formatBibliography(
      [{ sourceId: "s2" }, { sourceId: "s1" }],
      [CONGO, PEAU],
      "apa",
    );
    const list = texts(entries);
    expect(list).toHaveLength(2);
    expect(list[0]).toContain("Césaire");
    expect(list[1]).toContain("Fanon");
  });

  it("produces style-specific output (MLA given names, section titles)", async () => {
    const entries = await formatBibliography([{ sourceId: "s1" }], [CONGO], "mla");
    const text = entryToText(entries[0]);
    // MLA: full given name first: Césaire, Aimé. Une saison au Congo...
    expect(text.startsWith("Césaire, Aimé")).toBe(true);
    expect(cslStyleInfo("mla").sectionTitle).toBe("Works Cited");
    expect(cslStyleInfo("chicago-author-date").sectionTitle).toBe("Bibliography");
    expect(cslStyleInfo("apa").sectionTitle).toBe("References");
  });

  it("skips cited ids without a source record (nothing is invented)", async () => {
    const entries = await formatBibliography(
      [{ sourceId: "ghost" }, { sourceId: "s1" }],
      [CONGO],
      "apa",
    );
    expect(entries).toHaveLength(1);
    expect(entryToText(entries[0])).toContain("Césaire");
  });

  it("scopes a reused engine to each call's ids (updateItems discipline)", async () => {
    const first = await formatBibliography([{ sourceId: "s1" }], [CONGO, PEAU], "apa");
    const second = await formatBibliography([{ sourceId: "s2" }], [CONGO, PEAU], "apa");
    expect(texts(first)[0]).toContain("Césaire");
    expect(texts(second)[0]).toContain("Fanon");
    expect(texts(second)[0]).not.toContain("Césaire");
  });

  it("handles Family, Given names and multi-author strings", async () => {
    const qui = source("s3", {
      title: "Colonialidad y modernidad/racionalidad",
      author: "Quijano, Aníbal; Dussel, Enrique",
      year: "1992",
    });
    const entries = await formatBibliography([{ sourceId: "s3" }], [qui], "apa");
    const text = entryToText(entries[0]);
    expect(text).toContain("Quijano, A.");
    expect(text).toContain("Dussel, E.");
  });

  it("returns nothing without cited sources", async () => {
    expect(await formatBibliography([], [CONGO], "apa")).toEqual([]);
  });

  it("exposes the bundled style picker", () => {
    expect(CSL_STYLES.map((s) => s.id)).toEqual([
      "apa",
      "chicago-author-date",
      "mla",
    ]);
    const known = CSL_STYLES.every((s) => s.label.length > 0 && s.sectionTitle.length > 0);
    expect(known).toBe(true);
    // Unknown ids fall back to APA rather than exploding.
    expect(cslStyleInfo("nonsense" as CslStyleId).id).toBe("apa");
  });
});

describe("name parsing", () => {
  it("parses Family, Given; Given Family; and keeps single tokens whole", () => {
    expect(parseAuthorName("Smith, Linda Tuhiwai")).toEqual({
      family: "Smith",
      given: "Linda Tuhiwai",
    });
    expect(parseAuthorName("Frantz Fanon")).toEqual({
      family: "Fanon",
      given: "Frantz",
    });
    // A spaced display string is inherently ambiguous ("Given Family"
    // wins); organization names stay whole through the brace literal
    // marker, and CSL JSON's structured {name}/{literal} parts.
    expect(parseAuthorName("One-Name Organization")).toEqual({
      family: "Organization",
      given: "One-Name",
    });
    expect(parseAuthorName("{One-Name Organization}")).toEqual({
      literal: "One-Name Organization",
    });
    expect(parseAuthorName("Quijano, Aníbal")).toEqual({
      family: "Quijano",
      given: "Aníbal",
    });
    expect(parseAuthorName("Zapatistas")).toEqual({ family: "Zapatistas" });
  });

  it("splits authors on ; and and, never on name commas", () => {
    expect(parseAuthors("Aimé Césaire; René Depestre")).toHaveLength(2);
    expect(parseAuthors("Aimé Césaire and René Depestre")).toHaveLength(2);
    expect(parseAuthors("Quijano, Aníbal")).toHaveLength(1);
    expect(parseAuthors(undefined)).toEqual([]);
    // A separator INSIDE a literal organization is not a boundary.
    expect(parseAuthors("{Smith; Sons and Co}; Frantz Fanon")).toEqual([
      { literal: "Smith; Sons and Co" },
      { family: "Fanon", given: "Frantz" },
    ]);
  });

  it("builds honest CSL items (absent fields stay absent, type is not invented)", () => {
    const item = cslItemFromSource(
      { title: "T", author: "Quijano, Aníbal", year: "not-a-year", doi: undefined, url: "https://x", language: "es" },
      "id1",
    );
    expect(item.id).toBe("id1");
    expect(item.type).toBe("document");
    expect(item.author).toEqual([{ family: "Quijano", given: "Aníbal" }]);
    expect(item.issued).toBeUndefined();
    expect(item.DOI).toBeUndefined();
    expect(item.URL).toBe("https://x");
    expect(item.language).toBe("es");
  });

  it("carries the retained bibliographic metadata into the CSL item", () => {
    const item = cslItemFromSource(
      {
        title: "Historia y colonialidad",
        author: "{Colectivo Abya Yala}",
        year: "2019",
        sourceType: "article-journal",
        containerTitle: "Tabula Rasa",
        publisher: "Universidad Colegio Mayor",
        volume: "31",
        issue: "2",
        pages: "101-120",
        abstract: "Resumen…",
      },
      "id2",
    );
    expect(item.type).toBe("article-journal");
    expect(item.author).toEqual([{ literal: "Colectivo Abya Yala" }]);
    expect(item["container-title"]).toBe("Tabula Rasa");
    expect(item.publisher).toBe("Universidad Colegio Mayor");
    expect(item.volume).toBe("31");
    expect(item.issue).toBe("2");
    expect(item.page).toBe("101-120");
    expect(item.abstract).toBe("Resumen…");
  });
});
