// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionPalette } from "../components/SelectionPalette";
import { createLexicalAdapter, type LexicalEditorLike, type LexicalHelpers } from "./lexical";
import { createProseMirrorAdapter, type ProseMirrorViewLike } from "./prosemirror";
import { createTiptapAdapter, type TiptapEditorLike } from "./tiptap";
import type { EditorAdapter, EditorSelection } from "./editorAdapter";
import { useEditorAnchor } from "./useEditorAnchor";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A flat-text fake of a ProseMirror view: positions are character offsets + 1. */
function fakePmView(text: string) {
  const state = {
    text,
    selection: { from: 1, to: 1, empty: true },
    doc: {
      content: { size: text.length + 2 },
      textBetween: (from: number, to: number) => state.text.slice(from - 1, to - 1),
    },
    tr: {
      ops: [] as Array<[string, number, number]>,
      insertText(value: string, from?: number, to?: number) {
        this.ops.push([value, from ?? 0, to ?? 0]);
        return this;
      },
    },
  };
  const dom = document.createElement("div");
  document.body.appendChild(dom);
  const view = {
    dom,
    state,
    coordsAtPos: (pos: number) => ({ left: pos * 10, right: pos * 10 + 10, top: 100, bottom: 120 }),
    dispatch: vi.fn(),
    focus: vi.fn(),
  };
  return view satisfies Partial<ProseMirrorViewLike> as unknown as ProseMirrorViewLike & typeof view;
}

describe("createProseMirrorAdapter", () => {
  it("returns null for collapsed selections and text + rect for ranges", () => {
    const view = fakePmView("Hello world");
    const adapter = createProseMirrorAdapter(view);
    expect(adapter.getSelection()).toBeNull();

    (view.state.selection as { from: number; to: number; empty: boolean }) = { from: 1, to: 6, empty: false };
    const sel = adapter.getSelection()!;
    expect(sel).toMatchObject({ text: "Hello", from: 1, to: 6, key: "1:6" });
    expect(adapter.getRect(sel)).toEqual({ left: 10, right: 70, top: 100, bottom: 120 });
  });

  it("replaces only while the document text is unchanged", () => {
    const view = fakePmView("Hello world");
    const adapter = createProseMirrorAdapter(view);
    const sel = { from: 1, to: 6, text: "Hello", key: "1:6" };
    expect(adapter.replace(sel, "Howdy")).toBe(true);
    expect(view.state.tr.ops).toEqual([["Howdy", 1, 6]]);
    expect(view.dispatch).toHaveBeenCalledTimes(1);

    view.state.text = "Jello world";
    expect(adapter.replace(sel, "Hi")).toBe(false);
    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

  it("returns null rect when coordinates cannot be resolved", () => {
    const view = fakePmView("abc");
    view.coordsAtPos = () => {
      throw new RangeError("no pos");
    };
    expect(createProseMirrorAdapter(view).getRect({ from: 1, to: 3, text: "ab", key: "1:3" })).toBeNull();
  });

  it("select() needs a setSelection callback and validates bounds", () => {
    const view = fakePmView("abc");
    const sel = { from: 1, to: 3, text: "ab", key: "1:3" };
    expect(createProseMirrorAdapter(view).select(sel)).toBe(false);
    const setSelection = vi.fn();
    const adapter = createProseMirrorAdapter(view, { setSelection });
    expect(adapter.select(sel)).toBe(true);
    expect(setSelection).toHaveBeenCalledWith(view, 1, 3);
    expect(adapter.select({ ...sel, to: 99 })).toBe(false);
  });

  it("subscribes to selectionchange and unsubscribes cleanly", () => {
    const adapter = createProseMirrorAdapter(fakePmView("abc"));
    const listener = vi.fn();
    const off = adapter.subscribe(listener);
    document.dispatchEvent(new Event("selectionchange"));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    document.dispatchEvent(new Event("selectionchange"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("createTiptapAdapter", () => {
  function fakeEditor() {
    const view = fakePmView("Hello world");
    (view.state.selection as { from: number; to: number; empty: boolean }) = { from: 1, to: 6, empty: false };
    const handlers = new Map<string, Set<() => void>>();
    const commands = {
      insertContentAt: vi.fn(() => true),
      setTextSelection: vi.fn(() => true),
      focus: vi.fn(() => true),
    };
    const editor: TiptapEditorLike = {
      view,
      commands,
      on: (event, handler) => {
        (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(handler);
      },
      off: (event, handler) => {
        handlers.get(event)?.delete(handler);
      },
    };
    return { editor, commands, handlers, view };
  }

  it("uses Tiptap commands so edits stay undoable", () => {
    const { editor, commands } = fakeEditor();
    const adapter = createTiptapAdapter(editor);
    const sel = adapter.getSelection()!;
    expect(adapter.name).toBe("tiptap");
    expect(adapter.replace(sel, "Howdy")).toBe(true);
    expect(commands.insertContentAt).toHaveBeenCalledWith({ from: 1, to: 6 }, "Howdy");
    expect(adapter.select(sel)).toBe(true);
    expect(commands.setTextSelection).toHaveBeenCalledWith({ from: 1, to: 6 });
    adapter.focus();
    expect(commands.focus).toHaveBeenCalledWith(null, { scrollIntoView: false });
  });

  it("refuses to replace stale text", () => {
    const { editor, commands, view } = fakeEditor();
    const adapter = createTiptapAdapter(editor);
    const sel = adapter.getSelection()!;
    view.state.text = "Yellow world";
    expect(adapter.replace(sel, "x")).toBe(false);
    expect(commands.insertContentAt).not.toHaveBeenCalled();
  });

  it("subscribes to editor events and detaches", () => {
    const { editor, handlers } = fakeEditor();
    const adapter = createTiptapAdapter(editor);
    const listener = vi.fn();
    const off = adapter.subscribe(listener);
    expect([...handlers.keys()].sort()).toEqual(["blur", "selectionUpdate", "update"]);
    off();
    expect([...handlers.values()].every((set) => set.size === 0)).toBe(true);
  });
});

describe("createLexicalAdapter", () => {
  /** Tiny fake: one text node "n1" holding `text`, with a settable range. */
  function fakeLexical(initial: string) {
    const model = { text: initial, range: null as null | { a: number; f: number } };
    let current: ReturnType<typeof makeSelection> | null = null;

    function makeSelection(a: number, f: number) {
      const point = (offset: number) => ({
        key: "n1",
        offset,
        type: "text" as const,
        set(_key: string, o: number) {
          this.offset = o;
        },
      });
      const sel = {
        anchor: point(a),
        focus: point(f),
        isCollapsed: () => sel.anchor.offset === sel.focus.offset,
        getTextContent: () => model.text.slice(Math.min(sel.anchor.offset, sel.focus.offset), Math.max(sel.anchor.offset, sel.focus.offset)),
        insertText: (t: string) => {
          model.text = model.text.slice(0, Math.min(sel.anchor.offset, sel.focus.offset)) + t + model.text.slice(Math.max(sel.anchor.offset, sel.focus.offset));
        },
      };
      return sel;
    }

    const listeners = new Set<() => void>();
    const root = document.createElement("div");
    root.tabIndex = 0;
    document.body.appendChild(root);
    const editor: LexicalEditorLike = {
      getRootElement: () => root,
      focus: vi.fn(),
      getEditorState: () => ({ read: (fn) => fn() }),
      update: (fn) => fn(),
      registerUpdateListener: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const helpers: LexicalHelpers = {
      $getSelection: () => current,
      $isRangeSelection: (s): s is ReturnType<typeof makeSelection> => s !== null && typeof s === "object",
      $createRangeSelection: () => makeSelection(0, 0),
      $setSelection: (s) => {
        current = s as ReturnType<typeof makeSelection> | null;
      },
    };
    return {
      editor,
      helpers,
      model,
      listeners,
      select(a: number, f: number) {
        current = makeSelection(a, f);
      },
    };
  }

  it("reads the Lexical selection with a position-based key", () => {
    const f = fakeLexical("Hello world");
    const adapter = createLexicalAdapter(f.editor, f.helpers);
    expect(adapter.getSelection()).toBeNull();
    f.select(0, 5);
    expect(adapter.getSelection()).toMatchObject({ text: "Hello", key: "n1:0:n1:5" });
  });

  it("replaces inside editor.update and verifies the text", () => {
    const f = fakeLexical("Hello world");
    const adapter = createLexicalAdapter(f.editor, f.helpers);
    f.select(0, 5);
    const sel = adapter.getSelection()!;
    expect(adapter.replace(sel, "Howdy")).toBe(true);
    expect(f.model.text).toBe("Howdy world");
    expect(adapter.replace(sel, "again")).toBe(false); // text at the range is now "Howdy"... but sel.text was "Hello"
    expect(f.model.text).toBe("Howdy world");
  });

  it("select() restores a range and registers update listeners", () => {
    const f = fakeLexical("Hello world");
    const adapter = createLexicalAdapter(f.editor, f.helpers);
    const sel = { text: "world", key: "n1:6:n1:11", anchor: { key: "n1", offset: 6, type: "text" as const }, focus: { key: "n1", offset: 11, type: "text" as const } };
    expect(adapter.select(sel)).toBe(true);
    expect(adapter.getSelection()?.text).toBe("world");
    const off = adapter.subscribe(() => undefined);
    expect(f.listeners.size).toBe(1);
    off();
    expect(f.listeners.size).toBe(0);
  });
});

describe("useEditorAnchor", () => {
  function fakeAdapter() {
    let selection: (EditorSelection & { id: number }) | null = null;
    let rect: { left: number; right: number; top: number; bottom: number } | null = { left: 10, right: 60, top: 20, bottom: 40 };
    const listeners = new Set<() => void>();
    const adapter: EditorAdapter<EditorSelection & { id: number }> = {
      name: "prosemirror",
      getSelection: () => selection,
      getRect: () => rect,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      replace: vi.fn(() => true),
      select: vi.fn(() => true),
      focus: vi.fn(),
      getRoot: () => document.body,
    };
    return {
      adapter,
      listeners,
      setSelection(text: string | null, key = "k1") {
        selection = text === null ? null : { text, key, id: 1 };
      },
      setRect(next: typeof rect) {
        rect = next;
      },
      fire() {
        listeners.forEach((l) => l());
      },
    };
  }

  beforeEach(() => vi.useFakeTimers());

  it("debounces by 100ms before opening", () => {
    const f = fakeAdapter();
    const { result } = renderHook(() => useEditorAnchor(f.adapter));
    expect(result.current.isOpen).toBe(false);
    f.setSelection("hello");
    f.fire();
    act(() => void vi.advanceTimersByTime(99));
    expect(result.current.isOpen).toBe(false);
    act(() => void vi.advanceTimersByTime(2));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.selectedText).toBe("hello");
    expect(result.current.virtualElement?.getBoundingClientRect().left).toBe(10);
  });

  it("ignores selections shorter than minChars and closes when collapsed", () => {
    const f = fakeAdapter();
    const { result } = renderHook(() => useEditorAnchor(f.adapter, { minChars: 3 }));
    f.setSelection("hi");
    f.fire();
    act(() => void vi.advanceTimersByTime(150));
    expect(result.current.isOpen).toBe(false);
    f.setSelection("hello");
    f.fire();
    act(() => void vi.advanceTimersByTime(150));
    expect(result.current.isOpen).toBe(true);
    f.setSelection(null);
    f.fire();
    act(() => void vi.advanceTimersByTime(150));
    expect(result.current.isOpen).toBe(false);
  });

  it("stays closed after close() until the selection changes", () => {
    const f = fakeAdapter();
    const { result } = renderHook(() => useEditorAnchor(f.adapter));
    f.setSelection("hello");
    f.fire();
    act(() => void vi.advanceTimersByTime(150));
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    f.fire();
    act(() => void vi.advanceTimersByTime(150));
    expect(result.current.isOpen).toBe(false);
    f.setSelection("hello!", "k2");
    f.fire();
    act(() => void vi.advanceTimersByTime(150));
    expect(result.current.isOpen).toBe(true);
  });

  it("hides when the selection cannot be measured (scrolled out of view)", () => {
    const f = fakeAdapter();
    const { result } = renderHook(() => useEditorAnchor(f.adapter));
    f.setSelection("hello");
    f.fire();
    act(() => void vi.advanceTimersByTime(150));
    expect(result.current.isOpen).toBe(true);
    f.setRect(null);
    act(() => void window.dispatchEvent(new Event("scroll")));
    expect(result.current.isOpen).toBe(false);
  });

  it("restores focus + selection and replaces through the adapter; detaches on unmount", () => {
    const f = fakeAdapter();
    const { result, unmount } = renderHook(() => useEditorAnchor(f.adapter));
    f.setSelection("hello");
    f.fire();
    act(() => void vi.advanceTimersByTime(150));
    expect(result.current.restoreSelection()).toBe(true);
    expect(f.adapter.focus).toHaveBeenCalled();
    expect(result.current.replaceSelection("bye")).toBe(true);
    expect(f.adapter.replace).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }), "bye");
    unmount();
    expect(f.listeners.size).toBe(0);
  });

  it("stays inert without an adapter", () => {
    const { result } = renderHook(() => useEditorAnchor(null));
    expect(result.current.isOpen).toBe(false);
    expect(result.current.restoreSelection()).toBe(false);
    expect(result.current.replaceSelection("x")).toBe(false);
  });
});

describe("SelectionPalette with anchor", () => {
  it("renders from an external anchor and exposes a11y semantics", () => {
    const anchor = {
      isOpen: true,
      selectedText: "Hello",
      virtualElement: {
        getBoundingClientRect: () => ({ x: 10, y: 10, left: 10, top: 10, right: 60, bottom: 30, width: 50, height: 20, toJSON: () => ({}) }) as DOMRect,
        getClientRects: () => [],
      },
      close: vi.fn(),
      restoreSelection: vi.fn(() => true),
    };
    const onSelectPrompt = vi.fn();
    render(<SelectionPalette anchor={anchor} onSelectPrompt={onSelectPrompt} actions={[{ label: "Shorten", prompt: "Shorten it" }]} />);
    const toolbar = document.querySelector('[role="toolbar"]')!;
    expect(toolbar.getAttribute("aria-label")).toBe("AI actions");
    expect(toolbar.getAttribute("aria-keyshortcuts")).toBe("Alt+/");
    act(() => void screen.getByText("Shorten", { selector: "button" }).click());
    expect(onSelectPrompt).toHaveBeenCalledWith("Shorten it", "Hello");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("AI actions available");
  });
});
