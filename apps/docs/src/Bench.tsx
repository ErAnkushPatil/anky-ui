import { InlineDiff, computeDiff, type DiffMode } from "@erankushpatil/anky-ui";
import { useRef, useState } from "react";
import { Callout, Demo } from "./ui";

const VOCAB = "the quick brown fox jumps over lazy dog while system design review ships fast reliable software for every team and user".split(" ");

/** Deterministic PRNG so every run benchmarks identical input. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function makeText(chars: number, seed = 1): string {
  const rand = rng(seed);
  const words: string[] = [];
  let length = 0;
  while (length < chars) {
    const word = VOCAB[Math.floor(rand() * VOCAB.length)]!;
    words.push(word);
    length += word.length + 1;
  }
  return words.join(" ").slice(0, chars);
}

/** ~10% of the words replaced or removed, like a typical AI rewrite. */
function edit(text: string, seed = 2): string {
  const rand = rng(seed);
  return text
    .split(" ")
    .flatMap((word) => {
      const r = rand();
      if (r < 0.05) return [];
      if (r < 0.1) return [VOCAB[Math.floor(rand() * VOCAB.length)]!.toUpperCase()];
      return [word];
    })
    .join(" ");
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
};
const fmt = (n: number) => n.toFixed(n < 10 ? 2 : 1);

interface DiffRow {
  size: number;
  mode: DiffMode;
  median: number;
  p95: number;
  max: number;
}

const SIZES = [500, 1000, 2500, 5000];
const BUDGET_MS = 5;

function DiffBench() {
  const [rows, setRows] = useState<DiffRow[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setRows(null);
    await new Promise((r) => setTimeout(r, 30)); // let the button state paint
    const out: DiffRow[] = [];
    for (const size of SIZES) {
      const a = makeText(size);
      const b = edit(a);
      for (const mode of ["word", "char"] as const) {
        for (let i = 0; i < 5; i++) computeDiff(a, b, mode); // JIT warm-up
        const times: number[] = [];
        for (let i = 0; i < 40; i++) {
          const t0 = performance.now();
          computeDiff(a, b, mode);
          times.push(performance.now() - t0);
        }
        out.push({ size, mode, median: percentile(times, 0.5), p95: percentile(times, 0.95), max: Math.max(...times) });
      }
    }
    setRows(out);
    setRunning(false);
  };

  return (
    <Demo title="computeDiff speed" note={<>Budget: under {BUDGET_MS} ms (p95) for 5,000 characters with ~10% of the words edited. Results depend on your device.</>}>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={run} disabled={running}>
          {running ? "Running…" : "Run diff benchmark"}
        </button>
      </div>
      {rows && (
        <table className="results">
          <thead>
            <tr>
              <th scope="col">Characters</th>
              <th scope="col">Mode</th>
              <th scope="col">Median ms</th>
              <th scope="col">p95 ms</th>
              <th scope="col">Max ms</th>
              <th scope="col">&lt; {BUDGET_MS} ms</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.size}-${r.mode}`}>
                <td>{r.size.toLocaleString()}</td>
                <td>{r.mode}</td>
                <td>{fmt(r.median)}</td>
                <td>{fmt(r.p95)}</td>
                <td>{fmt(r.max)}</td>
                <td className={r.p95 < BUDGET_MS ? "pass" : "fail"}>{r.p95 < BUDGET_MS ? "pass" : "over"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Demo>
  );
}

interface StreamResult {
  rate: number;
  frames: number;
  fps: number;
  p95: number;
  max: number;
  dropped: number;
  tokens: number;
}

const STREAM_MS = 3000;
const STREAM_RATES = [50, 100, 200];

function StreamBench() {
  const original = useRef(makeText(2000, 7));
  const target = useRef(edit(original.current, 9));
  const [modified, setModified] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [results, setResults] = useState<StreamResult[]>([]);

  const run = async (rate: number) => {
    setStreaming(true);
    const tokens = target.current.match(/\s*\S+\s*|\s+/g) ?? [];
    const deltas: number[] = [];
    let shown = 0;
    await new Promise<void>((resolve) => {
      const start = performance.now();
      let last = start;
      const tick = (now: number) => {
        deltas.push(now - last);
        last = now;
        const elapsed = now - start;
        const count = Math.min(tokens.length, Math.floor((elapsed / 1000) * rate));
        if (count !== shown) {
          shown = count;
          setModified(tokens.slice(0, count).join(""));
        }
        if (elapsed < STREAM_MS && count < tokens.length) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    deltas.shift();
    const refresh = percentile(deltas, 0.5) || 16.7;
    const dropped = deltas.reduce((sum, d) => sum + Math.max(0, Math.round(d / refresh) - 1), 0);
    const total = deltas.reduce((a, b) => a + b, 0);
    setResults((prev) => [
      ...prev.filter((r) => r.rate !== rate),
      { rate, frames: deltas.length, fps: (deltas.length / total) * 1000, p95: percentile(deltas, 0.95), max: Math.max(0, ...deltas), dropped, tokens: shown },
    ].sort((a, b) => a.rate - b.rate));
    setStreaming(false);
  };

  return (
    <Demo
      title="Streaming frame rate into InlineDiff"
      note={<>Streams a 2,000-character rewrite through <code>InlineDiff</code> for up to {STREAM_MS / 1000}s per run. Every token re-diffs and re-renders. Dropped = frames missed relative to your display refresh.</>}
    >
      <div className="row">
        {STREAM_RATES.map((rate) => (
          <button key={rate} type="button" className="btn btn-primary" onClick={() => run(rate)} disabled={streaming}>
            {rate} tokens/s
          </button>
        ))}
      </div>
      <div className="demo-text" aria-hidden="true">
        <InlineDiff originalText={original.current} modifiedText={modified} isStreaming={streaming} toolbar="inline" onAccept={() => undefined} onReject={() => undefined} />
      </div>
      {results.length > 0 && (
        <table className="results">
          <thead>
            <tr>
              <th scope="col">Rate</th>
              <th scope="col">Avg FPS</th>
              <th scope="col">p95 frame ms</th>
              <th scope="col">Worst frame ms</th>
              <th scope="col">Dropped frames</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.rate}>
                <td>{r.rate} tok/s</td>
                <td>{fmt(r.fps)}</td>
                <td>{fmt(r.p95)}</td>
                <td>{fmt(r.max)}</td>
                <td className={r.dropped <= r.frames * 0.05 ? "pass" : "fail"}>{r.dropped}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Demo>
  );
}

export function Benchmarks() {
  return (
    <>
      <h2>Benchmarks</h2>
      <p className="lead">Measured live in your browser, so the numbers reflect your hardware, not a marketing machine.</p>
      <DiffBench />
      <StreamBench />
      <Callout>
        Benchmarks run the real library code. For the full pipeline (SSE parser, state hook, diff and React commits)
        open the playground's <code>#stress</code> page, and for CI-friendly numbers run <code>npm test</code>, which
        includes the 5 ms / 5,000-character diff assertion.
      </Callout>
    </>
  );
}
