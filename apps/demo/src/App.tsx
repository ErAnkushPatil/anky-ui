import {
  GhostInput,
  InlineDiff,
  SelectionPalette,
  captureSelectionSnapshot,
  useOptimisticAIState,
  type SelectionPaletteAction,
} from "@erankushpatil/anky-ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ARTICLE } from "./article";
import { PROMPTS, mockRewrite, mockSSEStream, mockSuggest } from "./mock";

/** A pending AI rewrite of `text.slice(start, end)`, reviewed inline before it is applied. */
interface ArticleEdit {
  start: number;
  end: number;
  original: string;
  modified: string;
}

interface ArticleState {
  text: string;
  edit: ArticleEdit | null;
}

/** Set `VITE_ANKY_ENDPOINT` to stream from a real backend (POST `{ prompt, text }` → SSE or raw text). */
const ENDPOINT: string | undefined = import.meta.env.VITE_ANKY_ENDPOINT || undefined;

const IS_MAC = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const TYPING_COMMIT_MS = 500;

const ACTIONS: SelectionPaletteAction[] = [
  { label: "Make Professional", prompt: PROMPTS.professional, icon: "✦" },
  { label: "Shorten", prompt: PROMPTS.shorten, icon: "↘" },
  { label: "Fix Grammar", prompt: PROMPTS.grammar, icon: "✓" },
];

export function App() {
  const articleRef = useRef<HTMLDivElement | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [email, setEmail] = useState("");

  const ai = useOptimisticAIState<ArticleState>({ initialState: { text: ARTICLE, edit: null }, endpoint: ENDPOINT });
  const { currentState: state, confirmedState, isStreaming, error, canUndo, canRedo, history } = ai;
  const { update, undo, redo, accept, reject, abort, mutateWithStream } = ai;

  /** Commits pending keystrokes in the article as one undoable history entry. */
  const flushTyping = useCallback(() => {
    if (typingTimer.current === undefined) return;
    clearTimeout(typingTimer.current);
    typingTimer.current = undefined;
    const text = articleRef.current?.textContent ?? "";
    update((s) => (s.edit || s.text === text ? s : { ...s, text }));
  }, [update]);

  const onTyping = useCallback(() => {
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(flushTyping, TYPING_COMMIT_MS);
  }, [flushTyping]);

  useEffect(() => () => clearTimeout(typingTimer.current), []);

  const runUndo = useCallback(() => {
    flushTyping();
    undo();
  }, [flushTyping, undo]);

  const runRedo = useCallback(() => {
    flushTyping();
    redo();
  }, [flushTyping, redo]);

  // Global Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (and Ctrl+Y) drive the AI state history. Plain form
  // fields (email, palette input) keep their native undo.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const isUndo = key === "z" && !event.shiftKey;
      const isRedo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey && !IS_MAC);
      if (!isUndo && !isRedo) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      event.preventDefault();
      if (isUndo) runUndo();
      else runRedo();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [runUndo, runRedo]);

  const runAI = useCallback(
    (prompt: string, selectedText: string) => {
      const el = articleRef.current;
      if (!el) return;
      flushTyping();
      const text = el.textContent ?? "";

      // The palette restores the selection before calling us, so map it to character offsets.
      let start = -1;
      const selection = document.getSelection();
      if (selection?.rangeCount && el.contains(selection.getRangeAt(0).commonAncestorContainer)) {
        start = captureSelectionSnapshot(selection.getRangeAt(0), el).start;
      }
      if (start < 0 || text.slice(start, start + selectedText.length) !== selectedText) {
        start = text.indexOf(selectedText);
      }
      if (start < 0 || !selectedText) return;
      const end = start + selectedText.length;
      const original = text.slice(start, end);
      selection?.removeAllRanges();

      void mutateWithStream(
        (signal) =>
          ENDPOINT
            ? fetch(ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
                body: JSON.stringify({ prompt, text: original }),
                signal,
              })
            : mockSSEStream(mockRewrite(original, prompt), signal),
        (s, chunk) => ({
          ...s,
          edit: { start, end, original, modified: (s.edit?.modified ?? "") + chunk },
        }),
      );
    },
    [flushTyping, mutateWithStream],
  );

  const acceptEdit = useCallback(() => {
    update((s) =>
      s.edit ? { text: s.text.slice(0, s.edit.start) + s.edit.modified + s.text.slice(s.edit.end), edit: null } : s,
    );
  }, [update]);

  // Rejecting is an undo: it cancels an in-flight stream or restores the pre-edit snapshot,
  // and Redo brings the suggestion back.
  const rejectEdit = useCallback(() => undo(), [undo]);

  const dirty = state !== confirmedState;
  const status = isStreaming
    ? state.edit
      ? "Streaming rewrite…"
      : "Thinking…"
    : state.edit
      ? "Review the suggested edit"
      : dirty
        ? "Unsaved changes"
        : "All changes saved";
  const visibleError = error && error.name !== "AbortError" ? error : null;

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            ✦
          </span>
          Anky UI <span className="muted">Playground</span>
        </div>
        <div className="controls" role="toolbar" aria-label="History">
          <button type="button" onClick={runUndo} disabled={!canUndo && !isStreaming}>
            Undo <kbd>{MOD}Z</kbd>
          </button>
          <button type="button" onClick={runRedo} disabled={!canRedo || isStreaming}>
            Redo <kbd>{MOD}⇧Z</kbd>
          </button>
          <span className="divider" />
          <button
            type="button"
            onClick={() => {
              flushTyping();
              accept();
            }}
            disabled={!dirty || isStreaming || state.edit !== null}
            title="Commit the current text as the new baseline (clears history)"
          >
            Save
          </button>
          <button
            type="button"
            onClick={reject}
            disabled={!dirty && !isStreaming}
            title="Revert to the last saved baseline (undoable)"
          >
            Revert
          </button>
        </div>
      </header>

      <main>
        <section className="card">
          <div className="card-head">
            <h2>Article</h2>
            <span className={`status${isStreaming ? " live" : ""}`} aria-live="polite">
              {status}
              {isStreaming && (
                <button type="button" className="link" onClick={abort}>
                  Stop
                </button>
              )}
            </span>
          </div>
          <p className="hint">
            Highlight any text to open the AI palette. History: {history.past.length} undo /{" "}
            {history.future.length} redo{ENDPOINT ? ` · endpoint ${ENDPOINT}` : " · mock stream"}
          </p>
          {visibleError && (
            <p className="error" role="alert">
              AI request failed: {visibleError.message}
            </p>
          )}
          {state.edit ? (
            <ReviewArticle
              state={state}
              edit={state.edit}
              isStreaming={isStreaming}
              onAccept={acceptEdit}
              onReject={rejectEdit}
            />
          ) : (
            <EditableArticle text={state.text} editable={!isStreaming} articleRef={articleRef} onTyping={onTyping} />
          )}
          <SelectionPalette
            containerRef={articleRef}
            enabled={!state.edit && !isStreaming}
            minChars={3}
            actions={ACTIONS}
            onSelectPrompt={runAI}
            customInputPlaceholder="Ask AI to rewrite…"
          />
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Email draft</h2>
          </div>
          <p className="hint">
            Inline completions as you type. <kbd>Tab</kbd> or <kbd>→</kbd> accepts, <kbd>Esc</kbd> dismisses.
          </p>
          <label className="field">
            <span>Subject</span>
            <input type="text" defaultValue="Async standups: two-week pilot" />
          </label>
          <GhostInput
            className="ghost-field"
            value={email}
            onChange={setEmail}
            fetchSuggestion={mockSuggest}
            debounceMs={250}
            rows={8}
            placeholder={"Start a sentence, e.g. “I wanted to…” or “Let me…”"}
            aria-label="Email body"
          />
        </section>
      </main>
    </div>
  );
}

interface EditableArticleProps {
  text: string;
  editable: boolean;
  articleRef: RefObject<HTMLDivElement | null>;
  onTyping: () => void;
}

/**
 * Uncontrolled plain-text editor. React renders no children here; the text is written
 * imperatively only when state changes from outside (undo/redo, accepted edits), so the
 * caret is never disturbed while typing.
 */
function EditableArticle({ text, editable, articleRef, onTyping }: EditableArticleProps) {
  useLayoutEffect(() => {
    const el = articleRef.current;
    if (el && el.textContent !== text) el.textContent = text;
  }, [text, articleRef]);

  return (
    <div
      ref={articleRef}
      className="article"
      contentEditable={editable ? "plaintext-only" : false}
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-multiline="true"
      aria-label="Article"
      onInput={onTyping}
    />
  );
}

interface ReviewArticleProps {
  state: ArticleState;
  edit: ArticleEdit;
  isStreaming: boolean;
  onAccept: () => void;
  onReject: () => void;
}

function ReviewArticle({ state, edit, isStreaming, onAccept, onReject }: ReviewArticleProps) {
  return (
    <div className="article reviewing" aria-label="Article (reviewing AI edit)">
      {state.text.slice(0, edit.start)}
      <InlineDiff
        originalText={edit.original}
        modifiedText={edit.modified}
        mode="word"
        isStreaming={isStreaming}
        onAccept={onAccept}
        onReject={onReject}
      />
      {state.text.slice(edit.end)}
    </div>
  );
}
