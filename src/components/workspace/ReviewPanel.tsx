import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DocumentProposal } from "@/types";
import { repo } from "@/utils/repository";
import { useAppStore } from "@/stores/useAppStore";
import {
  acceptProposal,
  rejectProposal,
  markStaleIfMoved,
  getActiveEditorDocumentId,
  subscribeActiveEditor,
  subscribeProposalChanges,
} from "@/services/revisionService";
import { Button } from "@/components/ui/button";
import {
  Check,
  Pencil,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";

// ──────────────────────────────────────────────
// ReviewPanel (Phase 5.3, ownership-checked in B11)
// ──────────────────────────────────────────────
// Before/after review of AI proposals for the open document. Acceptance
// requires the proposal's OWN document to be open in the editor —
// revision-checked, exact-located, and undoable (one ProseMirror
// transaction). In a read view (or another document's editor) a pending
// replacement offers "Open in editor" instead of an invalid Accept.
// Asynchronous loads are guarded by document/request identity, and every
// load/accept/reject failure is visible.

export default function ReviewPanel({ documentId }: { documentId: string | null }) {
  const [proposals, setProposals] = useState<DocumentProposal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Monotonic load identity: a stale response can never replace a newer
   * document's rows. */
  const requestSeq = useRef(0);
  const activeEditorDocumentId = useSyncExternalStore(
    subscribeActiveEditor,
    getActiveEditorDocumentId,
  );
  const canApply =
    documentId != null && activeEditorDocumentId === documentId;
  const openDocument = useAppStore((s) => s.openDocument);

  const refresh = useCallback(async () => {
    const target = documentId;
    const seq = ++requestSeq.current;
    if (!target) {
      setProposals([]);
      setLoaded(false);
      setLoadError(null);
      return;
    }
    setLoadError(null);
    try {
      const rows = await repo.proposalsList(target);
      // A manuscript changed underneath pending proposals → stale.
      const currentRev = repo.peekRev("text", target);
      await markStaleIfMoved(rows, currentRev);
      const fresh = await repo.proposalsList(target);
      if (seq !== requestSeq.current) return; // superseded load
      setProposals(fresh);
      setLoaded(true);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(
        `The proposals could not be loaded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      setLoaded(true);
    }
  }, [documentId]);

  useEffect(() => {
    // A document switch shows nothing until its own rows land.
    setProposals([]);
    setLoaded(false);
    void refresh();
  }, [refresh]);

  // A completed request (or any status change) refreshes the panel.
  useEffect(() => {
    return subscribeProposalChanges(() => {
      void refresh();
    });
  }, [refresh]);

  if (!documentId) {
    return (
      <p className="text-xs text-text-muted p-4 max-w-[34ch]">
        Open a document in the editor, select a passage, and use Revise —
        proposals appear here for before/after review.
      </p>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 text-sm" data-testid="review-panel">
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
        {loadError ? (
          <div role="alert" className="text-xs text-text-secondary flex items-start gap-2">
            <TriangleAlert className="size-3.5 shrink-0 text-warning mt-0.5" />
            <span className="flex-1">{loadError}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        ) : !loaded ? (
          <p className="text-xs text-text-muted">Loading…</p>
        ) : proposals.length === 0 ? (
          <p className="text-xs text-text-muted max-w-[34ch]">
            No proposals yet. Select a passage in the editor and choose
            Revise, Tighten, Clarify, or Comment.
          </p>
        ) : (
          proposals.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              canApply={canApply}
              onChanged={() => void refresh()}
              onOpenEditor={() => openDocument({ id: documentId })}
            />
          ))
        )}
      </div>
    </div>
  );
}

function messageForFailure(reason: string): string {
  switch (reason) {
    case "stale-revision":
      return "The document changed since this proposal — it is now stale.";
    case "ambiguous":
      return "The passage no longer matches exactly in only one place.";
    case "unverified-revision":
      return "The document's revision could not be verified. Reopen the document and try again.";
    case "not-owner":
      return "This proposal belongs to a different document. Open it in the editor first.";
    case "unsupported-selection":
      return "The original selection contains citations, footnotes, or structure that cannot be replaced with plain text.";
    case "no-change":
      return "The proposal does not change the text; nothing was applied.";
    case "already-decided":
      return "This proposal was already applied or decided.";
    case "apply-failed":
      return "The editor refused the change; nothing was applied.";
    default:
      return "The original passage is no longer in the document.";
  }
}

function ProposalCard({
  proposal,
  canApply,
  onChanged,
  onOpenEditor,
}: {
  proposal: DocumentProposal;
  canApply: boolean;
  onChanged: () => void;
  onOpenEditor: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const isComment = proposal.requestKind === "comment";
  const pending = proposal.status === "pending";
  const stale = proposal.status === "stale";

  const handleAccept = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      const result = await acceptProposal(proposal);
      if (!result.ok) {
        setFailure(messageForFailure(result.reason));
      } else if (result.warning) {
        // The edit IS applied; only the status write failed.
        setNote(result.warning);
      }
      onChanged();
    } catch (err) {
      setFailure(
        `Could not apply the proposal: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await rejectProposal(proposal);
      onChanged();
    } catch (err) {
      setFailure(
        `Could not reject the proposal: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs ${
        proposal.status === "accepted"
          ? "border-primary/40"
          : stale || proposal.status === "rejected"
            ? "border-border opacity-60"
            : "border-border"
      }`}
      data-status={proposal.status}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-text-primary capitalize">
          {proposal.requestKind}
        </span>
        <span className="text-text-muted">
          {new Date(proposal.createdAt).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        <span
          className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full ${
            proposal.status === "accepted"
              ? "bg-primary/10 text-text-primary"
              : proposal.status === "pending"
                ? "bg-warning/10 text-text-primary"
                : "bg-surface-alt text-text-muted"
          }`}
        >
          {proposal.status}
        </span>
      </div>

      {isComment ? (
        <p className="mt-1.5 whitespace-pre-wrap text-text-secondary [font-family:var(--font-doc)]">
          {proposal.contextNote}
        </p>
      ) : (
        <div className="mt-1.5 space-y-1">
          <p className="rounded bg-surface-alt px-2 py-1 text-text-secondary line-through decoration-text-muted/60 whitespace-pre-wrap">
            {proposal.baseFragment}
          </p>
          <p className="rounded bg-selection px-2 py-1 text-text-primary whitespace-pre-wrap [font-family:var(--font-doc)]">
            {proposal.proposedFragment}
          </p>
        </div>
      )}

      {failure && (
        <p role="alert" className="mt-1 text-[11px] text-warning flex items-center gap-1">
          <X className="size-3" /> {failure}
        </p>
      )}
      {note && (
        <p role="status" className="mt-1 text-[11px] text-text-muted flex items-center gap-1">
          <TriangleAlert className="size-3" /> {note}
        </p>
      )}

      {pending && (
        <div className="mt-2 flex items-center gap-2">
          {!isComment &&
            (canApply ? (
              <Button
                size="sm"
                className="bg-primary hover:bg-primary/80 text-primary-foreground"
                onClick={() => void handleAccept()}
                disabled={busy}
              >
                <Check className="size-3.5 mr-1" />
                Accept
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={onOpenEditor}
                disabled={busy}
                title="Open this document in the editor to apply the proposal"
              >
                <Pencil className="size-3.5 mr-1" />
                Open in editor
              </Button>
            ))}
          <Button variant="outline" size="sm" onClick={() => void handleReject()} disabled={busy}>
            Reject
          </Button>
        </div>
      )}
      {stale && (
        <p className="mt-1.5 text-[11px] text-text-muted flex items-center gap-1">
          <RotateCcw className="size-3" />
          The document moved since this proposal. Regenerate it from the
          current text.
        </p>
      )}
    </div>
  );
}
