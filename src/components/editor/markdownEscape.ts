// ──────────────────────────────────────────────
// Atom Markdown escaping (B19)
// ──────────────────────────────────────────────
// Citation and footnote atoms serialize as literal HTML in Markdown. Any
// value interpolated into that HTML — a label in element text, an id or
// locator in a double-quoted attribute — must be escaped, or a label
// containing `</sup>` closes the element early and a quote breaks the
// attribute. The reader plugin in `sourceAtoms.ts` decodes these entities
// back when it rebuilds the atoms.

/** Escape a value interpolated into HTML element text. */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a value interpolated into a double-quoted HTML attribute. */
export function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
