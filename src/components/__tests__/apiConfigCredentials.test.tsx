// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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

vi.mock("@/utils/api", () => ({
  listModels: vi.fn(),
  fetchZenPricing: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import ApiConfigForm from "@/components/settings/ApiConfigForm";
import { listModels, fetchZenPricing } from "@/utils/api";
import { credentialAccount } from "@/utils/keychain";
import { useChatStore } from "@/stores/chatStore";

const invokeMock = invoke as Mock;
const listModelsMock = listModels as unknown as Mock;
const fetchZenPricingMock = fetchZenPricing as unknown as Mock;

const ZEN_V1 = "https://opencode.ai/zen/v1";
const ZEN_V2 = "https://opencode.ai/zen/v2";

/** Fake keychain / prefs backing the mocked transport. */
const keychain = new Map<string, string>();
const prefs = new Map<string, string>();
/** keyring_get gates: an account's read waits on this promise. */
const keyReadGates = new Map<string, Promise<void>>();

beforeEach(() => {
  invokeMock.mockReset();
  listModelsMock.mockReset();
  fetchZenPricingMock.mockReset();
  keychain.clear();
  prefs.clear();
  keyReadGates.clear();
  listModelsMock.mockResolvedValue([]);
  fetchZenPricingMock.mockResolvedValue([]);
  invokeMock.mockImplementation(
    async (cmd: string, args: Record<string, unknown>) => {
      switch (cmd) {
        case "keyring_get": {
          const key = String(args.key);
          const gate = keyReadGates.get(key);
          if (gate) await gate;
          return keychain.get(key) ?? null;
        }
        case "keyring_set":
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
    },
  );
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

  useChatStore.setState({
    configLoaded: true,
    config: {
      ...useChatStore.getState().config,
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "V1-KEY",
      keychainAccount: credentialAccount("zen", ZEN_V1),
      sessionKeyOnly: false,
      model: "m1",
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("ApiConfigForm credential transitions (B17b)", () => {
  it("editing the endpoint clears the key synchronously and disables Test/Save", async () => {
    render(<ApiConfigForm />);
    const keyInput = screen.getByLabelText("API key") as HTMLInputElement;
    expect(keyInput.value).toBe("V1-KEY");

    fireEvent.change(screen.getByLabelText("API base URL"), {
      target: { value: ZEN_V2 },
    });

    // Synchronous invalidation: there is no window in which the old key
    // could be sent to the new endpoint.
    expect(keyInput.value).toBe("");
    const testButton = screen.getByRole("button", { name: /Test connection/ });
    const saveButton = screen.getByRole("button", { name: /^Save$/ });
    expect((testButton as HTMLButtonElement).disabled).toBe(true);
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(testButton);
    fireEvent.click(saveButton);
    expect(listModelsMock).not.toHaveBeenCalledWith(ZEN_V2, "V1-KEY", "zen");

    // Once the new profile resolves (it has no stored credential), the
    // field is still empty and Test is available for a typed key.
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: /Test connection/,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(keyInput.value).toBe("");
  });

  it("a slow stored-credential response cannot overwrite a newer endpoint's input", async () => {
    keychain.set(credentialAccount("zen", ZEN_V1), "V1-KEY");
    // The V2 read hangs; the V1 read returns its key.
    let releaseV2: () => void = () => {};
    keyReadGates.set(
      credentialAccount("zen", ZEN_V2),
      new Promise<void>((resolve) => {
        releaseV2 = resolve;
      }),
    );

    render(<ApiConfigForm />);
    const urlInput = screen.getByLabelText("API base URL");
    const keyInput = screen.getByLabelText("API key") as HTMLInputElement;

    fireEvent.change(urlInput, { target: { value: ZEN_V2 } });
    // The debounced V2 load starts and hangs.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(keyInput.value).toBe("");

    // Switch back to V1: its stored credential resolves.
    fireEvent.change(urlInput, { target: { value: ZEN_V1 } });
    await waitFor(() => expect(keyInput.value).toBe("V1-KEY"));

    // The stale V2 response (no credential) arrives late: it must not
    // clear the field for the profile now shown.
    releaseV2();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(keyInput.value).toBe("V1-KEY");
  });

  it("a detected provider switch keeps the typed key (it belongs to that profile)", async () => {
    render(<ApiConfigForm />);
    const keyInput = screen.getByLabelText("API key") as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "sk-ant-api03-abc" } });

    // Auto-detection switches the form to Anthropic with its default URL;
    // the typed key IS that provider's key, so it stays and Test is usable.
    await waitFor(() =>
      expect(
        (screen.getByLabelText("API base URL") as HTMLInputElement).value,
      ).toBe("https://api.anthropic.com"),
    );
    expect(keyInput.value).toBe("sk-ant-api03-abc");
    expect(
      (
        screen.getByRole("button", {
          name: /Test connection/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("Forget saved key removes the credential and clears the field", async () => {
    keychain.set(credentialAccount("zen", ZEN_V1), "V1-KEY");
    render(<ApiConfigForm />);
    fireEvent.click(screen.getByRole("button", { name: "Forget saved key" }));
    await waitFor(() =>
      expect(keychain.has(credentialAccount("zen", ZEN_V1))).toBe(false),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("API key") as HTMLInputElement).value,
      ).toBe(""),
    );
    expect(JSON.parse(prefs.get("config") ?? "{}").apiKey).toBeUndefined();
  });
});
