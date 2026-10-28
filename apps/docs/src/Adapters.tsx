import {
  InlineDiff,
  SelectionPalette,
  createProseMirrorAdapter,
  useEditorAnchor,
  useOptimisticAIState,
  type ProseMirrorViewLike,
} from "@erankushpatil/anky-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { PROMPTS, mockRewrite, mockSSEStream } from "../../demo/src/mock";
import { CodeBlock, Callout, Demo } from "./ui";

const INITIAL = "Honestly, this editor is kinda small, but alot of the behaviour matches a real rich-text editor. Select some words!";

/**
 * A ~40 line stand-in for a ProseMirror `EditorView` over a plain-text contenteditable. It shows the exact
 * surface `createProseMirrorAdapter` needs, which is also what Tiptap exposes as `editor.view`.
 */
function createMiniView(el: HTMLElement): ProseMirrorViewLike {
  let last = { from: 0, to: 0 };
  const read = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      const pre = document.createRange();
      pre.selectNodeContents(el);
      pre.setEnd(range.startContainer, range.startOffset);
      const from = pre.toString().length;
      last = { from, to: from + range.toString().length };
    }
    return last; // focus moved into the palette: the editor keeps its selection, like ProseMirror does
  };
  const text = () => el.textContent ?? "";
  const tr = {
    ops: [] as Array<[string, number, number]>,
    insertText(value: string, from = 0, to = 0) {
      tr.ops.push([value, from, to]);
      return tr;
    },
  };
  return {
    dom: el,
    get state() {
      const { from, to } = read();
      return {
        selection: { from, to, empty: from === to },
        doc: { content: { size: text().length }, textBetween: (a: number, b: number) => text().slice(a, b) },
        tr,
      };
    },
    coordsAtPos(pos: number) {
      const node = el.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) throw new RangeError("no text node");
      const length = text().length;
      const range = document.createRange();
      range.setStart(node, Math.min(pos, Math.max(0, length - 1)));
      range.setEnd(node, Math.min(Math.min(pos, Math.max(0, length - 1)) + 1, length));
      const r = range.getBoundingClientRect();
      return { left: pos === length ? r.right : r.left, right: pos === length ? r.right : r.right, top: r.top, bottom: r.bottom };
    },
    dispatch(next) {
      const ops = (next as unknown as typeof tr).ops.splice(0);
      for (const [value, from, to] of ops) el.textContent = text().slice(0, from) + value + text().slice(to);
    },
    focus: () => el.focus({ preventScroll: true }),
  };
}

function LiveAdapterDemo() {
  const editorRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ProseMirrorViewLike | null>(null);
  const ai = useOptimisticAIState({ initialState: "" });

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.textContent = INITIAL;
    setView(createMiniView(el));
  }, []);

  const adapter = useMemo(
    () =>
      view &&
      createProseMirrorAdapter(view, {
        setSelection: (v, from, to) => {
          const node = v.dom.firstChild;
          const sel = window.getSelection();
          if (!node || !sel) return;
          const range = document.createRange();
          range.setStart(node, from);
          range.setEnd(node, to);
          sel.removeAllRanges();
          sel.addRange(range);
        },
      }),
    [view],
  );
  const anchor = useEditorAnchor(adapter);
  const [pending, setPending] = useState<{ original: string } | null>(null);

  const run = (prompt: string, selected: string) => {
    setPending({ original: selected });
    const answer = mockRewrite(selected, prompt);
    let acc = "";
    void ai.mutateWithStream(
      (signal) => mockSSEStream(answer, signal, { firstTokenMs: 150, tokenIntervalMs: 30 }),
      (_c, chunk) => (acc += chunk),
    );
  };

  return (
    <Demo
      title="useEditorAnchor + SelectionPalette on an adapter"
      note="The adapter replaces text through the editor's own transaction API, and refuses if the text changed meanwhile."
    >
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Mini rich-text editor"
        className="demo-text"
        spellCheck={false}
      />
      <SelectionPalette
        anchor={anchor}
        onSelectPrompt={run}
        actions={[
          { label: "Fix Grammar", prompt: PROMPTS.grammar },
          { label: "Make Professional", prompt: PROMPTS.professional },
        ]}
      />
      {pending && (
        <p>
          <InlineDiff
            originalText={pending.original}
            modifiedText={ai.currentState}
            isStreaming={ai.isStreaming}
            toolbar="inline"
            shortcuts={false}
            onAccept={() => {
              anchor.replaceSelection(ai.currentState);
              setPending(null);
            }}
            onReject={() => {
              ai.abort();
              setPending(null);
              anchor.restoreSelection();
            }}
          />
        </p>
      )}
    </Demo>
  );
}

export function Adapters() {
  return (
    <>
      <h2>Editor adapters</h2>
      <p className="lead">
        <code>SelectionPalette</code> and <code>InlineDiff</code> work on plain DOM text. For rich-text editors, wrap the
        editor in an adapter and feed <code>useEditorAnchor</code> to the palette. Adapters are structurally typed:
        installing Anky UI never installs Tiptap, ProseMirror or Lexical.
      </p>
      <LiveAdapterDemo />

      <h3>Tiptap</h3>
      <CodeBlock
        code={`import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { SelectionPalette, createTiptapAdapter, useEditorAnchor } from "@erankushpatil/anky-ui";

function Editor() {
  const editor = useEditor({ extensions: [StarterKit], content: "<p>Select me</p>", immediatelyRender: false });
  const adapter = useMemo(() => (editor ? createTiptapAdapter(editor) : null), [editor]);
  const anchor = useEditorAnchor(adapter);

  return (
    <>
      <EditorContent editor={editor} />
      <SelectionPalette
        anchor={anchor}
        onSelectPrompt={async (prompt, selected) => {
          const rewritten = await rewrite(prompt, selected);
          anchor.replaceSelection(rewritten); // one undoable Tiptap step
        }}
      />
    </>
  );
}`}
      />

      <h3>ProseMirror</h3>
      <CodeBlock
        code={`import { TextSelection } from "prosemirror-state";
import { createProseMirrorAdapter } from "@erankushpatil/anky-ui";

const adapter = createProseMirrorAdapter(view, {
  setSelection: (v, from, to) => v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to))),
});`}
      />

      <h3>Lexical</h3>
      <CodeBlock
        code={`import { $getSelection, $isRangeSelection, $createRangeSelection, $setSelection } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { createLexicalAdapter } from "@erankushpatil/anky-ui";

const [editor] = useLexicalComposerContext();
const adapter = useMemo(
  () => createLexicalAdapter(editor, { $getSelection, $isRangeSelection, $createRangeSelection, $setSelection }),
  [editor],
);`}
      />
      <Callout>
        Lexical's <code>$</code> helpers must come from the same <code>lexical</code> instance as your editor, so you
        pass them in. Nothing is imported by Anky UI.
      </Callout>

      <h3>Custom editors</h3>
      <p>Implement the small <code>EditorAdapter</code> interface (above is a 40-line example) for any other editor:</p>
      <CodeBlock
        lang="ts"
        code={`interface EditorAdapter<S extends { text: string; key: string }> {
  getSelection(): S | null;
  getRect(selection: S): { left: number; right: number; top: number; bottom: number } | null;
  subscribe(listener: () => void): () => void;
  replace(selection: S, text: string): boolean; // false if the document changed under the range
  select(selection: S): boolean;
  focus(): void;
  getRoot(): Element | null;
}`}
      />
    </>
  );
}
