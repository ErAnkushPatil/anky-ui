import { InlineDiff, providerTextStream, useOptimisticAIState } from "@erankushpatil/anky-ui";
import { useState } from "react";
import { SAMPLE_ORIGINAL, SAMPLE_REWRITE, WIRE_FORMATS, mockProviderResponse, wireChunks, tokenize, type WireFormat } from "./mock";
import { CodeBlock, Callout, Demo } from "./ui";

function RecipeDemo() {
  const [format, setFormat] = useState<WireFormat>("openai");
  const [rate, setRate] = useState(25);
  const ai = useOptimisticAIState({ initialState: "" });
  const [raw, setRaw] = useState("");
  const provider = WIRE_FORMATS.find((f) => f.id === format)!.provider;

  const run = () => {
    setRaw(wireChunks(format, tokenize(SAMPLE_REWRITE)).slice(0, 5).join(""));
    let acc = "";
    void ai.mutateWithStream(
      (signal) => providerTextStream(mockProviderResponse(format, SAMPLE_REWRITE, { tokensPerSecond: rate, signal }), provider, { signal }),
      (_current, chunk) => (acc += chunk),
      { framing: "raw" },
    );
  };

  return (
    <Demo title="Decode a vendor stream into InlineDiff" note="Responses are generated in the browser in each vendor's real wire format, so no API key is needed.">
      <div className="row">
        <label>
          Format{" "}
          <select value={format} onChange={(e) => setFormat(e.target.value as WireFormat)}>
            {WIRE_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tokens/s{" "}
          <input type="number" min={1} max={200} value={rate} onChange={(e) => setRate(Number(e.target.value) || 1)} />
        </label>
        <button type="button" className="btn btn-primary" onClick={run}>
          Stream
        </button>
        <button type="button" className="btn" onClick={() => ai.abort()} disabled={!ai.isStreaming}>
          Abort
        </button>
      </div>
      <p>
        <InlineDiff
          originalText={SAMPLE_ORIGINAL}
          modifiedText={ai.currentState}
          isStreaming={ai.isStreaming}
          toolbar="inline"
          onAccept={ai.accept}
          onReject={ai.reject}
        />
      </p>
      {ai.error && <p className="fail">Stream stopped: {ai.error.message}</p>}
      {raw && (
        <>
          <strong>First events on the wire</strong>
          <div className="code">
            <pre className="wire">{raw}</pre>
          </div>
        </>
      )}
    </Demo>
  );
}

export function Recipes() {
  return (
    <>
      <h2>Streaming recipes</h2>
      <p className="lead">
        <code>providerTextReader</code> turns any of these responses into plain text tokens. It builds on{" "}
        <code>streamTextReader</code>, so cancellation and early exit release the network request.
      </p>
      <RecipeDemo />

      <h3>Vercel AI SDK</h3>
      <p>Server (Next.js route):</p>
      <CodeBlock
        code={`import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export async function POST(req: Request) {
  const { prompt, selected } = await req.json();
  const result = streamText({ model: openai("gpt-4o-mini"), prompt: prompt + "\\n\\n" + selected });
  return result.toTextStreamResponse(); // plain text, no decoding needed
  // or: return result.toUIMessageStreamResponse();   -> use provider "ai-sdk"
}`}
      />
      <p>Client:</p>
      <CodeBlock
        code={`const ai = useOptimisticAIState({ initialState: "" });

// plain text stream: pass the Response straight through
ai.mutateWithStream(fetch("/api/rewrite", { method: "POST", body }), (cur, chunk) => cur + chunk, { framing: "raw" });

// UI message / data stream: decode with the ai-sdk provider
ai.mutateWithStream(
  async (signal) => providerTextStream(await fetch("/api/rewrite", { method: "POST", body, signal }), "ai-sdk", { signal }),
  (cur, chunk) => cur + chunk,
  { framing: "raw" },
);`}
      />

      <h3>OpenAI</h3>
      <CodeBlock
        code={`// Server: forward the SSE body untouched
const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gpt-4o-mini", stream: true, messages }),
});
return new Response(upstream.body, { headers: { "Content-Type": "text/event-stream" } });

// Client
for await (const token of providerTextReader(await fetch("/api/rewrite", { method: "POST", body }), "openai", { signal })) {
  text += token;
}`}
      />
      <p>The Responses API (<code>response.output_text.delta</code>) is decoded by the same <code>openai</code> provider.</p>

      <h3>Anthropic</h3>
      <CodeBlock
        code={`// Server: proxy the Messages API stream
const upstream = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
  body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, stream: true, messages }),
});
return new Response(upstream.body, { headers: { "Content-Type": "text/event-stream" } });

// Client
ai.mutateWithStream(
  async (signal) => providerTextStream(await fetch("/api/rewrite", { method: "POST", body, signal }), "anthropic", { signal }),
  (cur, chunk) => cur + chunk,
  { framing: "raw" },
);`}
      />

      <Callout>
        Provider-reported errors (<code>error</code> events, v4 <code>3:</code> records) throw{" "}
        <code>ProviderStreamError</code>, so <code>useOptimisticAIState</code> rolls back and exposes <code>error</code>.
        Keep API keys on the server: never call vendors directly from the browser.
      </Callout>
      <CodeBlock
        lang="ts"
        code={`import { providerTextReader } from "@erankushpatil/anky-ui";
// providerTextReader(source, "openai" | "anthropic" | "ai-sdk", { signal }) -> AsyncGenerator<string>`}
      />
    </>
  );
}
