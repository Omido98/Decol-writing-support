import { invoke } from "@tauri-apps/api/core";
import {
  ensureDataDir,
  loadJson,
  saveJson,
  hasTauriFs,
} from "@/utils/storage";
import {
  mkdir,
  writeTextFile,
  remove,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";
import { setPrefPrivileged } from "@/utils/preferences";

/**
 * One-time storage bootstrap, awaited before any store loads data.
 *
 * Inside Tauri this walks the legacy stack forward so nothing is lost:
 * 1. make sure the app data directory exists;
 * 2. inventory the browser-fallback copies (`dws:*` keys) and adopt each
 *    one — but NEVER at the cost of destroying data: a copy is only
 *    removed after a verified equal native write, conflicts are preserved
 *    on both sides and reported, and malformed copies are kept in place
 *    and reported;
 * 3. `db_init` opens the SQLite database and runs the validated one-time
 *    legacy JSON import (its report is returned for the startup UI).
 *
 * The bootstrap is retried after a failure: a failed run leaves every raw
 * input in place (no completion marker, no archive) so the next launch —
 * or the Retry button on the startup error screen — re-attempts it.
 *
 * In a plain browser dev session there is nothing to bootstrap: the JSON
 * repository keeps using localStorage directly.
 */

export interface MigrationIssue {
  path: string;
  kind: string; // "malformed" | "unreadable" | "orphan" | "invalid-record"
  detail: string;
}

export interface MigrationReport {
  completed: boolean;
  alreadyOpen?: boolean;
  counts: {
    texts: number;
    projects: number;
    threads: number;
    messages: number;
    versions: number;
  };
  issues: MigrationIssue[];
  archivedDir: string | null;
}

export interface BootstrapIssue {
  path: string;
  kind: "malformed" | "unreadable" | "conflict" | "adopt-failed" | "unimportable";
  detail: string;
}

export interface BootstrapResult {
  /** Report from the native legacy-JSON migration (undefined in browser). */
  migration: MigrationReport | null;
  /** Problems found while reconciling the browser fallback copies. */
  issues: BootstrapIssue[];
  /** Number of `dws:*` copies safely adopted or deduplicated. */
  adopted: number;
}

let bootstrapPromise: Promise<BootstrapResult> | null = null;

export function bootstrapStorage(): Promise<BootstrapResult> {
  bootstrapPromise ??= run()
    .then((result) => {
      if (result.migration && !result.migration.completed) {
        // An incomplete migration must be RETRYABLE after the input is
        // corrected: the result is not cached.
        bootstrapPromise = null;
      }
      return result;
    })
    .catch((err) => {
      bootstrapPromise = null; // allow retry after a failed bootstrap
      throw err;
    });
  return bootstrapPromise;
}

/** Test seam: forget the cached run so the next call re-executes. */
export function resetBootstrap(): void {
  bootstrapPromise = null;
}

/** Entity files related to a conflicting registry (the browser copy must
 * be applied COMPLETELY, not just the registry metadata). */
function relatedEntityFiles(path: string, parsed: unknown): string[] {
  if (!Array.isArray(parsed)) return [];
  const ids = parsed
    .map((row) =>
      row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string"
        ? ((row as { id: string }).id)
        : null,
    )
    .filter((id): id is string => id != null);
  if (path === "library.json") {
    return ids.flatMap((id) => [`text_${id}.json`, `text_${id}.versions.json`]);
  }
  if (path === "threads.json") {
    return ids.map((id) => `chat_${id}.json`);
  }
  if (path === "projects.json") {
    return ids.map((id) => `project_${id}.json`);
  }
  return [];
}

function stripSecrets(value: unknown): unknown {
  if (value && typeof value === "object" && "apiKey" in (value as object)) {
    return { ...(value as object), apiKey: "" };
  }
  return value;
}

/**
 * Paths whose `dws:` copy the native app can actually consume: the Rust
 * legacy importer's registries + entity files (see `LEGACY_REGISTRY_FILES`
 * and the `text_`/`project_`/`chat_` readers), plus the settings files the
 * preference migration reads. Anything else (sources.json, proposals.json,
 * source/passages files, unknown paths) can NEVER be imported by the
 * desktop app: adopting one would write an orphan native file AND delete
 * the only copy (#F05), so it is preserved and reported instead.
 */
function isNativelyConsumablePath(path: string): boolean {
  if (path === "config.json" || path === "settings.json" || path === "zen-prices.json") {
    return true;
  }
  if (path === "library.json" || path === "projects.json" || path === "threads.json") {
    return true;
  }
  return /^(text|project|chat)_[^/\\]+\.json$/.test(path);
}

/**
 * Resolve one conflicting browser copy (R4 note; B08): the user chooses
 * the winner explicitly. The ACTIVE repository is what changes:
 * - domain registries are applied to SQLite through the validated legacy
 *   import (verified before commit) instead of overwriting obsolete JSON
 *   files the database no longer reads;
 * - settings files become preferences (the live configuration);
 * - `native` keeps the active dataset and deletes the browser copy.
 * The recovery copy is removed ONLY after the chosen content is verified
 * in the active repository; a failure changes nothing.
 */
export async function resolveConflict(
  path: string,
  winner: "native" | "browser",
): Promise<boolean> {
  if (!hasTauriFs()) return false;
  // F05: an unconsumable copy is never deleted — neither "winner" can
  // apply it to the active dataset, so resolving would only destroy it.
  if (!isNativelyConsumablePath(path)) return false;
  const key = `dws:${path}`;
  if (winner === "native") {
    if (localStorage.getItem(key) == null) return false;
    localStorage.removeItem(key);
    return true;
  }
  const raw = localStorage.getItem(key);
  if (raw == null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // malformed copy: nothing to adopt (it stays reported)
  }

  // Settings: apply to the live preferences.
  if (path === "config.json" || path === "settings.json" || path === "zen-prices.json") {
    try {
      await setPrefPrivileged(
        path.replace(/\.json$/, ""),
        stripSecrets(parsed),
      );
      localStorage.removeItem(key);
      return true;
    } catch {
      return false; // the copy stays in place
    }
  }

  // Domain registries: import the chosen browser copy into the active
  // SQLite dataset in one verified transaction, from a scratch directory
  // (the live files are never written).
  const scratch = `conflict-import-${Date.now()}`;
  const related = relatedEntityFiles(path, parsed);
  try {
    await mkdir(scratch, { baseDir: BaseDirectory.AppData, recursive: true });
    await writeTextFile(`${scratch}/${path}`, raw, {
      baseDir: BaseDirectory.AppData,
    });
    for (const name of related) {
      const copy = localStorage.getItem(`dws:${name}`);
      if (copy != null) {
        await writeTextFile(`${scratch}/${name}`, copy, {
          baseDir: BaseDirectory.AppData,
        });
      }
    }
    const report = await invoke<MigrationReport | null>("db_import_legacy_at", {
      dir: scratch,
      clear: false,
    });
    if (!report || !report.completed) return false;
    // Verified in the active repository: the copies are now redundant.
    localStorage.removeItem(key);
    for (const name of related) localStorage.removeItem(`dws:${name}`);
    return true;
  } catch {
    return false; // the copy stays in place
  } finally {
    try {
      await remove(scratch, {
        baseDir: BaseDirectory.AppData,
        recursive: true,
      });
    } catch {
      // A leftover scratch directory is harmless; the copies are already
      // decided.
    }
  }
}

async function run(): Promise<BootstrapResult> {
  if (!hasTauriFs()) {
    return { migration: null, issues: [], adopted: 0 };
  }
  await ensureDataDir();
  const adoption = await adoptLegacyDwsKeys();
  // Throws on real failures (unreadable directory, newer schema, ...) —
  // a completed-but-flagged migration is returned for the startup UI.
  const migration = await invoke<MigrationReport>("db_init");
  return { migration, ...adoption };
}

/** Deep equality that ignores key insertion order. */
function deepEqual(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = stable(obj[key]);
          return acc;
        }, {});
    }
    return value;
  };
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/**
 * Reconcile every `dws:*` fallback key with the native store:
 * - missing native file → adopt the copy (removed only after the write);
 * - identical copies → drop the redundant fallback;
 * - differing copies → CONFLICT: both are preserved and reported, the
 *   native copy is never silently assumed newer;
 * - malformed/unreadable copies → kept in place and reported.
 */
async function adoptLegacyDwsKeys(): Promise<{
  issues: BootstrapIssue[];
  adopted: number;
}> {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("dws:")) keys.push(key.slice(4));
  }

  const issues: BootstrapIssue[] = [];
  let adopted = 0;

  for (const path of keys) {
    const raw = localStorage.getItem(`dws:${path}`);
    if (raw == null) continue;

    // F05: the desktop app cannot import this fallback: adopting it would
    // write an orphan native file and deleting it would drop the only
    // copy. Keep it under its `dws:` key and report it.
    if (!isNativelyConsumablePath(path)) {
      issues.push({
        path,
        kind: "unimportable",
        detail:
          "The desktop app cannot import this browser data file. It was kept " +
          `in place under the 'dws:${path}' fallback key; nothing was written ` +
          "or deleted.",
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Unparseable copy: kept in place and reported — never deleted.
      issues.push({
        path,
        kind: "malformed",
        detail: `The browser fallback copy is not valid JSON; it was kept in place. ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      continue;
    }

    let native: unknown;
    try {
      native = await loadJson(path);
    } catch (err) {
      // The native file exists but cannot be read: do not overwrite it,
      // keep the fallback copy for recovery.
      issues.push({
        path,
        kind: "unreadable",
        detail: `The native file could not be read; the browser copy was kept. ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      continue;
    }

    if (native === null) {
      try {
        await saveJson(path, parsed);
        localStorage.removeItem(`dws:${path}`);
        adopted++;
      } catch (err) {
        // Adoption failed (e.g. permission denied): the dws: copy stays.
        issues.push({
          path,
          kind: "adopt-failed",
          detail: `The browser copy could not be adopted; it was kept in place. ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    } else if (deepEqual(native, parsed)) {
      // Identical content: the fallback is redundant.
      localStorage.removeItem(`dws:${path}`);
      adopted++;
    } else {
      // Conflicting copies: preserve BOTH sides and surface the conflict —
      // the native copy is not silently assumed to be newer.
      issues.push({
        path,
        kind: "conflict",
        detail:
          "The browser fallback copy and the native file hold different versions. " +
          "The native file is in use; the browser copy was kept in place under " +
          `the 'dws:${path}' fallback key for recovery.`,
      });
    }
  }

  return { issues, adopted };
}
