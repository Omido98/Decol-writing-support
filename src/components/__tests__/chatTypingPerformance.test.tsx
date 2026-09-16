// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

// ──────────────────────────────────────────────
// Typing performance regressions
// ──────────────────────────────────────────────
// Keystrokes must stay cheap no matter how long the conversation is:
// - the draft lives in the composer, so typing re-renders only the
//   composer (never the message rows / markdown parsing);
// - the prepared-request preview compile is debounced, not per keystroke.

const prepareMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@/services/chatPrepare", () => ({
  prepareChatRequest: prepareMock,
}));

import ChatComposer from "@/components/chat/ChatComposer";
import MessageList from "@/components/chat/MessageList";
import { useChatStore } from "@/stores/chatStore";

function seed(): void {
  prepareMock.mockClear();
  useChatStore.setState({
    activeThreadId: "th-1",
    threadLoaded: true,
    threadsLoaded: true,
    threads: [
      {
        id: "th-1",
        title: "Conversation",
        mode: "text",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
    ],
    messages: [
      {
        id: "m1",
        role: "assistant",
        content: "an answer",
        timestamp: "2026-02-01T00:00:01.000Z",
      },
    ],
    drafts: {},
    threadAttachments: {},
    threadSourcePicks: {},
    brief: null,
    briefIncludedByThread: {},
    error: null,
    threadErrors: {},
  });
}

beforeEach(() => {
  seed();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("composer typing (performance contract)", () => {
  it("sends the current draft", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("debounces the preview compile: no work until typing pauses", async () => {
    vi.useFakeTimers();
    render(
      <>
        <MessageList />
        <ChatComposer onSend={() => {}} />
      </>,
    );
    const box = screen.getByRole("textbox");

    fireEvent.change(box, { target: { value: "h" } });
    fireEvent.change(box, { target: { value: "he" } });
    fireEvent.change(box, { target: { value: "hel" } });
    expect(prepareMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(prepareMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    // Three keystrokes, one compile.
    expect(prepareMock).toHaveBeenCalledTimes(1);
  });
});
