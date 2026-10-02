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
  listModelsForAccount: vi.fn(),
  fetchZenPricing: vi.fn(),
  credentialHint: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import ApiConfigForm from "@/components/settings/ApiConfigForm";
import { listModels, listModelsForAccount, fetchZenPricing } from "@/utils/api";
import { profileAccount } from "@/utils/profiles";
import { useChatStore } from "@/stores/chatStore";

const invokeMock = invoke as Mock;
const listModelsMock = listModels as unknown as Mock;
const listModelsForAccountMock = listModelsForAccount as unknown as Mock;
const fetchZenPricingMock = fetchZenPricing as unknown as Mock;

const ZEN_V1 = "https://opencode.ai/zen/v1";
const ZEN_V2 = "https://opencode.ai/zen/v2";
const P1 = "p1";

/** Fake keychain / prefs backing the mocked transport. */
const keychain = new Map<string, string>();
const prefs = new Map<string, string>();
/** keyring_get gates: the Nth read of the account awaits this promise. */
const keyReadGates: (Promise<void> | undefined)[] = [];

beforeEach(() => {
  invokeMock.mockReset();
  listModelsMock.mockReset();
  listModelsForAccountMock.mockReset();
  fetchZenPricingMock.mockReset();
  keychain.clear();
  prefs.clear();
  keyReadGates.length = 0;
  listModelsMock.mockResolvedValue([]);
  listModelsForAccountMock.mockResolvedValue([]);
  fetchZenPricingMock.mockResolvedValue([]);
  let reads = 0;
  invokeMock.mockImplementation(
    async (cmd: string, args: Record<string, unknown>) => {
      switch (cmd) {
        case "keyring_get": {
          const gate = keyReadGates[reads++];
          if (gate) await gate;
          return keychain.get(String(args.key)) ?? null;
        }
        case "keyring_set":
          keychain.set(String(args.key), String(args.value));
          return null;
        case "keyring_delete":
          keychain.delete(String(args.key));
          return null;
        case "keyring_hint":
          return keychain.has(String(args.key)) ? "…KEY" : null;
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
    profiles: [
      {
        id: P1,
        name: "Personal",
        provider: "zen",
        baseUrl: ZEN_V1,
        account: profileAccount(P1),
        lastModel: "m1",
        lastUsedAt: 1,
      },
    ],
    config: {
      ...useChatStore.getState().config,
      provider: "zen",
      baseUrl: ZEN_V1,
      apiKey: "V1-KEY",
      keychainAccount: profileAccount(P1),
      sessionKeyOnly: false,
      model: "m1",
      activeProfileId: P1,
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("ApiConfigForm credential transitions (B17b, profiles)", () => {
  it("editing the endpoint clears the key synchronously and disables Test/Save", async () => {
    keychain.set(profileAccount(P1), "V1-KEY");
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

    // What the form settles on is this profile's OWN stored key, resolved
    // again for the endpoint now shown.
    await waitFor(() => expect(keyInput.value).toBe("V1-KEY"), { timeout: 2000 });
  });

  it("a slow stored-key response cannot overwrite a newer endpoint's input", async () => {
    keychain.set(profileAccount(P1), "V1-KEY");
    // The first read (for the edited endpoint) hangs.
    let release: () => void = () => {};
    keyReadGates.push(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    render(<ApiConfigForm />);
    const urlInput = screen.getByLabelText("API base URL");
    const keyInput = screen.getByLabelText("API key") as HTMLInputElement;

    fireEvent.change(urlInput, { target: { value: ZEN_V2 } });
    // The debounced load starts and hangs.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(keyInput.value).toBe("");

    // Back to the profile's own endpoint: its stored key resolves.
    fireEvent.change(urlInput, { target: { value: ZEN_V1 } });
    await waitFor(() => expect(keyInput.value).toBe("V1-KEY"));

    // The stale response arrives late: it must not clear the field for the
    // endpoint now shown.
    release();
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
    keychain.set(profileAccount(P1), "V1-KEY");
    render(<ApiConfigForm />);
    fireEvent.click(screen.getByRole("button", { name: "Forget saved key" }));
    await waitFor(() => expect(keychain.has(profileAccount(P1))).toBe(false));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("API key") as HTMLInputElement).value,
      ).toBe(""),
    );
    expect(JSON.parse(prefs.get("config") ?? "{}").apiKey).toBeUndefined();
  });

  it("reads the active profile with its own key and other profiles by account", async () => {
    // A second profile the user is NOT sending with: its key must never be
    // handed to the webview, so its list is fetched from its ACCOUNT.
    useChatStore.setState({
      profiles: [
        ...useChatStore.getState().profiles,
        {
          id: "p2",
          name: "Work",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          account: profileAccount("p2"),
          lastUsedAt: 0,
        },
      ],
    });
    render(<ApiConfigForm />);

    await waitFor(() =>
      expect(listModelsMock).toHaveBeenCalledWith(ZEN_V1, "V1-KEY", "zen"),
    );
    await waitFor(() =>
      expect(listModelsForAccountMock).toHaveBeenCalledWith(
        profileAccount("p2"),
        "https://api.openai.com/v1",
        "openai",
      ),
    );
    // The non-active profile is only ever addressed by its ACCOUNT: no key
    // was fetched for it, and the active profile's key was sent to nothing
    // but the active profile's endpoint.
    expect(
      listModelsMock.mock.calls.every(
        (call) => call[0] === ZEN_V1 && call[1] === "V1-KEY",
      ),
    ).toBe(true);
    for (const [account] of listModelsForAccountMock.mock.calls) {
      expect(String(account)).toMatch(/^dws-key:profile:/);
    }
  });

  it("reports each profile's model list separately", async () => {
    listModelsMock.mockResolvedValue(["m1", "m2"]);
    listModelsForAccountMock.mockRejectedValue(new Error("HTTP 401"));
    useChatStore.setState({
      profiles: [
        ...useChatStore.getState().profiles,
        {
          id: "p2",
          name: "Work",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          account: profileAccount("p2"),
          lastUsedAt: 0,
        },
      ],
    });
    render(<ApiConfigForm />);

    await waitFor(() => expect(screen.getByText(/Personal:/)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/Work:/)).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByText(/2 models available\./)).toBeTruthy(),
    );
    await waitFor(() => expect(screen.getByText(/HTTP 401/)).toBeTruthy());
  });

  it("activating another profile re-aims the form at it", async () => {
    keychain.set(profileAccount("p2"), "WORK-KEY");
    useChatStore.setState({
      profiles: [
        ...useChatStore.getState().profiles,
        {
          id: "p2",
          name: "Work",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          account: profileAccount("p2"),
          lastModel: "gpt",
          lastUsedAt: 0,
        },
      ],
    });
    render(<ApiConfigForm />);
    expect(
      (screen.getByLabelText("API base URL") as HTMLInputElement).value,
    ).toBe(ZEN_V1);

    await act(async () => {
      await useChatStore.getState().activateProfile("p2");
    });

    await waitFor(() =>
      expect(
        (screen.getByLabelText("API base URL") as HTMLInputElement).value,
      ).toBe("https://api.openai.com/v1"),
    );
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "WORK-KEY",
    );
    expect(screen.getByText(/Editing profile/).textContent).toContain("Work");
  });
});
