import type { Repository, StoredMessage, TextRestoreResult } from "@/utils/repository";
import type {
  LibraryTextMeta,
  ProjectMeta,
  TextVersion,
  ThreadMeta,
  SourceMeta,
  SourcePassage,
  DocumentProposal,
} from "@/types";
import type { DocumentBody } from "@/utils/documentCodec";

/**
 * In-memory repository for store tests. Implements the same interface as
 * the SQLite/JSON backends, applying writes immediately (including the
 * version-snapshot and revision semantics) so tests can assert on stored
 * state without mocks of the underlying transport.
 */

export interface FakeSourceEntry {
  meta: SourceMeta;
  passages: SourcePassage[];
  rev: number;
}

export interface FakeTextEntry {
  meta: LibraryTextMeta;
  body: DocumentBody;
  versions: TextVersion[];
  rev: number;
}

export interface FakeProjectEntry {
  meta: ProjectMeta;
  brief: string | null;
  rev: number;
}

export interface FakeThreadEntry {
  meta: ThreadMeta;
  briefJson: string | null;
  messages: StoredMessage[];
  rev: number;
}

export interface FakeRepoState {
  texts: Map<string, FakeTextEntry>;
  projects: Map<string, FakeProjectEntry>;
  threads: Map<string, FakeThreadEntry>;
  sources: Map<string, FakeSourceEntry>;
  /** Set to make the next repository call fail (error-path tests). */
  nextError: Error | null;
}

export const fakeRepoState: FakeRepoState = {
  texts: new Map(),
  projects: new Map(),
  threads: new Map(),
  sources: new Map(),
  nextError: null,
};

const MAX_VERSIONS = 20;

/** Stable unique version identity (timestamps alone can collide). */
let versionSeq = 0;
function nextVersionId(): string {
  versionSeq += 1;
  return `sv-${Date.now().toString(16)}-${versionSeq.toString(16)}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
}

/** Clone a row into the store shape (maps behave like plain copies here). */
function cloneMeta<T>(meta: T): T {
  return JSON.parse(JSON.stringify(meta)) as T;
}

export function resetFakeRepository(): void {
  fakeRepoState.texts.clear();
  fakeRepoState.projects.clear();
  fakeRepoState.threads.clear();
  fakeRepoState.sources.clear();
  fakeProposals.length = 0;
  fakeRepoState.nextError = null;
}

/** Persisted proposals for the reviewable-revision tests. */
const fakeProposals: DocumentProposal[] = [];

async function maybeFail(): Promise<void> {
  if (fakeRepoState.nextError) {
    const err = fakeRepoState.nextError;
    fakeRepoState.nextError = null;
    throw err;
  }
}

const listeners = new Set<() => void>();

/** Domain-save semantics shared by the three entity kinds: update-only. */
function applyTextSave(id: string, args: Parameters<Repository["textSave"]>[1]): number {
  const entry = fakeRepoState.texts.get(id);
  if (!entry) throw new Error(`Text not found: ${id}`);
  if (args.content !== undefined && args.content.content !== entry.body.content) {
    // Snapshot decision made here by comparing persisted content.
    entry.versions.unshift({
      versionId: nextVersionId(),
      savedAt: args.meta.updatedAt,
      body: entry.body,
    });
    entry.versions = entry.versions.slice(0, MAX_VERSIONS);
    entry.body = args.content;
  }
  entry.meta = cloneMeta(args.meta);
  entry.meta.updatedAt = args.meta.updatedAt;
  entry.rev += 1;
  return entry.rev;
}

function applyProjectSave(
  id: string,
  args: Parameters<Repository["projectSave"]>[1],
): number {
  const entry = fakeRepoState.projects.get(id);
  if (!entry) throw new Error(`Project not found: ${id}`);
  if (args.brief !== undefined) entry.brief = args.brief;
  entry.meta = cloneMeta(args.meta);
  entry.meta.updatedAt = args.meta.updatedAt;
  entry.rev += 1;
  return entry.rev;
}

function applyThreadSave(
  id: string,
  args: Parameters<Repository["threadSave"]>[1],
): number {
  const entry = fakeRepoState.threads.get(id);
  if (!entry) throw new Error(`Thread not found: ${id}`);
  entry.meta = cloneMeta(args.meta);
  entry.meta.updatedAt = args.meta.updatedAt;
  entry.briefJson = args.briefJson;
  entry.messages = args.messages.map((m) => ({ ...m }));
  entry.rev += 1;
  return entry.rev;
}

export const fakeRepository: Repository = {
  async idle() {
    await maybeFail();
  },
  async search(query) {
    await maybeFail();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: { kind: "text" | "project" | "thread"; docId: string; title: string; excerpt: string }[] = [];
    for (const entry of fakeRepoState.texts.values()) {
      const bodyText = entry.body.plainText || entry.body.content;
      if (
        entry.meta.title.toLowerCase().includes(q) ||
        bodyText.toLowerCase().includes(q)
      ) {
        hits.push({ kind: "text", docId: entry.meta.id, title: entry.meta.title, excerpt: "" });
      }
    }
    for (const entry of fakeRepoState.projects.values()) {
      if (
        entry.meta.title.toLowerCase().includes(q) ||
        (entry.brief ?? "").toLowerCase().includes(q)
      ) {
        hits.push({ kind: "project", docId: entry.meta.id, title: entry.meta.title, excerpt: "" });
      }
    }
    for (const entry of fakeRepoState.threads.values()) {
      if (
        entry.meta.title.toLowerCase().includes(q) ||
        entry.messages.some((m) => m.content.toLowerCase().includes(q))
      ) {
        hits.push({ kind: "thread", docId: entry.meta.id, title: entry.meta.title, excerpt: "" });
      }
    }
    return hits;
  },
  async flushTextSaves() {
    await maybeFail();
  },
  async flushProjectSaves() {
    await maybeFail();
  },
  async flushThreadSaves() {
    await maybeFail();
  },
  async drainTextSaves() {
    await fakeRepository.flushTextSaves();
  },
  async drainProjectSaves() {
    await fakeRepository.flushProjectSaves();
  },
  async drainThreadSaves() {
    await fakeRepository.flushThreadSaves();
  },

  async textsList() {
    await maybeFail();
    return [...fakeRepoState.texts.values()].map((t) => cloneMeta(t.meta));
  },
  async textCreate(meta, body) {
    await maybeFail();
    if (fakeRepoState.texts.has(meta.id)) {
      throw new Error(`Text already exists: ${meta.id}`);
    }
    fakeRepoState.texts.set(meta.id, {
      meta: cloneMeta(meta),
      body,
      versions: [],
      rev: 0,
    });
  },
  textScheduleSave(id, args) {
    // Synchronous on purpose: tests assert state right after store calls.
    // An ARMED failure is reserved for the awaited flush (like the real
    // repository, where the debounced write happens on flush and may
    // fail): the scheduled write must not silently succeed first.
    if (fakeRepoState.nextError) return;
    try {
      applyTextSave(id, args);
    } catch {
      // Same failure semantics as the real backends: the scheduled save
      // fails silently here; the real repository retains a retryable
      // failure. Tests inject failures via nextError on awaited calls.
    }
  },
  async textSave(id, args) {
    await maybeFail();
    return applyTextSave(id, args);
  },
  async textContent(id) {
    await maybeFail();
    return fakeRepoState.texts.get(id)?.body ?? null;
  },
  async textVersions(id) {
    await maybeFail();
    return [...(fakeRepoState.texts.get(id)?.versions ?? [])];
  },
  async textSnapshot(id, label, now) {
    await maybeFail();
    const entry = fakeRepoState.texts.get(id);
    if (!entry) throw new Error(`Text not found: ${id}`);
    const versionId = nextVersionId();
    entry.versions.unshift({
      versionId,
      savedAt: now,
      body: entry.body,
      label,
    });
    entry.versions = entry.versions.slice(0, MAX_VERSIONS);
    return versionId;
  },
  async textRestore(id, versionId) {
    await maybeFail();
    const entry = fakeRepoState.texts.get(id);
    if (!entry) throw new Error(`Text not found: ${id}`);
    const target = entry.versions.find((v) => v.versionId === versionId);
    if (!target) throw new Error(`Version not found: ${versionId}`);
    if (entry.body.content !== target.body.content) {
      entry.versions.unshift({
        versionId: nextVersionId(),
        savedAt: new Date().toISOString(),
        body: entry.body,
      });
      entry.versions = entry.versions.slice(0, MAX_VERSIONS);
    }
    entry.body = target.body;
    const now = new Date().toISOString();
    const text = target.body.plainText || target.body.content;
    const snippet = text
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
      .slice(0, 180);
    const wordCountValue = text.split(/\s+/).filter(Boolean).length;
    entry.meta.snippet = snippet;
    entry.meta.wordCount = wordCountValue;
    entry.meta.updatedAt = now;
    entry.rev += 1;
    const result: TextRestoreResult = {
      rev: entry.rev,
      savedAt: target.savedAt,
      body: target.body,
      snippet,
      wordCount: wordCountValue,
      updatedAt: now,
    };
    return result;
  },
  async textDelete(id) {
    await maybeFail();
    fakeRepoState.texts.delete(id);
  },

  async projectsList() {
    await maybeFail();
    return [...fakeRepoState.projects.values()].map((p) => cloneMeta(p.meta));
  },
  async projectCreate(meta) {
    await maybeFail();
    if (fakeRepoState.projects.has(meta.id)) {
      throw new Error(`Project already exists: ${meta.id}`);
    }
    fakeRepoState.projects.set(meta.id, {
      meta: cloneMeta(meta),
      brief: null,
      rev: 0,
    });
  },
  projectScheduleSave(id, args) {
    // Synchronous on purpose: tests assert state right after store calls.
    // Armed failures belong to the awaited flush (see textScheduleSave).
    if (fakeRepoState.nextError) return;
    try {
      applyProjectSave(id, args);
    } catch {
      // See textScheduleSave.
    }
  },
  async projectSave(id, args) {
    await maybeFail();
    return applyProjectSave(id, args);
  },
  async projectBrief(id) {
    await maybeFail();
    return fakeRepoState.projects.get(id)?.brief ?? null;
  },
  async projectDelete(id) {
    await maybeFail();
    // One domain operation: unlink texts + conversations, remove brief.
    for (const entry of fakeRepoState.texts.values()) {
      if (entry.meta.projectId === id) {
        entry.meta = { ...entry.meta, projectId: undefined };
      }
    }
    for (const entry of fakeRepoState.threads.values()) {
      if (entry.meta.projectId === id) {
        entry.meta = { ...entry.meta, projectId: undefined };
      }
    }
    fakeRepoState.projects.delete(id);
  },

  // Sources (Phase 5.1)
  async sourcesList() {
    await maybeFail();
    return [...fakeRepoState.sources.values()].map((s) => cloneMeta(s.meta));
  },
  async sourceGet(id) {
    await maybeFail();
    const entry = fakeRepoState.sources.get(id);
    if (!entry) return null;
    return {
      source: cloneMeta(entry.meta),
      passages: entry.passages.map((p) => ({ ...p })),
      rev: entry.rev,
    };
  },
  async sourceCreate(meta, passages) {
    await maybeFail();
    if (fakeRepoState.sources.has(meta.id)) {
      throw new Error(`Source already exists: ${meta.id}`);
    }
    for (const entry of fakeRepoState.sources.values()) {
      if (entry.meta.contentHash === meta.contentHash) {
        throw new Error(
          `A source with identical content already exists (${meta.title})`,
        );
      }
    }
    fakeRepoState.sources.set(meta.id, {
      meta: cloneMeta(meta),
      passages: passages.map((p) => ({ ...p })),
      rev: 0,
    });
  },
  async sourceSave(id, source, passages) {
    await maybeFail();
    const entry = fakeRepoState.sources.get(id);
    if (!entry) throw new Error(`Source not found: ${id}`);
    entry.meta = cloneMeta(source);
    // Omitted passages = metadata-only save (unchanged); an explicit list
    // (including []) intentionally replaces them.
    if (passages !== undefined) {
      entry.passages = passages.map((p) => ({ ...p }));
    }
    entry.rev += 1;
    return entry.rev;
  },
  async sourceDelete(id) {
    await maybeFail();
    fakeRepoState.sources.delete(id);
  },

  // Reviewable revision proposals (Phase 5.3) — the list lives in module
  // state below, reset with everything else.
  async proposalsList(documentId) {
    await maybeFail();
    return fakeProposals.filter((p) => p.documentId === documentId);
  },
  async proposalCreate(proposal) {
    await maybeFail();
    fakeProposals.unshift(proposal);
  },
  async proposalSetStatus(id, status) {
    await maybeFail();
    const found = fakeProposals.find((p) => p.id === id);
    if (!found) throw new Error(`Proposal not found: ${id}`);
    found.status = status;
    found.updatedAt = new Date().toISOString();
  },
  peekRev(kind, id) {
    void kind;
    void id;
    return null;
  },

  async threadsList() {
    await maybeFail();
    return [...fakeRepoState.threads.values()].map((t) => cloneMeta(t.meta));
  },
  async threadCreate(meta) {
    await maybeFail();
    if (fakeRepoState.threads.has(meta.id)) {
      throw new Error(`Thread already exists: ${meta.id}`);
    }
    fakeRepoState.threads.set(meta.id, {
      meta: cloneMeta(meta),
      briefJson: null,
      messages: [],
      rev: 0,
    });
  },
  async threadGet(id) {
    await maybeFail();
    const entry = fakeRepoState.threads.get(id);
    if (!entry) return null;
    return {
      briefJson: entry.briefJson,
      messages: entry.messages.map((m) => ({ ...m })),
      rev: entry.rev,
    };
  },
  threadScheduleSave(id, args) {
    // Synchronous on purpose: tests assert state right after store calls.
    // Armed failures belong to the awaited flush (see textScheduleSave).
    if (fakeRepoState.nextError) return;
    try {
      applyThreadSave(id, args);
    } catch {
      // See textScheduleSave.
    }
  },
  async threadSave(id, args) {
    await maybeFail();
    return applyThreadSave(id, args);
  },
  async threadAppendMessage(id, message, updatedAt) {
    await maybeFail();
    const entry = fakeRepoState.threads.get(id);
    if (!entry) throw new Error(`Thread not found: ${id}`);
    entry.messages.push({ ...message });
    entry.meta.updatedAt = updatedAt;
    entry.rev += 1;
  },
  async threadReplaceMessage(id, messageId, content, incomplete, updatedAt) {
    await maybeFail();
    const entry = fakeRepoState.threads.get(id);
    if (!entry) throw new Error(`Thread not found: ${id}`);
    const message = entry.messages.find((m) => m.id === messageId);
    if (!message) throw new Error(`Message not found: ${messageId}`);
    message.content = content;
    message.incomplete = incomplete;
    entry.meta.updatedAt = updatedAt;
    entry.rev += 1;
  },
  async threadRename(id, title, updatedAt) {
    await maybeFail();
    const entry = fakeRepoState.threads.get(id);
    if (!entry) throw new Error(`Thread not found: ${id}`);
    entry.meta = { ...entry.meta, title, updatedAt };
    entry.rev += 1;
  },
  async textSetState(id, patch, updatedAt) {
    await maybeFail();
    const entry = fakeRepoState.texts.get(id);
    if (!entry) throw new Error(`Text not found: ${id}`);
    entry.meta = {
      ...entry.meta,
      archived: patch.archived ?? (entry.meta.archived ?? false),
      pinned: patch.pinned ?? (entry.meta.pinned ?? false),
      updatedAt,
    };
    entry.rev += 1;
  },
  async threadSetState(id, patch, updatedAt) {
    await maybeFail();
    const entry = fakeRepoState.threads.get(id);
    if (!entry) throw new Error(`Thread not found: ${id}`);
    entry.meta = {
      ...entry.meta,
      archived: patch.archived ?? (entry.meta.archived ?? false),
      pinned: patch.pinned ?? (entry.meta.pinned ?? false),
      updatedAt,
    };
    entry.rev += 1;
  },
  async threadSetFolder(id, folder, updatedAt) {
    await maybeFail();
    const entry = fakeRepoState.threads.get(id);
    if (!entry) throw new Error(`Thread not found: ${id}`);
    entry.meta = { ...entry.meta, folder: folder ?? undefined, updatedAt };
    entry.rev += 1;
  },
  async threadDelete(id) {
    await maybeFail();
    fakeRepoState.threads.delete(id);
  },

  saveFailures: () => [],
  async retrySave() {
    await maybeFail();
  },
  async resolveSaveFailure() {
    await maybeFail();
  },
  saveState: () => ({ scheduled: 0, inFlight: 0, failed: 0 }),
  subscribeSaveState: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  resetSessionState: () => {
    // Nothing cached in the fake beyond the maps themselves.
  },
  // The canonical dump contract (B21d) is exercised against the REAL
  // backends (`backup.test.ts`); this store-test double deliberately does
  // not fake it, so a backup flow can never silently test the fake.
  async exportDump() {
    throw new Error(
      "fakeRepository does not implement exportDump; use a real repository backend.",
    );
  },
  async replaceDump() {
    throw new Error(
      "fakeRepository does not implement replaceDump; use a real repository backend.",
    );
  },
};
