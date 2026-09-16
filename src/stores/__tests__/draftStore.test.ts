import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { useDraftStore, flushDrafts } from "@/stores/draftStore";

beforeEach(() => {
  // The global setup fakes the Tauri environment; these tests exercise
  // the browser (localStorage) preference path.
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  for (const key of Object.keys(storage)) delete storage[key];
  useDraftStore.setState({ drafts: {}, hydrated: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("draft sessions", () => {
  it("retains the draft across tab switches (component remounts)", () => {
    // The draft lives in the store, not in component state: a remounted
    // editor with the same key reads the same session.
    useDraftStore.getState().setDraft("text:abc", "text", "abc", {
      content: "half-typed manuscript",
      meta: { title: "My essay" },
    });
    // …the component unmounts and remounts…
    const draft = useDraftStore.getState().getDraft("text:abc");
    expect(draft?.content).toBe("half-typed manuscript");
    expect(draft?.meta?.title).toBe("My essay");
  });

  it("typing after an acknowledged save marks the draft unacknowledged", () => {
    useDraftStore.getState().setDraft("text:abc", "text", "abc", {
      content: "v1",
    });
    useDraftStore.getState().markSaved("text:abc");
    expect(useDraftStore.getState().getDraft("text:abc")?.savedAt).not.toBeNull();
    useDraftStore.getState().setDraft("text:abc", "text", "abc", {
      content: "v2",
    });
    const draft = useDraftStore.getState().getDraft("text:abc")!;
    expect(draft.content).toBe("v2");
    expect(draft.savedAt).toBeNull();
  });

  it("save errors retain the editable content for retry or explicit discard", () => {
    useDraftStore.getState().setDraft("text:abc", "text", "abc", {
      content: "the important draft",
    });
    useDraftStore.getState().markError("text:abc", "Save failed: disk gone");
    const draft = useDraftStore.getState().getDraft("text:abc")!;
    expect(draft.error).toContain("disk gone");
    expect(draft.content).toBe("the important draft");
    // Explicit user choice to discard is the only way it disappears.
    useDraftStore.getState().clearDraft("text:abc");
    expect(useDraftStore.getState().getDraft("text:abc")).toBeNull();
  });

  it("a restart restores the last typed recovery draft", async () => {
    vi.useFakeTimers();
    useDraftStore.getState().setDraft("project-brief:p1", "project-brief", "p1", {
      content: "Brief draft before the crash",
    });
    // The debounced persistence lands (or an explicit flush forces it).
    await flushDrafts();
    // "Restart": fresh store state, hydrated from the preference.
    useDraftStore.setState({ drafts: {}, hydrated: false });
    await useDraftStore.getState().hydrate();
    const draft = useDraftStore.getState().getDraft("project-brief:p1");
    expect(draft?.content).toBe("Brief draft before the crash");
  });

  it("the debounced persistence lands on its own (restart-safe)", async () => {
    vi.useFakeTimers();
    useDraftStore.getState().setDraft("text:abc", "text", "abc", {
      content: "typed",
    });
    await vi.advanceTimersByTimeAsync(300);
    // "Restart"
    useDraftStore.setState({ drafts: {}, hydrated: false });
    await useDraftStore.getState().hydrate();
    expect(useDraftStore.getState().getDraft("text:abc")?.content).toBe("typed");
  });

  it("an unreadable recovery-draft store starts clean instead of failing", async () => {
    storage["dws:pref:recovery-drafts"] = "{corrupt";
    await expect(useDraftStore.getState().hydrate()).resolves.toBeUndefined();
    expect(useDraftStore.getState().hydrated).toBe(true);
    expect(useDraftStore.getState().drafts).toEqual({});
  });
});

describe("shutdown drain (drafts)", () => {
  it("closing during the debounce window flushes the draft", async () => {
    vi.useFakeTimers();
    useDraftStore.getState().setDraft("text:abc", "text", "abc", {
      content: "not yet persisted",
    });
    // The close drain runs before the 300ms debounce fires.
    await flushDrafts();
    useDraftStore.setState({ drafts: {}, hydrated: false });
    await useDraftStore.getState().hydrate();
    expect(useDraftStore.getState().getDraft("text:abc")?.content).toBe(
      "not yet persisted",
    );
  });
});
