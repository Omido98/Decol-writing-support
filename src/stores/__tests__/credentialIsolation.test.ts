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
import { useChatStore } from "@/stores/chatStore";
import type { ProviderId } from "@/utils/providers";

const invokeMock = invoke as Mock;
const readTextFileMock = readTextFile as Mock;
const writeTextFileMock = writeTextFile as Mock;
const mkdirMock = mkdir as Mock;

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
    config: { ...useChatStore.getState().config, apiKey: "", keychainAccount: null, sessionKeyOnly: false },
    configLoaded: false,
  });
});

describe("credential accounts", () => {
  it("key credentials by provider and normalized endpoint", () => {
    const zen = credentialAccount("zen", "https://opencode.ai/zen/v1");
    const openai = credentialAccount("openai", "https://api.openai.com/v1");
    expect(zen).not.toBe(openai);
    // Endpoint normalization: trailing slash and casing do not fork
    // accounts.
    expect(credentialAccount("zen", "https://opencode.ai/zen/v1/")).toBe(zen);
    expect(credentialAccount("zen", "https://OpenCode.AI/zen/v1")).toBe(zen);
    expect(normalizeEndpoint("https://api.x.dev/")).toBe("https://api.x.dev");
  });

  it("a saved credential verifies by read-back", async () => {
    useChatStore.setState({
      config: {
        ...useChatStore.getState().config,
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    });
    await useChatStore.getState().setConfig({
      apiKey: "K1",
    });
    const account = credentialAccount("zen", "https://opencode.ai/zen/v1");
    expect(keychain.get(account)).toBe("K1");
  });

  it("preserves a case-sensitive endpoint PATH and migrates the old lowercased account", async () => {
    const p: ProviderId = "zen";
    // The path is case-sensitive: different paths are different profiles.
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
    expect(keychain.get(credentialAccount(p, "https://api.x.dev/V1"))).toBe(
      "PATH-KEY",
    );
    expect(keychain.has("dws-key:zen:https://api.x.dev/v1")).toBe(false);
  });
});

describe("configuration persistence (no plaintext keys)", () => {
  it("setConfig stores only the credential reference, never the key", async () => {
    useChatStore.setState({
      config: {
        ...useChatStore.getState().config,
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    });
    await useChatStore.getState().setConfig({ apiKey: "K1" });

    // The key works for this session...
    expect(useChatStore.getState().config.apiKey).toBe("K1");
    // ...the persistent config carries the account reference only...
    expect(useChatStore.getState().config.keychainAccount).toBe(
      credentialAccount("zen", "https://opencode.ai/zen/v1"),
    );
    const persisted = JSON.parse(prefs.get("config") ?? "{}");
    expect(persisted.apiKey).toBeUndefined();
    expect(persisted.keychainAccount).toContain("dws-key:zen:");
    // ...and the secret sits in the keychain, not the config.
    expect(JSON.stringify(persisted)).not.toContain("K1");
  });

  it("switching provider does not hand the prior key to the new profile", async () => {
    useChatStore.setState({
      config: {
        ...useChatStore.getState().config,
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    });
    await useChatStore.getState().setConfig({ apiKey: "ZEN-KEY" });

    // Simulate a restored/edited config for another provider: the key is
    // resolved from THAT profile's account only.
    prefs.set(
      "config",
      JSON.stringify({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt",
        keychainAccount: null,
        sessionKeyOnly: false,
      }),
    );
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.apiKey).toBe("");
    expect(useChatStore.getState().config.keychainAccount).toBeNull();
  });

  it("native credentials survive separate calls and a restart", async () => {
    useChatStore.setState({
      config: {
        ...useChatStore.getState().config,
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    });
    await useChatStore.getState().setConfig({ apiKey: "K1" });

    // "Restart": reload the config from the persisted state.
    useChatStore.setState({ configLoaded: false });
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.apiKey).toBe("K1");
  });

  it("clearing the key removes the credential so nothing resurfaces", async () => {
    useChatStore.setState({
      config: {
        ...useChatStore.getState().config,
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    });
    await useChatStore.getState().setConfig({ apiKey: "K1" });
    await useChatStore.getState().setConfig({ apiKey: "" });

    expect(keychain.size).toBe(0);
    expect(useChatStore.getState().config.keychainAccount).toBeNull();
    const persisted = JSON.parse(prefs.get("config") ?? "{}");
    expect(persisted.apiKey).toBeUndefined();
  });

  it("an unavailable keychain yields a session-only credential", async () => {
    keychainSetBroken = true;
    useChatStore.setState({
      config: {
        ...useChatStore.getState().config,
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    });
    await useChatStore.getState().setConfig({ apiKey: "K1" });

    const state = useChatStore.getState().config;
    expect(state.sessionKeyOnly).toBe(true);
    expect(state.keychainAccount).toBeNull();
    expect(state.apiKey).toBe("K1"); // works for this session
    const persisted = JSON.parse(prefs.get("config") ?? "{}");
    expect(JSON.stringify(persisted)).not.toContain("K1");
    expect(keychain.size).toBe(0);
  });

  it("an unverifiable keychain write is treated as failure", async () => {
    keychainReadBroken = true;
    useChatStore.setState({
      config: {
        ...useChatStore.getState().config,
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    });
    await useChatStore.getState().setConfig({ apiKey: "K1" });
    expect(useChatStore.getState().config.sessionKeyOnly).toBe(true);
  });

  it("a partial profile change never carries the old key to the new endpoint", async () => {
    const oldAccount = credentialAccount("zen", "https://opencode.ai/zen/v1");
    useChatStore.setState({
      config: {
        ...useChatStore.getState().config,
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    });
    await useChatStore.getState().setConfig({ apiKey: "K1" });
    expect(keychain.get(oldAccount)).toBe("K1");

    // Only the endpoint changes (no key in the same call): the in-memory
    // key must not ride along to the new endpoint.
    await useChatStore
      .getState()
      .setConfig({ baseUrl: "https://opencode.ai/zen/v2" });
    const state = useChatStore.getState().config;
    expect(state.baseUrl).toBe("https://opencode.ai/zen/v2");
    expect(state.apiKey).toBe("");
    expect(state.keychainAccount).toBeNull();
    // The old profile's stored credential stays (switching back resolves
    // it again), and nothing leaked into the persisted config.
    expect(keychain.get(oldAccount)).toBe("K1");
    const persisted = JSON.parse(prefs.get("config") ?? "{}");
    expect(JSON.stringify(persisted)).not.toContain("K1");
  });

  it("forgetCredential removes the profile's credential and clears the field", async () => {
    const account = credentialAccount("zen", "https://opencode.ai/zen/v1");
    useChatStore.setState({
      config: {
        ...useChatStore.getState().config,
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    });
    await useChatStore.getState().setConfig({ apiKey: "K1" });
    expect(keychain.get(account)).toBe("K1");

    await useChatStore.getState().forgetCredential();
    expect(keychain.has(account)).toBe(false);
    const state = useChatStore.getState().config;
    expect(state.apiKey).toBe("");
    expect(state.keychainAccount).toBeNull();
    const persisted = JSON.parse(prefs.get("config") ?? "{}");
    expect(JSON.stringify(persisted)).not.toContain("K1");
  });

  it("forgetCredential for a different profile leaves the active key alone", async () => {
    const account = credentialAccount("zen", "https://opencode.ai/zen/v1");
    useChatStore.setState({
      config: {
        ...useChatStore.getState().config,
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    });
    await useChatStore.getState().setConfig({ apiKey: "K1" });

    await useChatStore.getState().forgetCredential({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    });
    // The active profile is untouched.
    expect(useChatStore.getState().config.apiKey).toBe("K1");
    expect(keychain.get(account)).toBe("K1");
  });

  it("forgetting another profile never deletes the active profile's legacy copies (F12)", async () => {
    const account = credentialAccount("zen", "https://opencode.ai/zen/v1");
    useChatStore.setState({
      config: {
        ...useChatStore.getState().config,
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    });
    await useChatStore.getState().setConfig({ apiKey: "K1" });
    // Legacy fallbacks of the ACTIVE profile exist again (e.g. written by
    // an older build after the key was saved).
    keychain.set(LEGACY_ACCOUNT, "K1");
    nativeFiles.set(
      "config.json",
      JSON.stringify({
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: "K1",
      }),
    );

    // Forgetting a DIFFERENT profile must not touch the active profile's
    // key or its legacy fallbacks.
    await useChatStore.getState().forgetCredential({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(useChatStore.getState().config.apiKey).toBe("K1");
    expect(keychain.get(account)).toBe("K1");
    expect(keychain.get(LEGACY_ACCOUNT)).toBe("K1");
    expect(JSON.parse(nativeFiles.get("config.json")!).apiKey).toBe("K1");
  });
});

describe("credential migration", () => {
  it("migrates the legacy shared keychain entry after a verified write", async () => {
    keychain.set(LEGACY_ACCOUNT, "OLD-KEY");
    prefs.set(
      "config",
      JSON.stringify({
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
        model: "m",
        keychainAccount: null,
        sessionKeyOnly: false,
      }),
    );
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.apiKey).toBe("OLD-KEY");
    // The profile account holds it now; the shared entry is gone.
    expect(keychain.get(credentialAccount("zen", "https://opencode.ai/zen/v1"))).toBe("OLD-KEY");
    expect(keychain.has(LEGACY_ACCOUNT)).toBe(false);
  });

  it("migrates legacy plaintext from config.json and strips the file", async () => {
    nativeFiles.set(
      "config.json",
      JSON.stringify({ provider: "zen", baseUrl: "https://opencode.ai/zen/v1", apiKey: "PLAIN" }),
    );
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.apiKey).toBe("PLAIN");
    expect(keychain.get(credentialAccount("zen", "https://opencode.ai/zen/v1"))).toBe("PLAIN");
    // The plaintext copy was removed after the verified keychain write.
    const rewritten = JSON.parse(nativeFiles.get("config.json")!);
    expect(rewritten.apiKey).toBe("");
  });

  it("strips the plaintext file only when it held the stored key (F12)", async () => {
    // The shared keychain entry holds the key being migrated; the
    // plaintext file holds a DIFFERENT key (another profile's, or a stale
    // one). Migrating the shared key must not destroy that file's copy.
    keychain.set(LEGACY_ACCOUNT, "SHARED-KEY");
    nativeFiles.set(
      "config.json",
      JSON.stringify({
        provider: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: "OTHER-KEY",
      }),
    );
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.apiKey).toBe("SHARED-KEY");
    expect(
      keychain.get(credentialAccount("zen", "https://opencode.ai/zen/v1")),
    ).toBe("SHARED-KEY");
    // The migrated shared entry is gone…
    expect(keychain.has(LEGACY_ACCOUNT)).toBe(false);
    // …but the plaintext file held a different key: it stays intact.
    expect(JSON.parse(nativeFiles.get("config.json")!).apiKey).toBe(
      "OTHER-KEY",
    );
  });

  it("keeps the legacy file when the keychain migration fails", async () => {
    keychainSetBroken = true;
    nativeFiles.set(
      "config.json",
      JSON.stringify({ provider: "zen", baseUrl: "https://opencode.ai/zen/v1", apiKey: "PLAIN" }),
    );
    await useChatStore.getState().loadConfig();
    // Session-only key...
    expect(useChatStore.getState().config.sessionKeyOnly).toBe(true);
    expect(useChatStore.getState().config.apiKey).toBe("PLAIN");
    // ...and the original file was NOT touched (recoverability).
    const untouched = JSON.parse(nativeFiles.get("config.json")!);
    expect(untouched.apiKey).toBe("PLAIN");
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
        keychainAccount: "dws-key:zen:https://opencode.ai/zen/v1",
        sessionKeyOnly: false,
      }),
    );
    await useChatStore.getState().loadConfig();
    expect(useChatStore.getState().config.apiKey).toBe("");
    expect(keychain.get(LEGACY_ACCOUNT)).toBe("OLD-KEY");
    expect(
      keychain.has(credentialAccount("openai", "https://api.openai.com/v1")),
    ).toBe(false);
  });
});
