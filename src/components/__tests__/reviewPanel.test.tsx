// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

const storage: Record<string, string> = {};

vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => {
    storage[key] = String(value);
  },
  removeItem: (key: string) => {
    delete storage[key];
  },
  clear: () => {
    for (const key of Object.keys(storage)) delete storage[key];
  },
  key: (index: number) => Object.keys(storage)[index] ?? null,
  get length() {
    return Object.keys(storage).length;
  },
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

vi.mock("@/utils/api", () => ({
  sendMessage: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
  exists: vi.fn(),
  BaseDirectory: { AppData: "AppData" },
}));

import ReviewPanel from "@/components/workspace/ReviewPanel";
import { useAppStore } from "@/stores/useAppStore";
import {
  setActiveEditor,
  requestProposal,
  resetAppliedProposalsForTests,
} from "@/services/revisionService";
import { fakeRepository, resetFakeRepository } from "@/test/fakeRepository";
import { sendMessage } from "@/utils/api";
import type { DocumentProposal } from "@/types";

const sendMessageMock = sendMessage as unknown as Mock;

let editor: Editor | null = null;

function register(ed: Editor, documentId: string): void {
  setActiveEditor({ documentId, editor: ed, editVersion: () => 0 });
}

function proposal(over: Partial<DocumentProposal> = {}): DocumentProposal {
  return {
    id: "p1",
    documentId: "doc1",
    baseRev: 0,
    requestKind: "revise",
    baseFragment: "One two three.",
    proposedFragment: "REPLACED.",
    status: "pending",
    createdAt: "c",
    updatedAt: "u",
    ...over,
  };
}

beforeEach(() => {
  resetFakeRepository();
  resetAppliedProposalsForTests();
  sendMessageMock.mockReset();
  // A known revision: the fake has no revision registry of its own.
  fakeRepository.peekRev = () => 0;
  useAppStore.setState({ view: { kind: "read", id: "doc1" } });
});

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
  setActiveEditor(null);
});

describe("ReviewPanel ownership (B11)", () => {
  it("offers Open in editor in a read view instead of an invalid Accept", async () => {
    await fakeRepository.proposalCreate(proposal({ documentId: "doc1" }));
    render(<ReviewPanel documentId="doc1" />);
    await screen.findByText("REPLACED.");

    expect(screen.queryByRole("button", { name: /Accept/i })).toBeNull();
    const open = screen.getByRole("button", { name: /Open in editor/i });
    open.click();
    expect(useAppStore.getState().view).toEqual({ kind: "edit", id: "doc1" });
  });

  it("applies a proposal only when its own document is open in the editor", async () => {
    editor = new Editor({
      extensions: [StarterKit],
      content: "<p>One two three.</p>",
    });
    register(editor, "doc1");
    await fakeRepository.proposalCreate(proposal({ documentId: "doc1" }));

    render(<ReviewPanel documentId="doc1" />);
    const accept = await screen.findByRole("button", { name: /Accept/i });
    accept.click();
    await waitFor(() => expect(editor!.getText()).toContain("REPLACED."));
    await waitFor(async () => {
      const rows = await fakeRepository.proposalsList("doc1");
      expect(rows[0].status).toBe("accepted");
    });
  });

  it("a delayed load for A cannot replace B's proposals", async () => {
    await fakeRepository.proposalCreate(
      proposal({ id: "pa", documentId: "docA", proposedFragment: "A-ROW" }),
    );
    await fakeRepository.proposalCreate(
      proposal({ id: "pb", documentId: "docB", proposedFragment: "B-ROW" }),
    );
    const original = fakeRepository.proposalsList.bind(fakeRepository);
    fakeRepository.proposalsList = async (id: string) => {
      if (id === "docA") {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return original(id);
    };

    const { rerender } = render(<ReviewPanel documentId="docA" />);
    rerender(<ReviewPanel documentId="docB" />);
    expect(await screen.findByText("B-ROW")).toBeDefined();

    // A's slow response lands late: it must be discarded, not shown.
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(screen.queryByText("A-ROW")).toBeNull();
    expect(screen.getByText("B-ROW")).toBeDefined();
    fakeRepository.proposalsList = original;
  });

  it("refreshes when a proposal request completes", async () => {
    editor = new Editor({
      extensions: [StarterKit],
      content: "<p>One two three.</p>",
    });
    register(editor, "doc1");
    editor.commands.setTextSelection({ from: 1, to: 15 });
    sendMessageMock.mockResolvedValue({ content: "A better sentence." });

    render(<ReviewPanel documentId="doc1" />);
    await screen.findByText(/No proposals yet/i);

    await act(async () => {
      await requestProposal({ documentId: "doc1", kind: "revise" });
    });
    expect(await screen.findByText("A better sentence.")).toBeDefined();
  });

  it("shows an accept failure visibly and does not mutate the document", async () => {
    editor = new Editor({
      extensions: [StarterKit],
      content: "<p>nothing relevant</p>",
    });
    register(editor, "doc1");
    await fakeRepository.proposalCreate(
      proposal({ baseFragment: "vanished text", proposedFragment: "x" }),
    );

    render(<ReviewPanel documentId="doc1" />);
    const accept = await screen.findByRole("button", { name: /Accept/i });
    accept.click();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no longer in the document/i);
    expect(editor.getText()).toBe("nothing relevant");
  });
});
