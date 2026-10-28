import { InlineDiff, computeDiff, useOptimisticAIState, type DiffMode } from "@erankushpatil/anky-ui";
import { Profiler, useCallback, useRef, useState, type ProfilerOnRenderCallback } from "react";
import { ARTICLE } from "./article";
import { PROMPTS, mockRewrite, mockSSEStream } from "./mock";

export interface StressResult {
  rate: number;
  mode: DiffMode;
  chars: number;
  tokens: number;
  durationMs: number;
  achievedRate: number;
  refreshMs: number;
  frames: number;
  frameP50: number;
  frameP95: number;
  frameMax: number;
  droppedFrames: number;
  droppedPct: number;
  longTasks: number;
  longTaskMaxMs: number;
  longAnimationFrames: number;
  forcedLayoutMs: number;
  commits: number;
  commitAvgMs: number;
  commitP95Ms: number;
  commitMaxMs: number;
  diffAvgMs: number;
  diffP95Ms: number;
  diffMaxMs: number;
}

declare global {
  interface Window {
    __ankyStress?: StressResult;
  }
}

/** Chrome's Long Animation Frames API entry (not yet in lib.dom). */
type LongAnimationFrame = PerformanceEntry & { scripts?: Array<{ forcedStyleAndLayoutDuration?: number }> };

const SIZES = { "1×": 1, "2×": 2 } as const;

/**
 * Streams a rewrite of the article into `<InlineDiff>` at a fixed token rate through the real pipeline
 * (SSE mock → streamTextReader → useOptimisticAIState → InlineDiff) and reports frame pacing,
 * long tasks, forced layouts and React commit cost.
 */
export function StressTest() {
  const [rate, setRate] = useState(50);
  const [mode, setMode] = useState<DiffMode>("word");
  const [size, setSize] = useState<keyof typeof SIZES>("1×");
  const [result, setResult] = useState<StressResult | null>(null);
  const [original, setOriginal] = useState(ARTICLE);
  const ai = useOptimisticAIState({ initialState: "" });
  const commits = useRef<number[]>([]);

  const onRender = useCallback<ProfilerOnRenderCallback>((_id, phase, actualDuration) => {
    if (phase !== "mount") commits.current.push(actualDuration);
  }, []);

  const run = async () => {
    const text = Array.from({ length: SIZES[size] }, () => ARTICLE).join("\n\n");
    const target = mockRewrite(text, PROMPTS.professional);
    setOriginal(text);
    setResult(null);
    window.__ankyStress = undefined;

    const refreshMs = await estimateRefreshInterval();
    const frames = recordFrames();
    const longTasks = observe("longtask");
    const loafs = observe("long-animation-frame");
    commits.current = [];
    const states: string[] = [];
    const start = performance.now();

    let streamed = "";
    await ai.mutateWithStream(
      (signal) => mockSSEStream(target, signal, { firstTokenMs: 0, tokenIntervalMs: 1000 / rate }),
      // Each run starts from scratch, independent of the previous run's state.
      (_current, chunk) => {
        streamed += chunk;
        states.push(streamed);
        return streamed;
      },
    );

    const durationMs = performance.now() - start;
    // Let the final commit paint before stopping the frame recorder.
    await nextFrame();
    await nextFrame();
    const deltas = frames.stop();
    const tasks = longTasks.stop();
    const animationFrames = loafs.stop() as LongAnimationFrame[];

    // Diff cost per token, measured offline so it does not skew the frame timings above.
    const diffTimes = states.map((state) => {
      const t0 = performance.now();
      computeDiff(text, state, mode);
      return performance.now() - t0;
    });

    const dropped = deltas.reduce((sum, d) => sum + Math.max(0, Math.round(d / refreshMs) - 1), 0);
    const next: StressResult = {
      rate,
      mode,
      chars: text.length,
      tokens: states.length,
      durationMs: round(durationMs),
      achievedRate: round((states.length / durationMs) * 1000),
      refreshMs: round(refreshMs),
      frames: deltas.length,
      frameP50: round(percentile(deltas, 0.5)),
      frameP95: round(percentile(deltas, 0.95)),
      frameMax: round(Math.max(0, ...deltas)),
      droppedFrames: dropped,
      droppedPct: round((dropped / Math.max(1, deltas.length + dropped)) * 100),
      longTasks: tasks.length,
      longTaskMaxMs: round(Math.max(0, ...tasks.map((t) => t.duration))),
      longAnimationFrames: animationFrames.length,
      forcedLayoutMs: round(
        animationFrames.reduce(
          (sum, f) => sum + (f.scripts ?? []).reduce((s, x) => s + (x.forcedStyleAndLayoutDuration ?? 0), 0),
          0,
        ),
      ),
      commits: commits.current.length,
      commitAvgMs: round(average(commits.current)),
      commitP95Ms: round(percentile(commits.current, 0.95)),
      commitMaxMs: round(Math.max(0, ...commits.current)),
      diffAvgMs: round(average(diffTimes)),
      diffP95Ms: round(percentile(diffTimes, 0.95)),
      diffMaxMs: round(Math.max(0, ...diffTimes)),
    };
    window.__ankyStress = next;
    setResult(next);
  };

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            ✦
          </span>
          Anky UI <span className="muted">Token stress test</span>
        </div>
        <div className="controls" role="toolbar" aria-label="Stress test">
          <label>
            Rate{" "}
            <select value={rate} onChange={(e) => setRate(Number(e.target.value))} disabled={ai.isStreaming}>
              {[25, 50, 100, 200].map((r) => (
                <option key={r} value={r}>
                  {r} tok/s
                </option>
              ))}
            </select>
          </label>
          <label>
            Mode{" "}
            <select value={mode} onChange={(e) => setMode(e.target.value as DiffMode)} disabled={ai.isStreaming}>
              <option value="word">word</option>
              <option value="char">char</option>
            </select>
          </label>
          <label>
            Text{" "}
            <select value={size} onChange={(e) => setSize(e.target.value as keyof typeof SIZES)} disabled={ai.isStreaming}>
              {Object.keys(SIZES).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={run} disabled={ai.isStreaming}>
            {ai.isStreaming ? "Streaming…" : "Run"}
          </button>
          <a href="#">Playground</a>
        </div>
      </header>
      <main>
        <section className="card" data-status={ai.isStreaming ? "running" : result ? "done" : "idle"}>
          <div className="card-head">
            <h2>Results</h2>
          </div>
          {result ? <ResultTable result={result} /> : <p className="hint">Run to measure frame pacing while tokens stream in.</p>}
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Stream</h2>
          </div>
          <div className="article reviewing">
            <Profiler id="inline-diff" onRender={onRender}>
              <InlineDiff
                originalText={original}
                modifiedText={ai.currentState || original}
                mode={mode}
                isStreaming={ai.isStreaming}
                shortcuts={false}
                onAccept={() => ai.accept()}
                onReject={() => ai.reject()}
              />
            </Profiler>
          </div>
        </section>
      </main>
    </div>
  );
}

function ResultTable({ result: r }: { result: StressResult }) {
  const rows: Array<[string, string, boolean?]> = [
    ["Tokens", `${r.tokens} in ${r.durationMs} ms (${r.achievedRate} tok/s, target ${r.rate})`],
    ["Text", `${r.chars} chars, ${r.mode} mode`],
    ["Frames", `${r.frames} @ ~${r.refreshMs} ms · p50 ${r.frameP50} · p95 ${r.frameP95} · max ${r.frameMax} ms`],
    ["Dropped frames", `${r.droppedFrames} (${r.droppedPct}%)`, r.droppedPct < 5],
    ["Long tasks (>50 ms)", `${r.longTasks}${r.longTasks ? `, max ${r.longTaskMaxMs} ms` : ""}`, r.longTasks === 0],
    ["Long animation frames", `${r.longAnimationFrames}, forced style/layout ${r.forcedLayoutMs} ms total`, r.forcedLayoutMs < 16],
    ["React commits", `${r.commits} · avg ${r.commitAvgMs} · p95 ${r.commitP95Ms} · max ${r.commitMaxMs} ms`, r.commitP95Ms < 16],
    ["computeDiff per token", `avg ${r.diffAvgMs} · p95 ${r.diffP95Ms} · max ${r.diffMaxMs} ms`, r.diffP95Ms < 5],
  ];
  return (
    <table className="stress-table">
      <tbody>
        {rows.map(([label, value, ok]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
            <td aria-label={ok === undefined ? undefined : ok ? "pass" : "fail"}>{ok === undefined ? "" : ok ? "✓" : "✗"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function estimateRefreshInterval(samples = 30): Promise<number> {
  const deltas: number[] = [];
  let last = await nextFrame();
  for (let i = 0; i < samples; i++) {
    const now = await nextFrame();
    deltas.push(now - last);
    last = now;
  }
  return percentile(deltas, 0.5);
}

function recordFrames() {
  const deltas: number[] = [];
  let last: number | undefined;
  let handle = requestAnimationFrame(function tick(now) {
    if (last !== undefined) deltas.push(now - last);
    last = now;
    handle = requestAnimationFrame(tick);
  });
  return {
    stop() {
      cancelAnimationFrame(handle);
      return deltas;
    },
  };
}

function observe(type: string) {
  const entries: PerformanceEntry[] = [];
  let observer: PerformanceObserver | undefined;
  if (PerformanceObserver.supportedEntryTypes?.includes(type)) {
    observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
    observer.observe({ type, buffered: false });
  }
  return {
    stop() {
      if (observer) entries.push(...observer.takeRecords());
      observer?.disconnect();
      return entries;
    },
  };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function average(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
