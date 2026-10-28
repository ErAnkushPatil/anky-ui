import { describe, expect, it } from "vitest";
import { streamTextReader } from "./parser";
import { collect, controllableStream, flush, streamOf } from "../../test/streams";

describe("streamTextReader", () => {
  describe("raw text", () => {
    it("yields decoded chunks verbatim", async () => {
      const tokens = await collect(streamTextReader(streamOf("Hello, ", "world! This is raw text.")));
      expect(tokens.join("")).toBe("Hello, world! This is raw text.");
    });

    it("does not delay raw tokens until a blank line", async () => {
      const src = controllableStream();
      const it = streamTextReader(src.stream)[Symbol.asyncIterator]();
      src.push("The quick brown fox jumps");
      await expect(it.next()).resolves.toEqual({ value: "The quick brown fox jumps", done: false });
      src.push(" over");
      await expect(it.next()).resolves.toEqual({ value: " over", done: false });
      src.close();
      await expect(it.next()).resolves.toEqual({ value: undefined, done: true });
    });

    it("emits short payloads that end before the sniff window fills", async () => {
      expect(await collect(streamTextReader(streamOf("Hi")))).toEqual(["Hi"]);
    });

    it("keeps raw text containing 'data:' mid-line", async () => {
      const tokens = await collect(streamTextReader(streamOf("The data: field is nested here\n")));
      expect(tokens.join("")).toBe("The data: field is nested here\n");
    });

    it("decodes multi-byte UTF-8 sequences split across chunks", async () => {
      const bytes = new TextEncoder().encode("héllo 👋 wörld, some more text");
      const tokens = await collect(streamTextReader(streamOf(bytes.slice(0, 2), bytes.slice(2, 8), bytes.slice(8))));
      expect(tokens.join("")).toBe("héllo 👋 wörld, some more text");
    });

    it("honours framing: 'raw' even for SSE-looking input", async () => {
      const tokens = await collect(streamTextReader(streamOf("data: x\n\n"), { framing: "raw" }));
      expect(tokens.join("")).toBe("data: x\n\n");
    });
  });

  describe("SSE", () => {
    it("strips data: prefixes and yields one token per event", async () => {
      const tokens = await collect(streamTextReader(streamOf("data: Hello\n\ndata:  world\n\ndata:!\n\n")));
      expect(tokens).toEqual(["Hello", " world", "!"]);
    });

    it("reassembles events split across arbitrary chunk boundaries", async () => {
      const tokens = await collect(streamTextReader(streamOf("da", "ta: Hel", "lo\n", "\ndata: wor", "ld\n\n")));
      expect(tokens).toEqual(["Hello", "world"]);
    });

    it("handles CRLF, CR and a CRLF split across chunks", async () => {
      const tokens = await collect(streamTextReader(streamOf("data: a\r", "\n\r\ndata: b\r\rdata: c\n\n")));
      expect(tokens).toEqual(["a", "b", "c"]);
    });

    it("joins multi-line data fields with newlines", async () => {
      expect(await collect(streamTextReader(streamOf("data: line 1\ndata: line 2\n\n")))).toEqual(["line 1\nline 2"]);
    });

    it("ignores comments, event/id/retry fields and empty payloads", async () => {
      const payload = ": keep-alive\n\nevent: delta\nid: 7\nretry: 100\ndata: x\n\ndata:\n\n";
      expect(await collect(streamTextReader(streamOf(payload)))).toEqual(["x"]);
    });

    it("stops at the [DONE] sentinel and cancels the source", async () => {
      const src = controllableStream();
      src.push("data: a\n\ndata: [DONE]\n\ndata: ignored\n\n");
      expect(await collect(streamTextReader(src.stream))).toEqual(["a"]);
      expect(src.cancelled).toBe(true);
    });

    it("allows disabling the done sentinel", async () => {
      const tokens = await collect(streamTextReader(streamOf("data: [DONE]\n\n"), { doneSentinel: null }));
      expect(tokens).toEqual(["[DONE]"]);
    });

    it("flushes a trailing event without a terminating blank line", async () => {
      expect(await collect(streamTextReader(streamOf("data: a\n\ndata: tail")))).toEqual(["a", "tail"]);
    });

    it("strips a leading BOM", async () => {
      expect(await collect(streamTextReader(streamOf("\uFEFFdata: a\n\n")))).toEqual(["a"]);
    });
  });

  describe("sources", () => {
    it("accepts a fetch Response", async () => {
      const response = new Response(streamOf("data: from response\n\n"));
      expect(await collect(streamTextReader(response))).toEqual(["from response"]);
    });

    it("rejects a consumed or bodiless Response", async () => {
      const used = new Response("x");
      await used.text();
      await expect(collect(streamTextReader(used))).rejects.toThrow(/already been consumed/);
      await expect(collect(streamTextReader(new Response(null)))).rejects.toThrow(/no body/);
    });
  });

  describe("cancellation", () => {
    it("throws immediately for an already-aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(collect(streamTextReader(streamOf("x"), { signal: controller.signal }))).rejects.toMatchObject({
        name: "AbortError",
      });
    });

    it("aborts a pending read and cancels the source", async () => {
      const src = controllableStream();
      const controller = new AbortController();
      const tokens: string[] = [];
      const done = (async () => {
        for await (const t of streamTextReader(src.stream, { signal: controller.signal, framing: "raw" })) tokens.push(t);
      })();
      src.push("partial");
      await flush();
      controller.abort();
      await expect(done).rejects.toMatchObject({ name: "AbortError" });
      expect(tokens).toEqual(["partial"]);
      expect(src.cancelled).toBe(true);
    });

    it("cancels the source when the consumer breaks early", async () => {
      const src = controllableStream();
      src.push("data: a\n\ndata: b\n\n");
      for await (const token of streamTextReader(src.stream)) {
        expect(token).toBe("a");
        break;
      }
      expect(src.cancelled).toBe(true);
    });

    it("propagates source errors", async () => {
      const src = controllableStream();
      src.error(new Error("network down"));
      await expect(collect(streamTextReader(src.stream))).rejects.toThrow("network down");
    });
  });
});
