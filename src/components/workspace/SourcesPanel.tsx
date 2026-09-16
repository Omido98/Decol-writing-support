import { useEffect, useRef, useState } from "react";
import { useSourceStore, type ExtractionJob } from "@/stores/sourceStore";
import type { SourceMeta, VerificationStatus } from "@/types";
import {
  parseBibTeX,
  parseRIS,
  parseCslJson,
  serializeBibTeX,
  serializeRIS,
  serializeCslJson,
} from "@/utils/bibliography";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  BookUp,
  FileDown,
  FileText,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { UPLOAD_ACCEPT, isSupportedUpload } from "@/utils/fileParse";

// ──────────────────────────────────────────────
// SourcesPanel (Phase 5.1)
// ──────────────────────────────────────────────
// The inspector's source surface: the project's source records with
// extracted passages, user-controlled context inclusion, verification
// status, background extraction jobs (cancellable), and dedup feedback.

const VERIFICATION_OPTIONS: { id: VerificationStatus; label: string }[] = [
  { id: "unverified", label: "Support unverified" },
  { id: "retrieved", label: "Source retrieved" },
  { id: "quote_matched", label: "Quote matched" },
  { id: "supports", label: "Passage appears to support claim" },
  { id: "disputed", label: "Support disputed" },
];

export default function SourcesPanel() {
  const sources = useSourceStore((s) => s.sources);
  const sourcesLoaded = useSourceStore((s) => s.sourcesLoaded);
  const loadSources = useSourceStore((s) => s.loadSources);
  const jobs = useSourceStore((s) => s.jobs);

  useEffect(() => {
    if (!sourcesLoaded) void loadSources();
  }, [sourcesLoaded, loadSources]);

  return (
    <div className="flex flex-col h-full min-h-0 text-sm">
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
        {!sourcesLoaded ? (
          <p className="text-xs text-text-muted px-1 py-4">Loading…</p>
        ) : sources.length === 0 && Object.keys(jobs).length === 0 ? (
          <p className="text-xs text-text-muted px-1 py-4 max-w-[34ch]">
            No sources yet. Add material below — paste text or upload a
            document. Identical content is only stored once.
          </p>
        ) : (
          <>
            {Object.values(jobs)
              .filter((j) => j.status === "extracting" || j.status === "failed")
              .map((job) => <JobRow key={job.id} job={job} />)}
            {sources.map((s) => (
              <SourceRow key={s.id} id={s.id} />
            ))}
          </>
        )}
      </div>
      <AddSourceForm />
    </div>
  );
}

function JobRow({ job }: { job: ExtractionJob }) {
  const cancelExtraction = useSourceStore((s) => s.cancelExtraction);
  return (
    <div
      role="status"
      className="rounded-lg border border-border bg-surface-alt px-3 py-2 flex items-center gap-2 text-xs"
    >
      {job.status === "extracting" ? (
        <Loader2 className="size-3.5 animate-spin text-text-secondary shrink-0" />
      ) : (
        <TriangleAlert className="size-3.5 text-warning shrink-0" />
      )}
      <span className="flex-1 min-w-0 truncate">
        {job.status === "extracting" && <>Extracting “{job.name}”…</>}
        {job.status === "failed" && (
          <>Extraction failed for “{job.name}”: {job.error ?? "unknown error"}</>
        )}
        {job.status === "cancelled" && <>Extraction cancelled.</>}
      </span>
      {job.status === "extracting" && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => cancelExtraction(job.id)}
          aria-label="Cancel extraction"
          title="Cancel extraction"
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

function SourceRow({ id }: { id: string }) {
  const source = useSourceStore((s) => s.sources.find((x) => x.id === id) ?? null);
  const setIncluded = useSourceStore((s) => s.setIncluded);
  const setVerification = useSourceStore((s) => s.setVerification);
  const deleteSource = useSourceStore((s) => s.deleteSource);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /** Run a persistence action; failures are VISIBLE, never an
   * acknowledged success (the store only updates after the write). */
  const run = async (action: () => Promise<void>) => {
    setFailure(null);
    try {
      await action();
    } catch (err) {
      setFailure(
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  if (!source) return null;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 px-3 py-2">
        <Checkbox
          checked={source.includedInContext}
          onCheckedChange={(v) => void run(() => setIncluded(id, v === true))}
          aria-label={`Include “${source.title}” in AI context`}
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 text-left"
          aria-expanded={open}
        >
          <span className="block truncate text-text-primary font-medium text-xs">
            {source.title}
          </span>
          <span className="block truncate text-[11px] text-text-muted">
            {[source.author, source.year].filter(Boolean).join(", ") || "no attribution yet"}
          </span>
        </button>
        <VerificationDot status={source.verification} />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void run(() => deleteSource(id))}
          aria-label={`Delete source “${source.title}”`}
          title="Delete source"
        >
          <Trash2 className="size-3.5 text-text-muted" />
        </Button>
      </div>

      {failure && (
        <p
          role="alert"
          className="px-3 pb-2 text-[11px] text-warning flex items-start gap-1.5"
        >
          <TriangleAlert className="size-3 mt-0.5 shrink-0" />
          <span>
            Could not save this change: {failure} The source is unchanged.
          </span>
        </p>
      )}

      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-border pt-2">
          {source.truncationNote && (
            <p role="status" className="text-[11px] text-warning flex items-start gap-1.5">
              <TriangleAlert className="size-3 mt-0.5 shrink-0" />
              {source.truncationNote}
            </p>
          )}
          {source.doi && (
            <p className="text-[11px] text-text-muted truncate">DOI: {source.doi}</p>
          )}
          {source.url && (
            <p className="text-[11px] text-text-muted truncate">URL: {source.url}</p>
          )}
          {source.language && (
            <p className="text-[11px] text-text-muted">
              Original language: {source.language}
              {source.translation ? ` · ${source.translation}` : ""}
            </p>
          )}
          {(source.sourceType ||
            source.containerTitle ||
            source.publisher ||
            source.volume ||
            source.issue ||
            source.pages) && (
            <p className="text-[11px] text-text-muted">
              {[
                source.sourceType,
                source.containerTitle,
                source.publisher,
                source.volume ? `vol. ${source.volume}` : "",
                source.issue ? `no. ${source.issue}` : "",
                source.pages ? `pp. ${source.pages}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {source.abstract && (
            <p className="text-[11px] text-text-muted max-h-24 overflow-y-auto whitespace-pre-wrap">
              {source.abstract}
            </p>
          )}
          {source.notes && (
            <p className="text-[11px] text-text-muted max-h-24 overflow-y-auto whitespace-pre-wrap">
              Notes: {source.notes}
            </p>
          )}
          <div>
            <Label className="text-[10px] text-text-muted">Verification</Label>
            <select
              value={source.verification}
              onChange={(e) =>
                void run(() =>
                  setVerification(id, e.target.value as VerificationStatus),
                )
              }
              className="w-full h-7 rounded-md border border-border bg-field px-2 text-xs text-text-primary"
              aria-label={`Verification status of “${source.title}”`}
            >
              {VERIFICATION_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {source.originalText && (
            <details className="text-[11px] text-text-muted">
              <summary className="cursor-pointer select-none">Original text</summary>
              <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap [font-family:var(--font-doc)] text-text-secondary">
                {source.originalText.slice(0, 4000)}
                {source.originalText.length > 4000 ? "…" : ""}
              </p>
            </details>
          )}
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-expanded={editing}
            aria-label={`Edit metadata of “${source.title}”`}
            className="text-[11px] text-primary hover:text-primary/80 select-none"
          >
            {editing ? "Close metadata editor" : "Edit metadata"}
          </button>
          {editing && (
            <SourceMetadataForm
              source={source}
              onClose={() => setEditing(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function VerificationDot({ status }: { status: VerificationStatus }) {
  const title =
    VERIFICATION_OPTIONS.find((o) => o.id === status)?.label ?? status;
  const color =
    status === "unverified"
      ? "bg-surface-alt border border-border"
      : status === "disputed"
        ? "bg-destructive"
        : status === "supports"
          ? "bg-primary"
          : "bg-warning";
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={`size-2.5 rounded-full shrink-0 ${color}`}
    >
      <ShieldCheck className="sr-only" />
      <FileText className="sr-only" />
    </span>
  );
}

// ──────────────────────────────────────────────
// Source metadata editing (B18)
// ──────────────────────────────────────────────

interface MetadataDraft {
  title: string;
  author: string;
  year: string;
  sourceType: string;
  containerTitle: string;
  publisher: string;
  volume: string;
  issue: string;
  pages: string;
  doi: string;
  url: string;
  language: string;
  translation: string;
  abstract: string;
  notes: string;
}

function metadataDraft(s: SourceMeta): MetadataDraft {
  return {
    title: s.title,
    author: s.author ?? "",
    year: s.year ?? "",
    sourceType: s.sourceType ?? "",
    containerTitle: s.containerTitle ?? "",
    publisher: s.publisher ?? "",
    volume: s.volume ?? "",
    issue: s.issue ?? "",
    pages: s.pages ?? "",
    doi: s.doi ?? "",
    url: s.url ?? "",
    language: s.language ?? "",
    translation: s.translation ?? "",
    abstract: s.abstract ?? "",
    notes: s.notes ?? "",
  };
}

/** The patch: empty optional fields CLEAR; the title never becomes empty. */
function metadataPatch(
  draft: MetadataDraft,
  currentTitle: string,
): Partial<SourceMeta> {
  return {
    title: draft.title.trim() || currentTitle,
    author: draft.author.trim(),
    year: draft.year.trim(),
    sourceType: draft.sourceType.trim(),
    containerTitle: draft.containerTitle.trim(),
    publisher: draft.publisher.trim(),
    volume: draft.volume.trim(),
    issue: draft.issue.trim(),
    pages: draft.pages.trim(),
    doi: draft.doi.trim(),
    url: draft.url.trim(),
    language: draft.language.trim(),
    translation: draft.translation.trim(),
    abstract: draft.abstract.trim(),
    notes: draft.notes.trim(),
  };
}

/** Edit the retained bibliography metadata; a failed write is visible and
 * leaves the stored source unchanged (the store saves before updating). */
function SourceMetadataForm({
  source,
  onClose,
}: {
  source: SourceMeta;
  onClose: () => void;
}) {
  const updateSource = useSourceStore((s) => s.updateSource);
  const [draft, setDraft] = useState<MetadataDraft>(() => metadataDraft(source));
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const field = (key: keyof MetadataDraft) => ({
    value: draft[key],
    onChange: (e: { target: { value: string } }) =>
      setDraft((d) => ({ ...d, [key]: e.target.value })),
  });

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await updateSource(source.id, metadataPatch(draft, source.title));
      onClose();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 space-y-2 border-t border-border pt-2">
      <p className="text-[10px] uppercase tracking-wide text-text-muted">
        Edit metadata
      </p>
      <Input
        {...field("title")}
        aria-label="Edit title"
        placeholder="Title…"
        className="h-7 bg-field text-xs"
      />
      <div className="flex gap-2">
        <Input
          {...field("author")}
          aria-label="Edit author"
          placeholder="Author…"
          className="h-7 bg-field text-xs flex-1"
        />
        <Input
          {...field("year")}
          aria-label="Edit year"
          placeholder="Year…"
          className="h-7 bg-field text-xs w-16"
        />
      </div>
      <div className="flex gap-2">
        <Input
          {...field("sourceType")}
          aria-label="Edit type"
          placeholder="article-journal, book…"
          className="h-7 bg-field text-xs flex-1"
        />
        <Input
          {...field("containerTitle")}
          aria-label="Edit container"
          placeholder="Journal / book…"
          className="h-7 bg-field text-xs flex-1"
        />
      </div>
      <Input
        {...field("publisher")}
        aria-label="Edit publisher"
        placeholder="Publisher…"
        className="h-7 bg-field text-xs"
      />
      <div className="flex gap-2">
        <Input
          {...field("volume")}
          aria-label="Edit volume"
          placeholder="Vol."
          className="h-7 bg-field text-xs w-16"
        />
        <Input
          {...field("issue")}
          aria-label="Edit issue"
          placeholder="Issue"
          className="h-7 bg-field text-xs w-16"
        />
        <Input
          {...field("pages")}
          aria-label="Edit pages"
          placeholder="Pages"
          className="h-7 bg-field text-xs flex-1"
        />
      </div>
      <div className="flex gap-2">
        <Input
          {...field("doi")}
          aria-label="Edit DOI"
          placeholder="DOI…"
          className="h-7 bg-field text-xs flex-1"
        />
        <Input
          {...field("url")}
          aria-label="Edit URL"
          placeholder="URL…"
          className="h-7 bg-field text-xs flex-1"
        />
      </div>
      <div className="flex gap-2">
        <Input
          {...field("language")}
          aria-label="Edit language"
          placeholder="Language…"
          className="h-7 bg-field text-xs flex-1"
        />
        <Input
          {...field("translation")}
          aria-label="Edit translation"
          placeholder="Translation attribution…"
          className="h-7 bg-field text-xs flex-1"
        />
      </div>
      <textarea
        {...field("abstract")}
        aria-label="Edit abstract"
        placeholder="Abstract…"
        rows={3}
        className="w-full rounded-md border border-border bg-field px-2 py-1.5 text-xs resize-y"
      />
      <textarea
        {...field("notes")}
        aria-label="Edit notes"
        placeholder="Notes…"
        rows={2}
        className="w-full rounded-md border border-border bg-field px-2 py-1.5 text-xs resize-y"
      />
      {failure && (
        <p role="alert" className="text-[11px] text-warning">
          Could not save this change: {failure} The source is unchanged.
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={busy}
          className="flex-1 bg-primary hover:bg-primary/80 text-primary-foreground"
        >
          {busy ? "Saving…" : "Save metadata"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AddSourceForm() {
  const addSource = useSourceStore((s) => s.addSource);
  const addSourceFromFile = useSourceStore((s) => s.addSourceFromFile);
  const [formOpen, setFormOpen] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [year, setYear] = useState("");
  const [language, setLanguage] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [importReport, setImportReport] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const submit = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setDuplicate(false);
    try {
      const result = await addSource({
        title: title || "Pasted source",
        ...(author ? { author } : {}),
        ...(year ? { year } : {}),
        ...(language ? { language } : {}),
        text,
      });
      if (result.duplicate) {
        setDuplicate(true);
      } else {
        setText("");
        setTitle("");
        setAuthor("");
        setYear("");
        setLanguage("");
        setFormOpen(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!isSupportedUpload(file.name)) continue;
      await addSourceFromFile(file, { ...(title ? { title } : {}) });
    }
  };

  // ── Bibliography interchange (5.4, B18): BibTeX, RIS, and CSL JSON ──
  const importBibliography = async () => {
    const selection = await open({
      multiple: false,
      filters: [{ name: "Bibliography", extensions: ["bib", "ris", "json"] }],
    });
    if (!selection || typeof selection !== "string") return;
    const raw = await readTextFile(selection);
    const lower = selection.toLowerCase();
    const entries = lower.endsWith(".ris")
      ? parseRIS(raw)
      : lower.endsWith(".json")
        ? parseCslJson(raw)
        : parseBibTeX(raw);
    if (entries.length === 0) {
      setImportReport(
        "No importable records found in that file — nothing was added.",
      );
      return;
    }
    let imported = 0;
    let duplicates = 0;
    let merged = 0;
    for (const entry of entries) {
      const result = await addSource(entry);
      if (result.duplicate) {
        duplicates++;
        if (result.merged) merged++;
      } else {
        imported++;
      }
    }
    // Duplicate/merge decisions are REPORTED, never silent. Duplicates keep
    // the existing source; missing metadata they carried was merged into it.
    setImportReport(
      `Imported ${imported} source${imported === 1 ? "" : "s"}` +
        (duplicates > 0
          ? `; ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped` +
            (merged > 0 ? ` (${merged} merged missing metadata)` : "") +
            "."
          : "."),
    );
  };

  /** Export every source in one of the advertised interchange formats. */
  const exportBibliography = async (
    format: "bibtex" | "ris" | "csl-json",
  ) => {
    const sources = useSourceStore.getState().sources;
    if (sources.length === 0) return;
    const spec =
      format === "ris"
        ? { ext: "ris", label: "RIS", serialize: serializeRIS }
        : format === "csl-json"
          ? { ext: "json", label: "CSL JSON", serialize: serializeCslJson }
          : { ext: "bib", label: "BibTeX", serialize: serializeBibTeX };
    const path = await save({
      defaultPath: `bibliography.${spec.ext}`,
      filters: [{ name: spec.label, extensions: [spec.ext] }],
    });
    if (!path) return;
    await writeTextFile(path, spec.serialize(sources));
  };

  if (!formOpen) {
    return (
      <div className="border-t border-border p-3 space-y-1 shrink-0">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setFormOpen(true)} className="flex-1">
            <Plus className="size-3.5 mr-1" />
            Add source
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileInput.current?.click()}
            aria-label="Upload source file"
            title="Upload source file"
          >
            <Upload className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void importBibliography()}
            aria-label="Import bibliography"
            title="Import BibTeX, RIS, or CSL JSON"
          >
            <FileDown className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void exportBibliography("bibtex")}
            aria-label="Export bibliography as BibTeX"
            title="Export bibliography as BibTeX"
          >
            <BookUp className="size-3.5" />
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={UPLOAD_ACCEPT}
            className="hidden"
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {importReport && (
          <p role="status" className="text-[11px] text-text-secondary">
            {importReport}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-border p-3 space-y-2 shrink-0">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-text-secondary">New source</Label>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setFormOpen(false)}
          aria-label="Cancel adding a source"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title…"
        className="h-8 bg-field"
        aria-label="Source title"
      />
      <div className="flex gap-2">
        <Input
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="Author…"
          className="h-8 bg-field flex-1"
          aria-label="Source author"
        />
        <Input
          value={year}
          onChange={(e) => setYear(e.target.value)}
          placeholder="Year…"
          className="h-8 bg-field w-20"
          aria-label="Source year"
        />
      </div>
      <Input
        value={language}
        onChange={(e) => setLanguage(e.target.value)}
        placeholder="Original language (optional)…"
        className="h-8 bg-field"
        aria-label="Source language"
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste the source text (or quotations) here…"
        rows={4}
        className="w-full rounded-md border border-border bg-field px-3 py-2 text-xs [font-family:var(--font-doc)] resize-y"
        aria-label="Source text"
      />
      {duplicate && (
        <p role="status" className="text-[11px] text-text-secondary">
          This exact content is already in your sources — nothing added.
        </p>
      )}
      <div className="pt-2 border-t border-border space-y-1">
        <p className="text-[11px] text-text-muted">Export all sources</p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => void exportBibliography("bibtex")}
          >
            BibTeX
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => void exportBibliography("ris")}
          >
            RIS
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => void exportBibliography("csl-json")}
          >
            CSL JSON
          </Button>
        </div>
      </div>
      <Button
        size="sm"
        className="w-full bg-primary hover:bg-primary/80 text-primary-foreground"
        onClick={() => void submit()}
        disabled={busy || !text.trim()}
      >
        {busy ? "Adding…" : "Add source"}
      </Button>
    </div>
  );
}
