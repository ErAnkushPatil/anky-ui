import { describe, expect, it } from "vitest";
import {
  ProviderStreamError,
  anthropicEventText,
  openAIEventText,
  providerTextReader,
  providerTextStream,
} from "./providers";
import { streamTextReader } from "./parser";

const enc = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

async function collect(iter: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const token of iter) out += token;
  return out;
}

const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

describe("OpenAI", () => {
  it("reads chat completion deltas and stops at [DONE]", async () => {
    const body = streamOf([
      sse({ choices: [{ delta: { role: "assistant" } }] }),
      sse({ choices: [{ delta: { content: "Hel" } }] }),
      sse({ choices: [{ delta: { content: "lo" } }] }),
      sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    expect(await collect(providerTextReader(body, "openai"))).toBe("Hello");
  });

  it("reads Responses API output_text deltas", () => {
    expect(openAIEventText(JSON.stringify({ type: "response.output_text.delta", delta: "hi" }))).toBe("hi");
    expect(openAIEventText(JSON.stringify({ type: "response.completed" }))).toBeNull();
  });

  it("handles events split across chunks", async () => {
    const full = sse({ choices: [{ delta: { content: "split" } }] });
    const body = streamOf([full.slice(0, 15), full.slice(15)]);
    expect(await collect(providerTextReader(body, "openai"))).toBe("split");
  });

  it("throws ProviderStreamError on error payloads", () => {
    expect(() => openAIEventText(JSON.stringify({ error: { message: "rate limited" } }))).toThrow(ProviderStreamError);
  });

  it("ignores malformed payloads", () => {
    expect(openAIEventText("not json")).toBeNull();
  });
});

describe("Anthropic", () => {
  it("reads text_delta events and ignores the rest", async () => {
    const body = streamOf([
      sse({ type: "message_start", message: {} }, "message_start"),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bon" } }, "content_block_delta"),
      sse({ type: "ping" }, "ping"),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "jour" } }, "content_block_delta"),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{" } }),
      sse({ type: "message_stop" }, "message_stop"),
    ]);
    expect(await collect(providerTextReader(body, "anthropic"))).toBe("Bonjour");
  });

  it("surfaces mid-stream errors", async () => {
    const body = streamOf([sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })]);
    await expect(collect(providerTextReader(body, "anthropic"))).rejects.toThrow("Overloaded");
    expect(() => anthropicEventText('{"type":"error","error":"x"}')).toThrow(ProviderStreamError);
  });
});

describe("Vercel AI SDK", () => {
  it("passes plain text streams through (toTextStreamResponse)", async () => {
    const res = new Response(streamOf(["data: not a event, ", "just text"]), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    expect(await collect(providerTextReader(res, "ai-sdk"))).toBe("data: not a event, just text");
  });

  it("reads v5 UI message SSE streams", async () => {
    const res = new Response(
      streamOf([
        sse({ type: "start" }),
        sse({ type: "text-start", id: "1" }),
        sse({ type: "text-delta", id: "1", delta: "Hi " }),
        sse({ type: "text-delta", id: "1", delta: "there" }),
        sse({ type: "finish" }),
        "data: [DONE]\n\n",
      ]),
      { headers: { "content-type": "text/event-stream" } },
    );
    expect(await collect(providerTextReader(res, "ai-sdk"))).toBe("Hi there");
  });

  it("reads the v4 data stream protocol, including records split across chunks", async () => {
    const res = new Response(streamOf(['0:"Hel', 'lo"\n0:" wor', 'ld"\ne:{"finishReason":"stop"}\nd:{}\n']), {
      headers: { "content-type": "text/plain", "x-vercel-ai-data-stream": "v1" },
    });
    expect(await collect(providerTextReader(res, "ai-sdk"))).toBe("Hello world");
  });

  it("throws on v4 error records", async () => {
    const res = new Response(streamOf(['3:"boom"\n']), {
      headers: { "content-type": "text/plain", "x-vercel-ai-data-stream": "v1" },
    });
    await expect(collect(providerTextReader(res, "ai-sdk"))).rejects.toThrow("boom");
  });
});

describe("providerTextStream", () => {
  it("re-exposes tokens as a raw byte stream that streamTextReader can consume", async () => {
    const body = streamOf([
      sse({ choices: [{ delta: { content: "data: tricky" } }] }),
      sse({ choices: [{ delta: { content: " text" } }] }),
    ]);
    const out = await collect(streamTextReader(providerTextStream(body, "openai"), { framing: "raw" }));
    expect(out).toBe("data: tricky text");
  });

  it("cancels the source and rejects on abort", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode(sse({ choices: [{ delta: { content: "x" } }] })));
        return new Promise((r) => setTimeout(r, 5));
      },
      cancel() {
        cancelled = true;
      },
    });
    const ac = new AbortController();
    const run = collect(providerTextReader(source, "openai", { signal: ac.signal }));
    setTimeout(() => ac.abort(), 20);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });
});
