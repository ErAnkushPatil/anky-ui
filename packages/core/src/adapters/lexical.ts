import type { EditorAdapter, EditorSelection } from "./editorAdapter";

interface LexicalPointLike {
  key: string;
  offset: number;
  type: "text" | "element";
}

/** Subset of a Lexical `RangeSelection`. */
export interface LexicalRangeSelectionLike {
  anchor: LexicalPointLike & { set(key: string, offset: number, type: "text" | "element"): void };
  focus: LexicalPointLike & { set(key: string, offset: number, type: "text" | "element"): void };
  isCollapsed(): boolean;
  getTextContent(): string;
  insertText(text: string): void;
}

/** Subset of a Lexical `LexicalEditor` used by the adapter. */
export interface LexicalEditorLike {
  getRootElement(): HTMLElement | null;
  focus(callback?: () => void, options?: { defaultSelection?: "rootStart" | "rootEnd" }): void;
  getEditorState(): { read<T>(fn: () => T): T };
  update(fn: () => void, options?: { discrete?: boolean }): void;
  registerUpdateListener(listener: () => void): () => void;
}

/**
 * Lexical's `$`-functions only work inside `editor.read/update`, and must come from the same `lexical`
 * instance as the editor, so the app passes them in rather than this package importing `lexical`.
 *
 * @example
 * // helpers come from the app's own `lexical` install
 * createLexicalAdapter(editor, { $getSelection, $isRangeSelection, $createRangeSelection, $setSelection });
 */
export interface LexicalHelpers {
  $getSelection(): unknown;
  $isRangeSelection(selection: unknown): selection is LexicalRangeSelectionLike;
  $createRangeSelection(): LexicalRangeSelectionLike;
  $setSelection(selection: LexicalRangeSelectionLike | null): void;
}

export interface LexicalSelection extends EditorSelection {
  readonly anchor: LexicalPointLike;
  readonly focus: LexicalPointLike;
}

/**
 * Adapter for a Lexical editor. Selection state is read from Lexical (so it reflects node keys, not
 * fragile DOM offsets) and measured from the DOM selection inside the editor root.
 *
 * Edits run inside `editor.update`, so they join Lexical's history as one undoable step.
 */
export function createLexicalAdapter(editor: LexicalEditorLike, lexical: LexicalHelpers): EditorAdapter<LexicalSelection> {
  const { $getSelection, $isRangeSelection, $createRangeSelection, $setSelection } = lexical;
  let lastRect: { key: string; rect: DOMRect } | null = null;

  const readSelection = (): LexicalSelection | null =>
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return null;
      const anchor = { key: selection.anchor.key, offset: selection.anchor.offset, type: selection.anchor.type };
      const focus = { key: selection.focus.key, offset: selection.focus.offset, type: selection.focus.type };
      return {
        anchor,
        focus,
        text: selection.getTextContent(),
        key: `${anchor.key}:${anchor.offset}:${focus.key}:${focus.offset}`,
      };
    });

  /** Re-create the range inside an `update` and run `fn` on it if the text still matches. */
  const withRange = (selection: LexicalSelection, fn: (range: LexicalRangeSelectionLike) => void): boolean => {
    let applied = false;
    editor.update(
      () => {
        try {
          const range = $createRangeSelection();
          range.anchor.set(selection.anchor.key, selection.anchor.offset, selection.anchor.type);
          range.focus.set(selection.focus.key, selection.focus.offset, selection.focus.type);
          if (range.isCollapsed() || range.getTextContent() !== selection.text) return;
          $setSelection(range);
          fn(range);
          applied = true;
        } catch {
          // Node was removed; leave the document untouched.
        }
      },
      { discrete: true }, // run synchronously so `applied` is accurate on return
    );
    return applied;
  };

  return {
    name: "lexical",
    getSelection: readSelection,
    getRect(selection) {
      const root = editor.getRootElement();
      const domSelection = typeof window === "undefined" ? null : window.getSelection();
      if (root && domSelection && domSelection.rangeCount > 0) {
        const range = domSelection.getRangeAt(0);
        if (root.contains(range.commonAncestorContainer)) {
          const rect = range.getBoundingClientRect();
          if (rect.width !== 0 || rect.height !== 0) {
            lastRect = { key: selection.key, rect };
            return rect;
          }
        }
      }
      // Focus moved into the palette, so the DOM selection is gone but Lexical still holds the range.
      return lastRect?.key === selection.key ? lastRect.rect : null;
    },
    subscribe(listener) {
      return editor.registerUpdateListener(listener);
    },
    replace(selection, text) {
      return withRange(selection, (range) => range.insertText(text));
    },
    select(selection) {
      return withRange(selection, () => undefined);
    },
    focus() {
      editor.getRootElement()?.focus({ preventScroll: true });
    },
    getRoot() {
      return editor.getRootElement();
    },
  };
}
