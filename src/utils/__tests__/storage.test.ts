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
  BaseDirectory: { AppData: 22 },
}));

import { readTextFile, writeTextFile, remove } from "@tauri-apps/plugin-fs";
import { saveJson, loadJson, deleteFile } from "@/utils/storage";

const readTextFileMock = readTextFile as Mock;
const writeTextFileMock = writeTextFile as Mock;
const removeMock = remove as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(storage)) delete storage[key];
});

describe("saveJson", () => {
  it("writes JSON to the app data directory via the fs plugin", async () => {
    writeTextFileMock.mockResolvedValue(undefined);
    await saveJson("threads.json", { applications: [] });
    expect(writeTextFileMock).toHaveBeenCalledWith(
      "threads.json",
      expect.stringContaining('"applications"'),
      { baseDir: 22 },
    );
  });

  it("falls back to localStorage when the fs plugin fails", async () => {
    writeTextFileMock.mockRejectedValue(new Error("not in tauri"));
    await saveJson("threads.json", { applications: [1] });
    expect(localStorage.getItem("dws:threads.json")).toContain(
      '"applications": [',
    );
  });
});

describe("loadJson", () => {
  it("parses JSON read from disk", async () => {
    readTextFileMock.mockResolvedValue(JSON.stringify({ ok: true }));
    expect(await loadJson("config.json")).toEqual({ ok: true });
  });

  it("falls back to localStorage when the file read fails", async () => {
    readTextFileMock.mockRejectedValue(new Error("missing"));
    localStorage.setItem("dws:config.json", JSON.stringify({ ok: true }));
    expect(await loadJson("config.json")).toEqual({ ok: true });
  });

  it("returns null when nothing is available", async () => {
    readTextFileMock.mockRejectedValue(new Error("missing"));
    expect(await loadJson("settings.json")).toBeNull();
  });

  it("returns null for unparseable localStorage content", async () => {
    readTextFileMock.mockRejectedValue(new Error("missing"));
    localStorage.setItem("dws:settings.json", "{not json");
    expect(await loadJson("settings.json")).toBeNull();
  });
});

describe("deleteFile", () => {
  it("removes the file via the fs plugin", async () => {
    removeMock.mockResolvedValue(undefined);
    await deleteFile("chat_abc.json");
    expect(removeMock).toHaveBeenCalledWith("chat_abc.json", { baseDir: 22 });
  });

  it("falls back to localStorage when removal fails", async () => {
    removeMock.mockRejectedValue(new Error("not in tauri"));
    localStorage.setItem("dws:chat_abc.json", "[]");
    await deleteFile("chat_abc.json");
    expect(localStorage.getItem("dws:chat_abc.json")).toBeNull();
  });
});
