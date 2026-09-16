import {
  readTextFile,
  writeTextFile,
  remove,
  mkdir,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";

/**
 * Low-level JSON persistence.
 *
 * Two hard rules (different from earlier versions of this file):
 *
 * 1. The storage backend is decided per environment, once: inside Tauri all
 *    data lives in the app-data directory; in a plain browser it lives in
 *    localStorage. A failing native write is an error, never a silent
 *    detour to localStorage — silent fallbacks produced divergent copies
 *    that resurrected stale content.
 * 2. Operations on the same file are serialized, and `awaitStorageIdle()`
 *    waits for every in-flight write. Shutdown and destructive actions use
 *    it so "flushed" means the bytes are actually written.
 */

export class StorageError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "StorageError";
    this.cause = cause;
  }
}

const BASE = { baseDir: BaseDirectory.AppData } as const;

/** True when running inside Tauri (native fs + invoke available). */
export function hasTauriFs(): boolean {
  return typeof globalThis !== "undefined" && "__TAURI_INTERNALS__" in globalThis;
}

/** Errors from the OS that mean "the file is not there", not "storage broke". */
const MISSING_RE =
  /os error (2|3)\b|no such file|cannot find the file|not found/i;

function isMissingFileError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return MISSING_RE.test(message);
}

// ──────────────────────────────────────────────
// Per-path operation queue
// ──────────────────────────────────────────────

const queues = new Map<string, Promise<void>>();

/**
 * Run `op` after every previously enqueued operation for the same path has
 * settled. Returns the real result (rejections propagate to the caller).
 */
function enqueue<T>(path: string, op: () => Promise<T>): Promise<T> {
  const tail = queues.get(path) ?? Promise.resolve();
  const run = tail.then(op, op) as Promise<T>;
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(path, settled);
  void settled.then(() => {
    if (queues.get(path) === settled) queues.delete(path);
  });
  return run;
}

/** Wait until every queued storage operation has fully settled. */
export async function awaitStorageIdle(): Promise<void> {
  for (;;) {
    const pending = [...queues.values()];
    if (pending.length === 0) return;
    await Promise.all(pending);
  }
}

// ──────────────────────────────────────────────
// App data directory
// ──────────────────────────────────────────────

let ensureDirPromise: Promise<void> | null = null;

/**
 * Make sure the app data directory exists. Without this, first-run writes
 * failed and (historically) pushed data into the localStorage fallback.
 */
export function ensureDataDir(): Promise<void> {
  ensureDirPromise ??= mkdir(".", { ...BASE, recursive: true }).catch((err) => {
    ensureDirPromise = null; // allow a retry on the next write
    throw new StorageError("Could not create the app data directory", err);
  });
  return ensureDirPromise;
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Save a JSON-serializable value to a file inside the app's data directory.
 * Throws `StorageError` when the write fails — callers must not assume
 * success.
 */
export async function saveJson<T>(path: string, data: T): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  if (!hasTauriFs()) {
    localStorage.setItem(`dws:${path}`, json);
    return;
  }
  await enqueue(path, async () => {
    await ensureDataDir();
    try {
      await writeTextFile(path, json, BASE);
    } catch (err) {
      throw new StorageError(`Failed to save ${path}`, err);
    }
  });
}

/**
 * Load a JSON value from a file inside the app's data directory.
 *
 * Returns `null` only when the file does not exist. Corrupt or unreadable
 * files throw `StorageError` — returning null here silently blanked
 * documents on read failures.
 */
export async function loadJson<T>(path: string): Promise<T | null> {
  if (!hasTauriFs()) {
    const raw = localStorage.getItem(`dws:${path}`);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new StorageError(`Corrupt data in local storage: ${path}`, err);
    }
  }
  return enqueue(path, async () => {
    let content: string | null;
    try {
      content = await readTextFile(path, BASE);
    } catch (err) {
      // A missing file is an empty read — NOT an adoption trigger. Legacy
      // browser copies are reconciled exclusively by the verified
      // bootstrap (bootstrap.ts); a silent adopt-on-read could delete the
      // fallback copy before anything validated it.
      if (isMissingFileError(err)) return null;
      throw new StorageError(`Failed to read ${path}`, err);
    }
    if (content == null) return null;
    try {
      return JSON.parse(content) as T;
    } catch (err) {
      throw new StorageError(`Corrupt data file: ${path}`, err);
    }
  });
}

/**
 * Delete a file from the app's data directory. A file that is already gone
 * counts as deleted; any other failure throws.
 */
export async function deleteFile(path: string): Promise<void> {
  if (!hasTauriFs()) {
    localStorage.removeItem(`dws:${path}`);
    return;
  }
  await enqueue(path, async () => {
    try {
      await remove(path, BASE);
    } catch (err) {
      if (isMissingFileError(err)) return;
      throw new StorageError(`Failed to delete ${path}`, err);
    }
  });
}
