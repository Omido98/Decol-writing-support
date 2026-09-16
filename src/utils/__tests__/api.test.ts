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
  lastBrief: null,
  keychainAccount: "dws-key:zen:https://opencode.ai/zen/v1",
  sessionKeyOnly: false,
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
    expect(result.content).toBe("Clean draft.");

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
    expect(result.content).toBe("Deep answer.");
  });

  it("the round-cap fallback hands the gathered evidence to the final round", async () => {
    mockToolLoop(20, "Final answer.");
    await sendMessage([], baseConfig, "system");
    // The final (tools-free) round must contain the search results.
    const finalRound = mockedInvoke.mock.calls.find((c) => c[0] === "zen_chat");
    const payload = (finalRound?.[1] as {
      payload: { messages: Array<{ role: string; content: string }> };
    }).payload;
    const evidence = payload.messages.find(
      (m) => m.role === "user" && m.content.includes("Research material"),
    );
    expect(evidence).toBeDefined();
    expect(evidence!.content).toContain("https://example.com");
  });
});

describe("stream discipline (R9)", () => {
  it("events emitted before the startup acknowledgement are not lost", async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_chat_stream") {
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        // Synchronous emission BEFORE the promise resolves: the handler
        // must already be attached.
        onEvent?.onmessage({ type: "delta", text: "early " });
        setTimeout(() => {
          onEvent?.onmessage({
            type: "done",
            data: openaiMessage({ content: "early answer" }),
          });
        }, 0);
        return "req-1";
      }
      if (cmd === "zen_chat_stream_cancel") return null;
      return null;
    });
    const deltas: string[] = [];
    const result = await sendMessage([], baseConfig, "system", {
      onDelta: (t) => deltas.push(t),
    });
    expect(deltas.join("")).toBe("early ");
    expect(result.content).toBe("early answer");
  });

  it("an abort during startup queues the cancellation and stops", async () => {
    let resolveInvoke: (id: string) => void = () => {};
    let cancelled = false;
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "zen_chat_stream") {
        await new Promise<string>((r) => {
          resolveInvoke = r;
        });
        return "req-1";
      }
      if (cmd === "zen_chat_stream_cancel") {
        cancelled = true;
        return null;
      }
      return null;
    });
    const controller = new AbortController();
    const pending = sendMessage([], baseConfig, "system", {
      signal: controller.signal,
    });
    // Abort BEFORE the startup acknowledgement arrives.
    controller.abort();
    resolveInvoke("req-1");
    const result = await pending;
    expect(result.stopped).toBe(true);
    // The queued cancel fires as soon as the request id exists.
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("late events after terminal settlement are ignored", async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_chat_stream") {
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        setTimeout(() => {
          onEvent?.onmessage({
            type: "done",
            data: openaiMessage({ content: "final" }),
          });
          // Late events (e.g. a duplicated done / stray delta) after the
          // terminal settlement must be ignored.
          onEvent?.onmessage({ type: "delta", text: "LATE" });
          onEvent?.onmessage({ type: "error", message: "LATE ERROR" });
        }, 0);
        return "req-1";
      }
      if (cmd === "zen_chat_stream_cancel") return null;
      return null;
    });
    const deltas: string[] = [];
    const result = await sendMessage([], baseConfig, "system", {
      onDelta: (t) => deltas.push(t),
    });
    expect(result.content).toBe("final");
    expect(result.error).toBeUndefined();
    expect(deltas).toEqual([]);
  });

  it("a truncated stream keeps the partial content and reports truncation", async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_chat_stream") {
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        setTimeout(() => {
          // The Rust accumulator marks EOF-without-completion as truncated.
          onEvent?.onmessage({
            type: "done",
            data: {
              choices: [
                {
                  message: { content: "partial answer" },
                  finish_reason: null,
                  truncated: true,
                },
              ],
            },
          });
        }, 0);
        return "req-1";
      }
      if (cmd === "zen_chat_stream_cancel") return null;
      return null;
    });
    const result = await sendMessage([], baseConfig, "system");
    expect(result.content).toBe("partial answer");
    expect(result.truncated).toBe(true);
    expect(result.outcome).toBe("interrupted");
    expect(result.error).toBeUndefined();
  });

  it("a disabled research setting prevents tool execution even when the provider returns tool calls", async () => {
    let toolCalls = 0;
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_web_search") {
        toolCalls++;
        return [
          { title: "Should not appear", url: "https://example.com", snippet: "" },
        ];
      }
      if (cmd === "zen_chat_stream") {
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        setTimeout(() => {
          onEvent?.onmessage({
            type: "done",
            data: openaiMessage({
              content: "I would search here.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({ query: "x" }),
                  },
                },
              ],
            }),
          });
        }, 0);
        return "req-1";
      }
      if (cmd === "zen_chat_stream_cancel") return null;
      return null;
    });
    const result = await sendMessage([], { ...baseConfig, webSearchEnabled: false }, "system");
    expect(toolCalls).toBe(0);
    expect(result.content).toBe("I would search here.");
  });

  it("stop during a tool batch returns the streamed partial as stopped", async () => {
    const controller = new AbortController();
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_web_search") {
        // The user hits Stop while the tools are running.
        controller.abort();
        return [{ title: "R", url: "https://example.com", snippet: "" }];
      }
      if (cmd === "zen_chat_stream") {
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        setTimeout(() => {
          onEvent?.onmessage({
            type: "done",
            data: openaiMessage({
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({ query: "x" }),
                  },
                },
              ],
            }),
          });
        }, 0);
        return "req-1";
      }
      if (cmd === "zen_chat_stream_cancel") return null;
      return null;
    });
    const result = await sendMessage([], baseConfig, "system", {
      signal: controller.signal,
    });
    expect(result.stopped).toBe(true);
  });

  it("a stream failure after output started returns the partial as truncated", async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_chat_stream") {
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        setTimeout(() => {
          onEvent?.onmessage({ type: "delta", text: "streamed so far" });
          onEvent?.onmessage({
            type: "error",
            message: "connection reset mid-stream",
          });
        }, 0);
        return "req-1";
      }
      if (cmd === "zen_chat_stream_cancel") return null;
      return null;
    });
    const result = await sendMessage([], baseConfig, "system");
    // No silent restart-and-replace: the partial survives, marked.
    expect(result.content).toBe("streamed so far");
    expect(result.truncated).toBe(true);
    expect(result.outcome).toBe("interrupted");
    expect(result.error).toContain("connection reset");
  });
});

describe("response completeness model (B16)", () => {
  /** Emit stream-shaped events for one request, then settle. */
  function mockWireStream(
    events: Array<{ type: string; [key: string]: unknown }>,
    onCall?: (payload: Record<string, unknown>) => void,
  ) {
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_chat_stream") {
        const typed = args as {
          onEvent?: { onmessage: (msg: unknown) => void };
          payload?: Record<string, unknown>;
        };
        onCall?.(typed.payload ?? {});
        setTimeout(() => {
          for (const event of events) typed.onEvent?.onmessage(event);
        }, 0);
        return "req-1";
      }
      if (cmd === "zen_chat_stream_cancel") return null;
      return null;
    });
  }

  it("finish → usage → DONE is a clean completion with root-level usage", async () => {
    mockWireStream([
      { type: "delta", text: "full answer" },
      {
        type: "done",
        data: {
          choices: [
            {
              message: { content: "full answer" },
              finish_reason: "stop",
              // The usage chunk arrives AFTER the finish chunk on the wire;
              // the accumulator puts it on the assembled payload.
              usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
              truncated: false,
            },
          ],
        },
      },
    ]);
    const result = await sendMessage([], baseConfig, "system");
    expect(result.outcome).toBe("complete");
    expect(result.content).toBe("full answer");
    expect(result.truncated).toBe(false);
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
    });
  });

  it("an output-limit stop is a truncation, not a clean completion", async () => {
    mockWireStream([
      { type: "delta", text: "cut off mid-sentence" },
      {
        type: "done",
        data: {
          choices: [
            {
              message: { content: "cut off mid-sentence" },
              finish_reason: "length",
              truncated: false,
            },
          ],
        },
      },
    ]);
    const result = await sendMessage([], baseConfig, "system");
    expect(result.outcome).toBe("truncated");
    expect(result.truncated).toBe(true);
    expect(result.content).toBe("cut off mid-sentence");
    expect(result.finishReason).toBe("length");
  });

  it("a provider error before any text is a failure with no content", async () => {
    mockWireStream([
      { type: "error", message: "The provider reported an error: overloaded" },
    ]);
    const result = await sendMessage([], baseConfig, "system");
    expect(result.outcome).toBe("failed");
    expect(result.content).toBe("");
    expect(result.error).toContain("overloaded");
  });

  it("never executes tools from an interrupted round, and preserves the partial text", async () => {
    let toolCalls = 0;
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_web_search") {
        toolCalls++;
        return [{ title: "must not run", url: "https://example.com", snippet: "" }];
      }
      if (cmd === "zen_chat_stream") {
        const typed = args as {
          onEvent?: { onmessage: (msg: unknown) => void };
        };
        setTimeout(() => {
          typed.onEvent?.onmessage({ type: "delta", text: "Let me search" });
          // Interrupted after partial tool-call arguments: the assembled
          // round carries both text and tool_calls, but truncated=true.
          typed.onEvent?.onmessage({
            type: "done",
            data: {
              choices: [
                {
                  message: {
                    content: "Let me search",
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "web_search",
                          arguments: '{"query":"par',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                  truncated: true,
                },
              ],
            },
          });
        }, 0);
        return "req-1";
      }
      if (cmd === "zen_chat_stream_cancel") return null;
      return null;
    });
    const result = await sendMessage([], baseConfig, "system");
    expect(toolCalls).toBe(0);
    expect(result.outcome).toBe("interrupted");
    expect(result.content).toBe("Let me search");
    expect(result.truncated).toBe(true);
  });
});

describe("evidence accounting (B16b)", () => {
  it("marks cut excerpts and counts only successful retrievals in the fallback note", async () => {
    let streamCalls = 0;
    let finalMessages: Array<{ role: string; content: string }> = [];
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_fetch_page") return "X".repeat(5000);
      if (cmd === "zen_chat_stream") {
        streamCalls++;
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        setTimeout(() => {
          onEvent?.onmessage({
            type: "done",
            data: openaiMessage({
              content: null,
              tool_calls: [
                {
                  id: `call_${streamCalls}`,
                  type: "function",
                  function: {
                    name: "fetch_page",
                    arguments: JSON.stringify({ url: "https://example.com/page" }),
                  },
                },
              ],
            }),
          });
        }, 0);
        return `req-${streamCalls}`;
      }
      if (cmd === "zen_chat") {
        finalMessages = (
          args as { payload: { messages: Array<{ role: string; content: string }> } }
        ).payload.messages;
        return openaiMessage({ content: "Final answer." });
      }
      if (cmd === "zen_chat_stream_cancel") return null;
      return null;
    });

    const result = await sendMessage([], baseConfig, "system");
    // The third identical call trips the loop guard: the two retrievals
    // that ran are research results, nothing else is claimed.
    expect(result.content).toContain("Web research stopped");
    expect(result.content).toContain("the final answer uses the 2 research results");
    const evidence = finalMessages.find(
      (m) => m.role === "user" && m.content.includes("Research material"),
    );
    expect(evidence).toBeDefined();
    expect(evidence!.content).toContain("[excerpt cut at 2000 characters]");
  });

  it("reports failed retrievals accurately instead of counting them as research results", async () => {
    let streamCalls = 0;
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_fetch_page") throw new Error("host unreachable");
      if (cmd === "zen_chat_stream") {
        streamCalls++;
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        setTimeout(() => {
          onEvent?.onmessage({
            type: "done",
            data: openaiMessage({
              content: null,
              tool_calls: [
                {
                  id: `call_${streamCalls}`,
                  type: "function",
                  function: {
                    name: "fetch_page",
                    arguments: JSON.stringify({ url: "https://example.com/page" }),
                  },
                },
              ],
            }),
          });
        }, 0);
        return `req-${streamCalls}`;
      }
      if (cmd === "zen_chat") return openaiMessage({ content: "Final answer." });
      if (cmd === "zen_chat_stream_cancel") return null;
      return null;
    });

    const result = await sendMessage([], baseConfig, "system");
    expect(result.content).toContain("all 2 retrievals failed");
    expect(result.content).not.toContain("the final answer uses the");
  });

  it("reports an interrupted tool batch instead of stopping silently", async () => {
    const controller = new AbortController();
    let releaseFifth: () => void = () => {};
    const fifth = new Promise<void>((resolve) => {
      releaseFifth = resolve;
    });
    let toolCalls = 0;
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_web_search") {
        toolCalls++;
        const query = (args as { query?: string }).query ?? "";
        if (query === "q4") {
          // The fifth retrieval stays in flight until after the abort.
          await fifth;
          return [{ title: "late", url: "https://example.com", snippet: "" }];
        }
        return [{ title: `result-${query}`, url: "https://example.com", snippet: "" }];
      }
      if (cmd === "zen_chat_stream") {
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        setTimeout(() => {
          onEvent?.onmessage({
            type: "done",
            data: openaiMessage({
              content: null,
              tool_calls: Array.from({ length: 5 }, (_, i) => ({
                id: `call_${i}`,
                type: "function",
                function: {
                  name: "web_search",
                  arguments: JSON.stringify({ query: `q${i}` }),
                },
              })),
            }),
          });
        }, 0);
        return "req-1";
      }
      if (cmd === "zen_chat_stream_cancel") return null;
      return null;
    });

    const pending = sendMessage([], baseConfig, "system", {
      signal: controller.signal,
    });
    // Four retrievals finish; the fifth is in flight.
    await vi.waitFor(() => expect(toolCalls).toBe(5));
    controller.abort();
    releaseFifth();
    const result = await pending;
    expect(result.stopped).toBe(true);
    expect(result.content).toContain(
      "Research was interrupted after 4 of 5 research steps finished.",
    );
  });
});

describe("cancellation coverage (B17a)", () => {
  it("abort during the nonstreaming fallback stops it, cancels the native request, and never retries", async () => {
    const controller = new AbortController();
    let chatCallId: string | null = null;
    let cancelledId: string | null = null;
    let chatCalls = 0;
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_chat_stream") {
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        setTimeout(() => {
          onEvent?.onmessage({
            type: "error",
            message: "streaming is not supported by this endpoint",
          });
        }, 0);
        return "req-1";
      }
      if (cmd === "zen_chat") {
        chatCalls++;
        chatCallId = (args as { id?: string }).id ?? null;
        // Stalls until the native cancel arrives (the real backend would
        // return "Request cancelled." once its token fires).
        return new Promise<never>(() => {});
      }
      if (cmd === "zen_chat_stream_cancel") {
        cancelledId = (args as { id?: string }).id ?? null;
        return null;
      }
      return null;
    });

    const pending = sendMessage([], baseConfig, "system", {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(chatCalls).toBe(1));
    controller.abort();
    const result = await pending;

    expect(result.stopped).toBe(true);
    expect(result.outcome).toBe("stopped");
    // Never retried/resumed after the abort.
    expect(chatCalls).toBe(1);
    // The exact id the one-shot request registered was cancelled natively.
    expect(chatCallId).not.toBeNull();
    expect(cancelledId).toBe(chatCallId);
  });

  it("an aborted Anthropic one-shot fallback also reports stopped without retrying", async () => {
    const controller = new AbortController();
    let chatCalls = 0;
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_chat_stream") {
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        setTimeout(() => {
          onEvent?.onmessage({
            type: "error",
            message: "streaming unsupported",
          });
        }, 0);
        return "req-1";
      }
      if (cmd === "zen_chat") {
        chatCalls++;
        return new Promise<never>(() => {});
      }
      return null;
    });

    const pending = sendMessage(
      [],
      { ...baseConfig, provider: "anthropic" },
      "system",
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(chatCalls).toBe(1));
    controller.abort();
    const result = await pending;
    expect(result.stopped).toBe(true);
    expect(result.outcome).toBe("stopped");
    expect(chatCalls).toBe(1);
  });

  it("abort cancels ACTIVE tool workers and never advances to another round", async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    const toolIds = new Set<string>();
    const cancelledIds: string[] = [];
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_web_search") {
        const id = (args as { id?: string }).id ?? "";
        if (id) toolIds.add(id);
        // In-flight retrievals: they only end through cancellation.
        return new Promise<never>(() => {});
      }
      if (cmd === "zen_chat_stream") {
        streamCalls++;
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        setTimeout(() => {
          onEvent?.onmessage({
            type: "done",
            data: openaiMessage({
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({ query: "one" }),
                  },
                },
                {
                  id: "call_2",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({ query: "two" }),
                  },
                },
              ],
            }),
          });
        }, 0);
        return `req-${streamCalls}`;
      }
      if (cmd === "zen_chat_stream_cancel") {
        const id = (args as { id?: string }).id ?? "";
        if (id) cancelledIds.push(id);
        return null;
      }
      return null;
    });

    const pending = sendMessage([], baseConfig, "system", {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(toolIds.size).toBe(2));
    controller.abort();
    const result = await pending;

    expect(result.stopped).toBe(true);
    expect(result.outcome).toBe("stopped");
    // The loop never advanced: no second stream round, no tools-free
    // fallback success.
    expect(streamCalls).toBe(1);
    // Every active worker's native request was cancelled.
    for (const id of toolIds) {
      expect(cancelledIds).toContain(id);
    }
    // The interrupted batch is visible to the user.
    expect(result.content).toContain("Research was interrupted");
  });
});

describe("bounded tool concurrency (5.5b)", () => {
  it("runs one batch's independent tool calls through a bounded pool with results mapped by id", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const rounds: unknown[] = [];
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "zen_web_search") {
        const query = (args as { query?: string }).query ?? "";
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return [
          {
            title: `result-${query}`,
            url: `https://example.com/${query}`,
            snippet: "",
          },
        ];
      }
      if (cmd === "zen_chat_stream") {
        const onEvent = (
          args as { onEvent?: { onmessage: (msg: unknown) => void } }
        )?.onEvent;
        rounds.push((args as { payload?: { messages: unknown[] } }).payload);
        const round = rounds.length;
        setTimeout(() => {
          if (round === 1) {
            onEvent?.onmessage({
              type: "done",
              data: openaiMessage({
                content: null,
                tool_calls: Array.from({ length: 6 }, (_, i) => ({
                  id: `call_${i}`,
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({ query: `q${i}` }),
                  },
                })),
              }),
            });
          } else {
            onEvent?.onmessage({
              type: "done",
              data: openaiMessage({ content: "final" }),
            });
          }
        }, 0);
        return `req-${round}`;
      }
      if (cmd === "zen_chat_stream_cancel") return null;
      return null;
    });

    const result = await sendMessage([], baseConfig, "system");
    expect(result.content).toBe("final");

    // Bounded pool: at most MAX_PARALLEL_TOOLS (4) at once, and more
    // than one at a time (the pool is real, not just sequential code).
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);

    // Round 2's tool messages map every result back to its OWN call id.
    const secondRound = (rounds[1] as {
      messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
    }).messages;
    const toolMessages = secondRound.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      const message = toolMessages.find((m) => m.tool_call_id === `call_${i}`);
      expect(message?.content).toContain(`result-q${i}`);
    }
  });
});
