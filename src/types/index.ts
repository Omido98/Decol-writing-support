// ============================================================
// Core domain types for Decol Writing Support
// ============================================================

/** Metadata for a standalone chat thread. */
export interface ThreadMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────────
// Text library
// ──────────────────────────────────────────────

/** The fixed set of kinds a library text can have. */
export type TextTypeId =
  | "essay"
  | "article"
  | "research-paper"
  | "letter"
  | "talk"
  | "other";

/** Filterable, human-readable labels for the fixed type set. */
export const TEXT_TYPES: { id: TextTypeId; label: string }[] = [
  { id: "essay", label: "Essay" },
  { id: "article", label: "Article" },
  { id: "research-paper", label: "Research paper" },
  { id: "letter", label: "Letter" },
  { id: "talk", label: "Talk" },
  { id: "other", label: "Other" },
];

/** Human label for a type id, falling back to "Other". */
export function textTypeLabel(id: TextTypeId): string {
  return TEXT_TYPES.find((t) => t.id === id)?.label ?? "Other";
}

/** Metadata for a saved text in the library. Content lives in its own file. */
export interface LibraryTextMeta {
  id: string;
  title: string;
  textType: TextTypeId;
  /** Optional one-level folder name for organizing texts. */
  folder?: string;
  /** First ~180 characters of content, for the list-card preview. */
  snippet?: string;
  /** Cached word count, so cards can show size without loading content. */
  wordCount?: number;
  createdAt: string;
  updatedAt: string;
}

/** A point-in-time snapshot of a text's content, taken on each save. */
export interface TextVersion {
  savedAt: string;
  content: string;
}

/** A library text resolved with its content, ready to attach to a chat send. */
export interface AttachedLibraryText {
  id: string;
  title: string;
  textType: TextTypeId;
  content: string;
}
