/**
 * Framing strategy for {@link streamTextReader}.
 *
 * - `'auto'` (default): sniffs the first bytes. SSE-looking payloads (`data:`,
 *   `event:`, `id:`, `retry:` or `:` comment lines) are parsed as SSE; anything
 *   else is passed through as raw text.
 * - `'sse'`: always parse as Server-Sent-Events.
 * - `'raw'`: always yield decoded text verbatim.
 */
export type StreamFraming = "auto" | "sse" | "raw";

export interface StreamTextReaderOptions {
  /** Cancels the read. The underlying stream is cancelled and the generator throws `signal.reason`. */
  signal?: AbortSignal;
  /** See {@link StreamFraming}. Defaults to `'auto'`. */
  framing?: StreamFraming;
  /** SSE payload that terminates the stream (OpenAI convention). `null` disables it. Defaults to `'[DONE]'`. */
  doneSentinel?: string | null;
}

export type StreamTextSource = ReadableStream<Uint8Array> | Response;

const SSE_PREFIX = /^(?:data|event|id|retry)[ \t]*:|^:/;
/** Characters inspected before deciding on framing in `'auto'` mode (unless a newline arrives first). */
const SNIFF_LENGTH = 16;

/**
 * Consume a byte stream (or a `fetch` `Response`) as decoded text tokens.
 *
 * Decoding uses `TextDecoderStream` when available and a streaming `TextDecoder`
 * otherwise, so multi-byte UTF-8 sequences split across chunks are handled.
 *
 * When SSE framing is active, each dispatched event yields its `data` payload
 * (multi-line `data:` fields joined with `\n`). Comments and `event`/`id`/`retry`
 * fields are ignored, empty payloads are skipped, and `doneSentinel` ends iteration.
 *
 * Abort semantics mirror `fetch`: on abort the source is cancelled and the
 * generator rejects with `signal.reason` (an `AbortError` `DOMException` by default).
 * Exiting a `for await` loop early also cancels the source.
 *
 * @example
 * for await (const token of streamTextReader(await fetch(url), { signal })) {
 *   output += token;
 * }
 */
export async function* streamTextReader(
  source: StreamTextSource,
  options: StreamTextReaderOptions = {},
): AsyncGenerator<string, void, undefined> {
  const { signal, framing = "auto", doneSentinel = "[DONE]" } = options;

  signal?.throwIfAborted();

  const reader = decode(toByteStream(source)).getReader();
  let sourceExhausted = false;
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let mode: Exclude<StreamFraming, "auto"> | null = framing === "auto" ? null : framing;
    let pending = "";
    const sse = new SseParser(doneSentinel);

    while (!sse.done) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        sourceExhausted = true;
        break;
      }
      if (!value) continue;

      let text = value;
      if (mode === null) {
        pending += value;
        const probe = stripBom(pending).trimStart();
        if (probe.length < SNIFF_LENGTH && !/[\r\n]/.test(probe)) continue;
        mode = SSE_PREFIX.test(probe) ? "sse" : "raw";
        text = pending;
        pending = "";
      }

      if (mode === "raw") yield text;
      else yield* sse.push(text);
    }

    if (mode === null && pending) {
      // Payload ended before the sniff window filled up.
      mode = SSE_PREFIX.test(stripBom(pending).trimStart()) ? "sse" : "raw";
      if (mode === "raw") yield pending;
      else yield* sse.push(pending);
    }
    if (mode === "sse") yield* sse.flush();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!sourceExhausted) {
      // Early exit (break, throw, abort, done sentinel): release the network resource.
      await reader.cancel(signal?.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function toByteStream(source: StreamTextSource): ReadableStream<Uint8Array> {
  if (typeof Response !== "undefined" && source instanceof Response) {
    if (source.bodyUsed) throw new TypeError("streamTextReader: Response body has already been consumed");
    if (!source.body) throw new TypeError("streamTextReader: Response has no body");
    return source.body;
  }
  return source as ReadableStream<Uint8Array>;
}

function decode(bytes: ReadableStream<Uint8Array>): ReadableStream<string> {
  if (typeof TextDecoderStream !== "undefined") {
    return bytes.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>);
  }
  const decoder = new TextDecoder("utf-8");
  return bytes.pipeThrough(
    new TransformStream<Uint8Array, string>({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        if (text) controller.enqueue(text);
      },
      flush(controller) {
        const text = decoder.decode();
        if (text) controller.enqueue(text);
      },
    }),
  );
}

/**
 * Incremental SSE parser following the WHATWG event-stream rules
 * (CR, LF and CRLF line endings, including a CRLF split across chunks).
 */
class SseParser {
  done = false;
  private buffer = "";
  private data: string[] = [];
  private started = false;

  constructor(private readonly doneSentinel: string | null) {}

  *push(text: string): Generator<string> {
    if (this.done) return;
    if (!this.started) {
      this.started = true;
      text = stripBom(text);
    }
    const buf = this.buffer + text;

    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf.charCodeAt(i);
      if (ch !== 10 && ch !== 13) continue;
      // A trailing CR may be the first half of a CRLF arriving in the next chunk.
      if (ch === 13 && i === buf.length - 1) break;
      const line = buf.slice(start, i);
      if (ch === 13 && buf.charCodeAt(i + 1) === 10) i++;
      start = i + 1;

      const token = this.processLine(line);
      if (token !== null) yield token;
      if (this.done) {
        this.buffer = "";
        return;
      }
    }
    this.buffer = buf.slice(start);
  }

  /** Dispatch a trailing event that was not terminated by a blank line. */
  *flush(): Generator<string> {
    if (this.done) return;
    if (this.buffer) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      this.processLine(line);
    }
    const token = this.dispatch();
    if (token !== null) yield token;
  }

  private processLine(line: string): string | null {
    if (line === "") return this.dispatch();
    if (line.charCodeAt(0) === 58 /* ':' comment */) return null;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") return null;

    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    this.data.push(value);
    return null;
  }

  private dispatch(): string | null {
    if (this.data.length === 0) return null;
    const payload = this.data.join("\n");
    this.data = [];
    if (this.doneSentinel !== null && payload.trim() === this.doneSentinel) {
      this.done = true;
      return null;
    }
    return payload === "" ? null : payload;
  }
}
