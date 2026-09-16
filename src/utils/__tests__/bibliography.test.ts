import { describe, it, expect } from "vitest";
import {
  parseBibTeX,
  serializeBibTeX,
  parseRIS,
  serializeRIS,
  parseCslJson,
  serializeCslJson,
} from "@/utils/bibliography";
import { normalizeDoi } from "@/types";

describe("parseBibTeX", () => {
  it("parses entries with braced, quoted, and bare values", () => {
    const bib = `
@book{cesaire1966,
  author = {Aim\\&{e} Césaire and René Depestre},
  title = {Une saison au Congo},
  year = 1966,
  publisher = "Seuil",
  doi = {10.1000/xyz-1}
}`;
    const entries = parseBibTeX(bib);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.title).toBe("Une saison au Congo");
    expect(e.author).toContain("Césaire");
    expect(e.year).toBe("1966");
    expect(e.doi).toBe("10.1000/xyz-1");
    expect(e.text).toContain("Une saison au Congo");
  });

  it("keeps unicode and nested braces, and skips comments/preambles", () => {
    const bib = `
@comment{this is not an entry}
@preamble{"nothing"}
@article{fanon1952,
  title = {Peau noire, masques blancs {Éditions} du Seuil},
  author = {Frantz Fanon},
  year = {1952}
}`;
    const entries = parseBibTeX(bib);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toContain("Peau noire, masques blancs Éditions du Seuil");
    expect(entries[0].author).toBe("Frantz Fanon");
  });
});

describe("parseRIS", () => {
  it("parses multiple records with authors and unicode", () => {
    const ris = [
      "TY  - JOUR",
      "TI  - Décoloniser la méthode",
      "AU  - Smith, Linda Tuhiwai",
      "PY  - 1999",
      "DO  - 10.2307/j.ctt1xxx",
      "ER  - ",
      "TY  - BOOK",
      "T1  - أطروحة عن الاستعمار",
      "A1  - Author One",
      "A1  - Author Two",
      "Y1  - 2012/01/01",
      "LA  - ar",
      "ER  - ",
    ].join("\n");
    const entries = parseRIS(ris);
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe("Décoloniser la méthode");
    expect(entries[0].year).toBe("1999");
    expect(entries[1].title).toBe("أطروحة عن الاستعمار");
    // Multi-author strings join with "; " (unambiguous for CSL name parts).
    expect(entries[1].author).toBe("Author One; Author Two");
    expect(entries[1].language).toBe("ar");
  });
});

describe("serialization round-trips", () => {
  const sources = [
    {
      title: "Une saison au Congo",
      author: "Aimé Césaire",
      year: "1966",
      doi: "10.1000/a",
      language: "French",
      notes: "theatre",
    },
    {
      title: "Peau noire, masques blancs",
      author: "Frantz Fanon",
      year: "1952",
    },
  ];

  it("BibTeX: serialize → parse preserves the fields", () => {
    const parsed = parseBibTeX(serializeBibTeX(sources));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe("Une saison au Congo");
    // BibTeX authors are written family-first ("Césaire, Aimé" — the
    // canonical BibTeX form), so the parsed parts stay exact.
    expect(parsed[0].author).toBe("Césaire, Aimé");
    expect(parsed[0].year).toBe("1966");
    expect(parsed[0].doi).toBe("10.1000/a");
    expect(parsed[1].title).toBe("Peau noire, masques blancs");
  });

  it("RIS: serialize → parse preserves the fields and authors", () => {
    const parsed = parseRIS(serializeRIS(sources));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe("Une saison au Congo");
    // RIS is written family-first ("Césaire, Aimé"), so the display string
    // keeps the structured parts exactly; a two-word family name (e.g.
    // "Tuhiwai Smith, Linda") can no longer be mangled.
    expect(parsed[0].author).toBe("Césaire, Aimé");
    expect(parsed[0].year).toBe("1966");
    expect(parsed[1].author).toBe("Fanon, Frantz");
  });
});

describe("CSL JSON (Zotero interop, 5.4d)", () => {
  it("parses Zotero's CSL JSON export (name parts, date-parts, unicode)", () => {
    const csl = JSON.stringify([
      {
        type: "book",
        title: "Décoloniser la méthode",
        author: [{ family: "Tuhiwai Smith", given: "Linda" }],
        issued: { "date-parts": [[1999]] },
        DOI: "10.2307/x",
        language: "fr",
      },
      {
        type: "article",
        title: "أطروحة",
        author: [{ name: "One-Name Organization" }],
        issued: { "date-parts": [[2012, 3]] },
      },
    ]);
    const entries = parseCslJson(csl);
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe("Décoloniser la méthode");
    // Structured CSL names keep their exact parts: "Tuhiwai Smith" is the
    // family, "Linda" the given — not "Smith, Linda Tuhiwai".
    expect(entries[0].author).toBe("Tuhiwai Smith, Linda");
    expect(entries[0].year).toBe("1999");
    expect(entries[0].doi).toBe("10.2307/x");
    // A literal organization survives as a marked literal, not as a
    // guessed Given Family pair.
    expect(entries[1].author).toBe("{One-Name Organization}");
    expect(entries[1].year).toBe("2012");
  });

  it("returns nothing for non-CSL JSON", () => {
    expect(parseCslJson('{"not":"an array"}')).toEqual([]);
    expect(parseCslJson("not json at all")).toEqual([]);
  });

  it("serialize → parse preserves the fields", () => {
    const parsed = parseCslJson(
      serializeCslJson([
        { title: "Une saison au Congo", author: "Aimé Césaire", year: "1966", doi: "10.1000/a" },
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe("Une saison au Congo");
    expect(parsed[0].author).toContain("Aimé");
    expect(parsed[0].author).toContain("Césaire");
    expect(parsed[0].year).toBe("1966");
    expect(parsed[0].doi).toBe("10.1000/a");
  });

  it("serialization splits authors on ; and and with honest name parts", () => {
    const items = JSON.parse(
      serializeCslJson([
        { title: "T", author: "Quijano, Aníbal; Aimé Césaire" },
      ]),
    );
    expect(items[0].author).toEqual([
      { family: "Quijano", given: "Aníbal" },
      { family: "Césaire", given: "Aimé" },
    ]);
  });
});

describe("bibliographic identity and metadata (B18)", () => {
  it("keeps multi-author boundaries unambiguous in BibTeX", () => {
    const bib = `@article{q,
  author = {Quijano, Aníbal and Tuhiwai Smith, Linda and {Colectivo Abya Yala}},
  title = {Colonialidad},
  year = {1992}
}`;
    const [entry] = parseBibTeX(bib);
    // Every author boundary is "; ", so "Quijano, Aníbal" can never be
    // read as one name with the following author as its given name.
    expect(entry.author).toBe(
      "Quijano, Aníbal; Tuhiwai Smith, Linda; {Colectivo Abya Yala}",
    );
    // Round-trip through the serializer keeps every structured part.
    const [again] = parseBibTeX(serializeBibTeX([entry]));
    expect(again.author).toBe(entry.author);
  });

  it("separates notes, abstract, container/publisher, type, and translation", () => {
    const bib = `@article{full,
  author = {{Colectivo Abya Yala}},
  title = {Territorio y conocimiento},
  year = {2019},
  journal = {Tabula Rasa},
  publisher = {Universidad Colegio Mayor},
  volume = {31},
  number = {2},
  pages = {101-120},
  doi = {10.25058/20112742.n31.05},
  abstract = {Un resumen largo sobre el territorio.},
  note = {Special issue on territory.},
  translator = {María Pérez},
  language = {es}
}`;
    const [entry] = parseBibTeX(bib);
    expect(entry.sourceType).toBe("article-journal");
    expect(entry.containerTitle).toBe("Tabula Rasa");
    expect(entry.publisher).toBe("Universidad Colegio Mayor");
    expect(entry.volume).toBe("31");
    expect(entry.issue).toBe("2");
    expect(entry.pages).toBe("101-120");
    expect(entry.abstract).toBe("Un resumen largo sobre el territorio.");
    expect(entry.notes).toBe("Special issue on territory.");
    expect(entry.translation).toBe("María Pérez");
    expect(entry.author).toBe("{Colectivo Abya Yala}");
    // Round-trip: the metadata survives serialize → parse.
    const [again] = parseBibTeX(serializeBibTeX([entry]));
    expect(again.sourceType).toBe("article-journal");
    expect(again.containerTitle).toBe("Tabula Rasa");
    expect(again.publisher).toBe("Universidad Colegio Mayor");
    expect(again.abstract).toBe("Un resumen largo sobre el territorio.");
    expect(again.notes).toBe("Special issue on territory.");
    expect(again.pages).toBe("101-120");
  });

  it("escapes BibTeX values and round-trips literal braces and symbols", () => {
    const tricky = {
      title: "100% {authentic} & \\ raw #1 _underscore_ $x$",
      author: "Fanon, Frantz",
      year: "1952",
      notes: "a{b}c",
    };
    const round = parseBibTeX(serializeBibTeX([tricky]))[0];
    expect(round.title).toBe(tricky.title);
    expect(round.notes).toBe("a{b}c");
  });

  it("enforces unique citation keys for equal titles and different DOIs", () => {
    const a = { title: "Same title", author: "Smith, Linda", year: "1999", doi: "10.1/a" };
    const b = { title: "Same title", author: "Smith, Linda", year: "1999", doi: "10.1/b" };
    const out = serializeBibTeX([a, b]);
    const keys = [...out.matchAll(/@\w+\{([^,]+),/g)].map((m) => m[1]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    const csl = JSON.parse(serializeCslJson([a, b]));
    expect(csl[0].id).not.toBe(csl[1].id);
  });

  it("tracks emitted keys so a suffix can never be reused (F11)", () => {
    const base = { title: "Same title", author: "Smith, Linda", year: "1999" };
    const sources = [
      { ...base, doi: "10.1/a" },
      { ...base, doi: "10.1/b" },
      { ...base, doi: "10.1/c" },
      // A natural base that would collide if only base keys were tracked.
      { ...base, title: "Same title-2", doi: "10.1/d" },
    ];
    const out = serializeBibTeX(sources);
    const keys = [...out.matchAll(/@\w+\{([^,]+),/g)].map((m) => m[1]);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    // The suffix chain is deterministic and the natural base is distinct.
    expect(keys[1]).toBe(`${keys[0]}-2`);
    expect(keys[2]).toBe(`${keys[0]}-3`);
    expect(keys[3]).not.toBe(keys[1]);
    expect(keys[3]).not.toBe(keys[2]);
    // Both serializers agree on the identities.
    const csl = JSON.parse(serializeCslJson(sources)) as { id: string }[];
    expect(new Set(csl.map((item) => item.id)).size).toBe(4);
  });

  it("skips title-less BibTeX entries like RIS and CSL, never a placeholder (F11)", () => {
    const entries = parseBibTeX(`
@article{no-title,
  author = {Smith, Linda},
  year = {1999},
}
@book{with-title,
  title = {A real title},
  author = {Smith, Linda},
  year = {1999},
}
`);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("A real title");
    // The other formats agree: no title, no record.
    expect(parseRIS("TY  - JOUR\nAU  - Smith, Linda\nER  - ")).toHaveLength(0);
    expect(parseCslJson('[{"type":"book","author":[{"family":"Smith"}]}]')).toHaveLength(0);
  });

  it("normalizes DOI identity (resolver prefixes, case)", () => {
    expect(normalizeDoi("https://doi.org/10.2307/J.CTT1X")).toBe("10.2307/j.ctt1x");
    expect(normalizeDoi("http://dx.doi.org/10.1000/XYZ")).toBe("10.1000/xyz");
    expect(normalizeDoi("doi: 10.1000/ABC")).toBe("10.1000/abc");
    expect(normalizeDoi("  10.1/a  ")).toBe("10.1/a");
  });

  it("RIS notes and abstracts are symmetric and the type is retained", () => {
    // A long abstract must survive intact (no silent truncation).
    const longAbstract = (
      "This article examines the coloniality of knowledge production and " +
      "the politics of citation in the modern research university. "
    )
      .repeat(15)
      .trim();
    const source = {
      title: "Décoloniser la méthode",
      author: "Tuhiwai Smith, Linda",
      year: "1999",
      sourceType: "book",
      publisher: "Zed Books",
      abstract: longAbstract,
      notes: "Read chapter 2.",
      pages: "1-25",
    };
    const [entry] = parseRIS(serializeRIS([source]));
    expect(entry.sourceType).toBe("book");
    expect(entry.publisher).toBe("Zed Books");
    expect(entry.abstract).toBe(longAbstract);
    expect(entry.abstract!.length).toBeGreaterThan(1000);
    expect(entry.notes).toBe("Read chapter 2.");
    expect(entry.pages).toBe("1-25");
    expect(entry.author).toBe("Tuhiwai Smith, Linda");
    // An article stays an article through RIS (not every article is a
    // book), with its container and numbering intact.
    const [article] = parseRIS(
      serializeRIS([
        {
          title: "A",
          sourceType: "article-journal",
          containerTitle: "J",
          volume: "1",
          issue: "2",
          pages: "3-4",
        },
      ]),
    );
    expect(article.sourceType).toBe("article-journal");
    expect(article.containerTitle).toBe("J");
    expect(article.volume).toBe("1");
    expect(article.issue).toBe("2");
    expect(article.pages).toBe("3-4");
  });

  it("CSL round-trip preserves literal organizations, type, and container", () => {
    const [entry] = parseCslJson(
      serializeCslJson([
        {
          title: "Territorio",
          author: "{Colectivo Abya Yala}; Quijano, Aníbal",
          year: "2019",
          sourceType: "article-journal",
          containerTitle: "Tabula Rasa",
          volume: "31",
          issue: "2",
          pages: "101-120",
          abstract: "Resumen",
          notes: "nota",
        },
      ]),
    );
    expect(entry.author).toBe("{Colectivo Abya Yala}; Quijano, Aníbal");
    expect(entry.sourceType).toBe("article-journal");
    expect(entry.containerTitle).toBe("Tabula Rasa");
    expect(entry.pages).toBe("101-120");
    expect(entry.abstract).toBe("Resumen");
    expect(entry.notes).toBe("nota");
  });

  it("never invents sources from unrelated JSON", () => {
    expect(parseCslJson('[{"foo":1},{"bar":[1,2]}]')).toEqual([]);
    // A type without a title is not a CSL item either.
    expect(parseCslJson('[{"type":"book","author":[{"family":"X"}]}]')).toEqual([]);
    // A real item is imported with its own type.
    const [entry] = parseCslJson('[{"type":"book","title":"T"}]');
    expect(entry?.title).toBe("T");
    expect(entry?.sourceType).toBe("book");
  });
});
