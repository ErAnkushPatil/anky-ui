import { createProseMirrorAdapter, type ProseMirrorViewLike } from "./prosemirror";
import type { EditorAdapter } from "./editorAdapter";
import type { ProseMirrorSelection } from "./prosemirror";

/** Subset of a Tiptap `Editor` used by the adapter (structurally compatible with the real one). */
export interface TiptapEditorLike {
  readonly view: ProseMirrorViewLike;
  readonly isDestroyed?: boolean;
  on(event: "selectionUpdate" | "update" | "blur", handler: () => void): unknown;
  off(event: "selectionUpdate" | "update" | "blur", handler: () => void): unknown;
  readonly commands: {
    insertContentAt(range: { from: number; to: number }, content: string): boolean;
    setTextSelection(range: { from: number; to: number }): boolean;
    focus(position?: "start" | "end" | "all" | number | boolean | null, options?: { scrollIntoView?: boolean }): boolean;
  };
}

/**
 * Adapter for a Tiptap `Editor` (any version exposing `view`, `on`/`off` and `commands`).
 *
 * Uses Tiptap's `selectionUpdate` and `update` events and its `commands` so history, collaboration and
 * input rules behave as they do for normal edits: an accepted AI edit is one undoable step.
 *
 * @example
 * const editor = useEditor({ extensions: [StarterKit] });
 * const adapter = useMemo(() => editor && createTiptapAdapter(editor), [editor]);
 */
export function createTiptapAdapter(editor: TiptapEditorLike): EditorAdapter<ProseMirrorSelection> {
  const base = createProseMirrorAdapter(editor.view, {
    setSelection: (_view, from, to) => {
      editor.commands.setTextSelection({ from, to });
    },
  });

  return {
    ...base,
    name: "tiptap",
    subscribe(listener) {
      editor.on("selectionUpdate", listener);
      editor.on("update", listener);
      editor.on("blur", listener);
      return () => {
        if (editor.isDestroyed) return;
        editor.off("selectionUpdate", listener);
        editor.off("update", listener);
        editor.off("blur", listener);
      };
    },
    replace(selection, text) {
      const { from, to } = selection;
      const doc = editor.view.state.doc;
      if (from < 0 || to > doc.content.size || from >= to || doc.textBetween(from, to, "\n", " ") !== selection.text) {
        return false;
      }
      return editor.commands.insertContentAt({ from, to }, text);
    },
    focus() {
      editor.commands.focus(null, { scrollIntoView: false });
    },
  };
}
