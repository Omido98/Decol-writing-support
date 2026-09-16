import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "@/utils/providers";

/**
 * OS keychain integration for provider credentials.
 *
 * Each credential is keyed by provider + normalized endpoint identity, so
 * switching providers selects THAT profile's credential (or nothing) — one
 * profile's key can never be sent to another profile's endpoint. The
 * Rust backend (keyring_get/set/delete) stores secrets in the system
 * keychain (Windows Credential Manager / macOS Keychain / libsecret).
 *
 * Writes are verified with a read-back before callers may act as if the
 * credential were stored; when the keychain is unavailable, callers fall
 * back to session-only credentials (in memory, never persisted).
 */

/** Account of the pre-R7 single shared key (used for migration only). */
export const LEGACY_ACCOUNT = "api_key";

/**
 * Normalize an endpoint into the credential's account identity. The
 * scheme and host are case-insensitive (lowercased); the PATH is
 * case-sensitive and preserved — `https://x.dev/V1` and
 * `https://x.dev/v1` are different endpoints and must never share a
 * credential. Trailing slashes are dropped.
 */
export function normalizeEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    // Not an absolute URL: keep the string as given (case may matter in
    // endpoint forms the URL parser cannot see).
    return trimmed;
  }
}

/**
 * The PRE-B17b normalization (the whole URL lowercased). Used ONLY to
 * locate a credential stored under the old account and migrate it to the
 * case-preserving account; never for new writes.
 */
export function legacyNormalizeEndpoint(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").toLowerCase();
}

/** The keychain account for one provider/profile + endpoint identity. */
export function credentialAccount(
  provider: ProviderId,
  baseUrl: string,
): string {
  return `dws-key:${provider}:${normalizeEndpoint(baseUrl)}`;
}

async function keyringGet(account: string): Promise<string | null> {
  try {
    return (await invoke<string | null>("keyring_get", { key: account })) ?? null;
  } catch (err) {
    console.warn(
      "Keychain read failed (secure storage unavailable):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function keyringSet(account: string, value: string): Promise<boolean> {
  try {
    await invoke("keyring_set", { key: account, value });
    return true;
  } catch (err) {
    console.warn(
      "Keychain write failed (secure storage unavailable):",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

async function keyringDelete(account: string): Promise<boolean> {
  try {
    await invoke("keyring_delete", { key: account });
    return true;
  } catch {
    return false;
  }
}

/**
 * Store a credential AND verify the read-back. Returns false (and removes
 * the half-written entry) when the keychain could not store or read the
 * value — callers must then keep the credential session-only.
 */
export async function saveCredential(
  provider: ProviderId,
  baseUrl: string,
  value: string,
): Promise<boolean> {
  const account = credentialAccount(provider, baseUrl);
  if (!(await keyringSet(account, value))) return false;
  const readBack = await keyringGet(account);
  if (readBack !== value) {
    await keyringDelete(account);
    return false;
  }
  return true;
}

/**
 * Load the credential of one provider/profile + endpoint identity. When
 * the case-preserving account has no entry, a credential stored under the
 * PRE-B17b all-lowercase account for the SAME endpoint is migrated
 * forward: the write under the new identity is verified BEFORE the old
 * copy is removed (recoverability first). Provenance is exact — same
 * provider, same URL, only the normalization rule changed.
 */
export async function loadCredential(
  provider: ProviderId,
  baseUrl: string,
): Promise<string | null> {
  const account = credentialAccount(provider, baseUrl);
  const value = await keyringGet(account);
  if (value != null) return value;
  const legacyAccount = `dws-key:${provider}:${legacyNormalizeEndpoint(baseUrl)}`;
  if (legacyAccount === account) return null;
  const legacy = await keyringGet(legacyAccount);
  if (legacy == null) return null;
  const stored = await saveCredential(provider, baseUrl, legacy);
  if (stored) await keyringDelete(legacyAccount);
  return legacy;
}

/** Delete the credential of one provider/profile + endpoint identity. */
export async function deleteCredential(
  provider: ProviderId,
  baseUrl: string,
): Promise<boolean> {
  return keyringDelete(credentialAccount(provider, baseUrl));
}

/** The pre-R7 shared key (single account for every provider). */
export async function loadLegacyKey(): Promise<string | null> {
  return keyringGet(LEGACY_ACCOUNT);
}

export async function deleteLegacyKey(): Promise<boolean> {
  return keyringDelete(LEGACY_ACCOUNT);
}

export async function readLegacyPlaintextKey(): Promise<string | null> {
  try {
    const { loadJson } = await import("@/utils/storage");
    const legacy = await loadJson<{ apiKey?: string }>("config.json");
    return legacy?.apiKey || null;
  } catch {
    return null;
  }
}

/** Rewrite the legacy config.json WITHOUT its plaintext key. */
export async function stripLegacyPlaintextKey(): Promise<void> {
  try {
    const { loadJson, saveJson } = await import("@/utils/storage");
    const legacy = await loadJson<Record<string, unknown>>("config.json");
    if (legacy && "apiKey" in legacy) {
      await saveJson("config.json", { ...legacy, apiKey: "" });
    }
  } catch {
    // The legacy file stays as-is when it cannot be read or rewritten —
    // recoverability beats cleanup.
  }
}
