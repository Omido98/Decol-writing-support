// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

// The AI request is mocked: revisionService builds the proposal rows.
vi.mock("@/utils/api", () => ({
  sendMessage: vi.fn(),
}));

import { sendMessage } from "@/utils/api";
import { Citation } from "@/components/editor/citationExtension";
import {
  requestProposal,
  acceptProposal,
  rejectProposal,
  markStaleIfMoved,
  cancelProposalRequests,
} from "@/services/revisionService";
import { setActiveEditor } from "@/services/revisionService";
import { resetAppliedProposalsForTests } from "@/services/revisionService";
import { listOperations, resetOperations } from "@/services/aiOperations";
import { fakeRepository, resetFakeRepository } from "@/test/fakeRepository";
import type { DocumentProposal } from "@/types";

const sendMessageMock = sendMessage as unknown as ReturnType<typeof vi.fn>;

let editor: Editor | null = null;

function makeEditor(content: string): Editor {
  return new Editor({ extensions: [StarterKit], content });
}

/** Register an editor as the active one for a document (B11 contract). */
function registerEditor(ed: Editor, documentId = "doc1"): void {
  setActiveEditor({ documentId, editor: ed, editVersion: () => 0 });
}

beforeEach(() => {
  resetFakeRepository();
  resetOperations();
  resetAppliedProposalsForTests();
  sendMessageMock.mockReset();
  // Default: a KNOWN revision (0) matching the fixture proposals. A null
  // revision is "unverified" in B11 and covered explicitly below.
  fakeRepository.peekRev = () => 0;
});

afterEach(() => {
  editor?.destroy();
  editor = null;
  setActiveEditor(null);
});

function pendingProposal(over: Partial<DocumentProposal> = {}): DocumentProposal {
  return {
    id: "p1",
    documentId: "doc1",
    baseRev: 0,
    requestKind: "revise",
    baseFragment: "One two three.",
    proposedFragment: "REPLACED.",
    selFrom: undefined,
    selTo: undefined,
    status: "pending",
    createdAt: "c",
    updatedAt: "u",
    ...over,
  };
}

describe("requestProposal", () => {
  it("creates a pending proposal from the selection with the base revision", async () => {
    editor = makeEditor("<p>One two three. Four five six.</p>");
    registerEditor(editor);
    // Select "One two three."
    editor.commands.setTextSelection({ from: 1, to: 15 });
    fakeRepository.peekRev = () => 4;
    sendMessageMock.mockResolvedValue({ content: "A better sentence." });

    const result = await requestProposal({ documentId: "doc1", kind: "revise" });
    expect("id" in result).toBe(true);

    const rows = await fakeRepository.proposalsList("doc1");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].baseFragment).toBe("One two three.");
    expect(rows[0].baseRev).toBe(4);
    expect(rows[0].proposedFragment).toBe("A better sentence.");
    // Citations/names preservation is part of the REQUEST instructions.
    const sent = sendMessageMock.mock.calls[0][0] as { content: string }[];
    expect(sent[0].content).toContain("One two three.");
  });

  it("refuses when nothing is selected", async () => {
    editor = makeEditor("<p>text</p>");
    registerEditor(editor);
    await expect(
      requestProposal({ documentId: "doc1", kind: "revise" }),
    ).rejects.toThrow(/Select the passage/);
  });

  it("a cancelled request is owned by the operation service: settled aborted, nothing persisted", async () => {
    editor = makeEditor("<p>One two three. Four five six.</p>");
    registerEditor(editor);
    editor.commands.setTextSelection({ from: 1, to: 15 });
    // The transport honors the operation's signal (as the real one does).
    sendMessageMock.mockImplementation(
      (
        _history: unknown,
        _config: unknown,
        _system: unknown,
        opts?: { signal?: AbortSignal },
      ) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            const err = new Error("The user stopped this request.");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const pending = requestProposal({ documentId: "doc1", kind: "revise" });
    await new Promise((r) => setTimeout(r, 0));
    // The toolbar's Cancel affordance goes through the operation service.
    expect(cancelProposalRequests("doc1")).toBe(true);

    const result = await pending;
    expect(result).toEqual({
      cancelled: true,
      operationId: expect.any(String),
    });
    // After settlement, there is nothing left to cancel.
    expect(cancelProposalRequests("doc1")).toBe(false);
    // The operation settled aborted in the service.
    const op = listOperations().find((o) => o.type === "proposal");
    expect(op?.status).toBe("aborted");
    expect(op?.settled).toBe(true);
    // NOTHING was persisted: no proposal row exists.
    const rows = await fakeRepository.proposalsList("doc1");
    expect(rows).toHaveLength(0);
  });

  it("a stopped result (transport-level stop) also persists nothing", async () => {
    editor = makeEditor("<p>One two three. Four five six.</p>");
    registerEditor(editor);
    editor.commands.setTextSelection({ from: 1, to: 15 });
    sendMessageMock.mockResolvedValue({ content: "", stopped: true });

    const result = await requestProposal({ documentId: "doc1", kind: "revise" });
    expect("cancelled" in result).toBe(true);
    const op = listOperations().find((o) => o.type === "proposal");
    expect(op?.status).toBe("stopped");
    const rows = await fakeRepository.proposalsList("doc1");
    expect(rows).toHaveLength(0);
  });

  it("refuses to create a proposal from a cut-off (interrupted/truncated) response", async () => {
    for (const outcome of ["interrupted", "truncated"] as const) {
      resetFakeRepository();
      resetOperations();
      editor?.destroy();
      editor = makeEditor("<p>One two three. Four five six.</p>");
      registerEditor(editor);
      editor.commands.setTextSelection({ from: 1, to: 15 });
      // A usable-looking replacement that was cut off mid-answer: it must
      // never become a proposal (accepting it would delete the rest of
      // the selected passage).
      sendMessageMock.mockResolvedValue({
        content: "A better sentence that was cut",
        outcome,
        truncated: true,
        error: "connection reset",
      });

      await expect(
        requestProposal({ documentId: "doc1", kind: "revise" }),
      ).rejects.toThrow(/cut off/);
      const rows = await fakeRepository.proposalsList("doc1");
      expect(rows, outcome).toHaveLength(0);
      const op = listOperations().find((o) => o.type === "proposal");
      expect(op?.status).toBe("failed");
      expect(cancelProposalRequests("doc1")).toBe(false);
    }
  });
});

describe("acceptProposal", () => {
  it("locates the fragment exactly, applies ONE undoable transaction, and persists acceptance", async () => {
    editor = makeEditor("<p>One two three. Four five six.</p>");
    registerEditor(editor);

    const straight = pendingProposal({
      baseFragment: "One two three.",
      proposedFragment: "REPLACED.",
    });
    await fakeRepository.proposalCreate(straight);
    const result = await acceptProposal(straight);
    expect(result).toEqual({ ok: true });
    expect(editor!.getText()).toContain("REPLACED.");
    expect(editor!.getText()).not.toContain("One two three.");
    // The change is undoable (a ProseMirror history boundary).
    expect(editor!.can().undo()).toBe(true);
    // Accepted status persisted.
    const rows = await fakeRepository.proposalsList("doc1");
    expect(rows[0].status).toBe("accepted");
  });

  it("accepts via the verified selection range when the text there matches", async () => {
    editor = makeEditor("<p>AAA target BBB target</p>");
    registerEditor(editor);
    // sel range points at the FIRST "target" (positions 5..11).
    const ranged = pendingProposal({
      baseFragment: "target",
      proposedFragment: "kept-first",
      selFrom: 5,
      selTo: 11,
    });
    await fakeRepository.proposalCreate(ranged);
    const result = await acceptProposal(ranged);
    expect(result).toEqual({ ok: true });
    // The FIRST occurrence was replaced (range), the second untouched —
    // not a global replace.
    expect(editor!.getText()).toBe("AAA kept-first BBB target");
  });

  it("marks STALE when the base revision no longer matches, applying nothing", async () => {
    editor = makeEditor("<p>One two three.</p>");
    registerEditor(editor);
    fakeRepository.peekRev = () => 9; // the document moved on

    const staleProposal = pendingProposal({ baseRev: 3 });
    await fakeRepository.proposalCreate(staleProposal);
    const result = await acceptProposal(staleProposal);
    expect(result).toEqual({ ok: false, reason: "stale-revision" });
    // Nothing was applied.
    expect(editor!.getText()).toContain("One two three.");
    expect(editor!.can().undo()).toBe(false);
    const rows = await fakeRepository.proposalsList("doc1");
    expect(rows[0].status).toBe("stale");
  });

  it("refuses an ambiguous fragment (two exact matches) without mutation", async () => {
    editor = makeEditor("<p>echo here and echo there</p>");
    registerEditor(editor);
    const ambiguous = pendingProposal({ baseFragment: "echo", proposedFragment: "x" });
    await fakeRepository.proposalCreate(ambiguous);
    const result = await acceptProposal(ambiguous);
    expect(result).toEqual({ ok: false, reason: "ambiguous" });
    expect(editor!.getText()).toBe("echo here and echo there");
    const rows = await fakeRepository.proposalsList("doc1");
    expect(rows[0].status).toBe("pending");
  });

  it("refuses a fragment that is no longer in the document", async () => {
    editor = makeEditor("<p>nothing relevant</p>");
    registerEditor(editor);
    const rejected = pendingProposal({ baseFragment: "vanished text", proposedFragment: "x" });
    await fakeRepository.proposalCreate(rejected);
    const result = await acceptProposal(rejected);
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(editor!.getText()).toBe("nothing relevant");
  });
});

// ── B12: application matches the review display exactly ──

describe("literal application (B12)", () => {
  it("applies the preview literally: HTML-looking tags, entities, Unicode, multiline", async () => {
    editor = makeEditor("<p>One two three.</p>");
    registerEditor(editor);
    const proposed = 'A <b>bold?</b> & "quotes" — naïve\nsecond line';
    const p = pendingProposal({
      baseFragment: "One two three.",
      proposedFragment: proposed,
      selFrom: 1,
      selTo: 15,
    });
    await fakeRepository.proposalCreate(p);

    const result = await acceptProposal(p);
    expect(result).toEqual({ ok: true });
    // Multiline: one paragraph per line, exact text.
    expect(editor!.getText()).toBe(
      'A <b>bold?</b> & "quotes" — naïve\n\nsecond line',
    );
    // The literal payload, not parsed HTML: no <b> element, escaped source.
    expect(editor!.getHTML()).not.toContain("<b>");
    expect(editor!.getHTML()).toContain("&lt;b&gt;");
    // Undo restores the original fragment (one transaction).
    editor!.commands.undo();
    expect(editor!.getText()).toBe("One two three.");
  });

  it("keeps entity-looking text literal in a single-line replacement", async () => {
    editor = makeEditor("<p>before X after</p>");
    registerEditor(editor);
    const p = pendingProposal({
      baseFragment: "X",
      proposedFragment: "&amp; <tag> &#39;",
      selFrom: 8,
      selTo: 9,
    });
    await fakeRepository.proposalCreate(p);

    expect(await acceptProposal(p)).toEqual({ ok: true });
    expect(editor!.getText()).toBe("before &amp; <tag> &#39; after");
  });

  it("rejects a selection containing protected atoms with a clear explanation", async () => {
    editor = new Editor({
      extensions: [StarterKit, Citation],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Claim " },
              { type: "citation", attrs: { sourceId: "s1", label: "(Smith, 1999)" } },
              { type: "text", text: " stands." },
            ],
          },
        ],
      },
    });
    registerEditor(editor);
    const size = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: 1, to: size - 1 });

    await expect(
      requestProposal({ documentId: "doc1", kind: "revise" }),
    ).rejects.toThrow(/citation|plain-text/i);
    expect(sendMessageMock).not.toHaveBeenCalled();

    const p = pendingProposal({
      baseFragment: "Claim  stands.",
      proposedFragment: "REPLACED",
      selFrom: 1,
      selTo: size - 1,
    });
    await fakeRepository.proposalCreate(p);
    expect(await acceptProposal(p)).toEqual({
      ok: false,
      reason: "unsupported-selection",
    });
    expect(editor.getText()).toContain("stands.");
  });

  it("rejects a selection that spans multiple blocks", async () => {
    editor = makeEditor("<p>one</p><p>two</p>");
    registerEditor(editor);
    editor.commands.setTextSelection({ from: 2, to: 7 });

    await expect(
      requestProposal({ documentId: "doc1", kind: "revise" }),
    ).rejects.toThrow(/single paragraph|multiple blocks/i);

    const p = pendingProposal({
      baseFragment: "ne\ntw",
      proposedFragment: "REPLACED",
      selFrom: 2,
      selTo: 7,
    });
    await fakeRepository.proposalCreate(p);
    expect(await acceptProposal(p)).toEqual({
      ok: false,
      reason: "unsupported-selection",
    });
  });

  it("detects a proposal that does not change the text", async () => {
    editor = makeEditor("<p>One two three.</p>");
    registerEditor(editor);
    const p = pendingProposal({
      baseFragment: "One two three.",
      proposedFragment: "One two three.",
      selFrom: 1,
      selTo: 15,
    });
    await fakeRepository.proposalCreate(p);

    const result = await acceptProposal(p);
    expect(result).toEqual({ ok: false, reason: "no-change" });
    expect(editor!.getText()).toBe("One two three.");
    expect(editor!.can().undo()).toBe(false);
  });

  it("prevents applying the same proposal twice", async () => {
    editor = makeEditor("<p>One two three.</p>");
    registerEditor(editor);
    const p = pendingProposal({
      baseFragment: "One two three.",
      proposedFragment: "REPLACED.",
      selFrom: 1,
      selTo: 15,
    });
    await fakeRepository.proposalCreate(p);

    expect(await acceptProposal(p)).toEqual({ ok: true });
    const again = await acceptProposal({ ...p, status: "pending" });
    expect(again).toEqual({ ok: false, reason: "already-decided" });
    expect(editor!.getText()).toBe("REPLACED.");
  });

  it("an out-of-range recorded selection falls back to a unique exact match", async () => {
    editor = makeEditor("<p>One two three.</p>");
    registerEditor(editor);
    const p = pendingProposal({
      baseFragment: "One two three.",
      proposedFragment: "FOUND BY MATCH.",
      selFrom: 9999,
      selTo: 10001,
    });
    await fakeRepository.proposalCreate(p);

    expect(await acceptProposal(p)).toEqual({ ok: true });
    expect(editor!.getText()).toBe("FOUND BY MATCH.");
  });
});

describe("reject + revalidation", () => {
  it("reject persists without touching the document", async () => {
    editor = makeEditor("<p>text</p>");
    registerEditor(editor);
    const rejected = pendingProposal();
    await fakeRepository.proposalCreate(rejected);
    await rejectProposal(rejected);
    const rows = await fakeRepository.proposalsList("doc1");
    expect(rows[0].status).toBe("rejected");
  });

  it("markStaleIfMoved flags pending proposals from older revisions", async () => {
    editor = makeEditor("<p>text</p>");
    registerEditor(editor);
    const rows = [
      pendingProposal({ id: "a", baseRev: 1, status: "pending" }),
      pendingProposal({ id: "b", baseRev: 7, status: "pending" }),
    ];
    for (const p of rows) await fakeRepository.proposalCreate(p);
    const changed = await markStaleIfMoved(rows, 7);
    expect(changed).toBe(1);
    const after = await fakeRepository.proposalsList("doc1");
    expect(after.find((p) => p.id === "a")!.status).toBe("stale");
    expect(after.find((p) => p.id === "b")!.status).toBe("pending");
  });
});

// ── B11: proposals are bound to their exact document and session ──

describe("proposal document/session ownership (B11)", () => {
  it("a delayed A proposal cannot apply to B's editor, even with identical words", async () => {
    const editorA = makeEditor("<p>Identical words.</p>");
    const editorB = makeEditor("<p>Identical words.</p>");
    registerEditor(editorA, "docA");

    const proposal = pendingProposal({
      documentId: "docA",
      baseFragment: "Identical words.",
      proposedFragment: "CHANGED BY A.",
    });
    await fakeRepository.proposalCreate(proposal);

    // The user navigates to document B (the editor is replaced) before
    // accepting A's proposal.
    registerEditor(editorB, "docB");
    const result = await acceptProposal(proposal);

    expect(result.ok).toBe(false);
    expect(editorB.getText()).toBe("Identical words.");
    expect(editorB.getText()).not.toContain("CHANGED BY A.");
    // The proposal was not touched by a failed acceptance.
    const rows = await fakeRepository.proposalsList("docA");
    expect(rows[0].status).toBe("pending");
    editorA.destroy();
    editorB.destroy();
  });

  it("refuses to request a proposal for a document the editor is not showing", async () => {
    editor = makeEditor("<p>One two three.</p>");
    registerEditor(editor);
    editor.commands.setTextSelection({ from: 1, to: 15 });
    await expect(
      requestProposal({ documentId: "other-doc", kind: "revise" }),
    ).rejects.toThrow(/different document|not open/i);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("captures the base revision BEFORE awaiting the AI (a save during generation must not move it)", async () => {
    editor = makeEditor("<p>One two three. Four five six.</p>");
    registerEditor(editor);
    editor.commands.setTextSelection({ from: 1, to: 15 });
    fakeRepository.peekRev = () => 4;

    let release!: () => void;
    sendMessageMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ content: "A better sentence." });
        }),
    );

    const pending = requestProposal({ documentId: "doc1", kind: "revise" });
    await new Promise((r) => setTimeout(r, 0));
    // A Save lands while the AI is still generating: the revision moves on.
    fakeRepository.peekRev = () => 7;
    release();
    await pending;

    const rows = await fakeRepository.proposalsList("doc1");
    expect(rows[0].baseRev).toBe(4);
  });

  it("treats an unknown revision as unverified at acceptance (never automatically valid)", async () => {
    editor = makeEditor("<p>One two three.</p>");
    registerEditor(editor);
    fakeRepository.peekRev = () => null;
    const proposal = pendingProposal({ baseRev: 3 });
    await fakeRepository.proposalCreate(proposal);

    const result = await acceptProposal(proposal);
    expect(result).toEqual({ ok: false, reason: "unverified-revision" });
    expect(editor!.getText()).toBe("One two three.");
    expect(editor!.can().undo()).toBe(false);
  });

  it("refuses to create a proposal when the base revision cannot be captured", async () => {
    editor = makeEditor("<p>One two three.</p>");
    registerEditor(editor);
    editor.commands.setTextSelection({ from: 1, to: 15 });
    fakeRepository.peekRev = () => null;
    await expect(
      requestProposal({ documentId: "doc1", kind: "revise" }),
    ).rejects.toThrow(/revision/i);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
