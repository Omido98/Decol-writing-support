import {
  mkdir,
  writeTextFile,
  remove,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { saveJson, hasTauriFs } from "@/utils/storage";
import {
  repo,
  runExclusiveMaintenance,
  privilegedDrain,
} from "@/utils/repository";
import {
  getAllPrefs,
  setPrefPrivileged,
  replacePrefsPrivileged,
  beginPreferenceMaintenance,
  endPreferenceMaintenance,
  privilegedPreferenceDrain,
} from "@/utils/preferences";
import {
  bumpDatasetGeneration,
} from "@/utils/datasetGeneration";
import { CONTENT_SCHEMA_VERSION } from "@/utils/documentCodec";

// The reactive dataset generation lives in its own module (mounted views
// subscribe to it); re-exported here for existing callers/tests.
export { datasetGeneration, bumpDatasetGeneration } from "@/utils/datasetGeneration";

/**
 * Backup & restore of all app data as a single JSON bundle.
 *
 * Bundle versions:
 * - **v1** — every data file as JSON (legacy; also produced by browser dev
 *   sessions). Restore replaces the domain files and lets the legacy
 *   importer take over inside the desktop app.
 * - **v2** — a SQLite dump (`db`) plus plain settings files. Restore
 *   replaces the database and preferences in one transaction.
 * - **v3** — a SQLite dump (`data`) plus a `preferences` record (non-secret
 *   configuration, credentials excluded). This is the current format.
 *
 * Every restore runs inside one maintenance barrier: AI operations are
 * settled, new persistence is blocked, pending saves are drained, a
 * recovery snapshot of the current dataset is written, and the restored
 * dataset (domain rows + preferences) commits in ONE Rust transaction.
 * API keys are never exported in any version. Migration bookkeeping is
 * never part of a bundle: exports contain only domain tables and named
 * preferences, never internal markers.
 */

export const BACKUP_FORMAT = "decol-writing-support-backup";
export const BACKUP_VERSION = 3;

// ──────────────────────────────────────────────
// Canonical dump contract
// ──────────────────────────────────────────────
//
// The canonical shape is what Rust's `DbDump` ACTUALLY serializes:
// camelCase keys, every struct field present (serde emits `null` for absent
// Options), and message/passage rows FLATTENED into their parent row
// (`#[serde(flatten)]` on `StoredMessageRow`/`StoredSourcePassageRow`).
// Bundles produced while the nested contract existed put the payload under
// `message`/`passage`; `normalizeDump` converts those historical shapes
// explicitly before validation. Every path that reaches Rust passes the
// canonical shape only.

export type DumpContentFormat = "markdown" | "tiptap-json";

export interface DumpTextRow {
  id: string;
  title: string;
  textType: string;
  folder: string | null;
  projectId: string | null;
  snippet: string | null;
  wordCount: number | null;
  rev: number;
  archived: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DumpTextContentRow {
  textId: string;
  content: string;
  contentFormat: DumpContentFormat | null;
  contentSchemaVersion: number | null;
  plainText: string | null;
}

export interface DumpTextVersionRow {
  textId: string;
  versionId: string | null;
  savedAt: string;
  content: string;
  contentFormat: DumpContentFormat | null;
  contentSchemaVersion: number | null;
  plainText: string | null;
  label: string | null;
}

export interface DumpProjectRow {
  id: string;
  title: string;
  description: string | null;
  defaultAudience: string | null;
  defaultTone: string | null;
  defaultCitations: string | null;
  defaultLanguage: string | null;
  /** Wire name; legacy `refs` payloads are normalized to this. */
  references: string | null;
  briefWordCount: number | null;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export interface DumpProjectBriefRow {
  projectId: string;
  content: string;
}

export interface DumpSourceRow {
  id: string;
  projectId: string | null;
  title: string;
  author: string | null;
  year: string | null;
  doi: string | null;
  url: string | null;
  language: string | null;
  translation: string | null;
  assetRef: string | null;
  /** Bibliography metadata (B18, schema v13). */
  sourceType: string | null;
  containerTitle: string | null;
  publisher: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  abstract: string | null;
  originalText: string;
  contentHash: string;
  extractionStatus: "pending" | "ready" | "failed" | "truncated";
  truncationNote: string | null;
  includedInContext: boolean;
  notes: string | null;
  verification:
    | "unverified"
    | "retrieved"
    | "quote_matched"
    | "supports"
    | "disputed";
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export interface DumpSourcePassageRow {
  sourceId: string;
  id: string;
  locator: string | null;
  content: string;
}

export interface DumpProposalRow {
  id: string;
  documentId: string;
  baseRev: number;
  requestKind: "revise" | "tighten" | "clarify" | "comment";
  baseFragment: string;
  proposedFragment: string;
  selFrom: number | null;
  selTo: number | null;
  contextNote: string | null;
  status: "pending" | "accepted" | "rejected" | "stale";
  createdAt: string;
  updatedAt: string;
}

export interface DumpThreadRow {
  id: string;
  title: string;
  mode: string;
  projectId: string | null;
  /** One-level conversation folder (v15); null = no folder. */
  folder: string | null;
  references: string | null;
  rev: number;
  archived: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DumpThreadBriefRow {
  threadId: string;
  briefJson: string | null;
}

/** A navigator folder registry row (schema v16). */
export interface DumpFolderRow {
  id: string;
  /** "" = the standalone area; otherwise a project id. */
  scope: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Canonical message row: `StoredMessageRow` with its message flattened. */
export interface DumpMessageRow {
  threadId: string;
  idx: number;
  id: string | null;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  failed: boolean;
  /** Incompleteness marker of an assistant partial (B16b, schema v12). */
  incomplete: "interrupted" | "truncated" | null;
  attachmentsJson: string | null;
}

export interface CanonicalDump {
  texts: DumpTextRow[];
  textContents: DumpTextContentRow[];
  textVersions: DumpTextVersionRow[];
  projects: DumpProjectRow[];
  projectBriefs: DumpProjectBriefRow[];
  sources: DumpSourceRow[];
  sourcePassages: DumpSourcePassageRow[];
  proposals: DumpProposalRow[];
  threads: DumpThreadRow[];
  threadBriefs: DumpThreadBriefRow[];
  messages: DumpMessageRow[];
  folders: DumpFolderRow[];
}

export interface BackupBundle {
  format: string;
  version: number;
  exportedAt: string;
  /** v1/v2: data files keyed by name. */
  files?: Record<string, unknown>;
  /** v2: SQLite dump, canonicalized by the parser. */
  db?: CanonicalDump;
  /** v3: SQLite dump, canonicalized by the parser. */
  data?: CanonicalDump;
  /** v3: non-secret preferences keyed by name (credentials excluded). */
  preferences?: Record<string, unknown>;
}

/** Real activated counts, reported to the user after a restore. */
export interface RestoreCounts {
  texts: number;
  projects: number;
  threads: number;
  messages: number;
  versions: number;
  sources?: number;
  sourcePassages?: number;
  files?: number;
}

/** Plain settings (now preferences) names carried by v1/v2 bundles. */
const SETTINGS_FILES = ["config.json", "settings.json", "zen-prices.json"] as const;

/** Only these safe file names are accepted when restoring a v1 backup. */
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+\.json$/;

/** Dataset generation: see `@/utils/datasetGeneration` (re-exported). */

/** Strip the credential from a config record (never export/restore it). */
function withoutSecrets(pref: unknown): unknown {
  if (pref && typeof pref === "object" && "apiKey" in (pref as object)) {
    return { ...(pref as object), apiKey: "" };
  }
  return pref;
}

/**
 * The canonical v3 envelope of the CURRENT dataset: the validated dump
 * from the active backend plus the full credential-free preferences
 * record (which carries the recovery drafts). The caller owns the
 * maintenance/drain context and the failure wording.
 */
async function exportCanonicalBundle(
  exportedAt: string,
  abort: (reason: string) => Error,
): Promise<BackupBundle> {
  // B21d: BOTH backends produce the canonical v3 dump. The JSON backend
  // assembles it from its files; the SQLite backend returns `db_export`.
  const { dump, error } = normalizeDumpChecked(await repo.exportDump());
  if (!dump) throw abort(error ?? "unknown validation error");
  const preferences: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(await getAllPrefs())) {
    preferences[key] = withoutSecrets(value);
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    data: dump,
    preferences,
  };
}

export async function buildBackupBundle(): Promise<BackupBundle> {
  const exportedAt = new Date().toISOString();

  // One EXCLUSIVE maintenance run: the barrier goes up BEFORE the drain,
  // so no mutation can slip between the drain and the snapshot. The drain
  // itself is privileged (it runs while ordinary writes are blocked).
  // Saves scheduled during the snapshot are held and released afterwards.
  return runExclusiveMaintenance("release", async () => {
    await privilegedDrain();
    // F04: preference writes are acknowledged too — a delayed `setPref`
    // (settings, recovery drafts) must land before the snapshot reads
    // them, or the bundle silently omits a value the app reports pending.
    await privilegedPreferenceDrain();
    return exportCanonicalBundle(exportedAt, (reason) => {
      // The production export path must produce a bundle the production
      // import parser accepts. Failing here beats writing an unimportable
      // file the user only discovers when they need it.
      return new Error(
        `Export aborted: the stored dataset failed backup validation (${reason}). ` +
          "No backup file was written.",
      );
    });
  });
}

// ──────────────────────────────────────────────
// Validation (before anything is touched)
// ──────────────────────────────────────────────

class DumpError extends Error {}

function bad(message: string): never {
  throw new DumpError(message);
}

function recordOf(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) bad(`${where} is not an object`);
  return v as Record<string, unknown>;
}

function arrayOf(v: unknown, where: string): unknown[] {
  if (v == null) return [];
  if (!Array.isArray(v)) bad(`${where} must be an array`);
  return v;
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string") bad(`${where} must be a string`);
  return v;
}

function nonEmptyStr(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) {
    bad(`${where} must be a non-empty string`);
  }
  return v;
}

function optionalStr(v: unknown, where: string): string | null {
  if (v == null) return null;
  if (typeof v !== "string") bad(`${where} must be a string or null`);
  return v;
}

function bool(v: unknown, where: string, fallback: boolean): boolean {
  if (v == null) return fallback;
  if (typeof v !== "boolean") bad(`${where} must be a boolean`);
  return v;
}

function int(v: unknown, where: string, fallback: number): number {
  if (v == null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v)) bad(`${where} must be an integer`);
  return v;
}

function optionalInt(v: unknown, where: string): number | null {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    bad(`${where} must be an integer or null`);
  }
  return v;
}

function enumOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
  where: string,
): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    bad(`${where} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

/** `references` wins over the legacy `refs` spelling, exactly like serde. */
function referencesOf(row: Record<string, unknown>, where: string): string | null {
  return "references" in row
    ? optionalStr(row.references, `${where}.references`)
    : optionalStr(row.refs, `${where}.refs`);
}

/** A string carrying JSON; malformed JSON is a malformed record. */
function optionalJsonString(v: unknown, where: string): string | null {
  const s = optionalStr(v, where);
  if (s == null) return null;
  try {
    JSON.parse(s);
  } catch {
    bad(`${where} is not valid JSON`);
  }
  return s;
}

/** Attachments travel as a JSON array; anything else is malformed. */
function optionalAttachmentsJson(v: unknown, where: string): string | null {
  const s = optionalStr(v, where);
  if (s == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    bad(`${where} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) bad(`${where} must be a JSON array`);
  return s;
}

/** The format-contract fields shared by bodies and version snapshots. */
function contentFields(
  row: Record<string, unknown>,
  where: string,
): Pick<DumpTextContentRow, "contentFormat" | "contentSchemaVersion" | "plainText"> {
  const contentFormat =
    row.contentFormat == null
      ? null
      : enumOf(
          row.contentFormat,
          ["markdown", "tiptap-json"] as const,
          `${where}.contentFormat`,
        );
  const contentSchemaVersion =
    row.contentSchemaVersion == null
      ? null
      : int(row.contentSchemaVersion, `${where}.contentSchemaVersion`, 0);
  if (
    contentSchemaVersion != null &&
    (contentSchemaVersion < 1 || contentSchemaVersion > CONTENT_SCHEMA_VERSION)
  ) {
    bad(
      `${where}.contentSchemaVersion ${contentSchemaVersion} is not supported ` +
        `(this build supports up to ${CONTENT_SCHEMA_VERSION})`,
    );
  }
  return {
    contentFormat,
    contentSchemaVersion,
    plainText: optionalStr(row.plainText, `${where}.plainText`),
  };
}

// ── Row normalizers (historical shapes → canonical rows) ──

function normText(raw: unknown, i: number): DumpTextRow {
  const row = recordOf(raw, `texts[${i}]`);
  return {
    id: nonEmptyStr(row.id, `texts[${i}].id`),
    title: str(row.title, `texts[${i}].title`),
    textType: str(row.textType, `texts[${i}].textType`),
    folder: optionalStr(row.folder, `texts[${i}].folder`),
    projectId: optionalStr(row.projectId, `texts[${i}].projectId`),
    snippet: optionalStr(row.snippet, `texts[${i}].snippet`),
    wordCount: optionalInt(row.wordCount, `texts[${i}].wordCount`),
    rev: int(row.rev, `texts[${i}].rev`, 0),
    archived: bool(row.archived, `texts[${i}].archived`, false),
    pinned: bool(row.pinned, `texts[${i}].pinned`, false),
    createdAt: str(row.createdAt, `texts[${i}].createdAt`),
    updatedAt: str(row.updatedAt, `texts[${i}].updatedAt`),
  };
}

function normProject(raw: unknown, i: number): DumpProjectRow {
  const row = recordOf(raw, `projects[${i}]`);
  return {
    id: nonEmptyStr(row.id, `projects[${i}].id`),
    title: str(row.title, `projects[${i}].title`),
    description: optionalStr(row.description, `projects[${i}].description`),
    defaultAudience: optionalStr(row.defaultAudience, `projects[${i}].defaultAudience`),
    defaultTone: optionalStr(row.defaultTone, `projects[${i}].defaultTone`),
    defaultCitations: optionalStr(
      row.defaultCitations,
      `projects[${i}].defaultCitations`,
    ),
    defaultLanguage: optionalStr(row.defaultLanguage, `projects[${i}].defaultLanguage`),
    references: referencesOf(row, `projects[${i}]`),
    briefWordCount: optionalInt(row.briefWordCount, `projects[${i}].briefWordCount`),
    rev: int(row.rev, `projects[${i}].rev`, 0),
    createdAt: str(row.createdAt, `projects[${i}].createdAt`),
    updatedAt: str(row.updatedAt, `projects[${i}].updatedAt`),
  };
}

function normThread(raw: unknown, i: number): DumpThreadRow {
  const row = recordOf(raw, `threads[${i}]`);
  return {
    id: nonEmptyStr(row.id, `threads[${i}].id`),
    title: str(row.title, `threads[${i}].title`),
    mode: row.mode == null ? "text" : str(row.mode, `threads[${i}].mode`),
    projectId: optionalStr(row.projectId, `threads[${i}].projectId`),
    folder: optionalStr(row.folder, `threads[${i}].folder`),
    references: referencesOf(row, `threads[${i}]`),
    rev: int(row.rev, `threads[${i}].rev`, 0),
    archived: bool(row.archived, `threads[${i}].archived`, false),
    pinned: bool(row.pinned, `threads[${i}].pinned`, false),
    createdAt: str(row.createdAt, `threads[${i}].createdAt`),
    updatedAt: str(row.updatedAt, `threads[${i}].updatedAt`),
  };
}

function normSource(raw: unknown, i: number): DumpSourceRow {
  const row = recordOf(raw, `sources[${i}]`);
  return {
    id: nonEmptyStr(row.id, `sources[${i}].id`),
    projectId: optionalStr(row.projectId, `sources[${i}].projectId`),
    title: str(row.title, `sources[${i}].title`),
    author: optionalStr(row.author, `sources[${i}].author`),
    year: optionalStr(row.year, `sources[${i}].year`),
    doi: optionalStr(row.doi, `sources[${i}].doi`),
    url: optionalStr(row.url, `sources[${i}].url`),
    language: optionalStr(row.language, `sources[${i}].language`),
    translation: optionalStr(row.translation, `sources[${i}].translation`),
    assetRef: optionalStr(row.assetRef, `sources[${i}].assetRef`),
    sourceType: optionalStr(row.sourceType, `sources[${i}].sourceType`),
    containerTitle: optionalStr(row.containerTitle, `sources[${i}].containerTitle`),
    publisher: optionalStr(row.publisher, `sources[${i}].publisher`),
    volume: optionalStr(row.volume, `sources[${i}].volume`),
    issue: optionalStr(row.issue, `sources[${i}].issue`),
    pages: optionalStr(row.pages, `sources[${i}].pages`),
    abstract: optionalStr(row.abstract, `sources[${i}].abstract`),
    originalText: str(row.originalText, `sources[${i}].originalText`),
    contentHash: nonEmptyStr(row.contentHash, `sources[${i}].contentHash`),
    extractionStatus:
      row.extractionStatus == null
        ? "ready"
        : enumOf(
            row.extractionStatus,
            ["pending", "ready", "failed", "truncated"] as const,
            `sources[${i}].extractionStatus`,
          ),
    truncationNote: optionalStr(row.truncationNote, `sources[${i}].truncationNote`),
    includedInContext: bool(
      row.includedInContext,
      `sources[${i}].includedInContext`,
      true,
    ),
    notes: optionalStr(row.notes, `sources[${i}].notes`),
    verification:
      row.verification == null
        ? "unverified"
        : enumOf(
            row.verification,
            ["unverified", "retrieved", "quote_matched", "supports", "disputed"] as const,
            `sources[${i}].verification`,
          ),
    rev: int(row.rev, `sources[${i}].rev`, 0),
    createdAt: str(row.createdAt, `sources[${i}].createdAt`),
    updatedAt: str(row.updatedAt, `sources[${i}].updatedAt`),
  };
}

function normProposal(raw: unknown, i: number): DumpProposalRow {
  const row = recordOf(raw, `proposals[${i}]`);
  return {
    id: nonEmptyStr(row.id, `proposals[${i}].id`),
    documentId: nonEmptyStr(row.documentId, `proposals[${i}].documentId`),
    baseRev: int(row.baseRev, `proposals[${i}].baseRev`, 0),
    requestKind: enumOf(
      row.requestKind,
      ["revise", "tighten", "clarify", "comment"] as const,
      `proposals[${i}].requestKind`,
    ),
    baseFragment: str(row.baseFragment, `proposals[${i}].baseFragment`),
    proposedFragment: str(row.proposedFragment, `proposals[${i}].proposedFragment`),
    selFrom: optionalInt(row.selFrom, `proposals[${i}].selFrom`),
    selTo: optionalInt(row.selTo, `proposals[${i}].selTo`),
    contextNote: optionalStr(row.contextNote, `proposals[${i}].contextNote`),
    status:
      row.status == null
        ? "pending"
        : enumOf(
            row.status,
            ["pending", "accepted", "rejected", "stale"] as const,
            `proposals[${i}].status`,
          ),
    createdAt: str(row.createdAt, `proposals[${i}].createdAt`),
    updatedAt: str(row.updatedAt, `proposals[${i}].updatedAt`),
  };
}

/**
 * Message rows: canonical is flattened (`threadId`/`idx` beside the
 * message fields). Historical bundles nested the payload under `message`;
 * that shape is converted here, explicitly and only for reading.
 */
function normMessage(raw: unknown, i: number): DumpMessageRow {
  const outer = recordOf(raw, `messages[${i}]`);
  const row =
    outer.message == null
      ? outer
      : {
          ...recordOf(outer.message, `messages[${i}].message`),
          threadId: outer.threadId,
          idx: outer.idx,
        };
  return {
    threadId: nonEmptyStr(row.threadId, `messages[${i}].threadId`),
    idx: int(row.idx, `messages[${i}].idx`, -1),
    id: optionalStr(row.id, `messages[${i}].id`),
    role: enumOf(row.role, ["user", "assistant"] as const, `messages[${i}].role`),
    content: str(row.content, `messages[${i}].content`),
    timestamp: str(row.timestamp, `messages[${i}].timestamp`),
    failed: bool(row.failed, `messages[${i}].failed`, false),
    incomplete:
      row.incomplete == null
        ? null
        : enumOf(
            row.incomplete,
            ["interrupted", "truncated"] as const,
            `messages[${i}].incomplete`,
          ),
    attachmentsJson: optionalAttachmentsJson(
      row.attachmentsJson,
      `messages[${i}].attachmentsJson`,
    ),
  };
}

/** Passage rows: canonical is flattened; historical `passage` is converted. */
function normPassage(raw: unknown, i: number): DumpSourcePassageRow {
  const outer = recordOf(raw, `sourcePassages[${i}]`);
  const row =
    outer.passage == null
      ? outer
      : {
          ...recordOf(outer.passage, `sourcePassages[${i}].passage`),
          sourceId: outer.sourceId,
        };
  return {
    sourceId: nonEmptyStr(row.sourceId, `sourcePassages[${i}].sourceId`),
    id: nonEmptyStr(row.id, `sourcePassages[${i}].id`),
    locator: optionalStr(row.locator, `sourcePassages[${i}].locator`),
    content: str(row.content, `sourcePassages[${i}].content`),
  };
}

/** Validate ids are unique across a table. Returns the id set. */
function uniqueIds(rows: { id: string }[], where: string): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) bad(`${where} contains duplicate id "${row.id}"`);
    ids.add(row.id);
  }
  return ids;
}

/** Build the canonical dump from a raw payload, converting legacy shapes. */
function buildCanonicalDump(raw: unknown): CanonicalDump {
  const dump = recordOf(raw, "backup data");

  const texts = arrayOf(dump.texts, "texts").map(normText);
  const projects = arrayOf(dump.projects, "projects").map(normProject);
  const threads = arrayOf(dump.threads, "threads").map(normThread);
  const textContents = arrayOf(dump.textContents, "textContents").map((r, i) => {
    const row = recordOf(r, `textContents[${i}]`);
    const where = `textContents[${i}]`;
    return {
      textId: nonEmptyStr(row.textId, `${where}.textId`),
      content: str(row.content, `${where}.content`),
      ...contentFields(row, where),
    };
  });
  const textVersions = arrayOf(dump.textVersions, "textVersions").map((r, i) => {
    const row = recordOf(r, `textVersions[${i}]`);
    const where = `textVersions[${i}]`;
    const versionId = optionalStr(row.versionId, `${where}.versionId`);
    return {
      textId: nonEmptyStr(row.textId, `${where}.textId`),
      // An empty id means "generate one on import" in Rust; normalize it.
      versionId: versionId === "" ? null : versionId,
      savedAt: str(row.savedAt, `${where}.savedAt`),
      content: str(row.content, `${where}.content`),
      ...contentFields(row, where),
      label: optionalStr(row.label, `${where}.label`),
    };
  });
  const projectBriefs = arrayOf(dump.projectBriefs, "projectBriefs").map((r, i) => {
    const row = recordOf(r, `projectBriefs[${i}]`);
    return {
      projectId: nonEmptyStr(row.projectId, `projectBriefs[${i}].projectId`),
      content: str(row.content, `projectBriefs[${i}].content`),
    };
  });
  const sources = arrayOf(dump.sources, "sources").map(normSource);
  const sourcePassages = arrayOf(dump.sourcePassages, "sourcePassages").map(normPassage);
  const proposals = arrayOf(dump.proposals, "proposals").map(normProposal);
  const threadBriefs = arrayOf(dump.threadBriefs, "threadBriefs").map((r, i) => {
    const row = recordOf(r, `threadBriefs[${i}]`);
    return {
      threadId: nonEmptyStr(row.threadId, `threadBriefs[${i}].threadId`),
      briefJson: optionalJsonString(row.briefJson, `threadBriefs[${i}].briefJson`),
    };
  });
  const messages = arrayOf(dump.messages, "messages").map(normMessage);
  const folders = arrayOf(dump.folders, "folders").map((r, i) => {
    const row = recordOf(r, `folders[${i}]`);
    return {
      id: nonEmptyStr(row.id, `folders[${i}].id`),
      scope: str(row.scope, `folders[${i}].scope`),
      name: nonEmptyStr(row.name, `folders[${i}].name`),
      createdAt: str(row.createdAt, `folders[${i}].createdAt`),
      updatedAt: str(row.updatedAt, `folders[${i}].updatedAt`),
    };
  });

  const textIds = uniqueIds(texts, "texts");
  const projectIds = uniqueIds(projects, "projects");
  const threadIds = uniqueIds(threads, "threads");
  uniqueIds(proposals, "proposals");
  uniqueIds(sourcePassages, "sourcePassages");
  uniqueIds(folders, "folders");

  const sourceIds = new Set<string>();
  const sourceHashes = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) {
      bad(`sources contains duplicate id "${source.id}"`);
    }
    sourceIds.add(source.id);
    if (sourceHashes.has(source.contentHash)) {
      bad(`sources contains duplicate content hash "${source.contentHash}"`);
    }
    sourceHashes.add(source.contentHash);
  }

  const requireParent = (parentId: string | null, parents: Set<string>, where: string) => {
    if (parentId != null && !parents.has(parentId)) {
      bad(`${where} references unknown id "${parentId}"`);
    }
  };

  // Composite identities: these are the actual primary keys the restored
  // database enforces; duplicates here would otherwise be silently dropped
  // or collide mid-restore.
  const contentTextIds = new Set<string>();
  for (const row of textContents) {
    requireParent(row.textId, textIds, `textContents "${row.textId}"`);
    if (contentTextIds.has(row.textId)) {
      bad(`textContents contains duplicate row for text "${row.textId}"`);
    }
    contentTextIds.add(row.textId);
  }
  const versionKeys = new Set<string>();
  for (const row of textVersions) {
    requireParent(row.textId, textIds, `textVersions "${row.textId}"`);
    if (row.versionId != null) {
      const key = `${row.textId}\u0000${row.versionId}`;
      if (versionKeys.has(key)) {
        bad(
          `textVersions contains duplicate version "${row.versionId}" ` +
            `for text "${row.textId}"`,
        );
      }
      versionKeys.add(key);
    }
  }
  const briefProjectIds = new Set<string>();
  for (const row of projectBriefs) {
    requireParent(row.projectId, projectIds, `projectBriefs "${row.projectId}"`);
    if (briefProjectIds.has(row.projectId)) {
      bad(`projectBriefs contains duplicate row for project "${row.projectId}"`);
    }
    briefProjectIds.add(row.projectId);
  }
  const briefThreadIds = new Set<string>();
  for (const row of threadBriefs) {
    requireParent(row.threadId, threadIds, `threadBriefs "${row.threadId}"`);
    if (briefThreadIds.has(row.threadId)) {
      bad(`threadBriefs contains duplicate row for thread "${row.threadId}"`);
    }
    briefThreadIds.add(row.threadId);
  }
  const messageKeys = new Set<string>();
  for (const row of messages) {
    requireParent(row.threadId, threadIds, `messages "${row.threadId}"`);
    const key = `${row.threadId}\u0000${row.idx}`;
    if (messageKeys.has(key)) {
      bad(`messages contains duplicate position ${row.idx} for thread "${row.threadId}"`);
    }
    messageKeys.add(key);
  }
  for (const row of sourcePassages) {
    requireParent(row.sourceId, sourceIds, `sourcePassages "${row.sourceId}"`);
  }
  for (const row of proposals) {
    requireParent(row.documentId, textIds, `proposals "${row.documentId}"`);
  }
  for (const row of texts) {
    requireParent(row.projectId, projectIds, `texts "${row.id}"`);
  }
  for (const row of threads) {
    requireParent(row.projectId, projectIds, `threads "${row.id}"`);
  }
  for (const row of sources) {
    requireParent(row.projectId, projectIds, `sources "${row.id}"`);
  }
  const folderKeys = new Set<string>();
  for (const row of folders) {
    // A project-scoped folder must point at a project in the same dump.
    if (row.scope !== "") {
      requireParent(row.scope, projectIds, `folders "${row.id}"`);
    }
    const key = `${row.scope}\u0000${row.name}`;
    if (folderKeys.has(key)) {
      bad(
        `folders contains duplicate row for scope "${row.scope}" ` +
          `named "${row.name}"`,
      );
    }
    folderKeys.add(key);
  }

  return {
    texts,
    textContents,
    textVersions,
    projects,
    projectBriefs,
    sources,
    sourcePassages,
    proposals,
    threads,
    threadBriefs,
    messages,
    folders,
  };
}

/**
 * Normalize and validate a raw dump. Returns null when its structure cannot
 * be trusted (wrong types, duplicate identities, invalid relationships, or
 * an unsupported content-schema version).
 */
export function normalizeDump(raw: unknown): CanonicalDump | null {
  return normalizeDumpChecked(raw).dump;
}

/** Same as `normalizeDump`, but keeps the reason for user-facing errors. */
export function normalizeDumpChecked(
  raw: unknown,
): { dump: CanonicalDump | null; error: string | null } {
  try {
    return { dump: buildCanonicalDump(raw), error: null };
  } catch (err) {
    return { dump: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Parse and validate a raw backup file. Returns null when not a backup or
 * when its structure cannot be trusted. Validation (including conversion of
 * historical nested message/passage rows) happens before any current data
 * is touched; the returned bundle carries the CANONICAL dump only.
 */
export function parseBackupBundle(raw: string): BackupBundle | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.format !== BACKUP_FORMAT) return null;
    if (typeof parsed.version !== "number" || !Number.isInteger(parsed.version)) {
      return null;
    }
    if (parsed.version < 1 || parsed.version > BACKUP_VERSION) return null;
    if (typeof parsed.exportedAt !== "string") return null;

    const filesRaw = parsed.files ?? {};
    if (typeof filesRaw !== "object" || filesRaw === null || Array.isArray(filesRaw)) {
      return null;
    }
    const files = filesRaw as Record<string, unknown>;
    // Registry files must be arrays — writing e.g. an object there made
    // the corresponding store crash on its next sort.
    for (const name of ["threads.json", "library.json", "projects.json"]) {
      if (name in files && !Array.isArray(files[name])) return null;
    }

    if (parsed.version === 2) {
      const dump = normalizeDump(parsed.db);
      if (!dump) return null;
      return {
        format: BACKUP_FORMAT,
        version: 2,
        exportedAt: parsed.exportedAt,
        files,
        db: dump,
      };
    }

    if (parsed.version === 3) {
      if (parsed.data === undefined || parsed.data === null) return null;
      const dump = normalizeDump(parsed.data);
      if (!dump) return null;
      const prefsRaw = parsed.preferences ?? {};
      if (typeof prefsRaw !== "object" || prefsRaw === null || Array.isArray(prefsRaw)) {
        return null;
      }
      const preferences = prefsRaw as Record<string, unknown>;
      // A backup must never carry a usable credential.
      const config = preferences["config"] as Record<string, unknown> | undefined;
      if (config && typeof config === "object" && !Array.isArray(config) && config.apiKey) {
        return null;
      }
      return {
        format: BACKUP_FORMAT,
        version: 3,
        exportedAt: parsed.exportedAt,
        data: dump,
        preferences,
      };
    }

    return {
      format: BACKUP_FORMAT,
      version: parsed.version,
      exportedAt: parsed.exportedAt,
      files,
    };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// Restore
// ──────────────────────────────────────────────

function recoverySnapshotName(): string {
  return `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
}

/**
 * Write a COMPLETE, validated v3 recovery envelope of the CURRENT dataset
 * (domain dump + credential-free preferences, which include the recovery
 * drafts). The artifact goes through the SAME parser as an imported
 * backup, so it can be restored directly if the restore goes wrong; a
 * snapshot that would not parse ABORTS the restore before anything is
 * replaced.
 */
async function writeRecoverySnapshot(): Promise<void> {
  const envelope = await exportCanonicalBundle(
    new Date().toISOString(),
    (reason) =>
      new Error(
        "The recovery snapshot could not be written: the current dataset " +
          `failed validation (${reason}). The restore was aborted; nothing was changed.`,
      ),
  );
  // Directly importable: the production parser must accept the artifact.
  if (parseBackupBundle(JSON.stringify(envelope)) === null) {
    throw new Error(
      "The recovery snapshot failed backup validation. The restore was " +
        "aborted; nothing was changed.",
    );
  }
  await saveJson(recoverySnapshotName(), envelope);
}

/** v2 bundle settings files → preference rows (credentials stripped). */
function prefRowsFromV2Files(
  files: Record<string, unknown>,
): { key: string; value: string }[] {
  const rows: { key: string; value: string }[] = [];
  for (const name of SETTINGS_FILES) {
    if (!(name in files)) continue;
    const prefKey = name.replace(/\.json$/, "");
    rows.push({ key: prefKey, value: JSON.stringify(withoutSecrets(files[name])) });
  }
  return rows;
}

/**
 * Replace the current data set with the bundle, exclusively: AI operations
 * are settled first, new persistence is blocked, pending saves are
 * drained, a recovery snapshot of the current dataset is written, and the
 * restored dataset commits in one transaction. Returns the real activated
 * counts (documents/projects/conversations), not "file" counts.
 */
export async function restoreBackupBundle(
  bundle: BackupBundle,
  options?: { abortOperations?: () => void },
): Promise<RestoreCounts> {
  const files = bundle.files ?? {};

  if (bundle.version === 2 && !hasTauriFs()) {
    // A v2 bundle carries a SQLite dump plus settings files; the browser
    // cannot apply the legacy database dump. Reject BEFORE changing
    // anything. (v3 dumps ARE portable: the browser consumes the same
    // canonical shape through the JSON backend — B21d.)
    throw new Error(
      "This backup was made by the desktop app and can only be restored there.",
    );
  }

  // Settle active AI operations (a pre-restore completion must not modify
  // the restored dataset).
  options?.abortOperations?.();
  // One EXCLUSIVE maintenance run. The barrier goes up BEFORE any drain,
  // so no ordinary mutation (domain or preference) can cross the restore
  // boundary; the drains themselves are privileged. A failed restore
  // releases held pre-restore work instead of discarding it.
  return runExclusiveMaintenance("discard", async () => {
    beginPreferenceMaintenance();
    let succeeded = false;
    try {
      // Everything pending lands (or is retained visibly) before the swap.
      await privilegedDrain();
      await privilegedPreferenceDrain();

      if (bundle.version === 3) {
        // Recovery snapshot of the CURRENT dataset, written before the swap.
        await writeRecoverySnapshot();
        if (!hasTauriFs()) {
          // B21d: the browser applies the SAME canonical dump through the
          // JSON backend's journal envelope. Every file the new generation
          // does not carry is removed, so an older dump can never leave a
          // newer body behind.
          const counts = await repo.replaceDump(bundle.data);
          await replacePrefsPrivileged(
            Object.entries(bundle.preferences ?? {}).map(([key, value]) => ({
              key,
              value: withoutSecrets(value),
            })),
          );
          repo.resetSessionState();
          bumpDatasetGeneration();
          succeeded = true;
          return counts;
        }
        const prefs = Object.entries(bundle.preferences ?? {}).map(
          ([key, value]) => ({ key, value: JSON.stringify(withoutSecrets(value)) }),
        );
        const counts = await invoke<RestoreCounts>("db_restore", {
          dump: bundle.data,
          prefs,
        });
        // Reset the revision/failure state ONCE, centrally, and notify
        // every mounted generation subscriber.
        repo.resetSessionState();
        bumpDatasetGeneration();
        succeeded = true;
        return counts;
      }

      if (bundle.version === 2) {
        // Recovery snapshot, then one transaction: domain dump + preferences
        // derived from the bundle's settings files. The live JSON files are
        // NOT overwritten to perform the conversion.
        await writeRecoverySnapshot();
        const counts = await invoke<RestoreCounts>("db_restore", {
          dump: bundle.db,
          prefs: prefRowsFromV2Files(files),
        });
        repo.resetSessionState();
        bumpDatasetGeneration();
        succeeded = true;
        return counts;
      }

      // v1 (file bundle): settings become preferences, and the domain
      // files are imported through the validated legacy pipeline. On
      // desktop the files go to a SCRATCH directory (never the live data
      // directory) and the verified import applies them transactionally;
      // a browser session (whose storage IS the JSON files) replaces them.
      let restored = 0;
      for (const [name, data] of Object.entries(files)) {
        if (!SAFE_NAME_RE.test(name)) continue;
        if (
          name === "config.json" ||
          name === "settings.json" ||
          name === "zen-prices.json"
        ) {
          await setPrefPrivileged(name.replace(/\.json$/, ""), withoutSecrets(data));
          continue;
        }
        if (!hasTauriFs()) {
          await saveJson(name, data);
        }
        restored++;
      }
      if (hasTauriFs()) {
        const scratch = `v1-restore-${Date.now()}`;
        try {
          await mkdir(scratch, { baseDir: BaseDirectory.AppData, recursive: true });
          for (const [name, data] of Object.entries(files)) {
            if (!SAFE_NAME_RE.test(name)) continue;
            if (name === "config.json" || name === "settings.json" || name === "zen-prices.json") {
              continue;
            }
            await writeTextFile(`${scratch}/${name}`, JSON.stringify(data), {
              baseDir: BaseDirectory.AppData,
            });
          }
          const report = await invoke<{
            completed: boolean;
            counts: RestoreCounts;
            issues: { path: string; kind: string; detail: string }[];
          }>("db_import_legacy_at", { dir: scratch, clear: true });
          if (!report.completed) {
            throw new Error(
              "The v1 backup could not be converted: " +
                report.issues
                  .map((issue) => `${issue.path} (${issue.kind}): ${issue.detail}`)
                  .join("; "),
            );
          }
          repo.resetSessionState();
          bumpDatasetGeneration();
          succeeded = true;
          return { ...report.counts, files: restored };
        } finally {
          try {
            await remove(scratch, {
              baseDir: BaseDirectory.AppData,
              recursive: true,
            });
          } catch {
            // A leftover scratch directory is harmless.
          }
        }
      }
      repo.resetSessionState();
      bumpDatasetGeneration();
      succeeded = true;
      return {
        texts: 0,
        projects: 0,
        threads: 0,
        messages: 0,
        versions: 0,
        files: restored,
      };
    } finally {
      // Held pre-restore work is discarded ONLY after a successful
      // replacement; a failed restore releases it (recoverable).
      endPreferenceMaintenance(succeeded ? "discard" : "release");
    }
  });
}
