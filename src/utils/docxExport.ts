import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  FootnoteReferenceRun,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { ILevelsOptions, IParagraphOptions } from "docx";
import type { DocumentBody } from "@/utils/documentCodec";
import type { FormattedEntry } from "@/utils/cslProcessor";

// ──────────────────────────────────────────────
// DOCX export (Phase 5.4c, repaired in B19)
// ──────────────────────────────────────────────
// Export preserves the SUPPORTED structure (headings, paragraphs, lists
// with nesting/start values, quotations including their tables,
// hyperlinks, tables with merged cells, bold/italic/code, footnotes) plus
// the bibliography. Anything not representable degrades to plain text —
// never lost silently: the original document stays untouched in the app.

interface JsonNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

type InlineChild = TextRun | ExternalHyperlink | FootnoteReferenceRun;

/** Export side-effects for inline atoms (footnote numbering). */
interface InlineFx {
  /** A footnote reference: assigns its 1-based number, records its text. */
  footnote: (text: string) => number;
}

// ──────────────────────────────────────────────
// Ordered-list numbering planner (B19)
// ──────────────────────────────────────────────
// Each top-level ordered list gets its OWN concrete numbering instance
// (`instance` in docx terms), so separate lists restart independently.
// Lists that share the same level shape share one abstract config; their
// extra instances keep them apart. Nesting depth drives `level`.

interface OrderedNumbering {
  reference: string;
  instance: number;
}

interface ListPlanner {
  configs: { reference: string; levels: ILevelsOptions[] }[];
  allocateOrdered(levels: ILevelsOptions[]): OrderedNumbering;
}

function orderedFormat(type: unknown): (typeof LevelFormat)[keyof typeof LevelFormat] {
  switch (type) {
    case "a":
      return LevelFormat.LOWER_LETTER;
    case "A":
      return LevelFormat.UPPER_LETTER;
    case "i":
      return LevelFormat.LOWER_ROMAN;
    case "I":
      return LevelFormat.UPPER_ROMAN;
    default:
      return LevelFormat.DECIMAL;
  }
}

/** Record the abstract-level definition for every ordered list at its
 * absolute depth (bullets are skipped: they use the built-in bullet
 * numbering, but their nesting still advances the depth). */
function collectOrderedLevels(
  node: JsonNode,
  depth: number,
  levels: ILevelsOptions[],
): void {
  if (node.type === "orderedList" && !levels.some((l) => l.level === depth)) {
    const start = node.attrs?.start;
    levels.push({
      level: depth,
      format: orderedFormat(node.attrs?.type),
      text: `%${depth + 1}.`,
      alignment: AlignmentType.START,
      ...(typeof start === "number" && start > 1 ? { start } : {}),
      style: {
        paragraph: { indent: { left: 720 * (depth + 1), hanging: 260 } },
      },
    });
  }
  for (const item of node.content ?? []) {
    for (const child of item.content ?? []) {
      if (child.type === "orderedList" || child.type === "bulletList") {
        collectOrderedLevels(child, depth + 1, levels);
      }
    }
  }
}

function createListPlanner(): ListPlanner {
  const configs: ListPlanner["configs"] = [];
  const byKey = new Map<string, { reference: string; nextInstance: number }>();
  let counter = 0;
  return {
    configs,
    allocateOrdered(levels: ILevelsOptions[]): OrderedNumbering {
      const sorted = [...levels].sort((a, b) => a.level - b.level);
      const key = JSON.stringify(sorted);
      let entry = byKey.get(key);
      if (!entry) {
        const reference = `ordered-list-${++counter}`;
        entry = { reference, nextInstance: 0 };
        byKey.set(key, entry);
        configs.push({ reference, levels: sorted });
      }
      return { reference: entry.reference, instance: entry.nextInstance++ };
    },
  };
}

// ──────────────────────────────────────────────
// Inline runs
// ──────────────────────────────────────────────

/** Build the inline children of a paragraph (marks, hyperlinks, citation
 * labels, footnote references). */
function inlineRuns(node: JsonNode, fx?: InlineFx): InlineChild[] {
  const runs: InlineChild[] = [];
  const walk = (
    n: JsonNode,
    marks: { type: string; attrs?: Record<string, unknown> }[],
  ): void => {
    if (n.type === "citation") {
      const label = String(n.attrs?.label ?? "");
      if (label) runs.push(new TextRun({ text: label, italics: true }));
      return;
    }
    if (n.type === "footnoteRef") {
      const num = fx
        ? fx.footnote(String(n.attrs?.text ?? ""))
        : null;
      if (num != null) runs.push(new FootnoteReferenceRun(num));
      return;
    }
    if (n.type === "hardBreak") {
      runs.push(new TextRun({ text: "", break: 1 }));
      return;
    }
    if (typeof n.text === "string") {
      const all = [...marks, ...(n.marks ?? [])];
      const run = new TextRun({
        text: n.text,
        bold: all.some((m) => m.type === "bold"),
        italics: all.some((m) => m.type === "italic"),
        strike: all.some((m) => m.type === "strike"),
        font: all.some((m) => m.type === "code") ? "Consolas" : undefined,
        underline: all.some((m) => m.type === "underline") ? {} : undefined,
      });
      // Hyperlinks become real external relationships (docx writes the
      // relationship entry); the text keeps its other marks inside.
      const link = all.find((m) => m.type === "link");
      const href =
        link && typeof link.attrs?.href === "string" ? link.attrs.href : null;
      runs.push(
        href ? new ExternalHyperlink({ children: [run], link: href }) : run,
      );
      return;
    }
    for (const child of n.content ?? []) walk(child, [...marks, ...(n.marks ?? [])]);
  };
  walk(node, []);
  return runs;
}

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

interface BlockContext {
  fx?: InlineFx;
  /** 1 for the first quotation level, 2 for nested, 0 outside. */
  quoteDepth: number;
  planner: ListPlanner;
}

/** Create a paragraph, adding the quotation indent when inside a quote. */
function makeParagraph(
  options: IParagraphOptions,
  ctx: BlockContext,
): Paragraph {
  if (ctx.quoteDepth <= 0) return new Paragraph(options);
  const base = options.indent ?? {};
  return new Paragraph({
    ...options,
    indent: {
      ...base,
      left: 720 * ctx.quoteDepth + ((base as { left?: number }).left ?? 0),
    },
  });
}

/** Export one list (and its nested lists) at the given depth. A plan is
 * allocated at the first ordered list and shared by nested ordered lists;
 * separate top-level ordered lists get separate numbering instances. */
function listToParagraphs(
  node: JsonNode,
  ctx: BlockContext,
  plan: OrderedNumbering | null,
  depth: number,
): (Paragraph | Table)[] {
  const ordered = node.type === "orderedList";
  let active = plan;
  if (ordered && !active) {
    const levels: ILevelsOptions[] = [];
    collectOrderedLevels(node, depth, levels);
    active = ctx.planner.allocateOrdered(levels);
  }

  const out: (Paragraph | Table)[] = [];
  for (const item of node.content ?? []) {
    let firstParagraph = true;
    for (const child of item.content ?? []) {
      if (child.type === "paragraph") {
        const options: IParagraphOptions = {
          children: inlineRuns(child, ctx.fx),
          ...(firstParagraph
            ? ordered && active
              ? {
                  numbering: {
                    reference: active.reference,
                    level: depth,
                    instance: active.instance,
                  },
                }
              : { bullet: { level: depth } }
            : {
                // Continuation paragraphs in the same list item stay
                // aligned under the numbered text instead of stealing a
                // list number.
                indent: { left: 720 * (depth + 1) },
              }),
        };
        out.push(makeParagraph(options, ctx));
        firstParagraph = false;
      } else if (child.type === "orderedList" || child.type === "bulletList") {
        out.push(...listToParagraphs(child, ctx, active, depth + 1));
      } else {
        out.push(...blockToParagraphs(child, ctx));
      }
    }
  }
  return out;
}

function blockToParagraphs(
  node: JsonNode,
  ctx: BlockContext,
): (Paragraph | Table)[] {
  switch (node.type) {
    case "heading": {
      const level = (node.attrs?.level as number) ?? 1;
      return [
        makeParagraph(
          {
            children: inlineRuns(node, ctx.fx),
            heading: HEADING_LEVELS[Math.min(level, 6) - 1],
          },
          ctx,
        ),
      ];
    }
    case "blockquote": {
      // Quotation content keeps its paragraph boundaries and embedded
      // tables; every paragraph is indented by the quote depth.
      const innerCtx: BlockContext = {
        ...ctx,
        quoteDepth: ctx.quoteDepth + 1,
      };
      return (node.content ?? []).flatMap((child) =>
        blockToParagraphs(child, innerCtx),
      );
    }
    case "codeBlock": {
      const text = (node.content ?? [])
        .map((c) => c.text ?? "")
        .join("");
      return [
        makeParagraph(
          {
            children: [new TextRun({ text, font: "Consolas" })],
            spacing: { before: 120, after: 120 },
            shading: { fill: "F2F2F2" },
          },
          ctx,
        ),
      ];
    }
    case "bulletList":
    case "orderedList":
      return listToParagraphs(node, ctx, null, 0);
    case "table": {
      const rows = (node.content ?? []).map(
        (row) =>
          new TableRow({
            children: (row.content ?? []).map((cell) => {
              const colspan = Number(cell.attrs?.colspan ?? 1);
              const rowspan = Number(cell.attrs?.rowspan ?? 1);
              return new TableCell({
                ...(colspan > 1 ? { columnSpan: colspan } : {}),
                ...(rowspan > 1 ? { rowSpan: rowspan } : {}),
                children: (cell.content ?? []).flatMap((child) =>
                  child.type === "paragraph"
                    ? [
                        makeParagraph(
                          { children: inlineRuns(child, ctx.fx) },
                          ctx,
                        ),
                      ]
                    : blockToParagraphs(child, ctx),
                ),
              });
            }),
          }),
      );
      return [
        new Table({
          rows,
          width: { size: 100, type: WidthType.PERCENTAGE },
        }),
      ];
    }
    default: {
      // Paragraphs and anything unknown: inline content (never dropped).
      return [makeParagraph({ children: inlineRuns(node, ctx.fx) }, ctx)];
    }
  }
}

function docxBibliography(
  title: string,
  entries: FormattedEntry[],
): Paragraph[] {
  // An empty bibliography section is skipped entirely (B19): a heading
  // with no entries claims references the document does not have.
  if (entries.length === 0) return [];
  return [
    new Paragraph({
      text: title,
      heading: HeadingLevel.HEADING_2,
    }),
    ...entries.map(
      (entry) =>
        new Paragraph({
          children: entry.map(
            (run) =>
              new TextRun({
                text: run.text,
                italics: run.italic,
                bold: run.bold,
              }),
          ),
        }),
    ),
  ];
}

/**
 * Whether a document JSON tree already contains a heading with this exact
 * text — the shape the editor's "insert bibliography" action produces.
 * DOCX callers use it to avoid appending a second bibliography.
 */
export function hasBibliographyHeading(json: unknown, title: string): boolean {
  const wanted = title.trim();
  if (!wanted) return false;
  let found = false;
  const walk = (node: unknown): void => {
    if (found || typeof node !== "object" || node === null) return;
    const n = node as JsonNode;
    if (n.type === "heading") {
      const text = (n.content ?? []).map((c) => c.text ?? "").join("").trim();
      if (text === wanted) found = true;
      return;
    }
    for (const child of n.content ?? []) walk(child);
  };
  walk(json);
  return found;
}

/**
 * Build a DOCX export for a document body (markdown bodies are converted
 * through the editor's parser first) + bibliography entries. Entries are
 * the CSL processor's structured runs (5.4e) — real italics survive.
 * The AI conversation is never included; only the manuscript is exported.
 *
 * `appendBibliography` is explicit (B19): callers whose document already
 * carries a bibliography section pass `false` so it is not duplicated.
 */
export async function buildDocx(options: {
  title: string;
  body: DocumentBody;
  bibliography: FormattedEntry[];
  /** The style's section heading (References / Works Cited / …). */
  bibliographyTitle?: string;
  appendBibliography?: boolean;
}): Promise<Buffer> {
  const {
    title,
    body,
    bibliography,
    bibliographyTitle,
    appendBibliography = true,
  } = options;
  let json: JsonNode;
  if (body.contentFormat === "tiptap-json") {
    json = JSON.parse(body.content) as JsonNode;
  } else {
    // Markdown body: convert through the editor's parser.
    const { richFromMarkdown } = await import("@/utils/richMarkdown");
    json = JSON.parse(richFromMarkdown(body.content)) as JsonNode;
  }

  // Footnotes: numbered by document order; Word numbers the references
  // natively. Text with no footnote leaves the footnotes part absent.
  const footnotes: string[] = [];
  const fx: InlineFx = {
    footnote: (text) => {
      footnotes.push(text);
      return footnotes.length;
    },
  };
  const ctx: BlockContext = { fx, quoteDepth: 0, planner: createListPlanner() };
  const blocks = (json.content ?? []).flatMap((n) => blockToParagraphs(n, ctx));

  const doc = new Document({
    ...(footnotes.length
      ? {
          footnotes: Object.fromEntries(
            footnotes.map((text, i) => [
              String(i + 1),
              {
                children: [new Paragraph({ children: [new TextRun(text)] })],
              },
            ]),
          ),
        }
      : {}),
    ...(ctx.planner.configs.length
      ? { numbering: { config: ctx.planner.configs } }
      : {}),
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
          ...blocks,
          ...(appendBibliography
            ? docxBibliography(
                bibliographyTitle ?? "Bibliography",
                bibliography,
              )
            : []),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
