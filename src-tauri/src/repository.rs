//! SQLite-backed repository for all domain data: library texts (+ content,
//! + version history), projects (+ briefs), and chat threads (+ messages,
//! + writing briefs).
//!
//! Design rules:
//! - Every command that touches more than one row runs in one transaction,
//!   so a crash can never leave metadata and content disagreeing.
//! - The frontend owns business logic (derived snippet/word counts,
//!   snapshot decisions, timestamps); this module is deliberately dumb
//!   transactional storage.
//! - Legacy JSON data files are imported once on first `db_init` and moved
//!   into a `legacy/` folder afterwards — the originals stay on disk until
//!   the user deletes them.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

/// Maximum version snapshots kept per text (same cap as the old JSON store).
const MAX_VERSIONS: i64 = 20;

/// Unique, monotonic version identity. Timestamps alone collide when two
/// snapshots land in the same millisecond, so every version row also gets
/// a generated id (nanos + process counter).
fn next_version_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("sv-{nanos:016x}-{n:04x}")
}

/// The SQLite file inside the app data directory.
const DB_FILE: &str = "data.sqlite3";

/// Folder legacy JSON files are moved into after import.
const LEGACY_DIR: &str = "legacy";

// ──────────────────────────────────────────────
// Managed state
// ──────────────────────────────────────────────

/// The open SQLite connection, set once by `db_init`.
pub struct Db(pub Mutex<Option<Connection>>);

impl Default for Db {
    fn default() -> Self {
        Db(Mutex::new(None))
    }
}

fn with_conn<T>(
    db: &State<Db>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let guard = db.0.lock().map_err(|_| "Database lock poisoned")?;
    let conn = guard.as_ref().ok_or("Database not initialized")?;
    f(conn)
}

// ──────────────────────────────────────────────
// Row types (serde camelCase on both sides)
// ──────────────────────────────────────────────

/// Default thread mode for legacy payloads that lack `mode`.
fn default_thread_mode() -> String {
    "text".to_string()
}

/// Legacy payloads may omit `mode` or spell it null; both read as "text".
fn thread_mode_from_json<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<String> = Option::deserialize(d)?;
    Ok(opt.unwrap_or_else(default_thread_mode))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextRow {
    pub id: String,
    pub title: String,
    pub text_type: String,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub snippet: Option<String>,
    #[serde(default)]
    pub word_count: Option<i64>,
    /// Persisted revision counter (optimistic concurrency). Legacy rows default to 0.
    #[serde(default)]
    pub rev: i64,
    /// Navigator organization (D3): pinned sorts first, archived hides
    /// the row from the main lists. Legacy rows/dumps default to false.
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VersionRow {
    pub version_id: String,
    pub saved_at: String,
    pub content: String,
    /// Document format contract (Phase 4.1); legacy rows are markdown.
    #[serde(default)]
    pub content_format: Option<String>,
    #[serde(default)]
    pub content_schema_version: Option<i64>,
    #[serde(default)]
    pub plain_text: Option<String>,
    /// User-given name for an explicit snapshot (v8); save points are unlabeled.
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub default_audience: Option<String>,
    #[serde(default)]
    pub default_tone: Option<String>,
    #[serde(default)]
    pub default_citations: Option<String>,
    #[serde(default)]
    pub default_language: Option<String>,
    /// Wire name `references`; the legacy `refs` spelling stays readable.
    #[serde(rename = "references", alias = "refs", default)]
    pub refs: Option<String>,
    #[serde(default)]
    pub brief_word_count: Option<i64>,
    #[serde(default)]
    pub rev: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRow {
    pub id: String,
    pub title: String,
    /// Defaults to "text" for legacy payloads lacking (or nulling) `mode`.
    #[serde(default = "default_thread_mode", deserialize_with = "thread_mode_from_json")]
    pub mode: String,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Wire name `references`; the legacy `refs` spelling stays readable.
    #[serde(rename = "references", alias = "refs", default)]
    pub refs: Option<String>,
    #[serde(default)]
    pub rev: i64,
    /// Navigator organization (D3); legacy rows/dumps default to false.
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    /// Stable message identity (null for pre-v5 rows; the frontend
    /// migrates by assigning ids on load).
    #[serde(default)]
    pub id: Option<String>,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    pub failed: bool,
    /// Why an assistant reply is incomplete (B16b, schema v12):
    /// "interrupted" | "truncated" | null. The partial content is stored
    /// with its marker instead of being discarded.
    #[serde(default)]
    pub incomplete: Option<String>,
    #[serde(default)]
    pub attachments_json: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThreadData {
    #[serde(default)]
    pub brief_json: Option<String>,
    #[serde(default)]
    pub messages: Vec<MessageRow>,
    #[serde(default)]
    pub rev: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbDump {
    #[serde(default)]
    pub texts: Vec<TextRow>,
    #[serde(default)]
    pub text_contents: Vec<TextContentRow>,
    #[serde(default)]
    pub text_versions: Vec<TextVersionRow>,
    #[serde(default)]
    pub projects: Vec<ProjectRow>,
    #[serde(default)]
    pub project_briefs: Vec<ProjectBriefRow>,
    #[serde(default)]
    pub sources: Vec<SourceRow>,
    #[serde(default)]
    pub source_passages: Vec<StoredSourcePassageRow>,
    #[serde(default)]
    pub proposals: Vec<ProposalRow>,
    #[serde(default)]
    pub threads: Vec<ThreadRow>,
    #[serde(default)]
    pub thread_briefs: Vec<ThreadBriefRow>,
    #[serde(default)]
    pub messages: Vec<StoredMessageRow>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextContentRow {
    pub text_id: String,
    pub content: String,
    /// Document format contract (Phase 4.1); legacy dumps are markdown.
    #[serde(default)]
    pub content_format: Option<String>,
    #[serde(default)]
    pub content_schema_version: Option<i64>,
    #[serde(default)]
    pub plain_text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextVersionRow {
    pub text_id: String,
    /// Legacy dumps may lack it; a fresh id is generated on import.
    #[serde(default)]
    pub version_id: Option<String>,
    pub saved_at: String,
    pub content: String,
    #[serde(default)]
    pub content_format: Option<String>,
    #[serde(default)]
    pub content_schema_version: Option<i64>,
    #[serde(default)]
    pub plain_text: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

/// The versioned document body a frontend sends with create/save (the
/// Phase 4.1 contract). Legacy callers sending a bare string content are
/// handled by the command layer.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextBody {
    pub content: String,
    #[serde(default = "default_content_format")]
    pub content_format: String,
    #[serde(default = "default_content_schema_version")]
    pub content_schema_version: i64,
    #[serde(default)]
    pub plain_text: Option<String>,
}

fn default_content_format() -> String {
    "markdown".to_string()
}

/// Content-schema contract this build can open (mirrors the frontend's
/// `CONTENT_SCHEMA_VERSION`). Imports carrying a newer schema are refused
/// before any row is written.
pub const SUPPORTED_CONTENT_SCHEMA_VERSION: i64 = 1;

fn default_content_schema_version() -> i64 {
    SUPPORTED_CONTENT_SCHEMA_VERSION
}

impl TextBody {
    fn format(&self) -> &str {
        // Unknown formats are not inventable from the frontend; anything
        // but the known set is stored as markdown (preserved verbatim).
        match self.content_format.as_str() {
            "markdown" | "tiptap-json" => self.content_format.as_str(),
            _ => "markdown",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBriefRow {
    pub project_id: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThreadBriefRow {
    pub thread_id: String,
    #[serde(default)]
    pub brief_json: Option<String>,
}

// ── Source model (Phase 5.1) ──

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceRow {
    pub id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub year: Option<String>,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    /// Original language of the material.
    #[serde(default)]
    pub language: Option<String>,
    /// Translation attribution note.
    #[serde(default)]
    pub translation: Option<String>,
    /// Reference to the original asset (file name / origin).
    #[serde(default)]
    pub asset_ref: Option<String>,
    /// Bibliographic type when known (a CSL type).
    #[serde(default)]
    pub source_type: Option<String>,
    /// Container: journal, book, proceedings, or site title.
    #[serde(default)]
    pub container_title: Option<String>,
    /// Publisher / institution / university.
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default)]
    pub volume: Option<String>,
    #[serde(default)]
    pub issue: Option<String>,
    #[serde(default)]
    pub pages: Option<String>,
    /// Abstract, kept separate from notes and translation attribution.
    /// (`abstract` is a Rust keyword, so the column/field is renamed.)
    #[serde(default, rename = "abstract")]
    pub abstract_text: Option<String>,
    /// The original text as provided — preserved verbatim.
    pub original_text: String,
    /// Content identity for deduplication (not the file name).
    pub content_hash: String,
    /// pending | ready | failed | truncated
    #[serde(default = "default_extraction_status")]
    pub extraction_status: String,
    #[serde(default)]
    pub truncation_note: Option<String>,
    /// User-controlled context inclusion.
    #[serde(default = "default_true")]
    pub included_in_context: bool,
    #[serde(default)]
    pub notes: Option<String>,
    /// unverified | retrieved | quote_matched | supports | disputed
    #[serde(default = "default_verification")]
    pub verification: String,
    #[serde(default)]
    pub rev: i64,
    pub created_at: String,
    pub updated_at: String,
}

fn default_extraction_status() -> String {
    "ready".to_string()
}
fn default_verification() -> String {
    "unverified".to_string()
}
fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourcePassageRow {
    pub id: String,
    /// Page or section locator.
    #[serde(default)]
    pub locator: Option<String>,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceData {
    pub source: SourceRow,
    #[serde(default)]
    pub passages: Vec<SourcePassageRow>,
    #[serde(default)]
    pub rev: i64,
}

/// A reviewable AI revision proposal (Phase 5.3).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProposalRow {
    pub id: String,
    pub document_id: String,
    /// Document revision the proposal was made against.
    pub base_rev: i64,
    /// revise | tighten | clarify | comment
    pub request_kind: String,
    /// The ORIGINAL selected fragment (never fuzzy-matched at acceptance).
    pub base_fragment: String,
    pub proposed_fragment: String,
    /// The selection range at proposal time (a locating hint, verified
    /// against the fragment — never trusted alone).
    #[serde(default)]
    pub sel_from: Option<i64>,
    #[serde(default)]
    pub sel_to: Option<i64>,
    #[serde(default)]
    pub context_note: Option<String>,
    /// pending | accepted | rejected | stale
    #[serde(default = "default_proposal_status")]
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

fn default_proposal_status() -> String {
    "pending".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessageRow {
    pub thread_id: String,
    pub idx: i64,
    #[serde(flatten)]
    pub message: MessageRow,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoredSourcePassageRow {
    pub source_id: String,
    #[serde(flatten)]
    pub passage: SourcePassageRow,
}

// ──────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS texts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  text_type TEXT NOT NULL,
  folder TEXT,
  project_id TEXT,
  snippet TEXT,
  word_count INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS text_contents (
  text_id TEXT PRIMARY KEY REFERENCES texts(id) ON DELETE CASCADE,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS text_versions (
  text_id TEXT NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
  saved_at TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (text_id, saved_at)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  default_audience TEXT,
  default_tone TEXT,
  default_citations TEXT,
  default_language TEXT,
  refs TEXT,
  brief_word_count INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_briefs (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'text',
  project_id TEXT,
  refs TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_data (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  brief_json TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  failed INTEGER NOT NULL DEFAULT 0,
  attachments_json TEXT,
  PRIMARY KEY (thread_id, idx)
);
";

/// Schema the current build supports. Databases created by a NEWER version
/// are refused rather than misread.
pub const SUPPORTED_SCHEMA_VERSION: i64 = 14;

/// v13: bibliography metadata on sources (B18): type, container, publisher,
/// volume/issue/pages, and abstract, each nullable so legacy rows and older
/// dumps default to absent. Applied by `migrate_v13` (column-guarded).
///
/// v12: incomplete-response marker on messages (B16b). A partial assistant
/// reply stores WHY it is partial ("interrupted" | "truncated") beside its
/// content, so the UI can mark it and no incomplete proposal can be derived
/// from it. Applied by `migrate_v12` (column-guarded, repairable).
///
/// v11: pin/archive states (Phase 3 deferred note, D3). Applied by
/// `migrate_v11` (column-guarded, repairable).

/// v10: reviewable AI revision proposals (Phase 5.3). A proposal records
/// the document id + base revision, the ORIGINAL selected fragment (and
/// its selection range), the proposed replacement, and a status
/// (pending | accepted | rejected | stale). Nothing is applied
/// automatically; acceptance is a separate act.
const SCHEMA_V10: &str = "
CREATE TABLE IF NOT EXISTS document_proposals (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  base_rev INTEGER NOT NULL,
  request_kind TEXT NOT NULL,
  base_fragment TEXT NOT NULL,
  proposed_fragment TEXT NOT NULL,
  sel_from INTEGER,
  sel_to INTEGER,
  context_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
";

/// v9: the source model (Phase 5.1). Versioned source records (dedup by
/// content identity) + extracted passages with locators. The original
/// text is preserved verbatim on the source row; verification status and
/// user-controlled context inclusion are explicit columns.
const SCHEMA_V9: &str = "
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  author TEXT,
  year TEXT,
  doi TEXT,
  url TEXT,
  language TEXT,
  translation TEXT,
  asset_ref TEXT,
  original_text TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  extraction_status TEXT NOT NULL DEFAULT 'ready',
  truncation_note TEXT,
  included_in_context INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  verification TEXT NOT NULL DEFAULT 'unverified',
  rev INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_passages (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  locator TEXT,
  content TEXT NOT NULL
);
";

/// v8: named snapshots. A user-created version row can carry a label.
/// Applied by `migrate_v8` (column-guarded).
/// v7: document format fields + plain-text projection. Applied by
/// `migrate_v7` (column-guarded, idempotent backfill).

/// v6: full-text search. An FTS5 index over document bodies, message
/// bodies, and project briefs, kept in sync by TRIGGERS — every index
/// update commits inside the same transaction as the write that caused
/// it. Existing rows are backfilled during the migration.
const SCHEMA_V6: &str = "
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  kind,
  doc_id,
  body,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS search_texts_ai AFTER INSERT ON text_contents BEGIN
  INSERT INTO search_index (kind, doc_id, body) VALUES ('text', NEW.text_id, NEW.content);
END;
CREATE TRIGGER IF NOT EXISTS search_texts_au AFTER UPDATE OF content ON text_contents BEGIN
  DELETE FROM search_index WHERE kind = 'text' AND doc_id = NEW.text_id;
  INSERT INTO search_index (kind, doc_id, body) VALUES ('text', NEW.text_id, NEW.content);
END;
CREATE TRIGGER IF NOT EXISTS search_texts_ad AFTER DELETE ON text_contents BEGIN
  DELETE FROM search_index WHERE kind = 'text' AND doc_id = OLD.text_id;
END;

CREATE TRIGGER IF NOT EXISTS search_briefs_ai AFTER INSERT ON project_briefs BEGIN
  INSERT INTO search_index (kind, doc_id, body) VALUES ('project', NEW.project_id, NEW.content);
END;
CREATE TRIGGER IF NOT EXISTS search_briefs_au AFTER UPDATE OF content ON project_briefs BEGIN
  DELETE FROM search_index WHERE kind = 'project' AND doc_id = NEW.project_id;
  INSERT INTO search_index (kind, doc_id, body) VALUES ('project', NEW.project_id, NEW.content);
END;
CREATE TRIGGER IF NOT EXISTS search_briefs_ad AFTER DELETE ON project_briefs BEGIN
  DELETE FROM search_index WHERE kind = 'project' AND doc_id = OLD.project_id;
END;

CREATE TRIGGER IF NOT EXISTS search_messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO search_index (kind, doc_id, body) VALUES ('thread', NEW.thread_id, NEW.content);
END;
CREATE TRIGGER IF NOT EXISTS search_messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM search_index WHERE kind = 'thread' AND doc_id = OLD.thread_id;
END;
";

/// v14: message replacement must move the FTS entry. v6 never created a
/// `search_messages_au` trigger, so `thread_replace_message` UPDATEs left
/// the OLD text searchable and the NEW text unsearchable; the v6 delete
/// trigger was also over-broad (it removed every message row of the
/// thread). The index has no message identity, so both triggers match the
/// affected row by its stored body (equality on the stored text; rows
/// with identical bodies are interchangeable for search). `migrate_v14`
/// replaces the triggers and re-indexes every message row, repairing
/// indexes left stale by either bug.
const SCHEMA_V14: &str = "
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  kind,
  doc_id,
  body,
  tokenize = 'unicode61'
);
DROP TRIGGER IF EXISTS search_messages_ai;
DROP TRIGGER IF EXISTS search_messages_au;
DROP TRIGGER IF EXISTS search_messages_ad;
CREATE TRIGGER search_messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO search_index (kind, doc_id, body) VALUES ('thread', NEW.thread_id, NEW.content);
END;
CREATE TRIGGER search_messages_au AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM search_index WHERE kind = 'thread' AND doc_id = OLD.thread_id AND body = OLD.content;
  INSERT INTO search_index (kind, doc_id, body) VALUES ('thread', NEW.thread_id, NEW.content);
END;
CREATE TRIGGER search_messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM search_index WHERE kind = 'thread' AND doc_id = OLD.thread_id AND body = OLD.content;
END;
";

/// v5: stable message identity. Message rows carry an `msg_id` assigned by
/// the frontend (or generated for legacy imports) so operations can target
/// a message reliably across sessions; order and content never change.
const SCHEMA_V5: &str = "
ALTER TABLE messages ADD COLUMN msg_id TEXT;
";

/// v4: dedicated preferences table. Non-secret configuration lives in the
/// database so a backup restore commits domain data and preferences
/// together; credentials stay in the OS keychain.
const SCHEMA_V4: &str = "
CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
";

/// v3: stable version identity (rebuilt by `migrate_v3`, repairable from
/// every crash point).

/// True when the table exists.
fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count > 0)
}

/// Run ONE migration step and its version advancement in ONE transaction:
/// a crash mid-step leaves the previous version intact (the step is
/// re-runnable) instead of stranding a half-migrated database.
fn apply_migration(
    conn: &Connection,
    to_version: i64,
    step: impl FnOnce(&Connection) -> Result<(), String>,
) -> Result<(), String> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if current >= to_version {
        return Ok(());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    step(&tx)?;
    tx.pragma_update(None, "user_version", to_version)
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// v3, REPAIRABLE: the old table may already be renamed (a crash between
/// the rename and the rebuild) or already copied (a crash before the
/// version bump). Every intermediate state becomes the finished schema.
fn migrate_v3(conn: &Connection) -> Result<(), String> {
    if column_exists(conn, "text_versions", "version_id")? {
        // Fully migrated; drop any leftover staging table.
        conn.execute_batch("DROP TABLE IF EXISTS text_versions_old")
            .map_err(|e| format!("Failed to clean up the version repair: {e}"))?;
        return Ok(());
    }
    if !table_exists(conn, "text_versions_old")? {
        conn.execute_batch("ALTER TABLE text_versions RENAME TO text_versions_old")
            .map_err(|e| format!("Failed to migrate version history: {e}"))?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS text_versions (
           text_id TEXT NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
           version_id TEXT NOT NULL,
           saved_at TEXT NOT NULL,
           content TEXT NOT NULL,
           PRIMARY KEY (text_id, version_id)
         );",
    )
    .map_err(|e| format!("Failed to rebuild version history: {e}"))?;
    conn.execute_batch(
        "INSERT OR IGNORE INTO text_versions (text_id, version_id, saved_at, content)
           SELECT text_id, 'legacy-' || rowid, saved_at, content FROM text_versions_old;
         DROP TABLE text_versions_old;",
    )
    .map_err(|e| format!("Failed to copy version history: {e}"))?;
    Ok(())
}

/// v2, REPAIRABLE: each revision column is added only when missing.
fn migrate_v2(conn: &Connection) -> Result<(), String> {
    for table in ["texts", "projects", "threads"] {
        if !column_exists(conn, table, "rev")? {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN rev INTEGER NOT NULL DEFAULT 0"),
                [],
            )
            .map_err(|e| format!("Failed to add rev column to {table}: {e}"))?;
        }
    }
    Ok(())
}

/// v5, REPAIRABLE: the message-id column is added only when missing.
fn migrate_v5(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "messages", "msg_id")? {
        conn.execute_batch(SCHEMA_V5)
            .map_err(|e| format!("Failed to add message ids: {e}"))?;
    }
    Ok(())
}

/// v6, REPAIRABLE: the index is rebuilt from scratch, so a partial
/// backfill can never duplicate entries.
fn migrate_v6(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA_V6)
        .map_err(|e| format!("Failed to create the search index: {e}"))?;
    conn.execute_batch(
        "DELETE FROM search_index;
         INSERT INTO search_index (kind, doc_id, body)
         SELECT 'text', text_id, content FROM text_contents;
         INSERT INTO search_index (kind, doc_id, body)
         SELECT 'project', project_id, content FROM project_briefs;
         INSERT INTO search_index (kind, doc_id, body)
         SELECT 'thread', thread_id, content FROM messages;",
    )
    .map_err(|e| format!("Failed to backfill the search index: {e}"))?;
    Ok(())
}

/// v7, REPAIRABLE: every column is added only when missing and the
/// plain-text backfill only touches rows that lack it.
fn migrate_v7(conn: &Connection) -> Result<(), String> {
    let content_columns = [
        ("text_contents", "content_format", "TEXT NOT NULL DEFAULT 'markdown'"),
        ("text_contents", "content_schema_version", "INTEGER NOT NULL DEFAULT 1"),
        ("text_contents", "plain_text", "TEXT"),
        ("text_versions", "content_format", "TEXT NOT NULL DEFAULT 'markdown'"),
        ("text_versions", "content_schema_version", "INTEGER NOT NULL DEFAULT 1"),
        ("text_versions", "plain_text", "TEXT"),
    ];
    for (table, column, decl) in content_columns {
        if !column_exists(conn, table, column)? {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
                [],
            )
            .map_err(|e| format!("Failed to add {column} to {table}: {e}"))?;
        }
    }
    conn.execute_batch(
        "DROP TRIGGER IF EXISTS search_texts_ai;
         DROP TRIGGER IF EXISTS search_texts_au;
         DROP TRIGGER IF EXISTS search_texts_ad;
         CREATE TRIGGER IF NOT EXISTS search_texts_ai AFTER INSERT ON text_contents BEGIN
           INSERT INTO search_index (kind, doc_id, body) VALUES ('text', NEW.text_id, COALESCE(NEW.plain_text, NEW.content));
         END;
         CREATE TRIGGER IF NOT EXISTS search_texts_au AFTER UPDATE OF content ON text_contents BEGIN
           DELETE FROM search_index WHERE kind = 'text' AND doc_id = NEW.text_id;
           INSERT INTO search_index (kind, doc_id, body) VALUES ('text', NEW.text_id, COALESCE(NEW.plain_text, NEW.content));
         END;
         CREATE TRIGGER IF NOT EXISTS search_texts_ad AFTER DELETE ON text_contents BEGIN
           DELETE FROM search_index WHERE kind = 'text' AND doc_id = OLD.text_id;
         END;
         UPDATE text_contents SET plain_text = content WHERE plain_text IS NULL;
         UPDATE text_versions SET plain_text = content WHERE plain_text IS NULL;",
    )
    .map_err(|e| format!("Failed to add the document format fields: {e}"))?;
    Ok(())
}

/// v8, REPAIRABLE: the label column is added only when missing.
fn migrate_v8(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "text_versions", "label")? {
        conn.execute_batch("ALTER TABLE text_versions ADD COLUMN label TEXT;")
            .map_err(|e| format!("Failed to add snapshot labels: {e}"))?;
    }
    Ok(())
}

/// v11, REPAIRABLE: each pin/archive column is added only when missing.
fn migrate_v11(conn: &Connection) -> Result<(), String> {
    for (table, column) in [
        ("texts", "archived"),
        ("texts", "pinned"),
        ("threads", "archived"),
        ("threads", "pinned"),
    ] {
        if !column_exists(conn, table, column)? {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"),
                [],
            )
            .map_err(|e| format!("Failed to add {column} to {table}: {e}"))?;
        }
    }
    Ok(())
}

/// v14, REPAIRABLE: replace the message triggers and re-derive the
/// message portion of the index from the messages table. The re-index is
/// idempotent (delete + insert), and the whole step runs in one
/// transaction with its version bump, so a crash resumes cleanly.
fn migrate_v14(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA_V14)
        .map_err(|e| format!("Failed to repair the message search triggers: {e}"))?;
    conn.execute_batch(
        "DELETE FROM search_index WHERE kind = 'thread';
         INSERT INTO search_index (kind, doc_id, body)
         SELECT 'thread', thread_id, content FROM messages;",
    )
    .map_err(|e| format!("Failed to re-index messages: {e}"))?;
    Ok(())
}

/// v12, REPAIRABLE: the incomplete marker column is added only when missing.
fn migrate_v12(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "messages", "incomplete")? {
        conn.execute_batch("ALTER TABLE messages ADD COLUMN incomplete TEXT;")
            .map_err(|e| format!("Failed to add the incomplete marker: {e}"))?;
    }
    Ok(())
}

/// v13, REPAIRABLE: every bibliography metadata column is added only when
/// missing, so a crash mid-migration leaves a re-runnable database.
fn migrate_v13(conn: &Connection) -> Result<(), String> {
    for (column, decl) in [
        ("source_type", "TEXT"),
        ("container_title", "TEXT"),
        ("publisher", "TEXT"),
        ("volume", "TEXT"),
        ("issue", "TEXT"),
        ("pages", "TEXT"),
        ("abstract_text", "TEXT"),
    ] {
        if !column_exists(conn, "sources", column)? {
            conn.execute(
                &format!("ALTER TABLE sources ADD COLUMN {column} {decl}"),
                [],
            )
            .map_err(|e| format!("Failed to add {column} to sources: {e}"))?;
        }
    }
    Ok(())
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if version > SUPPORTED_SCHEMA_VERSION {
        return Err(format!(
            "The database was written by a newer version of this app (schema v{version}, \
             this build supports up to v{SUPPORTED_SCHEMA_VERSION}). Not opening it."
        ));
    }
    apply_migration(conn, 1, |tx| {
        tx.execute_batch(SCHEMA)
            .map_err(|e| format!("Failed to create schema: {e}"))
    })?;
    apply_migration(conn, 2, migrate_v2)?;
    apply_migration(conn, 3, migrate_v3)?;
    apply_migration(conn, 4, |tx| {
        tx.execute_batch(SCHEMA_V4)
            .map_err(|e| format!("Failed to create preferences table: {e}"))
    })?;
    apply_migration(conn, 5, migrate_v5)?;
    apply_migration(conn, 6, migrate_v6)?;
    apply_migration(conn, 7, migrate_v7)?;
    apply_migration(conn, 8, migrate_v8)?;
    apply_migration(conn, 9, |tx| {
        tx.execute_batch(SCHEMA_V9)
            .map_err(|e| format!("Failed to create the source tables: {e}"))
    })?;
    apply_migration(conn, 10, |tx| {
        tx.execute_batch(SCHEMA_V10)
            .map_err(|e| format!("Failed to create the proposals table: {e}"))
    })?;
    apply_migration(conn, 11, migrate_v11)?;
    apply_migration(conn, 12, migrate_v12)?;
    apply_migration(conn, 13, migrate_v13)?;
    apply_migration(conn, 14, migrate_v14)?;
    Ok(())
}

/// True when the table already has the given column.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let found = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .any(|name| name.map(|n| n == column).unwrap_or(false));
    Ok(found)
}

fn open_connection(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("Cannot open database: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    // Durability first: a acknowledged save must survive a crash.
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ──────────────────────────────────────────────
// Meta helpers
// ──────────────────────────────────────────────

fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM app_meta WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Keep only the newest MAX_VERSIONS snapshots per text.
fn enforce_version_cap(conn: &Connection, text_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM text_versions
         WHERE text_id = ?1 AND version_id NOT IN (
           SELECT version_id FROM text_versions WHERE text_id = ?1
           ORDER BY saved_at DESC LIMIT ?2
         )",
        params![text_id, MAX_VERSIONS],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ──────────────────────────────────────────────
// Row mapping
// ──────────────────────────────────────────────

fn row_to_text(r: &rusqlite::Row) -> rusqlite::Result<TextRow> {
    Ok(TextRow {
        id: r.get("id")?,
        title: r.get("title")?,
        text_type: r.get("text_type")?,
        folder: r.get("folder")?,
        project_id: r.get("project_id")?,
        snippet: r.get("snippet")?,
        word_count: r.get("word_count")?,
        rev: r.get("rev")?,
        archived: r.get::<_, i64>("archived")? != 0,
        pinned: r.get::<_, i64>("pinned")? != 0,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

fn row_to_project(r: &rusqlite::Row) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        id: r.get("id")?,
        title: r.get("title")?,
        description: r.get("description")?,
        default_audience: r.get("default_audience")?,
        default_tone: r.get("default_tone")?,
        default_citations: r.get("default_citations")?,
        default_language: r.get("default_language")?,
        refs: r.get("refs")?,
        brief_word_count: r.get("brief_word_count")?,
        rev: r.get("rev")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

fn row_to_thread(r: &rusqlite::Row) -> rusqlite::Result<ThreadRow> {
    Ok(ThreadRow {
        id: r.get("id")?,
        title: r.get("title")?,
        mode: r.get("mode")?,
        project_id: r.get("project_id")?,
        refs: r.get("refs")?,
        rev: r.get("rev")?,
        archived: r.get::<_, i64>("archived")? != 0,
        pinned: r.get::<_, i64>("pinned")? != 0,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

fn row_to_message(r: &rusqlite::Row) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        id: r.get("msg_id")?,
        role: r.get("role")?,
        content: r.get("content")?,
        timestamp: r.get("timestamp")?,
        failed: r.get::<_, i64>("failed")? != 0,
        incomplete: r.get("incomplete")?,
        attachments_json: r.get("attachments_json")?,
    })
}

/// Reject stale updates: when the caller based its edit on an older
/// revision, refuse instead of silently overwriting newer data.
fn check_expected_rev(expected: Option<i64>, current: i64) -> Result<(), String> {
    if let Some(expected) = expected {
        if expected != current {
            return Err(format!(
                "Stale revision: expected {expected}, current {current}"
            ));
        }
    }
    Ok(())
}

/// B21c: resolve a child's project link against the live project index.
/// A stale client can still hold a link to a project someone deleted; a
/// persisted link must point at an existing project or be absent, so the
/// save keeps its content but drops the dead association. Runs inside the
/// caller's transaction, so a concurrent project delete cannot interleave.
fn live_project_id(tx: &Connection, candidate: Option<&str>) -> Result<Option<String>, String> {
    let Some(id) = candidate else {
        return Ok(None);
    };
    let exists: Option<i64> = tx
        .query_row("SELECT 1 FROM projects WHERE id = ?1", params![id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(if exists.is_some() {
        Some(id.to_string())
    } else {
        None
    })
}

// ──────────────────────────────────────────────
// Core operations (testable, connection-based)
// ──────────────────────────────────────────────

fn texts_list(conn: &Connection) -> Result<Vec<TextRow>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM texts ORDER BY updated_at DESC, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_text)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// INSERT a text row with its revision. Used by creation and imports.
fn text_insert(conn: &Connection, meta: &TextRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO texts (id, title, text_type, folder, project_id, snippet, word_count, rev, archived, pinned, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            meta.id,
            meta.title,
            meta.text_type,
            meta.folder,
            meta.project_id,
            meta.snippet,
            meta.word_count,
            meta.rev,
            meta.archived,
            meta.pinned,
            meta.created_at,
            meta.updated_at
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE constraint failed") {
            format!("Text already exists: {}", meta.id)
        } else {
            e.to_string()
        }
    })?;
    Ok(())
}

/// Upsert a text row preserving its given revision (import path only).
fn text_upsert_meta(conn: &Connection, meta: &TextRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO texts (id, title, text_type, folder, project_id, snippet, word_count, rev, archived, pinned, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           text_type = excluded.text_type,
           folder = excluded.folder,
           project_id = excluded.project_id,
           snippet = excluded.snippet,
           word_count = excluded.word_count,
           rev = excluded.rev,
           archived = excluded.archived,
           pinned = excluded.pinned,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at",
        params![
            meta.id,
            meta.title,
            meta.text_type,
            meta.folder,
            meta.project_id,
            meta.snippet,
            meta.word_count,
            meta.rev,
            meta.archived,
            meta.pinned,
            meta.created_at,
            meta.updated_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Create a text: INSERT-only. Creating an id that already exists fails.
fn text_create(conn: &Connection, meta: &TextRow, body: &TextBody) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // B21c: a create must not persist a dangling project link.
    let mut stored = meta.clone();
    stored.project_id = live_project_id(&tx, meta.project_id.as_deref())?;
    text_insert(&tx, &stored)?;
    tx.execute(
        "INSERT INTO text_contents (text_id, content, content_format, content_schema_version, plain_text)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(text_id) DO UPDATE SET
           content = excluded.content,
           content_format = excluded.content_format,
           content_schema_version = excluded.content_schema_version,
           plain_text = excluded.plain_text",
        params![
            meta.id,
            body.content,
            body.format(),
            body.content_schema_version,
            body.plain_text
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// The format fields read alongside a body column set.
struct BodyFields {
    content: String,
    content_format: Option<String>,
    content_schema_version: Option<i64>,
    plain_text: Option<String>,
}

/// Domain save of a text: metadata (+ optional content) in one transaction.
/// Update-only: a deleted text is never recreated. When `expected_rev` is
/// given and differs from the persisted revision, the save is rejected.
/// The snapshot decision is made HERE by comparing the persisted content
/// with the new content — the frontend cannot lose history by passing the
/// wrong flag. Returns the new revision.
fn text_save(
    conn: &Connection,
    id: &str,
    meta: &TextRow,
    body: Option<&TextBody>,
    expected_rev: Option<i64>,
) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let current_rev: Option<i64> = tx
        .query_row("SELECT rev FROM texts WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let current_rev = current_rev.ok_or_else(|| format!("Text not found: {id}"))?;
    check_expected_rev(expected_rev, current_rev)?;
    let new_rev = current_rev + 1;
    if let Some(body) = body {
        // Snapshot the persisted content being replaced — only when it
        // actually differs — inside this transaction. The snapshot keeps
        // the replaced body's format fields (R3 + the 4.1 contract).
        let old: Option<BodyFields> = tx
            .query_row(
                "SELECT content, content_format, content_schema_version, plain_text
                 FROM text_contents WHERE text_id = ?1",
                params![id],
                |r| {
                    Ok(BodyFields {
                        content: r.get(0)?,
                        content_format: r.get(1)?,
                        content_schema_version: r.get(2)?,
                        plain_text: r.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(old) = old {
            if old.content != body.content {
                tx.execute(
                    "INSERT INTO text_versions (text_id, version_id, saved_at, content,
                                               content_format, content_schema_version, plain_text)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        id,
                        next_version_id(),
                        meta.updated_at,
                        old.content,
                        old.content_format,
                        old.content_schema_version,
                        old.plain_text
                    ],
                )
                .map_err(|e| e.to_string())?;
                enforce_version_cap(&tx, id)?;
            }
        }
        tx.execute(
            "INSERT INTO text_contents (text_id, content, content_format, content_schema_version, plain_text)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(text_id) DO UPDATE SET
               content = excluded.content,
               content_format = excluded.content_format,
               content_schema_version = excluded.content_schema_version,
               plain_text = excluded.plain_text",
            params![
                id,
                body.content,
                body.format(),
                body.content_schema_version,
                body.plain_text
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    let project_id = live_project_id(&tx, meta.project_id.as_deref())?;
    tx.execute(
        "UPDATE texts SET title = ?2, text_type = ?3, folder = ?4, project_id = ?5,
                snippet = ?6, word_count = ?7, updated_at = ?8, rev = ?9
         WHERE id = ?1",
        params![
            id,
            meta.title,
            meta.text_type,
            meta.folder,
            project_id,
            meta.snippet,
            meta.word_count,
            meta.updated_at,
            new_rev
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_rev)
}

fn text_content(conn: &Connection, id: &str) -> Result<Option<TextContentRow>, String> {
    conn.query_row(
        "SELECT text_id, content, content_format, content_schema_version, plain_text
         FROM text_contents WHERE text_id = ?1",
        params![id],
        |r| {
            Ok(TextContentRow {
                text_id: r.get(0)?,
                content: r.get(1)?,
                content_format: r.get(2)?,
                content_schema_version: r.get(3)?,
                plain_text: r.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn text_versions(conn: &Connection, id: &str) -> Result<Vec<VersionRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT version_id, saved_at, content, content_format, content_schema_version,
                    plain_text, label
             FROM text_versions
             WHERE text_id = ?1 ORDER BY saved_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![id], |r| {
            Ok(VersionRow {
                version_id: r.get(0)?,
                saved_at: r.get(1)?,
                content: r.get(2)?,
                content_format: r.get(3)?,
                content_schema_version: r.get(4)?,
                plain_text: r.get(5)?,
                label: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// What a restore produced, so the frontend cache/meta can be refreshed
/// from authoritative data (the content is resolved inside Rust).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub rev: i64,
    /// Snapshot time of the restored version (unchanged from history).
    pub saved_at: String,
    pub content: String,
    /// Document format contract (Phase 4.1); legacy versions are markdown.
    pub content_format: Option<String>,
    pub content_schema_version: Option<i64>,
    pub plain_text: Option<String>,
    pub snippet: String,
    pub word_count: i64,
    /// The updated_at written to the metadata row.
    pub updated_at: String,
}

/// Derived snippet (first ~180 chars, whitespace-collapsed).
fn derive_snippet(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(180)
        .collect()
}

/// Snippet + word count come from the plain-text projection when the body
/// carries one (structured formats); markdown bodies are their own text.
fn derive_snippet_words(
    content: &str,
    plain_text: Option<&str>,
) -> (String, i64) {
    let text = plain_text.unwrap_or(content);
    let snippet = derive_snippet(text);
    let word_count = text.split_whitespace().count() as i64;
    (snippet, word_count)
}

/// Restore a version atomically, resolving the target content INSIDE Rust
/// from the selected `version_id` — the frontend never supplies restore
/// content. The replaced current content is snapshotted (when different)
/// and everything commits in one transaction. Restoring requires the row
/// to still be at `expected_rev` when given. Returns what was restored.
fn text_restore(
    conn: &Connection,
    id: &str,
    version_id: &str,
    now: &str,
    expected_rev: Option<i64>,
) -> Result<RestoreResult, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let current_rev: Option<i64> = tx
        .query_row("SELECT rev FROM texts WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let current_rev = current_rev.ok_or_else(|| format!("Text not found: {id}"))?;
    check_expected_rev(expected_rev, current_rev)?;

    let (target_saved_at, target): (String, BodyFields) = tx
        .query_row(
            "SELECT saved_at, content, content_format, content_schema_version, plain_text
             FROM text_versions
             WHERE text_id = ?1 AND version_id = ?2",
            params![id, version_id],
            |r| {
                Ok((
                    r.get(0)?,
                    BodyFields {
                        content: r.get(1)?,
                        content_format: r.get(2)?,
                        content_schema_version: r.get(3)?,
                        plain_text: r.get(4)?,
                    },
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Version not found: {version_id}"))?;

    let current: Option<BodyFields> = tx
        .query_row(
            "SELECT content, content_format, content_schema_version, plain_text
             FROM text_contents WHERE text_id = ?1",
            params![id],
            |r| {
                Ok(BodyFields {
                    content: r.get(0)?,
                    content_format: r.get(1)?,
                    content_schema_version: r.get(2)?,
                    plain_text: r.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(current) = current {
        if current.content != target.content {
            tx.execute(
                "INSERT INTO text_versions (text_id, version_id, saved_at, content,
                                            content_format, content_schema_version, plain_text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    next_version_id(),
                    now,
                    current.content,
                    current.content_format,
                    current.content_schema_version,
                    current.plain_text
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "INSERT INTO text_contents (text_id, content, content_format, content_schema_version, plain_text)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(text_id) DO UPDATE SET
           content = excluded.content,
           content_format = excluded.content_format,
           content_schema_version = excluded.content_schema_version,
           plain_text = excluded.plain_text",
        params![
            id,
            target.content,
            target.content_format,
            target.content_schema_version,
            target.plain_text
        ],
    )
    .map_err(|e| e.to_string())?;

    let (snippet, word_count) = derive_snippet_words(&target.content, target.plain_text.as_deref());
    tx.execute(
        "UPDATE texts SET snippet = ?2, word_count = ?3, updated_at = ?4, rev = ?5
         WHERE id = ?1",
        params![id, snippet, word_count, now, current_rev + 1],
    )
    .map_err(|e| e.to_string())?;
    enforce_version_cap(&tx, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(RestoreResult {
        rev: current_rev + 1,
        saved_at: target_saved_at,
        content: target.content,
        content_format: target.content_format,
        content_schema_version: target.content_schema_version,
        plain_text: target.plain_text,
        snippet,
        word_count,
        updated_at: now.to_string(),
    })
}

fn text_delete(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM texts WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Take a NAMED snapshot of the current content (v8). The snapshot is an
/// additional version row labeled by the user; it does not change the
/// live body and does not bump the revision (no content/metadata write,
/// so pending scheduled saves stay valid). Applies the version cap.
fn text_snapshot(conn: &Connection, id: &str, label: &str, now: &str) -> Result<String, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let exists: Option<i64> = tx
        .query_row("SELECT rev FROM texts WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if exists.is_none() {
        return Err(format!("Text not found: {id}"));
    }
    let body: Option<BodyFields> = tx
        .query_row(
            "SELECT content, content_format, content_schema_version, plain_text
             FROM text_contents WHERE text_id = ?1",
            params![id],
            |r| {
                Ok(BodyFields {
                    content: r.get(0)?,
                    content_format: r.get(1)?,
                    content_schema_version: r.get(2)?,
                    plain_text: r.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let body = body.ok_or_else(|| format!("Text has no content: {id}"))?;
    let version_id = next_version_id();
    tx.execute(
        "INSERT INTO text_versions (text_id, version_id, saved_at, content,
                                    content_format, content_schema_version, plain_text, label)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            version_id,
            now,
            body.content,
            body.content_format,
            body.content_schema_version,
            body.plain_text,
            label
        ],
    )
    .map_err(|e| e.to_string())?;
    enforce_version_cap(&tx, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(version_id)
}

// ──────────────────────────────────────────────
// Sources (Phase 5.1)
// ──────────────────────────────────────────────

fn sources_list(conn: &Connection) -> Result<Vec<SourceRow>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM sources ORDER BY updated_at DESC, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_source)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn row_to_source(r: &rusqlite::Row) -> rusqlite::Result<SourceRow> {
    Ok(SourceRow {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        title: r.get("title")?,
        author: r.get("author")?,
        year: r.get("year")?,
        doi: r.get("doi")?,
        url: r.get("url")?,
        language: r.get("language")?,
        translation: r.get("translation")?,
        asset_ref: r.get("asset_ref")?,
        source_type: r.get("source_type")?,
        container_title: r.get("container_title")?,
        publisher: r.get("publisher")?,
        volume: r.get("volume")?,
        issue: r.get("issue")?,
        pages: r.get("pages")?,
        abstract_text: r.get("abstract_text")?,
        original_text: r.get("original_text")?,
        content_hash: r.get("content_hash")?,
        extraction_status: r.get("extraction_status")?,
        truncation_note: r.get("truncation_note")?,
        included_in_context: r.get::<_, i64>("included_in_context")? != 0,
        notes: r.get("notes")?,
        verification: r.get("verification")?,
        rev: r.get("rev")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

fn source_passages(conn: &Connection, source_id: &str) -> Result<Vec<SourcePassageRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, locator, content FROM source_passages
             WHERE source_id = ?1 ORDER BY idx",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![source_id], |r| {
            Ok(SourcePassageRow {
                id: r.get(0)?,
                locator: r.get(1)?,
                content: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn source_get(conn: &Connection, id: &str) -> Result<Option<SourceData>, String> {
    let source: Option<SourceRow> = conn
        .query_row("SELECT * FROM sources WHERE id = ?1", params![id], row_to_source)
        .optional()
        .map_err(|e| e.to_string())?;
    match source {
        None => Ok(None),
        Some(source) => {
            let passages = source_passages(conn, id)?;
            Ok(Some(SourceData {
                rev: source.rev,
                source,
                passages,
            }))
        }
    }
}

/// Create a source (INSERT-only). The content hash is UNIQUE: adding
/// identical content twice fails with a clear message — deduplication is
/// content identity, never the file name.
fn source_create(
    conn: &Connection,
    source: &SourceRow,
    passages: &[SourcePassageRow],
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // B21c: extraction is async on the frontend; the user may have deleted
    // the project while the file was being read. Never create a dangling
    // link (a dangling row would make the export validator reject the
    // whole dataset).
    let project_id = live_project_id(&tx, source.project_id.as_deref())?;
    tx.execute(
        "INSERT INTO sources (id, project_id, title, author, year, doi, url, language,
                              translation, asset_ref, original_text, content_hash,
                              extraction_status, truncation_note, included_in_context,
                              notes, verification, rev, created_at, updated_at,
                              source_type, container_title, publisher, volume, issue,
                              pages, abstract_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                 ?21, ?22, ?23, ?24, ?25, ?26, ?27)",
        params![
            source.id,
            project_id,
            source.title,
            source.author,
            source.year,
            source.doi,
            source.url,
            source.language,
            source.translation,
            source.asset_ref,
            source.original_text,
            source.content_hash,
            source.extraction_status,
            source.truncation_note,
            source.included_in_context,
            source.notes,
            source.verification,
            source.rev,
            source.created_at,
            source.updated_at,
            source.source_type,
            source.container_title,
            source.publisher,
            source.volume,
            source.issue,
            source.pages,
            source.abstract_text
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE constraint failed") {
            format!("A source with identical content already exists ({})", source.title)
        } else {
            e.to_string()
        }
    })?;
    for (idx, passage) in passages.iter().enumerate() {
        tx.execute(
            "INSERT INTO source_passages (id, source_id, idx, locator, content)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![passage.id, source.id, idx as i64, passage.locator, passage.content],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Domain save of a source: row + passages in one transaction. Update-only;
/// revision-checked. Passages are replaced wholesale (sources are small).
fn source_save(
    conn: &Connection,
    id: &str,
    source: &SourceRow,
    passages: Option<&[SourcePassageRow]>,
    expected_rev: Option<i64>,
) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let current_rev: Option<i64> = tx
        .query_row("SELECT rev FROM sources WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let current_rev = current_rev.ok_or_else(|| format!("Source not found: {id}"))?;
    check_expected_rev(expected_rev, current_rev)?;
    let new_rev = current_rev + 1;
    let project_id = live_project_id(&tx, source.project_id.as_deref())?;

    tx.execute(
        "UPDATE sources SET project_id = ?2, title = ?3, author = ?4, year = ?5, doi = ?6,
                url = ?7, language = ?8, translation = ?9, asset_ref = ?10,
                original_text = ?11, content_hash = ?12, extraction_status = ?13,
                truncation_note = ?14, included_in_context = ?15, notes = ?16,
                verification = ?17, updated_at = ?18, rev = ?19,
                source_type = ?20, container_title = ?21, publisher = ?22,
                volume = ?23, issue = ?24, pages = ?25, abstract_text = ?26
         WHERE id = ?1",
        params![
            id,
            project_id,
            source.title,
            source.author,
            source.year,
            source.doi,
            source.url,
            source.language,
            source.translation,
            source.asset_ref,
            source.original_text,
            source.content_hash,
            source.extraction_status,
            source.truncation_note,
            source.included_in_context,
            source.notes,
            source.verification,
            source.updated_at,
            new_rev,
            source.source_type,
            source.container_title,
            source.publisher,
            source.volume,
            source.issue,
            source.pages,
            source.abstract_text
        ],
    )
    .map_err(|e| e.to_string())?;

    // Passage ownership: an omitted list is a METADATA-ONLY save and keeps
    // the stored passages (ids/content/locators). An explicit list —
    // including the empty one — intentionally replaces them.
    if let Some(passages) = passages {
        tx.execute("DELETE FROM source_passages WHERE source_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        for (idx, passage) in passages.iter().enumerate() {
            tx.execute(
                "INSERT INTO source_passages (id, source_id, idx, locator, content)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![passage.id, id, idx as i64, passage.locator, passage.content],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_rev)
}

fn source_delete(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM sources WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// INSERT a source row preserving its given revision (import path only).
/// Strict: a duplicate id or content hash fails the import transaction.
fn source_insert(tx: &Connection, source: &SourceRow) -> Result<(), String> {
    tx.execute(
        "INSERT INTO sources (id, project_id, title, author, year, doi, url, language,
                              translation, asset_ref, original_text, content_hash,
                              extraction_status, truncation_note, included_in_context,
                              notes, verification, rev, created_at, updated_at,
                              source_type, container_title, publisher, volume, issue,
                              pages, abstract_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                 ?21, ?22, ?23, ?24, ?25, ?26, ?27)",
        params![
            source.id,
            source.project_id,
            source.title,
            source.author,
            source.year,
            source.doi,
            source.url,
            source.language,
            source.translation,
            source.asset_ref,
            source.original_text,
            source.content_hash,
            source.extraction_status,
            source.truncation_note,
            source.included_in_context,
            source.notes,
            source.verification,
            source.rev,
            source.created_at,
            source.updated_at,
            source.source_type,
            source.container_title,
            source.publisher,
            source.volume,
            source.issue,
            source.pages,
            source.abstract_text
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE constraint failed") {
            format!("Duplicate source identity in the backup: {}", source.id)
        } else {
            e.to_string()
        }
    })?;
    Ok(())
}

fn projects_list(conn: &Connection) -> Result<Vec<ProjectRow>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM projects ORDER BY updated_at DESC, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_project)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// INSERT a project row with its revision. Used by creation and imports.
fn project_insert(conn: &Connection, meta: &ProjectRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO projects (id, title, description, default_audience, default_tone,
                               default_citations, default_language, refs, brief_word_count,
                               rev, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            meta.id,
            meta.title,
            meta.description,
            meta.default_audience,
            meta.default_tone,
            meta.default_citations,
            meta.default_language,
            meta.refs,
            meta.brief_word_count,
            meta.rev,
            meta.created_at,
            meta.updated_at
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE constraint failed") {
            format!("Project already exists: {}", meta.id)
        } else {
            e.to_string()
        }
    })?;
    Ok(())
}

/// Upsert a project row preserving its given revision (import path only).
/// ON CONFLICT DO UPDATE (not INSERT OR REPLACE): REPLACE would cascade a
/// delete through project_briefs and wipe the brief.
fn project_upsert(conn: &Connection, meta: &ProjectRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO projects (id, title, description, default_audience, default_tone,
                               default_citations, default_language, refs, brief_word_count,
                               rev, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           default_audience = excluded.default_audience,
           default_tone = excluded.default_tone,
           default_citations = excluded.default_citations,
           default_language = excluded.default_language,
           refs = excluded.refs,
           brief_word_count = excluded.brief_word_count,
           rev = excluded.rev,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at",
        params![
            meta.id,
            meta.title,
            meta.description,
            meta.default_audience,
            meta.default_tone,
            meta.default_citations,
            meta.default_language,
            meta.refs,
            meta.brief_word_count,
            meta.rev,
            meta.created_at,
            meta.updated_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Domain save of a project: metadata (+ optional brief) in one
/// transaction. Update-only. Returns the new revision.
fn project_save(
    conn: &Connection,
    id: &str,
    meta: &ProjectRow,
    brief: Option<&str>,
    expected_rev: Option<i64>,
) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let current_rev: Option<i64> = tx
        .query_row("SELECT rev FROM projects WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let current_rev = current_rev.ok_or_else(|| format!("Project not found: {id}"))?;
    check_expected_rev(expected_rev, current_rev)?;
    let new_rev = current_rev + 1;
    if let Some(brief) = brief {
        tx.execute(
            "INSERT INTO project_briefs (project_id, content) VALUES (?1, ?2)
             ON CONFLICT(project_id) DO UPDATE SET content = excluded.content",
            params![id, brief],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE projects SET title = ?2, description = ?3, default_audience = ?4,
                default_tone = ?5, default_citations = ?6, default_language = ?7,
                refs = ?8, brief_word_count = ?9, updated_at = ?10, rev = ?11
         WHERE id = ?1",
        params![
            id,
            meta.title,
            meta.description,
            meta.default_audience,
            meta.default_tone,
            meta.default_citations,
            meta.default_language,
            meta.refs,
            meta.brief_word_count,
            meta.updated_at,
            new_rev
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_rev)
}

fn project_brief(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT content FROM project_briefs WHERE project_id = ?1",
        params![id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// A child unlinked by `project_delete` together with its new revision;
/// the frontend refreshes its session cache from these before the next
/// save (B21c).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedChildRow {
    pub kind: String,
    pub id: String,
    pub rev: i64,
}

/// Delete a project AND unlink everything that references it, in one
/// domain operation: its texts, conversations, and sources survive as
/// standalone rows (project_id NULL); nothing dangling remains. Each
/// unlinked child advances its revision — the relationship change is a
/// metadata change, so stale clients cannot save on top of it. Returns
/// the unlinked children with their new revisions.
fn project_delete(conn: &Connection, id: &str) -> Result<Vec<AffectedChildRow>, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut affected: Vec<AffectedChildRow> = Vec::new();
    for (kind, table) in [("text", "texts"), ("thread", "threads"), ("source", "sources")] {
        let children: Vec<(String, i64)> = {
            let mut stmt = tx
                .prepare(&format!(
                    "SELECT id, rev FROM {table} WHERE project_id = ?1"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        if children.is_empty() {
            continue;
        }
        tx.execute(
            &format!(
                "UPDATE {table} SET project_id = NULL, rev = rev + 1 WHERE project_id = ?1"
            ),
            params![id],
        )
        .map_err(|e| e.to_string())?;
        for (child_id, rev) in children {
            affected.push(AffectedChildRow {
                kind: kind.to_string(),
                id: child_id,
                rev: rev + 1,
            });
        }
    }
    tx.execute(
        "DELETE FROM project_briefs WHERE project_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(affected)
}

fn threads_list(conn: &Connection) -> Result<Vec<ThreadRow>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM threads ORDER BY updated_at DESC, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_thread)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// INSERT a thread row with its revision. Used by creation and imports.
fn thread_insert(conn: &Connection, meta: &ThreadRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO threads (id, title, mode, project_id, refs, rev, archived, pinned, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            meta.id,
            meta.title,
            meta.mode,
            meta.project_id,
            meta.refs,
            meta.rev,
            meta.archived,
            meta.pinned,
            meta.created_at,
            meta.updated_at
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE constraint failed") {
            format!("Thread already exists: {}", meta.id)
        } else {
            e.to_string()
        }
    })?;
    Ok(())
}

/// Upsert a thread row preserving its given revision (import path only).
fn thread_upsert(conn: &Connection, meta: &ThreadRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO threads (id, title, mode, project_id, refs, rev, archived, pinned, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           mode = excluded.mode,
           project_id = excluded.project_id,
           refs = excluded.refs,
           rev = excluded.rev,
           archived = excluded.archived,
           pinned = excluded.pinned,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at",
        params![
            meta.id,
            meta.title,
            meta.mode,
            meta.project_id,
            meta.refs,
            meta.rev,
            meta.archived,
            meta.pinned,
            meta.created_at,
            meta.updated_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn thread_get(conn: &Connection, id: &str) -> Result<Option<ThreadData>, String> {
    let row: Option<(i64,)> = conn
        .query_row("SELECT rev FROM threads WHERE id = ?1", params![id], |r| {
            Ok((r.get(0)?,))
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((rev,)) = row else {
        return Ok(None);
    };
    let brief_json: Option<String> = conn
        .query_row(
            "SELECT brief_json FROM thread_data WHERE thread_id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let mut stmt = conn
        .prepare(
            "SELECT msg_id, role, content, timestamp, failed, incomplete, attachments_json
             FROM messages WHERE thread_id = ?1 ORDER BY idx ASC",
        )
        .map_err(|e| e.to_string())?;
    let messages = stmt
        .query_map(params![id], row_to_message)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(Some(ThreadData {
        brief_json,
        messages,
        rev,
    }))
}

/// Create a thread: metadata + brief + initial messages in one transaction.
fn thread_create(
    conn: &Connection,
    meta: &ThreadRow,
    brief_json: Option<String>,
    messages: &[MessageRow],
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // B21c: a create must not persist a dangling project link.
    let mut stored = meta.clone();
    stored.project_id = live_project_id(&tx, meta.project_id.as_deref())?;
    thread_insert(&tx, &stored)?;
    write_thread_data(&tx, &meta.id, brief_json, messages)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Insert one message row at a position. Shared by thread create/save,
/// append, dump restore, and legacy import (one SQL string, one column list).
fn insert_message(
    conn: &Connection,
    thread_id: &str,
    idx: i64,
    m: &MessageRow,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO messages (thread_id, idx, msg_id, role, content, timestamp, failed, incomplete, attachments_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            thread_id,
            idx,
            m.id,
            m.role,
            m.content,
            m.timestamp,
            m.failed as i64,
            m.incomplete,
            m.attachments_json
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Write the thread's brief + message rows (used by create and save).
fn write_thread_data(
    tx: &Connection,
    id: &str,
    brief_json: Option<String>,
    messages: &[MessageRow],
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO thread_data (thread_id, brief_json) VALUES (?1, ?2)
         ON CONFLICT(thread_id) DO UPDATE SET brief_json = excluded.brief_json",
        params![id, brief_json],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM messages WHERE thread_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    for (idx, m) in messages.iter().enumerate() {
        insert_message(tx, id, idx as i64, m)?;
    }
    Ok(())
}

/// Domain save of a whole thread: metadata, writing brief, and messages in
/// one transaction. Update-only: a deleted thread is never recreated. When
/// `expected_rev` is given and differs from the persisted revision (e.g. a
/// background append landed meanwhile), the save is rejected so it cannot
/// silently remove the appended reply. Returns the new revision.
fn thread_save(
    conn: &Connection,
    id: &str,
    meta: &ThreadRow,
    brief_json: Option<String>,
    messages: &[MessageRow],
    expected_rev: Option<i64>,
) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let current_rev: Option<i64> = tx
        .query_row("SELECT rev FROM threads WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let current_rev = current_rev.ok_or_else(|| format!("Thread not found: {id}"))?;
    check_expected_rev(expected_rev, current_rev)?;
    let new_rev = current_rev + 1;
    let project_id = live_project_id(&tx, meta.project_id.as_deref())?;
    tx.execute(
        "UPDATE threads SET title = ?2, mode = ?3, project_id = ?4, refs = ?5,
                updated_at = ?6, rev = ?7
         WHERE id = ?1",
        params![id, meta.title, meta.mode, project_id, meta.refs, meta.updated_at, new_rev],
    )
    .map_err(|e| e.to_string())?;
    write_thread_data(&tx, id, brief_json, messages)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_rev)
}

/// Append one message to a thread without rewriting it (used when a
/// generation finishes after the user switched conversations). Bumps the
/// revision so any debounced save scheduled before the append is rejected.
/// Returns the new revision.
fn thread_append_message(
    conn: &Connection,
    id: &str,
    message: &MessageRow,
    updated_at: &str,
) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let current_rev: Option<i64> = tx
        .query_row("SELECT rev FROM threads WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let current_rev = current_rev.ok_or_else(|| format!("Thread not found: {id}"))?;
    let new_rev = current_rev + 1;
    let next_idx: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(idx), -1) + 1 FROM messages WHERE thread_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    insert_message(&tx, id, next_idx, message)?;
    tx.execute(
        "UPDATE threads SET updated_at = ?2, rev = ?3 WHERE id = ?1",
        params![id, updated_at, new_rev],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_rev)
}

/// Replace one message's content by its stable id (used by regeneration
/// committing after the user navigated away). Update-only; bumps the
/// thread revision. Returns the new revision.
fn thread_replace_message(
    conn: &Connection,
    id: &str,
    message_id: &str,
    content: &str,
    incomplete: Option<&str>,
    updated_at: &str,
) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let current_rev: Option<i64> = tx
        .query_row("SELECT rev FROM threads WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let current_rev = current_rev.ok_or_else(|| format!("Thread not found: {id}"))?;
    let updated = tx
        .execute(
            "UPDATE messages SET content = ?3, incomplete = ?4
             WHERE thread_id = ?1 AND msg_id = ?2",
            params![id, message_id, content, incomplete],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        return Err(format!("Message not found: {message_id}"));
    }
    let new_rev = current_rev + 1;
    tx.execute(
        "UPDATE threads SET updated_at = ?2, rev = ?3 WHERE id = ?1",
        params![id, updated_at, new_rev],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_rev)
}

/// Rename a thread (metadata-only): the messages and brief are untouched,
/// so renaming a conversation that is not currently loaded is safe.
/// Returns the new revision.
fn thread_rename(
    conn: &Connection,
    id: &str,
    title: &str,
    updated_at: &str,
) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let current_rev: Option<i64> = tx
        .query_row("SELECT rev FROM threads WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let current_rev = current_rev.ok_or_else(|| format!("Thread not found: {id}"))?;
    let new_rev = current_rev + 1;
    tx.execute(
        "UPDATE threads SET title = ?2, updated_at = ?3, rev = ?4 WHERE id = ?1",
        params![id, title, updated_at, new_rev],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_rev)
}

fn thread_delete(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM threads WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Navigator organization (D3): set archived/pinned on a TEXT. Update-only,
/// revision-checked like every metadata write; unmentioned fields keep
/// their values. Returns the new revision.
fn text_set_state(
    conn: &Connection,
    id: &str,
    archived: Option<bool>,
    pinned: Option<bool>,
    updated_at: &str,
) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let row: Option<(i64, i64, i64)> = tx
        .query_row(
            "SELECT rev, archived, pinned FROM texts WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (current_rev, current_archived, current_pinned) =
        row.ok_or_else(|| format!("Text not found: {id}"))?;
    let new_rev = current_rev + 1;
    tx.execute(
        "UPDATE texts SET archived = ?2, pinned = ?3, updated_at = ?4, rev = ?5 WHERE id = ?1",
        params![
            id,
            archived.unwrap_or(current_archived != 0),
            pinned.unwrap_or(current_pinned != 0),
            updated_at,
            new_rev
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_rev)
}

/// Navigator organization (D3) for conversations: same semantics as
/// `text_set_state`. Metadata-only, update-only, bumps rev.
fn thread_set_state(
    conn: &Connection,
    id: &str,
    archived: Option<bool>,
    pinned: Option<bool>,
    updated_at: &str,
) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let row: Option<(i64, i64, i64)> = tx
        .query_row(
            "SELECT rev, archived, pinned FROM threads WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (current_rev, current_archived, current_pinned) =
        row.ok_or_else(|| format!("Thread not found: {id}"))?;
    let new_rev = current_rev + 1;
    tx.execute(
        "UPDATE threads SET archived = ?2, pinned = ?3, updated_at = ?4, rev = ?5 WHERE id = ?1",
        params![
            id,
            archived.unwrap_or(current_archived != 0),
            pinned.unwrap_or(current_pinned != 0),
            updated_at,
            new_rev
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(new_rev)
}

// ──────────────────────────────────────────────
// Consistent-snapshot export / import
// ──────────────────────────────────────────────

fn export_dump(conn: &Connection) -> Result<DbDump, String> {
    // One read transaction: the dump is a single consistent snapshot.
    conn.execute_batch("BEGIN")
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<DbDump, String> {
        let texts = texts_list(conn)?;
        let projects = projects_list(conn)?;
        let threads = threads_list(conn)?;

        let mut text_contents = Vec::new();
        let mut stmt = conn
            .prepare(
                "SELECT text_id, content, content_format, content_schema_version, plain_text
                 FROM text_contents ORDER BY text_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TextContentRow {
                    text_id: r.get(0)?,
                    content: r.get(1)?,
                    content_format: r.get(2)?,
                    content_schema_version: r.get(3)?,
                    plain_text: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            text_contents.push(row.map_err(|e| e.to_string())?);
        }

        let mut text_versions = Vec::new();
        let mut stmt = conn
            .prepare(
                "SELECT text_id, version_id, saved_at, content, content_format,
                        content_schema_version, plain_text, label
                 FROM text_versions ORDER BY text_id, version_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TextVersionRow {
                    text_id: r.get(0)?,
                    version_id: Some(r.get(1)?),
                    saved_at: r.get(2)?,
                    content: r.get(3)?,
                    content_format: r.get(4)?,
                    content_schema_version: r.get(5)?,
                    plain_text: r.get(6)?,
                    label: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            text_versions.push(row.map_err(|e| e.to_string())?);
        }

        let mut project_briefs = Vec::new();
        let mut stmt = conn
            .prepare("SELECT project_id, content FROM project_briefs ORDER BY project_id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ProjectBriefRow {
                    project_id: r.get(0)?,
                    content: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            project_briefs.push(row.map_err(|e| e.to_string())?);
        }

        let mut thread_briefs = Vec::new();
        let mut stmt = conn
            .prepare("SELECT thread_id, brief_json FROM thread_data ORDER BY thread_id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ThreadBriefRow {
                    thread_id: r.get(0)?,
                    brief_json: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            thread_briefs.push(row.map_err(|e| e.to_string())?);
        }

        let sources = sources_list(conn)?;

        let mut proposals = Vec::new();
        let mut stmt = conn
            .prepare("SELECT * FROM document_proposals ORDER BY created_at, id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], row_to_proposal)
            .map_err(|e| e.to_string())?;
        for row in rows {
            proposals.push(row.map_err(|e| e.to_string())?);
        }

        let mut source_passages = Vec::new();
        let mut stmt = conn
            .prepare(
                "SELECT source_id, id, locator, content FROM source_passages
                 ORDER BY source_id, idx",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(StoredSourcePassageRow {
                    source_id: r.get(0)?,
                    passage: SourcePassageRow {
                        id: r.get(1)?,
                        locator: r.get(2)?,
                        content: r.get(3)?,
                    },
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            source_passages.push(row.map_err(|e| e.to_string())?);
        }

        let mut messages = Vec::new();
        let mut stmt = conn
            .prepare(
                "SELECT thread_id, idx, msg_id, role, content, timestamp, failed, incomplete, attachments_json
                 FROM messages ORDER BY thread_id, idx",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(StoredMessageRow {
                    thread_id: r.get(0)?,
                    idx: r.get(1)?,
                    message: row_to_message(r)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            messages.push(row.map_err(|e| e.to_string())?);
        }

        Ok(DbDump {
            texts,
            text_contents,
            text_versions,
            projects,
            project_briefs,
            sources,
            source_passages,
            proposals,
            threads,
            thread_briefs,
            messages,
        })
    })();
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    result
}

fn clear_domain_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM messages;
         DELETE FROM thread_data;
         DELETE FROM threads;
         DELETE FROM source_passages;
         DELETE FROM sources;
         DELETE FROM document_proposals;
         DELETE FROM text_versions;
         DELETE FROM text_contents;
         DELETE FROM texts;
         DELETE FROM project_briefs;
         DELETE FROM projects;",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Refuse content rows this build cannot open: an unknown format or a
/// content schema newer than the supported contract. Runs BEFORE the row is
/// written, inside the restore transaction.
fn check_content_contract(
    content_format: &Option<String>,
    content_schema_version: Option<i64>,
    what: &str,
) -> Result<(), String> {
    if let Some(format) = content_format {
        if format != "markdown" && format != "tiptap-json" {
            return Err(format!(
                "{what} carries an unsupported content format \"{format}\""
            ));
        }
    }
    if let Some(version) = content_schema_version {
        if version < 1 || version > SUPPORTED_CONTENT_SCHEMA_VERSION {
            return Err(format!(
                "{what} carries content schema v{version}; this build supports \
                 up to v{SUPPORTED_CONTENT_SCHEMA_VERSION}"
            ));
        }
    }
    Ok(())
}

/// Refuse incomplete markers this build does not know (schema v12): a
/// restore must not write a value the UI cannot render honestly.
fn check_incomplete_contract(marker: &Option<String>, what: &str) -> Result<(), String> {
    if let Some(value) = marker {
        if value != "interrupted" && value != "truncated" {
            return Err(format!(
                "{what} carries an unsupported incomplete marker \"{value}\""
            ));
        }
    }
    Ok(())
}

/// Apply the whole domain dataset to an OPEN transaction (no commit).
///
/// Strict inserts: every identity is validated by the database itself.
/// Duplicate primary/composite keys fail the restore (and roll back) instead
/// of being silently dropped by `INSERT OR IGNORE` or merged by an upsert —
/// a backup that cannot be restored faithfully must be rejected, not
/// partially applied.
fn apply_dump(tx: &Connection, dump: &DbDump) -> Result<(), String> {
    clear_domain_tables(tx)?;

    for t in &dump.texts {
        text_insert(tx, t)?;
    }
    for c in &dump.text_contents {
        check_content_contract(
            &c.content_format,
            c.content_schema_version,
            &format!("text_contents row for \"{}\"", c.text_id),
        )?;
        tx.execute(
            "INSERT INTO text_contents (text_id, content, content_format, content_schema_version, plain_text)
             VALUES (?1, ?2, COALESCE(?3, 'markdown'), COALESCE(?4, 1), ?5)",
            params![
                c.text_id,
                c.content,
                c.content_format,
                c.content_schema_version,
                c.plain_text
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for v in &dump.text_versions {
        check_content_contract(
            &v.content_format,
            v.content_schema_version,
            &format!("text_versions row for \"{}\"", v.text_id),
        )?;
        let version_id = match &v.version_id {
            Some(id) if !id.is_empty() => id.clone(),
            _ => next_version_id(),
        };
        tx.execute(
            "INSERT INTO text_versions (text_id, version_id, saved_at, content,
                                        content_format, content_schema_version, plain_text, label)
             VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 'markdown'), COALESCE(?6, 1), ?7, ?8)",
            params![
                v.text_id,
                version_id,
                v.saved_at,
                v.content,
                v.content_format,
                v.content_schema_version,
                v.plain_text,
                v.label
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for p in &dump.projects {
        project_insert(tx, p)?;
    }
    for b in &dump.project_briefs {
        tx.execute(
            "INSERT INTO project_briefs (project_id, content) VALUES (?1, ?2)",
            params![b.project_id, b.content],
        )
        .map_err(|e| e.to_string())?;
    }
    for s in &dump.sources {
        source_insert(tx, s)?;
    }
    for p in &dump.source_passages {
        tx.execute(
            "INSERT INTO source_passages (id, source_id, idx, locator, content)
             VALUES (?1, ?2,
                     COALESCE((SELECT COUNT(*) FROM source_passages WHERE source_id = ?2), 0),
                     ?3, ?4)",
            params![p.passage.id, p.source_id, p.passage.locator, p.passage.content],
        )
        .map_err(|e| e.to_string())?;
    }
    for p in &dump.proposals {
        proposal_create(tx, p)?;
    }
    for t in &dump.threads {
        thread_insert(tx, t)?;
    }
    for b in &dump.thread_briefs {
        tx.execute(
            "INSERT INTO thread_data (thread_id, brief_json) VALUES (?1, ?2)",
            params![b.thread_id, b.brief_json],
        )
        .map_err(|e| e.to_string())?;
    }
    for m in &dump.messages {
        check_incomplete_contract(&m.message.incomplete, &format!("message for \"{}\"", m.thread_id))?;
        insert_message(tx, &m.thread_id, m.idx, &m.message)?;
    }
    Ok(())
}

// ──────────────────────────────────────────────
// Preferences (non-secret configuration in SQLite)
// ──────────────────────────────────────────────

/// One preference row: `value` holds the JSON-encoded preference.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrefRow {
    pub key: String,
    pub value: String,
}

/// How many rows a restore activated (reported to the user as real
/// document/project/conversation counts, not "files").
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RestoreCounts {
    pub texts: u32,
    pub projects: u32,
    pub threads: u32,
    pub messages: u32,
    pub versions: u32,
    pub sources: u32,
    pub source_passages: u32,
}

fn restore_counts(conn: &Connection) -> Result<RestoreCounts, String> {
    let q = |sql: &str| -> Result<u32, String> {
        conn.query_row(sql, [], |r| r.get::<_, i64>(0))
            .map(|n| n as u32)
            .map_err(|e| e.to_string())
    };
    Ok(RestoreCounts {
        texts: q("SELECT COUNT(*) FROM texts")?,
        projects: q("SELECT COUNT(*) FROM projects")?,
        threads: q("SELECT COUNT(*) FROM threads")?,
        messages: q("SELECT COUNT(*) FROM messages")?,
        versions: q("SELECT COUNT(*) FROM text_versions")?,
        sources: q("SELECT COUNT(*) FROM sources")?,
        source_passages: q("SELECT COUNT(*) FROM source_passages")?,
    })
}

fn prefs_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM preferences WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn prefs_get_all(conn: &Connection) -> Result<Vec<PrefRow>, String> {
    let mut stmt = conn
        .prepare("SELECT key, value FROM preferences ORDER BY key")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PrefRow {
                key: r.get(0)?,
                value: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn prefs_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO preferences (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ──────────────────────────────────────────────
// Full-text search (FTS5, transactionally maintained)
// ──────────────────────────────────────────────

/// One search hit: what matched, where, and a readable excerpt.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// "text" | "project" (brief) | "thread" (conversation)
    pub kind: String,
    pub doc_id: String,
    pub title: String,
    pub excerpt: String,
}

/// Turn raw user input into a safe FTS5 MATCH query: every whitespace
/// token is quoted (implicit AND). Malformed operator input can no longer
/// break the query parser.
fn fts_query(input: &str) -> Option<String> {
    let tokens: Vec<String> = input
        .split_whitespace()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

fn resolve_title(
    conn: &Connection,
    kind: &str,
    doc_id: &str,
) -> Result<String, String> {
    let table = match kind {
        "text" => "texts",
        "project" => "projects",
        "thread" => "threads",
        _ => return Ok(String::new()),
    };
    let title: Option<String> = conn
        .query_row(
            &format!("SELECT title FROM {table} WHERE id = ?1"),
            params![doc_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(title.unwrap_or_default())
}

/// Full-text search across documents, project briefs, and conversations.
/// Body matches come from the FTS index (ranked); title matches are added
/// as leading hits. The index is trigger-maintained, so results always
/// reflect committed data.
fn search(conn: &Connection, query: &str) -> Result<Vec<SearchHit>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut seen: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();

    // Title matches first (exact substring, any position).
    let like = format!("%{}%", trimmed.replace('\"', "\"\""));
    for (kind, table) in [
        ("text", "texts"),
        ("project", "projects"),
        ("thread", "threads"),
    ] {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, title FROM {table} WHERE title LIKE ?1 LIMIT 10"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![like], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (doc_id, title) = row.map_err(|e| e.to_string())?;
            if seen.insert((kind.to_string(), doc_id.clone())) {
                hits.push(SearchHit {
                    kind: kind.to_string(),
                    doc_id,
                    title,
                    excerpt: String::new(),
                });
            }
        }
    }

    // Body matches (ranked by relevance).
    if let Some(match_query) = fts_query(trimmed) {
        let mut stmt = conn
            .prepare(
                "SELECT kind, doc_id, snippet(search_index, 2, '', '', '…', 16)
                 FROM search_index WHERE search_index MATCH ?1
                 ORDER BY rank LIMIT 25",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![match_query], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (kind, doc_id, excerpt) = row.map_err(|e| e.to_string())?;
            if seen.insert((kind.clone(), doc_id.clone())) {
                let title = resolve_title(conn, &kind, &doc_id)?;
                hits.push(SearchHit { kind, doc_id, title, excerpt });
            }
        }
    }

    hits.truncate(25);
    Ok(hits)
}

// ──────────────────────────────────────────────
// Legacy JSON import (validated, recoverable)
// ──────────────────────────────────────────────

/// Registry files the legacy importer reads.
const LEGACY_REGISTRY_FILES: [&str; 3] = ["library.json", "projects.json", "threads.json"];

/// One problem found while inventorying/importing legacy data. Nothing in
/// this list deletes or rewrites any input file.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MigrationIssue {
    /// File name (or logical path) the issue belongs to.
    pub path: String,
    /// "malformed" | "unreadable" | "orphan" | "invalid-record"
    pub kind: String,
    pub detail: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MigrationCounts {
    pub texts: u32,
    pub projects: u32,
    pub threads: u32,
    pub messages: u32,
    pub versions: u32,
}

/// What a legacy migration did. `completed: false` means NOTHING was
/// imported, NOTHING was archived, and the completion marker was not set —
/// the raw inputs are untouched and the next launch retries.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub completed: bool,
    /// Set when db_init found the repository already open (idempotent no-op).
    #[serde(default)]
    pub already_open: bool,
    pub counts: MigrationCounts,
    pub issues: Vec<MigrationIssue>,
    /// Directory (relative to the data dir) the consumed files were moved
    /// into, when archiving succeeded.
    pub archived_dir: Option<String>,
}

impl MigrationReport {
    fn empty() -> Self {
        MigrationReport {
            completed: true,
            already_open: false,
            counts: MigrationCounts::default(),
            issues: Vec::new(),
            archived_dir: None,
        }
    }
}

enum ReadOutcome {
    Value(serde_json::Value),
    Missing,
    Unreadable(String),
    Malformed(String),
}

/// Read a JSON file WITHOUT conflating failure modes: a missing file is
/// distinct from an unreadable one and from a malformed one.
fn read_json_classified(path: &Path) -> ReadOutcome {
    match fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ReadOutcome::Missing,
        Err(e) => ReadOutcome::Unreadable(e.to_string()),
        Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(v) => ReadOutcome::Value(v),
            Err(e) => ReadOutcome::Malformed(e.to_string()),
        },
    }
}

/// Legacy ids end up in file paths (`text_<id>.json`); only ids that
/// cannot escape the data directory are trusted for path construction.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Parse a JSON value into a string field, with a default when absent.
fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn i64_field(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| {
        x.as_i64()
            .or_else(|| x.as_f64().map(|f| f.round() as i64))
    })
}

/// A JSON boolean; absent/null means false.
fn bool_field(v: &serde_json::Value, key: &str) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(false)
}

/// The fully validated import dataset, built BEFORE anything is activated.
#[derive(Default)]
struct LegacyDataset {
    texts: Vec<TextRow>,
    text_contents: Vec<TextContentRow>,
    versions: Vec<TextVersionRow>,
    projects: Vec<ProjectRow>,
    briefs: Vec<(String, String)>,
    threads: Vec<ThreadRow>,
    thread_briefs: Vec<(String, Option<String>)>,
    messages: Vec<(String, MessageRow)>,
    /// Files fully consumed by the import (candidates for archiving).
    consumed: Vec<PathBuf>,
    counts: MigrationCounts,
    issues: Vec<MigrationIssue>,
}

/// Build the validated dataset from the legacy files in `dir`.
///
/// - A registry file that is unreadable or malformed ABORTS the build:
///   nothing is imported, the marker is not set, no file is touched.
/// - Invalid individual records are skipped and reported as issues.
/// - Orphan body/history files (no registry entry) are inventoried but
///   never imported.
/// - Original files are never modified or deleted by this function.
fn build_legacy_dataset(dir: &Path) -> Result<LegacyDataset, Vec<MigrationIssue>> {
    let mut ds = LegacyDataset::default();
    let mut hard_failures: Vec<MigrationIssue> = Vec::new();

    let mut registries: Vec<(&str, Vec<serde_json::Value>)> = Vec::new();
    for name in LEGACY_REGISTRY_FILES {
        let path = dir.join(name);
        match read_json_classified(&path) {
            ReadOutcome::Missing => {}
            ReadOutcome::Unreadable(e) => hard_failures.push(MigrationIssue {
                path: name.into(),
                kind: "unreadable".into(),
                detail: e,
            }),
            ReadOutcome::Malformed(e) => hard_failures.push(MigrationIssue {
                path: name.into(),
                kind: "malformed".into(),
                detail: e,
            }),
            ReadOutcome::Value(serde_json::Value::Array(items)) => {
                registries.push((name, items));
            }
            ReadOutcome::Value(_) => hard_failures.push(MigrationIssue {
                path: name.into(),
                kind: "malformed".into(),
                detail: "not a JSON array".into(),
            }),
        }
    }
    if !hard_failures.is_empty() {
        return Err(hard_failures);
    }

    let stamp = format!("imported-{}", now_unix_secs());

    for (name, items) in registries {
        match name {
            "library.json" => {
                ds.consumed.push(dir.join(name));
                for item in &items {
                    let Some(id) = str_field(item, "id").filter(|i| is_safe_id(i)) else {
                        ds.issues.push(MigrationIssue {
                            path: name.into(),
                            kind: "invalid-record".into(),
                            detail: "library entry without a usable id".into(),
                        });
                        continue;
                    };
                    ds.texts.push(TextRow {
                        id: id.clone(),
                        title: str_field(item, "title").unwrap_or_else(|| "Untitled text".into()),
                        text_type: str_field(item, "textType").unwrap_or_else(|| "other".into()),
                        folder: str_field(item, "folder"),
                        project_id: str_field(item, "projectId"),
                        snippet: str_field(item, "snippet"),
                        word_count: i64_field(item, "wordCount"),
                        rev: 0,
                        // Navigator organization survives a v1 transfer.
                        archived: bool_field(item, "archived"),
                        pinned: bool_field(item, "pinned"),
                        created_at: str_field(item, "createdAt").unwrap_or_else(|| stamp.clone()),
                        updated_at: str_field(item, "updatedAt").unwrap_or_else(|| stamp.clone()),
                    });
                    ds.counts.texts += 1;

                    let content_path = dir.join(format!("text_{id}.json"));
                    match read_json_classified(&content_path) {
                        ReadOutcome::Missing => {}
                        ReadOutcome::Value(data) => {
                            ds.consumed.push(content_path);
                            // Rich browser documents carry the format
                            // contract fields; older files are markdown.
                            ds.text_contents.push(TextContentRow {
                                text_id: id.clone(),
                                content: str_field(&data, "content").unwrap_or_default(),
                                content_format: str_field(&data, "contentFormat"),
                                content_schema_version: i64_field(
                                    &data,
                                    "contentSchemaVersion",
                                )
                                .filter(|v| *v >= 1 && *v <= SUPPORTED_CONTENT_SCHEMA_VERSION),
                                plain_text: str_field(&data, "plainText"),
                            });
                        }
                        ReadOutcome::Unreadable(e) | ReadOutcome::Malformed(e) => {
                            // Missing optional data is fine; unreadable or
                            // malformed content is reported and the file
                            // is left exactly where it is.
                            ds.issues.push(MigrationIssue {
                                path: content_path
                                    .file_name()
                                    .map(|n| n.to_string_lossy().into_owned())
                                    .unwrap_or_default(),
                                kind: "malformed".into(),
                                detail: e,
                            });
                        }
                    }

                    let versions_path = dir.join(format!("text_{id}.versions.json"));
                    match read_json_classified(&versions_path) {
                        ReadOutcome::Missing => {}
                        ReadOutcome::Value(serde_json::Value::Array(versions)) => {
                            ds.consumed.push(versions_path);
                            for v in &versions {
                                let Some(saved_at) =
                                    str_field(v, "savedAt").filter(|s| !s.is_empty())
                                else {
                                    continue;
                                };
                                // Current browser files nest the body
                                // under `body`; older ones inline it.
                                let body = v.get("body").unwrap_or(v);
                                ds.versions.push(TextVersionRow {
                                    text_id: id.clone(),
                                    version_id: str_field(v, "versionId"),
                                    saved_at,
                                    content: str_field(body, "content").unwrap_or_default(),
                                    content_format: str_field(body, "contentFormat"),
                                    content_schema_version: i64_field(
                                        body,
                                        "contentSchemaVersion",
                                    )
                                    .filter(|n| *n >= 1 && *n <= SUPPORTED_CONTENT_SCHEMA_VERSION),
                                    plain_text: str_field(body, "plainText"),
                                    label: str_field(v, "label"),
                                });
                                ds.counts.versions += 1;
                            }
                        }
                        ReadOutcome::Value(_) => {
                            ds.issues.push(MigrationIssue {
                                path: versions_path
                                    .file_name()
                                    .map(|n| n.to_string_lossy().into_owned())
                                    .unwrap_or_default(),
                                kind: "malformed".into(),
                                detail: "version history is not a JSON array".into(),
                            });
                        }
                        ReadOutcome::Unreadable(e) | ReadOutcome::Malformed(e) => {
                            ds.issues.push(MigrationIssue {
                                path: versions_path
                                    .file_name()
                                    .map(|n| n.to_string_lossy().into_owned())
                                    .unwrap_or_default(),
                                kind: "malformed".into(),
                                detail: e,
                            });
                        }
                    }
                }
            }
            "projects.json" => {
                ds.consumed.push(dir.join(name));
                for item in &items {
                    let Some(id) = str_field(item, "id").filter(|i| is_safe_id(i)) else {
                        ds.issues.push(MigrationIssue {
                            path: name.into(),
                            kind: "invalid-record".into(),
                            detail: "project entry without a usable id".into(),
                        });
                        continue;
                    };
                    ds.projects.push(ProjectRow {
                        id: id.clone(),
                        title: str_field(item, "title")
                            .unwrap_or_else(|| "Untitled project".into()),
                        description: str_field(item, "description"),
                        default_audience: str_field(item, "defaultAudience"),
                        default_tone: str_field(item, "defaultTone"),
                        default_citations: str_field(item, "defaultCitations"),
                        default_language: str_field(item, "defaultLanguage"),
                        refs: str_field(item, "references"),
                        brief_word_count: i64_field(item, "briefWordCount"),
                        rev: 0,
                        created_at: str_field(item, "createdAt").unwrap_or_else(|| stamp.clone()),
                        updated_at: str_field(item, "updatedAt").unwrap_or_else(|| stamp.clone()),
                    });
                    ds.counts.projects += 1;

                    let brief_path = dir.join(format!("project_{id}.json"));
                    match read_json_classified(&brief_path) {
                        ReadOutcome::Missing => {}
                        ReadOutcome::Value(data) => {
                            ds.consumed.push(brief_path);
                            ds.briefs
                                .push((id.clone(), str_field(&data, "content").unwrap_or_default()));
                        }
                        ReadOutcome::Unreadable(e) | ReadOutcome::Malformed(e) => {
                            ds.issues.push(MigrationIssue {
                                path: brief_path
                                    .file_name()
                                    .map(|n| n.to_string_lossy().into_owned())
                                    .unwrap_or_default(),
                                kind: "malformed".into(),
                                detail: e,
                            });
                        }
                    }
                }
            }
            "threads.json" => {
                ds.consumed.push(dir.join(name));
                for item in &items {
                    let Some(id) = str_field(item, "id").filter(|i| is_safe_id(i)) else {
                        ds.issues.push(MigrationIssue {
                            path: name.into(),
                            kind: "invalid-record".into(),
                            detail: "thread entry without a usable id".into(),
                        });
                        continue;
                    };
                    ds.threads.push(ThreadRow {
                        id: id.clone(),
                        title: str_field(item, "title")
                            .unwrap_or_else(|| "Untitled conversation".into()),
                        mode: str_field(item, "mode").unwrap_or_else(|| "text".into()),
                        project_id: str_field(item, "projectId"),
                        refs: str_field(item, "references"),
                        rev: 0,
                        archived: bool_field(item, "archived"),
                        pinned: bool_field(item, "pinned"),
                        created_at: str_field(item, "createdAt").unwrap_or_else(|| stamp.clone()),
                        updated_at: str_field(item, "updatedAt").unwrap_or_else(|| stamp.clone()),
                    });
                    ds.counts.threads += 1;

                    let thread_path = dir.join(format!("chat_{id}.json"));
                    let data = match read_json_classified(&thread_path) {
                        ReadOutcome::Missing => continue,
                        ReadOutcome::Value(d) => d,
                        ReadOutcome::Unreadable(e) | ReadOutcome::Malformed(e) => {
                            ds.issues.push(MigrationIssue {
                                path: thread_path
                                    .file_name()
                                    .map(|n| n.to_string_lossy().into_owned())
                                    .unwrap_or_default(),
                                kind: "malformed".into(),
                                detail: e,
                            });
                            continue;
                        }
                    };
                    ds.consumed.push(thread_path);

                    // Old files stored a bare message array; newer ones a
                    // { messages, brief } object.
                    let (messages_value, brief_value) = match &data {
                        serde_json::Value::Array(_) => (Some(data.clone()), None),
                        other => (other.get("messages").cloned(), other.get("brief").cloned()),
                    };
                    let brief_json = match brief_value {
                        Some(serde_json::Value::Null) | None => None,
                        Some(brief) => serde_json::to_string(&brief).ok(),
                    };
                    ds.thread_briefs.push((id.clone(), brief_json));

                    if let Some(serde_json::Value::Array(messages)) = messages_value {
                        for m in &messages {
                            let role = str_field(m, "role").unwrap_or_else(|| "user".into());
                            let content = str_field(m, "content").unwrap_or_default();
                            let timestamp = str_field(m, "timestamp").unwrap_or_else(|| stamp.clone());
                            let failed = m.get("failed").and_then(|f| f.as_bool()).unwrap_or(false);
                            let incomplete = match m.get("incomplete").and_then(|v| v.as_str()) {
                                Some("interrupted") => Some("interrupted".to_string()),
                                Some("truncated") => Some("truncated".to_string()),
                                _ => None,
                            };
                            let attachments_json = match m.get("fileAttachments") {
                                Some(serde_json::Value::Null) | None => None,
                                Some(att) => serde_json::to_string(att).ok(),
                            };
                            ds.messages.push((
                                id.clone(),
                                MessageRow {
                                    id: None, // legacy messages get ids on load
                                    role,
                                    content,
                                    timestamp,
                                    failed,
                                    incomplete,
                                    attachments_json,
                                },
                            ));
                            ds.counts.messages += 1;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // Orphan inventory: domain-shaped files no registry entry referenced.
    // They are reported, never imported, and never touched on disk.
    let mut orphans = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(fname) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let domain_shaped = fname.starts_with("text_")
                || fname.starts_with("project_")
                || fname.starts_with("chat_");
            if domain_shaped
                && fname.ends_with(".json")
                && !ds.consumed.iter().any(|c| c.file_name() == path.file_name())
            {
                orphans.push(MigrationIssue {
                    path: fname.into(),
                    kind: "orphan".into(),
                    detail: "no registry entry references this file; it was left in place"
                        .into(),
                });
            }
        }
    }
    ds.issues.extend(orphans);
    Ok(ds)
}

/// Activate the validated dataset: import everything (optionally replacing
/// the current domain rows), verify counts/relationships/content, and set
/// the completion marker — all in ONE transaction.
fn run_legacy_import(
    conn: &Connection,
    dir: &Path,
    clear: bool,
) -> Result<MigrationReport, String> {
    let ds = match build_legacy_dataset(dir) {
        Ok(ds) => ds,
        Err(issues) => {
            return Ok(MigrationReport {
                completed: false,
                already_open: false,
                counts: MigrationCounts::default(),
                issues,
                archived_dir: None,
            });
        }
    };

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if clear {
        clear_domain_tables(&tx)?;
    }
    for meta in &ds.texts {
        text_upsert_meta(&tx, meta)?;
    }
    for c in &ds.text_contents {
        check_content_contract(
            &c.content_format,
            c.content_schema_version,
            &format!("legacy text body for \"{}\"", c.text_id),
        )?;
        tx.execute(
            "INSERT INTO text_contents (text_id, content, content_format, content_schema_version, plain_text)
             VALUES (?1, ?2, COALESCE(?3, 'markdown'), COALESCE(?4, 1), ?5)
             ON CONFLICT(text_id) DO UPDATE SET
               content = excluded.content,
               content_format = excluded.content_format,
               content_schema_version = excluded.content_schema_version,
               plain_text = excluded.plain_text",
            params![
                c.text_id,
                c.content,
                c.content_format,
                c.content_schema_version,
                c.plain_text
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for v in &ds.versions {
        check_content_contract(
            &v.content_format,
            v.content_schema_version,
            &format!("legacy version for \"{}\"", v.text_id),
        )?;
        let version_id = match &v.version_id {
            Some(id) if !id.is_empty() => id.clone(),
            _ => next_version_id(),
        };
        tx.execute(
            "INSERT INTO text_versions (text_id, version_id, saved_at, content,
                                        content_format, content_schema_version, plain_text, label)
             VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 'markdown'), COALESCE(?6, 1), ?7, ?8)",
            params![
                v.text_id,
                version_id,
                v.saved_at,
                v.content,
                v.content_format,
                v.content_schema_version,
                v.plain_text,
                v.label
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for meta in &ds.projects {
        project_upsert(&tx, meta)?;
    }
    for (id, content) in &ds.briefs {
        tx.execute(
            "INSERT INTO project_briefs (project_id, content) VALUES (?1, ?2)
             ON CONFLICT(project_id) DO UPDATE SET content = excluded.content",
            params![id, content],
        )
        .map_err(|e| e.to_string())?;
    }
    for meta in &ds.threads {
        thread_upsert(&tx, meta)?;
    }
    for (id, brief_json) in &ds.thread_briefs {
        tx.execute(
            "INSERT INTO thread_data (thread_id, brief_json) VALUES (?1, ?2)
             ON CONFLICT(thread_id) DO UPDATE SET brief_json = excluded.brief_json",
            params![id, brief_json],
        )
        .map_err(|e| e.to_string())?;
    }
    // Messages grouped per thread with sequential positions.
    let mut by_thread: std::collections::BTreeMap<String, Vec<&MessageRow>> =
        std::collections::BTreeMap::new();
    for (tid, m) in &ds.messages {
        by_thread.entry(tid.clone()).or_default().push(m);
    }
    for (tid, messages) in &by_thread {
        tx.execute("DELETE FROM messages WHERE thread_id = ?1", params![tid])
            .map_err(|e| e.to_string())?;
        for (idx, m) in messages.iter().enumerate() {
            insert_message(&tx, tid, idx as i64, m)?;
        }
    }

    // Verify the imported dataset BEFORE committing: counts (a CLEAR
    // import replaces everything), content bytes, and relationships must
    // all match what was validated.
    verify_import(&tx, &ds, clear)?;

    set_meta(&tx, "legacy_imported", &now_unix_secs().to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    let archived_dir = archive_files(dir, &ds.consumed);
    Ok(MigrationReport {
        completed: true,
        already_open: false,
        counts: ds.counts,
        issues: ds.issues,
        archived_dir,
    })
}

/// Verify the rows staged in the open transaction against the validated
/// dataset: counts, byte-level content, and relationships. An entirely
/// empty dataset verifies nothing (a first-run migration into a database
/// that already holds rows — e.g. after a v1-restore — has nothing to
/// check).
fn verify_import(
    conn: &Connection,
    ds: &LegacyDataset,
    strict_counts: bool,
) -> Result<(), String> {
    let has_any = !ds.texts.is_empty()
        || !ds.projects.is_empty()
        || !ds.threads.is_empty()
        || !ds.messages.is_empty()
        || !ds.text_contents.is_empty()
        || !ds.versions.is_empty()
        || !ds.briefs.is_empty()
        || !ds.thread_briefs.is_empty();
    if !has_any {
        return Ok(());
    }
    let check_count = |sql: &str, expected: usize, what: &str| -> Result<(), String> {
        let n: i64 = conn
            .query_row(sql, [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if n != expected as i64 {
            return Err(format!(
                "Import verification failed: {what} count is {n}, expected {expected}"
            ));
        }
        Ok(())
    };
    // A CLEAR import replaces the whole dataset, so global counts must
    // match. A MERGE import (conflict resolution / first-run legacy
    // adoption) keeps existing rows: the per-entity checks below verify
    // everything it claimed to import.
    if strict_counts {
        check_count("SELECT COUNT(*) FROM texts", ds.texts.len(), "texts")?;
        check_count(
            "SELECT COUNT(*) FROM text_contents",
            ds.text_contents.len(),
            "text contents",
        )?;
        check_count("SELECT COUNT(*) FROM projects", ds.projects.len(), "projects")?;
        check_count(
            "SELECT COUNT(*) FROM project_briefs",
            ds.briefs.len(),
            "project briefs",
        )?;
        check_count("SELECT COUNT(*) FROM threads", ds.threads.len(), "threads")?;
        check_count(
            "SELECT COUNT(*) FROM thread_data",
            ds.thread_briefs.len(),
            "thread briefs",
        )?;
        check_count("SELECT COUNT(*) FROM messages", ds.messages.len(), "messages")?;
    }

    // Content bytes: the imported body must equal the validated source.
    for c in &ds.text_contents {
        let stored: String = conn
            .query_row(
                "SELECT content FROM text_contents WHERE text_id = ?1",
                params![c.text_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if stored != c.content {
            return Err(format!(
                "Import verification failed: content mismatch for text {}",
                c.text_id
            ));
        }
    }
    // Relationships: every message/brief/content row must reference an
    // imported row (foreign keys enforce this live; the explicit check
    // keeps verification meaningful when FKs are off in tests).
    let known: std::collections::HashSet<&str> =
        ds.threads.iter().map(|t| t.id.as_str()).collect();
    for (tid, _) in &ds.messages {
        if !known.contains(tid.as_str()) {
            return Err(format!(
                "Import verification failed: message references unknown thread {tid}"
            ));
        }
    }
    Ok(())
}

/// Move consumed legacy files into a UNIQUE `legacy/<run>` directory so the
/// originals survive, are never imported twice, and no previous archive is
/// ever overwritten. Files that cannot be moved stay in place (the marker
/// prevents re-import).
fn archive_files(dir: &Path, files: &[PathBuf]) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let base = dir.join(LEGACY_DIR);
    for attempt in 0..1000u32 {
        let run_dir = base.join(format!("{}-{}", now_unix_secs(), attempt));
        if run_dir.exists() {
            continue;
        }
        if fs::create_dir_all(&run_dir).is_err() {
            return None; // keep files in place rather than lose them
        }
        for path in files {
            let Some(name) = path.file_name() else { continue };
            let _ = fs::rename(path, run_dir.join(name));
        }
        return run_dir
            .file_name()
            .map(|n| format!("{LEGACY_DIR}/{}", n.to_string_lossy()));
    }
    None
}

/// First-run legacy import: imports once (validated, verified, marker in
/// the same transaction), then archives the source files.
fn import_legacy_if_needed(conn: &Connection, dir: &Path) -> Result<MigrationReport, String> {
    if get_meta(conn, "legacy_imported")?.is_some() {
        return Ok(MigrationReport::empty());
    }
    run_legacy_import(conn, dir, false)
}

// ──────────────────────────────────────────────
// Tauri commands
// ──────────────────────────────────────────────

/// Core of `db_init`, testable against an isolated directory. Opens (or
/// creates) the database, runs the schema migration and the one-time
/// validated legacy import.
fn init_at(dir: &Path, db: &Db) -> Result<MigrationReport, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create app data directory: {e}"))?;
    let mut guard = db.0.lock().map_err(|_| "Database lock poisoned")?;
    if guard.is_some() {
        // Already open: an idempotent no-op. Re-initializing an open
        // repository (second connection, re-running migrations) is unsafe
        // and never attempted.
        let mut report = MigrationReport::empty();
        report.already_open = true;
        return Ok(report);
    }
    let conn = open_connection(&dir.join(DB_FILE))?;
    ensure_schema(&conn)?;
    let report = import_legacy_if_needed(&conn, dir)?;
    if !report.completed {
        // The legacy migration found unusable input: do NOT open the normal
        // writable workspace (an apparently empty dataset would invite
        // writes that race the retry). The raw inputs stay in place.
        return Ok(report);
    }
    *guard = Some(conn);
    Ok(report)
}

/// Open (or create) the database, run the schema migration and the one-time
/// validated legacy import. Must be awaited before any other db command.
/// Returns a migration report (counts + any malformed/orphan material).
#[tauri::command]
pub fn db_init(app: AppHandle, db: State<Db>) -> Result<MigrationReport, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data directory: {e}"))?;
    init_at(&dir, &db)
}

#[tauri::command]
pub fn db_texts_list(db: State<Db>) -> Result<Vec<TextRow>, String> {
    with_conn(&db, texts_list)
}

#[tauri::command]
pub fn db_text_create(db: State<Db>, meta: TextRow, body: TextBody) -> Result<(), String> {
    with_conn(&db, |conn| text_create(conn, &meta, &body))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn db_text_save(
    db: State<Db>,
    id: String,
    meta: TextRow,
    body: Option<TextBody>,
    expected_rev: Option<i64>,
) -> Result<i64, String> {
    with_conn(&db, |conn| {
        text_save(conn, &id, &meta, body.as_ref(), expected_rev)
    })
}

#[tauri::command]
pub fn db_text_content(db: State<Db>, id: String) -> Result<Option<TextContentRow>, String> {
    with_conn(&db, |conn| text_content(conn, &id))
}

#[tauri::command]
pub fn db_text_versions(db: State<Db>, id: String) -> Result<Vec<VersionRow>, String> {
    with_conn(&db, |conn| text_versions(conn, &id))
}

#[tauri::command]
pub fn db_text_restore(
    db: State<Db>,
    id: String,
    version_id: String,
    now: String,
    expected_rev: Option<i64>,
) -> Result<RestoreResult, String> {
    with_conn(&db, |conn| {
        text_restore(conn, &id, &version_id, &now, expected_rev)
    })
}

/// Take a user-named snapshot of the current content. Returns the new
/// version id.
#[tauri::command]
pub fn db_text_snapshot(
    db: State<Db>,
    id: String,
    label: String,
    now: String,
) -> Result<String, String> {
    with_conn(&db, |conn| text_snapshot(conn, &id, &label, &now))
}

#[tauri::command]
pub fn db_text_delete(db: State<Db>, id: String) -> Result<(), String> {
    with_conn(&db, |conn| text_delete(conn, &id))
}

#[tauri::command]
pub fn db_projects_list(db: State<Db>) -> Result<Vec<ProjectRow>, String> {
    with_conn(&db, projects_list)
}

#[tauri::command]
pub fn db_project_create(db: State<Db>, meta: ProjectRow) -> Result<(), String> {
    with_conn(&db, |conn| project_insert(conn, &meta))
}

#[tauri::command]
pub fn db_project_save(
    db: State<Db>,
    id: String,
    meta: ProjectRow,
    brief: Option<String>,
    expected_rev: Option<i64>,
) -> Result<i64, String> {
    with_conn(&db, |conn| {
        project_save(conn, &id, &meta, brief.as_deref(), expected_rev)
    })
}

#[tauri::command]
pub fn db_project_brief(db: State<Db>, id: String) -> Result<Option<String>, String> {
    with_conn(&db, |conn| project_brief(conn, &id))
}

#[tauri::command]
pub fn db_project_delete(db: State<Db>, id: String) -> Result<Vec<AffectedChildRow>, String> {
    with_conn(&db, |conn| project_delete(conn, &id))
}

#[tauri::command]
pub fn db_threads_list(db: State<Db>) -> Result<Vec<ThreadRow>, String> {
    with_conn(&db, threads_list)
}

#[tauri::command]
pub fn db_thread_create(
    db: State<Db>,
    meta: ThreadRow,
    brief_json: Option<String>,
    messages: Vec<MessageRow>,
) -> Result<(), String> {
    with_conn(&db, |conn| {
        thread_create(conn, &meta, brief_json, &messages)
    })
}

#[tauri::command]
pub fn db_thread_get(db: State<Db>, id: String) -> Result<Option<ThreadData>, String> {
    with_conn(&db, |conn| thread_get(conn, &id))
}

#[tauri::command]
pub fn db_thread_save(
    db: State<Db>,
    id: String,
    meta: ThreadRow,
    brief_json: Option<String>,
    messages: Vec<MessageRow>,
    expected_rev: Option<i64>,
) -> Result<i64, String> {
    with_conn(&db, |conn| {
        thread_save(conn, &id, &meta, brief_json, &messages, expected_rev)
    })
}

#[tauri::command]
pub fn db_thread_append_message(
    db: State<Db>,
    id: String,
    message: MessageRow,
    updated_at: String,
) -> Result<i64, String> {
    with_conn(&db, |conn| {
        thread_append_message(conn, &id, &message, &updated_at)
    })
}

#[tauri::command]
pub fn db_thread_replace_message(
    db: State<Db>,
    id: String,
    message_id: String,
    content: String,
    incomplete: Option<String>,
    updated_at: String,
) -> Result<i64, String> {
    with_conn(&db, |conn| {
        thread_replace_message(
            conn,
            &id,
            &message_id,
            &content,
            incomplete.as_deref(),
            &updated_at,
        )
    })
}

#[tauri::command]
pub fn db_thread_rename(
    db: State<Db>,
    id: String,
    title: String,
    updated_at: String,
) -> Result<i64, String> {
    with_conn(&db, |conn| thread_rename(conn, &id, &title, &updated_at))
}

#[tauri::command]
pub fn db_text_set_state(
    db: State<Db>,
    id: String,
    archived: Option<bool>,
    pinned: Option<bool>,
    updated_at: String,
) -> Result<i64, String> {
    with_conn(&db, |conn| {
        text_set_state(conn, &id, archived, pinned, &updated_at)
    })
}

#[tauri::command]
pub fn db_thread_set_state(
    db: State<Db>,
    id: String,
    archived: Option<bool>,
    pinned: Option<bool>,
    updated_at: String,
) -> Result<i64, String> {
    with_conn(&db, |conn| {
        thread_set_state(conn, &id, archived, pinned, &updated_at)
    })
}

#[tauri::command]
pub fn db_thread_delete(db: State<Db>, id: String) -> Result<(), String> {
    with_conn(&db, |conn| thread_delete(conn, &id))
}

// ── Sources (Phase 5.1) ──

#[tauri::command]
pub fn db_sources_list(db: State<Db>) -> Result<Vec<SourceRow>, String> {
    with_conn(&db, sources_list)
}

#[tauri::command]
pub fn db_source_get(db: State<Db>, id: String) -> Result<Option<SourceData>, String> {
    with_conn(&db, |conn| source_get(conn, &id))
}

#[tauri::command]
pub fn db_source_create(
    db: State<Db>,
    source: SourceRow,
    passages: Vec<SourcePassageRow>,
) -> Result<(), String> {
    with_conn(&db, |conn| source_create(conn, &source, &passages))
}

/// Save a source. `passages: None` is a metadata-only save (stored
/// passages stay unchanged); `Some(list)` (including `Some(vec![])`)
/// intentionally replaces them.
#[tauri::command]
pub fn db_source_save(
    db: State<Db>,
    id: String,
    source: SourceRow,
    passages: Option<Vec<SourcePassageRow>>,
    expected_rev: Option<i64>,
) -> Result<i64, String> {
    with_conn(&db, |conn| {
        source_save(conn, &id, &source, passages.as_deref(), expected_rev)
    })
}

#[tauri::command]
pub fn db_source_delete(db: State<Db>, id: String) -> Result<(), String> {
    with_conn(&db, |conn| source_delete(conn, &id))
}

// ── Reviewable revision proposals (Phase 5.3) ──

fn proposals_list(conn: &Connection, document_id: &str) -> Result<Vec<ProposalRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT * FROM document_proposals WHERE document_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![document_id], row_to_proposal)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn row_to_proposal(r: &rusqlite::Row) -> rusqlite::Result<ProposalRow> {
    Ok(ProposalRow {
        id: r.get("id")?,
        document_id: r.get("document_id")?,
        base_rev: r.get("base_rev")?,
        request_kind: r.get("request_kind")?,
        base_fragment: r.get("base_fragment")?,
        proposed_fragment: r.get("proposed_fragment")?,
        sel_from: r.get("sel_from")?,
        sel_to: r.get("sel_to")?,
        context_note: r.get("context_note")?,
        status: r.get("status")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

fn proposal_create(conn: &Connection, proposal: &ProposalRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO document_proposals (id, document_id, base_rev, request_kind,
                                         base_fragment, proposed_fragment, sel_from, sel_to,
                                         context_note, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            proposal.id,
            proposal.document_id,
            proposal.base_rev,
            proposal.request_kind,
            proposal.base_fragment,
            proposal.proposed_fragment,
            proposal.sel_from,
            proposal.sel_to,
            proposal.context_note,
            proposal.status,
            proposal.created_at,
            proposal.updated_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Update a proposal's status. Accepted/rejected are terminal for this
/// proposal; stale is set by the acceptance check when the document moved.
fn proposal_set_status(
    conn: &Connection,
    id: &str,
    status: &str,
    updated_at: &str,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE document_proposals SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, status, updated_at],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("Proposal not found: {id}"));
    }
    Ok(())
}

#[tauri::command]
pub fn db_proposals_list(db: State<Db>, document_id: String) -> Result<Vec<ProposalRow>, String> {
    with_conn(&db, |conn| proposals_list(conn, &document_id))
}

#[tauri::command]
pub fn db_proposal_create(db: State<Db>, proposal: ProposalRow) -> Result<(), String> {
    with_conn(&db, |conn| proposal_create(conn, &proposal))
}

#[tauri::command]
pub fn db_proposal_set_status(
    db: State<Db>,
    id: String,
    status: String,
    updated_at: String,
) -> Result<(), String> {
    with_conn(&db, |conn| proposal_set_status(conn, &id, &status, &updated_at))
}

#[tauri::command]
pub fn db_export(db: State<Db>) -> Result<DbDump, String> {
    with_conn(&db, export_dump)
}

/// Replace the domain dataset AND the non-secret preferences in ONE
/// transaction (v2/v3 backup restore). Migration bookkeeping (app_meta)
/// is never touched by a restore. Returns the real activated counts.
#[tauri::command]
pub fn db_restore(
    db: State<Db>,
    dump: DbDump,
    prefs: Vec<PrefRow>,
) -> Result<RestoreCounts, String> {
    with_conn(&db, |conn| {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        apply_dump(&tx, &dump)?;
        tx.execute("DELETE FROM preferences", [])
            .map_err(|e| e.to_string())?;
        for p in &prefs {
            prefs_set(&tx, &p.key, &p.value)?;
        }
        let counts = restore_counts(&tx)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(counts)
    })
}

#[tauri::command]
pub fn db_prefs_get(db: State<Db>, key: String) -> Result<Option<String>, String> {
    with_conn(&db, |conn| prefs_get(conn, &key))
}

#[tauri::command]
pub fn db_prefs_get_all(db: State<Db>) -> Result<Vec<PrefRow>, String> {
    with_conn(&db, prefs_get_all)
}

#[tauri::command]
pub fn db_prefs_set(db: State<Db>, key: String, value: String) -> Result<(), String> {
    with_conn(&db, |conn| prefs_set(conn, &key, &value))
}

#[tauri::command]
pub fn db_search(db: State<Db>, query: String) -> Result<Vec<SearchHit>, String> {
    with_conn(&db, |conn| search(conn, &query))
}

/// Import legacy JSON files that are currently in the app data directory.
/// Used by the v1-backup restore path after the frontend wrote the bundle
/// files to disk. `clear` removes existing domain rows first. A malformed
/// or unreadable registry fails the import visibly (the restore aborts
/// before anything is replaced). Returns the real activated counts.
#[tauri::command]
pub fn db_import_legacy(
    app: AppHandle,
    db: State<Db>,
    clear: bool,
) -> Result<MigrationCounts, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data directory: {e}"))?;
    with_conn(&db, |conn| {
        let report = run_legacy_import(conn, &dir, clear)?;
        if !report.completed {
            return Err(format!(
                "The legacy import found unusable data: {}",
                report
                    .issues
                    .iter()
                    .map(|i| format!("{}: {}", i.path, i.kind))
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
        Ok(report.counts)
    })
}

/// Import a validated legacy dataset from an EXPLICIT scratch directory
/// under the app data directory (the conflict-resolution workflow): the
/// chosen browser copy is applied to the active SQLite database in one
/// verified transaction. Never touches the live JSON files. Returns the
/// report so callers can keep the recovery copy until the import landed.
#[tauri::command]
pub fn db_import_legacy_at(
    app: AppHandle,
    db: State<Db>,
    dir: String,
    clear: bool,
) -> Result<MigrationReport, String> {
    // The scratch directory is a simple name under the app data directory;
    // traversal/absolute paths are refused.
    if dir.is_empty()
        || dir.contains("..")
        || dir.contains('/')
        || dir.contains('\\')
        || Path::new(&dir).is_absolute()
    {
        return Err(format!("Invalid scratch directory name: {dir}"));
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data directory: {e}"))?;
    let path = base.join(dir);
    with_conn(&db, |conn| run_legacy_import(conn, &path, clear))
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Shared wire-contract fixtures (also consumed by the frontend tests).
    const CONTRACT_JSON: &str = include_str!("../../src/test/repository-contract.json");

    fn fixture(name: &str) -> serde_json::Value {
        let v: serde_json::Value = serde_json::from_str(CONTRACT_JSON).unwrap();
        v[name].clone()
    }

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        ensure_schema(&conn).expect("schema");
        conn
    }

    fn meta(id: &str) -> TextRow {
        TextRow {
            id: id.into(),
            title: "T".into(),
            text_type: "essay".into(),
            folder: None,
            project_id: None,
            snippet: None,
            word_count: None,
            rev: 0,
            archived: false,
            pinned: false,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    /// A plain markdown test body (legacy-shaped: no plain-text projection).
    fn markdown_body(content: &str) -> TextBody {
        TextBody {
            content: content.into(),
            content_format: "markdown".into(),
            content_schema_version: 1,
            plain_text: None,
        }
    }

    /// Test helper: create a text with plain markdown content.
    fn create_text(conn: &Connection, meta: &TextRow, content: &str) -> Result<(), String> {
        text_create(conn, meta, &markdown_body(content))
    }

    /// Test helper: read the raw content payload of a text.
    fn text_content_str(conn: &Connection, id: &str) -> Result<Option<String>, String> {
        Ok(text_content(conn, id)?.map(|c| c.content))
    }

    fn proj(id: &str) -> ProjectRow {
        ProjectRow {
            id: id.into(),
            title: "P".into(),
            description: None,
            default_audience: None,
            default_tone: None,
            default_citations: None,
            default_language: None,
            refs: None,
            brief_word_count: None,
            rev: 0,
            created_at: "c".into(),
            updated_at: "u".into(),
        }
    }

    fn thread(id: &str) -> ThreadRow {
        ThreadRow {
            id: id.into(),
            title: "Thread".into(),
            mode: "text".into(),
            project_id: None,
            refs: None,
            rev: 0,
            archived: false,
            pinned: false,
            created_at: "c".into(),
            updated_at: "u".into(),
        }
    }

    fn source_row(id: &str) -> SourceRow {
        SourceRow {
            id: id.into(),
            project_id: None,
            title: "S".into(),
            author: None,
            year: None,
            doi: None,
            url: None,
            language: None,
            translation: None,
            asset_ref: None,
            source_type: None,
            container_title: None,
            publisher: None,
            volume: None,
            issue: None,
            pages: None,
            abstract_text: None,
            original_text: "body".into(),
            content_hash: format!("hash-{id}"),
            extraction_status: "ready".into(),
            truncation_note: None,
            included_in_context: true,
            notes: None,
            verification: "unverified".into(),
            rev: 0,
            created_at: "c".into(),
            updated_at: "u".into(),
        }
    }

    /// Content-only domain save: reads the persisted meta first and stamps
    /// the edit time (used as the snapshot time for replaced content).
    fn save_text_content(conn: &Connection, id: &str, content: &str, saved_at: &str) -> i64 {
        let mut meta = texts_list(conn)
            .unwrap()
            .into_iter()
            .find(|t| t.id == id)
            .unwrap();
        meta.updated_at = saved_at.to_string();
        text_save(conn, id, &meta, Some(&markdown_body(content)), None).unwrap()
    }

    #[test]
    fn text_create_and_content_roundtrip() {
        let conn = mem();
        create_text(&conn, &meta("a"), "hello").unwrap();
        assert_eq!(text_content_str(&conn, "a").unwrap(), Some("hello".to_string()));
        assert_eq!(text_content_str(&conn, "missing").unwrap(), None);
    }

    #[test]
    fn text_create_twice_fails() {
        let conn = mem();
        create_text(&conn, &meta("a"), "v1").unwrap();
        assert!(create_text(&conn, &meta("a"), "v2").is_err());
        assert_eq!(text_content_str(&conn, "a").unwrap(), Some("v1".to_string()));
    }

    #[test]
    fn content_update_snapshots_replaced_content_only_when_changed() {
        let conn = mem();
        create_text(&conn, &meta("a"), "v1").unwrap();
        // Same content: no version row (the decision is made inside the
        // transaction by comparing persisted content).
        save_text_content(&conn, "a", "v1", "t1");
        assert!(text_versions(&conn, "a").unwrap().is_empty());
        // Different content: snapshots the old value.
        save_text_content(&conn, "a", "v2", "t2");
        let versions = text_versions(&conn, "a").unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].content, "v1");
        assert_eq!(text_content_str(&conn, "a").unwrap(), Some("v2".to_string()));
    }

    #[test]
    fn same_millisecond_snapshots_remain_distinguishable() {
        let conn = mem();
        create_text(&conn, &meta("a"), "v0").unwrap();
        // Both replaced snapshots stamped with the SAME timestamp: each
        // gets its own version id, neither is lost.
        save_text_content(&conn, "a", "v1", "same-ms");
        save_text_content(&conn, "a", "v2", "same-ms");
        let versions = text_versions(&conn, "a").unwrap();
        assert_eq!(versions.len(), 2);
        assert_ne!(versions[0].version_id, versions[1].version_id);
        assert_eq!(versions[0].saved_at, "same-ms");
        assert_eq!(versions[1].saved_at, "same-ms");
    }

    #[test]
    fn edit_save_save_again_does_not_lose_history() {
        let conn = mem();
        create_text(&conn, &meta("a"), "v0").unwrap();
        save_text_content(&conn, "a", "v1", "t1");
        // The frontend re-saves the SAME cached edit before the debounce
        // fired: no duplicate, and the v0 snapshot must survive.
        save_text_content(&conn, "a", "v1", "t2");
        let versions = text_versions(&conn, "a").unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].content, "v0");
        // A further edit adds a version without dropping the old one.
        save_text_content(&conn, "a", "v2", "t3");
        let versions = text_versions(&conn, "a").unwrap();
        assert_eq!(versions.len(), 2);
        assert!(versions.iter().any(|v| v.content == "v0"));
        assert!(versions.iter().any(|v| v.content == "v1"));
    }

    #[test]
    fn version_cap_keeps_only_newest_20() {
        let conn = mem();
        create_text(&conn, &meta("a"), "v0").unwrap();
        for i in 1..=25 {
            save_text_content(&conn, "a", &format!("v{i}"), &format!("t{i:03}"));
        }
        let versions = text_versions(&conn, "a").unwrap();
        assert_eq!(versions.len(), 20);
        assert_eq!(versions[0].content, "v24");
    }

    #[test]
    fn restore_by_version_id_resolves_content_inside_rust() {
        let conn = mem();
        create_text(&conn, &meta("a"), "original").unwrap();
        save_text_content(&conn, "a", "edited", "t2");
        let versions = text_versions(&conn, "a").unwrap();
        assert_eq!(versions.len(), 1);
        let original_id = versions[0].version_id.clone();

        let result = text_restore(&conn, "a", &original_id, "t3", None).unwrap();
        assert_eq!(result.content, "original");
        // The restored content keeps its original snapshot time.
        assert_eq!(result.saved_at, "t2");
        assert_eq!(text_content_str(&conn, "a").unwrap(), Some("original".to_string()));
        // The replaced content is snapshotted, so the user can step back.
        let versions = text_versions(&conn, "a").unwrap();
        assert!(versions.iter().any(|v| v.content == "edited"));
        assert_eq!(result.word_count, 1);
        assert_eq!(result.snippet, "original");
    }

    #[test]
    fn restore_wrong_or_missing_version_fails_without_mutation() {
        let conn = mem();
        create_text(&conn, &meta("a"), "v1").unwrap();
        save_text_content(&conn, "a", "v2", "t2");
        // Missing id.
        assert!(text_restore(&conn, "a", "no-such-id", "t3", None).is_err());
        // Existing version id of a DIFFERENT document.
        create_text(&conn, &meta("b"), "other").unwrap();
        save_text_content(&conn, "b", "other2", "t2");
        let b_versions = text_versions(&conn, "b").unwrap();
        assert!(text_restore(&conn, "a", &b_versions[0].version_id, "t3", None).is_err());
        // Nothing changed on a.
        assert_eq!(text_content_str(&conn, "a").unwrap(), Some("v2".to_string()));
        assert_eq!(text_versions(&conn, "a").unwrap().len(), 1);
    }

    #[test]
    fn restore_rejects_stale_expected_rev() {
        let conn = mem();
        create_text(&conn, &meta("a"), "v0").unwrap();
        save_text_content(&conn, "a", "v1", "t2");
        let versions = text_versions(&conn, "a").unwrap();
        let err = text_restore(&conn, "a", &versions[0].version_id, "t3", Some(9))
            .unwrap_err();
        assert!(err.contains("Stale revision"), "{err}");
        assert_eq!(text_content_str(&conn, "a").unwrap(), Some("v1".to_string()));
    }

    #[test]
    fn save_missing_text_is_not_recreated() {
        let conn = mem();
        let m = meta("ghost");
        let err = text_save(&conn, "ghost", &m, Some(&markdown_body("x")), None).unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert_eq!(text_content_str(&conn, "ghost").unwrap(), None);
    }

    #[test]
    fn stale_text_save_is_rejected() {
        let conn = mem();
        create_text(&conn, &meta("a"), "v1").unwrap();
        // Based on rev 5 while the row is at 0: rejected.
        let err = text_save(&conn, "a", &meta("a"), Some(&markdown_body("v2")), Some(5)).unwrap_err();
        assert!(err.contains("Stale revision"), "{err}");
        assert_eq!(text_content_str(&conn, "a").unwrap(), Some("v1".to_string()));
        // Matching revisions save and return the bumped counter.
        assert_eq!(
            text_save(&conn, "a", &meta("a"), Some(&markdown_body("v2")), Some(0)).unwrap(),
            1
        );
        assert_eq!(
            text_save(&conn, "a", &meta("a"), Some(&markdown_body("v3")), Some(1)).unwrap(),
            2
        );
        assert_eq!(text_content_str(&conn, "a").unwrap(), Some("v3".to_string()));
    }

    #[test]
    fn v3_migration_preserves_legacy_versions_and_timestamps() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO texts (id, title, text_type, created_at, updated_at)
             VALUES ('a', 'T', 'essay', 'c', 'u')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO text_versions (text_id, saved_at, content) VALUES ('a', 'ms-1', 'old1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO text_versions (text_id, saved_at, content) VALUES ('a', 'ms-2', 'old2')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();

        ensure_schema(&conn).unwrap();
        let versions = text_versions(&conn, "a").unwrap();
        assert_eq!(versions.len(), 2);
        // Timestamps and content survive the migration, and every row
        // gains a stable version id.
        assert!(versions.iter().any(|v| v.saved_at == "ms-1" && v.content == "old1"));
        assert!(versions.iter().any(|v| v.saved_at == "ms-2" && v.content == "old2"));
        assert_ne!(versions[0].version_id, versions[1].version_id);
        assert_eq!(text_content_str(&conn, "a").unwrap(), None);
    }

    #[test]
    fn project_delete_unlinks_texts_and_threads() {
        let conn = mem();
        let mut p = proj("p");
        p.refs = Some("Spivak".into());
        project_insert(&conn, &p).unwrap();
        project_save(&conn, "p", &p, Some("brief"), None).unwrap();
        let mut t = meta("a");
        t.project_id = Some("p".into());
        create_text(&conn, &t, "body").unwrap();
        let mut th = thread("th");
        th.project_id = Some("p".into());
        thread_create(&conn, &th, None, &[]).unwrap();
        let mut s = source_row("s");
        s.project_id = Some("p".into());
        source_create(&conn, &s, &[]).unwrap();

        let affected = project_delete(&conn, "p").unwrap();

        assert!(thread_get(&conn, "p").unwrap().is_none());
        assert_eq!(project_brief(&conn, "p").unwrap(), None);
        // Texts and conversations survive as standalone (no dangling refs)
        // and the unlink ADVANCES their revision: the relationship change
        // is a metadata change, so a stale client cannot save on top of
        // the pre-deletion association.
        let texts = texts_list(&conn).unwrap();
        assert_eq!(texts[0].project_id, None);
        assert_eq!(texts[0].rev, 1);
        assert_eq!(text_content_str(&conn, "a").unwrap(), Some("body".to_string()));
        let threads = threads_list(&conn).unwrap();
        assert_eq!(threads[0].project_id, None);
        assert_eq!(threads[0].rev, 1);
        assert_eq!(threads[0].refs.as_deref(), None);
        // Sources follow the same invariant: a dangling project link
        // would make the export validator reject the whole dataset.
        let sources = sources_list(&conn).unwrap();
        assert_eq!(sources[0].project_id, None);
        assert_eq!(sources[0].rev, 1);
        // The affected children are reported so the session cache can
        // refresh before the next save.
        let reported: Vec<(&str, &str, i64)> = affected
            .iter()
            .map(|a| (a.kind.as_str(), a.id.as_str(), a.rev))
            .collect();
        assert!(reported.contains(&("text", "a", 1)));
        assert!(reported.contains(&("thread", "th", 1)));
        assert!(reported.contains(&("source", "s", 1)));
        // Repeat deletion is a no-op (idempotent).
        assert!(project_delete(&conn, "p").unwrap().is_empty());
        assert_eq!(texts_list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn text_save_drops_a_dead_project_link() {
        let conn = mem();
        project_insert(&conn, &proj("p")).unwrap();
        let mut t = meta("a");
        t.project_id = Some("p".into());
        create_text(&conn, &t, "v1").unwrap();
        project_delete(&conn, "p").unwrap();

        // A stale client still saves with the deleted project in its meta:
        // the content lands, the link is dropped, the row is not recreated.
        let new_rev = text_save(&conn, "a", &t, Some(&markdown_body("v2")), None).unwrap();
        assert_eq!(new_rev, 2);
        let row = texts_list(&conn).unwrap().pop().unwrap();
        assert_eq!(row.project_id, None);
        assert_eq!(text_content_str(&conn, "a").unwrap(), Some("v2".to_string()));
    }

    #[test]
    fn thread_save_drops_a_dead_project_link() {
        let conn = mem();
        project_insert(&conn, &proj("p")).unwrap();
        let mut th = thread("th");
        th.project_id = Some("p".into());
        thread_create(&conn, &th, None, &[]).unwrap();
        project_delete(&conn, "p").unwrap();

        let new_rev = thread_save(&conn, "th", &th, None, &[], None).unwrap();
        assert_eq!(new_rev, 2);
        let row = threads_list(&conn).unwrap().pop().unwrap();
        assert_eq!(row.project_id, None);
    }

    #[test]
    fn source_save_drops_a_dead_project_link() {
        let conn = mem();
        project_insert(&conn, &proj("p")).unwrap();
        let mut s = source_row("s");
        s.project_id = Some("p".into());
        source_create(&conn, &s, &[]).unwrap();
        project_delete(&conn, "p").unwrap();

        let new_rev = source_save(&conn, "s", &s, None, None).unwrap();
        assert_eq!(new_rev, 2);
        let row = sources_list(&conn).unwrap().pop().unwrap();
        assert_eq!(row.project_id, None);
    }

    #[test]
    fn source_create_drops_a_dead_project_link() {
        let conn = mem();
        // The file extraction is async: the project can be gone by the
        // time the source lands. No dangling link may be created.
        let mut s = source_row("s");
        s.project_id = Some("missing".into());
        source_create(&conn, &s, &[]).unwrap();
        assert_eq!(sources_list(&conn).unwrap()[0].project_id, None);
    }

    #[test]
    fn creates_keep_live_project_links_and_drop_dead_ones() {
        let conn = mem();
        project_insert(&conn, &proj("p")).unwrap();
        let mut live = meta("a");
        live.project_id = Some("p".into());
        create_text(&conn, &live, "v1").unwrap();
        let mut dead = meta("b");
        dead.project_id = Some("missing".into());
        create_text(&conn, &dead, "v2").unwrap();
        let mut live_thread = thread("th-live");
        live_thread.project_id = Some("p".into());
        thread_create(&conn, &live_thread, None, &[]).unwrap();
        let mut dead_thread = thread("th-dead");
        dead_thread.project_id = Some("missing".into());
        thread_create(&conn, &dead_thread, None, &[]).unwrap();

        let texts = texts_list(&conn).unwrap();
        let by_id = |id: &str| texts.iter().find(|t| t.id == id).unwrap();
        assert_eq!(by_id("a").project_id.as_deref(), Some("p"));
        assert_eq!(by_id("b").project_id, None);
        let threads = threads_list(&conn).unwrap();
        let thread_by_id = |id: &str| threads.iter().find(|t| t.id == id).unwrap();
        assert_eq!(thread_by_id("th-live").project_id.as_deref(), Some("p"));
        assert_eq!(thread_by_id("th-dead").project_id, None);
    }

    #[test]
    fn delete_text_cascades_content_and_versions() {
        let conn = mem();
        create_text(&conn, &meta("a"), "v1").unwrap();
        save_text_content(&conn, "a", "v2", "t2");
        text_delete(&conn, "a").unwrap();
        assert_eq!(text_content_str(&conn, "a").unwrap(), None);
        assert!(text_versions(&conn, "a").unwrap().is_empty());
    }

    #[test]
    fn project_save_keeps_brief_and_needs_existing_row() {
        let conn = mem();
        let mut p = proj("p");
        project_insert(&conn, &p).unwrap();
        project_save(&conn, "p", &p, Some("the brief"), None).unwrap();
        // Rename (metadata-only save) must not wipe the brief.
        p.title = "P2".into();
        project_save(&conn, "p", &p, None, None).unwrap();
        assert_eq!(project_brief(&conn, "p").unwrap(), Some("the brief".to_string()));
        // Saving a brief for a deleted project must fail loudly, never
        // recreate the row.
        project_delete(&conn, "p").unwrap();
        let err = project_save(&conn, "p", &p, Some("x"), None).unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }

    #[test]
    fn thread_save_get_roundtrip() {
        let conn = mem();
        let t = thread("th");
        let messages = vec![
            MessageRow {
                id: None,
                role: "user".into(),
                content: "hi".into(),
                timestamp: "t1".into(),
                failed: false,
                incomplete: None,
                attachments_json: None,
            },
            MessageRow {
                id: None,
                role: "assistant".into(),
                content: "hello".into(),
                timestamp: "t2".into(),
                failed: false,
                incomplete: None,
                attachments_json: Some("[{\"name\":\"f.txt\"}]".into()),
            },
        ];
        thread_create(&conn, &t, Some("{\"topic\":\"x\"}".into()), &messages).unwrap();
        let data = thread_get(&conn, "th").unwrap().unwrap();
        assert_eq!(data.messages.len(), 2);
        assert_eq!(data.rev, 0);
        assert_eq!(data.brief_json.as_deref(), Some("{\"topic\":\"x\"}"));
        assert_eq!(data.messages[1].attachments_json.as_deref(), Some("[{\"name\":\"f.txt\"}]"));

        // Saving fewer messages replaces the set (no leftovers).
        thread_save(&conn, "th", &t, None, &messages[..1], None).unwrap();
        let data = thread_get(&conn, "th").unwrap().unwrap();
        assert_eq!(data.messages.len(), 1);
        assert_eq!(data.brief_json, None);
        assert_eq!(data.rev, 1);
    }

    #[test]
    fn incomplete_marker_survives_thread_roundtrips() {
        let conn = mem();
        let t = thread("th");
        thread_create(
            &conn,
            &t,
            None,
            &[MessageRow {
                id: Some("m1".into()),
                role: "assistant".into(),
                content: "partial answer".into(),
                timestamp: "t1".into(),
                failed: false,
                incomplete: Some("interrupted".into()),
                attachments_json: None,
            }],
        )
        .unwrap();
        let data = thread_get(&conn, "th").unwrap().unwrap();
        assert_eq!(data.messages[0].incomplete.as_deref(), Some("interrupted"));

        // Regeneration replaces the content and CLEARS the marker.
        thread_replace_message(&conn, "th", "m1", "complete answer", None, "t2").unwrap();
        let data = thread_get(&conn, "th").unwrap().unwrap();
        assert_eq!(data.messages[0].content, "complete answer");
        assert!(data.messages[0].incomplete.is_none());

        // A truncated replacement sets it again.
        thread_replace_message(&conn, "th", "m1", "cut off", Some("truncated"), "t3").unwrap();
        let data = thread_get(&conn, "th").unwrap().unwrap();
        assert_eq!(data.messages[0].incomplete.as_deref(), Some("truncated"));

        // Export → apply_dump → export is exact (the backup contract).
        let dump = export_dump(&conn).unwrap();
        let conn2 = mem();
        let tx = conn2.unchecked_transaction().unwrap();
        apply_dump(&tx, &dump).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            serde_json::to_value(export_dump(&conn2).unwrap()).unwrap(),
            serde_json::to_value(&dump).unwrap()
        );
    }

    #[test]
    fn unsupported_incomplete_marker_fails_restore() {
        let conn = mem();
        create_text(&conn, &meta("keep"), "body").unwrap();
        let dump = DbDump {
            threads: vec![thread("t")],
            messages: vec![StoredMessageRow {
                thread_id: "t".into(),
                idx: 0,
                message: MessageRow {
                    id: Some("m".into()),
                    role: "assistant".into(),
                    content: "x".into(),
                    timestamp: "t".into(),
                    failed: false,
                    incomplete: Some("mystery".into()),
                    attachments_json: None,
                },
            }],
            ..Default::default()
        };
        let tx = conn.unchecked_transaction().unwrap();
        let err = apply_dump(&tx, &dump).unwrap_err();
        assert!(err.contains("incomplete marker"), "{err}");
        drop(tx); // rollback: the failed restore changed nothing
        assert_eq!(text_content_str(&conn, "keep").unwrap().as_deref(), Some("body"));
    }

    #[test]
    fn thread_append_bumps_rev_and_invalidates_stale_whole_thread_save() {
        let conn = mem();
        let t = thread("th");
        thread_create(&conn, &t, None, &[]).unwrap();
        let m = MessageRow {
            id: None,
            role: "assistant".into(),
            content: "late reply".into(),
            timestamp: "t9".into(),
            failed: false,
            incomplete: None,
            attachments_json: None,
        };
        thread_append_message(&conn, "th", &m, "t9").unwrap();

        // A whole-thread save scheduled before the append (expected rev 0)
        // is rejected — it must not silently remove the appended reply.
        let err = thread_save(&conn, "th", &t, None, &[], Some(0)).unwrap_err();
        assert!(err.contains("Stale revision"), "{err}");
        let data = thread_get(&conn, "th").unwrap().unwrap();
        assert_eq!(data.messages.len(), 1);
        assert_eq!(data.messages[0].content, "late reply");

        // A fresh save (rev 1) succeeds.
        thread_save(&conn, "th", &t, None, &[], Some(1)).unwrap();
        let data = thread_get(&conn, "th").unwrap().unwrap();
        assert_eq!(data.messages.len(), 0);
    }

    #[test]
    fn save_missing_thread_is_not_recreated() {
        let conn = mem();
        let t = thread("ghost");
        let err = thread_save(&conn, "ghost", &t, None, &[], None).unwrap_err();
        assert!(err.contains("not found"), "{err}");
        let err = thread_append_message(
            &conn,
            "ghost",
            &MessageRow {
                id: None,
                role: "assistant".into(),
                content: "x".into(),
                timestamp: "t".into(),
                failed: false,
                incomplete: None,
                attachments_json: None,
            },
            "t",
        )
        .unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert!(thread_get(&conn, "ghost").unwrap().is_none());
    }

    #[test]
    fn replace_message_by_id_updates_content_and_rev() {
        let conn = mem();
        let t = thread("th");
        let messages = vec![MessageRow {
            id: Some("msg-1".into()),
            role: "assistant".into(),
            content: "first draft".into(),
            timestamp: "t1".into(),
            failed: false,
            incomplete: None,
            attachments_json: None,
        }];
        thread_create(&conn, &t, None, &messages).unwrap();
        let new_rev = thread_replace_message(&conn, "th", "msg-1", "regenerated", None, "t2").unwrap();
        assert_eq!(new_rev, 1);
        let data = thread_get(&conn, "th").unwrap().unwrap();
        assert_eq!(data.messages[0].content, "regenerated");
        assert_eq!(data.messages[0].id.as_deref(), Some("msg-1"));
        // Unknown message id fails without mutation.
        let err = thread_replace_message(&conn, "th", "ghost", "x", None, "t3").unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert_eq!(thread_get(&conn, "th").unwrap().unwrap().messages[0].content, "regenerated");
    }

    #[test]
    fn schema_newer_than_supported_is_rejected() {
        let conn = mem();
        conn.pragma_update(None, "user_version", SUPPORTED_SCHEMA_VERSION + 1)
            .unwrap();
        let err = ensure_schema(&conn).unwrap_err();
        assert!(err.contains("newer"), "{err}");
    }

    #[test]
    fn export_import_roundtrip() {
        let conn = mem();
        create_text(&conn, &meta("a"), "hello").unwrap();
        save_text_content(&conn, "a", "v2", "t2");
        let p = proj("p");
        project_insert(&conn, &p).unwrap();
        project_save(&conn, "p", &p, Some("brief"), None).unwrap();
        let t = thread("th");
        let m = MessageRow {
            id: None,
            role: "user".into(),
            content: "hi".into(),
            timestamp: "t1".into(),
            failed: false,
            incomplete: None,
            attachments_json: None,
        };
        thread_create(&conn, &t, Some("{\"a\":1}".into()), &[m]).unwrap();

        let dump = export_dump(&conn).unwrap();
        assert_eq!(dump.texts.len(), 1);
        assert_eq!(dump.text_versions.len(), 1);
        assert_eq!(dump.project_briefs.len(), 1);
        assert_eq!(dump.messages.len(), 1);

        // Import into a second database.
        let conn2 = mem();
        let tx = conn2.unchecked_transaction().unwrap(); apply_dump(&tx, &dump).unwrap(); tx.commit().unwrap();
        assert_eq!(text_content_str(&conn2, "a").unwrap(), Some("v2".to_string()));
        assert_eq!(project_brief(&conn2, "p").unwrap(), Some("brief".to_string()));
        let data = thread_get(&conn2, "th").unwrap().unwrap();
        assert_eq!(data.messages.len(), 1);
        assert_eq!(data.brief_json.as_deref(), Some("{\"a\":1}"));
    }

    #[test]
    fn legacy_import_reads_old_shapes_and_archives() {
        let conn = mem();
        let dir = std::env::temp_dir().join(format!("dws-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, body: &str| {
            fs::write(dir.join(name), body).unwrap();
        };
        write(
            "library.json",
            r#"[{"id":"a","title":"Essay","textType":"essay","createdAt":"c","updatedAt":"u"}]"#,
        );
        write("text_a.json", r#"{"content":"body text"}"#);
        write(
            "text_a.versions.json",
            r#"[{"savedAt":"s1","content":"old body"}]"#,
        );
        write(
            "projects.json",
            r#"[{"id":"p","title":"Proj","createdAt":"c","updatedAt":"u"}]"#,
        );
        write("project_p.json", r#"{"content":"project brief"}"#);
        write(
            "threads.json",
            r#"[{"id":"th","title":"Chat","mode":"text","createdAt":"c","updatedAt":"u"}]"#,
        );
        // Old bare-array thread shape.
        write(
            "chat_th.json",
            r#"[{"role":"user","content":"hi","timestamp":"t1"}]"#,
        );

        let report = run_legacy_import(&conn, &dir, false).unwrap();
        assert!(report.completed, "import must complete on valid data");
        assert_eq!(report.counts.texts, 1);
        assert_eq!(report.counts.projects, 1);
        assert_eq!(report.counts.threads, 1);
        assert_eq!(report.counts.messages, 1);
        assert_eq!(report.counts.versions, 1);
        assert_eq!(report.issues.len(), 0);
        assert_eq!(text_content_str(&conn, "a").unwrap(), Some("body text".to_string()));
        let versions = text_versions(&conn, "a").unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(project_brief(&conn, "p").unwrap(), Some("project brief".to_string()));
        let data = thread_get(&conn, "th").unwrap().unwrap();
        assert_eq!(data.messages.len(), 1);
        assert_eq!(data.brief_json, None);

        let archived = report.archived_dir.expect("files archived");
        let run_dir = dir.join(&archived);
        assert!(run_dir.join("library.json").is_file());
        assert!(!dir.join("library.json").exists());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn import_legacy_clear_replaces_domain_data() {
        let conn = mem();
        create_text(&conn, &meta("old"), "old body").unwrap();
        let dir = std::env::temp_dir().join(format!("dws-test-clear-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("library.json"),
            r#"[{"id":"new","title":"New","textType":"other","createdAt":"c","updatedAt":"u"}]"#,
        )
        .unwrap();
        fs::write(dir.join("text_new.json"), r#"{"content":"new body"}"#).unwrap();
        let report = run_legacy_import(&conn, &dir, true).unwrap();
        assert!(report.completed);
        assert_eq!(text_content_str(&conn, "old").unwrap(), None);
        assert_eq!(text_content_str(&conn, "new").unwrap(), Some("new body".to_string()));
        fs::remove_dir_all(&dir).ok();
    }

    // ── Validated migration (R4) ──

    /// A malformed REGISTRY aborts the migration: no marker, no archive,
    /// no import, files exactly where they were.
    #[test]
    fn malformed_registry_prevents_marker_and_touches_nothing() {
        let conn = mem();
        let dir = std::env::temp_dir().join(format!("dws-test-malformed-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("library.json"), "{not valid json").unwrap();
        fs::write(dir.join("text_a.json"), r#"{"content":"body"}"#).unwrap();

        let report = run_legacy_import(&conn, &dir, false).unwrap();
        assert!(!report.completed);
        assert!(report.issues.iter().any(|i| i.kind == "malformed" && i.path == "library.json"));
        // Marker not set → the next launch retries.
        assert_eq!(get_meta(&conn, "legacy_imported").unwrap(), None);
        // Nothing imported, files untouched.
        assert_eq!(text_content_str(&conn, "a").unwrap(), None);
        assert!(dir.join("text_a.json").is_file());
        fs::remove_dir_all(&dir).ok();
    }

    /// An unreadable content file is reported, the file is preserved, and
    /// the rest still imports.
    #[test]
    fn unreadable_content_file_is_reported_and_preserved() {
        let conn = mem();
        let dir =
            std::env::temp_dir().join(format!("dws-test-unreadable-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("library.json"),
            r#"[{"id":"a","title":"Essay","textType":"essay","createdAt":"c","updatedAt":"u"}]"#,
        )
        .unwrap();
        // A directory where the content file should be → read fails.
        fs::create_dir_all(dir.join("text_a.json")).unwrap();

        let report = run_legacy_import(&conn, &dir, false).unwrap();
        assert!(report.completed);
        assert!(report.issues.iter().any(|i| i.path == "text_a.json"));
        // The registry row still imported (content is missing optional data).
        assert_eq!(text_content_str(&conn, "a").unwrap(), None);
        // The raw input was NOT deleted.
        assert!(dir.join("text_a.json").is_dir());
        fs::remove_dir_all(&dir).ok();
    }

    /// Orphan body/history files are inventoried and left in place.
    #[test]
    fn orphan_files_are_inventoried_not_imported() {
        let conn = mem();
        let dir = std::env::temp_dir().join(format!("dws-test-orphan-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("library.json"), "[]").unwrap();
        fs::write(dir.join("text_ghost.json"), r#"{"content":"orphan body"}"#).unwrap();

        let report = run_legacy_import(&conn, &dir, false).unwrap();
        assert!(report.completed);
        let orphan = report
            .issues
            .iter()
            .find(|i| i.kind == "orphan" && i.path == "text_ghost.json");
        assert!(orphan.is_some(), "orphan must appear in the report");
        assert!(dir.join("text_ghost.json").is_file());
        assert_eq!(text_content_str(&conn, "ghost").unwrap(), None);
        fs::remove_dir_all(&dir).ok();
    }

    /// Ids that could escape the data directory are rejected as records;
    /// no path is ever constructed from them.
    #[test]
    fn unsafe_ids_are_rejected_before_path_construction() {
        let conn = mem();
        let dir = std::env::temp_dir().join(format!("dws-test-unsafe-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("library.json"),
            r#"[{"id":"../../evil","title":"Evil","textType":"other","createdAt":"c","updatedAt":"u"}]"#,
        )
        .unwrap();
        let report = run_legacy_import(&conn, &dir, false).unwrap();
        assert!(report.completed);
        assert!(report
            .issues
            .iter()
            .any(|i| i.kind == "invalid-record" && i.path == "library.json"));
        assert_eq!(texts_list(&conn).unwrap().len(), 0);
        fs::remove_dir_all(&dir).ok();
    }

    /// Unicode content and legacy array-shaped conversations retain data.
    #[test]
    fn unicode_and_legacy_array_threads_survive_import() {
        let conn = mem();
        let dir = std::env::temp_dir().join(format!("dws-test-unicode-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("library.json"),
            r#"[{"id":"u1","title":"Ça — 東京","textType":"other","createdAt":"c","updatedAt":"u"}]"#,
        )
        .unwrap();
        fs::write(dir.join("text_u1.json"), "{\"content\":\"Café — 東京 🌍 combien?\"}").unwrap();
        fs::write(
            dir.join("threads.json"),
            r#"[{"id":"th1","title":"Chat","createdAt":"c","updatedAt":"u"}]"#,
        )
        .unwrap();
        fs::write(
            dir.join("chat_th1.json"),
            r#"[{"role":"user","content":"東京 backslash \\ quote \" ok"}]"#,
        )
        .unwrap();

        let report = run_legacy_import(&conn, &dir, false).unwrap();
        assert!(report.completed);
        assert_eq!(
            text_content_str(&conn, "u1").unwrap(),
            Some("Café — 東京 🌍 combien?".to_string())
        );
        let data = thread_get(&conn, "th1").unwrap().unwrap();
        assert_eq!(data.messages[0].content, "東京 backslash \\ quote \" ok");
        fs::remove_dir_all(&dir).ok();
    }

    /// Repeating initialization never duplicates or overwrites imported
    /// data (marker inside the import transaction).
    #[test]
    fn repeated_initialization_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("dws-test-idem-{}", std::process::id()));
        // PIDs are recycled: never trust a leftover directory from an
        // earlier (crashed) run with the same pid.
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("library.json"),
            r#"[{"id":"a","title":"Essay","textType":"essay","createdAt":"c","updatedAt":"u"}]"#,
        )
        .unwrap();
        fs::write(dir.join("text_a.json"), r#"{"content":"body"}"#).unwrap();

        let db = Db::default();
        let report1 = init_at(&dir, &db).unwrap();
        assert!(report1.completed);
        assert_eq!(report1.counts.texts, 1);

        // Second init on the SAME open repository: idempotent no-op.
        let report2 = init_at(&dir, &db).unwrap();
        assert!(report2.already_open);
        assert_eq!(report2.counts.texts, 0);

        {
            let guard = db.0.lock().unwrap();
            let conn = guard.as_ref().unwrap();
            assert_eq!(texts_list(conn).unwrap().len(), 1);
            assert_eq!(text_content_str(conn, "a").unwrap(), Some("body".to_string()));
        }

        // A fresh open (as after a restart) finds the marker and imports
        // nothing again.
        drop(db);
        let db2 = Db::default();
        let report3 = init_at(&dir, &db2).unwrap();
        assert!(report3.completed);
        assert_eq!(report3.counts.texts, 0);
        {
            let guard = db2.0.lock().unwrap();
            let conn = guard.as_ref().unwrap();
            assert_eq!(texts_list(conn).unwrap().len(), 1);
        }
        fs::remove_dir_all(&dir).ok();
    }

    /// Archives go to unique per-run directories; earlier archives are
    /// never overwritten.
    #[test]
    fn archives_use_unique_directories() {
        let dir = std::env::temp_dir().join(format!("dws-test-arch-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let files1 = vec![dir.join("library.json")];
        fs::write(&files1[0], "[]").unwrap();
        let dir1 = archive_files(&dir, &files1).unwrap();

        // Re-create and archive again (as a second run would).
        fs::write(&files1[0], "[]").unwrap();
        let dir2 = archive_files(&dir, &files1).unwrap();

        assert_ne!(dir1, dir2);
        assert!(dir.join(&dir1).join("library.json").is_file());
        assert!(dir.join(&dir2).join("library.json").is_file());
        fs::remove_dir_all(&dir).ok();
    }

    // ── Wire-contract (R1): fixtures shared with the frontend tests ──

    /// The exact payload the frontend's createThread()/threadUpsertMeta
    /// produces (see repository.test.ts) must deserialize into Rust.
    #[test]
    fn contract_thread_meta_fixture_deserializes() {
        let row: ThreadRow = serde_json::from_value(fixture("threadMeta")).unwrap();
        assert_eq!(row.mode, "text");
        assert_eq!(
            row.refs.as_deref(),
            Some("Fanon, Black Skin, White Masks (1952).")
        );
        // Serializes under the canonical wire name, never the internal one.
        let back = serde_json::to_value(&row).unwrap();
        assert_eq!(
            back.get("references").and_then(|v| v.as_str()),
            Some("Fanon, Black Skin, White Masks (1952).")
        );
        assert!(back.get("refs").is_none());
    }

    #[test]
    fn contract_thread_meta_project_fixture_deserializes() {
        let row: ThreadRow = serde_json::from_value(fixture("threadMetaProject")).unwrap();
        assert_eq!(row.mode, "project");
        assert_eq!(row.project_id.as_deref(), Some("p-1"));
        assert_eq!(row.refs, None);
    }

    /// Existing v2 dumps spell the field `refs` and may omit `mode`.
    #[test]
    fn contract_legacy_refs_alias_and_missing_mode() {
        let row: ThreadRow = serde_json::from_value(fixture("threadMetaLegacy")).unwrap();
        assert_eq!(row.mode, "text");
        assert_eq!(row.refs.as_deref(), Some("Said, Orientalism (1978)."));
    }

    #[test]
    fn contract_project_meta_fixture_deserializes() {
        let row: ProjectRow = serde_json::from_value(fixture("projectMeta")).unwrap();
        assert_eq!(
            row.refs.as_deref(),
            Some("Spivak, Can the Subaltern Speak? (1988).")
        );
        assert_eq!(row.default_audience.as_deref(), Some("academics"));
        assert_eq!(row.brief_word_count, None);
        let legacy: ProjectRow = serde_json::from_value(fixture("projectMetaLegacy")).unwrap();
        assert_eq!(
            legacy.refs.as_deref(),
            Some("Césaire, Discourse on Colonialism (1950).")
        );
        assert_eq!(legacy.default_audience, None);
        let back = serde_json::to_value(&legacy).unwrap();
        assert!(back.get("refs").is_none());
        assert_eq!(
            back.get("references").and_then(|v| v.as_str()),
            Some("Césaire, Discourse on Colonialism (1950).")
        );
    }

    #[test]
    fn contract_text_meta_fixture_deserializes() {
        let row: TextRow = serde_json::from_value(fixture("textMeta")).unwrap();
        assert_eq!(row.project_id.as_deref(), Some("p-1"));
        assert_eq!(row.word_count, Some(1200));
        assert_eq!(row.folder, None);
        assert_eq!(row.snippet, None);
    }

    /// References survive create → read → export → import on both rows.
    #[test]
    fn references_survive_create_read_export_import() {
        let conn = mem();
        let mut p = proj("p");
        p.refs = Some("Spivak".into());
        project_insert(&conn, &p).unwrap();
        let mut t = thread("th");
        t.refs = Some("Fanon".into());
        t.project_id = Some("p".into());
        thread_create(&conn, &t, None, &[]).unwrap();

        // Read back.
        assert_eq!(projects_list(&conn).unwrap()[0].refs.as_deref(), Some("Spivak"));
        assert_eq!(threads_list(&conn).unwrap()[0].refs.as_deref(), Some("Fanon"));

        // Export serializes the canonical wire name...
        let dump = export_dump(&conn).unwrap();
        let dump_json = serde_json::to_string(&dump).unwrap();
        assert!(dump_json.contains(r#""references":"Spivak""#));
        assert!(dump_json.contains(r#""references":"Fanon""#));
        assert!(!dump_json.contains(r#""refs""#));

        // ...and a roundtrip through import preserves everything.
        let conn2 = mem();
        let tx = conn2.unchecked_transaction().unwrap(); apply_dump(&tx, &dump).unwrap(); tx.commit().unwrap();
        let p2 = &projects_list(&conn2).unwrap()[0];
        assert_eq!(p2.refs.as_deref(), Some("Spivak"));
        let t2 = &threads_list(&conn2).unwrap()[0];
        assert_eq!(t2.refs.as_deref(), Some("Fanon"));
        assert_eq!(t2.mode, "text");
        assert_eq!(t2.project_id.as_deref(), Some("p"));

        // A metadata update from fresh rows must not clear references.
        t.updated_at = "u2".into();
        thread_save(&conn2, "th", &t, None, &[], None).unwrap();
        assert_eq!(threads_list(&conn2).unwrap()[0].refs.as_deref(), Some("Fanon"));
        p.title = "P2".into();
        project_save(&conn2, "p", &p, None, None).unwrap();
        assert_eq!(projects_list(&conn2).unwrap()[0].refs.as_deref(), Some("Spivak"));
    }

    /// An existing v2 dump whose rows spell `refs` (and lack optional
    /// fields) still imports.
    #[test]
    fn legacy_v2_dump_with_refs_imports() {
        let conn = mem();
        let dump: DbDump = serde_json::from_str(
            r#"{
              "texts": [],
              "textContents": [],
              "textVersions": [],
              "projects": [
                {"id":"p","title":"P","refs":"Césaire","createdAt":"c","updatedAt":"u"}
              ],
              "projectBriefs": [],
              "threads": [
                {"id":"th","title":"T","refs":"Fanon","createdAt":"c","updatedAt":"u"}
              ],
              "threadBriefs": [],
              "messages": []
            }"#,
        )
        .unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        apply_dump(&tx, &dump).unwrap();
        tx.commit().unwrap();
        assert_eq!(projects_list(&conn).unwrap()[0].refs.as_deref(), Some("Césaire"));
        let t = &threads_list(&conn).unwrap()[0];
        assert_eq!(t.refs.as_deref(), Some("Fanon"));
        assert_eq!(t.mode, "text");
    }

    /// A restore REPLACES everything: missing optional content must not
    /// inherit newer live content, preferences commit in the same
    /// transaction, and the reported counts are real.
    #[test]
    fn restore_replaces_domain_and_prefs_in_one_transaction() {
        let conn = mem();
        // Live data that must NOT survive or be inherited from.
        create_text(&conn, &meta("a"), "newer live body").unwrap();
        prefs_set(&conn, "config", r#"{"provider":"zen","apiKey":"old"}"#).unwrap();

        let dump: DbDump = serde_json::from_str(
            r#"{
              "texts": [
                {"id":"b","title":"Restored","textType":"other","createdAt":"c","updatedAt":"u"}
              ],
              "textContents": [],
              "textVersions": [],
              "projects": [],
              "projectBriefs": [],
              "threads": [],
              "threadBriefs": [],
              "messages": []
            }"#,
        )
        .unwrap();

        let tx = conn.unchecked_transaction().unwrap();
        apply_dump(&tx, &dump).unwrap();
        tx.execute("DELETE FROM preferences", []).unwrap();
        prefs_set(&tx, "config", r#"{"provider":"zen","apiKey":""}"#).unwrap();
        let counts = restore_counts(&tx).unwrap();
        assert_eq!(counts.texts, 1);
        assert_eq!(counts.threads, 0);
        tx.commit().unwrap();

        // Live content is gone; the restored text (no content row) does
        // NOT inherit it.
        assert_eq!(text_content_str(&conn, "a").unwrap(), None);
        assert_eq!(text_content_str(&conn, "b").unwrap(), None);
        assert_eq!(texts_list(&conn).unwrap()[0].id, "b");
        // Preferences replaced in the same commit.
        assert_eq!(
            prefs_get(&conn, "config").unwrap().as_deref(),
            Some(r#"{"provider":"zen","apiKey":""}"#)
        );
    }

    #[test]
    fn prefs_get_set_roundtrip() {
        let conn = mem();
        assert_eq!(prefs_get(&conn, "settings").unwrap(), None);
        prefs_set(&conn, "settings", r#"{"theme":"light"}"#).unwrap();
        prefs_set(&conn, "settings", r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(
            prefs_get(&conn, "settings").unwrap().as_deref(),
            Some(r#"{"theme":"dark"}"#)
        );
        prefs_set(&conn, "config", r#"{"provider":"zen"}"#).unwrap();
        let all = prefs_get_all(&conn).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].key, "config");
        assert_eq!(all[1].key, "settings");
    }

    // ── R11: real temporary SQLite databases (no in-memory shortcuts) ──

    /// The isolated native smoke test: fresh startup, create conversation,
    /// create project with references, save/edit/reopen a document, restore
    /// history, export, and restore a backup — all against a real temp
    /// SQLite file, then reopened after "shutdown".
    #[test]
    fn fts5_support_available_in_bundled_build() {
        // Verify FIRST (Phase 3.3): full-text search builds on FTS5.
        let conn = mem();
        let ok = conn
            .execute("CREATE VIRTUAL TABLE fts_probe USING fts5(content)", [])
            .is_ok();
        assert!(
            ok,
            "The bundled SQLite build must support FTS5 for full-text search"
        );
    }

    // ── Full-text search (R: 3.3) ──

    #[test]
    fn search_finds_documents_conversations_and_briefs() {
        let conn = mem();
        create_text(&conn, &meta("a"), "on extractive citation practices").unwrap();
        let p = proj("p");
        project_insert(&conn, &p).unwrap();
        project_save(&conn, "p", &p, Some("brief about subaltern archives"), None).unwrap();
        let th = thread("th");
        thread_create(&conn, &th, None, &[]).unwrap();
        thread_append_message(
            &conn,
            "th",
            &MessageRow {
                id: None,
                role: "user".into(),
                content: "question about orientalism".into(),
                timestamp: "t1".into(),
                failed: false,
                incomplete: None,
                attachments_json: None,
            },
            "u",
        )
        .unwrap();

        // Body matches, all three kinds.
        let hits = search(&conn, "citation").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "text");
        assert_eq!(hits[0].doc_id, "a");
        assert!(!hits[0].title.is_empty());

        let hits = search(&conn, "subaltern").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "project");

        let hits = search(&conn, "orientalism").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "thread");

        // Title matches too.
        let hits = search(&conn, "T").unwrap();
        assert!(hits.iter().any(|h| h.kind == "text" && h.title == "T"));
    }

    #[test]
    fn search_index_follows_writes_and_deletes_transactionally() {
        let conn = mem();
        create_text(&conn, &meta("a"), "initial words").unwrap();
        assert_eq!(search(&conn, "initial").unwrap().len(), 1);

        // A content edit REPLACES the index entry (no duplicates).
        save_text_content(&conn, "a", "replaced words", "t2");
        let hits = search(&conn, "initial").unwrap();
        assert_eq!(hits.len(), 0, "old body must leave the index");
        assert_eq!(search(&conn, "replaced").unwrap().len(), 1);

        // A rename keeps the body hit but updates the title.
        let mut m = texts_list(&conn).unwrap().remove(0);
        m.title = "Renamed".into();
        text_save(&conn, "a", &m, None, None).unwrap();
        assert_eq!(search(&conn, "replaced").unwrap()[0].title, "Renamed");

        // Deleting the document removes it from the index.
        text_delete(&conn, "a").unwrap();
        assert_eq!(search(&conn, "replaced").unwrap().len(), 0);

        // Thread message rewrites (whole-thread save) stay in sync.
        let th = thread("th");
        thread_create(&conn, &th, None, &[]).unwrap();
        thread_append_message(
            &conn,
            "th",
            &MessageRow {
                id: None,
                role: "user".into(),
                content: "find me quickly".into(),
                timestamp: "t".into(),
                failed: false,
                incomplete: None,
                attachments_json: None,
            },
            "u",
        )
        .unwrap();
        assert_eq!(search(&conn, "quickly").unwrap().len(), 1);
        thread_save(&conn, "th", &th, None, &[], None).unwrap();
        assert_eq!(search(&conn, "quickly").unwrap().len(), 0);
        thread_delete(&conn, "th").unwrap();
        assert_eq!(search(&conn, "quickly").unwrap().len(), 0);
    }

    /// Stable-id message replacement must move the FTS entry: the OLD
    /// text stops matching, the NEW text matches, and the thread's other
    /// messages stay searchable (B21e).
    #[test]
    fn replaced_message_is_searchable_only_under_its_new_text() {
        let conn = mem();
        let mut th = thread("th");
        th.title = "Conversation".into();
        thread_create(
            &conn,
            &th,
            None,
            &[
                MessageRow {
                    id: Some("m1".into()),
                    role: "assistant".into(),
                    content: "zanzibar original".into(),
                    timestamp: "t1".into(),
                    failed: false,
                    incomplete: None,
                    attachments_json: None,
                },
                MessageRow {
                    id: Some("m2".into()),
                    role: "user".into(),
                    content: "sibling question".into(),
                    timestamp: "t2".into(),
                    failed: false,
                    incomplete: None,
                    attachments_json: None,
                },
            ],
        )
        .unwrap();
        assert_eq!(search(&conn, "zanzibar").unwrap().len(), 1);
        assert_eq!(search(&conn, "sibling").unwrap().len(), 1);

        thread_replace_message(&conn, "th", "m1", "kaleidoscope replacement", None, "t3")
            .unwrap();

        assert_eq!(
            search(&conn, "zanzibar").unwrap().len(),
            0,
            "the replaced body must leave the search index"
        );
        assert_eq!(
            search(&conn, "kaleidoscope").unwrap().len(),
            1,
            "the new body must be searchable"
        );
        assert_eq!(
            search(&conn, "sibling").unwrap().len(),
            1,
            "the replacement must not unindex the thread's other messages"
        );
    }

    /// Deleting one message must not unindex the thread's remaining
    /// messages (the pre-B21e delete trigger removed every row for the
    /// thread). Whole-thread rewrites and thread deletes still clear
    /// exactly what they should.
    #[test]
    fn deleting_one_message_keeps_the_others_searchable() {
        let conn = mem();
        let th = thread("th");
        thread_create(
            &conn,
            &th,
            None,
            &[
                MessageRow {
                    id: Some("m1".into()),
                    role: "assistant".into(),
                    content: "zanzibar original".into(),
                    timestamp: "t1".into(),
                    failed: false,
                    incomplete: None,
                    attachments_json: None,
                },
                MessageRow {
                    id: Some("m2".into()),
                    role: "user".into(),
                    content: "sibling question".into(),
                    timestamp: "t2".into(),
                    failed: false,
                    incomplete: None,
                    attachments_json: None,
                },
            ],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM messages WHERE thread_id = 'th' AND msg_id = 'm1'",
            [],
        )
        .unwrap();

        assert_eq!(search(&conn, "zanzibar").unwrap().len(), 0);
        assert_eq!(search(&conn, "sibling").unwrap().len(), 1);

        thread_delete(&conn, "th").unwrap();
        assert_eq!(search(&conn, "sibling").unwrap().len(), 0);
    }

    #[test]
    fn search_handles_unicode_and_malformed_queries() {
        let conn = mem();
        create_text(&conn, &meta("a"), "Café — 東京 concretismo").unwrap();
        assert_eq!(search(&conn, "東京").unwrap().len(), 1);
        assert_eq!(search(&conn, "café").unwrap().len(), 1);
        // Malformed FTS operators are quoted away, not passed through.
        assert_eq!(search(&conn, "\" (NEAR").unwrap().len(), 0);
        assert_eq!(search(&conn, "").unwrap().len(), 0);
        assert_eq!(search(&conn, "   ").unwrap().len(), 0);
    }

    // ── Document format contract (Phase 4.1) ──

    /// A rich body: the payload is serialized ProseMirror JSON; the plain
    /// text is a separate derived projection.
    fn rich_body(payload: &str, plain_text: &str) -> TextBody {
        TextBody {
            content: payload.into(),
            content_format: "tiptap-json".into(),
            content_schema_version: 1,
            plain_text: Some(plain_text.into()),
        }
    }

    #[test]
    fn document_body_fields_roundtrip_through_create_save_restore() {
        let conn = mem();
        let rich = rich_body(r#"{"type":"doc"}"#, "first rich text");
        create_text(&conn, &meta("a"), "markdown original").unwrap();
        // Save a rich body: the replaced MARKDOWN body is snapshotted with
        // its own format fields.
        let mut m = texts_list(&conn).unwrap().remove(0);
        m.updated_at = "t1".into();
        text_save(&conn, "a", &m, Some(&rich), None).unwrap();

        let stored = text_content(&conn, "a").unwrap().unwrap();
        assert_eq!(stored.content, rich.content);
        assert_eq!(stored.content_format.as_deref(), Some("tiptap-json"));
        assert_eq!(stored.content_schema_version, Some(1));
        assert_eq!(stored.plain_text.as_deref(), Some("first rich text"));

        let versions = text_versions(&conn, "a").unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].content, "markdown original");
        assert_eq!(versions[0].content_format.as_deref(), Some("markdown"));
        assert_eq!(versions[0].content_schema_version, Some(1));

        // Restore the markdown version: its format fields come back with it.
        let result = text_restore(&conn, "a", &versions[0].version_id, "t2", None).unwrap();
        assert_eq!(result.content, "markdown original");
        assert_eq!(result.content_format.as_deref(), Some("markdown"));
        assert_eq!(result.plain_text, None);
        let stored = text_content(&conn, "a").unwrap().unwrap();
        assert_eq!(stored.content_format.as_deref(), Some("markdown"));
        assert_eq!(stored.plain_text, None);
        // ...and the replaced rich body was snapshotted with its fields.
        let versions = text_versions(&conn, "a").unwrap();
        let rich_snapshot = versions
            .iter()
            .find(|v| v.content_format.as_deref() == Some("tiptap-json"))
            .expect("rich snapshot preserved");
        assert_eq!(rich_snapshot.plain_text.as_deref(), Some("first rich text"));
    }

    #[test]
    fn plain_text_drives_derived_readouts_and_search_for_rich_bodies() {
        let conn = mem();
        // The payload is a JSON document; only the plain-text projection is
        // meaningful prose.
        let rich = rich_body(
            r#"{"type":"doc","content":[{"type":"paragraph"}]}"#,
            "decolonial historiography of the archive",
        );
        create_text(&conn, &meta("a"), "seed").unwrap();
        let mut m = texts_list(&conn).unwrap().remove(0);
        m.updated_at = "t1".into();
        text_save(&conn, "a", &m, Some(&rich), None).unwrap();

        // Search hits the plain text, never the serialized payload.
        assert_eq!(search(&conn, "historiography").unwrap().len(), 1);
        assert_eq!(search(&conn, "contentFormat").unwrap().len(), 0);
        assert_eq!(search(&conn, "paragraph").unwrap().len(), 0);

        // Restore derives snippet/word count from the plain text (a JSON
        // payload would produce garbage readouts).
        save_text_content(&conn, "a", "seed two", "t3"); // snapshots the rich body
        let versions = text_versions(&conn, "a").unwrap();
        let rich_version_id = versions
            .iter()
            .find(|v| v.content == rich.content)
            .expect("rich body snapshotted")
            .version_id
            .clone();
        let result = text_restore(&conn, "a", &rich_version_id, "t4", None).unwrap();
        assert_eq!(result.snippet, "decolonial historiography of the archive");
        assert_eq!(result.word_count, 5);
    }

    #[test]
    fn legacy_dump_without_format_fields_imports_as_markdown() {
        let conn = mem();
        let dump = DbDump {
            texts: vec![meta("a")],
            text_contents: vec![TextContentRow {
                text_id: "a".into(),
                content: "pre-contract body".into(),
                content_format: None,
                content_schema_version: None,
                plain_text: None,
            }],
            text_versions: vec![TextVersionRow {
                text_id: "a".into(),
                version_id: Some("v1".into()),
                saved_at: "t1".into(),
                content: "pre-contract version".into(),
                content_format: None,
                content_schema_version: None,
                plain_text: None,
                label: None,
            }],
            ..Default::default()
        };
        let tx = conn.unchecked_transaction().unwrap();
        apply_dump(&tx, &dump).unwrap();
        tx.commit().unwrap();
        let stored = text_content(&conn, "a").unwrap().unwrap();
        assert_eq!(stored.content, "pre-contract body");
        assert_eq!(stored.content_format.as_deref(), Some("markdown"), "legacy dump rows apply as markdown v1");
        // Versions round-trip their content without labels too.
        let versions = text_versions(&conn, "a").unwrap();
        assert_eq!(versions[0].content, "pre-contract version");
        assert_eq!(versions[0].content_format.as_deref(), Some("markdown"));
    }

    /// Sources round-trip with their passages; duplicate content identity
    /// is rejected; restores activate them with real counts.
    #[test]
    fn sources_roundtrip_dedup_and_restore() {
        let conn = mem();
        let mut source = SourceRow {
            id: "s1".into(),
            project_id: None,
            title: "Une saison au Congo".into(),
            author: Some(" Aimé Césaire".into()),
            year: Some("1966".into()),
            doi: None,
            url: None,
            language: Some("French".into()),
            translation: Some("English translation consulted".into()),
            asset_ref: Some("cesaire-1966.md".into()),
            source_type: Some("book".into()),
            container_title: None,
            publisher: Some("Seuil".into()),
            volume: None,
            issue: None,
            pages: None,
            abstract_text: None,
            original_text: "original text — أطروحة".into(),
            content_hash: "hash-1".into(),
            extraction_status: "ready".into(),
            truncation_note: None,
            included_in_context: true,
            notes: Some("check page numbers".into()),
            verification: "retrieved".into(),
            rev: 0,
            created_at: "c".into(),
            updated_at: "u".into(),
        };
        let passages = vec![SourcePassageRow {
            id: "sp1".into(),
            locator: Some("p. 41".into()),
            content: "A quoted passage.".into(),
        }];
        source_create(&conn, &source, &passages).unwrap();

        // Dedup by CONTENT IDENTITY: the same hash is rejected even with a
        // different title/filename.
        let mut twin = source.clone();
        twin.id = "s2".into();
        twin.title = "Different title, same bytes".into();
        let err = source_create(&conn, &twin, &[]).unwrap_err();
        assert!(err.contains("identical content"), "{err}");
        assert_eq!(sources_list(&conn).unwrap().len(), 1);

        // Read back with passages.
        let data = source_get(&conn, "s1").unwrap().unwrap();
        assert_eq!(data.source.title, "Une saison au Congo");
        assert_eq!(data.passages.len(), 1);
        assert_eq!(data.passages[0].locator.as_deref(), Some("p. 41"));

        // Domain save: revision-checked, replaces passages, bumps rev.
        source.rev = 0;
        source.title = "Une saison au Congo (théâtre)".into();
        source_save(&conn, "s1", &source, Some(&passages), Some(0)).unwrap();
        assert!(source_save(&conn, "s1", &source, Some(&[]), Some(0)).is_err());

        // Dump → apply preserves sources, passages, and hash identity.
        let dump = export_dump(&conn).unwrap();
        assert_eq!(dump.sources.len(), 1);
        assert_eq!(dump.source_passages.len(), 1);
        let tx = conn.unchecked_transaction().unwrap();
        apply_dump(&tx, &dump).unwrap();
        tx.commit().unwrap();
        let data = source_get(&conn, "s1").unwrap().unwrap();
        assert_eq!(data.source.content_hash, "hash-1");
        assert_eq!(data.passages.len(), 1);
        assert_eq!(data.source.original_text, "original text — أطروحة");

        // Metadata-only save (None) keeps the stored passages untouched.
        source.title = "Une saison au Congo (2e éd.)".into();
        source_save(&conn, "s1", &source, None, Some(1)).unwrap();
        let data = source_get(&conn, "s1").unwrap().unwrap();
        assert_eq!(data.passages.len(), 1);
        assert_eq!(data.passages[0].id, "sp1");
        assert_eq!(data.source.title, "Une saison au Congo (2e éd.)");

        // An explicit empty list intentionally clears them.
        source_save(&conn, "s1", &source, Some(&[]), Some(2)).unwrap();
        let data = source_get(&conn, "s1").unwrap().unwrap();
        assert_eq!(data.passages.len(), 0);

        // Deletion removes the passages (cascade).
        source_delete(&conn, "s1").unwrap();
        assert_eq!(sources_list(&conn).unwrap().len(), 0);
        assert_eq!(source_get(&conn, "s1").unwrap().is_none(), true);
    }

    #[test]
    fn proposals_roundtrip_through_dump_and_status_updates() {
        let conn = mem();
        let proposal = ProposalRow {
            id: "pr1".into(),
            document_id: "doc1".into(),
            base_rev: 4,
            request_kind: "revise".into(),
            base_fragment: "the original sentence".into(),
            proposed_fragment: "the improved sentence".into(),
            sel_from: Some(1),
            sel_to: Some(22),
            context_note: None,
            status: "pending".into(),
            created_at: "c".into(),
            updated_at: "u".into(),
        };
        proposal_create(&conn, &proposal).unwrap();
        assert_eq!(proposals_list(&conn, "doc1").unwrap().len(), 1);
        assert_eq!(proposals_list(&conn, "other").unwrap().len(), 0);

        // Status updates are real updates (missing ids fail visibly).
        proposal_set_status(&conn, "pr1", "accepted", "u2").unwrap();
        assert!(proposal_set_status(&conn, "ghost", "accepted", "u").is_err());
        assert_eq!(
            proposals_list(&conn, "doc1").unwrap()[0].status,
            "accepted"
        );

        // Dumps carry proposals; applying a dump preserves them.
        let dump = export_dump(&conn).unwrap();
        assert_eq!(dump.proposals.len(), 1);
        let tx = conn.unchecked_transaction().unwrap();
        apply_dump(&tx, &dump).unwrap();
        tx.commit().unwrap();
        let rows = proposals_list(&conn, "doc1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "accepted");
        assert_eq!(rows[0].base_fragment, "the original sentence");

        // A legacy dump WITHOUT proposals still imports (serde defaults).
        let legacy: DbDump = serde_json::from_str(
            r#"{"texts": [], "textContents": [], "textVersions": [],
                "projects": [], "projectBriefs": [], "threads": [],
                "threadBriefs": [], "messages": []}"#,
        )
        .unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        apply_dump(&tx, &legacy).unwrap();
        tx.commit().unwrap();
        assert_eq!(proposals_list(&conn, "doc1").unwrap().len(), 0);
    }

    #[test]
    fn pin_archive_states_roundtrip_through_dump_and_set_state() {
        let conn = mem();
        create_text(&conn, &meta("a"), "body").unwrap();
        thread_create(&conn, &thread("t1"), None, &[]).unwrap();

        // Defaults: nothing pinned or archived.
        let text = texts_list(&conn).unwrap().remove(0);
        assert!(!text.archived && !text.pinned);

        // Pin the text, archive the conversation; unmentioned fields keep
        // their values; revisions bump.
        let text_rev = text_set_state(&conn, "a", None, Some(true), "t2").unwrap();
        let thread_rev = thread_set_state(&conn, "t1", Some(true), None, "t2").unwrap();
        assert!(text_rev > 0 && thread_rev > 0);
        let texts = texts_list(&conn).unwrap();
        assert!(!texts[0].archived && texts[0].pinned);
        let threads = threads_list(&conn).unwrap();
        assert!(threads[0].archived && !threads[0].pinned);

        // Pin/archive states ride the dump → import cycle.
        let dump = export_dump(&conn).unwrap();
        assert!(dump.texts[0].pinned);
        assert!(dump.threads[0].archived);
        let conn2 = mem();
        let tx = conn2.unchecked_transaction().unwrap();
        apply_dump(&tx, &dump).unwrap();
        tx.commit().unwrap();
        let texts = texts_list(&conn2).unwrap();
        assert!(texts[0].pinned && !texts[0].archived);
        let threads = threads_list(&conn2).unwrap();
        assert!(threads[0].archived && !threads[0].pinned);

        // Unpin/archive via the same op (false overwrites).
        text_set_state(&conn, "a", None, Some(false), "t3").unwrap();
        assert!(!texts_list(&conn).unwrap()[0].pinned);
    }

    #[test]
    fn named_snapshots_capture_the_current_body_and_keep_labels() {
        let conn = mem();
        create_text(&conn, &meta("a"), "first state").unwrap();
        save_text_content(&conn, "a", "second state", "t2");

        // A user-named snapshot of the CURRENT body.
        let version_id = text_snapshot(&conn, "a", "submitted draft", "t3").unwrap();
        let versions = text_versions(&conn, "a").unwrap();
        let snap = versions
            .iter()
            .find(|v| v.version_id == version_id)
            .expect("snapshot row");
        assert_eq!(snap.label.as_deref(), Some("submitted draft"));
        assert_eq!(snap.content, "second state");
        assert_eq!(snap.saved_at, "t3");

        // Snapshots don't bump the revision: pending scheduled saves stay
        // valid (no content/metadata write happened).
        let m = texts_list(&conn).unwrap().remove(0);
        text_save(&conn, "a", &m, Some(&markdown_body("third")), Some(m.rev)).unwrap();

        // The labeled version restores like any other (content only; the
        // label stays on the history row, not the live body).
        let result = text_restore(&conn, "a", &version_id, "t4", None).unwrap();
        assert_eq!(result.content, "second state");
        let versions = text_versions(&conn, "a").unwrap();
        assert!(versions.iter().any(|v| v.label.as_deref() == Some("submitted draft")));

        // Dumps carry labels.
        let dump = export_dump(&conn).unwrap();
        assert!(dump
            .text_versions
            .iter()
            .any(|v| v.label.as_deref() == Some("submitted draft")));
    }

    #[test]
    fn document_format_survives_export_import_dump_cycle() {
        let conn = mem();
        let rich = rich_body(r#"{"type":"doc","content":[]}"#, "exported rich text");
        create_text(&conn, &meta("a"), &rich.content).unwrap();
        // Rewrite the row as rich (create stores markdown in the helper).
        let mut m = texts_list(&conn).unwrap().remove(0);
        m.updated_at = "t1".into();
        text_save(&conn, "a", &m, Some(&rich), None).unwrap();

        let dump = export_dump(&conn).unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        apply_dump(&tx, &dump).unwrap();
        tx.commit().unwrap();
        let stored = text_content(&conn, "a").unwrap().unwrap();
        assert_eq!(stored.content, rich.content);
        assert_eq!(stored.content_format.as_deref(), Some("tiptap-json"));
        assert_eq!(stored.content_schema_version, Some(1));
        assert_eq!(stored.plain_text.as_deref(), Some("exported rich text"));
    }

    #[test]
    fn smoke_fresh_startup_to_backup_restore() {
        let dir =
            std::env::temp_dir().join(format!("dws-smoke-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let db = Db::default();

        // Fresh startup.
        let report = init_at(&dir, &db).unwrap();
        assert!(report.completed && !report.already_open);

        {
            let guard = db.0.lock().unwrap();
            let conn = guard.as_ref().unwrap();

            // Create a conversation.
            let th = thread("th");
            thread_create(&conn, &th, None, &[]).unwrap();
            thread_append_message(
                &conn,
                "th",
                &MessageRow {
                    id: Some("m1".into()),
                    role: "user".into(),
                    content: "hello".into(),
                    timestamp: "t1".into(),
                    failed: false,
                    incomplete: None,
                    attachments_json: None,
                },
                "u2",
            )
            .unwrap();

            // Create a project WITH references.
            let mut p = proj("p");
            p.refs = Some("Fanon, Black Skin, White Masks (1952).".into());
            project_insert(&conn, &p).unwrap();
            project_save(&conn, "p", &p, Some("the brief"), None).unwrap();

            // Save / edit / reopen a document.
            let mut tm = meta("doc");
            tm.project_id = Some("p".into());
            create_text(&conn, &tm, "first draft").unwrap();
            save_text_content(&conn, "doc", "second draft", "t2");
            assert_eq!(
                text_content_str(&conn, "doc").unwrap().as_deref(),
                Some("second draft")
            );

            // Restore history (by stable version id).
            let versions = text_versions(&conn, "doc").unwrap();
            assert_eq!(versions.len(), 1);
            let restored =
                text_restore(&conn, "doc", &versions[0].version_id, "t3", None).unwrap();
            assert_eq!(restored.content, "first draft");
        }

        // Export a consistent snapshot...
        let dump = {
            let guard = db.0.lock().unwrap();
            export_dump(guard.as_ref().unwrap()).unwrap()
        };
        assert_eq!(dump.threads.len(), 1);
        assert_eq!(dump.projects.len(), 1);
        assert_eq!(dump.texts.len(), 1);
        // ...references survive dump serialization...
        let dump_json = serde_json::to_string(&dump).unwrap();
        assert!(dump_json.contains(r#""references":"Fanon, Black Skin, White Masks (1952).""#));

        // ...and restore into a SECOND fresh dataset (another temp dir).
        let dir2 = std::env::temp_dir()
            .join(format!("dws-smoke-restore-{}", std::process::id()));
        let db2 = Db::default();
        init_at(&dir2, &db2).unwrap();
        {
            let guard = db2.0.lock().unwrap();
            let conn = guard.as_ref().unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            apply_dump(&tx, &dump).unwrap();
            tx.execute("DELETE FROM preferences", []).unwrap();
            prefs_set(&tx, "config", r#"{"provider":"zen","apiKey":""}"#).unwrap();
            tx.commit().unwrap();
            assert_eq!(
                text_content_str(&conn, "doc").unwrap().as_deref(),
                Some("first draft")
            );
            assert_eq!(
                projects_list(&conn).unwrap()[0].refs.as_deref(),
                Some("Fanon, Black Skin, White Masks (1952).")
            );
            assert_eq!(
                thread_get(&conn, "th").unwrap().unwrap().messages.len(),
                1
            );
        }
        drop(db2);

        // Reopen the FIRST database after "shutdown": intact.
        drop(db);
        let db3 = Db::default();
        let report3 = init_at(&dir, &db3).unwrap();
        assert!(report3.completed && !report3.already_open);
        {
            let guard = db3.0.lock().unwrap();
            let conn = guard.as_ref().unwrap();
            assert_eq!(
                text_content_str(&conn, "doc").unwrap().as_deref(),
                Some("first draft")
            );
            assert_eq!(
                thread_get(&conn, "th").unwrap().unwrap().messages.len(),
                1
            );
        }

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&dir2).ok();
    }

    /// Failure injection: a corrupt database file fails startup VISIBLY
    /// (never silently reinitialized or wiped).
    #[test]
    fn corrupt_database_file_fails_startup_visibly() {
        let dir =
            std::env::temp_dir().join(format!("dws-corrupt-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(DB_FILE), b"this is definitely not a sqlite database")
            .unwrap();
        let db = Db::default();
        assert!(init_at(&dir, &db).is_err());
        // The corrupted file was left untouched for recovery.
        assert!(dir.join(DB_FILE).is_file());
        fs::remove_dir_all(&dir).ok();
    }

    /// A real v1 file database migrates through every schema step to the
    /// current version, preserving data (real file, not in-memory).
    #[test]
    fn real_file_migration_from_v1_preserves_data() {
        let dir =
            std::env::temp_dir().join(format!("dws-migrate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        {
            let conn = Connection::open(dir.join(DB_FILE)).unwrap();
            conn.execute_batch(SCHEMA).unwrap(); // v1 shape
            conn.execute(
                "INSERT INTO texts (id, title, text_type, created_at, updated_at)
                 VALUES ('a', 'Legacy', 'essay', 'c', 'u')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO text_versions (text_id, saved_at, content)
                 VALUES ('a', 'old-ms', 'legacy body')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO threads (id, title, mode, created_at, updated_at)
                 VALUES ('th', 'Chat', 'text', 'c', 'u')",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        let db = Db::default();
        init_at(&dir, &db).unwrap();
        {
            let guard = db.0.lock().unwrap();
            let conn = guard.as_ref().unwrap();
            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(version, SUPPORTED_SCHEMA_VERSION);
            assert_eq!(
                text_content_str(conn, "a").unwrap().as_deref(),
                None // v1 rows have no content row yet
            );
            assert_eq!(texts_list(conn).unwrap()[0].title, "Legacy");
            let versions = text_versions(conn, "a").unwrap();
            assert_eq!(versions.len(), 1);
            assert_eq!(versions[0].saved_at, "old-ms");
            assert_eq!(versions[0].content, "legacy body");
            assert!(threads_list(conn).unwrap()[0].rev >= 0);
        }
        fs::remove_dir_all(&dir).ok();
    }

    // ── Shared backup contract fixture (B01) ──
    //
    // The fixture contains what Rust's `DbDump` ACTUALLY serializes:
    // camelCase keys, every struct field present, and message/passage rows
    // FLATTENED (`#[serde(flatten)]`). The frontend parser validates this
    // same file (src/utils/__tests__/backup.test.ts). Regenerate after any
    // contract change:
    //   `cargo test --lib regenerate_backup_contract_fixture -- --ignored`

    const BACKUP_CONTRACT_JSON: &str = include_str!("../../src/test/backup-contract.json");

    /// The rich fixture dataset: manuscript + history, conversation
    /// messages + attachments, sources + passages, proposals.
    fn backup_fixture_dump() -> DbDump {
        let rich_content = r#"{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"On extractive citation"}]},{"type":"paragraph","content":[{"type":"text","text":"Ça, 東京 — prose with "},{"type":"text","marks":[{"type":"bold"}],"text":"citations"},{"type":"text","text":" and a footnote."}]}]}"#;

        DbDump {
            texts: vec![
                TextRow {
                    id: "t-rich-1".into(),
                    title: "Chapter draft — ça / 東京".into(),
                    text_type: "essay".into(),
                    folder: Some("Drafts".into()),
                    project_id: Some("p-1".into()),
                    snippet: Some("Prose with citations and a footnote.".into()),
                    word_count: Some(12),
                    rev: 2,
                    archived: false,
                    pinned: true,
                    created_at: "2026-01-02T08:00:00.000Z".into(),
                    updated_at: "2026-02-02T10:00:00.000Z".into(),
                },
                TextRow {
                    id: "t-legacy-1".into(),
                    title: "Old markdown draft".into(),
                    text_type: "other".into(),
                    folder: None,
                    project_id: None,
                    snippet: None,
                    word_count: None,
                    rev: 0,
                    archived: true,
                    pinned: false,
                    created_at: "2026-01-03T08:00:00.000Z".into(),
                    updated_at: "2026-01-05T09:00:00.000Z".into(),
                },
            ],
            text_contents: vec![
                TextContentRow {
                    text_id: "t-legacy-1".into(),
                    content: "# Legacy body\n\nMarkdown with «quotes».".into(),
                    content_format: Some("markdown".into()),
                    content_schema_version: Some(1),
                    plain_text: None,
                },
                TextContentRow {
                    text_id: "t-rich-1".into(),
                    content: rich_content.into(),
                    content_format: Some("tiptap-json".into()),
                    content_schema_version: Some(1),
                    plain_text: Some(
                        "On extractive citation Ça, 東京 — prose with citations and a footnote."
                            .into(),
                    ),
                },
            ],
            text_versions: vec![
                TextVersionRow {
                    text_id: "t-rich-1".into(),
                    version_id: Some("v-1".into()),
                    saved_at: "2026-01-10T09:00:00.000Z".into(),
                    content: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Earlier rich draft"}]}]}"#.into(),
                    content_format: Some("tiptap-json".into()),
                    content_schema_version: Some(1),
                    plain_text: Some("Earlier rich draft".into()),
                    label: Some("submitted draft".into()),
                },
                TextVersionRow {
                    text_id: "t-rich-1".into(),
                    version_id: Some("v-2".into()),
                    saved_at: "2026-01-20T09:00:00.000Z".into(),
                    content: "# Legacy snapshot\n\nOld markdown body".into(),
                    content_format: Some("markdown".into()),
                    content_schema_version: Some(1),
                    plain_text: None,
                    label: None,
                },
            ],
            projects: vec![ProjectRow {
                id: "p-1".into(),
                title: "Dissertation — 東京 conversations".into(),
                description: Some("Chapters and interviews.".into()),
                default_audience: Some("academics".into()),
                default_tone: Some("academic".into()),
                default_citations: Some("apa".into()),
                default_language: Some("en".into()),
                refs: Some("Spivak, Can the Subaltern Speak? (1988).".into()),
                brief_word_count: Some(400),
                rev: 3,
                created_at: "2026-01-01T00:00:00.000Z".into(),
                updated_at: "2026-02-03T00:00:00.000Z".into(),
            }],
            project_briefs: vec![ProjectBriefRow {
                project_id: "p-1".into(),
                content: "Argue that citation is extractive when it silences the cited.".into(),
            }],
            sources: vec![
                SourceRow {
                    id: "s-1".into(),
                    project_id: Some("p-1".into()),
                    title: "Linda Tuhiwai Smith, Decolonizing Methodologies".into(),
                    author: Some("Linda Tuhiwai Smith".into()),
                    year: Some("2012".into()),
                    doi: Some("10.1000/xyz123".into()),
                    url: Some("https://example.org/smith".into()),
                    language: Some("en".into()),
                    translation: None,
                    asset_ref: Some("smith-2012.pdf".into()),
                    source_type: Some("book".into()),
                    container_title: None,
                    publisher: Some("Zed Books".into()),
                    volume: None,
                    issue: None,
                    pages: Some("1-25".into()),
                    abstract_text: Some("A foundational text on decolonizing research methodologies.".into()),
                    original_text: "Full text — preserved verbatim.".into(),
                    content_hash: "sha256:aaa111".into(),
                    extraction_status: "ready".into(),
                    truncation_note: None,
                    included_in_context: true,
                    notes: Some("Chapter 1 used for the methods section.".into()),
                    verification: "quote_matched".into(),
                    rev: 1,
                    created_at: "2026-01-15T00:00:00.000Z".into(),
                    updated_at: "2026-02-04T11:00:00.000Z".into(),
                },
                SourceRow {
                    id: "s-2".into(),
                    project_id: None,
                    title: "Interview transcript".into(),
                    author: None,
                    year: Some("1999".into()),
                    doi: None,
                    url: None,
                    language: Some("fr".into()),
                    translation: Some("Translated from French by the author.".into()),
                    asset_ref: Some("interview.txt".into()),
                    source_type: Some("interview".into()),
                    container_title: None,
                    publisher: None,
                    volume: None,
                    issue: None,
                    pages: None,
                    abstract_text: Some("Oral history interview about land and memory.".into()),
                    original_text: "Entretien — texte intégral.".into(),
                    content_hash: "sha256:bbb222".into(),
                    extraction_status: "truncated".into(),
                    truncation_note: Some("Text truncated at 12,000 words.".into()),
                    included_in_context: false,
                    notes: None,
                    verification: "unverified".into(),
                    rev: 0,
                    created_at: "2026-01-16T00:00:00.000Z".into(),
                    updated_at: "2026-01-30T11:00:00.000Z".into(),
                },
            ],
            source_passages: vec![
                StoredSourcePassageRow {
                    source_id: "s-1".into(),
                    passage: SourcePassageRow {
                        id: "sp-1".into(),
                        locator: Some("p. 12".into()),
                        content: "Extractive citation takes without returning.".into(),
                    },
                },
                StoredSourcePassageRow {
                    source_id: "s-1".into(),
                    passage: SourcePassageRow {
                        id: "sp-2".into(),
                        locator: Some("pp. 20–21".into()),
                        content: "Rewriting is a method, not a metaphor.".into(),
                    },
                },
                StoredSourcePassageRow {
                    source_id: "s-2".into(),
                    passage: SourcePassageRow {
                        id: "sp-3".into(),
                        locator: None,
                        content: "Question : qui parle dans le texte ?".into(),
                    },
                },
            ],
            proposals: vec![
                ProposalRow {
                    id: "pr-1".into(),
                    document_id: "t-rich-1".into(),
                    base_rev: 1,
                    request_kind: "revise".into(),
                    base_fragment: "extractive citation".into(),
                    proposed_fragment: "extractive citation practices".into(),
                    sel_from: Some(10),
                    sel_to: Some(30),
                    context_note: Some("Tighten the claim.".into()),
                    status: "pending".into(),
                    created_at: "2026-02-05T10:00:00.000Z".into(),
                    updated_at: "2026-02-05T10:00:00.000Z".into(),
                },
                ProposalRow {
                    id: "pr-2".into(),
                    document_id: "t-rich-1".into(),
                    base_rev: 2,
                    request_kind: "comment".into(),
                    base_fragment: "footnote".into(),
                    proposed_fragment: "footnote (Smith 2012)".into(),
                    sel_from: None,
                    sel_to: None,
                    context_note: None,
                    status: "accepted".into(),
                    created_at: "2026-02-06T10:00:00.000Z".into(),
                    updated_at: "2026-02-06T10:00:00.000Z".into(),
                },
            ],
            threads: vec![
                ThreadRow {
                    id: "th-1".into(),
                    title: "On extractive citation — ça / 東京".into(),
                    mode: "text".into(),
                    project_id: Some("p-1".into()),
                    refs: Some("Fanon, Black Skin, White Masks (1952).".into()),
                    rev: 4,
                    archived: false,
                    pinned: true,
                    created_at: "2026-01-05T00:00:00.000Z".into(),
                    updated_at: "2026-02-07T12:00:00.000Z".into(),
                },
                ThreadRow {
                    id: "th-2".into(),
                    title: "Standalone notes".into(),
                    mode: "project".into(),
                    project_id: None,
                    refs: None,
                    rev: 1,
                    archived: true,
                    pinned: false,
                    created_at: "2026-01-06T00:00:00.000Z".into(),
                    updated_at: "2026-01-20T12:00:00.000Z".into(),
                },
            ],
            thread_briefs: vec![ThreadBriefRow {
                thread_id: "th-1".into(),
                brief_json: Some(r#"{"topic":"Extractive citation","length":"3000 words"}"#.into()),
            }],
            messages: vec![
                StoredMessageRow {
                    thread_id: "th-1".into(),
                    idx: 0,
                    message: MessageRow {
                        id: Some("msg-1".into()),
                        role: "user".into(),
                        content: "Help me sharpen this claim.".into(),
                        timestamp: "2026-02-07T11:00:00.000Z".into(),
                        failed: false,
                        incomplete: None,
                        attachments_json: Some(
                            r#"[{"name":"fieldnotes.txt","kind":"text","content":"Observed in the archive.","wordCount":120}]"#
                                .into(),
                        ),
                    },
                },
                StoredMessageRow {
                    thread_id: "th-1".into(),
                    idx: 1,
                    message: MessageRow {
                        id: Some("msg-2".into()),
                        role: "assistant".into(),
                        content: "Here is a tighter version…".into(),
                        timestamp: "2026-02-07T11:01:00.000Z".into(),
                        failed: false,
                        incomplete: Some("interrupted".into()),
                        attachments_json: None,
                    },
                },
                StoredMessageRow {
                    thread_id: "th-1".into(),
                    idx: 2,
                    message: MessageRow {
                        id: None,
                        role: "assistant".into(),
                        content: "Legacy reply without an id".into(),
                        timestamp: "2026-02-07T11:02:00.000Z".into(),
                        failed: true,
                        incomplete: None,
                        attachments_json: None,
                    },
                },
                StoredMessageRow {
                    thread_id: "th-2".into(),
                    idx: 0,
                    message: MessageRow {
                        id: Some("msg-4".into()),
                        role: "user".into(),
                        content: "Unrelated standalone note.".into(),
                        timestamp: "2026-01-20T11:00:00.000Z".into(),
                        failed: false,
                        incomplete: None,
                        attachments_json: None,
                    },
                },
            ],
        }
    }

    /// The full fixture file: a v3 backup envelope with non-secret
    /// preferences (credentials excluded), exactly as the frontend writes
    /// it after `db_export`.
    fn backup_fixture_envelope() -> serde_json::Value {
        serde_json::json!({
            "comment": [
                "Shared backup contract fixture (B01).",
                "The `bundle` object is a v3 backup exactly as the desktop app",
                "exports it: `data` is Rust's actual DbDump serialization",
                "(flattened message/passage rows, camelCase, all fields present)",
                "and `preferences` carries the parsed non-secret preference",
                "values (the credential is stripped).",
                "Frontend: src/utils/__tests__/backup.test.ts parses this file",
                "with the production parser. Rust: repository.rs asserts that",
                "applying `data` and re-exporting reproduces it exactly.",
                "Regenerate from src-tauri with:",
                "cargo test --lib regenerate_backup_contract_fixture -- --ignored"
            ],
            "bundle": {
                "format": "decol-writing-support-backup",
                "version": 3,
                "exportedAt": "2026-02-08T09:30:00.000Z",
                "data": serde_json::to_value(backup_fixture_dump()).unwrap(),
                "preferences": {
                    "config": {
                        "provider": "zen",
                        "baseUrl": "https://opencode.ai/zen/v1",
                        "model": "deepseek-flash",
                        "reasoningEffort": null,
                        "apiKey": ""
                    },
                    "settings": {
                        "theme": "dark",
                        "accent": "#34d399",
                        "fontSize": 18
                    },
                    "zen-prices": {
                        "model": "deepseek-flash",
                        "input": 0.0,
                        "output": 0.0,
                        "updatedAt": "2026-02-08T09:00:00.000Z"
                    },
                    "recovery-drafts": {
                        "text:t-rich-1": {
                            "kind": "text",
                            "content": "Unsaved ending — ça",
                            "savedAt": "2026-02-08T08:55:00.000Z",
                            "error": null
                        }
                    },
                    "workspace-shell": {
                        "view": "edit",
                        "activeTextId": "t-rich-1",
                        "navigatorWidth": 240,
                        "inspectorWidth": 360
                    }
                }
            }
        })
    }

    /// Writes the shared fixture from the actual Rust serialization. Run
    /// manually after contract changes (the file is committed and read by
    /// both test suites; this test never runs in CI).
    #[test]
    #[ignore = "writes src/test/backup-contract.json on demand"]
    fn regenerate_backup_contract_fixture() {
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&backup_fixture_envelope()).unwrap()
        );
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/test/backup-contract.json");
        fs::write(&path, text).unwrap();
    }

    /// Guard: the shared fixture deserializes into `DbDump`, applies through
    /// the REAL import path, and re-exports exactly as written. Any serde
    /// drift (renames, nesting, defaults) fails here.
    #[test]
    fn backup_contract_fixture_roundtrips_through_rust() {
        let fixture: serde_json::Value =
            serde_json::from_str(BACKUP_CONTRACT_JSON).unwrap();
        let bundle = &fixture["bundle"];
        assert_eq!(bundle["format"], "decol-writing-support-backup");
        assert_eq!(bundle["version"], 3);
        // Canonical shape: message/passage payloads are FLATTENED.
        assert!(bundle["data"]["messages"][0].get("message").is_none());
        assert!(bundle["data"]["sourcePassages"][0].get("passage").is_none());

        let dump: DbDump = serde_json::from_value(bundle["data"].clone()).unwrap();
        let conn = mem();
        let tx = conn.unchecked_transaction().unwrap();
        apply_dump(&tx, &dump).unwrap();
        tx.commit().unwrap();

        let exported = serde_json::to_value(export_dump(&conn).unwrap()).unwrap();
        assert_eq!(exported, bundle["data"]);

        // Preferences deserialize into the row shape db_restore sends, and
        // the fixture credential is empty (never usable).
        let prefs: std::collections::BTreeMap<String, serde_json::Value> =
            serde_json::from_value(bundle["preferences"].clone()).unwrap();
        assert_eq!(prefs["config"]["apiKey"], "");
        assert!(prefs.contains_key("recovery-drafts"));
        for (key, value) in &prefs {
            let row = PrefRow {
                key: key.clone(),
                value: serde_json::to_string(value).unwrap(),
            };
            let parsed: serde_json::Value = serde_json::from_str(&row.value).unwrap();
            assert_eq!(&parsed, value);
        }
    }

    /// Production export → production import → production export: seeding
    /// through the ordinary APIs and re-importing the serialized dump
    /// reproduces the exact payload (the "exported backups are importable"
    /// acceptance at the Rust boundary).
    #[test]
    fn production_export_reimports_faithfully() {
        let conn = mem();
        create_text(&conn, &meta("doc"), "first draft").unwrap();
        save_text_content(&conn, "doc", "second draft", "2026-02-01T10:00:00.000Z");
        let p = proj("p");
        project_insert(&conn, &p).unwrap();
        project_save(&conn, "p", &p, Some("brief"), None).unwrap();
        let t = thread("th");
        thread_create(
            &conn,
            &t,
            Some(r#"{"topic":"x"}"#.into()),
            &[
                MessageRow {
                    id: Some("m1".into()),
                    role: "user".into(),
                    content: "q".into(),
                    timestamp: "t1".into(),
                    failed: false,
                    incomplete: None,
                    attachments_json: Some(r#"[{"name":"f.txt"}]"#.into()),
                },
                MessageRow {
                    id: Some("m2".into()),
                    role: "assistant".into(),
                    content: "a".into(),
                    timestamp: "t2".into(),
                    failed: false,
                    incomplete: None,
                    attachments_json: None,
                },
            ],
        )
        .unwrap();
        let source = SourceRow {
            id: "s".into(),
            project_id: Some("p".into()),
            title: "Source".into(),
            author: None,
            year: None,
            doi: None,
            url: None,
            language: None,
            translation: None,
            asset_ref: None,
            source_type: Some("article-journal".into()),
            container_title: Some("Journal of Repairs".into()),
            publisher: Some("Archive Press".into()),
            volume: Some("12".into()),
            issue: Some("3".into()),
            pages: Some("45-67".into()),
            abstract_text: Some("An abstract kept separate from notes.".into()),
            original_text: "Full text.".into(),
            content_hash: "sha256:prod".into(),
            extraction_status: "ready".into(),
            truncation_note: None,
            included_in_context: true,
            notes: None,
            verification: "unverified".into(),
            rev: 0,
            created_at: "2026-02-01T00:00:00.000Z".into(),
            updated_at: "2026-02-01T00:00:00.000Z".into(),
        };
        source_create(
            &conn,
            &source,
            &[SourcePassageRow {
                id: "sp".into(),
                locator: Some("p. 1".into()),
                content: "Passage.".into(),
            }],
        )
        .unwrap();
        proposal_create(
            &conn,
            &ProposalRow {
                id: "pr".into(),
                document_id: "doc".into(),
                base_rev: 0,
                request_kind: "revise".into(),
                base_fragment: "first".into(),
                proposed_fragment: "second".into(),
                sel_from: Some(0),
                sel_to: Some(5),
                context_note: None,
                status: "pending".into(),
                created_at: "2026-02-02T00:00:00.000Z".into(),
                updated_at: "2026-02-02T00:00:00.000Z".into(),
            },
        )
        .unwrap();

        let first = serde_json::to_value(export_dump(&conn).unwrap()).unwrap();

        let conn2 = mem();
        let parsed: DbDump = serde_json::from_value(first.clone()).unwrap();
        let tx = conn2.unchecked_transaction().unwrap();
        apply_dump(&tx, &parsed).unwrap();
        tx.commit().unwrap();
        let second = serde_json::to_value(export_dump(&conn2).unwrap()).unwrap();
        assert_eq!(second, first);
    }

    /// Duplicate composite identities are rejected by the import path (no
    /// `INSERT OR IGNORE` data loss) and the failed restore mutates nothing.
    #[test]
    fn duplicate_identities_fail_restore_without_mutation() {
        let cases: Vec<(&str, DbDump)> = vec![
            ("messages", {
                let mut d = DbDump::default();
                d.threads.push(thread("th"));
                for _ in 0..2 {
                    d.messages.push(StoredMessageRow {
                        thread_id: "th".into(),
                        idx: 0,
                        message: MessageRow {
                            id: None,
                            role: "user".into(),
                            content: "dup".into(),
                            timestamp: "t".into(),
                            failed: false,
                            incomplete: None,
                            attachments_json: None,
                        },
                    });
                }
                d
            }),
            ("text_versions", {
                let mut d = DbDump::default();
                d.texts.push(meta("t"));
                for _ in 0..2 {
                    d.text_versions.push(TextVersionRow {
                        text_id: "t".into(),
                        version_id: Some("same-id".into()),
                        saved_at: "s".into(),
                        content: "c".into(),
                        content_format: None,
                        content_schema_version: None,
                        plain_text: None,
                        label: None,
                    });
                }
                d
            }),
            ("project_briefs", {
                let mut d = DbDump::default();
                d.projects.push(proj("p"));
                for _ in 0..2 {
                    d.project_briefs.push(ProjectBriefRow {
                        project_id: "p".into(),
                        content: "brief".into(),
                    });
                }
                d
            }),
            ("sources", {
                let mut d = DbDump::default();
                for id in ["s1", "s2"] {
                    d.sources.push(SourceRow {
                        id: id.into(),
                        project_id: None,
                        title: "S".into(),
                        author: None,
                        year: None,
                        doi: None,
                        url: None,
                        language: None,
                        translation: None,
                        asset_ref: None,
                        source_type: None,
                        container_title: None,
                        publisher: None,
                        volume: None,
                        issue: None,
                        pages: None,
                        abstract_text: None,
                        original_text: "text".into(),
                        content_hash: "same-hash".into(),
                        extraction_status: "ready".into(),
                        truncation_note: None,
                        included_in_context: true,
                        notes: None,
                        verification: "unverified".into(),
                        rev: 0,
                        created_at: "c".into(),
                        updated_at: "u".into(),
                    });
                }
                d
            }),
        ];

        for (what, dump) in cases {
            let conn = mem();
            create_text(&conn, &meta("keep"), "original").unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            let err = apply_dump(&tx, &dump).unwrap_err();
            assert!(!err.is_empty(), "{what} must report a duplicate");
            drop(tx); // rollback: the failed restore changed nothing
            assert_eq!(
                text_content_str(&conn, "keep").unwrap().as_deref(),
                Some("original"),
                "{what} failure must not mutate the dataset"
            );
        }
    }

    /// Unsupported content contracts (schema newer than this build, unknown
    /// format) fail BEFORE a row is written and roll back cleanly.
    #[test]
    fn unsupported_content_contract_fails_restore() {
        let schema_case = {
            let mut d = DbDump::default();
            d.texts.push(meta("t"));
            d.text_contents.push(TextContentRow {
                text_id: "t".into(),
                content: "{}".into(),
                content_format: Some("tiptap-json".into()),
                content_schema_version: Some(SUPPORTED_CONTENT_SCHEMA_VERSION + 1),
                plain_text: None,
            });
            d
        };
        let format_case = {
            let mut d = DbDump::default();
            d.texts.push(meta("t"));
            d.text_contents.push(TextContentRow {
                text_id: "t".into(),
                content: "{}".into(),
                content_format: Some("latex".into()),
                content_schema_version: Some(1),
                plain_text: None,
            });
            d
        };

        for (dump, needle) in [
            (schema_case, "content schema"),
            (format_case, "unsupported content format"),
        ] {
            let conn = mem();
            create_text(&conn, &meta("keep"), "original").unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            let err = apply_dump(&tx, &dump).unwrap_err();
            assert!(err.contains(needle), "expected {needle:?} in {err:?}");
            drop(tx);
            assert_eq!(
                text_content_str(&conn, "keep").unwrap().as_deref(),
                Some("original")
            );
        }
    }

    // ── B08: crash-safe schema upgrades + migration activation ──

    /// A database stranded by a PARTIALLY applied migration is repaired on
    /// the next startup instead of being refused forever.
    #[test]
    fn stranded_partial_migrations_are_repaired() {
        // (a) v3: crash after the rename, before the rebuild.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO texts (id, title, text_type, created_at, updated_at)
             VALUES ('a', 'T', 'essay', 'c', 'u')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO text_versions (text_id, saved_at, content)
             VALUES ('a', 'old-ms', 'legacy body')",
            [],
        )
        .unwrap();
        conn.execute_batch("ALTER TABLE text_versions RENAME TO text_versions_old")
            .unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        ensure_schema(&conn).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            SUPPORTED_SCHEMA_VERSION
        );
        let versions = text_versions(&conn, "a").unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].content, "legacy body");
        assert!(!table_exists(&conn, "text_versions_old").unwrap());

        // (b) v3: crash after the copy, before the version bump (staging
        // table still present alongside the new table).
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO texts (id, title, text_type, created_at, updated_at)
             VALUES ('b', 'T', 'essay', 'c', 'u')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO text_versions (text_id, saved_at, content)
             VALUES ('b', 'old-ms', 'stranded body')",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "ALTER TABLE text_versions RENAME TO text_versions_old;
             CREATE TABLE text_versions (
               text_id TEXT NOT NULL,
               version_id TEXT NOT NULL,
               saved_at TEXT NOT NULL,
               content TEXT NOT NULL,
               PRIMARY KEY (text_id, version_id)
             );
             INSERT INTO text_versions (text_id, version_id, saved_at, content)
               SELECT text_id, 'legacy-' || rowid, saved_at, content
               FROM text_versions_old;",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        ensure_schema(&conn).unwrap();
        assert!(!table_exists(&conn, "text_versions_old").unwrap());
        assert_eq!(text_versions(&conn, "b").unwrap().len(), 1);

        // (c) v7: pre-contract body rows (no format columns) upgrade with
        // the plain-text backfill, even when some columns already exist.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO texts (id, title, text_type, created_at, updated_at)
             VALUES ('c', 'T', 'essay', 'c', 'u')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO text_contents (text_id, content) VALUES ('c', 'plain body')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 6).unwrap();
        ensure_schema(&conn).unwrap();
        let plain: Option<String> = conn
            .query_row(
                "SELECT plain_text FROM text_contents WHERE text_id = 'c'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(plain.as_deref(), Some("plain body"));

        // (d) v11: one pin/archive column present, the rest missing.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        // A real v10 database already has the v9 source tables; the
        // fabricated one must too, or later migrations (v13) cannot run.
        conn.execute_batch(SCHEMA_V9).unwrap();
        conn.execute_batch(
            "ALTER TABLE texts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 10).unwrap();
        ensure_schema(&conn).unwrap();
        for (table, column) in [
            ("texts", "archived"),
            ("texts", "pinned"),
            ("threads", "archived"),
            ("threads", "pinned"),
        ] {
            assert!(
                column_exists(&conn, table, column).unwrap(),
                "{table}.{column} missing after repair"
            );
        }

        // (e) v12: a v11 database with existing messages upgrades with the
        // incomplete marker column, data intact; re-running is a no-op.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(SCHEMA_V9).unwrap();
        conn.execute(
            "INSERT INTO threads (id, title, created_at, updated_at)
             VALUES ('t', 'T', 'c', 'u')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (thread_id, idx, role, content, timestamp, failed)
             VALUES ('t', 0, 'assistant', 'partial', 'ts', 0)",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 11).unwrap();
        ensure_schema(&conn).unwrap();
        assert!(column_exists(&conn, "messages", "incomplete").unwrap());
        let content: String = conn
            .query_row(
                "SELECT content FROM messages WHERE thread_id = 't'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(content, "partial");
        // Repair: the migration is re-runnable after a partial crash.
        ensure_schema(&conn).unwrap();

        // (f) v13: a v12 database with sources upgrades with the
        // bibliography metadata columns; existing data is intact and the
        // re-run is a no-op.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(SCHEMA_V9).unwrap();
        conn.execute(
            "INSERT INTO sources (id, title, original_text, content_hash, extraction_status,
                                  included_in_context, verification, rev, created_at, updated_at)
             VALUES ('s', 'T', 'body', 'hash', 'ready', 1, 'unverified', 0, 'c', 'u')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 12).unwrap();
        ensure_schema(&conn).unwrap();
        for column in [
            "source_type",
            "container_title",
            "publisher",
            "volume",
            "issue",
            "pages",
            "abstract_text",
        ] {
            assert!(
                column_exists(&conn, "sources", column).unwrap(),
                "sources.{column} missing after repair"
            );
        }
        let stored: (String, Option<String>) = conn
            .query_row(
                "SELECT original_text, abstract_text FROM sources WHERE id = 's'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored.0, "body");
        assert_eq!(stored.1, None);
        ensure_schema(&conn).unwrap();

        // (g) v14: a v13 database whose message index was left stale by
        // the missing UPDATE trigger (old text indexed, new text missing)
        // and by the over-broad DELETE trigger (a sibling message lost)
        // upgrades with a full message re-index; the new triggers keep it
        // correct afterwards and the upgrade is re-runnable.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(SCHEMA_V5).unwrap();
        // A real v13 database went through v2 and v12: revision columns
        // and the incomplete marker exist.
        conn.execute_batch(
            "ALTER TABLE threads ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE messages ADD COLUMN incomplete TEXT;",
        )
        .unwrap();
        conn.execute_batch(SCHEMA_V6).unwrap();
        conn.execute(
            "INSERT INTO threads (id, title, created_at, updated_at)
             VALUES ('th', 'Conversation', 'c', 'u')",
            [],
        )
        .unwrap();
        // The replacement already happened under the buggy v13 schema: the
        // UPDATE did nothing to the index, which still holds the OLD text.
        conn.execute(
            "INSERT INTO messages (thread_id, idx, msg_id, role, content, timestamp, failed)
             VALUES ('th', 0, 'm1', 'assistant', 'zanzibar original', 't1', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE messages SET content = 'kaleidoscope replacement'
             WHERE thread_id = 'th' AND msg_id = 'm1'",
            [],
        )
        .unwrap();
        // A sibling message lost from the index by the old over-broad
        // delete trigger.
        conn.execute(
            "INSERT INTO messages (thread_id, idx, msg_id, role, content, timestamp, failed)
             VALUES ('th', 1, 'm2', 'user', 'sibling question', 't2', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM search_index WHERE kind = 'thread' AND doc_id = 'th'
               AND body = 'sibling question'",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 13).unwrap();
        ensure_schema(&conn).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            SUPPORTED_SCHEMA_VERSION
        );
        assert_eq!(
            search(&conn, "zanzibar").unwrap().len(),
            0,
            "the stale old text must be dropped by the re-index"
        );
        assert_eq!(
            search(&conn, "kaleidoscope").unwrap().len(),
            1,
            "the persisted new text must be indexed"
        );
        assert_eq!(
            search(&conn, "sibling").unwrap().len(),
            1,
            "the lost sibling row must come back"
        );
        // The upgraded database now tracks replacements and single deletes.
        thread_replace_message(&conn, "th", "m2", "orientalism question", None, "t3").unwrap();
        assert_eq!(search(&conn, "sibling").unwrap().len(), 0);
        assert_eq!(search(&conn, "orientalism").unwrap().len(), 1);
        // Repair: the migration is re-runnable after a partial crash.
        ensure_schema(&conn).unwrap();
    }

    /// An incomplete legacy migration never registers a writable dataset;
    /// correcting the input and retrying completes it.
    #[test]
    fn incomplete_legacy_migration_does_not_open_the_workspace() {
        let dir = std::env::temp_dir().join(format!("dws-incomplete-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("library.json"), "{not valid json").unwrap();

        let db = Db::default();
        let report = init_at(&dir, &db).unwrap();
        assert!(!report.completed);
        assert!(report.issues.iter().any(|i| i.kind == "malformed"));
        // No connection was registered: the workspace cannot open (and
        // therefore cannot look empty and writable).
        assert!(db.0.lock().unwrap().is_none());

        // Fix the input and retry: the migration completes and the data
        // is accessible.
        fs::write(
            dir.join("library.json"),
            r#"[{"id":"a","title":"Essay","textType":"essay","createdAt":"c","updatedAt":"u"}]"#,
        )
        .unwrap();
        fs::write(dir.join("text_a.json"), r#"{"content":"body"}"#).unwrap();
        let report2 = init_at(&dir, &db).unwrap();
        assert!(report2.completed);
        let guard = db.0.lock().unwrap();
        let conn = guard.as_ref().unwrap();
        assert_eq!(
            text_content_str(conn, "a").unwrap().as_deref(),
            Some("body")
        );
        drop(guard);
        fs::remove_dir_all(&dir).ok();
    }

    /// Conflict resolution ("use the browser copy") imports the chosen
    /// registry into the ACTIVE dataset without clearing the rest.
    #[test]
    fn conflict_resolution_import_merges_into_the_active_dataset() {        let conn = mem();
        create_text(&conn, &meta("native"), "native body").unwrap();

        let dir =
            std::env::temp_dir().join(format!("dws-conflict-merge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("library.json"),
            r#"[{"id":"browser","title":"Browser text","textType":"essay","createdAt":"c","updatedAt":"u"}]"#,
        )
        .unwrap();
        fs::write(dir.join("text_browser.json"), r#"{"content":"browser body"}"#).unwrap();

        let report = run_legacy_import(&conn, &dir, false).unwrap();
        assert!(report.completed);
        // The active dataset keeps its native rows…
        assert_eq!(
            text_content_str(&conn, "native").unwrap().as_deref(),
            Some("native body")
        );
        // …and gains the chosen browser entity.
        assert_eq!(
            text_content_str(&conn, "browser").unwrap().as_deref(),
            Some("browser body")
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// B09: a v1 (browser-generated) transfer preserves rich bodies,
    /// named snapshots, and navigator states instead of degrading
    /// everything to markdown.
    #[test]
    fn legacy_v1_transfer_preserves_rich_bodies_labels_and_states() {
        let conn = mem();
        let dir = std::env::temp_dir().join(format!("dws-v1-rich-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("library.json"),
            r#"[{"id":"a","title":"Rich browser text","textType":"essay","pinned":true,"archived":false,"createdAt":"c","updatedAt":"u"}]"#,
        )
        .unwrap();
        fs::write(
            dir.join("text_a.json"),
            r#"{"content":"{\"type\":\"doc\",\"content\":[]}","contentFormat":"tiptap-json","contentSchemaVersion":1,"plainText":"hello rich"}"#,
        )
        .unwrap();
        fs::write(
            dir.join("text_a.versions.json"),
            r##"[{"versionId":"v-1","savedAt":"s1","body":{"content":"# old","contentFormat":"markdown","contentSchemaVersion":1,"plainText":"old"},"label":"submitted draft"},{"savedAt":"s2","content":"legacy inline"}]"##,
        )
        .unwrap();

        let report = run_legacy_import(&conn, &dir, false).unwrap();
        assert!(report.completed);
        assert_eq!(report.counts.texts, 1);
        assert_eq!(report.counts.versions, 2);

        let body = text_content(&conn, "a").unwrap().unwrap();
        assert_eq!(body.content_format.as_deref(), Some("tiptap-json"));
        assert_eq!(body.plain_text.as_deref(), Some("hello rich"));

        let versions = text_versions(&conn, "a").unwrap();
        let labeled = versions
            .iter()
            .find(|v| v.version_id == "v-1")
            .expect("stable version id preserved");
        assert_eq!(labeled.label.as_deref(), Some("submitted draft"));
        assert_eq!(labeled.content_format.as_deref(), Some("markdown"));
        assert_eq!(labeled.plain_text.as_deref(), Some("old"));
        assert!(
            versions.iter().any(|v| v.content == "legacy inline"),
            "inline legacy version imported with a generated id"
        );

        let texts = texts_list(&conn).unwrap();
        assert!(texts[0].pinned, "pin state survived the transfer");
        fs::remove_dir_all(&dir).ok();
    }
}
