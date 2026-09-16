// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, waitFor, cleanup, act, fireEvent, within } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";

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

import DocumentEditorView from "@/components/editor/DocumentEditorView";
import DocumentPane from "@/components/workspace/DocumentPane";
import { capturePendingEditorChanges } from "@/components/editor/useDocumentSession";
import { getActiveEditorDocumentId, setActiveEditor } from "@/services/revisionService";
import { useLibraryStore } from "@/stores/libraryStore";
import { useAppStore } from "@/stores/useAppStore";
import { bumpDatasetGeneration } from "@/utils/datasetGeneration";
import { useDraftStore } from "@/stores/draftStore";
import { fakeRepoState, resetFakeRepository } from "@/test/fakeRepository";
import { markdownDocument, richDocument } from "@/utils/documentCodec";
import type { LibraryTextMeta } from "@/types";

const meta: LibraryTextMeta = {
  id: "doc1",
  title: "The Archive Essay",
  textType: "essay",
  createdAt: "c",
  updatedAt: "u",
};

beforeEach(async () => {
  const prefs = new Map<string, string>();
  const invokeMock = (await import("@tauri-apps/api/core")).invoke as Mock;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "db_prefs_get":
        return prefs.get(String(args.key)) ?? null;
      case "db_prefs_set":
        prefs.set(String(args.key), String(args.value));
        return null;
      case "db_prefs_get_all":
        return [...prefs.entries()].map(([key, value]) => ({ key, value }));
      default:
        return null;
    }
  });
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

  resetFakeRepository();
  fakeRepoState.texts.set("doc1", {
    meta,
    body: markdownDocument("# The Archive\n\nOld markdown body with *emphasis*."),
    versions: [],
    rev: 0,
  });
  useLibraryStore.setState({ texts: [meta], textsLoaded: true, pendingAttachId: null });
  // The body cache is module-level: drop any body cached by a previous
  // test (e.g. an invalid one) so this test reads its own seeded body.
  useLibraryStore.getState().invalidateTextContent("doc1");
  useDraftStore.setState({ drafts: {}, hydrated: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setActiveEditor(null);
});

// jsdom has no layout engine; ProseMirror's selection scrolling asks text
// nodes for client rects. Empty stubs keep the view code happy in tests.
if (typeof Text !== "undefined") {
  (Text.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects =
    () => [];
  (Element.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects =
    () => [];
}

describe("DocumentEditorView (rich editor)", () => {
  let editorCapture: Editor | null = null;

  it("recovers a rich draft across unmount and remount", async () => {
    const first = render(
      <DocumentEditorView
        id="doc1"
        onBack={() => {}}
        onSaved={() => {}}
        editorRef={(e) => {
          editorCapture = e;
        }}
      />,
    );

    // The editor mounts asynchronously (jsdom); wait for it to be live.
    await waitFor(
      () => expect(editorCapture).not.toBeNull(),
      { timeout: 5000 },
    );
    expect(document.querySelector(".rich-doc")!.textContent).toContain(
      "The Archive",
    );

    // Type through the editor's own command pipeline: the exact
    // transaction path real typing produces. (No focus(): jsdom has no
    // layout engine, and PM's scroll-to-selection needs client rects.)
    const ed = editorCapture!;
    await act(async () => {
      ed.commands.insertContent(" appended words");
    });

    // The debounced draft projection (500ms) carries the RICH payload.
    await waitFor(
      () => {
        const draft = useDraftStore.getState().drafts["text:doc1"];
        expect(draft).not.toBeNull();
        expect(draft!.meta?.contentFormat).toBe("tiptap-json");
        expect(() => JSON.parse(draft!.content)).not.toThrow();
      },
      { timeout: 4000 },
    );

    first.unmount();
    editorCapture = null;

    // Remount: the recovered draft (rich) wins over the stored markdown.
    render(
      <DocumentEditorView
        id="doc1"
        onBack={() => {}}
        onSaved={() => {}}
        editorRef={(e) => {
          editorCapture = e;
        }}
      />,
    );
    await waitFor(
      () => {
        expect(editorCapture).not.toBeNull();
        expect(
          document.querySelector(".rich-doc")!.textContent,
        ).toContain("appended words");
      },
      { timeout: 5000 },
    );
  });

  it("explicit Save commits a rich body and snapshots the markdown original", async () => {
    let captured: Editor | null = null;
    render(
      <DocumentEditorView
        id="doc1"
        onBack={() => {}}
        onSaved={() => {}}
        editorRef={(e) => {
          captured = e;
        }}
      />,
    );
    await waitFor(() => expect(captured).not.toBeNull(), { timeout: 5000 });

    fireEventSave();
    await waitFor(
      () => {
        const entry = fakeRepoState.texts.get("doc1");
        expect(entry?.body.contentFormat).toBe("tiptap-json");
        expect(JSON.parse(entry!.body.content)).toHaveProperty("type", "doc");
        // The original markdown survived as the snapshot.
        expect(entry!.versions.some((v) => v.body.contentFormat === "markdown")).toBe(true);
        // Acknowledged: the recovery draft is gone.
        expect(useDraftStore.getState().drafts["text:doc1"]).toBeUndefined();
      },
      { timeout: 5000 },
    );
  });

  it("a failed save retains the editable content and offers Retry/Discard", async () => {
    let captured: Editor | null = null;
    render(
      <DocumentEditorView
        id="doc1"
        onBack={() => {}}
        onSaved={() => {}}
        editorRef={(e) => {
          captured = e;
        }}
      />,
    );
    await waitFor(() => expect(captured).not.toBeNull(), { timeout: 5000 });

    fakeRepoState.nextError = new Error("disk gone");
    fireEventSave();
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined(), {
      timeout: 5000,
    });
    expect(screen.getByRole("alert").textContent).toContain("disk gone");
    // The editor still holds the document; the draft is retained.
    expect(document.querySelector(".rich-doc")!.textContent).toContain(
      "The Archive",
    );
    expect(screen.getByRole("button", { name: /Retry/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Discard draft/i })).toBeDefined();

    // Recovery: a retry commits and clears the recovery draft.
    fakeRepoState.nextError = null;
    screen.getByRole("button", { name: /Retry/i }).click();
    await waitFor(
      () => {
        expect(useDraftStore.getState().drafts["text:doc1"]).toBeUndefined();
        expect(fakeRepoState.texts.get("doc1")?.body.contentFormat).toBe("tiptap-json");
      },
      { timeout: 5000 },
    );
  });
});

function fireEventSave() {
  const saveButton = screen.getAllByRole("button", { name: /^Save$/i })[0];
  saveButton.click();
}

// ── B03: capture before navigation, unique sessions, explicit discard ──

/** Render an editor and resolve once its ProseMirror instance is live. */
async function renderEditor(props: {
  id: string | null;
  sessionId?: string;
  projectId?: string;
  onBack?: () => void;
}): Promise<{ unmount: () => void; editor: () => Editor }> {
  let captured: Editor | null = null;
  const result = render(
    <DocumentEditorView
      id={props.id}
      sessionId={props.sessionId}
      projectId={props.projectId}
      onBack={props.onBack ?? (() => {})}
      onSaved={() => {}}
      editorRef={(e) => {
        captured = e;
      }}
    />,
  );
  await waitFor(() => expect(captured).not.toBeNull(), { timeout: 5000 });
  return {
    unmount: () => result.unmount(),
    editor: () => {
      if (!captured) throw new Error("editor not ready");
      return captured;
    },
  };
}

describe("document session capture (B03)", () => {
  it("keeps an edit typed 100 ms before navigation and returns it on remount", async () => {
    const first = await renderEditor({ id: "doc1" });

    // Type through the real transaction path; no debounce is awaited.
    await act(async () => {
      first.editor().commands.insertContent(" hundred-ms-edit");
    });
    // Dirty state is immediate, not a debounce later.
    expect(screen.getByText("Unsaved")).toBeDefined();

    // Navigate away immediately (unmount), before the 500 ms projection.
    first.unmount();
    const recovered = useDraftStore.getState().drafts["text:doc1"];
    expect(recovered).toBeDefined();
    expect(recovered!.content).toContain("hundred-ms-edit");

    // Return: the latest document is what the editor shows.
    const second = await renderEditor({ id: "doc1" });
    expect(document.querySelector(".rich-doc")!.textContent).toContain(
      "hundred-ms-edit",
    );
    second.unmount();
  });

  it("flushes the latest document before a persistence drain (synchronous capture)", async () => {
    const view = await renderEditor({ id: "doc1" });
    await act(async () => {
      view.editor().commands.insertContent(" drained-edit");
    });
    // Exactly what the close/relaunch drains call first.
    capturePendingEditorChanges();
    const draft = useDraftStore.getState().drafts["text:doc1"];
    expect(draft).toBeDefined();
    expect(draft!.content).toContain("drained-edit");
    view.unmount();
  });

  it("gives two unsaved new documents in different projects separate sessions", async () => {
    const first = await renderEditor({
      id: null,
      sessionId: "session-a",
      projectId: "project-a",
    });
    await act(async () => {
      first.editor().commands.insertContent("alpha-body");
    });
    first.unmount();

    const second = await renderEditor({
      id: null,
      sessionId: "session-b",
      projectId: "project-b",
    });
    await act(async () => {
      second.editor().commands.insertContent("beta-body");
    });
    second.unmount();

    const drafts = useDraftStore.getState().drafts;
    expect(drafts["text:new:session-a"]?.content).toContain("alpha-body");
    expect(drafts["text:new:session-a"]?.meta?.projectId).toBe("project-a");
    expect(drafts["text:new:session-b"]?.content).toContain("beta-body");
    expect(drafts["text:new:session-b"]?.meta?.projectId).toBe("project-b");
    expect(drafts["text:new"]).toBeUndefined();

    // Each session recovers its OWN body — no cross-document leakage.
    const backToA = await renderEditor({
      id: null,
      sessionId: "session-a",
      projectId: "project-a",
    });
    expect(document.querySelector(".rich-doc")!.textContent).toContain(
      "alpha-body",
    );
    expect(document.querySelector(".rich-doc")!.textContent).not.toContain(
      "beta-body",
    );
    backToA.unmount();
  });

  it("explicit discard stays discarded through unmount and remount", async () => {
    const onBack = vi.fn();
    const view = await renderEditor({ id: "doc1", onBack });
    await act(async () => {
      view.editor().commands.insertContent(" discard-me");
    });

    // A failed save surfaces the explicit Discard action.
    fakeRepoState.nextError = new Error("disk gone");
    fireEventSave();
    await waitFor(
      () => expect(screen.getByRole("button", { name: /Discard draft/i })).toBeDefined(),
      { timeout: 5000 },
    );
    fireEvent.click(screen.getByRole("button", { name: /Discard draft/i }));
    expect(onBack).toHaveBeenCalled();
    expect(useDraftStore.getState().drafts["text:doc1"]).toBeUndefined();

    // Unmount: the cleanup capture must NOT resurrect the discarded text.
    view.unmount();
    expect(useDraftStore.getState().drafts["text:doc1"]).toBeUndefined();

    // Remount: the stored document, not the discarded edit.
    const again = await renderEditor({ id: "doc1" });
    const text = document.querySelector(".rich-doc")!.textContent ?? "";
    expect(text).toContain("The Archive");
    expect(text).not.toContain("discard-me");
    again.unmount();
  });
});

describe("dataset replacement (B07)", () => {
  it("replaces mounted editor content when the same id is restored", async () => {
    useAppStore.setState({ view: { kind: "edit", id: "doc1" } });
    render(<DocumentPane onOpenSettings={() => {}} />);
    await waitFor(
      () =>
        expect(document.querySelector(".rich-doc")!.textContent).toContain(
          "The Archive",
        ),
      { timeout: 5000 },
    );

    // Simulate a restore: the repository now holds different content for
    // the SAME id, and the dataset generation bumps.
    fakeRepoState.texts.get("doc1")!.body = markdownDocument("# Restored body");
    useLibraryStore.getState().invalidateTextContent("doc1");
    await act(async () => {
      bumpDatasetGeneration();
    });

    await waitFor(
      () =>
        expect(document.querySelector(".rich-doc")!.textContent).toContain(
          "Restored body",
        ),
      { timeout: 5000 },
    );
    expect(document.querySelector(".rich-doc")!.textContent).not.toContain(
      "The Archive",
    );
  });
});

// ── B10: schema-invalid rich bodies never become an empty manuscript ──

describe("schema-invalid rich bodies (B10)", () => {
  it("shows a recovery state, preserves the stored bytes, and blocks Save", async () => {
    const raw = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "kept prose" }] },
        { type: "futureWidget", attrs: { x: 1 } },
      ],
    });
    fakeRepoState.texts.get("doc1")!.body = {
      contentFormat: "tiptap-json",
      contentSchemaVersion: 1,
      content: raw,
      plainText: "kept prose",
    };
    useLibraryStore.getState().invalidateTextContent("doc1");

    render(
      <DocumentEditorView
        id="doc1"
        onBack={() => {}}
        onSaved={() => {}}
        editorRef={() => {}}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/schema|futureWidget|cannot/i);
    // The raw bytes stay visible for recovery.
    expect(
      document.querySelector("[data-testid=raw-body]")?.textContent,
    ).toContain("futureWidget");
    // The silent code-block fallback is gone.
    expect(document.querySelector(".rich-doc")).toBeNull();

    // Normal Save cannot replace the preserved original.
    const saveButton = screen.getAllByRole("button", {
      name: /^Save$/i,
    })[0] as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    saveButton.click();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(fakeRepoState.texts.get("doc1")!.body.content).toBe(raw);
    expect(useDraftStore.getState().drafts["text:doc1"]).toBeUndefined();
  });

  it("never replaces a corrupt rich payload with a code block", async () => {
    fakeRepoState.texts.get("doc1")!.body = {
      contentFormat: "tiptap-json",
      contentSchemaVersion: 1,
      content: "{not json",
      plainText: "",
    };
    useLibraryStore.getState().invalidateTextContent("doc1");

    render(
      <DocumentEditorView
        id="doc1"
        onBack={() => {}}
        onSaved={() => {}}
        editorRef={() => {}}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/JSON|schema|cannot/i);
    expect(
      document.querySelector("[data-testid=raw-body]")?.textContent,
    ).toContain("{not json");

    const saveButton = screen.getAllByRole("button", {
      name: /^Save$/i,
    })[0] as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(fakeRepoState.texts.get("doc1")!.body.content).toBe("{not json");
  });
});

// ── B11: the editor registers its document identity ──

describe("editor registration (B11)", () => {
  it("registers the open document and clears it on unmount", async () => {
    const view = await renderEditor({ id: "doc1" });
    expect(getActiveEditorDocumentId()).toBe("doc1");
    view.unmount();
    await waitFor(() => expect(getActiveEditorDocumentId()).toBeNull());
  });

  it("does not register an unsaved new document as a proposal target", async () => {
    const view = await renderEditor({ id: null, sessionId: "new-session" });
    expect(getActiveEditorDocumentId()).toBeNull();
    view.unmount();
  });
});

// ── B12: history restore reconciles the recovery draft ──

describe("history restore vs recovery drafts (B12)", () => {
  it("reopening Edit shows the restored version, not the pre-restore draft", async () => {
    // A dirty draft, as if the user typed and navigated away.
    useDraftStore.setState({
      drafts: {
        "text:doc1": {
          key: "text:doc1",
          kind: "text",
          entityId: "doc1",
          content: richDocument({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "DRAFT TEXT" }],
              },
            ],
          }).content,
          meta: { contentFormat: "tiptap-json", plainText: "DRAFT TEXT" },
          savedAt: null,
          error: null,
          updatedAt: "u",
        },
      },
      hydrated: true,
    });
    fakeRepoState.texts.get("doc1")!.versions = [
      {
        versionId: "v-old",
        savedAt: "2026-01-01T00:00:00.000Z",
        body: markdownDocument("# Restored version"),
      },
    ];
    useLibraryStore.getState().invalidateTextContent("doc1");

    await useLibraryStore.getState().restoreVersion("doc1", "v-old");
    // The restore explicitly discards the draft: it must not come back.
    expect(useDraftStore.getState().drafts["text:doc1"]).toBeUndefined();

    render(
      <DocumentEditorView
        id="doc1"
        onBack={() => {}}
        onSaved={() => {}}
        editorRef={() => {}}
      />,
    );
    await waitFor(
      () =>
        expect(document.querySelector(".rich-doc")!.textContent).toContain(
          "Restored version",
        ),
      { timeout: 5000 },
    );
    expect(document.querySelector(".rich-doc")!.textContent).not.toContain(
      "DRAFT TEXT",
    );
  });
});

// ── Markdown ↔ rich round-trip through the actual editor parsers ──

describe("markdown round-trip (editor parsers)", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function makeEditor(): Editor {
    return new Editor({
      extensions: [StarterKit, TableKit, Markdown],
      content: "",
    });
  }

  it("preserves headings, lists, quotations, links, tables, and unicode", () => {
    const md = [
      "# Décoloniser l'archive",
      "",
      "A paragraph with [a link](https://example.org) and *emphasis*.",
      "",
      "> A quotation worth keeping — 你好",
      "",
      "- first item",
      "- second item",
      "",
      "1. ordered one",
      "2. ordered two",
      "",
      "| A | B |",
      "| --- | --- |",
      "| one | deux |",
    ].join("\n");

    editor = makeEditor();
    editor.commands.setContent(md, { contentType: "markdown" });
    const out = editor.getMarkdown();

    // Structural fidelity (serialization normalizes whitespace and
    // pads table cells to align).
    expect(out).toContain("# Décoloniser l'archive");
    expect(out).toContain("[a link](https://example.org)");
    expect(out).toContain("*emphasis*");
    expect(out).toContain("A quotation worth keeping — 你好");
    expect(out).toContain("- first item");
    expect(out).toContain("2. ordered two");
    expect(out).toMatch(/\| A\s+\| B\s+\|/);
    expect(out).toMatch(/\| one\s+\| deux\s+\|/);
    expect(out).toMatch(/\| ---\s+\|/);

    // Round-trip stability: parse(serialize(parse(x))) == serialize(parse(x)).
    const second = makeEditor();
    second.commands.setContent(out, { contentType: "markdown" });
    expect(second.getMarkdown()).toBe(out);
    second.destroy();
  });

  it("rich bodies survive a save-and-reopen cycle with formatting intact", () => {
    editor = makeEditor();
    editor.commands.setContent("# Kept heading\n\nkept paragraph", {
      contentType: "markdown",
    });
    const body = richDocument(editor.getJSON());
    expect(body.contentFormat).toBe("tiptap-json");

    const reopened = makeEditor();
    const parsed = JSON.parse(body.content);
    reopened.commands.setContent(parsed);
    expect(reopened.getMarkdown()).toContain("# Kept heading");
    expect(reopened.getMarkdown()).toContain("kept paragraph");
    reopened.destroy();
  });
});

// ── B19: bibliography references through the real CiteControls button ──

describe("bibliography source references (B19)", () => {
  it("inserts known sources and reports unresolved references through the real button", async () => {
    const { useSourceStore } = await import("@/stores/sourceStore");
    useSourceStore.setState({
      sources: [
        {
          id: "s1",
          title: "Une saison au Congo",
          author: "Césaire, Aimé",
          year: "1966",
          originalText: "Une saison au Congo",
          contentHash: "hash-s1",
          extractionStatus: "ready",
          includedInContext: true,
          verification: "unverified",
          createdAt: "c",
          updatedAt: "u",
        },
      ],
      sourcesLoaded: true,
      jobs: {},
    });

    let editorCapture: Editor | null = null;
    render(
      <DocumentEditorView
        id="doc1"
        onBack={() => {}}
        onSaved={() => {}}
        editorRef={(e) => {
          editorCapture = e;
        }}
      />,
    );
    await waitFor(() => expect(editorCapture).not.toBeNull(), { timeout: 5000 });

    // One resolvable citation and one source-backed footnote whose source
    // no longer exists (its stored text is the fallback).
    await act(async () => {
      editorCapture!.commands.insertContent("Claim.");
      editorCapture!.commands.insertCitation({
        sourceId: "s1",
        label: "(Césaire, 1966)",
      });
      editorCapture!.commands.insertFootnote({
        id: "fn-gone",
        label: "1",
        text: "Fallback note text.",
        sourceId: "deleted-source",
        passageId: "p9",
        locator: "¶ 2",
      });
    });

    const controls = screen.getByRole("group", { name: "Citations" });
    fireEvent.click(
      within(controls).getByRole("button", { name: /Insert bibliography/i }),
    );

    // The unresolved reference is reported…
    const notice = await within(controls).findByRole(
      "status",
      {},
      { timeout: 10000 },
    );
    expect(notice.textContent).toMatch(/no longer exist/i);
    // …while the known source still produces the bibliography section.
    await waitFor(
      () =>
        expect(document.querySelector(".rich-doc")!.textContent).toContain(
          "Une saison au Congo",
        ),
      { timeout: 10000 },
    );
  });
});

// ── B20a: shortcut scoping and the Link / command-palette chord ──

describe("editor shortcut scoping (B20a)", () => {
  it("turns Ctrl+K into the link flow only while the manuscript has focus", async () => {
    let editorCapture: Editor | null = null;
    render(
      <DocumentEditorView
        id="doc1"
        onBack={() => {}}
        onSaved={() => {}}
        editorRef={(e) => {
          editorCapture = e;
        }}
      />,
    );
    await waitFor(() => expect(editorCapture).not.toBeNull(), { timeout: 5000 });
    const ed = editorCapture!;
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);

    // The shortcut listener registers once the editor state settles: Ctrl+F
    // proves it is live before the Ctrl+K assertions below.
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const findInput = await screen.findByLabelText("Find text");
    fireEvent.keyDown(findInput, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("search")).toBeNull());

    // A keystroke outside the manuscript: the palette owns Ctrl+K.
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(prompt).not.toHaveBeenCalled();

    // A keystroke inside the manuscript: the Link command handles it.
    fireEvent.keyDown(ed.view.dom, { key: "k", ctrlKey: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    prompt.mockRestore();
  });

  it("does not run Find shortcuts from inside a dialog surface", async () => {
    let editorCapture: Editor | null = null;
    render(
      <DocumentEditorView
        id="doc1"
        onBack={() => {}}
        onSaved={() => {}}
        editorRef={(e) => {
          editorCapture = e;
        }}
      />,
    );
    await waitFor(() => expect(editorCapture).not.toBeNull(), { timeout: 5000 });

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const input = document.createElement("input");
    dialog.appendChild(input);
    document.body.appendChild(dialog);
    input.focus();
    fireEvent.keyDown(input, { key: "f", ctrlKey: true });
    expect(screen.queryByRole("search")).toBeNull();
    dialog.remove();
  });
});
