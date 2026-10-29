import { streamTextReader, type StreamTextReaderOptions, type StreamTextSource } from "./parser";

/**
 * Wire formats understood by {@link providerTextReader}.
 *
 * - `openai`: Chat Completions (`choices[].delta.content`) and Responses API (`response.output_text.delta`) SSE.
 * - `anthropic`: Messages API SSE (`content_block_delta` with `text_delta`).
 * - `ai-sdk`: Vercel AI SDK streams: v5+ UI message SSE (`text-delta`), the v4 data stream
 *   (`0:"token"` lines) and plain text streams (`toTextStreamResponse()`).
 */
export type StreamProvider = "openai" | "anthropic" | "ai-sdk";

/** Raised when the provider reports an error inside an otherwise successful HTTP stream. */
export class ProviderStreamError extends Error {
  constructor(
    message: string,
    readonly provider: StreamProvider,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = "ProviderStreamError";
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (isObject(error) && typeof error.message === "string") return error.message;
  return fallback;
}

/** Extract the text token carried by one OpenAI SSE payload. `null` = nothing to emit. */
export function openAIEventText(payload: string): string | null {
  const event = parseJson(payload);
  if (!isObject(event)) return null;
  if (event.error) throw new ProviderStreamError(errorMessage(event.error, "OpenAI stream error"), "openai", event);
  if (event.type === "error") throw new ProviderStreamError(errorMessage(event, "OpenAI stream error"), "openai", event);
  if (event.type === "response.output_text.delta") return str(event.delta) || null;
  if (event.type === "response.failed") throw new ProviderStreamError("OpenAI response failed", "openai", event);
  const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
  if (isObject(choice) && isObject(choice.delta)) return str(choice.delta.content) || null;
  return null;
}

/** Extract the text token carried by one Anthropic SSE payload. `null` = nothing to emit. */
export function anthropicEventText(payload: string): string | null {
  const event = parseJson(payload);
  if (!isObject(event)) return null;
  if (event.type === "error") {
    throw new ProviderStreamError(errorMessage(event.error, "Anthropic stream error"), "anthropic", event);
  }
  if (event.type === "content_block_delta" && isObject(event.delta) && event.delta.type === "text_delta") {
    return str(event.delta.text) || null;
  }
  return null;
}

/** Extract text from one AI SDK payload (v5+ SSE JSON or a v4 data-stream line). */
export function aiSdkEventText(payload: string): string | null {
  const event = parseJson(payload);
  if (isObject(event)) {
    if (event.type === "error") {
      throw new ProviderStreamError(errorMessage(event.errorText ?? event.error, "AI SDK stream error"), "ai-sdk", event);
    }
    if (event.type === "text-delta") return str(event.delta ?? event.textDelta ?? event.text) || null;
    return null;
  }
  // v4 data stream protocol: `<type>:<json>`; type 0 = text, 3 = error.
  const match = /^([0-9a-z]):(.*)$/s.exec(payload);
  if (!match) return null;
  const value = parseJson(match[2]!);
  if (match[1] === "0") return typeof value === "string" && value ? value : null;
  if (match[1] === "3") throw new ProviderStreamError(errorMessage(value, "AI SDK stream error"), "ai-sdk", value);
  return null;
}

const EXTRACTORS: Record<StreamProvider, (payload: string) => string | null> = {
  openai: openAIEventText,
  anthropic: anthropicEventText,
  "ai-sdk": aiSdkEventText,
};

/**
 * Read a provider's streaming response as plain text tokens.
 *
 * Built on {@link streamTextReader}, so it accepts a `Response` or `ReadableStream`, honours an
 * `AbortSignal`, and cancels the network request on early exit. Provider-reported errors throw
 * {@link ProviderStreamError}.
 *
 * For `ai-sdk`, a `Response` served by `toTextStreamResponse()` (plain text) passes through verbatim; SSE
 * and v4 data-stream records are decoded. A bare `ReadableStream` is assumed to be an SSE/data stream.
 *
 * @example
 * for await (const token of providerTextReader(await fetch("/api/chat"), "openai", { signal })) {
 *   text += token;
 * }
 */
export async function* providerTextReader(
  source: StreamTextSource,
  provider: StreamProvider,
  options: Omit<StreamTextReaderOptions, "framing"> = {},
): AsyncGenerator<string, void, undefined> {
  const extract = EXTRACTORS[provider];

  if (provider === "ai-sdk" && typeof Response !== "undefined" && source instanceof Response) {
    // `toTextStreamResponse()` is plain text; the v4 data stream is also text/plain but carries this header.
    const type = source.headers.get("content-type") ?? "";
    if (type.includes("text/plain") && !source.headers.has("x-vercel-ai-data-stream")) {
      yield* streamTextReader(source, { ...options, framing: "raw" });
      return;
    }
  }

  let carry = "";
  // For ai-sdk, the first piece tells SSE (one JSON event per piece) from the v4 data stream (raw chunks).
  // Decide once: a raw chunk can split mid-record, so a later piece may start with "{" by accident.
  let lineMode: boolean | undefined;
  for await (const piece of streamTextReader(source, { ...options, framing: provider === "ai-sdk" ? "auto" : "sse" })) {
    if (provider === "ai-sdk") lineMode ??= !piece.trimStart().startsWith("{");
    if (lineMode) {
      // v4 data-stream records arrive as raw, newline-delimited chunks.
      carry += piece;
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const token = line ? extract(line) : null;
        if (token) yield token;
      }
      continue;
    }
    const token = extract(piece);
    if (token) yield token;
  }
  if (carry) {
    const token = extract(carry);
    if (token) yield token;
  }
}

/**
 * Convert a provider response into a plain-text `ReadableStream<Uint8Array>`, ready for
 * `useOptimisticAIState().mutateWithStream(...)` (use `framing: "raw"` there).
 *
 * @example
 * mutate(providerTextStream(await fetch("/api/rewrite"), "anthropic"), (cur, chunk) => cur + chunk, { framing: "raw" });
 */
export function providerTextStream(
  source: StreamTextSource,
  provider: StreamProvider,
  options: Omit<StreamTextReaderOptions, "framing"> = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = providerTextReader(source, provider, options);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(undefined);
      void reason;
    },
  });
}
