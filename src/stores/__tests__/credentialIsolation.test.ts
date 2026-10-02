import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  remove: vi.fn(),
  mkdir: vi.fn(),
  BaseDirectory: { AppData: 22 },
}));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

import { invoke } from "@tauri-apps/api/core";
import { readTextFile, writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
import {
  credentialAccount,
  normalizeEndpoint,
  LEGACY_ACCOUNT,
} from "@/utils/keychain";
import { profileAccount, PROFILES_PREF } from "@/utils/profiles";
import { useChatStore } from "@/stores/chatStore";
import type { ProviderId } from "@/utils/providers";

const invokeMock = invoke as Mock;
const readTextFileMock = readTextFile as Mock;
const writeTextFileMock = writeTextFile as Mock;
const mkdirMock = mkdir as Mock;

const ZEN_V1 = "https://opencode.ai/zen/v1";
const ZEN_V2 = "https://opencode.ai/zen/v2";

/** Fake keychain / prefs / native files backing the mocked transport. */
const keychain = new Map<string, string>();
const prefs = new Map<string, string>();
const nativeFiles = new Map<string, string>();

let keychainSetBroken = false;
let keychainReadBroken = false;

const MISSING = new Error("fs: No such file or directory (os error 2)");

beforeEach(() => {
  invokeMock.mockReset();
  readTextFileMock.mockReset();
  writeTextFileMock.mockReset();
  mkdirMock.mockReset();
  mkdirMock.mockResolvedValue(undefined);
  keychain.clear();
  prefs.clear();
  nativeFiles.clear();
  keychainSetBroken = false;
  keychainReadBroken = false;

  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "keyring_get":
        if (keychainReadBroken) throw new Error("Keychain error: locked");
        return keychain.get(String(args.key)) ?? null;
      case "keyring_set":
        if (keychainSetBroken) throw new Error("Keychain error: locked");
        keychain.set(String(args.key), String(args.value));
        return null;
      case "keyring_delete":
        keychain.delete(String(args.key));
        return null;
      case "db_prefs_get":
        return prefs.get(String(args.key)) ?? null;
      case "db_prefs_set":
        prefs.set(String(args.key), String(args.value));
        return null;
      case "db_prefs_get_all":
        return [...prefs.entries()].map(([key, value]) => ({ key, value }));
      default:
        return null;
    }
  });
  readTextFileMock.mockImplementation(async (path: string) => {
    const value = nativeFiles.get(path);
    if (value == null) throw MISSING;
    return value;
  });
  writeTextFileMock.mockImplementation(async (path: string, content: string) => {
    nativeFiles.set(path, content);
  });
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

  useChatStore.setState({
    config: {
      ...useChatStore.getState().config,
      apiKey: "",
      keychainAccount: null,
      sessionKeyOnly: false,
      activeProfileId: null,
    },
    profiles: [],
    configLoaded: false,
  });
});

/** The active profile, after a load. */
const active = () => {
  const { profiles, config } = useChatStore.getState();
  return profiles.find((p) => p.id === config.activeProfileId)!;
};

describe("credential accounts", () => {
  it("keys each profile by its own account, never by provider", () => {
    const a = profileAccount("p1");
    const b = profileAccount("p2");
    expect(a).not.toBe(b);
    expect(a).toContain("dws-key:profile:");
  });

  it("keeps the endpoint account normalized for the migration read", () => {
    // The pre-profiles scheme stays a valid, normalized read path.
    const zen = credentialAccount("zen", ZEN_V1);
    expect(credentialAccount("zen", `${ZEN_V1}/`)).toBe(zen);
    expect(credentialAccount("zen", "https://OpenCode.AI/zen/v1")).toBe(zen);
    expect(normalizeEndpoint("https://api.x.dev/")).toBe("https://api.x.dev");
  });

  it("a saved credential verifies by read-back", async () => {
    const result = await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
    });
    expect(result.ok).toBe(true);
    expect(keychain.get(profileAccount(active().id))).toBe("K1");
  });

  it("preserves a case-sensitive endpoint PATH and migrates the old lowercased account", async () => {
    const p: ProviderId = "zen";
    // The path is case-sensitive: different paths are different endpoints.
    expect(credentialAccount(p, "https://api.x.dev/V1")).not.toBe(
      credentialAccount(p, "https://api.x.dev/v1"),
    );
    // Scheme/host casing and trailing slashes still normalize together.
    expect(credentialAccount(p, "https://API.x.dev/V1/")).toBe(
      credentialAccount(p, "https://api.x.dev/V1"),
    );

    // A credential stored under the PRE-B17b all-lowercase account is
    // migrated forward on load (verified write first, old copy removed).
    keychain.set("dws-key:zen:https://api.x.dev/v1", "PATH-KEY");
    prefs.set(
      "config",
      JSON.stringify({
        provider: "zen",
        baseUrl: "https://api.x.dev/V1",
        model: "m",
        keychainAccount: null,
        sessionKeyOnly: false,
      }),
    );
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.apiKey).toBe("PATH-KEY");
    expect(keychain.get(profileAccount(active().id))).toBe("PATH-KEY");
    expect(keychain.has("dws-key:zen:https://api.x.dev/v1")).toBe(false);
  });
});

describe("configuration persistence (no plaintext keys)", () => {
  it("stores only the credential reference, never the key", async () => {
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
    });

    // The key works for this session...
    expect(useChatStore.getState().config.apiKey).toBe("K1");
    // ...the persistent config carries the account reference only...
    expect(useChatStore.getState().config.keychainAccount).toBe(
      profileAccount(active().id),
    );
    const persisted = JSON.parse(prefs.get("config") ?? "{}");
    expect(persisted.apiKey).toBeUndefined();
    expect(persisted.keychainAccount).toContain("dws-key:profile:");
    // ...and no secret reached either the config or the profile list.
    expect(JSON.stringify(persisted)).not.toContain("K1");
    expect(prefs.get(PROFILES_PREF) ?? "").not.toContain("K1");
  });

  it("keeps several keys for one provider in separate profiles", async () => {
    const store = useChatStore.getState();
    await store.saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "PERSONAL-KEY",
    });
    const personal = active().id;
    await useChatStore.getState().saveConnection({
      name: "Work",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "WORK-KEY",
    });
    const work = active().id;

    const { profiles, config } = useChatStore.getState();
    expect(profiles).toHaveLength(2);
    expect(new Set(profiles.map((p) => p.id)).size).toBe(2);
    // Same provider, same endpoint, two independent keys.
    expect(profiles[0].provider).toBe("zen");
    expect(profiles[1].provider).toBe("zen");
    expect(keychain.get(profileAccount(personal))).toBe("PERSONAL-KEY");
    expect(keychain.get(profileAccount(work))).toBe("WORK-KEY");
    expect(config.apiKey).toBe("WORK-KEY");
    expect(config.activeProfileId).toBe(work);
  });

  it("survives separate calls and a restart", async () => {
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
    });

    // "Restart": reload from the persisted state.
    useChatStore.setState({ configLoaded: false });
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.apiKey).toBe("K1");
    expect(active().name).toBe("Personal");
  });

  it("an unavailable keychain yields a session-only credential", async () => {
    keychainSetBroken = true;
    const result = await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
    });

    const state = useChatStore.getState().config;
    expect(result).toEqual({
      ok: true,
      sessionKeyOnly: true,
      profileId: active().id,
    });
    expect(state.sessionKeyOnly).toBe(true);
    expect(state.keychainAccount).toBeNull();
    expect(state.apiKey).toBe("K1"); // works for this session
    expect(JSON.stringify(prefs.get("config") ?? "")).not.toContain("K1");
    expect(keychain.size).toBe(0);
  });

  it("an unverifiable keychain write is treated as failure", async () => {
    keychainReadBroken = true;
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
    });
    expect(useChatStore.getState().config.sessionKeyOnly).toBe(true);
    expect(useChatStore.getState().config.keychainAccount).toBeNull();
  });

  it("an endpoint change never carries the key: it becomes a new profile", async () => {
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
    });
    const personal = active().id;
    expect(keychain.get(profileAccount(personal))).toBe("K1");

    // The same profile, pointed at another endpoint: the store refuses to
    // move the key and stores the connection as a NEW profile instead.
    const result = await useChatStore.getState().saveConnection({
      profileId: personal,
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V2,
      apiKey: "V2-KEY",
    });
    expect(result.ok).toBe(true);
    const { profiles, config } = useChatStore.getState();
    expect(profiles).toHaveLength(2);
    expect(config.activeProfileId).not.toBe(personal);
    // The moved connection is auto-named; the old profile keeps its label.
    expect(active().name).toBe("OpenCode Zen");
    expect(
      profiles.find((p) => p.id === personal)!.name,
    ).toBe("Personal");
    // The old profile keeps its own key; the new one has its own.
    expect(keychain.get(profileAccount(personal))).toBe("K1");
    expect(keychain.get(profileAccount(config.activeProfileId!))).toBe("V2-KEY");
    expect(JSON.stringify(prefs.get("config") ?? "")).not.toContain("K1");
  });

  it("a new connection without a key is refused", async () => {
    const result = await useChatStore.getState().saveConnection({
      name: "Empty",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
    });
    expect(result).toEqual({ ok: false, reason: "no-key" });
    expect(useChatStore.getState().profiles).toHaveLength(0);
  });

  it("forgetProfileKey removes the credential and clears the field", async () => {
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
    });
    const id = active().id;
    expect(keychain.get(profileAccount(id))).toBe("K1");

    await useChatStore.getState().forgetProfileKey(id);
    expect(keychain.has(profileAccount(id))).toBe(false);
    const state = useChatStore.getState().config;
    expect(state.apiKey).toBe("");
    expect(state.keychainAccount).toBeNull();
    // The profile itself survives (it can be given a key again).
    expect(useChatStore.getState().profiles).toHaveLength(1);
    expect(JSON.stringify(prefs.get("config") ?? "")).not.toContain("K1");
  });

  it("forgetCredential forgets the ACTIVE profile", async () => {
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
    });
    const id = active().id;
    await useChatStore.getState().forgetCredential();
    expect(keychain.has(profileAccount(id))).toBe(false);
  });

  it("forgetting another profile leaves the active one alone", async () => {
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "PERSONAL-KEY",
    });
    const personal = active().id;
    await useChatStore.getState().saveConnection({
      name: "Work",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "WORK-KEY",
    });
    const work = active().id;

    await useChatStore.getState().forgetProfileKey(personal);
    // The active profile is untouched.
    expect(useChatStore.getState().config.apiKey).toBe("WORK-KEY");
    expect(keychain.get(profileAccount(work))).toBe("WORK-KEY");
    expect(keychain.has(profileAccount(personal))).toBe(false);
  });

  it("forgetting another profile never deletes the active profile's legacy copies (F12)", async () => {
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
    });
    const personal = active().id;
    await useChatStore.getState().saveConnection({
      name: "Work",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "WORK-KEY",
    });
    // Legacy fallbacks of the ACTIVE profile exist again (e.g. written by
    // an older build after the key was saved).
    keychain.set(LEGACY_ACCOUNT, "WORK-KEY");
    nativeFiles.set(
      "config.json",
      JSON.stringify({ provider: "zen", baseUrl: ZEN_V1, apiKey: "WORK-KEY" }),
    );

    // Forgetting a DIFFERENT profile must not touch the active profile's
    // key or its legacy fallbacks.
    await useChatStore.getState().forgetProfileKey(personal);
    expect(useChatStore.getState().config.apiKey).toBe("WORK-KEY");
    expect(keychain.get(LEGACY_ACCOUNT)).toBe("WORK-KEY");
    expect(JSON.parse(nativeFiles.get("config.json")!).apiKey).toBe("WORK-KEY");
  });
});

describe("credential migration", () => {
  it("moves the endpoint-keyed credential into the seeded profile", async () => {
    keychain.set(credentialAccount("zen", ZEN_V1), "OLD-KEY");
    prefs.set(
      "config",
      JSON.stringify({
        provider: "zen",
        baseUrl: ZEN_V1,
        model: "m",
        keychainAccount: credentialAccount("zen", ZEN_V1),
        sessionKeyOnly: false,
      }),
    );
    await useChatStore.getState().loadConfig();

    expect(useChatStore.getState().config.apiKey).toBe("OLD-KEY");
    // The profile's own account holds it now; the endpoint account is gone.
    const profile = active();
    expect(keychain.get(profileAccount(profile.id))).toBe("OLD-KEY");
    expect(keychain.has(credentialAccount("zen", ZEN_V1))).toBe(false);
    expect(useChatStore.getState().config.keychainAccount).toBe(
      profileAccount(profile.id),
    );
    // Exactly one profile was seeded, named after its provider.
    expect(useChatStore.getState().profiles).toHaveLength(1);
  });

  it("keeps the profile pointed at the old account when the move fails", async () => {
    keychain.set(credentialAccount("zen", ZEN_V1), "OLD-KEY");
    keychainSetBroken = true;
    prefs.set(
      "config",
      JSON.stringify({
        provider: "zen",
        baseUrl: ZEN_V1,
        model: "m",
        keychainAccount: credentialAccount("zen", ZEN_V1),
        sessionKeyOnly: false,
      }),
    );
    await useChatStore.getState().loadConfig();

    // Recoverability first: the key is still usable this session and the
    // profile still points at the account it demonstrably lives in.
    expect(useChatStore.getState().config.apiKey).toBe("OLD-KEY");
    expect(active().account).toBe(credentialAccount("zen", ZEN_V1));
    expect(keychain.has(credentialAccount("zen", ZEN_V1))).toBe(true);
  });

  it("migrates the legacy shared keychain entry after a verified write", async () => {
    keychain.set(LEGACY_ACCOUNT, "OLD-KEY");
    prefs.set(
      "config",
      JSON.stringify({
        provider: "zen",
        baseUrl: ZEN_V1,
        model: "m",
        keychainAccount: null,
        sessionKeyOnly: false,
      }),
    );
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.apiKey).toBe("OLD-KEY");
    expect(keychain.get(profileAccount(active().id))).toBe("OLD-KEY");
    expect(keychain.has(LEGACY_ACCOUNT)).toBe(false);
  });

  it("migrates legacy plaintext from config.json and strips the file", async () => {
    nativeFiles.set(
      "config.json",
      JSON.stringify({ provider: "zen", baseUrl: ZEN_V1, apiKey: "PLAIN" }),
    );
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.apiKey).toBe("PLAIN");
    expect(keychain.get(profileAccount(active().id))).toBe("PLAIN");
    // The plaintext copy was removed after the verified keychain write.
    expect(JSON.parse(nativeFiles.get("config.json")!).apiKey).toBe("");
  });

  it("strips the plaintext file only when it held the stored key (F12)", async () => {
    // The shared keychain entry holds the key being migrated; the
    // plaintext file holds a DIFFERENT key (another profile's, or a stale
    // one). Migrating the shared key must not destroy that file's copy.
    keychain.set(LEGACY_ACCOUNT, "SHARED-KEY");
    nativeFiles.set(
      "config.json",
      JSON.stringify({ provider: "zen", baseUrl: ZEN_V1, apiKey: "OTHER-KEY" }),
    );
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.apiKey).toBe("SHARED-KEY");
    expect(keychain.get(profileAccount(active().id))).toBe("SHARED-KEY");
    // The migrated shared entry is gone…
    expect(keychain.has(LEGACY_ACCOUNT)).toBe(false);
    // …but the plaintext file held a different key: it stays intact.
    expect(JSON.parse(nativeFiles.get("config.json")!).apiKey).toBe("OTHER-KEY");
  });

  it("keeps the legacy file when the keychain migration fails", async () => {
    keychainSetBroken = true;
    nativeFiles.set(
      "config.json",
      JSON.stringify({ provider: "zen", baseUrl: ZEN_V1, apiKey: "PLAIN" }),
    );
    await useChatStore.getState().loadConfig();
    // Session-only key...
    expect(useChatStore.getState().config.sessionKeyOnly).toBe(true);
    expect(useChatStore.getState().config.apiKey).toBe("PLAIN");
    // ...and the original file was NOT touched (recoverability).
    expect(JSON.parse(nativeFiles.get("config.json")!).apiKey).toBe("PLAIN");
  });

  it("does not migrate a legacy key into a profile whose account reference points elsewhere", async () => {
    // A legacy shared key exists, but the persisted config's account
    // reference belongs to a DIFFERENT profile (the provider was edited
    // without re-saving): provenance is not established, so nothing is
    // claimed or deleted.
    keychain.set(LEGACY_ACCOUNT, "OLD-KEY");
    prefs.set(
      "config",
      JSON.stringify({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "m",
        keychainAccount: credentialAccount("zen", ZEN_V1),
        sessionKeyOnly: false,
      }),
    );
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.apiKey).toBe("");
    expect(keychain.get(LEGACY_ACCOUNT)).toBe("OLD-KEY");
    expect(keychain.has(profileAccount(active().id))).toBe(false);
  });

  it("seeds a single keyless profile on a fresh install", async () => {
    await useChatStore.getState().loadConfig();
    const { profiles, config } = useChatStore.getState();
    expect(profiles).toHaveLength(1);
    expect(config.activeProfileId).toBe(profiles[0].id);
    expect(config.apiKey).toBe("");
    expect(config.keychainAccount).toBeNull();
  });
});

describe("profile lifecycle", () => {
  it("activates a profile's own key, never the previous profile's", async () => {
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "PERSONAL-KEY",
    });
    const personal = active().id;
    await useChatStore.getState().saveConnection({
      name: "Work",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "WORK-KEY",
    });
    const work = active().id;
    expect(useChatStore.getState().config.apiKey).toBe("WORK-KEY");

    await useChatStore.getState().activateProfile(personal);
    expect(useChatStore.getState().config.apiKey).toBe("PERSONAL-KEY");
    expect(useChatStore.getState().config.activeProfileId).toBe(personal);

    await useChatStore.getState().activateProfile(work);
    expect(useChatStore.getState().config.apiKey).toBe("WORK-KEY");
  });

  it("remembers the active profile across a restart", async () => {
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "PERSONAL-KEY",
    });
    const personal = active().id;
    await useChatStore.getState().saveConnection({
      name: "Work",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "WORK-KEY",
    });
    const work = active().id;

    useChatStore.setState({ configLoaded: false });
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.activeProfileId).toBe(work);
    expect(useChatStore.getState().config.apiKey).toBe("WORK-KEY");

    await useChatStore.getState().activateProfile(personal);
    useChatStore.setState({ configLoaded: false });
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.activeProfileId).toBe(personal);
    expect(useChatStore.getState().config.apiKey).toBe("PERSONAL-KEY");
  });

  it("remembers each profile's own model", async () => {
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
      model: "free-model",
    });
    const personal = active().id;
    await useChatStore.getState().saveConnection({
      name: "Work",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K2",
      model: "paid-model",
    });
    const work = active().id;

    await useChatStore.getState().activateProfile(personal);
    expect(useChatStore.getState().config.model).toBe("free-model");
    await useChatStore.getState().activateProfile(work);
    expect(useChatStore.getState().config.model).toBe("paid-model");
  });

  it("renames a profile and refuses a duplicate name", async () => {
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
    });
    const personal = active().id;
    await useChatStore.getState().saveConnection({
      name: "Work",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K2",
    });

    expect(await useChatStore.getState().renameProfile(personal, "  home  ")).toBe(
      true,
    );
    expect(
      useChatStore.getState().profiles.find((p) => p.id === personal)!.name,
    ).toBe("home");
    // A typed name that collides is reported, not silently changed.
    const work = useChatStore.getState().profiles[1].id;
    expect(await useChatStore.getState().renameProfile(work, "home")).toBe(false);
    expect(await useChatStore.getState().renameProfile(work, "   ")).toBe(false);
    expect(
      useChatStore.getState().profiles.find((p) => p.id === work)!.name,
    ).toBe("Work");
  });

  it("gives an auto-named profile a unique name", async () => {
    await useChatStore.getState().saveConnection({
      name: "OpenCode Zen",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
    });
    const second = await useChatStore.getState().saveConnection({
      name: "",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K2",
    });
    expect(second.ok).toBe(true);
    expect(active().name).toBe("OpenCode Zen 2");
    // ...while a TYPED duplicate is refused.
    const third = await useChatStore.getState().saveConnection({
      name: "OpenCode Zen",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K3",
    });
    expect(third).toEqual({ ok: false, reason: "duplicate-name" });
  });

  it("deletes a profile with its key and refuses to delete the last one", async () => {
    await useChatStore.getState().saveConnection({
      name: "Personal",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K1",
    });
    const personal = active().id;
    await useChatStore.getState().saveConnection({
      name: "Work",
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "K2",
    });
    const work = active().id;

    // Deleting the ACTIVE profile activates another one.
    expect(await useChatStore.getState().deleteProfile(work)).toBe(true);
    expect(keychain.has(profileAccount(work))).toBe(false);
    expect(useChatStore.getState().profiles.map((p) => p.id)).toEqual([personal]);
    expect(useChatStore.getState().config.activeProfileId).toBe(personal);
    expect(useChatStore.getState().config.apiKey).toBe("K1");

    // The last profile stays.
    expect(await useChatStore.getState().deleteProfile(personal)).toBe(false);
    expect(useChatStore.getState().profiles).toHaveLength(1);
  });

  it("repairs a hand-edited profile list and drops unknown fields", async () => {
    prefs.set(
      PROFILES_PREF,
      JSON.stringify([
        {
          id: "p1",
          name: "Personal",
          provider: "zen",
          baseUrl: ZEN_V1,
          account: profileAccount("p1"),
          lastModel: "m",
          lastUsedAt: 5,
          apiKey: "LEAKED", // must never reach the app
        },
        { id: "p2", provider: "nope", baseUrl: ZEN_V1 }, // unrepairable
        { provider: "zen", baseUrl: ZEN_V1 }, // no id
        "not an object",
      ]),
    );
    prefs.set(
      "config",
      JSON.stringify({ provider: "zen", baseUrl: ZEN_V1, model: "m" }),
    );
    await useChatStore.getState().loadConfig();

    const { profiles, config } = useChatStore.getState();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe("p1");
    expect(config.activeProfileId).toBe("p1");
    expect(JSON.stringify(profiles)).not.toContain("LEAKED");
  });
});
