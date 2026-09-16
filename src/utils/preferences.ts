import { invoke } from "@tauri-apps/api/core";
import { hasTauriFs } from "@/utils/storage";

/**
 * Non-secret preferences (API config without credentials, appearance,
 * cached price tables, recovery drafts, composer attachments) live in the
 * SQLite preferences table on desktop — so a backup restore commits them
 * together with the domain data — and in localStorage in a plain browser
 * session. Credentials NEVER go through this module: they live in the OS
 * keychain (see keychain.ts).
 *
 * Writes are ACKNOWLEDGED: every value written through `setPref` is
 * tracked until its transport succeeds. The latest value per key wins
 * (coalescing), in-flight writes are awaited by `flushPreferences()`, and
 * a rejected write keeps its payload retained so a drain can surface it
 * (and the user can retry or explicitly discard it).
 */

const BROWSER_PREFIX = "dws:pref:";

interface PendingWrite {
  value: unknown;
  /** The in-flight transport write (null when waiting for a retry). */
  promise: Promise<void> | null;
  error: string | null;
}

const pendingWrites = new Map<string, PendingWrite>();
const prefListeners = new Set<() => void>();

function notifyPreferences(): void {
  for (const listener of prefListeners) listener();
}

export function subscribePreferences(listener: () => void): () => void {
  prefListeners.add(listener);
  return () => prefListeners.delete(listener);
}

/** Preference writes waiting, in flight, or retained as failures. */
export function pendingPreferenceWrites(): number {
  return pendingWrites.size;
}

/** Retained preference failures (key + message). */
export function preferenceFailures(): { key: string; message: string }[] {
  return [...pendingWrites.entries()]
    .filter(([, entry]) => entry.error != null)
    .map(([key, entry]) => ({ key, message: entry.error as string }));
}

/** Throw a retained preference payload away (explicit user choice). */
export function discardPreference(key: string): void {
  if (pendingWrites.delete(key)) notifyPreferences();
}

/** Test seam: forget pending/failed preference writes between tests. */
export function resetPreferenceState(): void {
  pendingWrites.clear();
  prefMaintenanceDepth = 0;
  heldDuringMaintenance.clear();
  notifyPreferences();
}

// ──────────────────────────────────────────────
// Maintenance barrier (a restore replaces preferences too)
// ──────────────────────────────────────────────

let prefMaintenanceDepth = 0;
/** Keys written WHILE the barrier is up (held; discarded on restore). */
const heldDuringMaintenance = new Set<string>();

export function beginPreferenceMaintenance(): void {
  prefMaintenanceDepth++;
}

/**
 * End the preference barrier: `release` starts the held writes (export);
 * `discard` drops them (their values predate the restored dataset).
 */
export function endPreferenceMaintenance(mode: "release" | "discard"): void {
  prefMaintenanceDepth = Math.max(0, prefMaintenanceDepth - 1);
  if (prefMaintenanceDepth > 0) return;
  const held = [...heldDuringMaintenance];
  heldDuringMaintenance.clear();
  if (mode === "release") {
    for (const key of held) {
      if (pendingWrites.has(key)) void startWrite(key).catch(() => {});
    }
  } else {
    for (const key of held) pendingWrites.delete(key);
  }
  notifyPreferences();
}

/**
 * Drain preference writes while the barrier is up (the recovery snapshot
 * must include the newest pending values). Ordinary `flushPreferences`
 * still works during maintenance; this entry point documents intent and
 * is what the maintenance task calls.
 */
export async function privilegedPreferenceDrain(): Promise<void> {
  await flushPreferences();
}

/** Write a preference despite the barrier (used by the v1 restore path). */
export async function setPrefPrivileged(
  key: string,
  value: unknown,
): Promise<void> {
  pendingWrites.set(key, { value, promise: null, error: null });
  notifyPreferences();
  return startWrite(key);
}

/**
 * Replace the COMPLETE preference set (browser restore, B21d): keys the
 * bundle does not carry are removed, exactly like the desktop's
 * `db_restore` (which deletes the preferences table before inserting the
 * bundle's rows). Desktop sessions restore through `db_restore` and never
 * call this.
 */
export async function replacePrefsPrivileged(
  entries: { key: string; value: unknown }[],
): Promise<void> {
  if (hasTauriFs()) {
    throw new Error(
      "Desktop sessions restore preferences through db_restore, not replacePrefsPrivileged.",
    );
  }
  const next = new Map(
    entries.map((entry) => [`${BROWSER_PREFIX}${entry.key}`, JSON.stringify(entry.value)]),
  );
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const storageKey = localStorage.key(i);
      if (!storageKey?.startsWith(BROWSER_PREFIX)) continue;
      if (!next.has(storageKey)) localStorage.removeItem(storageKey);
    }
    for (const [storageKey, json] of next) {
      localStorage.setItem(storageKey, json);
    }
  } catch (err) {
    // localStorage has no multi-key transaction: a quota/IO failure can
    // leave the preference set partially replaced. The restore's recovery
    // snapshot (written before the swap) is the way back; the caller sees
    // exactly what went wrong.
    throw new Error(
      `The restored preferences could not be applied completely: ${
        err instanceof Error ? err.message : String(err)
      }. The backup's recovery snapshot can still be restored.`,
    );
  }
  // The replaced values supersede anything still queued for a key.
  for (const key of [...pendingWrites.keys()]) {
    if (!next.has(`${BROWSER_PREFIX}${key}`)) pendingWrites.delete(key);
  }
  notifyPreferences();
}

/** The raw transport write for one preference key. */
async function writePrefValue(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  if (!hasTauriFs()) {
    localStorage.setItem(`${BROWSER_PREFIX}${key}`, json);
    return;
  }
  await invoke("db_prefs_set", { key, value: json });
}

/** Write the CURRENT value of a pending key (deduplicated by identity). */
function startWrite(key: string): Promise<void> {
  const entry = pendingWrites.get(key);
  if (!entry) return Promise.resolve();
  const value = entry.value;
  const promise = (async () => {
    try {
      await writePrefValue(key, value);
      const current = pendingWrites.get(key);
      if (current && current.value === value) {
        // Acknowledged: nothing newer arrived while writing.
        pendingWrites.delete(key);
      }
      notifyPreferences();
    } catch (err) {
      const current = pendingWrites.get(key);
      if (current && current.value === value) {
        current.error = err instanceof Error ? err.message : String(err);
      }
      notifyPreferences();
      throw err;
    } finally {
      const current = pendingWrites.get(key);
      if (current && current.value === value) current.promise = null;
    }
  })();
  entry.promise = promise;
  return promise;
}

export async function setPref(key: string, value: unknown): Promise<void> {
  const existing = pendingWrites.get(key);
  pendingWrites.set(key, {
    value,
    promise: null,
    error: existing?.error ?? null,
  });
  notifyPreferences();
  if (prefMaintenanceDepth > 0) {
    // Held until the barrier ends: a restore discards it (its value
    // describes the dataset being replaced), an export releases it.
    heldDuringMaintenance.add(key);
    return;
  }
  return startWrite(key);
}

/**
 * Drain preference writes: wait for every in-flight write, re-attempt
 * retained failures once, then reject while any payload is still retained.
 * Called by the close/relaunch drains (and exposed for retries).
 */
export async function flushPreferences(): Promise<void> {
  // Snapshot the keys: a new write may arrive while draining.
  for (const key of [...pendingWrites.keys()]) {
    const entry = pendingWrites.get(key);
    if (!entry) continue;
    if (entry.promise) {
      await entry.promise.catch(() => {});
    }
    // A failure (or a value that arrived while the write ran) is retried.
    if (pendingWrites.has(key)) {
      await startWrite(key).catch(() => {});
    }
  }
  const failed = preferenceFailures();
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} preference write${
        failed.length === 1 ? "" : "s"
      } could not be saved: ${failed[0].message}`,
    );
  }
}

export async function getPref<T>(key: string): Promise<T | null> {
  if (!hasTauriFs()) {
    const raw = localStorage.getItem(`${BROWSER_PREFIX}${key}`);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new Error(
        `Corrupt preference '${key}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const raw = await invoke<string | null>("db_prefs_get", { key });
  if (raw == null) return null;
  return JSON.parse(raw) as T;
}

/** Every stored preference, keyed by name (values are parsed). */
export async function getAllPrefs(): Promise<Record<string, unknown>> {
  if (!hasTauriFs()) {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (!storageKey || !storageKey.startsWith(BROWSER_PREFIX)) continue;
      try {
        out[storageKey.slice(BROWSER_PREFIX.length)] = JSON.parse(
          localStorage.getItem(storageKey) ?? "null",
        );
      } catch {
        // Unreadable browser preference: skip it in exports.
      }
    }
    return out;
  }
  const rows = await invoke<{ key: string; value: string }[]>("db_prefs_get_all");
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      // Unreadable preference: skip it rather than fail.
    }
  }
  return out;
}
