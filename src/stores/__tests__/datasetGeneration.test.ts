import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/utils/repository", () => ({
  repo: { textContent: vi.fn() },
}));

import { useLibraryStore } from "@/stores/libraryStore";
import {
  bumpDatasetGeneration,
  datasetGeneration,
} from "@/utils/datasetGeneration";
import { markdownDocument } from "@/utils/documentCodec";

beforeEach(async () => {
  const repoMock = (await import("@/utils/repository")).repo as unknown as {
    textContent: Mock;
  };
  repoMock.textContent.mockReset();
});

describe("dataset generation guards (B07)", () => {
  it("a body read that spans a dataset replacement returns the restored body", async () => {
    const repoMock = (await import("@/utils/repository")).repo as unknown as {
      textContent: Mock;
    };
    let resolveOld: (value: unknown) => void = () => {};
    repoMock.textContent
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(async () => markdownDocument("restored body"));

    const id = `doc-${datasetGeneration()}-stale-read`;
    const loading = useLibraryStore.getState().loadTextContent(id);
    // The dataset is replaced while the read is in flight.
    bumpDatasetGeneration();
    resolveOld(markdownDocument("old body"));

    const body = await loading;
    expect(body.content).toBe("restored body");
    // The stale result was NOT cached: a fresh load serves the restored
    // body from the cache without another read.
    const second = await useLibraryStore.getState().loadTextContent(id);
    expect(second.content).toBe("restored body");
    expect(repoMock.textContent).toHaveBeenCalledTimes(2);
  });
});
