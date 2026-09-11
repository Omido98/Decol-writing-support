import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendMessage, deslopText } from "@/utils/api";
import type { ApiConfig } from "@/stores/chatStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((msg: unknown) => void) | null = null;
  },
}));

import { invoke } from "@tauri-apps/api/core";

const mockedInvoke = vi.mocked(invoke);

const baseConfig: ApiConfig = {
  provider: "zen",
  baseUrl: "https://opencode.ai/zen/v1",
  apiKey: "test-key",
  model: "deepseek-v4-flash-free",
  reasoningEffort: null,
  webSearchEnabled: true,
  deepResearchEnabled: false,
  systemPromptMode: "standard",
  customSystemPrompt: "",
};

const deepConfig: ApiConfig = {
  ...baseConfig,
  deepResearchEnabled: true,
};

function openaiMessage(message: unknown): unknown {
  return { choices: [{ message }] };
}

/** Answer chat requests with a single streamed round. */
function mockChatStream(data: unknown) {
  mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
    if (cmd === "zen_chat_stream") {
      const onEvent = (
        args as {
          onEvent?: { onmessage: (msg: unknown) => void };
        }
      )?.onEvent;
      setTimeout(() => {
        onEvent?.onmessage({ type: "done", data });
      }, 0);
      return "req-1";
    }
    if (cmd === "zen_chat_stream_cancel") return null;
    return null;
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("deslopText", () => {
  it("sends the draft as the only user message with the de-slop prompt and no tools", async () => {
    mockChatStream(openaiMessage({ content: "Clean draft." }));
    const result = await deslopText("A sloppy draft.", baseConfig);
    expect(result).toEqual({ content: "Clean draft." });

    const chatCalls = mockedInvoke.mock.calls.filter(
      (c) => c[0] === "zen_chat_stream",
    );
    expect(chatCalls.length).toBeGreaterThan(0);
    for (const call of chatCalls) {
      const payload = (
        call[1] as {
          payload: {
            messages: Array<{ role: string; content?: string | null }>;
            tools?: unknown;
          };
        }
      ).payload;
      expect(payload.tools).toBeUndefined();
      expect(payload.messages[0].role).toBe("system");
      expect(payload.messages[0].content).toContain("Anti-slop writing rules");
      expect(payload.messages[0].content).toContain("No changes needed");
      expect(payload.messages[1]).toEqual({
        role: "user",
        content: "A sloppy draft.",
      });
    }
  });

  it("returns an error when the API key is missing", async () => {
    const result = await deslopText("Draft.", { ...baseConfig, apiKey: "" });
    expect(result.content).toBe("");
    expect(result.error).toMatch(/API key/i);
  });
});

describe("deep research tool budget", () => {
  /**
   * Answer with `toolRounds` tool-call rounds (each a distinct query, so the
   * identical-repeat detection never trips) followed by a final answer.
   */
  function mockToolLoop(toolRounds: number, finalContent: string) {
    let streamCalls = 0;
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_web_search") {
        return [
          { title: "Result", url: "https://example.com", snippet: "Snippet." },
        ];
      }
      if (cmd === "zen_chat_stream_cancel") return null;
      if (cmd === "zen_chat_stream") {
        streamCalls += 1;
        const onEvent = (
          args as {
            onEvent?: { onmessage: (msg: unknown) => void };
          }
        )?.onEvent;
        const data =
          streamCalls <= toolRounds
            ? openaiMessage({
                content: null,
                tool_calls: [
                  {
                    id: `call_${streamCalls}`,
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: JSON.stringify({
                        query: `topic ${streamCalls}`,
                      }),
                    },
                  },
                ],
              })
            : openaiMessage({ content: finalContent });
        setTimeout(() => {
          onEvent?.onmessage({ type: "done", data });
        }, 0);
        return `req-${streamCalls}`;
      }
      if (cmd === "zen_chat") {
        return openaiMessage({ content: finalContent });
      }
      return null;
    });
  }

  function streamCallCount(): number {
    return mockedInvoke.mock.calls.filter((c) => c[0] === "zen_chat_stream")
      .length;
  }

  it("stops at 15 tool rounds with the standard budget", async () => {
    mockToolLoop(20, "Final answer.");
    const result = await sendMessage([], baseConfig, "system");
    expect(streamCallCount()).toBe(15);
    expect(result.content).toContain("Web research stopped");
  });

  it("keeps researching past 15 rounds with deep research enabled", async () => {
    mockToolLoop(20, "Deep answer.");
    const result = await sendMessage([], deepConfig, "system");
    expect(result).toEqual({ content: "Deep answer." });
    expect(streamCallCount()).toBe(21);
  });
});
