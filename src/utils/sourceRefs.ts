// ──────────────────────────────────────────────
// Source references in a document (B19)
// ──────────────────────────────────────────────
// A document references sources through TWO atom kinds: citation nodes
// and source-backed footnotes. Bibliographies and "unresolved reference"
// reports must see both, in document order, deduplicated by source id.
// These helpers work on a live editor document and on stored/parsed JSON
// trees (the reader and DOCX export have no Node API).

export interface SourceRef {
  sourceId: string;
}

interface JsonLike {
  type?: unknown;
  attrs?: Record<string, unknown>;
  content?: unknown[];
}

function walkJson(node: unknown, out: SourceRef[], seen: Set<string>): void {
  if (typeof node !== "object" || node === null) return;
  const n = node as JsonLike;
  if (n.type === "citation" || n.type === "footnoteRef") {
    const id =
      typeof n.attrs?.sourceId === "string" ? n.attrs.sourceId : null;
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ sourceId: id });
    }
    return;
  }
  for (const child of n.content ?? []) walkJson(child, out, seen);
}

/** Source ids referenced by a PLAIN ProseMirror-JSON tree, in document
 * order, deduplicated. */
export function collectSourceRefsFromJson(json: unknown): SourceRef[] {
  const out: SourceRef[] = [];
  walkJson(json, out, new Set());
  return out;
}

/** Source ids referenced by a live editor document, in document order,
 * deduplicated. Works for citations and source-backed footnotes alike. */
export function collectSourceRefs(doc: {
  descendants: (
    f: (
      node: { type: { name: string }; attrs: Record<string, unknown> },
      pos: number,
    ) => boolean | void,
  ) => void;
}): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name !== "citation" && node.type.name !== "footnoteRef") {
      return;
    }
    const id = node.attrs.sourceId as string | null | undefined;
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ sourceId: id });
    }
  });
  return out;
}

/** Referenced ids that no longer exist among the user's sources. */
export function missingSourceIds(
  refs: SourceRef[],
  sources: { id: string }[],
): string[] {
  const known = new Set(sources.map((s) => s.id));
  return refs
    .map((ref) => ref.sourceId)
    .filter((id) => !known.has(id));
}
