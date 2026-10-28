/** A range the adapter can hand back later to replace or re-select text. */
export interface EditorSelection {
  /** Plain text covered by the selection. */
  readonly text: string;
  /** Identity of the range (positions), used to tell a new selection from a re-fired event. */
  readonly key: string;
}

/** Minimal rectangle in viewport coordinates, as returned by editor coordinate APIs. */
export interface ClientRectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Bridge between a rich-text editor and Anky UI's floating components.
 *
 * Adapters are structurally typed: they never import the editor package, so installing
 * `@erankushpatil/anky-ui` does not pull in Tiptap, ProseMirror or Lexical.
 */
export interface EditorAdapter<S extends EditorSelection = EditorSelection> {
  readonly name: "prosemirror" | "tiptap" | "lexical";
  /** The current non-collapsed selection, or `null`. */
  getSelection(): S | null;
  /** Viewport rectangle of `selection`, or `null` when it cannot be measured (e.g. scrolled away). */
  getRect(selection: S): ClientRectLike | null;
  /** Notify whenever the editor's selection or document may have changed. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Replace `selection` with `text`. Returns `false` (and changes nothing) when the document no longer
   * contains the same text at that range, e.g. the user kept typing during an AI run.
   */
  replace(selection: S, text: string): boolean;
  /** Re-select `selection`. Returns `false` if it is no longer valid. */
  select(selection: S): boolean;
  /** Focus the editor without scrolling. */
  focus(): void;
  /** Element that contains the editable content; used as the floating-ui context element. */
  getRoot(): Element | null;
}

/** Build a DOMRect-shaped object from editor coordinates (works where `DOMRect` is unavailable). */
export function toDOMRect(rect: ClientRectLike): DOMRect {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const value = {
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width,
    height,
  };
  return { ...value, toJSON: () => value } as DOMRect;
}

/** Smallest rectangle containing both inputs. */
export function unionRects(a: ClientRectLike, b: ClientRectLike): ClientRectLike {
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/** Subscribe to DOM `selectionchange` (client only). */
export function onDocumentSelectionChange(listener: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  document.addEventListener("selectionchange", listener);
  return () => document.removeEventListener("selectionchange", listener);
}
