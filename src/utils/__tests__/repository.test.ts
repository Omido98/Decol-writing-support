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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  repo,
  isSqliteRepository,
  setTransportInterceptor,
} from "@/utils/repository";
import { markdownDocument } from "@/utils/documentCodec";
import type { LibraryTextMeta, SourceMeta, ThreadMeta } from "@/types";
import fixtures from "@/test/repository-contract.json";

const invokeMock = invoke as Mock;

/** A markdown test body (the legacy-shaped document format). */
const md = (s: string) => markdownDocument(s);

const meta: LibraryTextMeta = {
  id: "t1",
  title: "T",
  textType: "essay",
  createdAt: "c",
  updatedAt: "u",
};

const threadMeta: ThreadMeta = {
  id: "t1",
  title: "Thread",
  mode: "text",
  createdAt: "c",
  updatedAt: "u",
};

/** A stored chat message for append/replace tests. */
const storedMsg = (id: string, content: string) => ({
  id,
  role: "user" as const,
  content,
  timestamp: "t",
  failed: false,
  incomplete: null,
  attachmentsJson: null,
});

beforeEach(() => {
  invokeMock.mockReset();
  setTransportInterceptor(null);
  for (const key of Object.keys(storage)) delete storage[key];
});

afterEach(() => {
  setTransportInterceptor(null);
});

/** The revision cache and failure registry are module-level: reset per test. */
function freshRepoState(): void {
  repo.resetSessionState();
}

describe("repository (JSON backend)", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    freshRepoState();
    expect(isSqliteRepository()).toBe(false);
  });

  it("textCreate writes the body and the registry", async () => {
    await repo.textCreate(meta, md("hello"));
    const stored = JSON.parse(storage["dws:text_t1.json"]);
    expect(stored.content).toBe("hello");
    expect(stored.contentFormat).toBe("markdown");
    expect(stored.contentSchemaVersion).toBe(1);
    expect(JSON.parse(storage["dws:library.json"])).toHaveLength(1);
  });

  it("a successful Save is contained when reopening immediately", async () => {
    await repo.textCreate(meta, md("v1"));
    await repo.textSave("t1", {
      meta: { ...meta, wordCount: 2, updatedAt: "u1" },
      content: md("v2"),
    });
    expect((await repo.textContent("t1"))?.content).toBe("v2");
    const registry = JSON.parse(storage["dws:library.json"]);
    expect(registry[0].wordCount).toBe(2);
  });

  it("a mid-write failure leaves the complete old state (B21b)", async () => {
    await repo.textCreate(meta, md("v1"));
    await repo.textSave("t1", {
      meta: { ...meta, wordCount: 2, updatedAt: "u1" },
      content: md("v2"),
    });

    // Fail the BODY write once — a middle file of the save batch, after
    // the versions write already happened. The rollback writes succeed.
    const setItem = localStorage.setItem.bind(localStorage);
    let bodyFailed = false;
    const setItemSpy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation((key: string, value: string) => {
        if (key === "dws:text_t1.json" && !bodyFailed) {
          bodyFailed = true;
          throw new Error("disk full");
        }
        setItem(key, value);
      });
    await expect(
      repo.textSave("t1", {
        meta: { ...meta, wordCount: 3, updatedAt: "u2" },
        content: md("v3"),
      }),
    ).rejects.toThrow("disk full");
    setItemSpy.mockRestore();

    // The whole v3 batch rolled back — body AND metadata are v2.
    repo.resetSessionState();
    expect((await repo.textContent("t1"))?.content).toBe("v2");
    expect(JSON.parse(storage["dws:library.json"])[0].wordCount).toBe(2);
    expect(storage["dws:commit-journal.json"]).toBeUndefined();

    // The complete old state is usable: the next save succeeds.
    await repo.textSave("t1", {
      meta: { ...meta, wordCount: 4, updatedAt: "u3" },
      content: md("v4"),
    });
    expect((await repo.textContent("t1"))?.content).toBe("v4");
  });

  it("replays a leftover commit journal instead of exposing a mixed state (B21b)", async () => {
    await repo.textCreate(meta, md("v1"));
    // Simulate a crash after the journal and body landed but before the
    // registry write.
    storage["dws:text_t1.json"] = JSON.stringify(md("v2"));
    storage["dws:commit-journal.json"] = JSON.stringify({
      files: [
        { path: "text_t1.json", data: md("v2") },
        {
          path: "library.json",
          data: [{ ...meta, wordCount: 9, updatedAt: "u2" }],
        },
      ],
    });
    repo.resetSessionState();

    // The FIRST read replays the journal: the list itself must return the
    // NEW generation, not the stale registry row (F02).
    const listed = await repo.textsList();
    expect(listed[0].wordCount).toBe(9);
    expect(listed[0].updatedAt).toBe("u2");
    expect((await repo.textContent("t1"))?.content).toBe("v2");
    expect(JSON.parse(storage["dws:library.json"])[0].wordCount).toBe(9);
    expect(storage["dws:commit-journal.json"]).toBeUndefined();
  });

  it("every registry and payload read replays a leftover journal first (F02)", async () => {
    await repo.threadCreate(threadMeta);
    await repo.threadSave("t1", {
      meta: threadMeta,
      briefJson: null,
      messages: [storedMsg("m1", "old message")],
    });
    const sourceMeta = {
      id: "s1",
      title: "Old source",
      originalText: "Old source",
      contentHash: "h",
      extractionStatus: "ready" as const,
      includedInContext: true,
      verification: "unverified" as const,
      createdAt: "c",
      updatedAt: "u",
    };
    await repo.sourceCreate(sourceMeta, [
      { id: "pg1", locator: "¶ 1", content: "old passage" },
    ]);

    // Simulate a crash after the payload files landed but before the
    // registries: the old readers listed the stale registry rows.
    storage["dws:chat_t1.json"] = JSON.stringify({
      messages: [storedMsg("m1", "new message")],
      brief: null,
    });
    storage["dws:source_s1.json"] = JSON.stringify([
      { id: "pg2", locator: "¶ 2", content: "new passage" },
    ]);
    storage["dws:commit-journal.json"] = JSON.stringify({
      files: [
        {
          path: "threads.json",
          data: [{ ...threadMeta, title: "New thread", updatedAt: "u2" }],
        },
        {
          path: "sources.json",
          data: [{ ...sourceMeta, title: "New source", updatedAt: "u2" }],
        },
      ],
    });
    repo.resetSessionState();

    expect((await repo.threadsList())[0].title).toBe("New thread");
    const thread = await repo.threadGet("t1");
    expect(thread!.messages[0].content).toBe("new message");
    expect((await repo.sourcesList())[0].title).toBe("New source");
    const source = await repo.sourceGet("s1");
    expect(source!.source.title).toBe("New source");
    expect(source!.passages[0].content).toBe("new passage");
    expect(storage["dws:commit-journal.json"]).toBeUndefined();
  });

  it("a mid-write failure rolls back projects, threads, and sources completely (B21b-2)", async () => {
    // Old generations for one entity of each type.
    await repo.projectCreate({ id: "p1", title: "P", createdAt: "c", updatedAt: "u" });
    await repo.projectSave("p1", {
      meta: { id: "p1", title: "P", createdAt: "c", updatedAt: "u1" },
      brief: "old brief",
    });
    await repo.threadCreate(threadMeta);
    await repo.threadSave("t1", {
      meta: threadMeta,
      briefJson: null,
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "old message",
          timestamp: "t",
          failed: false,
          incomplete: null,
          attachmentsJson: null,
        },
      ],
    });
    const sourceMeta = {
      id: "s1",
      title: "Old source",
      originalText: "Old source",
      contentHash: "h",
      extractionStatus: "ready" as const,
      includedInContext: true,
      verification: "unverified" as const,
      createdAt: "c",
      updatedAt: "u",
    };
    await repo.sourceCreate(sourceMeta, [
      { id: "pg1", locator: "¶ 1", content: "old passage" },
    ]);

    // The registry write of each save fails ONCE; rollbacks succeed.
    const failOnce = new Set<string>();
    const spy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation((key: string, value: string) => {
        if (failOnce.has(key)) {
          failOnce.delete(key);
          throw new Error("disk full");
        }
        storage[key] = String(value);
      });

    failOnce.add("dws:projects.json");
    await expect(
      repo.projectSave("p1", {
        meta: { id: "p1", title: "P2", createdAt: "c", updatedAt: "u2" },
        brief: "new brief",
      }),
    ).rejects.toThrow("disk full");

    failOnce.add("dws:threads.json");
    await expect(
      repo.threadSave("t1", {
        meta: { ...threadMeta, title: "T2" },
        briefJson: null,
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "new message",
            timestamp: "t2",
            failed: false,
            incomplete: null,
            attachmentsJson: null,
          },
        ],
      }),
    ).rejects.toThrow("disk full");

    failOnce.add("dws:sources.json");
    await expect(
      repo.sourceSave(
        "s1",
        { ...sourceMeta, title: "New source", updatedAt: "u2" },
        [{ id: "pg1", locator: "¶ 1", content: "new passage" }],
      ),
    ).rejects.toThrow("disk full");
    spy.mockRestore();

    repo.resetSessionState();
    // Every entity kept its complete OLD generation (payload AND metadata).
    expect(await repo.projectBrief("p1")).toBe("old brief");
    expect(JSON.parse(storage["dws:projects.json"])[0].title).toBe("P");
    expect((await repo.threadGet("t1"))!.messages[0].content).toBe(
      "old message",
    );
    expect(JSON.parse(storage["dws:threads.json"])[0].title).toBe("Thread");
    const source = await repo.sourceGet("s1");
    expect(source!.source.title).toBe("Old source");
    expect(source!.passages[0].content).toBe("old passage");
    expect(storage["dws:commit-journal.json"]).toBeUndefined();
  });

  it("a mid-write failure during deletes leaves the complete old generation (F06)", async () => {
    await repo.textCreate(meta, md("v1"));
    await repo.textSave("t1", {
      meta: { ...meta, updatedAt: "u1" },
      content: md("v2"),
    });
    await repo.threadCreate(threadMeta);
    await repo.threadAppendMessage("t1", storedMsg("m1", "hello"), "u1");
    const sourceMeta = {
      id: "s1",
      title: "Source",
      originalText: "Source",
      contentHash: "h-f06",
      extractionStatus: "ready" as const,
      includedInContext: true,
      verification: "unverified" as const,
      createdAt: "c",
      updatedAt: "u",
    };
    await repo.sourceCreate(sourceMeta, [
      { id: "pg1", locator: "¶ 1", content: "passage" },
    ]);

    const failOnce = new Set<string>();
    const spy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation((key: string, value: string) => {
        if (failOnce.has(key)) {
          failOnce.delete(key);
          throw new Error("disk full");
        }
        storage[key] = String(value);
      });
    const revisions = () =>
      JSON.parse(storage["dws:revisions.json"] ?? "{}") as Record<string, number>;

    // Each delete write fails after the registry was already written: the
    // whole removal batch must roll back (registry, payload, revision).
    failOnce.add("dws:revisions.json");
    await expect(repo.textDelete("t1")).rejects.toThrow("disk full");
    expect(
      JSON.parse(storage["dws:library.json"]).some(
        (t: { id: string }) => t.id === "t1",
      ),
    ).toBe(true);
    expect(storage["dws:text_t1.json"]).toContain("v2");
    expect(revisions()["text:t1"]).toBe(1);
    expect(storage["dws:commit-journal.json"]).toBeUndefined();

    failOnce.add("dws:revisions.json");
    await expect(repo.threadDelete("t1")).rejects.toThrow("disk full");
    expect(
      JSON.parse(storage["dws:threads.json"]).some(
        (t: { id: string }) => t.id === "t1",
      ),
    ).toBe(true);
    expect(JSON.parse(storage["dws:chat_t1.json"]).messages[0].content).toBe(
      "hello",
    );
    expect(revisions()["thread:t1"]).toBe(1);
    expect(storage["dws:commit-journal.json"]).toBeUndefined();

    failOnce.add("dws:revisions.json");
    await expect(repo.sourceDelete("s1")).rejects.toThrow("disk full");
    expect(
      JSON.parse(storage["dws:sources.json"]).some(
        (s: { id: string }) => s.id === "s1",
      ),
    ).toBe(true);
    expect(JSON.parse(storage["dws:source_s1.json"])[0].content).toBe(
      "passage",
    );
    expect(revisions()["source:s1"]).toBe(0);
    expect(storage["dws:commit-journal.json"]).toBeUndefined();
    spy.mockRestore();
  });

  it("a mid-write failure during creates leaves no partial entity (F06)", async () => {
    const failOnce = new Set<string>();
    const spy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation((key: string, value: string) => {
        if (failOnce.has(key)) {
          failOnce.delete(key);
          throw new Error("disk full");
        }
        storage[key] = String(value);
      });
    const revisions = () =>
      JSON.parse(storage["dws:revisions.json"] ?? "{}") as Record<string, number>;

    failOnce.add("dws:revisions.json");
    await expect(repo.textCreate(meta, md("v1"))).rejects.toThrow("disk full");
    expect(storage["dws:text_t1.json"]).toBeUndefined();
    expect(JSON.parse(storage["dws:library.json"] ?? "[]")).toHaveLength(0);
    expect(revisions()["text:t1"]).toBeUndefined();
    expect(storage["dws:commit-journal.json"]).toBeUndefined();

    failOnce.add("dws:revisions.json");
    await expect(
      repo.projectCreate({ id: "p1", title: "P", createdAt: "c", updatedAt: "u" }),
    ).rejects.toThrow("disk full");
    expect(JSON.parse(storage["dws:projects.json"] ?? "[]")).toHaveLength(0);
    expect(revisions()["project:p1"]).toBeUndefined();

    failOnce.add("dws:revisions.json");
    await expect(repo.threadCreate(threadMeta)).rejects.toThrow("disk full");
    expect(JSON.parse(storage["dws:threads.json"] ?? "[]")).toHaveLength(0);
    expect(revisions()["thread:t1"]).toBeUndefined();

    failOnce.add("dws:revisions.json");
    await expect(
      repo.sourceCreate(
        {
          id: "s1",
          title: "Source",
          originalText: "Source",
          contentHash: "h-f06-create",
          extractionStatus: "ready",
          includedInContext: true,
          verification: "unverified",
          createdAt: "c",
          updatedAt: "u",
        },
        [{ id: "pg1", locator: "¶ 1", content: "passage" }],
      ),
    ).rejects.toThrow("disk full");
    expect(JSON.parse(storage["dws:sources.json"] ?? "[]")).toHaveLength(0);
    expect(storage["dws:source_s1.json"]).toBeUndefined();
    expect(revisions()["source:s1"]).toBeUndefined();
    expect(storage["dws:commit-journal.json"]).toBeUndefined();
    spy.mockRestore();
  });

  it("a mid-write failure during projectDelete keeps project, brief, and children (F06)", async () => {
    const projectMeta = {
      id: "p1",
      title: "P",
      createdAt: "c",
      updatedAt: "u",
    };
    await repo.projectCreate(projectMeta);
    await repo.projectSave("p1", {
      meta: { ...projectMeta, updatedAt: "u1" },
      brief: "the brief",
    });
    await repo.textCreate({ ...meta, projectId: "p1" }, md("v1"));
    await repo.threadCreate({ ...threadMeta, projectId: "p1" });

    // The brief removal is the LAST step. Fail it: the old code deleted
    // the project (and unlinked the children) and then threw, leaving the
    // brief orphaned and the generation mixed. The brief removal must be
    // part of the same envelope as the registry/revision writes.
    let failed = false;
    const spy = vi
      .spyOn(localStorage, "removeItem")
      .mockImplementation((key: string) => {
        if (key === "dws:project_p1.json" && !failed) {
          failed = true;
          throw new Error("disk full");
        }
        delete storage[key];
      });

    await expect(repo.projectDelete("p1")).rejects.toThrow("disk full");
    spy.mockRestore();

    // The whole domain operation rolled back: the project, its brief, the
    // child links, and the revision are the complete old generation.
    expect(
      JSON.parse(storage["dws:projects.json"]).some(
        (p: { id: string }) => p.id === "p1",
      ),
    ).toBe(true);
    expect(storage["dws:project_p1.json"]).toContain("the brief");
    expect(JSON.parse(storage["dws:library.json"])[0].projectId).toBe("p1");
    expect(JSON.parse(storage["dws:threads.json"])[0].projectId).toBe("p1");
    expect(
      (JSON.parse(storage["dws:revisions.json"]) as Record<string, number>)[
        "project:p1"
      ],
    ).toBe(1);
    expect(storage["dws:commit-journal.json"]).toBeUndefined();
  });

  it("a failed save does not advance the revision (B21b-3)", async () => {
    await repo.textCreate(meta, md("v1"));
    await repo.textSave("t1", {
      meta: { ...meta, wordCount: 2, updatedAt: "u1" },
      content: md("v2"),
    });
    expect(repo.peekRev("text", "t1")).toBe(1);

    const setItem = localStorage.setItem.bind(localStorage);
    let failed = false;
    const spy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation((key: string, value: string) => {
        if (key === "dws:text_t1.json" && !failed) {
          failed = true;
          throw new Error("disk full");
        }
        setItem(key, value);
      });
    await expect(
      repo.textSave("t1", {
        meta: { ...meta, wordCount: 3, updatedAt: "u2" },
        content: md("v3"),
      }),
    ).rejects.toThrow("disk full");
    spy.mockRestore();

    // Content AND revision stayed at the v2 generation.
    repo.resetSessionState();
    expect((await repo.textContent("t1"))?.content).toBe("v2");
    await repo.textsList();
    expect(repo.peekRev("text", "t1")).toBe(1);
    expect(JSON.parse(storage["dws:revisions.json"])["text:t1"]).toBe(1);

    // The next save advances from the rollback-safe revision.
    await repo.textSave("t1", {
      meta: { ...meta, wordCount: 4, updatedAt: "u3" },
      content: md("v4"),
    });
    expect(repo.peekRev("text", "t1")).toBe(2);
  });

  it("a failed thread append leaves content and revision unchanged (B21b-4)", async () => {
    await repo.threadCreate(threadMeta);
    await repo.threadAppendMessage("t1", storedMsg("m1", "first"), "u1");
    expect(repo.peekRev("thread", "t1")).toBe(1);

    const setItem = localStorage.setItem.bind(localStorage);
    let failed = false;
    const spy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation((key: string, value: string) => {
        if (key === "dws:threads.json" && !failed) {
          failed = true;
          throw new Error("disk full");
        }
        setItem(key, value);
      });
    await expect(
      repo.threadAppendMessage("t1", storedMsg("m2", "second"), "u2"),
    ).rejects.toThrow("disk full");
    spy.mockRestore();

    // The chat file, the registry, and the revision all stayed old.
    repo.resetSessionState();
    expect((await repo.threadGet("t1"))!.messages.map((m) => m.content)).toEqual([
      "first",
    ]);
    await repo.threadsList();
    expect(repo.peekRev("thread", "t1")).toBe(1);
    expect(JSON.parse(storage["dws:revisions.json"])["thread:t1"]).toBe(1);
    expect(storage["dws:commit-journal.json"]).toBeUndefined();

    // The next append advances cleanly.
    await repo.threadAppendMessage("t1", storedMsg("m2", "second"), "u3");
    expect(repo.peekRev("thread", "t1")).toBe(2);
    expect((await repo.threadGet("t1"))!.messages.map((m) => m.content)).toEqual([
      "first",
      "second",
    ]);
  });

  it("a failed registry-only rename leaves the revision unchanged (B21b-4)", async () => {
    await repo.threadCreate(threadMeta);
    await repo.threadRename("t1", "First", "u1");
    expect(repo.peekRev("thread", "t1")).toBe(1);

    const setItem = localStorage.setItem.bind(localStorage);
    let failed = false;
    const spy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation((key: string, value: string) => {
        if (key === "dws:threads.json" && !failed) {
          failed = true;
          throw new Error("disk full");
        }
        setItem(key, value);
      });
    await expect(repo.threadRename("t1", "Second", "u2")).rejects.toThrow(
      "disk full",
    );
    spy.mockRestore();

    repo.resetSessionState();
    expect((await repo.threadsList())[0].title).toBe("First");
    expect(repo.peekRev("thread", "t1")).toBe(1);
    expect(JSON.parse(storage["dws:revisions.json"])["thread:t1"]).toBe(1);
  });

  it("a failed version restore keeps the old body, history, and revision (B21b-4)", async () => {
    await repo.textCreate(meta, md("v1"));
    await repo.textSave("t1", {
      meta: { ...meta, updatedAt: "u1" },
      content: md("v2"),
    });
    expect(repo.peekRev("text", "t1")).toBe(1);
    const versions = await repo.textVersions("t1");
    expect(versions.map((v) => v.body.content)).toEqual(["v1"]);

    const setItem = localStorage.setItem.bind(localStorage);
    let failed = false;
    const spy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation((key: string, value: string) => {
        if (key === "dws:text_t1.json" && !failed) {
          failed = true;
          throw new Error("disk full");
        }
        setItem(key, value);
      });
    await expect(repo.textRestore("t1", versions[0].versionId)).rejects.toThrow(
      "disk full",
    );
    spy.mockRestore();

    // Body, snapshot history, metadata, and revision are the v2 generation.
    repo.resetSessionState();
    expect((await repo.textContent("t1"))?.content).toBe("v2");
    expect((await repo.textVersions("t1")).map((v) => v.body.content)).toEqual([
      "v1",
    ]);
    await repo.textsList();
    expect(repo.peekRev("text", "t1")).toBe(1);
    expect(JSON.parse(storage["dws:revisions.json"])["text:t1"]).toBe(1);
    expect(storage["dws:commit-journal.json"]).toBeUndefined();
  });

  it("migrates legacy bare-id revision keys to entityKey(kind, id) (B21)", async () => {
    await repo.textCreate(meta, md("v1"));
    await repo.textSave("t1", {
      meta: { ...meta, wordCount: 2, updatedAt: "u1" },
      content: md("v2"),
    });
    // A file written by an older browser build: the revision map was keyed
    // by the raw entity id while every write now uses `text:t1`.
    storage["dws:revisions.json"] = JSON.stringify({ t1: 1 });
    repo.resetSessionState();

    // Reading the list honours the legacy key…
    expect(await repo.textsList()).toHaveLength(1);
    expect(repo.peekRev("text", "t1")).toBe(1);

    // …and the next save adopts it under the canonical key (memory AND
    // disk): no stale rejection, no lost revision.
    await repo.textSave("t1", {
      meta: { ...meta, wordCount: 3, updatedAt: "u2" },
      content: md("v3"),
    });
    expect(repo.peekRev("text", "t1")).toBe(2);
    const persisted = JSON.parse(storage["dws:revisions.json"]);
    expect(persisted["text:t1"]).toBe(2);
    expect(persisted["t1"]).toBeUndefined();
  });

  it("failed content persistence leaves no committed metadata describing unsaved content", async () => {
    await repo.textCreate(meta, md("v1"));
    setTransportInterceptor(() => Promise.reject(new Error("disk gone")));
    await expect(
      repo.textSave("t1", {
        meta: { ...meta, title: "Renamed", updatedAt: "u1" },
        content: md("v2"),
      }),
    ).rejects.toThrow("disk gone");
    // Nothing landed: the old title AND the old body are still there.
    const registry = JSON.parse(storage["dws:library.json"]);
    expect(registry[0].title).toBe("T");
    expect((await repo.textContent("t1"))?.content).toBe("v1");
  });

  it("a failed save is retained and retryable", async () => {
    await repo.textCreate(meta, md("v1"));
    let reject = true;
    setTransportInterceptor((op) =>
      reject ? Promise.reject(new Error("disk gone")) : op(),
    );
    repo.textScheduleSave("t1", {
      meta: { ...meta, updatedAt: "u1" },
      content: md("v2"),
    });
    await expect(repo.flushTextSaves()).rejects.toThrow("disk gone");

    const failures = repo.saveFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].key).toBe("text:t1");
    expect(failures[0].kind).toBe("error");
    // Retained payload is still the latest draft, not the pre-failure one.
    expect((await repo.textContent("t1"))?.content).toBe("v1");

    // Transport recovers; the retry commits and clears the failure.
    reject = false;
    await repo.retrySave("text:t1");
    expect((await repo.textContent("t1"))?.content).toBe("v2");
    expect(repo.saveFailures()).toHaveLength(0);
  });

  it("a stale debounced save is rejected and the appended reply survives", async () => {
    vi.useFakeTimers();
    try {
      // Hold the debounced write in flight while the append lands.
      let release: () => void = () => {};
      setTransportInterceptor(async (op) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return op();
      });
      await repo.threadCreate(threadMeta); // rev 0
      repo.threadScheduleSave("t1", {
        meta: threadMeta,
        briefJson: null,
        messages: [
          { id: null, role: "user", content: "q", timestamp: "t1", failed: false, incomplete: null, attachmentsJson: null },
        ],
      }); // expectedRev captured: 0
      await vi.advanceTimersByTimeAsync(400); // debounced write starts, blocks
      await repo.threadAppendMessage(
        "t1",
        { id: null, role: "assistant", content: "late", timestamp: "t2", failed: false, incomplete: null, attachmentsJson: null },
        "u2",
      ); // rev 1 + reply persisted
      release();
      await vi.advanceTimersByTimeAsync(0); // the held write settles → stale

      const failures = repo.saveFailures();
      expect(failures).toHaveLength(1);
      expect(failures[0].kind).toBe("stale");
      // The appended reply survived; the stale payload ("q") is NOT on
      // disk — it stays retained in the failure registry for explicit
      // retry instead of silently overwriting the append.
      const data = await repo.threadGet("t1");
      expect(data!.messages.map((m) => m.content)).toEqual(["late"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("updating a deleted entity does not recreate it", async () => {
    await repo.textCreate(meta, md("v1"));
    await repo.textDelete("t1");
    await expect(
      repo.textSave("t1", { meta: { ...meta, updatedAt: "u2" }, content: md("v2") }),
    ).rejects.toThrow(/not found/);
    expect(storage["dws:text_t1.json"]).toBeUndefined();
    expect(JSON.parse(storage["dws:library.json"])).toEqual([]);
  });

  it("save then delete cannot resurrect the entity", async () => {
    await repo.textCreate(meta, md("v1"));
    repo.textScheduleSave("t1", {
      meta: { ...meta, updatedAt: "u1" },
      content: md("v2"),
    });
    await repo.textDelete("t1");
    await repo.idle();

    expect(storage["dws:text_t1.json"]).toBeUndefined();
    expect(storage["dws:library.json"]).toBe("[]");
  });

  it("concurrent mutations do not overwrite each other's registries", async () => {
    const t1: ThreadMeta = { ...threadMeta, id: "a" };
    const t2: ThreadMeta = { ...threadMeta, id: "b" };
    await Promise.all([
      repo.threadCreate(t1),
      repo.threadCreate(t2),
      repo.textCreate(meta, md("hello")),
      repo.projectCreate({
        id: "p1",
        title: "P",
        createdAt: "c",
        updatedAt: "u",
      }),
    ]);
    expect(await repo.threadsList()).toHaveLength(2);
    expect(await repo.textsList()).toHaveLength(1);
    expect(await repo.projectsList()).toHaveLength(1);
  });

  it("textScheduleSave debounces and snapshots the replaced content once", async () => {
    await repo.textCreate(meta, md("v1"));
    repo.textScheduleSave("t1", {
      meta: { ...meta, updatedAt: "u1" },
      content: md("v2"),
    });
    repo.textScheduleSave("t1", {
      meta: { ...meta, updatedAt: "u2" },
      content: md("v3"),
    });
    await repo.flushTextSaves();

    expect(JSON.parse(storage["dws:text_t1.json"]).content).toBe("v3");
    const versions = JSON.parse(storage["dws:text_t1.versions.json"]);
    expect(versions).toHaveLength(1);
    expect(versions[0].body.content).toBe("v1");
    expect(versions[0].versionId).toMatch(/^sv-/);
    const registry = JSON.parse(storage["dws:library.json"]);
    expect(registry[0].title).toBe("T");
  });

  it("re-saving the same content does not duplicate or lose history", async () => {
    await repo.textCreate(meta, md("v0"));
    await repo.textSave("t1", { meta: { ...meta, updatedAt: "u1" }, content: md("v1") });
    // The same cached edit re-saved before the debounce fired: the v0
    // snapshot must survive, not be replaced by a lost one.
    await repo.textSave("t1", { meta: { ...meta, updatedAt: "u2" }, content: md("v1") });
    await repo.textSave("t1", { meta: { ...meta, updatedAt: "u3" }, content: md("v2") });
    const versions = await repo.textVersions("t1");
    expect(versions.map((v) => v.body.content)).toEqual(["v1", "v0"]);
    // Same-millisecond snapshots stay distinguishable via version ids.
    expect(versions[0].versionId).not.toBe(versions[1].versionId);
  });

  it("textRestore resolves the target by version id inside the repository", async () => {
    await repo.textCreate(meta, md("v1"));
    await repo.textSave("t1", { meta: { ...meta, updatedAt: "u1" }, content: md("v2") });
    const versions = await repo.textVersions("t1");
    expect(versions).toHaveLength(1);
    const result = await repo.textRestore("t1", versions[0].versionId);
    expect(result.body.content).toBe("v1");
    expect((await repo.textContent("t1"))?.content).toBe("v1");
    // The replaced content is snapshotted, so the user can step back.
    // (The restored version itself stays in history — it is now live.)
    const after = await repo.textVersions("t1");
    expect(after.map((v) => v.body.content)).toEqual(["v2", "v1"]);
    expect(after[0].versionId).not.toBe(versions[0].versionId);
    // Derived metadata returned from the restore.
    expect(result.wordCount).toBe(1);
  });

  it("restoring a missing version fails without mutation", async () => {
    await repo.textCreate(meta, md("v1"));
    await expect(repo.textRestore("t1", "no-such-id")).rejects.toThrow(/not found/);
    expect((await repo.textContent("t1"))?.content).toBe("v1");
  });

  it("projectDelete unlinks texts and conversations in one operation", async () => {
    const textMeta: LibraryTextMeta = { ...meta, id: "t1", projectId: "p1" };
    await repo.projectCreate({ id: "p1", title: "P", createdAt: "c", updatedAt: "u" });
    await repo.textCreate(textMeta, md("body"));
    await repo.threadCreate({ ...threadMeta, id: "th1", projectId: "p1" });

    await repo.projectDelete("p1");
    await repo.idle();

    expect((await repo.projectsList())).toHaveLength(0);
    const texts = await repo.textsList();
    expect(texts).toHaveLength(1);
    expect(texts[0].projectId).toBeUndefined();
    const threads = await repo.threadsList();
    expect(threads).toHaveLength(1);
    expect(threads[0].projectId).toBeUndefined();
    expect(storage["dws:project_p1.json"]).toBeUndefined();
  });

  // ── B21c: deletion and relink invariants ──

  const sourceMeta: SourceMeta = {
    id: "s1",
    title: "Source",
    originalText: "source body",
    contentHash: "hash-s1",
    extractionStatus: "ready",
    includedInContext: true,
    verification: "unverified",
    createdAt: "c",
    updatedAt: "u",
  };

  it("projectDelete bumps affected child revisions and unlinks sources (B21c)", async () => {
    await repo.projectCreate({ id: "p1", title: "P", createdAt: "c", updatedAt: "u" });
    await repo.textCreate({ ...meta, id: "t1", projectId: "p1" }, md("body"));
    await repo.threadCreate({ ...threadMeta, id: "th1", projectId: "p1" });
    await repo.sourceCreate({ ...sourceMeta, projectId: "p1" }, []);
    expect(repo.peekRev("text", "t1")).toBe(0);
    expect(repo.peekRev("source", "s1")).toBe(0);

    await repo.projectDelete("p1");
    await repo.idle();

    // The relationship change is a metadata change: children advance so
    // stale clients cannot save on the pre-deletion association.
    expect(repo.peekRev("text", "t1")).toBe(1);
    expect(repo.peekRev("thread", "th1")).toBe(1);
    expect(repo.peekRev("source", "s1")).toBe(1);
    expect(repo.peekRev("project", "p1")).toBeNull();
    const revsFile = JSON.parse(storage["dws:revisions.json"]);
    expect(revsFile["project:p1"]).toBeUndefined();
    expect(revsFile["text:t1"]).toBe(1);
    expect(revsFile["thread:th1"]).toBe(1);
    expect(revsFile["source:s1"]).toBe(1);

    expect((await repo.sourcesList())[0].projectId).toBeUndefined();
    expect(storage["dws:source_s1.json"]).toBeDefined();
  });

  it("a queued child save cannot relink a deleted project (B21c)", async () => {
    const textMeta: LibraryTextMeta = { ...meta, id: "t1", projectId: "p1" };
    await repo.projectCreate({ id: "p1", title: "P", createdAt: "c", updatedAt: "u" });
    await repo.textCreate(textMeta, md("v1"));
    // The pending payload still carries the pre-deletion association.
    repo.textScheduleSave("t1", {
      meta: { ...textMeta, updatedAt: "u2" },
      content: md("v2"),
    });
    await repo.projectDelete("p1");
    await repo.flushTextSaves();

    const texts = await repo.textsList();
    expect(texts[0]?.projectId).toBeUndefined();
    // The pending edit is not lost: it lands without the dead link.
    expect((await repo.textContent("t1"))?.content).toBe("v2");
    expect(repo.saveFailures()).toHaveLength(0);
  });

  it("a direct save with stale metadata drops the dead link (B21c)", async () => {
    await repo.projectCreate({ id: "p1", title: "P", createdAt: "c", updatedAt: "u" });
    await repo.textCreate({ ...meta, id: "t1", projectId: "p1" }, md("v1"));
    await repo.projectDelete("p1");

    await repo.textSave("t1", {
      meta: { ...meta, id: "t1", projectId: "p1", updatedAt: "u3" },
      content: md("v3"),
    });

    expect((await repo.textsList())[0].projectId).toBeUndefined();
    expect((await repo.textContent("t1"))?.content).toBe("v3");
  });

  it("creates keep live project links and drop dead ones (B21c)", async () => {
    await repo.projectCreate({ id: "p1", title: "P", createdAt: "c", updatedAt: "u" });
    await repo.textCreate({ ...meta, id: "t1", projectId: "p1" }, md("v1"));
    await repo.textCreate({ ...meta, id: "t2", projectId: "missing" }, md("v2"));
    await repo.threadCreate({ ...threadMeta, id: "th1", projectId: "p1" });
    await repo.threadCreate({ ...threadMeta, id: "th2", projectId: "missing" });

    const byId = new Map((await repo.textsList()).map((t) => [t.id, t]));
    expect(byId.get("t1")?.projectId).toBe("p1");
    expect(byId.get("t2")?.projectId).toBeUndefined();
    const threads = new Map((await repo.threadsList()).map((t) => [t.id, t]));
    expect(threads.get("th1")?.projectId).toBe("p1");
    expect(threads.get("th2")?.projectId).toBeUndefined();
  });

  it("a queued save for a deleted project fails instead of resurrecting it (B21c)", async () => {
    const project = { id: "p1", title: "P", createdAt: "c", updatedAt: "u" };
    await repo.projectCreate(project);
    repo.projectScheduleSave("p1", { meta: project, brief: "draft" });
    await repo.projectDelete("p1");
    await repo.idle();

    expect(await repo.projectsList()).toHaveLength(0);
    await expect(
      repo.projectSave("p1", { meta: project, brief: "again" }),
    ).rejects.toThrow(/not found/i);
    expect(await repo.projectsList()).toHaveLength(0);
  });

  it("threadGet reads the old bare-array thread shape", async () => {
    storage["dws:chat_t1.json"] = JSON.stringify([
      { role: "user", content: "hi", timestamp: "t" },
    ]);
    const data = await repo.threadGet("t1");
    expect(data!.messages).toHaveLength(1);
    expect(data!.messages[0].content).toBe("hi");
    expect(data!.briefJson).toBeNull();
    expect(data!.rev).toBe(0);
  });

  it("threadScheduleSave and threadGet roundtrip attachments and briefs", async () => {
    await repo.threadCreate(threadMeta);
    repo.threadScheduleSave("t1", {
      meta: threadMeta,
      briefJson: '{"topic":"x"}',
      messages: [
        {
          id: "m1",
          role: "user",
          content: "hi",
          timestamp: "t",
          failed: false,
          incomplete: null,
          attachmentsJson: '[{"name":"f.txt"}]',
        },
      ],
    });
    await repo.flushThreadSaves();

    const data = await repo.threadGet("t1");
    expect(data!.briefJson).toBe('{"topic":"x"}');
    expect(data!.messages[0].id).toBe("m1");
    expect(data!.messages[0].attachmentsJson).toBe('[{"name":"f.txt"}]');
  });

  it("threadSave persists the incomplete marker and threadGet returns it", async () => {
    await repo.threadCreate(threadMeta);
    await repo.threadSave("t1", {
      meta: threadMeta,
      briefJson: null,
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "partial answer",
          timestamp: "t",
          failed: false,
          incomplete: "truncated",
          attachmentsJson: null,
        },
      ],
    });
    const written = JSON.parse(storage["dws:chat_t1.json"]);
    expect(written.messages[0].incomplete).toBe("truncated");
    const data = await repo.threadGet("t1");
    expect(data!.messages[0].incomplete).toBe("truncated");
  });

  it("threadAppendMessage flushes the pending save before appending", async () => {
    await repo.threadCreate(threadMeta);
    repo.threadScheduleSave("t1", {
      meta: threadMeta,
      briefJson: null,
      messages: [
        { id: null, role: "user", content: "q", timestamp: "t1", failed: false, incomplete: null, attachmentsJson: null },
      ],
    });
    await repo.threadAppendMessage(
      "t1",
      { id: null, role: "assistant", content: "a", timestamp: "t2", failed: false, incomplete: null, attachmentsJson: null },
      "u2",
    );

    const data = await repo.threadGet("t1");
    expect(data!.messages.map((m) => m.content)).toEqual(["q", "a"]);
    const threadMeta2 = JSON.parse(storage["dws:threads.json"])[0];
    expect(threadMeta2.updatedAt).toBe("u2");
  });

  it("a close during a delayed save waits for the write to land", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    try {
      await repo.threadCreate(threadMeta);
      // The shutdown drain (flushChatSave → flushThreadSaves + idle) must
      // resolve only AFTER the delayed write actually landed.
      setTransportInterceptor(async (op) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return op();
      });
      repo.threadScheduleSave("t1", {
        meta: threadMeta,
        briefJson: null,
        messages: [
          { id: null, role: "user", content: "closing now", timestamp: "t1", failed: false, incomplete: null, attachmentsJson: null },
        ],
      });
      const drained = (async () => {
        await repo.flushThreadSaves();
        await repo.idle();
      })();
      await vi.advanceTimersByTimeAsync(400); // debounced write starts, blocks
      expect(storage["dws:chat_t1.json"]).toBeUndefined(); // nothing written yet
      release();
      await drained;
      const data = JSON.parse(storage["dws:chat_t1.json"]);
      expect(data.messages[0].content).toBe("closing now");
    } finally {
      // Never leak a blocked queue into the next test.
      release();
      setTransportInterceptor(null);
      vi.useRealTimers();
    }
  });

  it("threadsList normalizes legacy rows lacking mode and keeps references", async () => {
    storage["dws:threads.json"] = JSON.stringify([
      {
        id: "th-1",
        title: "Old conversation",
        references: "Fanon, Black Skin, White Masks (1952).",
        createdAt: "c",
        updatedAt: "u",
      },
      { id: "th-2", title: "Brief", mode: "project", createdAt: "c", updatedAt: "u" },
    ]);
    const threads = await repo.threadsList();
    expect(threads[0].mode).toBe("text");
    expect(threads[0].references).toBe("Fanon, Black Skin, White Masks (1952).");
    expect(threads[1].mode).toBe("project");
  });

  // ── B05: saver composition, drainage, retries ──

  it("saveNow merges a pending body save: rename + content both land", async () => {
    await repo.textCreate(meta, md("v1"));
    // A debounced content save is still pending…
    repo.textScheduleSave("t1", {
      meta: { ...meta, updatedAt: "u1" },
      content: md("v2"),
    });
    // …when an explicit metadata-only save arrives.
    await repo.textSave("t1", {
      meta: { ...meta, title: "Renamed", updatedAt: "u2" },
    });
    // The pending body was composed, never cancelled.
    expect((await repo.textContent("t1"))?.content).toBe("v2");
    const registry = JSON.parse(storage["dws:library.json"]);
    expect(registry[0].title).toBe("Renamed");
  });

  it("flush detaches its whole batch: a blocked first write cannot make the second run twice", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const setItemSpy = vi.spyOn(localStorage, "setItem");
    try {
      const secondMeta: LibraryTextMeta = { ...meta, id: "t2" };
      await repo.textCreate(meta, md("a0"));
      await repo.textCreate(secondMeta, md("b0"));

      const writes: string[] = [];
      setItemSpy.mockImplementation((key: string, value: string) => {
        writes.push(key);
        storage[key] = String(value);
      });

      let block = true;
      setTransportInterceptor(async (op) => {
        if (block) {
          block = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return op();
      });
      repo.textScheduleSave("t1", {
        meta: { ...meta, updatedAt: "u1" },
        content: md("a1"),
      });
      repo.textScheduleSave("t2", {
        meta: { ...secondMeta, updatedAt: "u1" },
        content: md("b1"),
      });

      const flush = repo.flushTextSaves();
      // The first write is blocked. The OLD flush left the second entry's
      // timer live and it would fire here, writing t2 once more later.
      await vi.advanceTimersByTimeAsync(400);
      release();
      await flush;

      expect(writes.filter((k) => k === "dws:text_t2.json")).toHaveLength(1);
      expect(storage["dws:text_t2.json"]).toContain("b1");
    } finally {
      release();
      setTransportInterceptor(null);
      setItemSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("drain fails visibly when an earlier timer-fired write is retained", async () => {
    vi.useFakeTimers();
    try {
      await repo.textCreate(meta, md("v1"));
      setTransportInterceptor(() => Promise.reject(new Error("disk gone")));
      repo.textScheduleSave("t1", {
        meta: { ...meta, updatedAt: "u1" },
        content: md("v2"),
      });
      await vi.advanceTimersByTimeAsync(400);

      expect(repo.saveFailures()).toHaveLength(1);
      setTransportInterceptor(null);
      // A later drain must NOT report success while the payload is retained.
      await expect(repo.drainTextSaves()).rejects.toThrow(/retained/i);
      // The retained payload is retryable and lands once the transport works.
      await repo.retrySave("text:t1");
      expect(repo.saveFailures()).toHaveLength(0);
      expect((await repo.textContent("t1"))?.content).toBe("v2");
    } finally {
      setTransportInterceptor(null);
      vi.useRealTimers();
    }
  });

  it("queued local saves adopt their own revision advancement; external staleness stays rejected", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    let block = true;
    try {
      await repo.textCreate(meta, md("v0"));
      setTransportInterceptor(async (op) => {
        if (block) {
          block = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return op();
      });

      repo.textScheduleSave("t1", {
        meta: { ...meta, updatedAt: "u1" },
        content: md("v1"),
      });
      await vi.advanceTimersByTimeAsync(400); // first write is in flight, blocked
      const second = repo.textSave("t1", {
        meta: { ...meta, title: "Renamed", updatedAt: "u2" },
        content: md("v2"),
      });
      release();
      await second;

      // The second (queued) local save succeeded instead of going stale.
      expect(repo.saveFailures()).toHaveLength(0);
      expect((await repo.textContent("t1"))?.content).toBe("v2");
      const registry = JSON.parse(storage["dws:library.json"]);
      expect(registry[0].title).toBe("Renamed");

      // A genuinely external revision advancement is still rejected.
      storage["dws:revisions.json"] = JSON.stringify({ "text:t1": 99 });
      await expect(
        repo.textSave("t1", { meta: { ...meta, updatedAt: "u3" } }),
      ).rejects.toThrow(/stale/i);
    } finally {
      release();
      setTransportInterceptor(null);
      vi.useRealTimers();
    }
  });
});

describe("repository (SQLite backend)", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    freshRepoState();
    expect(isSqliteRepository()).toBe(true);
  });

  // ── Wire contract (R1): fixtures shared with the Rust serde tests ──

  it("threadUpsertMeta (text mode) produces the exact contract payload", async () => {
    invokeMock.mockResolvedValue(null);
    await repo.threadSave("th-1", {
      meta: {
        id: fixtures.threadMeta.id,
        title: fixtures.threadMeta.title,
        mode: "text",
        references: fixtures.threadMeta.references,
        createdAt: fixtures.threadMeta.createdAt,
        updatedAt: fixtures.threadMeta.updatedAt,
      },
      briefJson: null,
      messages: [],
    });
    expect(invokeMock).toHaveBeenCalledWith("db_thread_save", {
      id: "th-1",
      meta: { ...fixtures.threadMeta, rev: 0 },
      briefJson: null,
      messages: [],
      expectedRev: null,
    });
  });

  it("threadUpsertMeta (project mode) produces the exact contract payload", async () => {
    invokeMock.mockResolvedValue(null);
    await repo.threadSave("th-2", {
      meta: {
        id: fixtures.threadMetaProject.id,
        title: fixtures.threadMetaProject.title,
        mode: "project",
        projectId: fixtures.threadMetaProject.projectId,
        folder: fixtures.threadMetaProject.folder,
        createdAt: fixtures.threadMetaProject.createdAt,
        updatedAt: fixtures.threadMetaProject.updatedAt,
      },
      briefJson: null,
      messages: [],
    });
    expect(invokeMock).toHaveBeenCalledWith("db_thread_save", {
      id: "th-2",
      meta: { ...fixtures.threadMetaProject, rev: 0 },
      briefJson: null,
      messages: [],
      expectedRev: null,
    });
  });

  it("threadCreate produces the exact contract payload", async () => {
    invokeMock.mockResolvedValue(null);
    await repo.threadCreate({
      id: fixtures.threadMeta.id,
      title: fixtures.threadMeta.title,
      mode: "text",
      references: fixtures.threadMeta.references,
      createdAt: fixtures.threadMeta.createdAt,
      updatedAt: fixtures.threadMeta.updatedAt,
    });
    // The Rust command requires briefJson AND messages; a create must send
    // both (an empty conversation is null + []).
    expect(invokeMock).toHaveBeenCalledWith("db_thread_create", {
      meta: fixtures.threadMeta,
      briefJson: null,
      messages: [],
    });
  });

  it("folder commands produce the exact contract payloads", async () => {
    invokeMock.mockResolvedValue(null);
    await repo.folderCreate(fixtures.folderMeta);
    expect(invokeMock).toHaveBeenCalledWith("db_folder_create", {
      folder: fixtures.folderMeta,
    });

    invokeMock.mockResolvedValue([
      { kind: "text", id: "t-1", rev: 4 },
      { kind: "thread", id: "th-1", rev: 5 },
    ]);
    await repo.folderRename("", "Notes", "Archive", "u2");
    expect(invokeMock).toHaveBeenCalledWith("db_folder_rename", {
      scope: "",
      oldName: "Notes",
      newName: "Archive",
      updatedAt: "u2",
    });

    invokeMock.mockResolvedValue([{ kind: "text", id: "t-1", rev: 6 }]);
    await repo.folderDelete("", "Archive");
    expect(invokeMock).toHaveBeenCalledWith("db_folder_delete", {
      scope: "",
      name: "Archive",
    });
  });

  it("threadAppendMessage and threadReplaceMessage carry the incomplete marker (schema v12)", async () => {
    invokeMock.mockResolvedValue(null);
    await repo.threadAppendMessage(
      "th-1",
      {
        id: "m-2",
        role: "assistant",
        content: "partial",
        timestamp: "t",
        failed: false,
        incomplete: "interrupted",
        attachmentsJson: null,
      },
      "u",
    );
    expect(invokeMock).toHaveBeenCalledWith("db_thread_append_message", {
      id: "th-1",
      message: {
        id: "m-2",
        role: "assistant",
        content: "partial",
        timestamp: "t",
        failed: false,
        incomplete: "interrupted",
        attachmentsJson: null,
      },
      updatedAt: "u",
    });

    invokeMock.mockResolvedValue(3);
    await repo.threadReplaceMessage("th-1", "m-2", "complete now", null, "u2");
    expect(invokeMock).toHaveBeenCalledWith("db_thread_replace_message", {
      id: "th-1",
      messageId: "m-2",
      content: "complete now",
      incomplete: null,
      updatedAt: "u2",
    });
  });

  it("projectSave produces the exact contract payload", async () => {
    invokeMock.mockResolvedValue(null);
    await repo.projectSave("p-1", {
      meta: {
        id: fixtures.projectMeta.id,
        title: fixtures.projectMeta.title,
        defaultAudience: "academics",
        defaultCitations: "apa",
        references: fixtures.projectMeta.references,
        createdAt: fixtures.projectMeta.createdAt,
        updatedAt: fixtures.projectMeta.updatedAt,
      },
    });
    expect(invokeMock).toHaveBeenCalledWith("db_project_save", {
      id: "p-1",
      meta: { ...fixtures.projectMeta, rev: 0 },
      brief: null,
      expectedRev: null,
    });
  });

  it("textCreate produces the exact contract payload", async () => {
    invokeMock.mockResolvedValue(null);
    await repo.textCreate(
      {
        id: fixtures.textMeta.id,
        title: fixtures.textMeta.title,
        textType: "essay",
        projectId: fixtures.textMeta.projectId,
        wordCount: 1200,
        createdAt: fixtures.textMeta.createdAt,
        updatedAt: fixtures.textMeta.updatedAt,
      },
      md("body"),
    );
    expect(invokeMock).toHaveBeenCalledWith("db_text_create", {
      meta: { ...fixtures.textMeta, rev: 0 },
      body: {
        content: "body",
        contentFormat: "markdown",
        contentSchemaVersion: 1,
        plainText: "body",
      },
    });
  });

  it("normalizes null wire fields into absent domain fields", async () => {
    invokeMock.mockResolvedValue([
      {
        id: "th-9",
        title: "Nulls",
        mode: "text",
        projectId: null,
        references: null,
        rev: 3,
        createdAt: "c",
        updatedAt: "u",
      },
    ]);
    const threads = await repo.threadsList();
    expect(threads[0]).toEqual({
      id: "th-9",
      title: "Nulls",
      mode: "text",
      createdAt: "c",
      updatedAt: "u",
    });
    expect("references" in threads[0]).toBe(false);
    expect("projectId" in threads[0]).toBe(false);

    invokeMock.mockResolvedValue([
      {
        id: "t-9",
        title: "Nulls",
        textType: "essay",
        folder: null,
        projectId: null,
        snippet: null,
        wordCount: null,
        rev: 1,
        createdAt: "c",
        updatedAt: "u",
      },
    ]);
    const texts = await repo.textsList();
    expect(texts[0]).toEqual({
      id: "t-9",
      title: "Nulls",
      textType: "essay",
      createdAt: "c",
      updatedAt: "u",
    });
    expect("folder" in texts[0]).toBe(false);
  });

  it("a metadata update keeps references intact", async () => {
    invokeMock.mockResolvedValue(null);
    const metaWithRefs: ThreadMeta = {
      ...threadMeta,
      references: "Fanon, Black Skin, White Masks (1952).",
    };
    await repo.threadSave("t1", {
      meta: metaWithRefs,
      briefJson: null,
      messages: [],
    });
    // Later rename update arrives with fresh domain metadata; references
    // must still travel on the wire.
    await repo.threadSave("t1", {
      meta: { ...metaWithRefs, title: "Renamed" },
      briefJson: null,
      messages: [],
    });
    const metas = invokeMock.mock.calls
      .filter((c: unknown[]) => c[0] === "db_thread_save")
      .map((c: unknown[]) => (c[1] as { meta: { references?: string } }).meta);
    expect(metas[0].references).toBe("Fanon, Black Skin, White Masks (1952).");
    expect(metas[1].references).toBe("Fanon, Black Skin, White Masks (1952).");
  });

  it("a save with a known revision sends expectedRev", async () => {
    invokeMock.mockResolvedValue(null);
    // Lists populate the revision cache.
    invokeMock.mockResolvedValueOnce([
      { ...fixtures.threadMeta, rev: 7 },
    ]);
    await repo.threadsList();
    invokeMock.mockResolvedValue(null);
    await repo.threadSave("th-1", {
      meta: {
        id: fixtures.threadMeta.id,
        title: fixtures.threadMeta.title,
        mode: "text",
        references: fixtures.threadMeta.references,
        createdAt: fixtures.threadMeta.createdAt,
        updatedAt: fixtures.threadMeta.updatedAt,
      },
      briefJson: null,
      messages: [],
    });
    expect(invokeMock).toHaveBeenLastCalledWith("db_thread_save", {
      id: "th-1",
      meta: { ...fixtures.threadMeta, rev: 7 },
      briefJson: null,
      messages: [],
      expectedRev: 7,
    });
  });

  it("textScheduleSave debounces into a single command with camelCase args", async () => {
    invokeMock.mockResolvedValue(2);
    repo.textScheduleSave("t1", {
      meta: { ...meta, snippet: "s", wordCount: 2, updatedAt: "u1" },
      content: md("v2"),
    });
    await repo.flushTextSaves();
    expect(invokeMock).toHaveBeenCalledWith("db_text_save", {
      id: "t1",
      meta: {
        id: "t1",
        title: "T",
        textType: "essay",
        folder: null,
        projectId: null,
        snippet: "s",
        wordCount: 2,
        rev: 0,
        archived: false,
        pinned: false,
        createdAt: "c",
        updatedAt: "u1",
      },
      body: {
        content: "v2",
        contentFormat: "markdown",
        contentSchemaVersion: 1,
        plainText: "v2",
      },
      expectedRev: null,
    });
  });

  it("textRestore flushes the pending save before invoking the restore", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "db_text_save") return 1;
      return {
        rev: 2,
        savedAt: "old",
        content: "v0",
        contentFormat: "markdown",
        contentSchemaVersion: 1,
        plainText: null,
        snippet: "s",
        wordCount: 1,
        updatedAt: "u2",
      };
    });
    repo.textScheduleSave("t1", {
      meta: { ...meta, updatedAt: "u1" },
      content: md("v2"),
    });
    await repo.textRestore("t1", "ver-1");

    const commands = invokeMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(commands).toContain("db_text_save");
    expect(commands.indexOf("db_text_save")).toBeLessThan(
      commands.indexOf("db_text_restore"),
    );
    // The restore carries the revision the flushed save just committed
    // (optimistic concurrency for history restores).
    expect(invokeMock).toHaveBeenLastCalledWith("db_text_restore", {
      id: "t1",
      versionId: "ver-1",
      now: expect.any(String),
      expectedRev: 1,
    });
  });

  it("textDelete cancels the pending save so deleted texts cannot resurrect", async () => {
    invokeMock.mockResolvedValue(null);
    repo.textScheduleSave("t1", {
      meta: { ...meta, updatedAt: "u1" },
      content: md("v2"),
    });
    await repo.textDelete("t1");
    await repo.idle();

    const commands = invokeMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(commands).not.toContain("db_text_save");
    expect(commands).toContain("db_text_delete");
  });

  it("projectDelete applies the child revisions the backend reports (B21c)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "db_project_delete") {
        return [
          { kind: "text", id: "t1", rev: 1 },
          { kind: "thread", id: "th1", rev: 1 },
          { kind: "source", id: "s1", rev: 1 },
        ];
      }
      return null;
    });

    await repo.projectDelete("p1");

    expect(invokeMock).toHaveBeenCalledWith("db_project_delete", { id: "p1" });
    // The unlink bumped each child; the session cache must know before the
    // next save so a stale expectation cannot be rebased onto a dead link.
    expect(repo.peekRev("text", "t1")).toBe(1);
    expect(repo.peekRev("thread", "th1")).toBe(1);
    expect(repo.peekRev("source", "s1")).toBe(1);
    expect(repo.peekRev("project", "p1")).toBeNull();
  });

  it("a queued child save after projectDelete drops the dead link (B21c)", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "db_project_delete") {
          return [{ kind: "text", id: "t1", rev: 1 }];
        }
        return 1;
      },
    );
    repo.textScheduleSave("t1", {
      meta: { ...meta, id: "t1", projectId: "p1", updatedAt: "u2" },
      content: md("v2"),
    });

    await repo.projectDelete("p1");
    await repo.flushTextSaves();

    const save = calls.find((c) => c.cmd === "db_text_save");
    expect(save).toBeDefined();
    const payload = save!.args as {
      meta: { projectId: string | null };
      expectedRev: number;
    };
    expect(payload.meta.projectId).toBeNull();
    expect(payload.expectedRev).toBe(1);
  });

  it("threadAppendMessage flushes the pending thread save first", async () => {
    invokeMock.mockResolvedValue(null);
    repo.threadScheduleSave("t1", {
      meta: threadMeta,
      briefJson: null,
      messages: [
        { id: null, role: "user", content: "q", timestamp: "t1", failed: false, incomplete: null, attachmentsJson: null },
      ],
    });
    await repo.threadAppendMessage(
      "t1",
      { id: null, role: "assistant", content: "a", timestamp: "t2", failed: false, incomplete: null, attachmentsJson: null },
      "u2",
    );

    const commands = invokeMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(commands).toContain("db_thread_save");
    expect(commands.indexOf("db_thread_save")).toBeLessThan(
      commands.indexOf("db_thread_append_message"),
    );
  });

  // ── B13: metadata-only source saves ──

  it("sourceSave omits passages (metadata-only) unless an explicit list is given", async () => {
    invokeMock.mockResolvedValue(0);
    const source = {
      id: "s1",
      title: "Source",
      originalText: "body",
      contentHash: "hash-1",
      extractionStatus: "ready" as const,
      includedInContext: true,
      verification: "unverified" as const,
      createdAt: "c",
      updatedAt: "u",
    };

    await repo.sourceSave("s1", source);
    expect(invokeMock).toHaveBeenLastCalledWith("db_source_save", {
      id: "s1",
      source: expect.objectContaining({ id: "s1", title: "Source" }),
      passages: null,
      expectedRev: null,
    });

    await repo.sourceSave("s1", source, []);
    expect(invokeMock).toHaveBeenLastCalledWith("db_source_save", {
      id: "s1",
      source: expect.objectContaining({ id: "s1" }),
      passages: [],
      expectedRev: 0,
    });

    await repo.sourceSave("s1", source, [
      { id: "p1", locator: "p. 3", content: "quoted" },
    ]);
    expect(invokeMock).toHaveBeenLastCalledWith("db_source_save", {
      id: "s1",
      source: expect.objectContaining({ id: "s1" }),
      passages: [{ id: "p1", locator: "p. 3", content: "quoted" }],
      expectedRev: 0,
    });
  });
});
