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

import {
  repo,
  runExclusiveMaintenance,
  privilegedDrain,
  setTransportInterceptor,
} from "@/utils/repository";
import { markdownDocument } from "@/utils/documentCodec";
import type { LibraryTextMeta } from "@/types";

const meta: LibraryTextMeta = {
  id: "t1",
  title: "T",
  textType: "essay",
  createdAt: "c",
  updatedAt: "u",
};

const md = (s: string) => markdownDocument(s);

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  for (const key of Object.keys(storage)) delete storage[key];
  repo.resetSessionState();
});

afterEach(() => {
  vi.useRealTimers();
  setTransportInterceptor(null);
});

describe("exclusive maintenance (B07)", () => {
  it("no mutation crosses a delayed restore boundary; held work is discarded on success", async () => {
    await repo.textCreate(meta, md("v0"));

    let releaseRestore: (() => void) | null = null;
    const maintenance = runExclusiveMaintenance("discard", async () => {
      await privilegedDrain();
      await new Promise<void>((resolve) => {
        releaseRestore = resolve;
      });
    });

    // The barrier is up: every ordinary mutation family rejects.
    await expect(repo.textCreate({ ...meta, id: "t2" }, md("x"))).rejects.toThrow(
      /maintenance/i,
    );
    await expect(repo.textSave("t1", { meta })).rejects.toThrow(/maintenance/i);
    await expect(repo.textDelete("t1")).rejects.toThrow(/maintenance/i);
    await expect(
      repo.sourceCreate(
        {
          id: "s1",
          title: "S",
          originalText: "x",
          contentHash: "h",
          extractionStatus: "ready",
          includedInContext: true,
          verification: "unverified",
          createdAt: "c",
          updatedAt: "u",
        },
        [],
      ),
    ).rejects.toThrow(/maintenance/i);

    // Scheduled saves are HELD (not applied) while the barrier is up.
    repo.textScheduleSave("t1", {
      meta: { ...meta, title: "Held rename" },
      content: md("held edit"),
    });
    await repo.idle();
    expect(storage["dws:text_t1.json"]).toContain("v0");

    releaseRestore!();
    await maintenance;

    // Successful replacement: held pre-restore work is discarded.
    const registry = JSON.parse(storage["dws:library.json"]);
    expect(registry[0].title).toBe("T");
    expect(storage["dws:text_t1.json"]).toContain("v0");
  });

  it("a failed maintenance task releases held work instead of dropping it", async () => {
    await repo.textCreate(meta, md("v0"));

    await expect(
      runExclusiveMaintenance("discard", async () => {
        // A held write is scheduled during the failed restore…
        repo.textScheduleSave("t1", {
          meta: { ...meta, title: "Recovered rename" },
          content: md("recovered edit"),
        });
        throw new Error("restore exploded");
      }),
    ).rejects.toThrow("restore exploded");

    // …and is RELEASED afterwards, so the user's work is not lost.
    await repo.flushTextSaves();
    expect(storage["dws:text_t1.json"]).toContain("recovered edit");
    const registry = JSON.parse(storage["dws:library.json"]);
    expect(registry[0].title).toBe("Recovered rename");
  });

  it("pauses Retry and Overwrite while the barrier is up (F01)", async () => {
    await repo.textCreate(meta, md("v0"));

    // A failed scheduled save retains its payload.
    setTransportInterceptor(() => Promise.reject(new Error("disk gone")));
    repo.textScheduleSave("t1", {
      meta: { ...meta, updatedAt: "u1" },
      content: md("v1"),
    });
    await expect(repo.flushTextSaves()).rejects.toThrow("disk gone");
    expect(repo.saveFailures()).toHaveLength(1);
    setTransportInterceptor(null);

    // Hold the barrier with a delayed maintenance task.
    let releaseBarrier: (() => void) | null = null;
    const maintenance = runExclusiveMaintenance("release", async () => {
      await new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
    });

    let writes = 0;
    setTransportInterceptor(async (op) => {
      writes++;
      return op();
    });

    // Both resolution paths reject and attempt no write: the failure stays
    // retained, and the stored generation is untouched.
    await expect(repo.retrySave("text:t1")).rejects.toThrow(/maintenance/i);
    await expect(
      repo.resolveSaveFailure("text:t1", "overwrite"),
    ).rejects.toThrow(/maintenance/i);
    expect(writes).toBe(0);
    expect(repo.saveFailures()).toHaveLength(1);
    expect((await repo.textContent("t1"))?.content).toBe("v0");

    releaseBarrier!();
    await maintenance;
    setTransportInterceptor(null);

    // The barrier is down: Retry commits the retained payload.
    await repo.retrySave("text:t1");
    expect(repo.saveFailures()).toHaveLength(0);
    expect((await repo.textContent("t1"))?.content).toBe("v1");

    // And Overwrite resolves a new failure once no maintenance is running.
    setTransportInterceptor(() => Promise.reject(new Error("disk gone")));
    repo.textScheduleSave("t1", {
      meta: { ...meta, updatedAt: "u2" },
      content: md("v2"),
    });
    await expect(repo.flushTextSaves()).rejects.toThrow("disk gone");
    setTransportInterceptor(null);
    await repo.resolveSaveFailure("text:t1", "overwrite");
    expect(repo.saveFailures()).toHaveLength(0);
    expect((await repo.textContent("t1"))?.content).toBe("v2");
  });

  it("serializes concurrent maintenance requests", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const first = runExclusiveMaintenance("release", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    });
    await Promise.resolve();
    const second = runExclusiveMaintenance("release", async () => {
      order.push("second");
    });
    // The second request waits until the first releases.
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    releaseFirst!();
    await first;
    await second;
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
