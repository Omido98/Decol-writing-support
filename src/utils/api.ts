import { invoke, Channel } from "@tauri-apps/api/core";
import type { ApiConfig } from "@/stores/chatStore";
import type { ChatMessage } from "@/stores/chatStore";
import type { ProviderId } from "@/utils/providers";
import { buildDeslopPrompt } from "@/utils/systemPrompt";

/**
 * The shared completeness model every consumer classifies on (B16):
 * - complete: the provider's terminal signal arrived and usable content
 *   (or a deliberate tools-free fallback answer) was delivered;
 * - stopped: the user aborted; `content` holds the partial text;
 * - interrupted: the transport ended without the provider's terminal
 *   signal (connection cut) or errored after output began;
 * - truncated: the provider finished because it hit an output limit
 *   (finish_reason "length" / stop_reason "max_tokens");
 * - failed: no usable content was produced and an error explains why.
 * `truncated`/`stopped` booleans remain for callers that only need the
 * coarse classification; `outcome` is the authoritative one.
 */
export type ApiOutcome =
  | "complete"
  | "stopped"
  | "interrupted"
  | "truncated"
  | "failed";

export interface ApiResponse {
  content: string;
  error?: string;
  /** The single UI-facing outcome. */
  outcome: ApiOutcome;
  /** True when the user stopped generation; `content` holds the partial answer. */
  stopped?: boolean;
  /** True when the delivered answer is incomplete (interrupted/truncated). */
  truncated?: boolean;
  /** The provider's observed finish reason, when known ("stop", "length", ...). */
  finishReason?: string | null;
  /** Provider usage data, when reported (normalized to the root level). */
  usage?: unknown;
}

/** Options for sendMessage: live text rendering and stop support. */
export interface SendMessageOptions {
  /** Called with each chunk of text as it streams in (live rendering). */
  onDelta?: (text: string) => void;
  /** Aborting the signal stops generation; whatever was streamed is returned. */
  signal?: AbortSignal;
}

/** An event emitted by the Rust `zen_chat_stream` command. */
type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; data: unknown }
  | { type: "error"; message: string };

/** A single web search result, as returned by the Rust `zen_web_search` command. */
interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

/** A single Zen pricing entry scraped from the Zen docs page. */
export interface ZenPricingEntry {
  id: string;
  /** Human-readable display name ("Model" column), when known. */
  name?: string | null;
  input: number | null;
  output: number | null;
  is_free: boolean;
}

/** An OpenAI-shaped message used inside the tool-calling loop. */
interface ApiMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** A function call requested by the model (OpenAI tool-calling format). */
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
}

const MAX_TOOL_ROUNDS = 15;

/** How many tool calls of one batch may run at once (5.5b): the calls
 * of a single batch are independent (searches/fetches), so a bounded
 * pool keeps research responsive without unbounded parallelism. */
const MAX_PARALLEL_TOOLS = 4;

/** Run workers over items with bounded concurrency (order of START is
 * irrelevant; each item's slot is fixed). */
async function runBounded<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
}

/**
 * Tool-round budget when deep research is enabled: high enough for
 * thorough multi-query research, but still a backstop so a looping model
 * always eventually answers (alongside the identical-repeat detection and
 * the user's Stop button).
 */
const DEEP_RESEARCH_TOOL_ROUNDS = 50;

/** Tool-round budget for a request, based on the deep-research setting. */
function maxToolRounds(config: ApiConfig): number {
  return config.deepResearchEnabled ? DEEP_RESEARCH_TOOL_ROUNDS : MAX_TOOL_ROUNDS;
}

/** One research action's retained evidence (identity, target, status, body). */
interface EvidencePacket {
  tool: string;
  /** The query or URL the tool was invoked with. */
  target: string;
  /** `interrupted` = the batch was cancelled before this call ran. */
  status: "succeeded" | "failed" | "interrupted";
  /** Excerpt: the tool's result body (truncated for the fallback message). */
  body: string;
}

/** Characters of a tool result kept in the evidence fallback note. */
const EVIDENCE_EXCERPT_LIMIT = 2000;

/** Render retained evidence packets for a tools-free final round. An
 * excerpt that was cut says so (the model must not read it as complete). */
function renderEvidence(packets: EvidencePacket[]): string {
  return packets
    .map((p) => {
      const body =
        p.body.length > EVIDENCE_EXCERPT_LIMIT
          ? `${p.body.slice(0, EVIDENCE_EXCERPT_LIMIT)}\n` +
            `[excerpt cut at ${EVIDENCE_EXCERPT_LIMIT} characters]`
          : p.body;
      return `[${p.tool}: ${p.target} — ${p.status}]\n${body}`;
    })
    .join("\n\n");
}

/**
 * The user-facing note for a tools-free final round. Counts ONLY
 * successful retrievals as research results and reports failed/cancelled
 * retrievals explicitly, so the note never overstates the material the
 * answer is based on (B16b).
 */
function evidenceNote(
  reason: "exhausted" | "unsupported",
  packets: EvidencePacket[],
): string {
  let ok = 0;
  let failed = 0;
  let interrupted = 0;
  for (const p of packets) {
    if (p.status === "succeeded") ok++;
    else if (p.status === "failed") failed++;
    else interrupted++;
  }
  const plural = (n: number) => (n === 1 ? "" : "s");
  const caveats: string[] = [];
  if (failed > 0) {
    caveats.push(`${failed} retrieval${plural(failed)} failed`);
  }
  if (interrupted > 0) {
    caveats.push(
      `${interrupted} retrieval${plural(interrupted)} interrupted`,
    );
  }
  const qualifier = caveats.length > 0 ? ` (${caveats.join("; ")})` : "";
  if (ok > 0) {
    return reason === "unsupported"
      ? `[Web tools are not supported here — the final answer uses the ${ok} research result${plural(
          ok,
        )} gathered before stopping${qualifier}.]\n\n`
      : `[Web research stopped — the final answer uses the ${ok} research result${plural(
          ok,
        )} gathered so far${qualifier}.]\n\n`;
  }
  const total = ok + failed + interrupted;
  if (total > 0) {
    return reason === "unsupported"
      ? `[Web tools are not supported here — all ${total} retrieval${plural(
          total,
        )} failed; answering without research material.${qualifier}]\n\n`
      : `[Web research stopped — all ${total} retrieval${plural(
          total,
        )} failed; answering without research material.${qualifier}]\n\n`;
  }
  return reason === "unsupported"
    ? "[Web search unavailable — answering without it]\n\n"
    : "[Web research stopped — answering without it]\n\n";
}

/** Note appended to a STOPPED response whose tool batch was cancelled
 * before it finished: the interrupted research is never silent (B16b). */
function interruptedResearchNote(ran: number, total: number): string {
  if (ran <= 0) {
    return "[Research was interrupted before any results were returned.]\n\n";
  }
  return `[Research was interrupted after ${ran} of ${total} research steps finished.]\n\n`;
}

/**
 * Prefix prepended when the tool loop runs out of rounds (or repeats a call)
 * but the model already drafted some text — the draft is still handed back
 * instead of failing the whole message.
 */
const PARTIAL_ANSWER_NOTE =
  "[The model kept researching and did not write a final answer. Here is what it drafted before stopping.]\n\n";

/** Tools advertised to models that support function calling. */
const TOOLS: Array<Record<string, unknown>> = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current information. Returns up to 5 results with title, URL and snippet. Use it to research facts, current events, and scholarly literature, and to verify citations before including them.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The search query, e.g. a topic, an event, or a work with its author.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description:
        "Fetch a web page and return its text content (tags stripped, length-limited). Use it to read an article, a documentation page, or a scholarly source such as a journal or publisher page.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The full URL (http/https) of the page to fetch.",
          },
        },
        required: ["url"],
      },
    },
  },
];

/**
 * List available models from a `/models` endpoint (OpenAI-compatible shape,
 * which Anthropic also uses).
 * Runs through Rust so the webview never hits CORS restrictions.
 *
 * @param baseUrl - The API base URL (e.g. https://opencode.ai/zen/v1).
 * @param apiKey  - The API key, sent as the provider's auth header.
 * @param provider - The provider id, which determines the endpoint & auth.
 * @returns The list of model IDs.
 */
export async function listModels(
  baseUrl: string,
  apiKey = "",
  provider: ProviderId = "zen",
): Promise<string[]> {
  try {
    return await invoke<string[]>("zen_list_models", {
      baseUrl,
      apiKey,
      provider,
    });
  } catch (err) {
    throw new Error(
      typeof err === "string" ? err : "Failed to load the model list.",
    );
  }
}

/**
 * Fetch the current OpenCode Zen pricing table from the official docs page.
 * Runs through Rust so the webview never hits CORS restrictions.
 *
 * @returns The list of pricing entries (model id, input/output price, free flag).
 */
export async function fetchZenPricing(): Promise<ZenPricingEntry[]> {
  try {
    return await invoke<ZenPricingEntry[]>("zen_fetch_zen_pricing");
  } catch (err) {
    throw new Error(
      typeof err === "string" ? err : "Failed to import model prices.",
    );
  }
}

/**
 * Send a message to the configured LLM provider. Routes to the correct
 * adapter based on `config.provider` (OpenAI-compatible or Anthropic).
 * Responses stream in chunk-by-chunk; each text chunk is forwarded to
 * `options.onDelta` and the final answer is returned when the stream ends.
 *
 * @param messages - The conversation history including the new user message.
 * @param config   - API configuration (provider, baseUrl, apiKey, model, ...).
 * @param systemPrompt - The system prompt to prepend (not included in messages array).
 * @param options  - Live-text callback and an optional AbortSignal to stop generation.
 * @returns The assistant's reply content, or an error message.
 */
export async function sendMessage(
  messages: ChatMessage[],
  config: ApiConfig,
  systemPrompt: string,
  options: SendMessageOptions = {},
): Promise<ApiResponse> {
  if (config.provider === "anthropic") {
    return sendAnthropicMessage(messages, config, systemPrompt, options);
  }
  return sendOpenAICompatMessage(messages, config, systemPrompt, options);
}

/**
 * Run the "Remove AI slop" pass on a single draft: sends the draft as the
 * only user message with the de-slop editor prompt and no tools, and
 * returns the cleaned draft (or "No changes needed.").
 *
 * @param draft - The assistant message text to clean up.
 * @param config - API configuration (provider, baseUrl, apiKey, model, ...).
 * @param options - Live-text callback and an optional AbortSignal.
 * @returns The cleaned reply content, or an error message.
 */
export async function deslopText(
  draft: string,
  config: ApiConfig,
  options: SendMessageOptions = {},
): Promise<ApiResponse> {
  return sendMessage(
    [{ role: "user", content: draft, timestamp: new Date().toISOString() }],
    { ...config, webSearchEnabled: false },
    buildDeslopPrompt(),
    options,
  );
}

/**
 * Stream a single chat-completions round through the Rust backend.
 * Resolves when the stream ends (or is stopped); text chunks are forwarded
 * to `onChunk` for live rendering.
 *
 * Event discipline (R9): the channel handler is registered BEFORE the
 * request starts (early events cannot be lost); cancellation is honoured
 * before and immediately after the startup acknowledgement (queued until
 * the request id arrives); every event after terminal settlement is
 * ignored; finish reason, usage, and the truncation marker are preserved.
 */
async function streamChat(
  baseUrl: string,
  apiKey: string,
  provider: string,
  payload: Record<string, unknown>,
  options: SendMessageOptions,
  onChunk: (text: string) => void,
): Promise<{ data?: unknown; error?: string; stopped?: boolean }> {
  if (options.signal?.aborted) {
    return { stopped: true };
  }

  const channel = new Channel<ChatStreamEvent>();
  let requestId = "";
  let cancelQueued = false;
  let settled = false;

  let finish: (result: { data?: unknown; error?: string; stopped?: boolean }) => void =
    () => {};

  function cleanup() {
    options.signal?.removeEventListener("abort", onAbort);
  }

  function onAbort() {
    if (requestId) {
      // Best-effort: tell Rust to close the HTTP connection.
      void invoke("zen_chat_stream_cancel", { id: requestId }).catch(() => {});
    } else {
      // Cancellation BEFORE the startup acknowledgement: queued, and the
      // cancel fires the moment the request id arrives.
      cancelQueued = true;
    }
    finish({ stopped: true });
  }

  // The handler is attached before the request is started, so no early
  // event can slip through unhandled.
  channel.onmessage = (event: ChatStreamEvent) => {
    if (settled) return; // ignore every event after terminal settlement
    switch (event.type) {
      case "delta":
        onChunk(event.text);
        break;
      case "done":
        finish({ data: event.data });
        break;
      case "error":
        finish({ error: event.message });
        break;
    }
  };

  options.signal?.addEventListener("abort", onAbort, { once: true });

  return new Promise((resolve) => {
    finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    void (async () => {
      try {
        requestId = await invoke<string>("zen_chat_stream", {
          baseUrl,
          apiKey,
          provider,
          payload,
          onEvent: channel,
        });
        if (cancelQueued) {
          void invoke("zen_chat_stream_cancel", { id: requestId }).catch(() => {});
        }
      } catch (err) {
        finish({
          error: typeof err === "string" ? err : "An unknown error occurred.",
        });
      }
    })();
  });
}

/** An Error carrying the cancellation identity the adapters classify on. */
function cancelledError(): Error {
  const err = new Error("Request cancelled.");
  err.name = "AbortError";
  return err;
}

/**
 * Invoke a NON-STREAMING Rust command with full cancellation (B17a): the
 * request gets a stable id, and an abort calls the shared native cancel
 * command so DNS, headers, and body reading terminate natively — not just
 * by abandoning the promise. A cancel that arrives before the command
 * registers is kept as a pre-cancelled tombstone natively.
 */
async function invokeAbortable<T>(
  cmd: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw cancelledError();
  const id = crypto.randomUUID();
  let rejectAborted: (err: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  // Handled even when the abort wins before the race below attaches.
  aborted.catch(() => {});
  const onAbort = () => {
    // Best-effort: tell Rust to stop the request and close its connection.
    void invoke("zen_chat_stream_cancel", { id }).catch(() => {});
    rejectAborted(cancelledError());
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([invoke<T>(cmd, { ...args, id }), aborted]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Flags of a stream's Done payload: observed finish reason + protocol state. */
interface StreamFlags {
  finishReason?: string | null;
  usage?: unknown;
  /** True when the stream ended WITHOUT the provider's terminal signal. */
  truncated?: boolean;
}

/**
 * Classify a completed round from its OBSERVED finish reason and its
 * protocol terminal state (separated on purpose, B16): a missing terminal
 * signal is an interruption; a provider-declared output limit is a
 * truncation; both are distinguished from a clean completion.
 */
function finishOutcome(flags: StreamFlags): ApiOutcome {
  if (flags.truncated === true) return "interrupted";
  if (
    typeof flags.finishReason === "string" &&
    /^(length|max_tokens)$/i.test(flags.finishReason)
  ) {
    return "truncated";
  }
  return "complete";
}

/** True when an outcome delivered content but not the full answer. */
function isPartialOutcome(outcome: ApiOutcome): boolean {
  return outcome === "interrupted" || outcome === "truncated";
}

/** Extract finishReason/usage/truncated from a stream's Done payload. */
function streamResultFlags(data: unknown): StreamFlags {
  if (!data || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;
  const finishReason =
    (d["finishReason"] as string | undefined | null) ??
    (d["stop_reason"] as string | undefined | null) ??
    ((d as { choices?: Array<{ finish_reason?: string }> }).choices?.[0]
      ?.finish_reason ?? null);
  return {
    finishReason: typeof finishReason === "string" ? finishReason : null,
    // Normalized root-level usage: the accumulator may carry it at the
    // root (Anthropic, OpenAI usage chunk) or inside the choice.
    usage:
      d["usage"] ??
      (d as { choices?: Array<{ usage?: unknown }> }).choices?.[0]?.usage ??
      undefined,
    truncated:
      d["truncated"] === true ||
      ((d as { choices?: Array<{ truncated?: boolean }> }).choices?.[0]
        ?.truncated ===
        true),
  };
}

/** A partial answer with its completeness metadata attached. */
function partialResponse(
  content: string,
  flags: StreamFlags,
  error?: string,
): ApiResponse {
  const outcome = finishOutcome(flags);
  return {
    ...flags,
    content,
    outcome: isPartialOutcome(outcome) ? outcome : "interrupted",
    truncated: true,
    ...(error ? { error } : {}),
  };
}

/** A round's delivered answer with its completeness metadata attached. */
function roundResponse(content: string, flags: StreamFlags): ApiResponse {
  const outcome = finishOutcome(flags);
  return {
    ...flags,
    content,
    outcome,
    ...(isPartialOutcome(outcome) ? { truncated: true } : {}),
  };
}

/**
 * Send a message to an OpenAI-compatible chat completions endpoint.
 * The request is executed by Rust, bypassing webview CORS restrictions.
 * Response text is streamed (SSE) and forwarded to `options.onDelta` so the
 * chat UI can render it live; the full answer is returned when the stream ends.
 *
 * Runs a tool-calling loop: if the model requests `web_search` or
 * `fetch_page`, the tools are executed through Rust and their results are
 * fed back to the model, up to `MAX_TOOL_ROUNDS` rounds (or
 * `DEEP_RESEARCH_TOOL_ROUNDS` with deep research enabled). If the model
 * rejects the `tools` field, the request is retried once without it and a
 * short note is prepended to the reply. Providers that reject streaming
 * fall back to one-shot requests automatically.
 */
async function sendOpenAICompatMessage(
  messages: ChatMessage[],
  config: ApiConfig,
  systemPrompt: string,
  options: SendMessageOptions = {},
): Promise<ApiResponse> {
  const { baseUrl, apiKey, model, reasoningEffort } = config;

  if (!apiKey) {
    return { content: "", error: "API key is not configured.", outcome: "failed" };
  }

  if (!baseUrl) {
    return { content: "", error: "API base URL is not configured.", outcome: "failed" };
  }

  // Conversation so far (system prompt is prepended on each request).
  const history: ApiMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Whether the current and future requests advertise tools. Set to false
  // after a tools-related error so the retry works with plain models, or
  // from the start when the user disabled web search.
  let useTools = config.webSearchEnabled !== false;

  // Whether responses are streamed. Set to false when the provider rejects
  // streaming (the answer then appears all at once instead of live).
  let useStream = true;

  // Text the model drafted alongside tool calls; returned if the loop
  // cannot finish (round cap or a repeated call).
  let partialContent: string | null = null;

  // Text streamed so far; returned as the partial answer when the user stops.
  let streamedContent = "";

  // Counts of every tool call signature made so far, to detect looping
  // models. A call only counts as stuck once the same signature appears a
  // third time: models legitimately re-search a topic or re-fetch a page
  // that failed or came back truncated.
  const callCounts = new Map<string, number>();

  const buildPayload = (withTools: boolean, stream: boolean): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      model: model || "deepseek-v4-flash-free",
      messages: [
        { role: "system", content: systemPrompt },
        ...history.map((m) => {
          if (m.role === "tool") {
            return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
          }
          if (m.tool_calls) {
            return { role: m.role, content: m.content, tool_calls: m.tool_calls };
          }
          return { role: m.role, content: m.content };
        }),
      ],
    };

    if (withTools) {
      payload["tools"] = TOOLS;
    }

    // Append reasoning effort as an OpenAI-compatible field if set
    if (reasoningEffort) {
      payload["reasoning_effort"] = reasoningEffort;
    }

    if (stream) {
      payload["stream"] = true;
    }
    return payload;
  };

  const runNonStreamingRound = async (
    withTools: boolean,
  ): Promise<{ data?: ChatResponse; error?: string; stopped?: boolean }> => {
    try {
      const data = await invokeAbortable<ChatResponse>(
        "zen_chat",
        {
          baseUrl,
          apiKey,
          provider: config.provider,
          payload: buildPayload(withTools, false),
        },
        options.signal,
      );
      return { data };
    } catch (err) {
      // An abort is a STOP, not a provider error: the native request was
      // cancelled and the round reports it as such (B17a).
      if (
        options.signal?.aborted ||
        (err as { name?: string })?.name === "AbortError"
      ) {
        return { stopped: true };
      }
      const message =
        typeof err === "string" ? err : "An unknown error occurred.";
      return { error: message };
    }
  };

  /**
   * The model repeated a tool call or exhausted its rounds without writing a
   * final answer. Rather than failing the request, stop the research and run
   * one final round so it writes its answer — WITH the material it already
   * gathered. (Deleting tool results made the model answer from nothing.)
   * The evidence packets keep their tool identity, query/URL, retrieval
   * status, and excerpts, so the label is accurate: when research produced
   * material, the final answer is NOT "without it".
   */
  const finishWithoutTools = async (
    fallbackError: string,
    reason: "exhausted" | "unsupported",
  ): Promise<ApiResponse> => {
    useTools = false;
    // Collapse the research into a single user message: tool artifacts
    // cannot stay in a tools-free request, but the gathered material must.
    const evidence = evidenceLog.map((p) => renderEvidence([p]));
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "tool") {
        history.splice(i, 1);
      } else {
        delete history[i].tool_calls;
      }
    }
    if (evidence.length > 0) {
      history.push({
        role: "user",
        content:
          `[Research material collected so far]\n\n${evidence.join("\n\n")}\n\n` +
          "Web research has stopped. Write the final answer using the material above.",
      });
    }

    const retry = await runNonStreamingRound(false);
    if (retry.stopped) {
      // The final round was cancelled: no fallback answer is claimed.
      return { content: streamedContent, stopped: true, outcome: "stopped" };
    }
    if (retry.error) {
      return { content: "", error: retry.error, outcome: "failed" };
    }
    const content = retry.data?.choices?.[0]?.message?.content;
    if (content == null) {
      return partialContent
        ? { content: `${PARTIAL_ANSWER_NOTE}${partialContent}`, outcome: "complete" }
        : { content: "", error: fallbackError, outcome: "failed" };
    }
    // Accurate labels: with retained evidence the answer is NOT "without"
    // the research; "unsupported" only hides the label when nothing was
    // gathered at all. Failed/cancelled retrievals are counted separately.
    const note = evidenceNote(reason, evidenceLog);
    return { content: `${note}${content}`, outcome: "complete" };
  };

  // Research evidence ledger: every tool call's identity, target, status,
  // and excerpt — retained through every finalization/fallback path.
  const evidenceLog: EvidencePacket[] = [];

  /** Execute one tool call IF web tools are permitted — the permission is
   * enforced here, at EXECUTION time, not only when advertising tools. The
   * request travels with the operation's abort signal, so Stop cancels an
   * active tool worker natively (B17a). */
  const executePermittedTool = async (
    call: ToolCall,
  ): Promise<string> => {
    if (config.webSearchEnabled === false) {
      return "Error: web tools are disabled in settings; this tool call was not executed.";
    }
    const args = parseToolArguments(call);
    const target =
      call.function.name === "web_search"
        ? String(args.query ?? "")
        : String(args.url ?? "");
    try {
      const body = await runToolBody(call.function.name, args, options.signal);
      evidenceLog.push({ tool: call.function.name, target, status: "succeeded", body });
      return body;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      evidenceLog.push({
        tool: call.function.name,
        target,
        // A cancelled retrieval is reported as interrupted, never as a
        // retriable provider failure.
        status: options.signal?.aborted ? "interrupted" : "failed",
        body: message,
      });
      return `Error while running ${call.function.name}: ${message}`;
    }
  };

  const maxRounds = maxToolRounds(config);
  for (let round = 0; round < maxRounds; round++) {
    if (options.signal?.aborted) {
      return { content: streamedContent, stopped: true, outcome: "stopped" };
    }

    let result = useStream
      ? await streamChat(baseUrl, apiKey, config.provider, buildPayload(useTools, true), options, (text) => {
          streamedContent += text;
          options.onDelta?.(text);
        })
      : await runNonStreamingRound(useTools);

    // A Stop is terminal: never advance to tools, fallbacks, or a
    // committed success once the signal fired (B17a).
    if (result.stopped || options.signal?.aborted) {
      return { content: streamedContent, stopped: true, outcome: "stopped" };
    }

    if (result.error) {
      // Automatic capability fallback only BEFORE output starts: once the
      // model has produced text, a failing stream must not silently restart
      // the answer — the partial content is returned as truncated.
      if (useStream && streamedContent === "" && /stream|sse|chunk|event/i.test(result.error)) {
        useStream = false;
        result = await runNonStreamingRound(useTools);
      }
      if (result.stopped || options.signal?.aborted) {
        return { content: streamedContent, stopped: true, outcome: "stopped" };
      }

      if (result.error) {
        // Some models reject the `tools` field; retry once without it —
        // but only before output starts. The fallback RETAINS the research
        // evidence (the gathered material is collapsed into the request).
        if (useTools && streamedContent === "" && /tool/i.test(result.error)) {
          return finishWithoutTools(
            "Web search is not supported by this model or endpoint.",
            "unsupported",
          );
        }
        // After output started (or non-recoverable): return the partial
        // content as an explicitly truncated answer, preserving the error.
        if (streamedContent !== "") {
          return partialResponse(streamedContent, {}, result.error);
        }
        return { content: "", error: result.error, outcome: "failed" };
      }
    }

    const flags = streamResultFlags(result.data);
    const data = result.data as ChatResponse | undefined;
    const message = data?.choices?.[0]?.message;
    // A round that did not terminate cleanly is never ACTED on: partial
    // tool-call arguments must not execute a request the model never
    // finished writing. The partial text is preserved and marked (B16).
    if (finishOutcome(flags) !== "complete") {
      const partial =
        streamedContent || message?.content || partialContent || "";
      if (partial.trim()) return partialResponse(partial, flags);
      return {
        content: "",
        error:
          "The response was cut off before it could finish; no answer was produced.",
        outcome: finishOutcome(flags),
        ...flags,
      };
    }
    const toolCalls = message?.tool_calls;
    const drafted = message?.content;

    if (toolCalls && toolCalls.length > 0) {
      // Permission enforced at EXECUTION time: a provider returning tool
      // calls although the user disabled web tools never gets them run.
      if (config.webSearchEnabled === false || !useTools) {
        if (drafted != null && drafted.trim() !== "") {
          return roundResponse(drafted, flags);
        }
        return {
          content: "",
          error: "The model requested web tools, but web search is disabled.",
          outcome: finishOutcome(flags),
          ...flags,
        };
      }
      // Keep any text drafted alongside the tool calls: if the loop cannot
      // finish, that draft is still returned instead of an error.
      if (drafted && !partialContent) {
        partialContent = drafted;
      }

      // If the model requests the same tool call a third time, it is stuck in
      // a loop — stop researching and force a tools-free final round. One
      // repeat is not a loop: models legitimately re-search a topic or
      // re-fetch a page that failed or came back truncated.
      const keys = toolCalls.map(
        (call) => `${call.function.name}(${call.function.arguments})`,
      );
      let stuck = false;
      for (const key of keys) {
        const count = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, count);
        if (count >= 3) {
          stuck = true;
          break;
        }
      }
      if (stuck) {
        return finishWithoutTools(
          "The model got stuck repeating the same web request. Please try again.",
          "exhausted",
        );
      }

      // Record the assistant's tool-call message, then feed back the results.
      history.push({
        role: "assistant",
        content: drafted ?? null,
        tool_calls: toolCalls,
      });

      // Tool calls of one batch are independent: run with bounded
      // concurrency (5.5b). Stop is honored: workers not yet started
      // never run, and ACTIVE workers are cancelled natively through
      // their request signal (B17a).
      const evidenceBefore = evidenceLog.length;
      const toolResults: (string | null)[] = toolCalls.map(() => null);
      await runBounded(toolCalls, MAX_PARALLEL_TOOLS, async (call, index) => {
        if (options.signal?.aborted) return;
        toolResults[index] = await executePermittedTool(call);
      });
      for (let i = 0; i < toolCalls.length; i++) {
        if (toolResults[i] == null) continue;
        history.push({
          role: "tool",
          tool_call_id: toolCalls[i].id,
          content: toolResults[i] as string,
        });
      }
      if (options.signal?.aborted) {
        // The batch was cancelled mid-flight: record the calls that never
        // ran and report the interrupted research (never a silent stop).
        // A call counts as finished only when its evidence packet is not
        // an interruption — a cancelled active worker returns an error
        // string, so counting non-null results would overstate the batch.
        const finished = evidenceLog
          .slice(evidenceBefore)
          .filter((p) => p.status !== "interrupted").length;
        for (let i = 0; i < toolCalls.length; i++) {
          if (toolResults[i] != null) continue;
          const call = toolCalls[i];
          const args = parseToolArguments(call);
          evidenceLog.push({
            tool: call.function.name,
            target:
              call.function.name === "web_search"
                ? String(args.query ?? "")
                : String(args.url ?? ""),
            status: "interrupted",
            body: "Interrupted before execution.",
          });
        }
        const note =
          streamedContent.trim() === "" && finished < toolCalls.length
            ? interruptedResearchNote(finished, toolCalls.length)
            : "";
        return { content: `${note}${streamedContent}`, stopped: true, outcome: "stopped" };
      }
      continue;
    }

    if (drafted == null) {
      // A truncated stream still carries partial content — return it as
      // such instead of discarding it as "no message".
      if (flags.truncated && streamedContent !== "") {
        return partialResponse(streamedContent, flags);
      }
      return {
        content: "",
        error: "API response did not contain a message.",
        outcome: "failed",
      };
    }
    return roundResponse(drafted, flags);
  }

  // Ran out of tool rounds: force a tools-free final answer instead of
  // failing, so the model writes with what it already researched.
  return finishWithoutTools(
    "The model kept requesting web tools without producing a final answer. Please try again.",
    "exhausted",
  );
}

// ──────────────────────────────────────────────
// Anthropic adapter (Messages API)
// ──────────────────────────────────────────────

/** A single content block in an Anthropic response. */
interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
}

type AnthropicContent = string | AnthropicContentBlock[];

interface AnthropicHistoryMessage {
  role: "user" | "assistant";
  content: AnthropicContent;
}

/** Advertised max output tokens for Anthropic requests (required field). */
const ANTHROPIC_MAX_TOKENS = 4096;
/** Fallback model when none is configured. */
const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-5";

/** Convert the OpenAI-shaped TOOLS list to Anthropic's `input_schema` format. */
function toAnthropicTools(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => {
    const fn = tool.function as {
      name: string;
      description: string;
      parameters: unknown;
    };
    return {
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters,
    };
  });
}

/**
 * Send a message to the Anthropic Messages API (`/v1/messages`).
 * Response text is streamed (SSE) and forwarded to `options.onDelta` for
 * live rendering. Runs a tool-calling loop like the OpenAI path, but with
 * Anthropic's `tool_use` / `tool_result` content blocks.
 */
async function sendAnthropicMessage(
  messages: ChatMessage[],
  config: ApiConfig,
  systemPrompt: string,
  options: SendMessageOptions = {},
): Promise<ApiResponse> {
  const { baseUrl, apiKey, model } = config;

  if (!apiKey) {
    return { content: "", error: "API key is not configured.", outcome: "failed" };
  }

  if (!baseUrl) {
    return { content: "", error: "API base URL is not configured.", outcome: "failed" };
  }

  // Clean text-only history; tool artifacts live in `toolContext` and are
  // dropped entirely if the model rejects the tools field.
  const history: AnthropicHistoryMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  let toolContext: AnthropicHistoryMessage[] = [];

  // Whether the current and future requests advertise tools. Set to false
  // after a tools-related error so the retry works with plain models, or
  // from the start when the user disabled web search.
  let useTools = config.webSearchEnabled !== false;

  // Whether responses are streamed. Set to false when the provider rejects
  // streaming (the answer then appears all at once instead of live).
  let useStream = true;

  // Text the model drafted alongside tool_use blocks; returned if the loop
  // cannot finish (round cap or a repeated call).
  let partialContent: string | null = null;

  // Text streamed so far; returned as the partial answer when the user stops.
  let streamedContent = "";

  // Counts of every tool call signature made so far, to detect looping
  // models. A call only counts as stuck once the same signature appears a
  // third time: models legitimately re-search a topic or re-fetch a page
  // that failed or came back truncated.
  const callCounts = new Map<string, number>();

  const buildPayload = (withTools: boolean, stream: boolean): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      model: model || ANTHROPIC_DEFAULT_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: systemPrompt,
      messages: [...history, ...toolContext],
    };

    if (withTools) {
      payload["tools"] = toAnthropicTools();
    }

    if (stream) {
      payload["stream"] = true;
    }
    return payload;
  };

  const runNonStreamingRound = async (
    withTools: boolean,
  ): Promise<{ data?: AnthropicResponse; error?: string; stopped?: boolean }> => {
    try {
      const data = await invokeAbortable<AnthropicResponse>(
        "zen_chat",
        {
          baseUrl,
          apiKey,
          provider: "anthropic",
          payload: buildPayload(withTools, false),
        },
        options.signal,
      );
      return { data };
    } catch (err) {
      // An abort is a STOP, not a provider error (B17a).
      if (
        options.signal?.aborted ||
        (err as { name?: string })?.name === "AbortError"
      ) {
        return { stopped: true };
      }
      const message =
        typeof err === "string" ? err : "An unknown error occurred.";
      return { error: message };
    }
  };

  /**
   * The model repeated a tool call or exhausted its rounds without writing a
   * final answer. Rather than failing the request, stop the research and run
   * one final round so it writes its answer — WITH the material it already
   * gathered. (Clearing the tool context discarded every search result.)
   * Evidence packets keep tool identity, query/URL, status, and excerpts.
   */
  const finishWithoutTools = async (
    fallbackError: string,
    reason: "exhausted" | "unsupported",
  ): Promise<ApiResponse> => {
    useTools = false;
    // Collapse the research into a single user message (Anthropic needs
    // user/assistant alternation, so the evidence merges into one turn).
    const evidence = evidenceLog.map((p) => renderEvidence([p]));
    if (evidence.length > 0) {
      const packet =
        `[Research material collected so far]\n\n${evidence.join("\n\n")}\n\n` +
        "Web research has stopped. Write the final answer using the material above.";
      const last = history[history.length - 1];
      if (last && last.role === "user" && typeof last.content === "string") {
        last.content = `${last.content}\n\n${packet}`;
        toolContext = [];
      } else {
        toolContext = [{ role: "user", content: packet }];
      }
    } else {
      toolContext = [];
    }

    const retry = await runNonStreamingRound(false);
    if (retry.stopped) {
      // The final round was cancelled: no fallback answer is claimed.
      return { content: streamedContent, stopped: true, outcome: "stopped" };
    }
    if (retry.error) {
      return { content: "", error: retry.error, outcome: "failed" };
    }
    const text = textFromAnthropicBlocks(retry.data?.content);
    if (text == null) {
      return partialContent
        ? { content: `${PARTIAL_ANSWER_NOTE}${partialContent}`, outcome: "complete" }
        : { content: "", error: fallbackError, outcome: "failed" };
    }
    const note = evidenceNote(reason, evidenceLog);
    return { content: `${note}${text}`, outcome: "complete" };
  };

  // Research evidence ledger (see the OpenAI adapter): identity, target,
  // retrieval status, and excerpts retained through every finalization.
  const evidenceLog: EvidencePacket[] = [];

  /** Execute a tool_use block with execution-time permission enforcement.
   * The request travels with the operation's abort signal (B17a). */
  const executePermittedAnthropicTool = async (
    call: AnthropicContentBlock,
  ): Promise<string> => {
    if (config.webSearchEnabled === false) {
      return "Error: web tools are disabled in settings; this tool call was not executed.";
    }
    const name = call.name ?? "";
    const args = call.input ?? {};
    const target = name === "web_search" ? String(args.query ?? "") : String(args.url ?? "");
    try {
      const body = await runToolBody(name, args, options.signal);
      evidenceLog.push({ tool: name, target, status: "succeeded", body });
      return body;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      evidenceLog.push({
        tool: name,
        target,
        status: options.signal?.aborted ? "interrupted" : "failed",
        body: message,
      });
      return `Error while running ${name}: ${message}`;
    }
  };

  const maxRounds = maxToolRounds(config);
  for (let round = 0; round < maxRounds; round++) {
    if (options.signal?.aborted) {
      return { content: streamedContent, stopped: true, outcome: "stopped" };
    }

    let result = useStream
      ? await streamChat(baseUrl, apiKey, "anthropic", buildPayload(useTools, true), options, (text) => {
          streamedContent += text;
          options.onDelta?.(text);
        })
      : await runNonStreamingRound(useTools);

    // A Stop is terminal: never advance to tools, fallbacks, or a
    // committed success once the signal fired (B17a).
    if (result.stopped || options.signal?.aborted) {
      return { content: streamedContent, stopped: true, outcome: "stopped" };
    }

    if (result.error) {
      // Automatic capability fallback only BEFORE output starts.
      if (useStream && streamedContent === "" && /stream|sse|chunk|event/i.test(result.error)) {
        useStream = false;
        result = await runNonStreamingRound(useTools);
      }
      if (result.stopped || options.signal?.aborted) {
        return { content: streamedContent, stopped: true, outcome: "stopped" };
      }

      if (result.error) {
        // Some models reject the `tools` field; retry once without it —
        // only before output starts, and WITH retained evidence.
        if (useTools && streamedContent === "" && /tool/i.test(result.error)) {
          return finishWithoutTools(
            "Web search is not supported by this model or endpoint.",
            "unsupported",
          );
        }
        if (streamedContent !== "") {
          return partialResponse(streamedContent, {}, result.error);
        }
        return { content: "", error: result.error, outcome: "failed" };
      }
    }

    const flags = streamResultFlags(result.data);
    const data = result.data as AnthropicResponse | undefined;
    const blocks = data?.content ?? [];
    // Same gate as the OpenAI adapter: an interrupted/limit-stopped round
    // never executes tool_use blocks (their input JSON may be cut off).
    if (finishOutcome(flags) !== "complete") {
      const partial =
        streamedContent || textFromAnthropicBlocks(blocks) || partialContent || "";
      if (partial.trim()) return partialResponse(partial, flags);
      return {
        content: "",
        error:
          "The response was cut off before it could finish; no answer was produced.",
        outcome: finishOutcome(flags),
        ...flags,
      };
    }
    const toolUses = blocks.filter((b) => b.type === "tool_use");

    if (toolUses.length > 0) {
      // Permission enforced at EXECUTION time.
      if (config.webSearchEnabled === false || !useTools) {
        const draftedNow = textFromAnthropicBlocks(blocks);
        if (draftedNow && draftedNow.trim() !== "") {
          return roundResponse(draftedNow, flags);
        }
        return {
          content: "",
          error: "The model requested web tools, but web search is disabled.",
          outcome: finishOutcome(flags),
          ...flags,
        };
      }
      // Keep any text drafted alongside the tool calls: if the loop cannot
      // finish, that draft is still returned instead of an error.
      const drafted = textFromAnthropicBlocks(blocks);
      if (drafted && !partialContent) {
        partialContent = drafted;
      }

      // If the model requests the same tool call a third time, it is stuck in
      // a loop — stop researching and force a tools-free final round. One
      // repeat is not a loop: models legitimately re-search a topic or
      // re-fetch a page that failed or came back truncated.
      const keys = toolUses.map(
        (call) => `${call.name}(${JSON.stringify(call.input ?? {})})`,
      );
      let stuck = false;
      for (const key of keys) {
        const count = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, count);
        if (count >= 3) {
          stuck = true;
          break;
        }
      }
      if (stuck) {
        return finishWithoutTools(
          "The model got stuck repeating the same web request. Please try again.",
          "exhausted",
        );
      }

      // Echo the assistant's full content blocks, then feed back the
      // results (bounded concurrency, 5.5b — same stop discipline as the
      // OpenAI loop: unstarted workers never run, active workers are
      // cancelled natively, an interrupted batch returns stopped).
      toolContext.push({ role: "assistant", content: blocks });
      const evidenceBefore = evidenceLog.length;
      const toolResults: (string | null)[] = toolUses.map(() => null);
      await runBounded(toolUses, MAX_PARALLEL_TOOLS, async (call, index) => {
        if (options.signal?.aborted) return;
        toolResults[index] = await executePermittedAnthropicTool(call);
      });
      const results: AnthropicContentBlock[] = [];
      for (let i = 0; i < toolUses.length; i++) {
        if (toolResults[i] == null) continue;
        results.push({
          type: "tool_result",
          tool_use_id: toolUses[i].id,
          content: toolResults[i] as string,
        });
      }
      toolContext.push({ role: "user", content: results });
      if (options.signal?.aborted) {
        // Same as the OpenAI adapter: an interrupted batch is recorded and
        // reported (a cancelled ACTIVE worker is an interruption, not a
        // finished research step).
        const finished = evidenceLog
          .slice(evidenceBefore)
          .filter((p) => p.status !== "interrupted").length;
        for (let i = 0; i < toolUses.length; i++) {
          if (toolResults[i] != null) continue;
          const call = toolUses[i];
          const args = call.input ?? {};
          evidenceLog.push({
            tool: call.name ?? "",
            target:
              call.name === "web_search"
                ? String(args.query ?? "")
                : String(args.url ?? ""),
            status: "interrupted",
            body: "Interrupted before execution.",
          });
        }
        const note =
          streamedContent.trim() === "" && finished < toolUses.length
            ? interruptedResearchNote(finished, toolUses.length)
            : "";
        return { content: `${note}${streamedContent}`, stopped: true, outcome: "stopped" };
      }
      continue;
    }

    const text = textFromAnthropicBlocks(blocks);
    if (text == null) {
      if (flags.truncated && streamedContent !== "") {
        return partialResponse(streamedContent, flags);
      }
      return {
        content: "",
        error: "API response did not contain a message.",
        outcome: "failed",
      };
    }
    return roundResponse(text, flags);
  }

  // Ran out of tool rounds: force a tools-free final answer instead of
  // failing, so the model writes with what it already researched.
  return finishWithoutTools(
    "The model kept requesting web tools without producing a final answer. Please try again.",
    "exhausted",
  );
}

/** Join all text blocks of an Anthropic response; null if there is no text. */
function textFromAnthropicBlocks(
  blocks?: AnthropicContentBlock[],
): string | null {
  if (!blocks) return null;
  const text = blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("");
  return text || null;
}

/** Parse a tool call's JSON arguments (tolerating malformed JSON). */
function parseToolArguments(call: ToolCall): Record<string, unknown> {
  try {
    return JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Run one tool's body (THROWS on failure so callers can record the
 * retrieval status). Validates that the call targets the public web: the
 * Rust backend enforces the private-address block list and validates every
 * redirect hop. The signal cancels DNS/headers/body natively through the
 * shared request registry (B17a).
 */
async function runToolBody(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (name === "web_search") {
    const query = String(args.query ?? "").trim();
    if (!query) {
      throw new Error("web_search requires a 'query' string argument.");
    }
    const results = await invokeAbortable<WebResult[]>(
      "zen_web_search",
      { query },
      signal,
    );
    if (!results || results.length === 0) {
      return "The web search returned no results.";
    }
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  }

  if (name === "fetch_page") {
    const url = String(args.url ?? "").trim();
    if (!url) {
      throw new Error("fetch_page requires a 'url' string argument.");
    }
    return await invokeAbortable<string>("zen_fetch_page", { url }, signal);
  }

  throw new Error(`unknown tool "${name}"`);
}
