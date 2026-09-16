// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));

vi.mock("@/utils/repository", () => ({
  repo: { search: searchMock },
}));

import CommandPalette from "@/components/workspace/CommandPalette";
import { useAppStore } from "@/stores/useAppStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useChatStore } from "@/stores/chatStore";
import type { SearchHit } from "@/utils/repository";

const originalToggleFocus = useAppStore.getState().toggleFocusMode;

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue([]);
  useLibraryStore.setState({ texts: [], textsLoaded: true });
  useProjectStore.setState({ projects: [], projectsLoaded: true });
  useChatStore.setState({ threads: [] });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ toggleFocusMode: originalToggleFocus });
});

const PALETTE = { name: "Command palette" } as const;
const SEARCH_LABEL = "Search commands and documents";

describe("CommandPalette (B20b)", () => {
  it("discards a slow earlier query's results when a newer query resolved first", async () => {
    let resolveSlow!: (hits: SearchHit[]) => void;
    const slow = new Promise<SearchHit[]>((resolve) => {
      resolveSlow = resolve;
    });
    searchMock.mockImplementation((q: string) =>
      q === "slow"
        ? slow
        : Promise.resolve([
            { kind: "text", docId: "doc-b", title: "Result B", excerpt: "" },
          ]),
    );

    render(<CommandPalette open onOpenChange={() => {}} />);
    const input = screen.getByLabelText(SEARCH_LABEL);

    // Query A is in flight (its debounce fired; the response is pending).
    fireEvent.change(input, { target: { value: "slow" } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Query B resolves while A is still pending.
    fireEvent.change(input, { target: { value: "fast" } });
    await screen.findByText("Result B");
    expect(searchMock).toHaveBeenCalledTimes(2);

    // A's late response must NOT replace B's results.
    resolveSlow([
      { kind: "text", docId: "doc-a", title: "Result A", excerpt: "" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Result A")).toBeNull();
    expect(screen.getByText("Result B")).toBeDefined();
  });

  it("clears stale full-text hits when the query changes (F10)", async () => {
    const openText = vi.fn();
    useAppStore.setState({ openText });
    searchMock.mockImplementation((q: string) => {
      if (q === "aardvark") {
        return Promise.resolve([
          {
            kind: "text",
            docId: "doc-a",
            title: "Aardvark manuscript",
            excerpt: "",
          },
        ] as SearchHit[]);
      }
      // Query B's search is deliberately never resolved during the test:
      // the stale-hit window is what is under test.
      return new Promise<SearchHit[]>(() => {});
    });

    render(<CommandPalette open onOpenChange={() => {}} />);
    const input = screen.getByLabelText(SEARCH_LABEL);

    fireEvent.change(input, { target: { value: "aardvark" } });
    await screen.findByText("Aardvark manuscript");

    // The query changes (to one that matches nothing else); the new
    // search is still inside its debounce window.
    fireEvent.change(input, { target: { value: "zzz" } });
    // The previous query's hit is cleared SYNCHRONOUSLY — it is never
    // displayed (or activatable) under the new query.
    expect(screen.queryByText("Aardvark manuscript")).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(openText).not.toHaveBeenCalled();
  });

  it("activates the focused result exactly once and closes", () => {
    const toggleFocus = vi.fn();
    useAppStore.setState({ toggleFocusMode: toggleFocus });
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} />);

    const input = screen.getByLabelText(SEARCH_LABEL);
    fireEvent.change(input, { target: { value: "Toggle focus" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(toggleFocus).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not activate on an IME-composing Enter", () => {
    const toggleFocus = vi.fn();
    useAppStore.setState({ toggleFocusMode: toggleFocus });
    render(<CommandPalette open onOpenChange={() => {}} />);

    const input = screen.getByLabelText(SEARCH_LABEL);
    fireEvent.change(input, { target: { value: "focus" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });

    expect(toggleFocus).not.toHaveBeenCalled();
  });

  it("keeps the active result in sync with keyboard navigation", () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    const input = screen.getByLabelText(SEARCH_LABEL);

    // Two action results: "New blank document", "New conversation", …
    fireEvent.change(input, { target: { value: "new" } });
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const afterDown = screen.getAllByRole("option");
    expect(afterDown[0].getAttribute("aria-selected")).toBe("false");
    expect(afterDown[1].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(
      screen.getAllByRole("option")[0].getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keeps content behind the palette inert and returns Tab focus through the guards", async () => {
    render(
      <div>
        <button type="button">Behind one</button>
        <button type="button">Behind two</button>
        <CommandPalette open onOpenChange={() => {}} />
      </div>,
    );

    const input = screen.getByLabelText(SEARCH_LABEL);
    await waitFor(() => expect(document.activeElement).toBe(input));
    const dialog = screen.getByRole("dialog", PALETTE);

    // The modal marks everything behind it inert + aria-hidden — a real
    // browser's tab order skips it entirely. (The buttons are not even in
    // the accessibility tree anymore, hence the text lookup.)
    const behind = screen.getByText("Behind one").closest("button")!;
    expect(behind).not.toBeNull();
    expect(behind.closest("[data-base-ui-inert]")).not.toBeNull();
    expect(behind.closest("[aria-hidden='true']")).not.toBeNull();

    // The focus guards that fence the dialog pull focus back inside.
    const guards = Array.from(
      document.querySelectorAll("[data-base-ui-focus-guard]"),
    ) as HTMLElement[];
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) {
      guard.focus();
      await waitFor(() =>
        expect(dialog.contains(document.activeElement)).toBe(true),
      );
    }
  });

  it("closes on Escape and restores focus to the opener", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open palette
          </button>
          <CommandPalette open={open} onOpenChange={setOpen} />
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);

    const opener = screen.getByRole("button", { name: "Open palette" });
    // Focus the opener explicitly first (jsdom's synthetic click does not
    // reliably focus buttons): the dialog's return-focus target.
    opener.focus();
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", PALETTE);
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", PALETTE)).toBeNull(),
    );
    // Restoration may need a frame after the popup unmounts.
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
