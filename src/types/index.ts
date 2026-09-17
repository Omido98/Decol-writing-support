// ============================================================
// Core domain types for Decol Writing Support
// ============================================================

import type { DocumentBody } from "@/utils/documentCodec";

/** What a chat thread is for: writing a text or developing a project brief. */
export type ThreadMode = "text" | "project";

/**
 * Why a stored assistant reply is incomplete (B16b): the provider hit an
 * output limit (`truncated`) or the transport ended without the provider's
 * terminal signal / errored after output began (`interrupted`). The partial
 * content is preserved and visibly marked; it is never silently discarded.
 */
export type IncompleteReason = "interrupted" | "truncated";

/** Metadata for a standalone chat thread. */
export interface ThreadMeta {
  id: string;
  title: string;
  /** Whether the thread writes a text or develops a project brief.
   * Legacy rows without a mode are normalized to "text" on read. */
  mode: ThreadMode;
  /** Project the thread is linked to (brief agent or text-in-project). */
  projectId?: string;
  /**
   * Optional one-level folder name for organizing conversations
   * (standalone and project-linked alike). Absent = no folder.
   */
  folder?: string;
  /**
   * Free-text reference material the user gave before the chat started
   * (links, authors, books, theories). Included in every send.
   */
  references?: string;
  /** Navigator organization (D3); absent = false (legacy rows). */
  archived?: boolean;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A navigator folder (schema v16). Folders group texts and conversations
 * (mixed) within one scope: `""` is the standalone area, a project id is
 * that project's area. Membership lives in the items' `folder` name —
 * the registry keeps empty folders alive and backs create/rename/delete.
 */
export interface FolderMeta {
  id: string;
  scope: string;
  name: string;
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
  /** Project the text belongs to; absent for standalone texts. */
  projectId?: string;
  /** First ~180 characters of content, for the list-card preview. */
  snippet?: string;
  /** Cached word count, so cards can show size without loading content. */
  wordCount?: number;
  /** Navigator organization (D3): pinned sorts first, archived hides
   * the text from the main lists. Absent = false (legacy rows). */
  archived?: boolean;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A point-in-time snapshot of a text's content, taken on each save.
 * `versionId` is a stable unique identity — timestamps alone can collide
 * when two snapshots land in the same millisecond. The snapshot carries
 * the full document format contract (Phase 4.1), so a historical restore
 * preserves the body format exactly. */
export interface TextVersion {
  versionId: string;
  savedAt: string;
  body: DocumentBody;
  /** User-given name for an explicit snapshot; absent for save points. */
  label?: string;
}

/** A library text resolved with its content, ready to attach to a chat send. */
export interface AttachedLibraryText {
  id: string;
  title: string;
  textType: TextTypeId;
  content: string;
}

// ──────────────────────────────────────────────
// Sources (Phase 5.1)
// ──────────────────────────────────────────────

/** How the source's text was extracted from its original asset. */
export type ExtractionStatus = "pending" | "ready" | "failed" | "truncated";

/** Distinct verification states (never collapsed into a "score"). */
export type VerificationStatus =
  | "unverified"
  | "retrieved"
  | "quote_matched"
  | "supports"
  | "disputed";

/** A versioned source record (book, article, interview, uploaded file…). */
export interface SourceMeta {
  id: string;
  /** Project association; absent for standalone sources. */
  projectId?: string;
  title: string;
  author?: string;
  year?: string;
  /** DOI/URL where available. */
  doi?: string;
  url?: string;
  /** Original language of the material. */
  language?: string;
  /** Translation attribution note. */
  translation?: string;
  /** Reference to the original asset (file name / origin). */
  assetRef?: string;
  /** Bibliographic type when known (a CSL type: "article-journal",
   * "book", "chapter", "paper-conference", "thesis", "report",
   * "webpage", "document"). Never invented — absent stays absent. */
  sourceType?: string;
  /** Container: journal, book, proceedings, or site title. */
  containerTitle?: string;
  /** Publisher / institution / university. */
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  /** Abstract, kept separate from notes and translation attribution. */
  abstract?: string;
  /** The original text as provided — preserved verbatim. */
  originalText: string;
  /** Content identity for deduplication (never the file name). */
  contentHash: string;
  extractionStatus: ExtractionStatus;
  /** Why the extraction is partial, when it is. */
  truncationNote?: string;
  /** User-controlled context inclusion. */
  includedInContext: boolean;
  notes?: string;
  verification: VerificationStatus;
  createdAt: string;
  updatedAt: string;
}

/** One extracted passage with its page/section locator. */
export interface SourcePassage {
  id: string;
  locator?: string;
  content: string;
}

/** A source resolved with its passages + revision. */
export interface SourceData {
  source: SourceMeta;
  passages: SourcePassage[];
  rev: number;
}

/** SHA-256 hex digest of text — the content identity for dedup. */
export async function contentIdentity(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Normalize a DOI to its comparable identity: the DOI is case-insensitive
 * and resolver prefixes are not part of it. Returns "" when the value is
 * empty. This is the BIBLIOGRAPHIC identity used for deduplication when a
 * source carries one (a formatted reference line is presentation, not
 * identity).
 */
export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLowerCase();
}

/** A reviewable AI revision proposal (Phase 5.3). */
export type ProposalKind = "revise" | "tighten" | "clarify" | "comment";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "stale";

export interface DocumentProposal {
  id: string;
  documentId: string;
  /** Document revision the proposal was made against. */
  baseRev: number;
  requestKind: ProposalKind;
  /** The ORIGINAL selected fragment. */
  baseFragment: string;
  proposedFragment: string;
  /** Selection range at proposal time (a verified locating hint). */
  selFrom?: number;
  selTo?: number;
  /** Context/source references recorded with the request. */
  contextNote?: string;
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────────
// Writing brief (structured answers that start a chat thread)
// ──────────────────────────────────────────────

/** The fixed set of audience options for the writing brief. */
export type AudienceId =
  | "children"
  | "students"
  | "academics"
  | "professionals"
  | "general-public"
  | "other";

/** Filterable, human-readable labels for the fixed audience set. */
export const AUDIENCES: { id: AudienceId; label: string }[] = [
  { id: "children", label: "Children" },
  { id: "students", label: "Students" },
  { id: "academics", label: "Academics" },
  { id: "professionals", label: "Professionals" },
  { id: "general-public", label: "General public" },
  { id: "other", label: "Other" },
];

/** Human label for an audience id, falling back to "Other". */
export function audienceLabel(id: AudienceId): string {
  return AUDIENCES.find((a) => a.id === id)?.label ?? "Other";
}

/** The fixed set of tone options for the writing brief. */
export type ToneId =
  | "academic"
  | "formal"
  | "conversational"
  | "journalistic"
  | "persuasive"
  | "teaching"
  | "other";

/** Filterable, human-readable labels for the fixed tone set. */
export const TONES: { id: ToneId; label: string }[] = [
  { id: "academic", label: "Academic" },
  { id: "formal", label: "Formal / neutral" },
  { id: "conversational", label: "Conversational" },
  { id: "journalistic", label: "Journalistic" },
  { id: "persuasive", label: "Persuasive" },
  { id: "teaching", label: "Teaching / explanatory" },
  { id: "other", label: "Other" },
];

/** Human label for a tone id, falling back to "Other". */
export function toneLabel(id: ToneId): string {
  return TONES.find((t) => t.id === id)?.label ?? "Other";
}

/** The fixed set of citation options for the writing brief. */
export type CitationId =
  | "none"
  | "resource-list"
  | "apa"
  | "mla"
  | "chicago"
  | "harvard"
  | "other";

/** Filterable, human-readable labels for the fixed citation set. */
export const CITATION_STYLES: { id: CitationId; label: string }[] = [
  { id: "none", label: "No citations" },
  { id: "resource-list", label: "Resource list at the end" },
  { id: "apa", label: "APA" },
  { id: "mla", label: "MLA" },
  { id: "chicago", label: "Chicago" },
  { id: "harvard", label: "Harvard" },
  { id: "other", label: "Other" },
];

/** Human label for a citation id, falling back to "Other". */
export function citationLabel(id: CitationId): string {
  return CITATION_STYLES.find((c) => c.id === id)?.label ?? "Other";
}

/** The fixed set of length options for the writing brief. */
export type LengthId = "short" | "medium" | "long" | "undecided";

/** Filterable, human-readable labels for the fixed length set. */
export const LENGTHS: { id: LengthId; label: string }[] = [
  { id: "short", label: "Short (under ~500 words)" },
  { id: "medium", label: "Medium (~500-1500 words)" },
  { id: "long", label: "Long (over ~1500 words)" },
  { id: "undecided", label: "Not decided yet" },
];

/** Human label for a length id, falling back to "Not decided yet". */
export function lengthLabel(id: LengthId): string {
  return LENGTHS.find((l) => l.id === id)?.label ?? "Not decided yet";
}

/**
 * The structured answers a user gives before a chat thread starts. The
 * agent treats these as settled and fills only the gaps in conversation.
 */
export interface WritingBrief {
  /** What the text is about (one-line topic). */
  topic: string;
  /** Context, occasion, or background the text should build on. */
  background: string;
  /** The kind of text (shares the library's type set). */
  textType: TextTypeId;
  /** Who the text is for. */
  audience: AudienceId;
  /** Free-text audience, used when `audience` is "other". */
  audienceOther?: string;
  /** The voice the text should carry. */
  tone: ToneId;
  /** Free-text tone, used when `tone` is "other". */
  toneOther?: string;
  /** How citations should appear in the text. */
  citations: CitationId;
  /** Free-text citation style, used when `citations` is "other". */
  citationsOther?: string;
  /** Target length of the text. */
  length: LengthId;
  /** Language to write in (e.g. "English", "Norwegian bokmål"). */
  language: string;
  /** Points, sources, or angles the text must include. */
  mustInclude: string;
  /** Things the text must avoid (words, framings, sources). */
  mustAvoid: string;
}

// ──────────────────────────────────────────────
// Projects
// ──────────────────────────────────────────────

/**
 * A project bundles several texts that share audience, voice, citation
 * style, and background. The brief is free-form markdown; the defaults
 * pre-fill the writing brief of texts created inside the project.
 */
export interface ProjectMeta {
  id: string;
  title: string;
  /** One-line description shown on the project card. */
  description?: string;
  /** Default audience texts of this project inherit. */
  defaultAudience?: AudienceId;
  /** Default tone texts of this project inherit. */
  defaultTone?: ToneId;
  /** Default citation style texts of this project inherit. */
  defaultCitations?: CitationId;
  /** Default language texts of this project inherit. */
  defaultLanguage?: string;
  /**
   * Free-text reference material for the whole project (links, authors,
   * books, theories): included in every send of the project's threads.
   */
  references?: string;
  /** Cached word count of the brief, for the project card. */
  briefWordCount?: number;
  createdAt: string;
  updatedAt: string;
}
