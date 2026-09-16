import { create } from "zustand";
import type {
  ExtractionStatus,
  SourceMeta,
  SourcePassage,
  VerificationStatus,
} from "@/types";
import { contentIdentity, normalizeDoi } from "@/types";
import { repo } from "@/utils/repository";
import { datasetGeneration } from "@/utils/datasetGeneration";
import { extractFromFile, type ExtractionHandle } from "@/services/sourceExtraction";

// ──────────────────────────────────────────────
// Source store (Phase 5.1, ownership-checked in B13)
// ──────────────────────────────────────────────
// Versioned source records + extracted passages. Deduplication is by
// CONTENT IDENTITY — the SHA-256 of the original text, or of the uploaded
// FILE'S BYTES (a truncated extraction must not collapse distinct files
// into one). The file name plays no part. Extraction runs in the
// background, is cancellable, and is owned by the JOB and the dataset
// generation it started in: a restore or cancel discards its result
// entirely. Metadata edits never touch stored passages.

export interface SourceInput {
  title: string;
  author?: string;
  year?: string;
  doi?: string;
  url?: string;
  language?: string;
  translation?: string;
  /** Bibliographic type (a CSL type when known). */
  sourceType?: string;
  containerTitle?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  /** Abstract, kept separate from notes and translation attribution. */
  abstract?: string;
  /** Free-form notes about this source. */
  notes?: string;
  projectId?: string;
  text: string;
  /** Original file name / origin, when the text came from an asset. */
  assetRef?: string;
  /** Pre-derived passages; derived from text when omitted. */
  passages?: SourcePassage[];
  extractionStatus?: ExtractionStatus;
  truncationNote?: string;
  /** Precomputed identity (e.g. an uploaded file's byte hash). Omitted =
   * derived from the normalized DOI when present, else the text. */
  contentHash?: string;
}

export interface ExtractionJob {
  id: string;
  name: string;
  status: "extracting" | "done" | "cancelled" | "failed";
  error?: string;
}

interface SourceState {
  sources: SourceMeta[];
  sourcesLoaded: boolean;
  /** Background extraction jobs (upload → passages), by job id. */
  jobs: Record<string, ExtractionJob>;

  loadSources: () => Promise<void>;
  ensureLoaded: () => Promise<void>;

  /** Add a source from provided text. Duplicate identity → duplicate: true
   * (and `merged: true` when absent metadata was filled from the input);
   * the existing source is never overwritten. `guard` is checked
   * immediately before the repository write: a caller whose extraction was
   * cancelled/restored away aborts the commit. */
  addSource: (
    input: SourceInput,
    guard?: () => boolean,
  ) => Promise<{ id: string; duplicate: boolean; merged?: boolean }>;

  /** Upload a file: background extraction, cancellable. Returns the job id. */
  addSourceFromFile: (
    file: File,
    meta?: Partial<Pick<SourceInput, "title" | "author" | "year" | "projectId">>,
  ) => Promise<string>;

  /** Cancel a running extraction; its result is discarded. */
  cancelExtraction: (jobId: string) => void;

  updateSource: (
    id: string,
    patch: Partial<
      Pick<
        SourceMeta,
        | "title"
        | "author"
        | "year"
        | "doi"
        | "url"
        | "language"
        | "translation"
        | "notes"
        | "sourceType"
        | "containerTitle"
        | "publisher"
        | "volume"
        | "issue"
        | "pages"
        | "abstract"
      >
    >,
  ) => Promise<void>;

  /** User-controlled context inclusion. */
  setIncluded: (id: string, included: boolean) => Promise<void>;
  /** Verification status (one of the distinct states, never a score). */
  setVerification: (id: string, status: VerificationStatus) => Promise<void>;
  deleteSource: (id: string) => Promise<void>;

  resetForRestore: () => Promise<void>;
}

const extractionHandles = new Map<string, ExtractionHandle>();

export const useSourceStore = create<SourceState>((set, get) => ({
  sources: [],
  sourcesLoaded: false,
  jobs: {},

  loadSources: async () => {
    const sources = await repo.sourcesList();
    sources.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    set({ sources, sourcesLoaded: true });
  },

  ensureLoaded: async () => {
    if (get().sourcesLoaded) return;
    await get().loadSources();
  },

  addSource: async (input, guard) => {
    await get().ensureLoaded();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    // Identity: the file's bytes when the caller supplies them (a
    // truncated extraction must not merge distinct files); the normalized
    // DOI when the source carries one (a formatted reference line is
    // presentation, not identity); the extracted text otherwise.
    const doi = input.doi?.trim() ? normalizeDoi(input.doi) : "";
    const hash =
      input.contentHash ??
      (doi ? `doi:${doi}` : await contentIdentity(input.text));
    // Ownership is rechecked AFTER the async identity work, immediately
    // before the write: a cancelled/restored-away upload commits nothing.
    if (guard && !guard()) {
      throw Object.assign(new Error("cancelled"), { cancelled: true });
    }
    const meta: SourceMeta = {
      id,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      title: input.title.trim() || "Untitled source",
      ...(input.author?.trim() ? { author: input.author.trim() } : {}),
      ...(input.year?.trim() ? { year: input.year.trim() } : {}),
      ...(input.doi?.trim() ? { doi: input.doi.trim() } : {}),
      ...(input.url?.trim() ? { url: input.url.trim() } : {}),
      ...(input.language?.trim() ? { language: input.language.trim() } : {}),
      ...(input.translation?.trim() ? { translation: input.translation.trim() } : {}),
      ...(input.sourceType?.trim() ? { sourceType: input.sourceType.trim() } : {}),
      ...(input.containerTitle?.trim()
        ? { containerTitle: input.containerTitle.trim() }
        : {}),
      ...(input.publisher?.trim() ? { publisher: input.publisher.trim() } : {}),
      ...(input.volume?.trim() ? { volume: input.volume.trim() } : {}),
      ...(input.issue?.trim() ? { issue: input.issue.trim() } : {}),
      ...(input.pages?.trim() ? { pages: input.pages.trim() } : {}),
      ...(input.abstract?.trim() ? { abstract: input.abstract.trim() } : {}),
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      ...(input.assetRef ? { assetRef: input.assetRef } : {}),
      // The original text is preserved VERBATIM (never re-wrapped).
      originalText: input.text,
      contentHash: hash,
      extractionStatus: input.extractionStatus ?? "ready",
      ...(input.truncationNote ? { truncationNote: input.truncationNote } : {}),
      includedInContext: true,
      verification: "unverified",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await repo.sourceCreate(meta, input.passages ?? []);
      set((s) => ({ sources: [meta, ...s.sources] }));
      return { id, duplicate: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("identical content")) {
        // Duplicate identity: the existing source is the truth. ABSENT
        // metadata from this import is filled in (merge) and reported to
        // the caller; existing values are never overwritten.
        const existing = get().sources.find((s) => s.contentHash === hash);
        if (!existing) return { id: "", duplicate: true, merged: false };
        const fillable = [
          "author",
          "year",
          "doi",
          "url",
          "language",
          "translation",
          "sourceType",
          "containerTitle",
          "publisher",
          "volume",
          "issue",
          "pages",
          "abstract",
          "notes",
          "assetRef",
        ] as const;
        const patch: Partial<SourceMeta> = {};
        for (const key of fillable) {
          const incoming = meta[key];
          if (incoming == null || incoming === "") continue;
          const current = existing[key];
          if (current == null || current === "") {
            (patch as Record<string, unknown>)[key] = incoming;
          }
        }
        if (Object.keys(patch).length === 0) {
          return { id: existing.id, duplicate: true, merged: false };
        }
        const next: SourceMeta = {
          ...existing,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        try {
          await repo.sourceSave(existing.id, next);
        } catch {
          // The duplicate itself is safe; a failed METADATA merge must not
          // fail the whole import (the imported file is not data loss).
          return { id: existing.id, duplicate: true, merged: false };
        }
        set((s) => ({
          sources: s.sources.map((x) => (x.id === existing.id ? next : x)),
        }));
        return { id: existing.id, duplicate: true, merged: true };
      }
      throw err;
    }
  },

  addSourceFromFile: async (file, meta = {}) => {
    await get().ensureLoaded();
    const generation = datasetGeneration();
    const jobId = crypto.randomUUID();
    set((s) => ({
      jobs: {
        ...s.jobs,
        [jobId]: {
          id: jobId,
          name: meta.title?.trim() || file.name,
          status: "extracting",
        },
      },
    }));
    const handle = extractFromFile(file);
    extractionHandles.set(jobId, handle);
    /** The job is the live owner of its result only while it is still
     * extracting AND the dataset generation has not been replaced. */
    const ownsJob = () =>
      get().jobs[jobId]?.status === "extracting" &&
      generation === datasetGeneration();
    void handle.promise
      .then(async (outcome) => {
        if (!ownsJob()) return;
        if (!outcome.text.trim()) {
          // An empty extraction is unusable: fail the job, add nothing.
          set((s) => ({
            jobs: {
              ...s.jobs,
              [jobId]: {
                ...(s.jobs[jobId] ?? { id: jobId, name: file.name }),
                status: "failed",
                error:
                  outcome.truncationNote ??
                  "No text could be extracted from this file; nothing was added.",
              },
            },
          }));
          return;
        }
        await get().addSource(
          {
            title: meta.title?.trim() || file.name.replace(/\.[^.]+$/, ""),
            author: meta.author,
            year: meta.year,
            projectId: meta.projectId,
            assetRef: file.name,
            text: outcome.text,
            passages: outcome.passages,
            extractionStatus: outcome.truncated ? "truncated" : "ready",
            truncationNote: outcome.truncationNote,
            // Dedup identity = the FILE'S BYTES, not the (possibly
            // truncated) extracted text.
            contentHash: outcome.fileHash,
          },
          ownsJob,
        );
        if (!ownsJob()) return;
        set((s) => ({
          jobs: { ...s.jobs, [jobId]: { ...(s.jobs[jobId] ?? { id: jobId, name: file.name }), status: "done" } },
        }));
      })
      .catch((err) => {
        // A job vanished (cancelled or cleared by a restore): nothing may
        // reappear. A missing job is NOT an active job.
        if (!get().jobs[jobId]) return;
        if (generation !== datasetGeneration()) return;
        const cancelled = (err as { cancelled?: boolean })?.cancelled === true;
        set((s) => ({
          jobs: {
            ...s.jobs,
            [jobId]: {
              ...(s.jobs[jobId] ?? { id: jobId, name: file.name }),
              status: cancelled ? "cancelled" : "failed",
              ...(cancelled ? {} : { error: err instanceof Error ? err.message : String(err) }),
            },
          },
        }));
      })
      .finally(() => {
        extractionHandles.delete(jobId);
      });
    return jobId;
  },

  cancelExtraction: (jobId) => {
    extractionHandles.get(jobId)?.cancel();
    set((s) => {
      const job = s.jobs[jobId];
      if (!job || job.status !== "extracting") return {};
      return { jobs: { ...s.jobs, [jobId]: { ...job, status: "cancelled" } } };
    });
  },

  updateSource: async (id, patch) => {
    await get().ensureLoaded();
    const current = get().sources.find((s) => s.id === id);
    if (!current) return;
    const now = new Date().toISOString();
    const next: SourceMeta = {
      ...current,
      ...Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      ),
      updatedAt: now,
    };
    // Persist FIRST (metadata only — passages stay untouched); a failed
    // write surfaces to the caller instead of looking saved.
    await repo.sourceSave(id, next);
    set((s) => ({
      sources: s.sources.map((s) => (s.id === id ? next : s)),
    }));
  },

  setIncluded: async (id, included) => {
    await get().ensureLoaded();
    const current = get().sources.find((s) => s.id === id);
    if (!current) return;
    const now = new Date().toISOString();
    const next: SourceMeta = { ...current, includedInContext: included, updatedAt: now };
    await repo.sourceSave(id, next);
    set((s) => ({ sources: s.sources.map((s) => (s.id === id ? next : s)) }));
  },

  setVerification: async (id, status) => {
    await get().ensureLoaded();
    const current = get().sources.find((s) => s.id === id);
    if (!current) return;
    const now = new Date().toISOString();
    const next: SourceMeta = { ...current, verification: status, updatedAt: now };
    await repo.sourceSave(id, next);
    set((s) => ({ sources: s.sources.map((s) => (s.id === id ? next : s)) }));
  },

  deleteSource: async (id) => {
    await get().ensureLoaded();
    await repo.sourceDelete(id);
    set((s) => ({ sources: s.sources.filter((s) => s.id !== id) }));
  },

  resetForRestore: async () => {
    // Cancel every in-flight extraction BEFORE the dataset swap: a result
    // from the old dataset must never be committed into the restored one.
    for (const handle of extractionHandles.values()) handle.cancel();
    extractionHandles.clear();
    set({ sources: [], sourcesLoaded: false, jobs: {} });
    await get().loadSources();
  },
}));
