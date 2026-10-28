import { useRef, useState } from "react";
import { GhostInput } from "../src/components/GhostInput";
import { InlineDiff } from "../src/components/InlineDiff";
import { SelectionPalette } from "../src/components/SelectionPalette";
import { useSelectionAnchor } from "../src/dom/useSelectionAnchor";
import { useOptimisticAIState } from "../src/hooks/useOptimisticAIState";

/** Every public component and hook in one tree, for SSR and hydration tests. */
export function SSRFixture({ onPrompt = () => {} }: { onPrompt?: (prompt: string, text: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const anchor = useSelectionAnchor({ containerRef });
  const ai = useOptimisticAIState({ initialState: "The quick brown fox." });
  const [draft, setDraft] = useState("Draft text");

  return (
    <main>
      <div ref={containerRef} id="article" data-anchor-open={String(anchor.isOpen)}>
        <p>{ai.currentState}</p>
        <p>
          Edited:{" "}
          <InlineDiff originalText="The quick brown fox." modifiedText="The swift brown fox!" onAccept={() => {}} onReject={() => {}} />
        </p>
        <p>
          <InlineDiff
            originalText="streaming text"
            modifiedText="streamed"
            isStreaming
            toolbar="inline"
            onAccept={() => {}}
            onReject={() => {}}
          />
        </p>
      </div>
      <SelectionPalette containerRef={containerRef} onSelectPrompt={onPrompt} />
      <GhostInput value={draft} onChange={setDraft} fetchSuggestion={async () => ""} placeholder="Write…" />
    </main>
  );
}
