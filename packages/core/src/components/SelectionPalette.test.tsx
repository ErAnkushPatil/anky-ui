// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELECTION_DEBOUNCE_MS } from "../dom/useSelectionAnchor";
import {
  DEFAULT_PALETTE_ACTIONS,
  SelectionPalette,
  StyledSelectionPalette,
  selectionPaletteTailwindPreset,
  type SelectionPaletteProps,
} from "./SelectionPalette";

type RectInit = { x: number; y: number; width: number; height: number };

function rect({ x, y, width, height }: RectInit): DOMRect {
  const r = { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  return { ...r, toJSON: () => r } as DOMRect;
}

let lineRects: DOMRect[] = [];
const originalGetClientRects = Range.prototype.getClientRects;
const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;

let editor: HTMLDivElement;
let editorRef: RefObject<HTMLDivElement | null>;

function textNode(): Text {
  return editor.querySelector("p")!.firstChild as Text;
}

function select(start: number, end: number, node: Node = textNode()) {
  act(() => {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

/** Lets the selection debounce elapse and floating-ui's async positioning resolve. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS);
  });
  await act(async () => {});
}

async function openOn(start = 4, end = 9) {
  select(start, end);
  await settle();
  return screen.getByRole("toolbar");
}

async function selectAndSettle(start: number, end: number, node?: Node) {
  select(start, end, node);
  await settle();
}

function renderPalette(props: Partial<SelectionPaletteProps> = {}, Component = SelectionPalette) {
  const onSelectPrompt = vi.fn();
  const utils = render(<Component onSelectPrompt={onSelectPrompt} containerRef={editorRef} {...props} />);
  return { ...utils, onSelectPrompt };
}

const queryPalette = () => screen.queryByRole("toolbar");
const getInput = () => document.querySelector<HTMLInputElement>(".anky-ui-palette-input")!;
const selectionText = () => document.getSelection()!.toString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  document.body.innerHTML = `
    <div id="editor" contenteditable="true"><p>The quick brown fox jumps over the lazy dog.</p></div>
    <p id="outside">Text outside the editor.</p>`;
  editor = document.getElementById("editor") as HTMLDivElement;
  editorRef = createRef<HTMLDivElement>();
  editorRef.current = editor;

  // jsdom has no layout: give the viewport a size and the selection a position.
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(768);
  lineRects = [rect({ x: 100, y: 200, width: 80, height: 18 })];
  Range.prototype.getClientRects = function () {
    return (this.collapsed ? [] : lineRects) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = () => rect({ x: 0, y: 0, width: 0, height: 0 });
});

afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
  Range.prototype.getClientRects = originalGetClientRects;
  Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SelectionPalette", () => {
  describe("anchoring", () => {
    it("renders nothing until a selection settles, then a portalled toolbar", async () => {
      renderPalette();
      expect(queryPalette()).toBeNull();

      select(4, 9);
      expect(queryPalette()).toBeNull();
      const palette = await openOn();

      expect(palette).toHaveProperty("className", "anky-ui-palette-root");
      expect(palette.getAttribute("aria-label")).toBe("AI actions");
      expect(palette.parentElement?.parentElement).toBe(document.body);
      expect(editor.contains(palette)).toBe(false);
    });

    it("positions the bar above the selection once measured", async () => {
      renderPalette();
      const palette = await openOn();
      // Selection is x 100–180, y 200; jsdom reports a 0×0 bar → centred at 140, 8px above.
      expect(palette.style.transform).toBe("translate(140px, 192px)");
      expect(palette.style.visibility).toBe("");
      expect(palette.dataset.placement).toBe("top");
    });

    it("flips below the selection when there is no room above", async () => {
      lineRects = [rect({ x: 100, y: 2, width: 80, height: 18 })];
      renderPalette();
      const palette = await openOn();
      expect(palette.dataset.placement).toBe("bottom");
      expect(palette.style.transform).toBe("translate(140px, 28px)");
    });

    it("honours placement and sideOffset", async () => {
      renderPalette({ placement: "bottom-start", sideOffset: 4 });
      const palette = await openOn();
      expect(palette.dataset.placement).toBe("bottom-start");
      expect(palette.style.transform).toBe("translate(100px, 222px)");
    });

    it("follows the selection when the editor that directly contains it scrolls", async () => {
      // Text directly inside the editor makes the editor itself the virtual element's contextElement,
      // which floating-ui's autoUpdate does not observe for scrolling on its own.
      editor.textContent = "The quick brown fox jumps over the lazy dog.";
      renderPalette();
      await selectAndSettle(4, 9, editor.firstChild!);
      const palette = screen.getByRole("toolbar");
      expect(palette.style.transform).toBe("translate(140px, 192px)");

      lineRects = [rect({ x: 100, y: 150, width: 80, height: 18 })];
      await act(async () => {
        editor.dispatchEvent(new Event("scroll"));
      });
      expect(palette.style.transform).toBe("translate(140px, 142px)");
    });

    it("forwards containerRef, minChars and enabled to the selection anchor", async () => {
      const { rerender, onSelectPrompt } = renderPalette({ minChars: 6 });
      await selectAndSettle(4, 9); // "quick" is 5 chars
      expect(queryPalette()).toBeNull();

      await selectAndSettle(0, 8, document.getElementById("outside")!.firstChild!);
      expect(queryPalette()).toBeNull();

      rerender(<SelectionPalette onSelectPrompt={onSelectPrompt} containerRef={editorRef} enabled={false} />);
      await selectAndSettle(4, 15);
      expect(queryPalette()).toBeNull();
    });
  });

  describe("preset actions", () => {
    it("renders the default pills", async () => {
      renderPalette();
      await openOn();
      const pills = screen.getAllByRole("button");
      expect(pills.map((p) => p.textContent)).toEqual(["Fix Grammar", "Shorten", "Translate"]);
      expect(pills.every((p) => p.className === "anky-ui-palette-action")).toBe(true);
    });

    it("renders custom actions with decorative icons, or none", async () => {
      const { rerender, onSelectPrompt } = renderPalette({
        actions: [{ label: "Explain", prompt: "Explain this", icon: <svg data-testid="icon" /> }],
      });
      await openOn();
      const pill = screen.getByRole("button", { name: "Explain" });
      const icon = screen.getByTestId("icon").parentElement!;
      expect(icon.className).toBe("anky-ui-palette-action-icon");
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(pill.contains(icon)).toBe(true);

      rerender(<SelectionPalette onSelectPrompt={onSelectPrompt} containerRef={editorRef} actions={[]} />);
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      expect(document.querySelector(".anky-ui-palette-actions")).toBeNull();
      expect(getInput()).not.toBeNull();
    });

    it("keeps the editor selection on mousedown and submits the prompt on click", async () => {
      const { onSelectPrompt } = renderPalette();
      await openOn();
      const pill = screen.getByRole("button", { name: "Shorten" });

      expect(fireEvent.mouseDown(pill)).toBe(false); // default prevented → no focus/selection steal
      fireEvent.click(pill);

      expect(onSelectPrompt).toHaveBeenCalledExactlyOnceWith(DEFAULT_PALETTE_ACTIONS[1].prompt, "quick");
      expect(queryPalette()).toBeNull();
      expect(selectionText()).toBe("quick");
    });

    it("stays open after a pick when closeOnSelect is false", async () => {
      const { onSelectPrompt } = renderPalette({ closeOnSelect: false });
      await openOn();
      fireEvent.click(screen.getByRole("button", { name: "Translate" }));
      expect(onSelectPrompt).toHaveBeenCalledOnce();
      expect(queryPalette()).not.toBeNull();
    });

    it("moves focus between items with arrow keys, Home and End", async () => {
      renderPalette();
      await openOn();
      const [grammar, shorten, translate] = screen.getAllByRole("button");
      act(() => grammar.focus());

      fireEvent.keyDown(grammar, { key: "ArrowRight" });
      expect(document.activeElement).toBe(shorten);
      fireEvent.keyDown(shorten, { key: "End" });
      expect(document.activeElement).toBe(getInput());
      fireEvent.keyDown(getInput(), { key: "Home" }); // the input keeps its own caret keys
      expect(document.activeElement).toBe(getInput());
      act(() => translate.focus());
      fireEvent.keyDown(translate, { key: "ArrowRight" });
      expect(document.activeElement).toBe(getInput());
      act(() => grammar.focus());
      fireEvent.keyDown(grammar, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(getInput());
    });
  });

  describe("custom prompt input", () => {
    async function focusInput() {
      const input = getInput();
      act(() => {
        input.focus();
        document.dispatchEvent(new Event("selectionchange"));
      });
      await settle();
      return input;
    }

    it("uses the placeholder as accessible name", async () => {
      renderPalette({ customInputPlaceholder: "Tell AI what to do" });
      await openOn();
      expect(screen.getByRole("textbox", { name: "Tell AI what to do" })).toBe(getInput());
      expect(getInput().placeholder).toBe("Tell AI what to do");
    });

    it("stays open while the input has focus", async () => {
      renderPalette();
      await openOn();
      await focusInput();
      expect(queryPalette()).not.toBeNull();
      expect(document.activeElement).toBe(getInput());
    });

    it("submits the trimmed prompt with the selected text on Enter and returns focus to the editor", async () => {
      const { onSelectPrompt } = renderPalette();
      await openOn();
      const input = await focusInput();
      fireEvent.change(input, { target: { value: "  make it formal  " } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onSelectPrompt).toHaveBeenCalledExactlyOnceWith("make it formal", "quick");
      expect(queryPalette()).toBeNull();
      expect(document.activeElement).toBe(editor);
      expect(selectionText()).toBe("quick");
    });

    it("ignores Enter for blank input and during IME composition", async () => {
      const { onSelectPrompt } = renderPalette();
      await openOn();
      const input = await focusInput();

      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.change(input, { target: { value: "日本語" } });
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });

      expect(onSelectPrompt).not.toHaveBeenCalled();
      expect(queryPalette()).not.toBeNull();
    });

    it("clears the draft when a different selection is made", async () => {
      renderPalette();
      await openOn();
      fireEvent.change(getInput(), { target: { value: "draft" } });
      await openOn(10, 15);
      expect(getInput().value).toBe("");
    });
  });

  describe("Escape", () => {
    it("closes from the input and restores focus and selection to the editor", async () => {
      renderPalette();
      await openOn();
      act(() => getInput().focus());
      fireEvent.keyDown(getInput(), { key: "Escape" });

      expect(queryPalette()).toBeNull();
      expect(document.activeElement).toBe(editor);
      expect(selectionText()).toBe("quick");
    });

    it("closes while focus is still in the editor and stays closed for that selection", async () => {
      renderPalette();
      await openOn();
      act(() => editor.focus());
      fireEvent.keyDown(editor, { key: "Escape" });
      expect(queryPalette()).toBeNull();
      expect(document.activeElement).toBe(editor);

      await selectAndSettle(4, 9);
      expect(queryPalette()).toBeNull();
      await openOn(10, 15);
    });

    it("moves focus out of the palette for read-only content", async () => {
      editor.removeAttribute("contenteditable");
      renderPalette();
      await openOn();
      act(() => getInput().focus());
      fireEvent.keyDown(getInput(), { key: "Escape" });

      expect(queryPalette()).toBeNull();
      expect(document.activeElement).toBe(document.body);
      expect(selectionText()).toBe("quick");
    });

    it("returns focus to the element focused before the palette opened", async () => {
      editor.removeAttribute("contenteditable");
      const trigger = document.createElement("button");
      document.body.append(trigger);
      act(() => trigger.focus());
      renderPalette();
      await openOn();
      act(() => getInput().focus());
      fireEvent.keyDown(getInput(), { key: "Escape" });
      expect(document.activeElement).toBe(trigger);
    });
  });

  describe("styling", () => {
    it("is unstyled by default and merges classNames after the semantic classes", async () => {
      renderPalette({
        classNames: { root: "r", actions: "g", action: "a", actionIcon: "i", input: "in" },
        actions: [{ label: "X", prompt: "x", icon: "★" }],
      });
      const palette = await openOn();
      expect(palette.className).toBe("anky-ui-palette-root r");
      expect(document.querySelector(".anky-ui-palette-actions")!.className).toBe("anky-ui-palette-actions g");
      expect(screen.getByRole("button").className).toBe("anky-ui-palette-action a");
      expect(document.querySelector(".anky-ui-palette-action-icon")!.className).toBe("anky-ui-palette-action-icon i");
      expect(getInput().className).toBe("anky-ui-palette-input in");
    });

    it("renders children inside the bar", async () => {
      renderPalette({ children: <span data-testid="extra">gpt</span> });
      const palette = await openOn();
      expect(palette.contains(screen.getByTestId("extra"))).toBe(true);
    });

    it("StyledSelectionPalette applies the Tailwind preset plus overrides", async () => {
      renderPalette({ classNames: { root: "ring-1" } }, StyledSelectionPalette);
      const palette = await openOn();
      expect(palette.className).toBe(`anky-ui-palette-root ${selectionPaletteTailwindPreset.root} ring-1`);
      expect(getInput().className).toBe(`anky-ui-palette-input ${selectionPaletteTailwindPreset.input}`);
      expect(screen.getAllByRole("button")[0].className).toBe(
        `anky-ui-palette-action ${selectionPaletteTailwindPreset.action}`,
      );
    });
  });
});
