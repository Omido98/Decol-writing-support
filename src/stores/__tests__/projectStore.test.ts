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

import {
  writeTextFile,
  readTextFile,
  remove,
} from "@tauri-apps/plugin-fs";
import { useProjectStore, flushProjectSave } from "@/stores/projectStore";
import { useLibraryStore } from "@/stores/libraryStore";

const writeMock = writeTextFile as Mock;
const readMock = readTextFile as Mock;
const removeMock = remove as Mock;

/** Simulate the disk: readTextFile serves what writeTextFile stored. */
function useFakeDisk() {
  const files = new Map<string, string>();
  writeMock.mockImplementation(
    async (path: string, content: string) => void files.set(path, content),
  );
  readMock.mockImplementation(async (path: string) => {
    const content = files.get(path);
    if (content === undefined) throw new Error("not found");
    return content;
  });
  removeMock.mockImplementation(
    async (path: string) => void files.delete(path),
  );
  return files;
}

beforeEach(async () => {
  await flushProjectSave();
  vi.clearAllMocks();
  for (const key of Object.keys(storage)) delete storage[key];
  useProjectStore.setState({ projects: [], projectsLoaded: false });
  useLibraryStore.setState({ texts: [], textsLoaded: false });
});

describe("projectStore", () => {
  it("creates a project with a trimmed title and defaults", async () => {
    useFakeDisk();
    const id = await useProjectStore.getState().createProject({
      title: "  Extractivism essays  ",
      description: "  A series on extraction  ",
    });

    const projects = useProjectStore.getState().projects;
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe(id);
    expect(projects[0].title).toBe("Extractivism essays");
    expect(projects[0].description).toBe("A series on extraction");
  });

  it("saves brief content with meta and loads it back", async () => {
    const files = useFakeDisk();
    const id = await useProjectStore.getState().createProject({ title: "P" });

    await useProjectStore.getState().updateProject(id, {
      briefContent: "Purpose: test the brief.",
    });

    const meta = useProjectStore.getState().projects[0];
    expect(meta.briefWordCount).toBe(4);

    // The debounced save is pending: the cache serves the latest content.
    expect(await useProjectStore.getState().loadBriefContent(id)).toBe(
      "Purpose: test the brief.",
    );
    await flushProjectSave();
    expect(JSON.parse(files.get(`project_${id}.json`) ?? "{}")).toEqual({
      content: "Purpose: test the brief.",
    });
  });

  it("sets defaults and clears them with null", async () => {
    useFakeDisk();
    const id = await useProjectStore.getState().createProject({ title: "P" });

    await useProjectStore.getState().updateProject(id, {
      defaultAudience: "academics",
      defaultTone: "academic",
      defaultCitations: "apa",
      defaultLanguage: "English",
    });
    let meta = useProjectStore.getState().projects[0];
    expect(meta.defaultAudience).toBe("academics");
    expect(meta.defaultTone).toBe("academic");
    expect(meta.defaultCitations).toBe("apa");
    expect(meta.defaultLanguage).toBe("English");

    await useProjectStore.getState().updateProject(id, {
      defaultTone: null,
      defaultLanguage: null,
    });
    meta = useProjectStore.getState().projects[0];
    expect(meta.defaultAudience).toBe("academics");
    expect(meta.defaultTone).toBeUndefined();
    expect(meta.defaultLanguage).toBeUndefined();
  });

  it("deleting a project removes the brief file", async () => {
    const files = useFakeDisk();
    const id = await useProjectStore.getState().createProject({ title: "P" });
    await useProjectStore.getState().updateProject(id, { briefContent: "x" });
    await flushProjectSave();

    await useProjectStore.getState().deleteProject(id);

    expect(useProjectStore.getState().projects).toHaveLength(0);
    expect(files.has(`project_${id}.json`)).toBe(false);
  });

  it("library texts can join and leave a project", async () => {
    useFakeDisk();
    const projectId = await useProjectStore.getState().createProject({
      title: "P",
    });
    const textId = await useLibraryStore.getState().createText({
      title: "T",
      content: "body",
      projectId,
    });
    expect(
      useLibraryStore.getState().texts[0].projectId,
    ).toBe(projectId);

    // Leaving the project: back to standalone.
    await useLibraryStore.getState().updateText(textId, { projectId: "" });
    expect(
      useLibraryStore.getState().texts[0].projectId,
    ).toBeUndefined();
  });
});
