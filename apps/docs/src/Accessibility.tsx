import { InlineDiff, SelectionPalette, announce, useOptimisticAIState } from "@erankushpatil/anky-ui";
import { useEffect, useRef, useState } from "react";
import { PROMPTS, mockRewrite, mockSSEStream } from "../../demo/src/mock";
import { CodeBlock, Demo, PropsTable } from "./ui";

const TEXT = "Honestly, we kinda broke the build and alot of people noticed.";

/** Shows what the shared live region is told, i.e. what a screen reader would announce. */
function useAnnouncementLog() {
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    const seen = new WeakMap<Element, string>();
    const observer = new MutationObserver(() => {
      document.querySelectorAll<HTMLElement>("[data-anky-ui-live]").forEach((node) => {
        const text = (node.textContent ?? "").replace(/\u00a0/g, "").trim();
        if (text && seen.get(node) !== text) {
          seen.set(node, text);
          setLog((prev) => [text, ...prev].slice(0, 6));
        } else if (!text) seen.delete(node);
      });
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, []);
  return log;
}

export function Accessibility() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [text, setText] = useState(TEXT);
  const ai = useOptimisticAIState({ initialState: "" });
  const log = useAnnouncementLog();

  const run = (prompt: string, selected: string) => {
    setTarget(selected);
    const answer = mockRewrite(selected, prompt);
    let acc = "";
    void ai.mutateWithStream(
      (signal) => mockSSEStream(answer, signal, { firstTokenMs: 200, tokenIntervalMs: 60 }),
      (_c, chunk) => (acc += chunk),
    );
  };
  const index = target === null ? -1 : text.indexOf(target);

  return (
    <>
      <h2>Accessibility</h2>
      <p className="lead">
        Every interactive piece is keyboard-operable, labelled, and announces its state to screen readers without
        flooding them with every streamed token.
      </p>
      <Demo title="Screen-reader announcements" note="Turn on a screen reader, or watch the log of what the live region receives.">
        <div ref={containerRef} className="demo-text" tabIndex={0} aria-label="Sample text">
          {index === -1 ? (
            text
          ) : (
            <>
              {text.slice(0, index)}
              <InlineDiff
                originalText={target!}
                modifiedText={ai.currentState}
                isStreaming={ai.isStreaming}
                onAccept={() => {
                  setText((t) => t.replace(target!, ai.currentState));
                  setTarget(null);
                }}
                onReject={() => {
                  ai.abort();
                  setTarget(null);
                }}
              />
              {text.slice(index + target!.length)}
            </>
          )}
        </div>
        <SelectionPalette
          containerRef={containerRef}
          enabled={target === null}
          actions={[{ label: "Make Professional", prompt: PROMPTS.professional }]}
          onSelectPrompt={run}
        />
        <div className="row">
          <button type="button" className="btn" onClick={() => announce("Custom message from your app.")}>
            announce()
          </button>
          <button type="button" className="btn" onClick={() => setText(TEXT)}>
            Reset
          </button>
        </div>
        <strong>Announced</strong>
        <ul className="log" aria-label="Announcement log">
          {log.length === 0 && <li>Nothing yet. Select some text.</li>}
          {log.map((entry, i) => (
            <li key={`${i}:${entry}`}>{entry}</li>
          ))}
        </ul>
      </Demo>

      <h3>Roles and relationships</h3>
      <PropsTable
        rows={[
          ["SelectionPalette", "role=toolbar", "Labelled “AI actions”, arrow/Home/End navigation, aria-keyshortcuts=Alt+/."],
          ["Palette input", "aria-label", "Uses customInputPlaceholder as its name; Enter submits, Esc closes."],
          ["InlineDiff", "role=group", "“AI suggested edit”, aria-busy while streaming, <ins>/<del> semantics."],
          ["InlineDiff toolbar", "role=toolbar", "Accept/Reject buttons with aria-keyshortcuts; Accept disabled while streaming."],
          ["GhostInput", "aria-autocomplete=inline", "Hidden polite live region reads the suggestion and “Press Tab to accept”."],
        ]}
      />

      <h3>Focus management</h3>
      <ul>
        <li>
          Opening the palette never steals focus (it would collapse the selection). <kbd>Alt</kbd>+<kbd>/</kbd> moves
          focus into it.
        </li>
        <li>
          <kbd>Esc</kbd> closes the palette, returns focus to the element that had it and restores the selection.
        </li>
        <li>
          Buttons ignore <code>mousedown</code>, so clicking them does not clear the selection.
        </li>
        <li>Animations respect <code>prefers-reduced-motion</code>.</li>
      </ul>

      <h3>Announcing from your own code</h3>
      <CodeBlock
        lang="ts"
        code={`import { announce } from "@erankushpatil/anky-ui";

announce("Rewrite applied.");              // polite (role=status)
announce("Network error, edit reverted.", "assertive"); // role=alert`}
      />
      <p>
        The live region is created lazily in <code>document.body</code> on the client, is a no-op during SSR and is
        emptied after five seconds. Streaming tokens are not announced: only “AI is writing a suggestion” and a summary
        (“Suggestion ready: 2 insertions, 1 deletion. Press Control Enter to accept or Escape to reject”) are.
      </p>
    </>
  );
}
