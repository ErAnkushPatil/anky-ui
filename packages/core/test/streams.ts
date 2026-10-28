const encoder = new TextEncoder();

/** A byte stream fed manually, for deterministic interleaving in tests. */
export function controllableStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    push(chunk: string | Uint8Array) {
      controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
    close() {
      controller.close();
    },
    error(err: unknown) {
      controller.error(err);
    },
    get cancelled() {
      return cancelled;
    },
  };
}

/** A byte stream that emits the given chunks, then closes. */
export function streamOf(...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      c.close();
    },
  });
}

export async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** Let pending promise reactions and stream pulls settle. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
