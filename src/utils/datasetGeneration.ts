import { useSyncExternalStore } from "react";

/**
 * Dataset generation: a reactive counter bumped after every successful
 * dataset replacement (backup restore). Mounted views key off it so a
 * restored dataset ALWAYS replaces what was on screen, and stale async
 * loads (started before the swap) can detect that their result belongs to
 * a previous generation and must not repopulate current state.
 */

let generation = 1;
const listeners = new Set<(generation: number) => void>();

export function datasetGeneration(): number {
  return generation;
}

/** Bump the generation (done by every successful restore). */
export function bumpDatasetGeneration(): void {
  generation++;
  for (const listener of [...listeners]) listener(generation);
}

export function subscribeDatasetGeneration(
  listener: (generation: number) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React: re-render when the dataset is replaced. */
export function useDatasetGeneration(): number {
  return useSyncExternalStore(
    (listener) => subscribeDatasetGeneration(listener),
    datasetGeneration,
    datasetGeneration,
  );
}
