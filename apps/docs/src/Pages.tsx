import {
  GhostInput,
  InlineDiff,
  SelectionPalette,
  useOptimisticAIState,
} from "@erankushpatil/anky-ui";
import { useRef, useState } from "react";
import { PROMPTS, mockRewrite, mockSSEStream, mockSuggest } from "../../demo/src/mock";
import { CodeBlock, Callout, Demo, PropsTable } from "./ui";

const PARAGRAPH =
  "Honestly, the daily standup was kinda broken for us. Folks would go off on a tangent about some bug, and me and the team talked about it alot. We figured out that the meeting wasn't really helping anyone get stuff done.";

const ACTIONS = [
  { label: "Fix Grammar", prompt: PROMPTS.grammar },
  { label: "Shorten", prompt: PROMPTS.shorten },
  { label: "Make Professional", prompt: PROMPTS.professional },
];

export function Home() {
  return (
    <>
      <h2>Anky UI</h2>
      <p className="lead">
        Headless React primitives for inline, in-context AI: a floating selection palette, a streaming inline diff,
        Copilot-style ghost text and optimistic AI state with undo/redo. Copy the source into your project, or install
        the package.
      </p>
      <h3>Install</h3>
      <CodeBlock lang="bash" code={"npm install @erankushpatil/anky-ui @floating-ui/react\n# or copy the source (shadcn-style):\nnpx anky-ui add selection-palette inline-diff ghost-input"} />
      <h3>Quick start</h3>
      <CodeBlock
        code={`import { SelectionPalette, InlineDiff, useOptimisticAIState } from "@erankushpatil/anky-ui";

function Editor() {
  const ai = useOptimisticAIState({ initialState: "" });

  return (
    <>
      <article>Select some of this text…</article>
      <SelectionPalette
        onSelectPrompt={(prompt, selected) =>
          ai.mutateWithStream(fetch("/api/rewrite", { method: "POST", body: JSON.stringify({ prompt, selected }) }),
            (current, chunk) => current + chunk)
        }
      />
      <InlineDiff originalText="…" modifiedText={ai.currentState} isStreaming={ai.isStreaming}
        onAccept={ai.accept} onReject={ai.reject} />
    </>
  );
}`}
      />
      <h3>What is in the box</h3>
      <ul>
        <li>
          <a href="#/components">Components</a>: <code>SelectionPalette</code>, <code>InlineDiff</code>,{" "}
          <code>GhostInput</code>.
        </li>
        <li>
          <a href="#/state">State</a>: <code>useOptimisticAIState</code> with snapshots, rollback and undo/redo.
        </li>
        <li>
          <a href="#/recipes">Streaming recipes</a>: OpenAI, Anthropic and the Vercel AI SDK.
        </li>
        <li>
          <a href="#/adapters">Editor adapters</a>: Tiptap, ProseMirror and Lexical.
        </li>
        <li>
          <a href="#/accessibility">Accessibility</a>: roles, focus management and screen-reader announcements.
        </li>
        <li>
          <a href="#/benchmarks">Benchmarks</a>: diff speed and streaming frame rate, measured in your browser.
        </li>
      </ul>
    </>
  );
}

function PaletteDiffDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(PARAGRAPH);
  const [target, setTarget] = useState<string | null>(null);
  const ai = useOptimisticAIState({ initialState: "" });

  const run = (prompt: string, selected: string) => {
    if (!text.includes(selected)) return;
    setTarget(selected);
    const answer = mockRewrite(selected, Object.values(PROMPTS).includes(prompt as never) ? prompt : PROMPTS.professional);
    let streamed = "";
    void ai.mutateWithStream(
      (signal) => mockSSEStream(answer, signal, { firstTokenMs: 150, tokenIntervalMs: 30 }),
      (_current, chunk) => (streamed += chunk),
    );
  };

  const finish = (apply: boolean) => {
    if (apply && target !== null) setText((t) => t.replace(target, ai.currentState));
    if (!apply) ai.abort();
    setTarget(null);
  };

  const index = target === null ? -1 : text.indexOf(target);
  return (
    <Demo
      title="SelectionPalette + InlineDiff"
      note={
        <>
          Select any words. Press <kbd>Alt</kbd>+<kbd>/</kbd> to move focus into the palette, then use the arrow keys.
        </>
      }
    >
      <div ref={containerRef} className="demo-text" tabIndex={0} aria-label="Sample article">
        {index === -1 ? (
          text
        ) : (
          <>
            {text.slice(0, index)}
            <InlineDiff
              originalText={target!}
              modifiedText={ai.currentState}
              isStreaming={ai.isStreaming}
              onAccept={() => finish(true)}
              onReject={() => finish(false)}
            />
            {text.slice(index + target!.length)}
          </>
        )}
      </div>
      <SelectionPalette containerRef={containerRef} actions={ACTIONS} onSelectPrompt={run} enabled={target === null} />
      <div className="row">
        <button type="button" className="btn" onClick={() => setText(PARAGRAPH)}>
          Reset text
        </button>
      </div>
    </Demo>
  );
}

function GhostDemo() {
  const [value, setValue] = useState("");
  return (
    <Demo title="GhostInput" note={<>Type “I wanted to…” or “Thanks…”, then press <kbd>Tab</kbd> to accept.</>}>
      <GhostInput
        value={value}
        onChange={setValue}
        fetchSuggestion={mockSuggest}
        debounceMs={250}
        placeholder="Start an email…"
        rows={4}
        style={{ width: "100%", font: "16px/1.6 ui-sans-serif, system-ui", padding: 10, border: "1px solid #d4d4d8", borderRadius: 8 }}
      />
    </Demo>
  );
}

export function Components() {
  return (
    <>
      <h2>Components</h2>
      <p className="lead">Unstyled by default; every part has an <code>anky-ui-*</code> class and a Tailwind preset is exported.</p>

      <h3>SelectionPalette and InlineDiff</h3>
      <PaletteDiffDemo />
      <CodeBlock
        code={`<SelectionPalette
  actions={[{ label: "Shorten", prompt: "Make this shorter." }]}
  onSelectPrompt={(prompt, selectedText) => run(prompt, selectedText)}
  customInputPlaceholder="Ask AI to edit…"
/>`}
      />
      <PropsTable
        rows={[
          ["actions", "{ label; icon?; prompt }[]", "Preset pills. Defaults to Fix Grammar, Shorten, Translate."],
          ["onSelectPrompt", "(prompt, selectedText) => void", "Called for a pill click or Enter in the input."],
          ["anchor", "UseSelectionAnchorResult", "Drive the palette from a rich-text editor (see Editor adapters)."],
          ["containerRef", "RefObject<HTMLElement>", "Only selections inside this element open the palette."],
          ["classNames", "SelectionPaletteClassNames", "Per-part class overrides."],
        ]}
      />
      <PropsTable
        rows={[
          ["originalText / modifiedText", "string", "The two sides of the diff."],
          ["mode", "'word' | 'char'", "Diff granularity. Defaults to 'word'."],
          ["onAccept / onReject", "() => void", "Cmd/Ctrl+Enter and Esc trigger them."],
          ["isStreaming", "boolean", "Pulses, disables Accept, sets aria-busy and announces progress."],
        ]}
      />

      <h3>GhostInput</h3>
      <GhostDemo />
      <CodeBlock
        code={`<GhostInput
  value={value}
  onChange={setValue}
  fetchSuggestion={(current, { signal }) => suggest(current, signal)}
  debounceMs={250}
/>`}
      />
      <Callout>
        <strong>Tab</strong> or <strong>→</strong> (caret at the end) accepts, <strong>Esc</strong> dismisses. Typing a
        character that matches the suggestion keeps it.
      </Callout>
    </>
  );
}

export function State() {
  const ai = useOptimisticAIState({ initialState: "Draft v1" });
  const rewrite = () => {
    let acc = ai.currentState;
    void ai.mutateWithStream(
      (signal) => mockSSEStream(" and some AI-added words, streamed.", signal, { firstTokenMs: 100, tokenIntervalMs: 120 }),
      (_current, chunk) => (acc += chunk),
    );
  };
  return (
    <>
      <h2>useOptimisticAIState</h2>
      <p className="lead">
        Optimistic streaming state with an atomic snapshot, automatic rollback on error or abort, and a 20-step
        undo/redo history.
      </p>
      <Demo title="Stream, abort, undo, redo">
        <p aria-live="off">
          <strong>currentState:</strong> {ai.currentState || "(empty)"}
          <br />
          <strong>confirmedState:</strong> {ai.confirmedState}
          <br />
          <strong>history:</strong> {ai.history.past.length} undo / {ai.history.future.length} redo
          {ai.error && <span className="fail"> · {ai.error.message}</span>}
        </p>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={rewrite}>
            {ai.isStreaming ? "Restart stream" : "Stream"}
          </button>
          <button type="button" className="btn" onClick={() => ai.abort()} disabled={!ai.isStreaming}>
            Abort (rolls back)
          </button>
          <button type="button" className="btn" onClick={() => ai.undo()} disabled={!ai.canUndo}>
            Undo
          </button>
          <button type="button" className="btn" onClick={() => ai.redo()} disabled={!ai.canRedo}>
            Redo
          </button>
          <button type="button" className="btn" onClick={() => ai.accept()}>
            Accept
          </button>
          <button type="button" className="btn" onClick={() => ai.reject()}>
            Reject
          </button>
        </div>
      </Demo>
      <CodeBlock
        code={`const ai = useOptimisticAIState({ initialState: "" });

await ai.mutateWithStream(fetch("/api/rewrite"), (current, chunk) => current + chunk);
ai.undo(); ai.redo(); ai.accept(); ai.reject();`}
      />
      <PropsTable
        rows={[
          ["mutateWithStream", "(source, transform, opts?) => Promise<MutationOutcome>", "Last call wins; never rejects."],
          ["abort()", "() => boolean", "Cancels and rolls back to the snapshot."],
          ["accept() / reject()", "() => void", "Commit current state, or revert to confirmed state."],
          ["undo() / redo()", "() => boolean", "Walk the history (20 entries each way)."],
        ]}
      />
    </>
  );
}
