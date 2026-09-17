// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";

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

import { Editor } from "@tiptap/react";
import DocumentEditorView from "@/components/editor/DocumentEditorView";
import DocumentPane from "@/components/workspace/DocumentPane";
import { capturePendingEditorChanges } from "@/components/editor/useDocumentSession";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useDraftStore } from "@/stores/draftStore";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/chatStore";
import { useSourceStore } from "@/stores/sourceStore";
import {
  fakeRepository,
  fakeRepoState,
  resetFakeRepository,
} from "@/test/fakeRepository";
import { markdownDocument } from "@/utils/documentCodec";
import type { LibraryTextMeta, ProjectMeta } from "@/types";

const docMeta: LibraryTextMeta = {
  id: "doc1",
  title: "The Archive Essay",
  textType: "essay",
  createdAt: "c",
  updatedAt: "u",
};

const projectA: ProjectMeta = {
  id: "p-a",
  title: "Project Alpha",
  createdAt: "c",
  updatedAt: "u",
};

const projectB: ProjectMeta = {
  id: "p-b",
  title: "Project Beta",
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
    meta: docMeta,
    body: markdownDocument("# The Archive\n\nOld markdown body with *emphasis*."),
    versions: [],
    rev: 0,
  });
  fakeRepoState.projects.set("p-a", { meta: projectA, brief: null, rev: 0 });
  fakeRepoState.projects.set("p-b", {
    meta: projectB,
    brief: "Beta's stored brief.",
    rev: 0,
  });
  useLibraryStore.setState({ texts: [docMeta], textsLoaded: true, pendingAttachId: null });
  useProjectStore.setState({
    projects: [projectA, projectB],
    projectsLoaded: true,
    pendingBriefProjectId: null,
  });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  useSourceStore.setState({ sources: [], sourcesLoaded: true, jobs: {} });
  useChatStore.setState({
    threads: [],
    threadsLoaded: true,
    activeThreadId: null,
    threadLoaded: true,
    messages: [],
  });
  useAppStore.setState({ view: { kind: "list" }, focusMode: false });
});

afterEach(() => {
  cleanup();
});

/** Render an editor and resolve once its ProseMirror instance is live. */
async function renderEditor(): Promise<{
  unmount: () => void;
  editor: () => Editor;
}> {
  let captured: Editor | null = null;
  const result = render(
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
  return {
    unmount: () => result.unmount(),
    editor: () => {
      if (!captured) throw new Error("editor not ready");
      return captured;
    },
  };
}

function clickSave(): void {
  screen.getAllByRole("button", { name: /^Save$/i })[0].click();
}

describe("save acknowledgements (B04)", () => {
  it("a title-only edit keeps the body and the title on remount", async () => {
    const first = await renderEditor();
    fireEvent.change(screen.getByLabelText("Document title"), {
      target: { value: "Retitled manuscript" },
    });
    // Metadata-only drafts must not replace the body with empty content:
    // leave before any debounce/projection.
    first.unmount();
    const draft = useDraftStore.getState().drafts["text:doc1"];
    expect(draft?.meta?.title).toBe("Retitled manuscript");

    const second = await renderEditor();
    expect(
      (screen.getByLabelText("Document title") as HTMLInputElement).value,
    ).toBe("Retitled manuscript");
    expect(document.querySelector(".rich-doc")!.textContent).toContain(
      "The Archive",
    );
    second.unmount();
  });

  it("a failed untouched-document Save retains the body and the error on remount", async () => {
    const first = await renderEditor();
    fakeRepoState.nextError = new Error("disk gone");
    clickSave();
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined(), {
      timeout: 5000,
    });
    first.unmount();

    // The failed revision is recoverable — the body is not an empty
    // replacement, and the error is still reported.
    const second = await renderEditor();
    expect(document.querySelector(".rich-doc")!.textContent).toContain(
      "The Archive",
    );
    expect(screen.getByRole("alert").textContent).toContain("disk gone");
    second.unmount();
  });

  it("acknowledges only the submitted version: edits typed during Save stay Unsaved", async () => {
    const view = await renderEditor();

    // A controllable in-flight flush: Save A stays pending while B is typed.
    let releaseFlush: (() => void) | null = null;
    const flushSpy = vi
      .spyOn(fakeRepository, "flushTextSaves")
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseFlush = resolve;
          }),
      );

    await act(async () => {
      view.editor().commands.insertContent(" A-edit");
    });
    clickSave();
    await waitFor(() => expect(releaseFlush).not.toBeNull());

    await act(async () => {
      view.editor().commands.insertContent(" B-edit");
    });
    capturePendingEditorChanges();

    await act(async () => {
      releaseFlush!();
    });
    flushSpy.mockRestore();

    // The acknowledged A revision does not wipe the newer B edits.
    await waitFor(
      () => {
        const draft = useDraftStore.getState().drafts["text:doc1"];
        expect(draft?.content).toContain("B-edit");
      },
      { timeout: 5000 },
    );
    expect(screen.getByText("Unsaved")).toBeDefined();
    // The submitted A revision WAS persisted.
    expect(fakeRepoState.texts.get("doc1")?.body.content).toContain("A-edit");

    // B remains recoverable on remount.
    view.unmount();
    const again = await renderEditor();
    expect(document.querySelector(".rich-doc")!.textContent).toContain("B-edit");
    again.unmount();
  });

  it("a failed Save whose body read throws keeps the stored body on remount (F03)", async () => {
    const view = await renderEditor();
    // The named `getBody()` failure: the save dies before any body was
    // recorded. Nothing newer is recoverable, and no draft exists yet.
    const getJsonSpy = vi
      .spyOn(view.editor(), "getJSON")
      .mockImplementationOnce(() => {
        throw new Error("serialize exploded");
      });
    clickSave();
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined(), {
      timeout: 5000,
    });
    getJsonSpy.mockRestore();

    // The error record claims no body; leaving now must not project one.
    view.unmount();
    const failed = useDraftStore.getState().drafts["text:doc1"];
    expect(failed?.errorOnly).toBe(true);

    // Remount: the STORED manuscript wins (never an empty replacement)
    // and the error is still reported.
    const again = await renderEditor();
    expect(document.querySelector(".rich-doc")!.textContent).toContain(
      "The Archive",
    );
    expect(document.querySelector(".rich-doc")!.textContent).toContain(
      "Old markdown body",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "serialize exploded",
    );
    again.unmount();
  });

  it("an intentionally emptied document still recovers as empty (F03)", async () => {
    const first = await renderEditor();
    await act(async () => {
      first.editor().commands.clearContent();
    });
    first.unmount();
    const draft = useDraftStore.getState().drafts["text:doc1"];
    expect(draft?.errorOnly).toBe(false);

    const second = await renderEditor();
    const manuscript = document.querySelector(".rich-doc")!.textContent ?? "";
    expect(manuscript.trim()).toBe("");
    expect(manuscript).not.toContain("The Archive");
    second.unmount();
  });

  it("an intentionally emptied brief still recovers as empty (F03)", async () => {
    useAppStore.setState({ view: { kind: "brief", id: "p-b" } });
    const first = render(<DocumentPane onOpenSettings={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /edit brief/i }));
    const box = screen.getByPlaceholderText(
      /Purpose, audience, planned texts/i,
    ) as HTMLTextAreaElement;
    expect(box.value).toBe("Beta's stored brief.");
    fireEvent.change(box, { target: { value: "" } });
    first.unmount();

    render(<DocumentPane onOpenSettings={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /edit brief/i }));
    expect(
      (
        screen.getByPlaceholderText(
          /Purpose, audience, planned texts/i,
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  it("switching project A → B leaks neither the brief body nor the details dialog", async () => {
    useAppStore.setState({ view: { kind: "project", id: "p-a" } });
    render(<DocumentPane onOpenSettings={() => {}} />);

    // Open A's details dialog with typed text.
    fireEvent.click(await screen.findByRole("button", { name: /edit details/i }));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Changed A title" },
    });

    // Switch to B (navigator route change).
    act(() => useAppStore.getState().setView({ kind: "project", id: "p-b" }));
    await screen.findByText("Project Beta");

    // No modal leak: the edit dialog is closed, and none of A's fields.
    expect(screen.queryByText("Edit project")).toBeNull();
    expect(screen.queryByDisplayValue("Changed A title")).toBeNull();
  });

  it("switching brief A → B leaks neither the brief body nor the draft", async () => {
    useAppStore.setState({ view: { kind: "brief", id: "p-a" } });
    render(<DocumentPane onOpenSettings={() => {}} />);

    // Start editing A's brief and leave uncommitted text behind.
    fireEvent.click(await screen.findByRole("button", { name: /write brief/i }));
    fireEvent.change(
      screen.getByPlaceholderText(/Purpose, audience, planned texts/i),
      { target: { value: "A-only brief text" } },
    );

    // Switch to B (navigator route change).
    act(() => useAppStore.getState().setView({ kind: "brief", id: "p-b" }));
    await screen.findByText("Project Beta");
    expect(screen.queryByDisplayValue("A-only brief text")).toBeNull();

    // B opens its OWN brief, not A's draft.
    fireEvent.click(await screen.findByRole("button", { name: /edit brief/i }));
    const briefBox = screen.getByPlaceholderText(
      /Purpose, audience, planned texts/i,
    ) as HTMLTextAreaElement;
    expect(briefBox.value).toBe("Beta's stored brief.");

    // Returning to A recovers A's own draft (per-project keys, not shared).
    act(() => useAppStore.getState().setView({ kind: "brief", id: "p-a" }));
    fireEvent.click(await screen.findByRole("button", { name: /write brief/i }));
    expect(
      (
        screen.getByPlaceholderText(
          /Purpose, audience, planned texts/i,
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("A-only brief text");
  });

  it("the overview's collapsed brief row opens the brief view", async () => {
    useAppStore.setState({ view: { kind: "project", id: "p-b" } });
    render(<DocumentPane onOpenSettings={() => {}} />);

    // The overview summarises the brief instead of rendering it.
    expect(await screen.findByText("3 words")).toBeDefined();

    fireEvent.click(screen.getByText("Brief"));
    fireEvent.click(await screen.findByRole("button", { name: /edit brief/i }));
    expect(
      (
        screen.getByPlaceholderText(
          /Purpose, audience, planned texts/i,
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Beta's stored brief.");
  });
});
