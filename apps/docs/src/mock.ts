/** Offline stand-ins for provider streaming endpoints, emitting each vendor's real wire format. */

export type WireFormat = "openai" | "anthropic" | "ai-sdk-v5" | "ai-sdk-v4" | "ai-sdk-text";

export const WIRE_FORMATS: Array<{ id: WireFormat; label: string; provider: "openai" | "anthropic" | "ai-sdk" }> = [
  { id: "openai", label: "OpenAI Chat Completions", provider: "openai" },
  { id: "anthropic", label: "Anthropic Messages", provider: "anthropic" },
  { id: "ai-sdk-v5", label: "Vercel AI SDK (UI message stream)", provider: "ai-sdk" },
  { id: "ai-sdk-v4", label: "Vercel AI SDK (v4 data stream)", provider: "ai-sdk" },
  { id: "ai-sdk-text", label: "Vercel AI SDK (text stream)", provider: "ai-sdk" },
];

const sse = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

export function tokenize(text: string): string[] {
  return text.match(/\s*\S+\s*|\s+/g) ?? [];
}

/** Raw wire chunks for `tokens` in `format`. */
export function wireChunks(format: WireFormat, tokens: string[]): string[] {
  switch (format) {
    case "openai":
      return [
        sse({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] }),
        ...tokens.map((content) => sse({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content } }] })),
        sse({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ];
    case "anthropic":
      return [
        sse({ type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } }, "message_start"),
        sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start"),
        ...tokens.map((text) => sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, "content_block_delta")),
        sse({ type: "content_block_stop", index: 0 }, "content_block_stop"),
        sse({ type: "message_stop" }, "message_stop"),
      ];
    case "ai-sdk-v5":
      return [
        sse({ type: "start" }),
        sse({ type: "text-start", id: "t1" }),
        ...tokens.map((delta) => sse({ type: "text-delta", id: "t1", delta })),
        sse({ type: "text-end", id: "t1" }),
        sse({ type: "finish" }),
        "data: [DONE]\n\n",
      ];
    case "ai-sdk-v4":
      return [...tokens.map((t) => `0:${JSON.stringify(t)}\n`), 'e:{"finishReason":"stop"}\n', "d:{}\n"];
    case "ai-sdk-text":
      return tokens;
  }
}

const HEADERS: Record<WireFormat, Record<string, string>> = {
  openai: { "content-type": "text/event-stream" },
  anthropic: { "content-type": "text/event-stream" },
  "ai-sdk-v5": { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
  "ai-sdk-v4": { "content-type": "text/plain; charset=utf-8", "x-vercel-ai-data-stream": "v1" },
  "ai-sdk-text": { "content-type": "text/plain; charset=utf-8" },
};

/** A `Response` streaming `text` token by token in the given vendor format. Honours `signal`. */
export function mockProviderResponse(
  format: WireFormat,
  text: string,
  { tokensPerSecond = 30, signal }: { tokensPerSecond?: number; signal?: AbortSignal } = {},
): Response {
  const chunks = wireChunks(format, tokenize(text));
  const encoder = new TextEncoder();
  const delay = 1000 / tokensPerSecond;
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          try {
            controller.error(signal.reason);
          } catch {
            // already closed
          }
        },
        { once: true },
      );
    },
    pull(controller) {
      return new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (signal?.aborted) return resolve();
          if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
          else controller.close();
          resolve();
        }, delay);
      });
    },
    cancel() {
      clearTimeout(timer);
    },
  });

  return new Response(body, { headers: HEADERS[format] });
}

export const SAMPLE_ORIGINAL = "the quick brown fox jump over the lazy dog";
export const SAMPLE_REWRITE = "The quick brown fox jumps over the lazy, sleeping dog.";
