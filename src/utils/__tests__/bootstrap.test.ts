import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

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

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  remove: vi.fn(),
  mkdir: vi.fn(),
  BaseDirectory: { AppData: 22 },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { readTextFile, writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { bootstrapStorage, resetBootstrap, resolveConflict } from "@/utils/bootstrap";

const readTextFileMock = readTextFile as Mock;
const writeTextFileMock = writeTextFile as Mock;
const mkdirMock = mkdir as Mock;
const invokeMock = invoke as Mock;

const MISSING = new Error("fs: No such file or directory (os error 2)");

beforeEach(() => {
  vi.clearAllMocks();
  resetBootstrap();
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  mkdirMock.mockResolvedValue(undefined);
  writeTextFileMock.mockResolvedValue(undefined);
  invokeMock.mockReset();
  // Native files are missing unless a test says otherwise.
  readTextFileMock.mockRejectedValue(MISSING);
  for (const key of Object.keys(storage)) delete storage[key];
});

describe("bootstrap (dws:* reconciliation)", () => {
  it("adopts a browser copy when the native file is missing", async () => {
    localStorage.setItem("dws:config.json", JSON.stringify({ ok: true }));
    const result = await bootstrapStorage();
    expect(result.adopted).toBe(1);
    expect(result.issues).toHaveLength(0);
    // The copy is removed only after the native write succeeded.
    expect(writeTextFileMock).toHaveBeenCalledWith(
      "config.json",
      expect.stringContaining('"ok"'),
      { baseDir: 22 },
    );
    expect(localStorage.getItem("dws:config.json")).toBeNull();
  });

  it("keeps the dws: copy when the adoption write fails (permission)", async () => {
    localStorage.setItem("dws:config.json", JSON.stringify({ ok: true }));
    writeTextFileMock.mockRejectedValue(new Error("permission denied"));
    const result = await bootstrapStorage();
    // Not fatal: the migration can still proceed; the copy stays for retry.
    expect(result.adopted).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].kind).toBe("adopt-failed");
    expect(localStorage.getItem("dws:config.json")).toBe(
      JSON.stringify({ ok: true }),
    );
  });

  it("keeps and reports a malformed dws: copy instead of deleting it", async () => {
    localStorage.setItem("dws:threads.json", "{not valid json");
    const result = await bootstrapStorage();
    expect(result.adopted).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].kind).toBe("malformed");
    expect(result.issues[0].path).toBe("threads.json");
    expect(localStorage.getItem("dws:threads.json")).toBe("{not valid json");
  });

  it("preserves conflicting copies and reports them without choosing a winner", async () => {
    const native = [{ id: "a", title: "Native version" }];
    const browser = [{ id: "a", title: "Browser version" }];
    localStorage.setItem("dws:threads.json", JSON.stringify(browser));
    readTextFileMock.mockResolvedValue(JSON.stringify(native));

    const result = await bootstrapStorage();
    expect(result.adopted).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].kind).toBe("conflict");
    // Neither side was overwritten or deleted.
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("dws:threads.json")).toContain(
      "Browser version",
    );
  });

  it("drops a dws: copy that is identical to the native file", async () => {
    const same = [{ id: "a", title: "Same" }];
    localStorage.setItem("dws:threads.json", JSON.stringify(same));
    readTextFileMock.mockResolvedValue(JSON.stringify(same));
    const result = await bootstrapStorage();
    expect(result.adopted).toBe(1);
    expect(result.issues).toHaveLength(0);
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("dws:threads.json")).toBeNull();
  });

  it("keeps a dws:sources.json copy instead of adopting an orphan native file (F05)", async () => {
    // The Rust legacy importer never reads sources.json: adopting it would
    // write a native file the app does not read AND delete the only copy.
    localStorage.setItem(
      "dws:sources.json",
      JSON.stringify([{ id: "s1", title: "A source" }]),
    );
    const result = await bootstrapStorage();
    expect(result.adopted).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].kind).toBe("unimportable");
    expect(result.issues[0].path).toBe("sources.json");
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("dws:sources.json")).not.toBeNull();
  });

  it("reports a sources.json native/browser conflict without offering deletion (F05)", async () => {
    localStorage.setItem(
      "dws:sources.json",
      JSON.stringify([{ id: "s1", title: "Browser source" }]),
    );
    readTextFileMock.mockResolvedValue(
      JSON.stringify([{ id: "s1", title: "Native source" }]),
    );
    const result = await bootstrapStorage();
    expect(result.issues[0].kind).toBe("unimportable");
    expect(localStorage.getItem("dws:sources.json")).not.toBeNull();

    // Resolution refuses both directions: the copy is unconsumable, so
    // deleting it would silently drop the chosen version.
    invokeMock.mockResolvedValue({
      completed: true,
      alreadyOpen: false,
      counts: { texts: 0, projects: 0, threads: 0, messages: 0, versions: 0 },
      issues: [],
      archivedDir: null,
    });
    const callsBefore = invokeMock.mock.calls.length;
    expect(await resolveConflict("sources.json", "browser")).toBe(false);
    expect(await resolveConflict("sources.json", "native")).toBe(false);
    // No import was attempted.
    expect(invokeMock.mock.calls.length).toBe(callsBefore);
    expect(localStorage.getItem("dws:sources.json")).toContain(
      "Browser source",
    );
  });

  it("still adopts a dws: copy for a path the importer consumes", async () => {
    localStorage.setItem(
      "dws:text_doc1.json",
      JSON.stringify({ content: "body" }),
    );
    const result = await bootstrapStorage();
    expect(result.adopted).toBe(1);
    expect(result.issues).toHaveLength(0);
    expect(writeTextFileMock).toHaveBeenCalledWith(
      "text_doc1.json",
      expect.stringContaining("body"),
      { baseDir: 22 },
    );
    expect(localStorage.getItem("dws:text_doc1.json")).toBeNull();
  });

  it("surfaces an incomplete migration report", async () => {
    invokeMock.mockResolvedValue({
      completed: false,
      alreadyOpen: false,
      counts: { texts: 0, projects: 0, threads: 0, messages: 0, versions: 0 },
      issues: [
        {
          path: "library.json",
          kind: "malformed",
          detail: "expected ident",
        },
      ],
      archivedDir: null,
    });
    const result = await bootstrapStorage();
    expect(result.migration?.completed).toBe(false);
    expect(result.migration?.issues[0].path).toBe("library.json");
  });
});

describe("bootstrap (retry)", () => {
  it("supports retry after a failed bootstrap", async () => {
    invokeMock.mockRejectedValueOnce(new Error("db locked"));
    await expect(bootstrapStorage()).rejects.toThrow("db locked");
    // The second attempt runs the bootstrap again (the failed promise is
    // not cached).
    invokeMock.mockResolvedValue({
      completed: true,
      alreadyOpen: false,
      counts: { texts: 2, projects: 1, threads: 3, messages: 7, versions: 4 },
      issues: [],
      archivedDir: "legacy/123-0",
    });
    const result = await bootstrapStorage();
    expect(result.migration?.completed).toBe(true);
    expect(result.migration?.counts.threads).toBe(3);
  });
});

describe("conflict resolution (D5/B08)", () => {
  const browserLibrary = [
    { id: "browser-doc", title: "Browser text", textType: "essay" },
  ];

  beforeEach(() => {
    // A native file exists and DIFFERS from the browser copy (a conflict).
    readTextFileMock.mockImplementation(async (path: string) => {
      if (path === "library.json") {
        return JSON.stringify([{ id: "native-doc", title: "Native text" }]);
      }
      throw MISSING;
    });
    localStorage.setItem("dws:library.json", JSON.stringify(browserLibrary));
    localStorage.setItem(
      "dws:text_browser-doc.json",
      JSON.stringify({ content: "browser body" }),
    );
    invokeMock.mockResolvedValue({
      completed: true,
      alreadyOpen: false,
      counts: { texts: 1, projects: 0, threads: 0, messages: 0, versions: 0 },
      issues: [],
      archivedDir: null,
    });
  });

  it("keeping the native file deletes only the browser copy", async () => {
    const ok = await resolveConflict("library.json", "native");
    expect(ok).toBe(true);
    expect(localStorage.getItem("dws:library.json")).toBeNull();
    // The active repository was never touched.
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("using the browser copy imports it into the ACTIVE repository, then removes the copy", async () => {
    const ok = await resolveConflict("library.json", "browser");
    expect(ok).toBe(true);
    // The chosen copy goes through the validated legacy import (verified
    // before commit) — never over the obsolete JSON file.
    expect(invokeMock).toHaveBeenCalledWith("db_import_legacy_at", {
      dir: expect.stringContaining("conflict-import-"),
      clear: false,
    });
    // The related entity file travelled with it, so the browser version is
    // applied completely.
    expect(writeTextFileMock).toHaveBeenCalledWith(
      expect.stringContaining("text_browser-doc.json"),
      expect.stringContaining("browser body"),
      { baseDir: 22 },
    );
    // The recovery copies are removed only after the import verified.
    expect(localStorage.getItem("dws:library.json")).toBeNull();
    expect(localStorage.getItem("dws:text_browser-doc.json")).toBeNull();
  });

  it("a failed import keeps the browser copy (recovery discipline)", async () => {
    invokeMock.mockResolvedValue({
      completed: false,
      alreadyOpen: false,
      counts: { texts: 0, projects: 0, threads: 0, messages: 0, versions: 0 },
      issues: [{ path: "library.json", kind: "malformed", detail: "broken" }],
      archivedDir: null,
    });
    const ok = await resolveConflict("library.json", "browser");
    expect(ok).toBe(false);
    expect(localStorage.getItem("dws:library.json")).not.toBeNull();
  });

  it("a settings conflict becomes a live preference", async () => {
    localStorage.setItem(
      "dws:settings.json",
      JSON.stringify({ theme: "light", accent: "#ffffff" }),
    );
    const ok = await resolveConflict("settings.json", "browser");
    expect(ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("db_prefs_set", {
      key: "settings",
      value: expect.stringContaining("light"),
    });
    expect(localStorage.getItem("dws:settings.json")).toBeNull();
  });

  it("nothing to resolve returns false and keeps everything in place", async () => {
    expect(await resolveConflict("missing.json", "native")).toBe(false);
    localStorage.setItem("dws:bad.json", "{not json");
    expect(await resolveConflict("bad.json", "browser")).toBe(false);
    expect(localStorage.getItem("dws:bad.json")).not.toBeNull();
  });
});
