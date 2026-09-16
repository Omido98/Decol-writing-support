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

const storage: Record<string, string> = {};

vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => {
    storage[key] = String(value);
  },
  removeItem: (key: string) => {
    delete storage[key];
  },
  clear: () => {
    for (const key of Object.keys(storage)) delete storage[key];
  },
  key: (index: number) => Object.keys(storage)[index] ?? null,
  get length() {
    return Object.keys(storage).length;
  },
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("@/utils/repository", async () => {
  const { fakeRepository } = await import("../../test/fakeRepository");
  return { repo: fakeRepository };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
  exists: vi.fn(),
  BaseDirectory: { AppData: "AppData" },
}));

vi.mock("@/utils/api", () => ({
  sendMessage: vi.fn(),
  deslopText: vi.fn(),
}));

import { sendMessage, deslopText, type ApiResponse } from "@/utils/api";
import MessageList from "@/components/chat/MessageList";
import { sendChatMessage } from "@/services/chatSend";
import { useChatStore, type ApiConfig, type ChatMessage } from "@/stores/chatStore";
import { resetOperations } from "@/services/aiOperations";
import { fakeRepoState, resetFakeRepository } from "@/test/fakeRepository";
import type { StoredMessage } from "@/utils/repository";
import type { ThreadMeta } from "@/types";

const sendMessageMock = sendMessage as unknown as Mock;
const deslopTextMock = deslopText as unknown as Mock;

const threadA: ThreadMeta = {
  id: "th-a",
  title: "Conversation A",
  mode: "text",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
};
const threadB: ThreadMeta = {
  id: "th-b",
  title: "Conversation B",
  mode: "text",
  createdAt: "2026-02-02T00:00:00.000Z",
  updatedAt: "2026-02-02T00:00:00.000Z",
};

const storedMessage = (id: string, content: string): StoredMessage => ({
  id,
  role: "assistant",
  content,
  timestamp: "2026-02-01T00:00:00.000Z",
  failed: false,
  incomplete: null,
  attachmentsJson: null,
});

function seed(): void {
  resetFakeRepository();
  resetOperations();
  sendMessageMock.mockReset();
  deslopTextMock.mockReset();
  fakeRepoState.threads.set("th-a", {
    meta: threadA,
    briefJson: null,
    messages: [],
    rev: 0,
  });
  fakeRepoState.threads.set("th-b", {
    meta: threadB,
    briefJson: null,
    messages: [storedMessage("m-b", "from B")],
    rev: 0,
  });
  useChatStore.setState({
    threads: [threadA, threadB],
    threadsLoaded: true,
    activeThreadId: "th-a",
    threadLoaded: true,
    messages: [
      {
        id: "u-a",
        role: "user",
        content: "question",
        timestamp: "2026-02-01T00:00:00.000Z",
      },
    ],
    drafts: {},
    threadAttachments: {},
    threadSourcePicks: {},
    brief: null,
    briefIncludedByThread: {},
    error: null,
    threadErrors: {},
    config: {
      ...useChatStore.getState().config,
      apiKey: "K1",
      baseUrl: "http://localhost",
      model: "model-1",
    },
  });
}

beforeEach(() => {
  seed();
});

afterEach(() => {
  cleanup();
});

describe("MessageList operation-driven UI (B15)", () => {
  it("keeps the full streaming buffer across A→B→A and shows no other thread's spinner", async () => {
    render(<MessageList />);
    let emit: ((chunk: string) => void) | undefined;
    sendMessageMock.mockImplementation(
      (_m: unknown, _c: unknown, _s: unknown, options?: { onDelta?: (t: string) => void }) =>
        new Promise<ApiResponse>(() => {
          emit = options?.onDelta;
        }),
    );
    void sendChatMessage({ text: "question" });
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));

    act(() => {
      emit!("partial one ");
      emit!("partial two");
    });
    expect(await screen.findByText(/partial one partial two/)).toBeDefined();

    // Navigate away while the operation runs: B shows ITS messages and no
    // spinner from A's operation.
    await act(async () => {
      await useChatStore.getState().switchThread("th-b");
    });
    expect(screen.queryByText(/partial one/)).toBeNull();
    expect(
      screen.queryByRole("status", { name: /generating answer/i }),
    ).toBeNull();
    expect(await screen.findByText("from B")).toBeDefined();

    // Returning to A restores the COMPLETE buffer immediately.
    await act(async () => {
      await useChatStore.getState().switchThread("th-a");
    });
    expect(await screen.findByText(/partial one partial two/)).toBeDefined();
  });

  it("a fresh failure exposes Retry, and the button replays the retained snapshot", async () => {
    render(
      <MessageList
        onResend={(key) => void sendChatMessage({ resendKey: key })}
      />,
    );
    sendMessageMock.mockResolvedValueOnce({ content: "", error: "boom" });
    await act(async () => {
      await sendChatMessage({ text: "original question" });
    });

    const retry = await screen.findByRole("button", { name: "Re-send message" });

    // Later settings changes must not leak into the replay.
    useChatStore.setState({
      config: { ...useChatStore.getState().config, apiKey: "K2", model: "model-2" },
    });
    // F07: the retained snapshot holds no raw key; Retry re-resolves it
    // from the profile's keychain account.
    const invokeMock = (await import("@tauri-apps/api/core")).invoke as Mock;
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "keyring_get" ? "K1" : null,
    );
    sendMessageMock.mockResolvedValueOnce({ content: "the answer" });
    fireEvent.click(retry);
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));

    const [, config] = sendMessageMock.mock.calls[1] as [
      ChatMessage[],
      ApiConfig,
      string,
    ];
    expect(config.model).toBe("model-1");
    expect(config.apiKey).toBe("K1");
    expect(await screen.findByText("the answer")).toBeDefined();
  });

  it("renders the incomplete marker and keeps Retry available after navigation", async () => {
    useChatStore.setState({
      messages: [
        {
          id: "u-1",
          role: "user",
          content: "question",
          timestamp: "2026-02-01T00:00:00.000Z",
        },
        {
          id: "a-1",
          role: "assistant",
          content: "the partial answer",
          timestamp: "2026-02-01T00:00:01.000Z",
          incomplete: "interrupted",
        },
      ],
    });
    // The marker rests on the message, so it is visible whenever the
    // conversation is opened — navigation alone never removes it.
    const onRegenerate = vi.fn();
    render(<MessageList onRegenerate={onRegenerate} />);

    expect(
      await screen.findByText(/Answer interrupted — partial response/),
    ).toBeDefined();
    const retry = screen.getByRole("button", { name: "Retry answer" });
    fireEvent.click(retry);
    expect(onRegenerate).toHaveBeenCalledWith("a-1");
  });

  it("marks a truncated answer distinctly", async () => {
    useChatStore.setState({
      messages: [
        {
          id: "a-2",
          role: "assistant",
          content: "cut off",
          timestamp: "2026-02-01T00:00:02.000Z",
          incomplete: "truncated",
        },
      ],
    });
    render(<MessageList />);
    expect(
      await screen.findByText(/Answer truncated — the model reached its output limit/),
    ).toBeDefined();
  });

  it("two mounted surfaces cannot start duplicate cleanup", async () => {
    useChatStore.setState({
      messages: [
        {
          id: "a-1",
          role: "assistant",
          content: "sloppy draft",
          timestamp: "2026-02-01T00:00:00.000Z",
        },
      ],
    });
    render(
      <>
        <MessageList />
        <MessageList />
      </>,
    );
    const buttons = await screen.findAllByRole("button", {
      name: "Remove AI slop",
    });
    expect(buttons).toHaveLength(2);

    deslopTextMock.mockResolvedValue({ content: "cleaned draft" });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);

    await waitFor(() => expect(deslopTextMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        useChatStore
          .getState()
          .messages.filter((m) => m.role === "assistant")
          .map((m) => m.content),
      ).toEqual(["sloppy draft", "cleaned draft"]),
    );
  });
});
