import { getProvider, isKnownProviderId, type ProviderId } from "@/utils/providers";
import { normalizeEndpoint } from "@/utils/keychain";

/**
 * Named credential profiles.
 *
 * A profile is the unit a user thinks in: "Personal", "Work", "Uni project" —
 * a name plus the provider/endpoint it talks to. Its secret lives in the OS
 * keychain under the profile's own account; the persisted profile record
 * (preference `credential-profiles`) holds only the ACCOUNT REFERENCE, the
 * label, and where it points. Two profiles may share a provider and even an
 * endpoint — that is the whole point (several keys for one provider).
 *
 * `ApiConfig` stays a flattened VIEW of the active profile (its provider,
 * endpoint, key and model), so every send path keeps working unchanged.
 */

/** Preference key holding the profile list (no secrets, see above). */
export const PROFILES_PREF = "credential-profiles";

/** Longest accepted profile name. */
export const MAX_PROFILE_NAME = 40;

export interface CredentialProfile {
  /** Stable identity; also the keychain account identity. */
  id: string;
  /** User label, e.g. "Personal". Never empty. */
  name: string;
  provider: ProviderId;
  baseUrl: string;
  /** Keychain account holding the secret — a REFERENCE, not the secret. */
  account: string;
  /** The model this profile last sent with (restores the picker selection). */
  lastModel?: string;
  /** Epoch millis of the last activation; picks the default profile. */
  lastUsedAt: number;
}

/** The keychain account of one profile. */
export function profileAccount(id: string): string {
  return `dws-key:profile:${id}`;
}

/** A fresh profile identity. */
function newProfileId(): string {
  return crypto.randomUUID();
}

/** The default label for a provider, e.g. "OpenCode Zen". */
export function defaultProfileName(provider: ProviderId): string {
  return getProvider(provider).label;
}

/** Trim, collapse inner runs of whitespace, and cap the length. */
export function normalizeProfileName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, MAX_PROFILE_NAME);
}

/** Whether two profiles point at the same provider AND endpoint. */
export function isSameEndpoint(
  a: { provider: ProviderId; baseUrl: string },
  b: { provider: ProviderId; baseUrl: string },
): boolean {
  return (
    a.provider === b.provider &&
    normalizeEndpoint(a.baseUrl) === normalizeEndpoint(b.baseUrl)
  );
}

/** Build a profile record with a fresh identity and its own account. */
export function makeProfile(
  name: string,
  provider: ProviderId,
  baseUrl: string,
): CredentialProfile {
  const id = newProfileId();
  return {
    id,
    name: normalizeProfileName(name) || defaultProfileName(provider),
    provider,
    baseUrl,
    account: profileAccount(id),
    lastUsedAt: Date.now(),
  };
}

/**
 * Repair a persisted profile list: drop records that cannot be repaired and
 * keep only the known, non-secret fields, so a hand-edited preference can
 * never smuggle extra data (a key) into the app. Returns an empty list when
 * nothing survives.
 */
export function sanitizeProfiles(raw: unknown): CredentialProfile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CredentialProfile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const r = entry as Record<string, unknown>;
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : null;
    const provider = isKnownProviderId(r.provider) ? (r.provider as ProviderId) : null;
    const baseUrl = typeof r.baseUrl === "string" ? r.baseUrl.trim() : "";
    if (!id || !provider || !baseUrl || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: normalizeProfileName(typeof r.name === "string" ? r.name : "") ||
        defaultProfileName(provider),
      provider,
      baseUrl,
      // An account written by an older build (or a failed migration) is kept
      // as-is: it is where that profile's key actually lives.
      account: typeof r.account === "string" && r.account
        ? r.account
        : profileAccount(id),
      lastModel: typeof r.lastModel === "string" && r.lastModel ? r.lastModel : undefined,
      lastUsedAt: typeof r.lastUsedAt === "number" && Number.isFinite(r.lastUsedAt)
        ? r.lastUsedAt
        : 0,
    });
  }
  return out;
}

/** The default profile: the most recently used, ties broken by list order. */
export function pickDefaultProfile(
  profiles: CredentialProfile[],
  preferredId?: string | null,
): CredentialProfile | null {
  if (profiles.length === 0) return null;
  if (preferredId) {
    const preferred = profiles.find((p) => p.id === preferredId);
    if (preferred) return preferred;
  }
  return profiles.reduce((best, p) => (p.lastUsedAt > best.lastUsedAt ? p : best));
}

/**
 * A name no other profile uses: the base, then "Base 2", "Base 3", … Used
 * for auto-generated names only — a name the user TYPED and that collides is
 * reported as a duplicate rather than silently changed.
 */
export function uniqueProfileName(
  base: string,
  existing: readonly CredentialProfile[],
): string {
  const taken = new Set(existing.map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`.slice(0, MAX_PROFILE_NAME);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}
