// ──────────────────────────────────────────────
// Reader source atoms (B10)
// ──────────────────────────────────────────────
// The rich serializer emits citations/footnotes as literal HTML so they
// survive Markdown round-trips. react-markdown does not render raw HTML
// (that would need rehype-raw, which allows arbitrary markup); without a
// plugin the tags would appear as visible text. This rehype plugin
// converts ONLY the editor's own citation span and footnote sup runs into
// real elements. Everything else keeps react-markdown's default behavior
// (escaped text), so no unrestricted HTML is enabled.

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

const OPEN_TAG = /^<(span|sup)\s+([^>]*)>$/;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:amp|lt|gt|quot|#39|apos);/g,
    (entity) => ENTITIES[entity] ?? entity,
  );
}

interface AtomTag {
  kind: "citation" | "footnote";
  attrs: Record<string, string>;
}

/** Parse the opening tag of an atom: attribute ORDER, extra attributes
 * (ids, locators), and entity-encoded values are all tolerated. */
function parseAtomTag(raw: string): AtomTag | null {
  const tag = OPEN_TAG.exec(raw.trim());
  if (!tag) return null;
  const attrs: Record<string, string> = {};
  const attribute = /([a-zA-Z0-9_-]+)(?:\s*=\s*"([^"]*)")?/g;
  let match: RegExpExecArray | null;
  while ((match = attribute.exec(tag[2])) !== null) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? "");
  }
  if (tag[1] === "span" && "data-citation" in attrs) {
    return { kind: "citation", attrs };
  }
  if (tag[1] === "sup" && "data-footnote" in attrs) {
    return { kind: "footnote", attrs };
  }
  return null;
}

function isRaw(node: HastNode | undefined): node is HastNode & { value: string } {
  return node?.type === "raw" && typeof node.value === "string";
}

function replaceAtoms(parent: HastNode): void {
  const children = parent.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (isRaw(node)) {
      const atom = parseAtomTag(node.value);
      if (atom) {
        const citation = atom.kind === "citation";
        const closeTag = citation ? "</span>" : "</sup>";
        let end = -1;
        for (let j = i + 1; j < children.length; j++) {
          const sibling = children[j];
          if (isRaw(sibling) && sibling.value.trim() === closeTag) {
            end = j;
            break;
          }
        }
        if (end > i) {
          const inner = children.slice(i + 1, end);
          const element: HastNode = citation
            ? {
                type: "element",
                tagName: "span",
                properties: {
                  className: ["citation-node"],
                  "data-citation": "",
                  "data-source-id": atom.attrs["data-source-id"] ?? "",
                },
                children: inner.length
                  ? inner
                  : [{ type: "text", value: "" }],
              }
            : {
                type: "element",
                tagName: "sup",
                properties: {
                  className: ["footnote-node"],
                  title: atom.attrs["data-footnote-text"] ?? "",
                  "data-footnote": "",
                  ...(atom.attrs["data-footnote-id"]
                    ? { "data-footnote-id": atom.attrs["data-footnote-id"] }
                    : {}),
                  ...(atom.attrs["data-source-id"]
                    ? { "data-source-id": atom.attrs["data-source-id"] }
                    : {}),
                  ...(atom.attrs["data-locator"]
                    ? { "data-locator": atom.attrs["data-locator"] }
                    : {}),
                },
                children: inner.length
                  ? inner
                  : [{ type: "text", value: "" }],
              };
          children.splice(i, end - i + 1, element);
          continue;
        }
      }
    }
    replaceAtoms(node);
  }
}

/** The react-markdown rehype plugin. */
export function rehypeSourceAtoms() {
  return (tree: unknown): void => {
    replaceAtoms(tree as HastNode);
  };
}
