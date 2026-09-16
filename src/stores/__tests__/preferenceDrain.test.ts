import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  discardPreference,
  flushPreferences,
  pendingPreferenceWrites,
  preferenceFailures,
  setPref,
} from "@/utils/preferences";
import { useDraftStore, flushDrafts } from "@/stores/draftStore";

const invokeMock = invoke as Mock;

beforeEach(() => {
  invokeMock.mockReset();
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  useDraftStore.setState({ drafts: {}, hydrated: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("acknowledged preference drains (B06)", () => {
  it("a delayed preference write blocks flushPreferences until acknowledged", async () => {
    let release: () => void = () => {};
    invokeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );

    const write = setPref("settings", { theme: "dark" });
    expect(pendingPreferenceWrites()).toBe(1);

    let flushed = false;
    const flush = flushPreferences().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    // Not acknowledged yet: the drain must still be waiting.
    expect(flushed).toBe(false);

    release();
    await write;
    await flush;
    expect(flushed).toBe(true);
    expect(pendingPreferenceWrites()).toBe(0);
  });

  it("a rejected write is retained and recoverable; a later flush retries it", async () => {
    const written = new Map<string, string>();
    let fail = true;
    invokeMock.mockImplementation(
      async (_cmd: string, args: Record<string, unknown>) => {
        if (fail) throw new Error("disk gone");
        written.set(String(args.key), String(args.value));
        return null;
      },
    );

    await expect(
      setPref("recovery-drafts", { "text:a": { content: "kept" } }),
    ).rejects.toThrow("disk gone");
    // Payload retained, drain fails visibly instead of reporting success.
    expect(pendingPreferenceWrites()).toBe(1);
    expect(preferenceFailures()).toHaveLength(1);
    await expect(flushPreferences()).rejects.toThrow(/could not be saved/i);

    // Transport recovers: the retained payload drains unchanged.
    fail = false;
    await flushPreferences();
    expect(pendingPreferenceWrites()).toBe(0);
    expect(JSON.parse(written.get("recovery-drafts")!)).toEqual({
      "text:a": { content: "kept" },
    });
  });

  it("flushDrafts waits for a draft write whose debounce already fired", async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    const written = new Map<string, string>();
    invokeMock.mockImplementation(
      (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "db_prefs_set") {
          return new Promise<void>((resolve) => {
            release = () => {
              written.set(String(args.key), String(args.value));
              resolve();
            };
          });
        }
        return Promise.resolve(null);
      },
    );

    useDraftStore.getState().setDraft("text:a", "text", "a", {
      content: "half-typed manuscript",
    });
    // The debounce has ALREADY fired; the write is in flight.
    await vi.advanceTimersByTimeAsync(300);
    expect(release).not.toBeNull();

    let flushed = false;
    const flush = flushDrafts().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    release!();
    await flush;
    expect(flushed).toBe(true);
    expect(written.get("recovery-drafts")).toContain("half-typed manuscript");
  });

  it("explicit discard drops a retained preference payload", async () => {
    invokeMock.mockRejectedValue(new Error("keychain locked"));
    await setPref("settings", { theme: "light" }).catch(() => {});
    expect(preferenceFailures()).toHaveLength(1);
    discardPreference("settings");
    expect(pendingPreferenceWrites()).toBe(0);
    // A drain after the explicit discard is clean.
    await flushPreferences();
  });
});
