import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useLibraryStore } from "@/stores/libraryStore";
import { useDraftStore } from "@/stores/draftStore";
import { repo } from "@/utils/repository";
import { datasetGeneration } from "@/utils/datasetGeneration";
import {
  markdownDocument,
  richDocument,
  type ConversionReport,
  type DocumentBody,
} from "@/utils/documentCodec";
import type { TextTypeId } from "@/types";

// ──────────────────────────────────────────────
// Document session (Phase 4.2)
// ──────────────────────────────────────────────
// One session owns the edit lifecycle of ONE document:
//
// - The ProseMirror editor holds the manuscript while editing; typing
//   stays LOCAL to the editor (no global-store churn per keystroke).
// - Every document transaction marks the session dirty IMMEDIATELY and
//   retains the latest ProseMirror document independently of the debounced
//   draft/outline projection. A synchronous capture flushes that document
//   into the recovery draft before navigation and before persistence
//   drains, so a change made 100 ms before leaving is never lost.
// - Explicit Save commits a DocumentBody (the 4.1 contract) through
//   libraryStore → repository and waits for the acknowledgment.
// - Explicit discard is distinguished from ordinary navigation: cleanup
//   must never resurrect text the user threw away.
// - A markdown document converts once, on open, in the editor; the
//   conversion is reported, and the original markdown stays in version
//   history (the save transaction snapshots the replaced bytes).

export interface SessionMeta {
  title: string;
  textType: TextTypeId;
  folder: string;
  projectId: string;
}

export type SessionSaveState = "saved" | "unsaved" | "saving" | "failed";

export interface DocumentSession {
  /** null while the document is loading; editing waits for it. */
  initialBody: DocumentBody | null;
  loadError: string | null;
  retryLoad: () => void;
  /** The conversion report when an existing markdown document was converted. */
  conversion: ConversionReport | null;
  /** Metadata as typed (draft wins over the stored document). */
  meta: SessionMeta;
  setMeta: (patch: Partial<SessionMeta>) => void;
  saveState: SessionSaveState;
  /** Explicit Save: commits the CURRENT editor body and waits for the ack.
   * Returns the saved (possibly new) id, or null on failure. */
  save: (getBody: () => DocumentBody) => Promise<string | null>;
  /** Called IMMEDIATELY on every editor transaction (cheap ref update). */
  markEdited: (doc: ProseMirrorNode) => void;
  /** Called by the editor's debounced update handler. */
  recordEdit: (body: DocumentBody) => void;
  /** Explicitly throw the draft away; cleanup must not resurrect it. */
  discard: () => void;
  /** The draft key (status display / tests). */
  draftKey: string;
  /** The current monotonic edit version of THIS session (B04). AI
   * proposals capture it before awaiting so they stay bound to the exact
   * editor state they were requested from. */
  getEditVersion: () => number;
}

/**
 * Every mounted editor's synchronous capture. Persistence drains (close,
 * relaunch) call this BEFORE flushing recovery drafts, so the latest
 * document — not the last debounced projection — is what gets persisted.
 */
const pendingEditorCaptures = new Set<() => void>();

/** Flush every mounted editor's latest document into its recovery draft. */
export function capturePendingEditorChanges(): void {
  for (const capture of [...pendingEditorCaptures]) capture();
}

const TEXT_TYPE_IDS: TextTypeId[] = [
  "essay",
  "article",
  "research-paper",
  "letter",
  "talk",
  "other",
];

/** Detect markdown constructs the rich editor cannot represent exactly. */
function conversionWarnings(markdown: string): string[] {
  const warnings: string[] = [];
  if (/\[\^[^\]]+\]/.test(markdown)) {
    warnings.push("Footnote references become ordinary text in the rich editor.");
  }
  if (/^:\s+\S/m.test(markdown)) {
    warnings.push("Definition lists become ordinary paragraphs.");
  }
  if (/<!--/.test(markdown)) {
    warnings.push("HTML comments are removed from the rich text.");
  }
  return warnings;
}

/** Interpret a recovered draft as a document body (format-tagged meta). */
function draftToBody(draft: {
  content: string;
  meta: Record<string, unknown> | null;
  errorOnly?: boolean;
}): DocumentBody | null {
  // F03: a record that only carries a save error claims no body. Recovering
  // it as an empty markdown document would silently replace the stored
  // manuscript; the stored body must win instead.
  if (draft.errorOnly) return null;
  const format = draft.meta?.contentFormat;
  if (format === "tiptap-json") {
    // A metadata-only draft (title/type typed before any body write) has
    // no recorded body: it must not replace the document with an empty one.
    if (draft.content === "") return null;
    return {
      contentFormat: "tiptap-json",
      contentSchemaVersion: 1,
      content: draft.content,
      plainText: (draft.meta?.plainText as string) ?? "",
    };
  }
  if (draft.content === "") {
    // Legacy metadata-only drafts (meta without a body tag) claim no body.
    // A plain empty draft (brief / legacy markdown body) is an intentional
    // empty and stays recoverable as such.
    if (draft.meta != null && format === undefined) return null;
    return markdownDocument("");
  }
  if (draft.content != null) {
    return markdownDocument(draft.content);
  }
  return null;
}

export function useDocumentSession(options: {
  id: string | null;
  projectId?: string;
  /**
   * Unique identity for an UNSAVED document. Every new-document session
   * gets its own key, so two unsaved documents can never share a draft.
   * (`id` identifies saved documents.)
   */
  sessionId?: string;
  initial?: { title?: string; content?: string };
}): DocumentSession {
  const { id, projectId, initial, sessionId } = options;
  // Fallback for callers without an explicit session id (tests): unique
  // per mount, never shared between documents.
  const ephemeralSessionId = useRef(crypto.randomUUID()).current;
  const draftKey = id
    ? `text:${id}`
    : `text:new:${sessionId ?? ephemeralSessionId}`;

  const draft = useDraftStore((s) => s.drafts[draftKey] ?? null);
  const setDraft = useDraftStore((s) => s.setDraft);
  const markError = useDraftStore((s) => s.markError);
  const clearDraft = useDraftStore((s) => s.clearDraft);
  const texts = useLibraryStore((s) => s.texts);

  const [initialBody, setInitialBody] = useState<DocumentBody | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [conversion, setConversion] = useState<ConversionReport | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The latest editor document and dirtiness live in refs: marking dirty
  // on every transaction must not re-render the editor.
  const latestDocRef = useRef<ProseMirrorNode | null>(null);
  const dirtyRef = useRef(false);
  const discardedRef = useRef(false);
  /** Monotonic edit counter: a save acknowledges exactly the version it
   * submitted; newer edits stay dirty and recoverable. */
  const editVersionRef = useRef(0);
  const [dirty, setDirty] = useState(false);

  const existing = id ? (texts.find((t) => t.id === id) ?? null) : null;

  // Metadata projection: draft-typed metadata wins over the stored
  // document; recomputed only when identity or sources change.
  const projectMeta = useCallback((): SessionMeta => {
    const dMeta = (draft?.meta ?? {}) as Record<string, unknown>;
    return {
      title: (dMeta.title as string) ?? existing?.title ?? initial?.title ?? "",
      textType: TEXT_TYPE_IDS.includes(dMeta.textType as TextTypeId)
        ? (dMeta.textType as TextTypeId)
        : ((existing?.textType ?? "other") as TextTypeId),
      folder: (dMeta.folder as string) ?? existing?.folder ?? "",
      projectId:
        (dMeta.projectId as string) ?? existing?.projectId ?? projectId ?? "",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, existing, initial, projectId]);

  const [metaState, setMetaState] = useState<SessionMeta>(projectMeta);
  useEffect(() => {
    // Re-project when switching documents (id change), not per keystroke.
    setMetaState(projectMeta());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, loadNonce]);

  const metaRef = useRef(metaState);
  metaRef.current = metaState;

  const setMeta = useCallback(
    (patch: Partial<SessionMeta>) => {
      // Metadata typing is an edit too: it must be acknowledged by the
      // save that actually includes it.
      editVersionRef.current += 1;
      setMetaState((prev) => {
        const next = { ...prev, ...patch };
        // Metadata typing is recorded like content typing (draft layer).
        setDraft(draftKey, "text", id, {
          meta: {
            ...next,
            contentFormat: "tiptap-json",
          },
        });
        return next;
      });
    },
    [draftKey, id, setDraft],
  );

  // Load: the recovered draft always wins over the stored body; a delayed
  // load can never overwrite typed content (R6 semantics, body-typed).
  // New documents recover their body from their OWN session draft too.
  useEffect(() => {
    setLoadError(null);
    setConversion(null);
    const recovered = draft ? draftToBody(draft) : null;
    if (recovered) {
      setInitialBody(recovered);
      return;
    }
    if (!id) {
      setInitialBody(markdownDocument(initial?.content ?? ""));
      return;
    }
    let cancelled = false;
    setInitialBody(null);
    // A read that started before a dataset replacement must not populate
    // the restored editor (the pane remounts on the generation bump).
    const generation = datasetGeneration();
    void useLibraryStore
      .getState()
      .loadTextContent(id)
      .then((body) => {
        if (cancelled) return;
        if (generation !== datasetGeneration()) return;
        if (body.contentFormat === "markdown" && body.content) {
          // First open of a markdown document in the rich editor: the
          // conversion happens in the editor; report what we know is lost.
          const warnings = conversionWarnings(body.content);
          setConversion({
            from: "markdown",
            to: "tiptap-json",
            at: new Date().toISOString(),
            warnings,
            lossless: warnings.length === 0,
          });
        }
        setInitialBody(body);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(
            `The document could not be loaded: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
    // Reload when the identity or an explicit retry changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, loadNonce]);

  /** Mark the session dirty immediately; retain the latest document. */
  const markEdited = useCallback((doc: ProseMirrorNode) => {
    if (discardedRef.current) return;
    latestDocRef.current = doc;
    editVersionRef.current += 1;
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      setDirty(true);
    }
  }, []);

  /** Synchronous capture: project the retained document into the draft. */
  const projectLatest = useCallback(() => {
    if (discardedRef.current || !dirtyRef.current) return;
    const doc = latestDocRef.current;
    if (doc == null) return;
    const body = richDocument(doc.toJSON());
    dirtyRef.current = false;
    setDirty(false);
    setDraft(draftKey, "text", id, {
      content: body.content,
      meta: {
        ...metaRef.current,
        contentFormat: "tiptap-json",
        plainText: body.plainText,
      },
    });
  }, [draftKey, id, setDraft]);

  // Navigation AND drains: register the synchronous capture, flush on
  // unmount (never cancel the only pending recovery projection).
  useEffect(() => {
    const capture = () => projectLatest();
    pendingEditorCaptures.add(capture);
    return () => {
      capture();
      pendingEditorCaptures.delete(capture);
    };
  }, [projectLatest]);

  /** The editor's debounced update: project the draft, nothing heavier. */
  const recordEdit = useCallback(
    (body: DocumentBody) => {
      if (discardedRef.current) return;
      latestDocRef.current = null; // the body already carries this revision
      dirtyRef.current = false;
      setDirty(false);
      setDraft(draftKey, "text", id, {
        content: body.content,
        meta: {
          ...metaRef.current,
          contentFormat: "tiptap-json",
          plainText: body.plainText,
        },
      });
    },
    [draftKey, id, setDraft],
  );

  const discard = useCallback(() => {
    // Explicit discard: cleanup must never resurrect this text. The
    // optimistic library cache (written before the failed save) is
    // dropped too, so remounting reads the persisted body again.
    discardedRef.current = true;
    dirtyRef.current = false;
    latestDocRef.current = null;
    setDirty(false);
    clearDraft(draftKey);
    if (id) useLibraryStore.getState().invalidateTextContent(id);
  }, [clearDraft, draftKey, id]);

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setLoadNonce((n) => n + 1);
  }, []);

  /** Stable provider for the session's edit counter (registration). */
  const getEditVersion = useCallback(() => editVersionRef.current, []);

  const save = useCallback(
    async (getBody: () => DocumentBody): Promise<string | null> => {
      if (saving) return null;
      // The version this Save submits; everything after it is "newer".
      const attemptedVersion = editVersionRef.current;
      let body: DocumentBody | null = null;
      setSaving(true);
      try {
        body = getBody();
        let savedId: string;
        if (id) {
          await useLibraryStore.getState().updateText(id, {
            title: metaState.title.trim() || "Untitled document",
            textType: metaState.textType,
            folder: metaState.folder.trim(),
            projectId: metaState.projectId,
            content: body,
          });
          savedId = id;
        } else {
          savedId = await useLibraryStore.getState().createText({
            title: metaState.title.trim() || "Untitled document",
            textType: metaState.textType,
            folder: metaState.folder.trim() || undefined,
            projectId: metaState.projectId || undefined,
            content: body,
          });
        }
        // Explicit Save waits for the persistence ACKNOWLEDGMENT.
        await repo.flushTextSaves();
        await repo.idle();
        // Acknowledge ONLY the submitted version: edits typed while the
        // save was in flight stay dirty and recoverable.
        const acknowledged = editVersionRef.current === attemptedVersion;
        if (acknowledged) {
          dirtyRef.current = false;
          latestDocRef.current = null;
          setDirty(false);
          clearDraft(draftKey);
          if (savedId !== id) {
            clearDraft(`text:${savedId}`);
          }
        } else {
          dirtyRef.current = true;
          setDirty(true);
        }
        setSaving(false);
        setSavedFlash(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSavedFlash(false), 1500);
        return savedId;
      } catch (err) {
        setSaving(false);
        const message = `Save failed: ${
          err instanceof Error ? err.message : String(err)
        }`;
        if (editVersionRef.current === attemptedVersion && body) {
          // Record the EXACT attempted manuscript: a remount recovers it
          // with the error instead of an empty replacement.
          markError(draftKey, message, {
            content: body.content,
            meta: {
              ...metaRef.current,
              contentFormat: "tiptap-json",
              plainText: body.plainText,
            },
          });
        } else {
          // Newer edits exist: keep them; only the error is added.
          markError(draftKey, message);
        }
        return null;
      }
    },
    [saving, id, metaState, clearDraft, draftKey, markError],
  );

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  const saveState: SessionSaveState = useMemo(() => {
    if (saving) return "saving";
    if (draft?.error) return "failed";
    // Unacknowledged edits (even before the debounced projection lands)
    // and any retained draft outrank a temporary "Saved" flash.
    if (dirty || draft) return "unsaved";
    if (savedFlash) return "saved";
    return "saved";
  }, [saving, draft, dirty, savedFlash]);

  return {
    initialBody,
    loadError,
    retryLoad,
    conversion,
    meta: metaState,
    setMeta,
    saveState,
    save,
    markEdited,
    recordEdit,
    discard,
    draftKey,
    getEditVersion,
  };
}
