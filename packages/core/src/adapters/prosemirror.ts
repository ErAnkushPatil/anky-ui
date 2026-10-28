import {
  onDocumentSelectionChange,
  unionRects,
  type ClientRectLike,
  type EditorAdapter,
  type EditorSelection,
} from "./editorAdapter";

/** Subset of a ProseMirror `Transaction` used by the adapter. */
export interface ProseMirrorTransactionLike {
  insertText(text: string, from?: number, to?: number): ProseMirrorTransactionLike;
  scrollIntoView?(): ProseMirrorTransactionLike;
}

/** Subset of a ProseMirror `EditorView` used by the adapter (structurally compatible with the real one). */
export interface ProseMirrorViewLike {
  readonly dom: Element;
  readonly state: {
    readonly selection: { readonly from: number; readonly to: number; readonly empty: boolean };
    readonly doc: {
      readonly content: { readonly size: number };
      textBetween(from: number, to: number, blockSeparator?: string, leafText?: string): string;
    };
    readonly tr: ProseMirrorTransactionLike;
  };
  coordsAtPos(pos: number): ClientRectLike;
  dispatch(tr: ProseMirrorTransactionLike): void;
  focus(): void;
}

export interface ProseMirrorSelection extends EditorSelection {
  readonly from: number;
  readonly to: number;
}

export interface ProseMirrorAdapterOptions {
  /**
   * Builds a `TextSelection` for `select()`. Pass `(view, from, to) => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))`.
   * Without it, `select()` returns `false`.
   */
  setSelection?: (view: ProseMirrorViewLike, from: number, to: number) => void;
  /** Separator used between blocks in `selection.text`. Defaults to a newline. */
  blockSeparator?: string;
}

/**
 * Adapter for a raw ProseMirror `EditorView`.
 *
 * ProseMirror has no selection event outside plugins, so the adapter listens to DOM `selectionchange`
 * and filters to selections inside `view.dom`.
 *
 * @example
 * const adapter = createProseMirrorAdapter(view, {
 *   setSelection: (v, from, to) => v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to))),
 * });
 * const anchor = useEditorAnchor(adapter);
 */
export function createProseMirrorAdapter(
  view: ProseMirrorViewLike,
  options: ProseMirrorAdapterOptions = {},
): EditorAdapter<ProseMirrorSelection> {
  const separator = options.blockSeparator ?? "\n";
  const textOf = (from: number, to: number) => view.state.doc.textBetween(from, to, separator, " ");
  const inBounds = (from: number, to: number) => from >= 0 && to <= view.state.doc.content.size && from < to;

  return {
    name: "prosemirror",
    getSelection() {
      const { from, to, empty } = view.state.selection;
      if (empty || !inBounds(from, to)) return null;
      return { from, to, text: textOf(from, to), key: `${from}:${to}` };
    },
    getRect({ from, to }) {
      if (!inBounds(from, to)) return null;
      try {
        return unionRects(view.coordsAtPos(from), view.coordsAtPos(to));
      } catch {
        return null; // position is not rendered (e.g. inside a collapsed node view)
      }
    },
    subscribe(listener) {
      const stop = onDocumentSelectionChange(listener);
      view.dom.addEventListener("keyup", listener);
      view.dom.addEventListener("mouseup", listener);
      return () => {
        stop();
        view.dom.removeEventListener("keyup", listener);
        view.dom.removeEventListener("mouseup", listener);
      };
    },
    replace(selection, text) {
      if (!inBounds(selection.from, selection.to) || textOf(selection.from, selection.to) !== selection.text) return false;
      view.dispatch(view.state.tr.insertText(text, selection.from, selection.to));
      return true;
    },
    select({ from, to }) {
      if (!options.setSelection || !inBounds(from, to)) return false;
      options.setSelection(view, from, to);
      return true;
    },
    focus() {
      view.focus();
    },
    getRoot() {
      return view.dom;
    },
  };
}
