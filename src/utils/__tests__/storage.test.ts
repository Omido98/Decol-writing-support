import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import {
  readTextFile,
  writeTextFile,
  remove,
  mkdir,
} from "@tauri-apps/plugin-fs";
import {
  saveJson,
  loadJson,
  deleteFile,
  awaitStorageIdle,
  StorageError,
} from "@/utils/storage";

const readTextFileMock = readTextFile as Mock;
const writeTextFileMock = writeTextFile as Mock;
const removeMock = remove as Mock;
const mkdirMock = mkdir as Mock;

/** Pretend to run inside Tauri (tests default to the plain-node env). */
function useTauri() {
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  mkdirMock.mockResolvedValue(undefined);
  for (const key of Object.keys(storage)) delete storage[key];
});

afterEach(async () => {
  await awaitStorageIdle();
});

describe("saveJson (Tauri)", () => {
  it("writes JSON to the app data directory via the fs plugin", async () => {
    useTauri();
    writeTextFileMock.mockResolvedValue(undefined);
    await saveJson("threads.json", { applications: [] });
    expect(writeTextFileMock).toHaveBeenCalledWith(
      "threads.json",
      expect.stringContaining('"applications"'),
      { baseDir: 22 },
    );
    // First write of the session must create the app data directory.
    expect(mkdirMock).toHaveBeenCalledWith(".", {
      baseDir: 22,
      recursive: true,
    });
  });

  it("throws instead of silently falling back when the write fails", async () => {
    useTauri();
    writeTextFileMock.mockRejectedValue(new Error("disk full"));
    await expect(saveJson("threads.json", { a: 1 })).rejects.toThrow(
      StorageError,
    );
    expect(localStorage.getItem("dws:threads.json")).toBeNull();
  });
});

describe("saveJson (browser)", () => {
  it("writes to localStorage when no Tauri fs is available", async () => {
    await saveJson("threads.json", { applications: [1] });
    expect(localStorage.getItem("dws:threads.json")).toContain(
      '"applications": [',
    );
    expect(writeTextFileMock).not.toHaveBeenCalled();
  });
});

describe("loadJson (Tauri)", () => {
  it("parses JSON read from disk", async () => {
    useTauri();
    readTextFileMock.mockResolvedValue(JSON.stringify({ ok: true }));
    expect(await loadJson("config.json")).toEqual({ ok: true });
  });

  it("returns null when the file does not exist", async () => {
    useTauri();
    readTextFileMock.mockRejectedValue(
      new Error("fs: No such file or directory (os error 2)"),
    );
    expect(await loadJson("settings.json")).toBeNull();
  });

  it("throws for unparseable file content instead of returning null", async () => {
    useTauri();
    readTextFileMock.mockResolvedValue("{not json");
    await expect(loadJson("settings.json")).rejects.toThrow(StorageError);
  });

  it("throws for read failures that are not a missing file", async () => {
    useTauri();
    readTextFileMock.mockRejectedValue(new Error("permission denied"));
    await expect(loadJson("settings.json")).rejects.toThrow(StorageError);
  });

  it("does not touch legacy localStorage copies on a native miss", async () => {
    // Adoption is the verified bootstrap's job; a read must have no side
    // effects (the fallback copy survives untouched).
    useTauri();
    readTextFileMock.mockRejectedValue(
      new Error("fs: No such file or directory (os error 2)"),
    );
    localStorage.setItem("dws:config.json", JSON.stringify({ ok: true }));
    expect(await loadJson("config.json")).toBeNull();
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("dws:config.json")).toBe(
      JSON.stringify({ ok: true }),
    );
  });
});

describe("loadJson (browser)", () => {
  it("reads the localStorage copy when no Tauri fs is available", async () => {
    localStorage.setItem("dws:config.json", JSON.stringify({ ok: true }));
    expect(await loadJson("config.json")).toEqual({ ok: true });
  });

  it("throws for unparseable localStorage content", async () => {
    localStorage.setItem("dws:settings.json", "{not json");
    await expect(loadJson("settings.json")).rejects.toThrow(StorageError);
  });
});

describe("deleteFile (Tauri)", () => {
  it("removes the file via the fs plugin", async () => {
    useTauri();
    removeMock.mockResolvedValue(undefined);
    await deleteFile("chat_abc.json");
    expect(removeMock).toHaveBeenCalledWith("chat_abc.json", { baseDir: 22 });
  });

  it("treats an already-missing file as deleted", async () => {
    useTauri();
    removeMock.mockRejectedValue(
      new Error("fs: No such file or directory (os error 2)"),
    );
    await expect(deleteFile("chat_abc.json")).resolves.toBeUndefined();
  });

  it("throws when deletion fails for a real reason", async () => {
    useTauri();
    removeMock.mockRejectedValue(new Error("permission denied"));
    await expect(deleteFile("chat_abc.json")).rejects.toThrow(StorageError);
  });

  it("waits for a queued write to the same path before removing", async () => {
    useTauri();
    let resolveWrite: () => void = () => {};
    writeTextFileMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
      }),
    );
    removeMock.mockResolvedValue(undefined);

    const write = saveJson("chat_abc.json", { a: 1 });
    const del = deleteFile("chat_abc.json");
    // The delete must not run while the write is still in flight.
    expect(removeMock).not.toHaveBeenCalled();
    resolveWrite();
    await Promise.all([write, del]);
    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});
