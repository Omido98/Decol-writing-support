import type { Editor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { sendMessage } from "@/utils/api";
import { findMatches } from "@/utils/documentFind";
import { useChatStore } from "@/stores/chatStore";
import { repo } from "@/utils/repository";
import {
  abortOperation,
  isStaleOperation,
  listOperations,
  settleOperation,
  startOperation,
} from "@/services/aiOperations";
import type { ChatMessage } from "@/stores/chatStore";
import type { DocumentProposal, ProposalKind } from "@/types";

// ──────────────────────────────────────────────
// Reviewable revisions (Phase 5.3, session-bound in B11)
// ──────────────────────────────────────────────
// Selection → Revise/Tighten/Clarify/Comment → a PERSISTED proposal
// (document id + base revision + the ORIGINAL fragment) → the Review
// panel shows before/after with Accept/Reject. Nothing is applied
// automatically. Acceptance validates the base revision and locates the
// fragment EXACTLY (verified range, then a unique exact match — never
// unrestricted replacement); an unlocatable fragment is STALE.
//
// The active editor is registered WITH its document id, session
// generation, and edit-version provider. A proposal can only be created
// from — and accepted into — an editor that is showing exactly its
// document; a delayed result from document A can never touch B, even when
// both contain identical words. Unknown revision state is UNVERIFIED:
// proposals are neither created nor accepted against it.

/** The live editor of the open document, tagged with its identity. */
export interface EditorRegistration {
  documentId: string;
  editor: Editor;
  /** Distinguishes editor remounts of the same document. */
  sessionGeneration: number;
  /** The session's monotonic edit counter (B04). */
  editVersion: () => number;
}

let activeRegistration: EditorRegistration | null = null;
let sessionGenerationSeq = 0;

const activeListeners = new Set<() => void>();
const proposalListeners = new Set<() => void>();

function notifyActiveListeners(): void {
  for (const listener of activeListeners) listener();
}

function notifyProposalListeners(): void {
  for (const listener of proposalListeners) listener();
}

/** Register the editor of the currently open document (or null when no
 * editor is mounted). the document id is what makes ownership checkable. */
export function setActiveEditor(
  registration: Omit<EditorRegistration, "sessionGeneration"> | null,
): void {
  if (registration == null) {
    activeRegistration = null;
  } else {
    activeRegistration = {
      ...registration,
      sessionGeneration: ++sessionGenerationSeq,
    };
  }
  notifyActiveListeners();
}

/**
 * Clear the registration for a DESTROYED editor. Identity-guarded: an
 * editor's destroy can arrive after the next editor has already
 * registered (React unmount/mount ordering is not synchronous), and a
 * late clear must never disarm the new document's proposals.
 */
export function clearActiveEditor(editor: Editor | null): void {
  if (activeRegistration == null || editor == null) return;
  if (activeRegistration.editor !== editor) return;
  activeRegistration = null;
  notifyActiveListeners();
}

/** The document the active editor is showing, or null. */
export function getActiveEditorDocumentId(): string | null {
  if (!activeRegistration || activeRegistration.editor.isDestroyed) {
    return null;
  }
  return activeRegistration.documentId;
}

/** Subscribe to editor registration changes (Review panel ownership). */
export function subscribeActiveEditor(listener: () => void): () => void {
  activeListeners.add(listener);
  return () => activeListeners.delete(listener);
}

/** Subscribe to proposal lifecycle changes (created/accepted/rejected/
 * stale) so the Review panel refreshes when a request completes. */
export function subscribeProposalChanges(listener: () => void): () => void {
  proposalListeners.add(listener);
  return () => proposalListeners.delete(listener);
}

function requireRegistrationFor(documentId: string): EditorRegistration {
  const registration = activeRegistration;
  if (!registration || registration.editor.isDestroyed) {
    throw new Error("No document is open in the editor.");
  }
  if (registration.documentId !== documentId) {
    throw new Error(
      "The editor is showing a different document; open this one before working on it.",
    );
  }
  return registration;
}

/**
 * The structured identity of a requested selection: the owning document,
 * the revision it was made against, the exact range and text, and the
 * editing session's version at request time. Persisted parts are
 * (documentId, baseRev, selFrom, selTo, baseFragment); the session parts
 * bind the in-flight request to the editor it came from.
 */
export interface SelectionFingerprint {
  documentId: string;
  baseRev: number;
  selFrom: number;
  selTo: number;
  /** The exact selected text — verified, never fuzzy-matched. */
  fragment: string;
  editVersion: number;
  sessionGeneration: number;
}

export function fingerprintSelection(
  registration: EditorRegistration,
  range: { from: number; to: number },
  fragment: string,
  baseRev: number,
): SelectionFingerprint {
  return {
    documentId: registration.documentId,
    baseRev,
    selFrom: range.from,
    selTo: range.to,
    fragment,
    editVersion: registration.editVersion(),
    sessionGeneration: registration.sessionGeneration,
  };
}

// ──────────────────────────────────────────────
// Replacement contract (B12)
// ──────────────────────────────────────────────
// The model's reply is LITERAL plain text (per the instruction above); it
// is never parsed as HTML or Markdown. A single line replaces the range
// as a literal text run (marks inherited from the insertion point); each
// additional line becomes its own paragraph, so the applied text equals
// the review preview exactly — including `<tag>`-looking text, entities,
// quotes, Unicode, and newlines.

export function literalReplacement(value: string): JSONContent | JSONContent[] {
  const normalized = value.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length === 1) {
    return { type: "text", text: normalized };
  }
  return lines.map((line) =>
    line.length > 0
      ? {
          type: "paragraph",
          content: [{ type: "text", text: line }],
        }
      : { type: "paragraph" },
  );
}

/**
 * Why a selected range cannot be replaced with plain text, or null when
 * it can. Supported: a range inside ONE text block whose content is text
 * and inline marks only. Protected atoms (citations, footnotes), leaves,
 * and structures spanning blocks would be restructured or destroyed by a
 * plain-text replacement, so v1 refuses them with an explanation.
 */
export function selectionProblem(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): string | null {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if (!$from.parent.isTextblock) {
    return "The selection does not start inside a paragraph or heading.";
  }
  if ($from.parent !== $to.parent) {
    return "The selection spans multiple blocks; select text within a single paragraph.";
  }
  let atom: string | null = null;
  doc.nodesBetween(from, to, (node) => {
    if (node.isAtom && !node.isText && node.type.name !== "hardBreak") {
      atom = node.type.name;
      return false;
    }
  });
  if (atom) {
    const label =
      atom === "citation" ? "a citation" : atom === "footnoteRef" ? "a footnote" : `a ${atom}`;
    return `The selection contains ${label} that cannot be replaced with plain-text revision. Select a plain-text passage instead.`;
  }
  return null;
}

const KIND_INSTRUCTIONS: Record<ProposalKind, string> = {
  revise: "Revise the passage for clarity and flow while keeping the author's voice and meaning. Keep the same language.",
  tighten: "Tighten the passage: remove filler and repetition. Do not change meaning, claims, or voice.",
  clarify: "Clarify the passage where it is ambiguous. Do not add new claims; keep the author's voice.",
  comment: "Comment on the passage: what works, what is unclear, what a skeptical reader might ask. Reply with your comment only.",
};

export const REVISION_SYSTEM_PROMPT =
  "You are a careful, skeptical writing partner working decolonially. You never invent citation details and never overwrite terminology.";

/** The EXACT instruction a proposal request sends (single source of
 * truth, shared with the evaluation harness). */
export function buildRevisionInstruction(
  kind: ProposalKind,
  fragment: string,
): string {
  return `${KIND_INSTRUCTIONS[kind]}

Passage (verbatim):

"""${fragment}"""
${
  kind === "comment"
    ? "\nReply with the comment only."
    : "\nReply with the replacement passage only — no preamble, no explanation. Preserve any citations, quotations, names, terminology, and numbers exactly."
}`;
}

export async function requestProposal(options: {
  documentId: string;
  kind: ProposalKind;
  contextNote?: string;
}): Promise<
  { id: string; operationId: string } | { cancelled: true; operationId: string }
> {
  // The request must come from the editor that is showing THIS document.
  const registration = requireRegistrationFor(options.documentId);
  const editor = registration.editor;
  const { from, to, empty } = editor.state.selection;
  if (empty) throw new Error("Select the passage to work on first.");
  const fragment = editor.state.doc.textBetween(from, to, "\n", " ");
  if (!fragment.trim()) throw new Error("The selection is empty.");
  // Only a plain-text range inside one block can be replaced literally.
  const unsupported = selectionProblem(editor.state.doc, from, to);
  if (unsupported) throw new Error(unsupported);

  // Capture the base revision, range, and session version BEFORE awaiting
  // the AI: a Save during generation must not move the proposal's base.
  const baseRev = repo.peekRev("text", options.documentId);
  if (baseRev == null) {
    throw new Error(
      "This document's revision is not known yet; open it from the library and try again.",
    );
  }
  const fingerprint = fingerprintSelection(
    registration,
    { from, to },
    fragment,
    baseRev,
  );

  const config = useChatStore.getState().config;
  const systemPrompt = REVISION_SYSTEM_PROMPT;
  const instruction = buildRevisionInstruction(options.kind, fragment);

  // The request lives in the OPERATION SERVICE (5.5b): abortable (the
  // toolbar's Cancel), invalidated by restores, lifetime independent of
  // the component.
  const operation = startOperation({
    type: "proposal",
    threadId: "",
    documentId: options.documentId,
    config: { ...config, webSearchEnabled: false },
    systemPrompt,
    history: [
      {
        role: "user",
        content: instruction,
        timestamp: new Date().toISOString(),
      } as ChatMessage,
    ],
  });

  try {
    const result = await sendMessage(
      operation.history,
      operation.config,
      operation.systemPrompt,
      { signal: operation.controller.signal },
    );
    const proposed = result.content.trim();
    if (result.stopped) {
      settleOperation(operation.id, "stopped");
      return { cancelled: true, operationId: operation.id };
    }
    // B16b: a response that was cut off (interrupted/truncated) must never
    // become a replacement proposal — accepting it would silently delete
    // the rest of the selected passage. Refuse creation; the request can
    // be made again.
    if (result.outcome === "interrupted" || result.outcome === "truncated") {
      settleOperation(operation.id, "failed");
      throw new Error(
        "The response was cut off before it finished; no proposal was created. Try again.",
      );
    }
    if (!proposed || result.error) {
      settleOperation(operation.id, "failed");
      throw new Error(result.error ?? "The request produced nothing.");
    }
    if (isStaleOperation(operation)) {
      // A restore happened mid-request: the proposal must never appear
      // on the restored dataset.
      settleOperation(operation.id, "aborted");
      return { cancelled: true, operationId: operation.id };
    }
    // A comment is not a replacement: it is recorded as the note the user
    // reads in the Review panel (still a reviewable proposal row).
    const isComment = options.kind === "comment";

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const proposal: DocumentProposal = {
      id,
      documentId: fingerprint.documentId,
      baseRev: fingerprint.baseRev,
      requestKind: options.kind,
      baseFragment: isComment ? "" : fingerprint.fragment,
      proposedFragment: isComment ? "" : proposed,
      selFrom: fingerprint.selFrom,
      selTo: fingerprint.selTo,
      ...(options.contextNote || isComment
        ? { contextNote: options.contextNote ?? proposed }
        : {}),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    await repo.proposalCreate(proposal);
    settleOperation(operation.id, "completed");
    notifyProposalListeners();
    return { id, operationId: operation.id };
  } catch (err) {
    const aborted =
      (err as { name?: string })?.name === "AbortError" ||
      (err as { cancelled?: boolean })?.cancelled === true ||
      operation.controller.signal.aborted;
    settleOperation(operation.id, aborted ? "aborted" : "failed");
    if (aborted) {
      return { cancelled: true, operationId: operation.id };
    }
    throw err;
  }
}

/** Cancel the running proposal request for a document (the toolbar's
 * busy state turns into the Cancel affordance). True when one was
 * running. */
export function cancelProposalRequests(documentId: string): boolean {
  let found = false;
  for (const op of listOperations()) {
    if (!op.settled && op.type === "proposal" && op.documentId === documentId) {
      abortOperation(op.id);
      found = true;
    }
  }
  return found;
}

export type AcceptResult =
  | { ok: true; warning?: string }
  | {
      ok: false;
      reason:
        | "stale-revision"
        | "not-found"
        | "ambiguous"
        | "unverified-revision"
        | "not-owner"
        | "unsupported-selection"
        | "no-change"
        | "already-decided"
        | "apply-failed";
    };

/**
 * Proposals already applied in THIS session. Kept even when the accepted
 * status write fails, so a persisted row that still says "pending" cannot
 * be applied a second time by a retry click.
 */
const appliedProposalIds = new Set<string>();

/** Test seam: forget which proposals were applied (fixtures reuse ids). */
export function resetAppliedProposalsForTests(): void {
  appliedProposalIds.clear();
}

/**
 * Accept: require the OWNING document's editor, validate the base
 * revision (unknown = unverified, never automatically valid), locate the
 * fragment EXACTLY (verified selection range first, then a unique
 * whole-document match), apply ONE ProseMirror transaction of LITERAL
 * text (undoable like any edit), and persist the accepted status. A moved
 * manuscript makes the proposal STALE — nothing is applied.
 */
export async function acceptProposal(proposal: DocumentProposal): Promise<AcceptResult> {
  if (proposal.status !== "pending" || appliedProposalIds.has(proposal.id)) {
    return { ok: false, reason: "already-decided" };
  }
  const registration = activeRegistration;
  if (
    !registration ||
    registration.editor.isDestroyed ||
    registration.documentId !== proposal.documentId
  ) {
    return { ok: false, reason: "not-owner" };
  }

  const currentRev = repo.peekRev("text", proposal.documentId);
  if (currentRev == null) {
    return { ok: false, reason: "unverified-revision" };
  }
  if (currentRev !== proposal.baseRev) {
    await repo.proposalSetStatus(proposal.id, "stale");
    notifyProposalListeners();
    return { ok: false, reason: "stale-revision" };
  }

  const editor = registration.editor;
  const doc = editor.state.doc;
  const { baseFragment, proposedFragment } = proposal;

  // A replacement that repeats the source text would only strip its
  // formatting: nothing meaningful would change.
  if (baseFragment !== "" && proposedFragment === baseFragment) {
    return { ok: false, reason: "no-change" };
  }

  // 1) The recorded range, VERIFIED against the fragment. An invalid or
  //    out-of-range hint falls through to the exact-match search rather
  //    than being trusted or crashing.
  let range: { from: number; to: number } | null = null;
  if (proposal.selFrom != null && proposal.selTo != null) {
    const { selFrom, selTo } = proposal;
    const inBounds =
      Number.isInteger(selFrom) &&
      Number.isInteger(selTo) &&
      selFrom >= 0 &&
      selTo <= doc.content.size &&
      selFrom < selTo;
    if (inBounds) {
      const problem = selectionProblem(doc, selFrom, selTo);
      if (problem) {
        return { ok: false, reason: "unsupported-selection" };
      }
      const at = doc.textBetween(selFrom, selTo, "\n", " ");
      if (at === baseFragment) {
        range = { from: selFrom, to: selTo };
      }
    }
  }
  // 2) Exact matches across the document: only a UNIQUE one is safe.
  if (!range) {
    const matches = findMatches(doc, baseFragment, { caseSensitive: true });
    if (matches.length === 1) {
      range = matches[0];
    } else if (matches.length === 0) {
      return { ok: false, reason: "not-found" };
    } else {
      return { ok: false, reason: "ambiguous" };
    }
  }

  // Ownership cannot change across the synchronous checks above, but the
  // editor could have been replaced by a navigation paint: never write
  // into an editor that is no longer the owner's.
  if (
    activeRegistration !== registration ||
    registration.editor.isDestroyed ||
    registration.documentId !== proposal.documentId
  ) {
    return { ok: false, reason: "not-owner" };
  }

  const applied = editor
    .chain()
    .focus()
    .insertContentAt(
      { from: range.from, to: range.to },
      literalReplacement(proposedFragment),
      { errorOnInvalidContent: true },
    )
    .run();
  if (!applied) {
    return { ok: false, reason: "apply-failed" };
  }
  appliedProposalIds.add(proposal.id);

  try {
    await repo.proposalSetStatus(proposal.id, "accepted");
    notifyProposalListeners();
    return { ok: true };
  } catch (err) {
    // The manuscript change IS applied; only its accepted status could
    // not be persisted. The in-memory ledger blocks a second apply this
    // session; the warning tells the user the record is out of date.
    notifyProposalListeners();
    return {
      ok: true,
      warning: `The change was applied, but its accepted status could not be saved: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

export async function rejectProposal(proposal: DocumentProposal): Promise<void> {
  await repo.proposalSetStatus(proposal.id, "rejected");
  notifyProposalListeners();
}

/** Mark pending proposals stale after the manuscript changed underneath.
 * An unknown revision cannot verify anything, so nothing is marked (the
 * acceptance path refuses those as unverified). */
export async function markStaleIfMoved(
  proposals: DocumentProposal[],
  currentRev: number | null,
): Promise<number> {
  if (currentRev == null) return 0;
  let changed = 0;
  for (const p of proposals) {
    if (p.status === "pending" && p.baseRev !== currentRev) {
      await repo.proposalSetStatus(p.id, "stale");
      changed++;
    }
  }
  if (changed > 0) notifyProposalListeners();
  return changed;
}
