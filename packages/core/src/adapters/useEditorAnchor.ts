"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SELECTION_DEBOUNCE_MS, type SelectionVirtualElement, type UseSelectionAnchorResult } from "../dom/useSelectionAnchor";
import { toDOMRect, type EditorAdapter, type EditorSelection } from "./editorAdapter";

export interface UseEditorAnchorOptions {
  /** Set to `false` to detach from the editor and reset. Defaults to `true`. */
  enabled?: boolean;
  /** Minimum trimmed selection length. Defaults to `1`. */
  minChars?: number;
  /** Debounce for editor selection events, in ms. Defaults to 100. */
  debounceMs?: number;
}

export interface UseEditorAnchorResult<S extends EditorSelection = EditorSelection> extends UseSelectionAnchorResult {
  /** The tracked selection (also kept after `close()` so an AI result can still be applied). */
  selection: S | null;
  /** Replace the tracked selection with `text`. Returns `false` if the document changed under it. */
  replaceSelection: (text: string) => boolean;
}

/**
 * `useSelectionAnchor` for rich-text editors. Pass the result to `<SelectionPalette anchor={...}>`.
 *
 * Same contract as the DOM hook: debounced, ignores collapsed or too-short selections, hides when the
 * selection scrolls out of view, and stays closed after `close()` until the selection changes.
 *
 * `adapter` must be referentially stable (wrap it in `useMemo`).
 *
 * @example
 * const adapter = useMemo(() => createTiptapAdapter(editor), [editor]);
 * const anchor = useEditorAnchor(adapter);
 * <SelectionPalette anchor={anchor} onSelectPrompt={...} />
 */
export function useEditorAnchor<S extends EditorSelection>(
  adapter: EditorAdapter<S> | null | undefined,
  options: UseEditorAnchorOptions = {},
): UseEditorAnchorResult<S> {
  const { enabled = true, minChars = 1, debounceMs = SELECTION_DEBOUNCE_MS } = options;
  const [selection, setSelection] = useState<S | null>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const dismissedKey = useRef<string | null>(null);
  const lastKey = useRef<string | null>(null);
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  // Mounting here (client only) keeps SSR and hydration free of editor access.
  useEffect(() => {
    if (!adapter || !enabled) {
      setOpen(false);
      setSelection(null);
      setRect(null);
      lastKey.current = null;
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const evaluate = () => {
      const next = adapter.getSelection();
      if (!next || next.text.trim().length < minChars) {
        lastKey.current = null;
        dismissedKey.current = null;
        setOpen(false);
        setSelection(null);
        setRect(null);
        return;
      }
      const measured = adapter.getRect(next);
      lastKey.current = next.key;
      setSelection(next);
      setRect(measured ? toDOMRect(measured) : null);
      setOpen(measured !== null && dismissedKey.current !== next.key);
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(evaluate, debounceMs);
    };

    const onScroll = () => {
      const current = adapter.getSelection();
      if (!current) return;
      const measured = adapter.getRect(current);
      setRect(measured ? toDOMRect(measured) : null);
      if (!measured) setOpen(false);
      else if (dismissedKey.current !== current.key) setOpen(true);
    };

    const unsubscribe = adapter.subscribe(schedule);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    evaluate();
    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [adapter, enabled, minChars, debounceMs]);

  const virtualElement = useMemo<SelectionVirtualElement | null>(() => {
    if (!open || !rect) return null;
    const root = adapter?.getRoot();
    return {
      getBoundingClientRect: () => rect,
      getClientRects: () => [rect],
      contextElement: root ?? undefined,
    };
  }, [open, rect, adapter]);

  const close = useCallback(() => {
    dismissedKey.current = lastKey.current;
    setOpen(false);
  }, []);

  const restoreSelection = useCallback(() => {
    const current = adapterRef.current;
    if (!current || !selection) return false;
    current.focus();
    return current.select(selection);
  }, [selection]);

  const replaceSelection = useCallback(
    (text: string) => {
      const current = adapterRef.current;
      if (!current || !selection) return false;
      return current.replace(selection, text);
    },
    [selection],
  );

  return {
    isOpen: open && virtualElement !== null,
    selectedText: selection?.text ?? "",
    virtualElement,
    close,
    restoreSelection,
    selection,
    replaceSelection,
  };
}
