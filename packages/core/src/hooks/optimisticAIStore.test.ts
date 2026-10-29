import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_LIMIT, OptimisticAIStore, StreamResponseError } from "./useOptimisticAIState";
import { controllableStream, flush, streamOf } from "../../test/streams";

const append = (state: string, chunk: string) => state + chunk;
const sse = (...tokens: string[]) => tokens.map((t) => `data: ${t}\n\n`).join("");

function createStore(initial = "", onStateChange?: (s: string) => void) {
  return new OptimisticAIStore<string>(initial, { onStateChange });
}

describe("OptimisticAIStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with matching current/confirmed state and empty history", () => {
    const store = createStore("init");
    expect(store.getSnapshot()).toEqual({
      currentState: "init",
      confirmedState: "init",
      history: { past: [], future: [] },
      isStreaming: false,
      error: null,
      canUndo: false,
      canRedo: false,
    });
  });

  describe("mutateWithStream", () => {
    it("applies tokens optimistically and records one history entry on completion", async () => {
      const src = controllableStream();
      const store = createStore("Hi");
      const pending = store.mutateWithStream(src.stream, append);

      expect(store.getSnapshot().isStreaming).toBe(true);
      expect(store.getSnapshot().canUndo).toBe(true);

      src.push("data:  there\n\n");
      await flush();
      expect(store.getSnapshot().currentState).toBe("Hi there");
      expect(store.getSnapshot().history.past).toEqual([]);

      src.push(sse("!"));
      src.close();
      await expect(pending).resolves.toEqual({ status: "completed", state: "Hi there!" });

      const snap = store.getSnapshot();
      expect(snap).toMatchObject({ currentState: "Hi there!", confirmedState: "Hi", isStreaming: false, error: null });
      expect(snap.history).toEqual({ past: ["Hi"], future: [] });
    });

    it.each([
      ["a ReadableStream", () => streamOf(sse("a", "b"))],
      ["a Response", () => new Response(streamOf(sse("a", "b")))],
      ["a Promise<Response>", () => Promise.resolve(new Response(streamOf(sse("a", "b"))))],
      ["a factory", () => () => Promise.resolve(new Response(streamOf(sse("a", "b"))))],
      ["raw (non-SSE) text", () => streamOf("a", "b")],
    ])("accepts %s", async (_name, make) => {
      const store = createStore();
      await expect(store.mutateWithStream(make(), append)).resolves.toEqual({ status: "completed", state: "ab" });
    });

    it("notifies subscribers and onStateChange for every token", async () => {
      const onStateChange = vi.fn();
      const store = createStore("", onStateChange);
      const listener = vi.fn();
      store.subscribe(listener);
      await store.mutateWithStream(streamOf(sse("a", "b", "c")), append);
      expect(onStateChange.mock.calls.map(([s]) => s)).toEqual(["a", "ab", "abc"]);
      // start + 3 tokens + completion
      expect(listener).toHaveBeenCalledTimes(5);
    });

    it("does not add a history entry when the stream produces no change", async () => {
      const store = createStore("same");
      await expect(store.mutateWithStream(streamOf(""), append)).resolves.toEqual({ status: "completed", state: "same" });
      expect(store.getSnapshot().history.past).toEqual([]);
    });

    it("rolls back and exposes the error when the stream fails", async () => {
      const src = controllableStream();
      const store = createStore("base");
      const pending = store.mutateWithStream(src.stream, append);
      src.push(sse(" partial"));
      await flush();
      expect(store.getSnapshot().currentState).toBe("base partial");

      src.error(new Error("connection reset"));
      const outcome = await pending;
      expect(outcome).toMatchObject({ status: "error", error: { message: "connection reset" } });
      expect(store.getSnapshot()).toMatchObject({ currentState: "base", isStreaming: false });
      expect(store.getSnapshot().error?.message).toBe("connection reset");
      expect(store.getSnapshot().history.past).toEqual([]);
    });

    it("rolls back when transformFn throws and stops reading", async () => {
      const src = controllableStream();
      const store = createStore("base");
      const pending = store.mutateWithStream(src.stream, (s, c) => {
        if (c === "bad") throw new Error("cannot apply");
        return s + c;
      });
      src.push(sse("ok", "bad"));
      await expect(pending).resolves.toMatchObject({ status: "error", error: { message: "cannot apply" } });
      expect(store.getSnapshot().currentState).toBe("base");
      expect(src.cancelled).toBe(true);
    });

    it("raises StreamResponseError for non-2xx responses", async () => {
      const store = createStore("base");
      const outcome = await store.mutateWithStream(
        Promise.resolve(new Response("nope", { status: 503, statusText: "Service Unavailable" })),
        append,
      );
      expect(outcome.status).toBe("error");
      const { error } = store.getSnapshot();
      expect(error).toBeInstanceOf(StreamResponseError);
      expect((error as StreamResponseError).status).toBe(503);
    });

    it("rolls back when the response promise rejects", async () => {
      const store = createStore("base");
      const outcome = await store.mutateWithStream(Promise.reject(new TypeError("Failed to fetch")), append);
      expect(outcome).toMatchObject({ status: "error", error: { message: "Failed to fetch" } });
      expect(store.getSnapshot()).toMatchObject({ currentState: "base", isStreaming: false });
    });
  });

  describe("cancellation", () => {
    it("abort() rolls back instantly, cancels the source and exposes an AbortError", async () => {
      const src = controllableStream();
      const store = createStore("base");
      const pending = store.mutateWithStream(src.stream, append);
      src.push(sse(" partial"));
      await flush();

      expect(store.abort()).toBe(true);
      expect(store.getSnapshot()).toMatchObject({ currentState: "base", isStreaming: false });
      expect(store.getSnapshot().error).toMatchObject({ name: "AbortError" });
      await expect(pending).resolves.toEqual({ status: "aborted", cause: "user" });
      expect(src.cancelled).toBe(true);
      expect(store.abort()).toBe(false);
    });

    it("honours an external AbortSignal, including one aborted up front", async () => {
      const src = controllableStream();
      const controller = new AbortController();
      const store = createStore("base");
      const pending = store.mutateWithStream(src.stream, append, { signal: controller.signal });
      src.push(sse("x"));
      await flush();
      controller.abort();
      await expect(pending).resolves.toEqual({ status: "aborted", cause: "user" });
      expect(store.getSnapshot().currentState).toBe("base");

      const outcome = await store.mutateWithStream(streamOf(sse("y")), append, { signal: AbortSignal.abort() });
      expect(outcome).toEqual({ status: "aborted", cause: "user" });
      expect(store.getSnapshot()).toMatchObject({ currentState: "base", isStreaming: false });
    });

    it("passes an AbortSignal to factory sources and aborts it on cancel", async () => {
      let received: AbortSignal | undefined;
      const store = createStore();
      const pending = store.mutateWithStream((signal) => {
        received = signal;
        return new Promise<Response>(() => undefined);
      }, append);
      expect(received?.aborted).toBe(false);
      store.abort();
      expect(received?.aborted).toBe(true);
      await expect(pending).resolves.toEqual({ status: "aborted", cause: "user" });
    });

    it("cancels a response body that arrives after the stream was aborted", async () => {
      const src = controllableStream();
      let resolve!: (r: Response) => void;
      const store = createStore();
      const pending = store.mutateWithStream(new Promise<Response>((r) => (resolve = r)), append);
      store.abort();
      await pending;
      resolve(new Response(src.stream));
      await flush();
      expect(src.cancelled).toBe(true);
    });

    it("dispose() cancels and rolls back without setting an error", async () => {
      const src = controllableStream();
      const store = createStore("base");
      const pending = store.mutateWithStream(src.stream, append);
      src.push(sse("x"));
      await flush();
      store.dispose();
      await expect(pending).resolves.toEqual({ status: "aborted", cause: "disposed" });
      expect(store.getSnapshot()).toMatchObject({ currentState: "base", isStreaming: false, error: null });
    });
  });

  describe("simultaneous streams", () => {
    it("last call wins: the older stream is cancelled, rolled back and can never write again", async () => {
      const first = controllableStream();
      const second = controllableStream();
      const store = createStore("base");

      const p1 = store.mutateWithStream(first.stream, append);
      first.push(sse(" one"));
      await flush();
      expect(store.getSnapshot().currentState).toBe("base one");

      const p2 = store.mutateWithStream(second.stream, append);
      // Rolled back to the shared pre-mutation snapshot before the new stream starts.
      expect(store.getSnapshot()).toMatchObject({ currentState: "base", isStreaming: true });
      await expect(p1).resolves.toEqual({ status: "aborted", cause: "superseded" });
      expect(first.cancelled).toBe(true);

      second.push(sse(" two"));
      second.close();
      await expect(p2).resolves.toEqual({ status: "completed", state: "base two" });

      const snap = store.getSnapshot();
      expect(snap.currentState).toBe("base two");
      expect(snap.error).toBeNull();
      expect(snap.history.past).toEqual(["base"]);
    });

    it("handles a burst of triggers while responses are still pending", async () => {
      const resolvers: Array<(r: Response) => void> = [];
      const sources = [controllableStream(), controllableStream(), controllableStream()];
      const store = createStore("");
      const outcomes = sources.map(() =>
        store.mutateWithStream(new Promise<Response>((r) => resolvers.push(r)), append),
      );

      // Resolve out of order: the superseded responses arrive late and must be discarded.
      sources[2].push(sse("third"));
      sources[2].close();
      resolvers[2](new Response(sources[2].stream));
      resolvers[0](new Response(sources[0].stream));
      resolvers[1](new Response(sources[1].stream));

      const results = await Promise.all(outcomes);
      expect(results.map((r) => r.status)).toEqual(["aborted", "aborted", "completed"]);
      await flush();
      expect(sources[0].cancelled && sources[1].cancelled).toBe(true);
      expect(store.getSnapshot()).toMatchObject({ currentState: "third", isStreaming: false });
      expect(store.getSnapshot().history.past).toEqual([""]);
    });
  });

  describe("history", () => {
    async function streamText(store: OptimisticAIStore<string>, text: string) {
      await store.mutateWithStream(streamOf(sse(text)), (_s, c) => c);
    }

    it("undo/redo walk the history", async () => {
      const store = createStore("v0");
      await streamText(store, "v1");
      await streamText(store, "v2");

      expect(store.undo()).toBe(true);
      expect(store.getSnapshot()).toMatchObject({ currentState: "v1", canUndo: true, canRedo: true });
      expect(store.undo()).toBe(true);
      expect(store.getSnapshot().currentState).toBe("v0");
      expect(store.undo()).toBe(false);

      expect(store.redo()).toBe(true);
      expect(store.redo()).toBe(true);
      expect(store.getSnapshot()).toMatchObject({ currentState: "v2", canRedo: false });
      expect(store.redo()).toBe(false);
    });

    it("an intervening mutation clears the redo branch", async () => {
      const store = createStore("v0");
      await streamText(store, "v1");
      store.undo();
      expect(store.getSnapshot().canRedo).toBe(true);
      await streamText(store, "v1b");
      expect(store.redo()).toBe(false);
      expect(store.getSnapshot().history).toEqual({ past: ["v0"], future: [] });
    });

    it("a failed mutation keeps the redo branch", async () => {
      const store = createStore("v0");
      await streamText(store, "v1");
      store.undo();
      await store.mutateWithStream(Promise.reject(new Error("boom")), append);
      expect(store.redo()).toBe(true);
      expect(store.getSnapshot().currentState).toBe("v1");
    });

    it(`caps both stacks at ${HISTORY_LIMIT} entries`, async () => {
      const store = createStore("0");
      for (let i = 1; i <= HISTORY_LIMIT + 5; i++) store.update(String(i));
      const { past } = store.getSnapshot().history;
      expect(past).toHaveLength(HISTORY_LIMIT);
      expect(past[0]).toBe("5");
      expect(past[past.length - 1]).toBe(String(HISTORY_LIMIT + 4));

      while (store.undo());
      expect(store.getSnapshot().currentState).toBe("5");
      expect(store.getSnapshot().history.future).toHaveLength(HISTORY_LIMIT);
    });

    it("undo during a stream cancels it and restores the snapshot only", async () => {
      const src = controllableStream();
      const store = createStore("v0");
      await streamText(store, "v1");
      const pending = store.mutateWithStream(src.stream, append);
      src.push(sse("+partial"));
      await flush();

      expect(store.undo()).toBe(true);
      expect(store.getSnapshot()).toMatchObject({ currentState: "v1", isStreaming: false, error: null });
      expect(store.getSnapshot().history.past).toEqual(["v0"]);
      await expect(pending).resolves.toEqual({ status: "aborted", cause: "interrupted" });
    });

    it("redo is a no-op while streaming", async () => {
      const src = controllableStream();
      const store = createStore("v0");
      await streamText(store, "v1");
      store.undo();
      void store.mutateWithStream(src.stream, append);
      expect(store.getSnapshot().canRedo).toBe(false);
      expect(store.redo()).toBe(false);
      store.abort();
    });
  });

  describe("accept / reject", () => {
    it("accept() commits the baseline and purges history", async () => {
      const store = createStore("v0");
      await store.mutateWithStream(streamOf(sse("v1")), (_s, c) => c);
      store.undo();
      store.redo();
      store.accept();
      expect(store.getSnapshot()).toMatchObject({
        currentState: "v1",
        confirmedState: "v1",
        history: { past: [], future: [] },
        canUndo: false,
        canRedo: false,
      });
    });

    it("accept() mid-stream stops the stream and keeps the partial output", async () => {
      const src = controllableStream();
      const store = createStore("a");
      const pending = store.mutateWithStream(src.stream, append);
      src.push(sse("b"));
      await flush();
      store.accept();
      src.push(sse("c"));
      await expect(pending).resolves.toEqual({ status: "aborted", cause: "interrupted" });
      expect(store.getSnapshot()).toMatchObject({ currentState: "ab", confirmedState: "ab", isStreaming: false });
      expect(src.cancelled).toBe(true);
    });

    it("reject() reverts to the confirmed state and is undoable", async () => {
      const store = createStore("v0");
      await store.mutateWithStream(streamOf(sse("v1")), (_s, c) => c);
      store.reject();
      expect(store.getSnapshot()).toMatchObject({ currentState: "v0", confirmedState: "v0" });
      expect(store.undo()).toBe(true);
      expect(store.getSnapshot().currentState).toBe("v1");
    });

    it("reject() mid-stream cancels and reverts, clearing errors", async () => {
      const src = controllableStream();
      const store = createStore("v0");
      store.update("v1");
      const pending = store.mutateWithStream(src.stream, append);
      src.push(sse("!"));
      await flush();
      store.reject();
      await expect(pending).resolves.toEqual({ status: "aborted", cause: "interrupted" });
      expect(store.getSnapshot()).toMatchObject({ currentState: "v0", isStreaming: false, error: null });
      expect(store.getSnapshot().history.past).toEqual(["v0", "v1"]);
    });

    it("reject() with nothing to revert does not grow history", () => {
      const store = createStore("v0");
      store.reject();
      expect(store.getSnapshot().history.past).toEqual([]);
    });
  });

  it("update() applies an undoable change, cancelling any in-flight stream", async () => {
    const src = controllableStream();
    const store = createStore("v0");
    const pending = store.mutateWithStream(src.stream, append);
    src.push(sse("x"));
    await flush();
    store.update((s) => s + " edited");
    await expect(pending).resolves.toEqual({ status: "aborted", cause: "interrupted" });
    expect(store.getSnapshot()).toMatchObject({ currentState: "v0 edited", isStreaming: false });
    expect(store.getSnapshot().history.past).toEqual(["v0"]);
  });

  it("an onStateChange that throws does not break the stream", async () => {
    const rethrown: unknown[] = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((cb) => {
      try {
        cb();
      } catch (err) {
        rethrown.push(err);
      }
    });
    const store = createStore("", () => {
      throw new Error("consumer bug");
    });
    await expect(store.mutateWithStream(streamOf(sse("a", "b")), append)).resolves.toEqual({
      status: "completed",
      state: "ab",
    });
    expect(rethrown).toHaveLength(2);
  });

  it("streamFromEndpoint POSTs JSON to the endpoint with an abort signal", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(streamOf(sse("ok"))));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const store = new OptimisticAIStore("", { endpoint: "/api/rewrite" });
      await expect(store.streamFromEndpoint({ prompt: "hi" }, append)).resolves.toEqual({
        status: "completed",
        state: "ok",
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/rewrite");
      expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ prompt: "hi" }) });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(() => createStore().streamFromEndpoint({}, append)).toThrow(/endpoint/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("streamFromEndpoint keeps caller headers of every HeadersInit shape", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(streamOf(sse("ok"))));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const store = new OptimisticAIStore("", { endpoint: "/api/rewrite" });
      const shapes: HeadersInit[] = [
        new Headers({ Authorization: "Bearer t" }),
        [["Authorization", "Bearer t"]],
        { Authorization: "Bearer t" },
      ];
      for (const shape of shapes) await store.streamFromEndpoint({}, append, { init: { headers: shape } });
      await store.streamFromEndpoint({}, append, { init: { headers: { "Content-Type": "text/plain" } } });

      const sent = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers));
      for (const headers of sent.slice(0, 3)) {
        expect(headers.get("Authorization")).toBe("Bearer t");
        expect(headers.get("Content-Type")).toBe("application/json");
        expect(headers.get("Accept")).toBe("text/event-stream");
      }
      expect(sent[3]!.get("Content-Type")).toBe("text/plain");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
