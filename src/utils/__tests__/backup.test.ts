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
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  remove: vi.fn(),
  mkdir: vi.fn(),
  BaseDirectory: { AppData: 22 },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  repo,
  beginMaintenance,
  endMaintenance,
} from "@/utils/repository";
import {
  buildBackupBundle,
  parseBackupBundle,
  normalizeDump,
  restoreBackupBundle,
  datasetGeneration,
  type CanonicalDump,
} from "@/utils/backup";
import { CONTENT_SCHEMA_VERSION } from "@/utils/documentCodec";
import {
  setPref,
  pendingPreferenceWrites,
  resetPreferenceState,
} from "@/utils/preferences";
import type { LibraryTextMeta } from "@/types";
import { markdownDocument } from "@/utils/documentCodec";
import fixture from "@/test/backup-contract.json";

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

beforeEach(() => {
  invokeMock.mockReset();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  repo.resetSessionState();
  resetPreferenceState();
  for (const key of Object.keys(storage)) delete storage[key];
});

describe("backup export (browser)", () => {
  it("includes a save that was made immediately before the export", async () => {
    await repo.textCreate(meta, md("v1"));
    // Scheduled (not yet flushed) save — the export barrier drains it.
    repo.textScheduleSave("t1", {
      meta: { ...meta, updatedAt: "u1" },
      content: md("v2"),
    });
    const bundle = await buildBackupBundle();
    expect(bundle.version).toBe(3);
    expect(bundle.data?.textContents[0]?.content).toBe("v2");
  });

  it("never exports a usable credential", async () => {
    localStorage.setItem(
      "dws:pref:config",
      JSON.stringify({ provider: "zen", apiKey: "sekrit" }),
    );
    const bundle = await buildBackupBundle();
    const config = bundle.preferences?.config as { apiKey?: string } | undefined;
    expect(config).toBeDefined();
    expect(config?.apiKey).toBe("");
  });

  it("exports the canonical dataset: sources, proposals, passages, drafts (B21d)", async () => {
    await repo.textCreate(meta, md("v1"));
    await repo.projectCreate({ id: "p1", title: "P", createdAt: "c", updatedAt: "u" });
    await repo.projectSave("p1", {
      meta: { id: "p1", title: "P", createdAt: "c", updatedAt: "u" },
      brief: "the brief",
    });
    await repo.threadCreate({
      id: "th1",
      title: "Thread",
      mode: "text",
      createdAt: "c",
      updatedAt: "u",
    });
    await repo.threadSave("th1", {
      meta: { id: "th1", title: "Thread", mode: "text", createdAt: "c", updatedAt: "u" },
      briefJson: null,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "hi",
          timestamp: "t1",
          failed: false,
          incomplete: null,
          attachmentsJson: null,
        },
      ],
    });
    await repo.sourceCreate(
      {
        id: "s1",
        title: "Source",
        originalText: "source body",
        contentHash: "hash-s1",
        extractionStatus: "ready",
        includedInContext: true,
        verification: "unverified",
        createdAt: "c",
        updatedAt: "u",
      },
      [{ id: "sp1", locator: "p. 1", content: "passage" }],
    );
    await repo.proposalCreate({
      id: "pr1",
      documentId: "t1",
      baseRev: 0,
      requestKind: "revise",
      baseFragment: "a",
      proposedFragment: "b",
      status: "pending",
      createdAt: "c",
      updatedAt: "u",
    });
    localStorage.setItem(
      "dws:pref:recovery-drafts",
      JSON.stringify({ "text:t1": { content: "draft" } }),
    );

    const bundle = await buildBackupBundle();
    expect(bundle.version).toBe(3);
    const data = bundle.data!;
    expect(data.texts.map((t) => t.id)).toEqual(["t1"]);
    expect(data.textContents[0]?.content).toBe("v1");
    expect(data.projectBriefs).toEqual([{ projectId: "p1", content: "the brief" }]);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({ threadId: "th1", idx: 0, content: "hi" });
    expect(data.sources.map((s) => s.id)).toEqual(["s1"]);
    expect(data.sourcePassages[0]).toMatchObject({
      sourceId: "s1",
      id: "sp1",
      content: "passage",
    });
    expect(data.proposals.map((p) => p.id)).toEqual(["pr1"]);
    expect(bundle.preferences?.["recovery-drafts"]).toBeDefined();
    // The written bundle is exactly what the production import parser reads.
    expect(parseBackupBundle(JSON.stringify(bundle))).not.toBeNull();
  });

  it("round-trips export → restore → export identically (browser, B21d)", async () => {
    await repo.textCreate(meta, md("v1"));
    await repo.textSave("t1", {
      meta: { ...meta, updatedAt: "u2" },
      content: md("v2"),
    });
    await repo.projectCreate({ id: "p1", title: "P", createdAt: "c", updatedAt: "u" });
    await repo.projectSave("p1", {
      meta: { id: "p1", title: "P", createdAt: "c", updatedAt: "u" },
      brief: "brief",
    });
    await repo.threadCreate({
      id: "th1",
      title: "Thread",
      mode: "text",
      createdAt: "c",
      updatedAt: "u",
    });
    await repo.threadSave("th1", {
      meta: { id: "th1", title: "Thread", mode: "text", createdAt: "c", updatedAt: "u" },
      briefJson: null,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "hi",
          timestamp: "t1",
          failed: false,
          incomplete: null,
          attachmentsJson: null,
        },
      ],
    });
    const first = await buildBackupBundle();
    await restoreBackupBundle(parseBackupBundle(JSON.stringify(first))!);
    const second = await buildBackupBundle();
    expect(second.data).toEqual(first.data);
    expect(second.preferences).toEqual(first.preferences);
  });

  it("consumes the Rust-generated production dump and re-exports the same shape (B21d)", async () => {
    const parsed = parseBackupBundle(JSON.stringify(fixture.bundle))!;
    await restoreBackupBundle(parsed);
    const reexported = await buildBackupBundle();

    // The SQLite backend's own export re-consumed by the JSON backend and
    // re-exported: identical canonical rows, field for field (table order
    // is not part of the contract, so compare sorted row sets).
    const byKey = <T>(rows: T[], key: (row: T) => string): T[] =>
      [...rows].sort((a, b) => key(a).localeCompare(key(b)));
    const rowSets = (dump: CanonicalDump) => ({
      texts: byKey(dump.texts, (r) => r.id),
      textContents: byKey(dump.textContents, (r) => r.textId),
      textVersions: byKey(dump.textVersions, (r) => `${r.textId}:${r.versionId}`),
      projects: byKey(dump.projects, (r) => r.id),
      projectBriefs: byKey(dump.projectBriefs, (r) => r.projectId),
      sources: byKey(dump.sources, (r) => r.id),
      sourcePassages: byKey(dump.sourcePassages, (r) => r.id),
      proposals: byKey(dump.proposals, (r) => r.id),
      threads: byKey(dump.threads, (r) => r.id),
      threadBriefs: byKey(dump.threadBriefs, (r) => r.threadId),
      messages: byKey(dump.messages, (r) => `${r.threadId}:${r.idx}`),
    });
    expect(rowSets(reexported.data!)).toEqual(rowSets(parsed.data!));
    expect(reexported.preferences).toBeDefined();
    expect(parseBackupBundle(JSON.stringify(reexported))).not.toBeNull();
  });
});

/** A canonical v3 dump (production/Rust shape: message rows flattened). */
function canonicalDump(): CanonicalDump {
  return {
    texts: [
      {
        id: "t1",
        title: "T",
        textType: "essay",
        folder: null,
        projectId: null,
        snippet: null,
        wordCount: null,
        rev: 0,
        archived: false,
        pinned: false,
        createdAt: "c",
        updatedAt: "u",
      },
    ],
    textContents: [
      {
        textId: "t1",
        content: "body",
        contentFormat: "markdown",
        contentSchemaVersion: 1,
        plainText: null,
      },
    ],
    textVersions: [],
    projects: [],
    projectBriefs: [],
    sources: [],
    sourcePassages: [],
    proposals: [],
    threads: [
      {
        id: "th1",
        title: "Thread",
        mode: "text",
        projectId: null,
        folder: null,
        references: null,
        rev: 0,
        archived: false,
        pinned: false,
        createdAt: "c",
        updatedAt: "u",
      },
    ],
    threadBriefs: [],
    messages: [
      {
        threadId: "th1",
        idx: 0,
        id: "m1",
        role: "user",
        content: "hi",
        timestamp: "t1",
        failed: false,
        incomplete: null,
        attachmentsJson: null,
      },
    ],
    folders: [],
  };
}

/** Wrap a dump in a v3 bundle envelope with a fixed exportedAt. */
function bundleJson(data: unknown, preferences: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: "decol-writing-support-backup",
    version: 3,
    exportedAt: "2026-01-01T00:00:00.000Z",
    data,
    preferences,
  });
}

describe("backup validation (canonical dump)", () => {
  it("accepts a canonical v3 bundle", () => {
    const parsed = parseBackupBundle(bundleJson(canonicalDump()));
    expect(parsed).not.toBeNull();
    expect(parsed!.data).toEqual(canonicalDump());
  });

  it("requires an INTEGER supported backup version", () => {
    const base = JSON.parse(bundleJson(canonicalDump()));
    for (const version of [0, 4, 1.5, "3", null]) {
      const raw = JSON.stringify({ ...base, version });
      expect(parseBackupBundle(raw), `version ${JSON.stringify(version)}`).toBeNull();
    }
  });

  it("rejects a v3 bundle that carries a credential", () => {
    const raw = bundleJson(canonicalDump(), { config: { apiKey: "sekrit" } });
    expect(parseBackupBundle(raw)).toBeNull();
  });

  it("rejects an unknown incomplete marker and accepts the real ones (schema v12)", () => {
    const unknown = canonicalDump();
    unknown.messages[0].incomplete = "mystery" as never;
    expect(parseBackupBundle(bundleJson(unknown))).toBeNull();

    const truncated = canonicalDump();
    truncated.messages[0].incomplete = "truncated";
    const parsed = parseBackupBundle(bundleJson(truncated));
    expect(parsed).not.toBeNull();
    expect(parsed!.data!.messages[0].incomplete).toBe("truncated");
  });

  it("rejects a dump with duplicate row ids", () => {
    const data = canonicalDump();
    data.texts = [data.texts[0], data.texts[0]];
    expect(parseBackupBundle(bundleJson(data))).toBeNull();
  });

  it("rejects duplicate composite identities", () => {
    // message position (threadId, idx)
    const messages = canonicalDump();
    messages.messages = [messages.messages[0], { ...messages.messages[0], content: "dup" }];
    expect(parseBackupBundle(bundleJson(messages))).toBeNull();

    // two content rows for one text
    const contents = canonicalDump();
    contents.textContents = [contents.textContents[0], { ...contents.textContents[0] }];
    expect(parseBackupBundle(bundleJson(contents))).toBeNull();

    // two briefs for one thread
    const briefs = canonicalDump();
    briefs.threadBriefs = [
      { threadId: "th1", briefJson: null },
      { threadId: "th1", briefJson: '{"topic":"x"}' },
    ];
    expect(parseBackupBundle(bundleJson(briefs))).toBeNull();
  });

  it("rejects a dump whose content rows reference unknown texts", () => {
    const data = canonicalDump();
    data.textContents = [{ ...data.textContents[0], textId: "ghost" }];
    expect(parseBackupBundle(bundleJson(data))).toBeNull();
  });

  it("accepts folder registry rows and rejects duplicates or unknown scopes", () => {
    // A standalone folder and a project folder for the dump's project.
    const withProject = canonicalDump();
    withProject.projects = [
      {
        id: "p1",
        title: "P",
        description: null,
        defaultAudience: null,
        defaultTone: null,
        defaultCitations: null,
        defaultLanguage: null,
        references: null,
        briefWordCount: null,
        rev: 0,
        createdAt: "c",
        updatedAt: "u",
      },
    ];
    withProject.folders = [
      {
        id: "f1",
        scope: "",
        name: "Essays",
        createdAt: "c",
        updatedAt: "u",
      },
      {
        id: "f2",
        scope: "p1",
        name: "Drafts",
        createdAt: "c",
        updatedAt: "u",
      },
    ];
    expect(parseBackupBundle(bundleJson(withProject))).not.toBeNull();

    // Duplicate (scope, name) identity.
    const duplicate = canonicalDump();
    duplicate.folders = [
      {
        id: "f1",
        scope: "",
        name: "Essays",
        createdAt: "c",
        updatedAt: "u",
      },
      {
        id: "f2",
        scope: "",
        name: "Essays",
        createdAt: "c",
        updatedAt: "u",
      },
    ];
    expect(parseBackupBundle(bundleJson(duplicate))).toBeNull();

    // A project-scoped folder pointing at no project in the dump.
    const orphanScope = canonicalDump();
    orphanScope.folders = [
      {
        id: "f1",
        scope: "ghost-project",
        name: "Essays",
        createdAt: "c",
        updatedAt: "u",
      },
    ];
    expect(parseBackupBundle(bundleJson(orphanScope))).toBeNull();
  });

  it("rejects a dump whose rows reference unknown parents", () => {
    const ghostMessage = canonicalDump();
    ghostMessage.messages = [{ ...ghostMessage.messages[0], threadId: "ghost" }];
    expect(parseBackupBundle(bundleJson(ghostMessage))).toBeNull();

    const ghostVersion = canonicalDump();
    ghostVersion.textVersions = [
      {
        textId: "ghost",
        versionId: "v1",
        savedAt: "s",
        content: "c",
        contentFormat: null,
        contentSchemaVersion: null,
        plainText: null,
        label: null,
      },
    ];
    expect(parseBackupBundle(bundleJson(ghostVersion))).toBeNull();

    const ghostProposal = canonicalDump();
    ghostProposal.proposals = [
      {
        id: "pr1",
        documentId: "ghost",
        baseRev: 0,
        requestKind: "revise",
        baseFragment: "a",
        proposedFragment: "b",
        selFrom: null,
        selTo: null,
        contextNote: null,
        status: "pending",
        createdAt: "c",
        updatedAt: "u",
      },
    ];
    expect(parseBackupBundle(bundleJson(ghostProposal))).toBeNull();
  });

  it("rejects an unsupported content-schema version", () => {
    const data = canonicalDump();
    data.textContents = [
      {
        ...data.textContents[0],
        contentSchemaVersion: CONTENT_SCHEMA_VERSION + 1,
      },
    ];
    expect(parseBackupBundle(bundleJson(data))).toBeNull();
  });

  it("rejects an unknown content format", () => {
    const data = canonicalDump();
    const row = data.textContents[0] as { contentFormat: unknown };
    row.contentFormat = "latex";
    expect(parseBackupBundle(bundleJson(data))).toBeNull();
  });

  it("rejects malformed message attachments", () => {
    const notJson = canonicalDump();
    notJson.messages = [{ ...notJson.messages[0], attachmentsJson: "{oops" }];
    expect(parseBackupBundle(bundleJson(notJson))).toBeNull();

    const notArray = canonicalDump();
    notArray.messages = [{ ...notArray.messages[0], attachmentsJson: '{"name":"f.txt"}' }];
    expect(parseBackupBundle(bundleJson(notArray))).toBeNull();
  });

  it("rejects malformed field types and unknown enum values", () => {
    const badRole = canonicalDump();
    (badRole.messages[0] as { role: unknown }).role = "system";
    expect(parseBackupBundle(bundleJson(badRole))).toBeNull();

    const badStatus = canonicalDump();
    badStatus.proposals = [
      {
        id: "pr1",
        documentId: "t1",
        baseRev: 0,
        requestKind: "revise",
        baseFragment: "a",
        proposedFragment: "b",
        selFrom: null,
        selTo: null,
        contextNote: null,
        status: "maybe",
        createdAt: "c",
        updatedAt: "u",
      } as unknown as CanonicalDump["proposals"][number],
    ];
    expect(parseBackupBundle(bundleJson(badStatus))).toBeNull();

    const badAttachments = canonicalDump();
    (badAttachments.messages[0] as { content: unknown }).content = 42;
    expect(parseBackupBundle(bundleJson(badAttachments))).toBeNull();
  });

  it("converts historical nested message/passage rows explicitly", () => {
    const data = canonicalDump();
    const historical: CanonicalDump = {
      ...data,
      sources: [
        {
          id: "s1",
          projectId: null,
          title: "S",
          author: null,
          year: null,
          doi: null,
          url: null,
          language: null,
          translation: null,
          assetRef: null,
          originalText: "text",
          contentHash: "hash-1",
          extractionStatus: "ready",
          truncationNote: null,
          includedInContext: true,
          notes: null,
          verification: "unverified",
          rev: 0,
          createdAt: "c",
          updatedAt: "u",
        },
      ],
      messages: [
        {
          threadId: "th1",
          idx: 0,
          message: { role: "user", content: "hi", timestamp: "t1" },
        },
      ],
      sourcePassages: [
        {
          sourceId: "s1",
          passage: { id: "sp1", locator: null, content: "a passage" },
        },
      ],
    } as unknown as CanonicalDump;
    // The old nested shape carried no `failed`; conversion supplies the
    // serde default rather than rejecting the historical bundle.
    const normalized = normalizeDump(historical);
    expect(normalized).not.toBeNull();
    expect(normalized!.messages[0]).toEqual({
      threadId: "th1",
      idx: 0,
      id: null,
      role: "user",
      content: "hi",
      timestamp: "t1",
      failed: false,
      incomplete: null,
      attachmentsJson: null,
    });
    expect(normalized!.sourcePassages[0]).toEqual({
      sourceId: "s1",
      id: "sp1",
      locator: null,
      content: "a passage",
    });
    // An unknown source parent is still rejected after conversion.
    expect(
      normalizeDump({
        ...historical,
        sourcePassages: [
          { sourceId: "ghost", passage: { id: "sp1", locator: null, content: "x" } },
        ],
      }),
    ).toBeNull();
  });
});

describe("shared Rust backup fixture (B01)", () => {
  it("parses the Rust-generated production export and preserves every row", () => {
    const parsed = parseBackupBundle(JSON.stringify(fixture.bundle));
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(3);
    // Canonicalization is identity for a canonical bundle: no row, field,
    // or value is dropped by the production import parser.
    expect(parsed!.data).toEqual(fixture.bundle.data);
  });

  it("keeps flattened production rows (regression: nested-only parser)", () => {
    const parsed = parseBackupBundle(JSON.stringify(fixture.bundle))!;
    const message = parsed.data!.messages[0];
    expect(message.threadId).toBe("th-1");
    expect(message.role).toBe("user");
    expect(message.attachmentsJson).toContain("fieldnotes.txt");
    expect("message" in message).toBe(false);
    const passage = parsed.data!.sourcePassages[0];
    expect(passage.sourceId).toBe("s-1");
    expect("passage" in passage).toBe(false);
    expect(parsed.data!.proposals).toHaveLength(2);
  });

  it("converts the historical nested form of the same fixture to canonical", () => {
    const data = fixture.bundle.data;
    const nested = {
      ...data,
      messages: data.messages.map(({ threadId, idx, ...message }) => ({
        threadId,
        idx,
        message,
      })),
      sourcePassages: data.sourcePassages.map(({ sourceId, ...passage }) => ({
        sourceId,
        passage,
      })),
    };
    const parsed = parseBackupBundle(
      JSON.stringify({ ...fixture.bundle, data: nested }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.data).toEqual(data);
  });
});

describe("desktop export path (B01)", () => {
  const preferences = fixture.bundle.preferences as Record<string, unknown>;

  function mockDesktopExport(dump: unknown) {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "db_export") return dump;
      if (cmd === "db_prefs_get_all") {
        return Object.entries(preferences).map(([key, value]) => ({
          key,
          value: JSON.stringify(value),
        }));
      }
      return null;
    });
  }

  it("exports a bundle the production parser accepts", async () => {
    mockDesktopExport(fixture.bundle.data);
    const bundle = await buildBackupBundle();
    expect(bundle.version).toBe(3);
    expect(bundle.data).toEqual(fixture.bundle.data);
    // Credentials are stripped on this path too.
    const config = bundle.preferences?.config as { apiKey?: string };
    expect(config.apiKey).toBe("");
    // The written file is exactly what the import parser reads.
    expect(parseBackupBundle(JSON.stringify(bundle))).not.toBeNull();
  });

  it("aborts the export instead of writing an unimportable file", async () => {
    const broken = {
      ...fixture.bundle.data,
      messages: [{ ...fixture.bundle.data.messages[0], threadId: "ghost" }],
    };
    mockDesktopExport(broken);
    await expect(buildBackupBundle()).rejects.toThrow(/failed backup validation/i);
  });

  it("drains a delayed preference write before reading the bundle (F04)", async () => {
    const prefsMap = new Map<string, string>(
      Object.entries(preferences).map(([key, value]) => [
        key,
        JSON.stringify(value),
      ]),
    );
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    let releasePref: (() => void) | null = null;
    invokeMock.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "db_export") return fixture.bundle.data;
        if (cmd === "db_prefs_get_all") {
          return [...prefsMap.entries()].map(([key, value]) => ({ key, value }));
        }
        if (cmd === "db_prefs_set") {
          // Delayed transport: the value lands only when released.
          await new Promise<void>((resolve) => {
            releasePref = () => {
              prefsMap.set(String(args.key), String(args.value));
              resolve();
            };
          });
          return null;
        }
        return null;
      },
    );

    const write = setPref("f04-probe", { value: "pending" });
    await vi.waitFor(() => expect(releasePref).not.toBeNull());
    expect(pendingPreferenceWrites()).toBe(1);

    const exportPromise = buildBackupBundle();
    // Let the export reach its drain while the preference write is held.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releasePref!();
    await write;

    const bundle = await exportPromise;
    // The delayed value was awaited and is IN the bundle; the app never
    // reports a write pending that the export silently omitted.
    expect(bundle.preferences?.["f04-probe"]).toEqual({ value: "pending" });
  });

  it("writes a pre-restore recovery snapshot the import parser accepts", async () => {
    const { writeTextFile, mkdir } = await import("@tauri-apps/plugin-fs");
    (mkdir as Mock).mockResolvedValue(undefined);
    const writes: { path: string; data: string }[] = [];
    (writeTextFile as Mock).mockImplementation(
      async (path: string, data: string) => {
        writes.push({ path, data: String(data) });
      },
    );
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "db_export") return fixture.bundle.data;
      if (cmd === "db_prefs_get_all") {
        return Object.entries(preferences).map(([key, value]) => ({
          key,
          value: JSON.stringify(value),
        }));
      }
      if (cmd === "db_restore") {
        return {
          texts: 1,
          projects: 0,
          threads: 0,
          messages: 0,
          versions: 0,
          sources: 0,
          sourcePassages: 0,
        };
      }
      return null;
    });

    const bundle = parseBackupBundle(JSON.stringify(fixture.bundle))!;
    await restoreBackupBundle(bundle);

    const snapshot = writes.find((w) => w.path.startsWith("pre-restore-"));
    expect(snapshot).toBeDefined();
    // The recovery artifact is a normal v3 envelope: directly importable,
    // with the current documents AND preferences (recovery drafts included).
    const parsed = parseBackupBundle(snapshot!.data);
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(3);
    expect(parsed!.data).toEqual(fixture.bundle.data);
    expect(parsed!.preferences?.["recovery-drafts"]).toBeDefined();
  });

  it("a desktop v1 restore converts through a scratch directory, never live files", async () => {
    const { writeTextFile, mkdir, remove } = await import("@tauri-apps/plugin-fs");
    (mkdir as Mock).mockResolvedValue(undefined);
    (remove as Mock).mockResolvedValue(undefined);
    const writes: string[] = [];
    (writeTextFile as Mock).mockImplementation(async (path: string) => {
      writes.push(String(path));
    });
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "db_export") return fixture.bundle.data;
      if (cmd === "db_prefs_get_all") return [];
      if (cmd === "db_import_legacy_at") {
        return {
          completed: true,
          alreadyOpen: false,
          counts: { texts: 1, projects: 0, threads: 0, messages: 0, versions: 0 },
          issues: [],
          archivedDir: null,
        };
      }
      return null;
    });

    const bundle = parseBackupBundle(
      JSON.stringify({
        format: "decol-writing-support-backup",
        version: 1,
        exportedAt: "x",
        files: {
          "library.json": [meta],
          [`text_${meta.id}.json`]: { content: "v1 body" },
        },
      }),
    )!;
    const counts = await restoreBackupBundle(bundle);
    expect(counts.files).toBe(2);
    // The chosen content was applied through the VALIDATED import.
    expect(invokeMock).toHaveBeenCalledWith("db_import_legacy_at", {
      dir: expect.stringContaining("v1-restore-"),
      clear: true,
    });
    // Nothing was written into live storage: only the recovery snapshot
    // and the scratch conversion directory were touched.
    expect(writes.length).toBeGreaterThan(0);
    expect(
      writes.every(
        (path) => path.startsWith("pre-restore-") || path.startsWith("v1-restore-"),
      ),
    ).toBe(true);
  });
});

describe("backup restore (browser)", () => {
  it("still rejects a v2 desktop bundle before changing anything", async () => {
    await repo.textCreate(meta, md("v1"));
    const bundle = parseBackupBundle(
      JSON.stringify({
        format: "decol-writing-support-backup",
        version: 2,
        exportedAt: "x",
        db: canonicalDump(),
        files: {},
      }),
    )!;
    await expect(restoreBackupBundle(bundle)).rejects.toThrow(/desktop app/i);
    // Nothing changed.
    expect((await repo.textContent("t1"))?.content).toBe("v1");
  });

  it("restores a canonical v3 dump in the browser (B21d)", async () => {
    await repo.textCreate(meta, md("live v1"));
    localStorage.setItem("dws:pref:stale", JSON.stringify({ gone: true }));
    const data = canonicalDump();
    data.textContents = [
      {
        textId: "t1",
        content: "restored body",
        contentFormat: "markdown",
        contentSchemaVersion: 1,
        plainText: null,
      },
    ];
    const bundle = parseBackupBundle(
      bundleJson(data, { appearance: { theme: "dark" } }),
    )!;
    const counts = await restoreBackupBundle(bundle);

    expect(counts.texts).toBe(1);
    expect(counts.messages).toBe(1);
    expect((await repo.textContent("t1"))?.content).toBe("restored body");
    const threads = await repo.threadGet("th1");
    expect(threads?.messages[0]?.content).toBe("hi");
    // Preferences are REPLACED (like db_restore), not merged.
    expect(storage["dws:pref:stale"]).toBeUndefined();
    expect(JSON.parse(storage["dws:pref:appearance"])).toEqual({ theme: "dark" });
  });

  it("an older dump replaces newer live bodies and omits nothing (B21d)", async () => {
    // Newer live dataset: t1 with a newer body, plus a text the dump omits.
    await repo.textCreate(meta, md("live v1"));
    await repo.textSave("t1", {
      meta: { ...meta, updatedAt: "u2" },
      content: md("live v2"),
    });
    await repo.textCreate({ ...meta, id: "t2" }, md("omitted newer body"));

    const data = canonicalDump();
    data.textContents = [
      {
        textId: "t1",
        content: "restored old",
        contentFormat: "markdown",
        contentSchemaVersion: 1,
        plainText: null,
      },
    ];
    const bundle = parseBackupBundle(bundleJson(data))!;
    const counts = await restoreBackupBundle(bundle);

    expect(counts.texts).toBe(1);
    const texts = await repo.textsList();
    expect(texts.map((t) => t.id)).toEqual(["t1"]);
    expect((await repo.textContent("t1"))?.content).toBe("restored old");
    // The newer omitted body must not survive anywhere.
    expect(storage["dws:text_t2.json"]).toBeUndefined();
    expect(storage["dws:text_t2.versions.json"]).toBeUndefined();
    expect(storage["dws:library.json"]).not.toContain("t2");
  });

  it("heals a null body format to markdown, like the desktop restore (B21d)", async () => {
    const data = canonicalDump();
    data.textContents = [
      {
        textId: "t1",
        content: "plain",
        contentFormat: null,
        contentSchemaVersion: 1,
        plainText: null,
      },
    ];
    const bundle = parseBackupBundle(bundleJson(data))!;
    await restoreBackupBundle(bundle);

    // `db_restore` COALESCEs a null format to markdown; the browser must
    // store a body both backends can read (a null format with schema 1
    // makes decodeDocumentBody throw).
    const body = await repo.textContent("t1");
    expect(body?.contentFormat).toBe("markdown");
    expect(body?.contentSchemaVersion).toBe(1);
    expect(body?.content).toBe("plain");
  });

  it("removes same-id content the restored dump does not carry (B21d)", async () => {
    await repo.textCreate(meta, md("live body"));
    const data = canonicalDump();
    data.textContents = [];
    const bundle = parseBackupBundle(bundleJson(data))!;
    await restoreBackupBundle(bundle);

    // The text survives as a row, but its live body is gone: the dump did
    // not carry it.
    expect((await repo.textsList()).map((t) => t.id)).toEqual(["t1"]);
    expect(storage["dws:text_t1.json"]).toBeUndefined();
  });

  it("a failed restore releases the barrier and keeps the app working", async () => {
    await repo.textCreate(meta, md("v1"));
    // The restore fails mid-way (storage write fails): the maintenance
    // barrier must come down, not leak.
    const setItemSpy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });
    const bundle = parseBackupBundle(
      JSON.stringify({
        format: "decol-writing-support-backup",
        version: 1,
        exportedAt: "x",
        files: { "library.json": [meta] },
      }),
    )!;
    await expect(restoreBackupBundle(bundle)).rejects.toThrow("quota exceeded");
    setItemSpy.mockRestore();
    // Normal saving works again afterwards.
    await repo.textSave("t1", { meta: { ...meta, updatedAt: "u2" }, content: md("v2") });
    expect((await repo.textContent("t1"))?.content).toBe("v2");
  });

  it("saves scheduled during a restore are discarded, not applied afterwards", async () => {
    await repo.textCreate(meta, md("v1"));
    beginMaintenance();
    repo.textScheduleSave("t1", {
      meta: { ...meta, updatedAt: "u2" },
      content: md("PRE-RESTORE"),
    });
    endMaintenance("discard");
    // The held pre-restore draft never lands.
    expect((await repo.textContent("t1"))?.content).toBe("v1");
  });

  it("saves scheduled during an export are released afterwards", async () => {
    await repo.textCreate(meta, md("v1"));
    beginMaintenance();
    repo.textScheduleSave("t1", {
      meta: { ...meta, updatedAt: "u2" },
      content: md("v2"),
    });
    // Release re-schedules the held save (debounced, as any edit).
    endMaintenance("release");
    await repo.flushTextSaves();
    expect((await repo.textContent("t1"))?.content).toBe("v2");
  });

  it("a v1 restore replaces domain files and never flushes pre-restore state afterwards", async () => {
    await repo.textCreate(meta, md("v1"));
    const bundle = parseBackupBundle(
      JSON.stringify({
        format: "decol-writing-support-backup",
        version: 1,
        exportedAt: "x",
        files: {
          "library.json": [meta],
          [`text_${meta.id}.json`]: { content: "restored body" },
        },
      }),
    )!;
    const counts = await restoreBackupBundle(bundle);
    expect(counts.files).toBe(2);
    expect((await repo.textContent("t1"))?.content).toBe("restored body");
    // Generation bumped.
    expect(datasetGeneration()).toBeGreaterThan(1);
  });
});
