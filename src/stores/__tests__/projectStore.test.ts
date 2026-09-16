import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

import { useProjectStore, flushProjectSave } from "@/stores/projectStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { fakeRepoState, resetFakeRepository } from "../../test/fakeRepository";

beforeEach(async () => {
  await flushProjectSave();
  for (const key of Object.keys(storage)) delete storage[key];
  resetFakeRepository();
  useProjectStore.setState({ projects: [], projectsLoaded: false });
  useLibraryStore.setState({ texts: [], textsLoaded: false });
});

describe("projectStore", () => {
  it("creates a project with a trimmed title and defaults", async () => {
    const id = await useProjectStore.getState().createProject({
      title: "  My Project  ",
      description: "  About texts  ",
    });

    const projects = useProjectStore.getState().projects;
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe(id);
    expect(projects[0].title).toBe("My Project");
    expect(projects[0].description).toBe("About texts");
    expect(fakeRepoState.projects.get(id)?.brief).toBeNull();
  });

  it("updates metadata and stores the brief", async () => {
    const id = await useProjectStore.getState().createProject({ title: "P" });
    await useProjectStore.getState().updateProject(id, {
      defaultAudience: "students",
      briefContent: "The brief body.",
    });

    const entry = fakeRepoState.projects.get(id)!;
    expect(entry.meta.defaultAudience).toBe("students");
    expect(entry.brief).toBe("The brief body.");
    expect(entry.meta.briefWordCount).toBe(3);
  });

  it("clears a default by passing null", async () => {
    const id = await useProjectStore.getState().createProject({ title: "P" });
    await useProjectStore
      .getState()
      .updateProject(id, { defaultAudience: "students" });
    await useProjectStore.getState().updateProject(id, { defaultAudience: null });

    const meta = useProjectStore.getState().projects[0];
    expect(meta.defaultAudience).toBeUndefined();
  });

  it("loading first keeps existing projects on cold-start mutation", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    fakeRepoState.projects.set("p1", {
      meta: {
        id: "p1",
        title: "Existing",
        createdAt: now,
        updatedAt: now,
      },
      brief: null,
      rev: 0,
    });

    await useProjectStore.getState().createProject({ title: "New" });

    expect([...fakeRepoState.projects.keys()]).toContain("p1");
    expect(useProjectStore.getState().projects).toHaveLength(2);
  });

  it("deleteProject removes the project and its brief", async () => {
    const id = await useProjectStore.getState().createProject({ title: "P" });
    await useProjectStore.getState().updateProject(id, { briefContent: "b" });
    await useProjectStore.getState().deleteProject(id);

    expect(useProjectStore.getState().projects).toHaveLength(0);
    expect(fakeRepoState.projects.has(id)).toBe(false);
  });

  it("loads brief content on demand", async () => {
    const id = await useProjectStore.getState().createProject({ title: "P" });
    await useProjectStore.getState().updateProject(id, { briefContent: "abc" });
    expect(await useProjectStore.getState().loadBriefContent(id)).toBe("abc");
  });
});
