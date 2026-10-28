// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SELECTION_DEBOUNCE_MS,
  captureSelectionSnapshot,
  resolveSelectionSnapshot,
  useSelectionAnchor,
  type UseSelectionAnchorOptions,
} from "./useSelectionAnchor";

type RectInit = { x: number; y: number; width: number; height: number };

function rect({ x, y, width, height }: RectInit): DOMRect {
  const r = { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  return { ...r, toJSON: () => r } as DOMRect;
}

/** jsdom has no layout: every Range reports these client rects. */
let lineRects: DOMRect[] = [];
const originalGetClientRects = Range.prototype.getClientRects;
const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;

let container: HTMLDivElement;
let outside: HTMLParagraphElement;

function textNode(el: Element = container.querySelector("p")!): Text {
  return el.firstChild as Text;
}

function select(node: Node, start: number, end: number, endNode: Node = node) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(endNode, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function clearSelection() {
  document.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
}

function settle(ms = SELECTION_DEBOUNCE_MS) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function scroll(target: EventTarget = document) {
  act(() => {
    target.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(20);
  });
}

function pointer(type: "mousedown" | "mouseup", target: EventTarget = container) {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
  });
}

/** jsdom has no `Touch` constructor; `touches` lists the fingers still down after the event. */
function touch(type: "touchstart" | "touchend" | "touchcancel", touches = type === "touchstart" ? 1 : 0, target: EventTarget = container) {
  act(() => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "touches", { value: Array.from({ length: touches }) });
    target.dispatchEvent(event);
  });
}

function setup(options: UseSelectionAnchorOptions = {}) {
  return renderHook((props: UseSelectionAnchorOptions) => useSelectionAnchor(props), {
    initialProps: { containerRef: { current: container }, ...options },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date"] });
  document.body.innerHTML = `
    <div id="container"><p>The quick brown fox jumps over the lazy dog.</p><p>Second paragraph here.</p></div>
    <p id="outside">Text outside the container.</p>
    <textarea id="field">editable</textarea>`;
  container = document.getElementById("container") as HTMLDivElement;
  outside = document.getElementById("outside") as HTMLParagraphElement;
  lineRects = [rect({ x: 100, y: 200, width: 80, height: 18 })];
  Range.prototype.getClientRects = function () {
    return (this.collapsed ? [] : lineRects) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = () => rect({ x: 0, y: 0, width: 0, height: 0 });
});

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  Range.prototype.getClientRects = originalGetClientRects;
  Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  vi.useRealTimers();
});

describe("useSelectionAnchor", () => {
  describe("debounced selection tracking", () => {
    it("opens 100ms after the last selectionchange", () => {
      const { result } = setup();
      act(() => select(textNode(), 4, 9));
      settle(SELECTION_DEBOUNCE_MS - 1);
      expect(result.current.isOpen).toBe(false);

      // Further changes restart the debounce window.
      act(() => select(textNode(), 4, 15));
      settle(SELECTION_DEBOUNCE_MS - 1);
      expect(result.current.isOpen).toBe(false);
      settle(1);

      expect(result.current).toMatchObject({ isOpen: true, selectedText: "quick brown" });
      expect(result.current.virtualElement).not.toBeNull();
    });

    it("does not open while the pointer is held down, then opens on release", () => {
      const { result } = setup();
      pointer("mousedown");
      for (const end of [6, 9, 12, 15]) {
        act(() => select(textNode(), 4, end));
        settle(150);
      }
      expect(result.current.isOpen).toBe(false);

      pointer("mouseup");
      expect(result.current.isOpen).toBe(false);
      settle();
      expect(result.current).toMatchObject({ isOpen: true, selectedText: "quick brown" });
    });

    it("hides a stale anchor when a new drag starts", () => {
      const { result } = setup();
      act(() => select(textNode(), 4, 9));
      settle();
      expect(result.current.isOpen).toBe(true);

      pointer("mousedown");
      act(() => select(textNode(), 10, 12));
      settle();
      expect(result.current).toMatchObject({ isOpen: false, virtualElement: null });
    });

    it("ignores collapsed, whitespace-only and too-short selections", () => {
      const { result } = setup({ minChars: 5 });
      act(() => select(textNode(), 4, 4));
      settle();
      expect(result.current.isOpen).toBe(false);

      act(() => select(textNode(), 3, 4)); // " "
      settle();
      expect(result.current.isOpen).toBe(false);

      act(() => select(textNode(), 4, 8)); // "quic"
      settle();
      expect(result.current.isOpen).toBe(false);

      act(() => select(textNode(), 4, 9)); // "quick"
      settle();
      expect(result.current.isOpen).toBe(true);
    });

    it("closes when the selection collapses", () => {
      const { result } = setup();
      act(() => select(textNode(), 4, 9));
      settle();
      act(() => clearSelection());
      settle();
      expect(result.current).toEqual(expect.objectContaining({ isOpen: false, selectedText: "", virtualElement: null }));
    });

    it("ignores selections outside the container", () => {
      const { result } = setup();
      act(() => select(textNode(outside), 0, 4));
      settle();
      expect(result.current.isOpen).toBe(false);
    });

    it("tracks selections spanning several elements", () => {
      const [first, second] = container.querySelectorAll("p");
      const { result } = setup();
      act(() => select(textNode(first), 40, 6, textNode(second)));
      settle();
      expect(result.current.isOpen).toBe(true);
      expect(result.current.selectedText).toBe("dog.Second");
    });

    it("closes when focus moves into a text field", () => {
      const { result } = setup();
      act(() => select(textNode(), 4, 9));
      settle();
      act(() => {
        (document.getElementById("field") as HTMLTextAreaElement).focus();
        document.dispatchEvent(new Event("selectionchange"));
      });
      settle();
      expect(result.current.isOpen).toBe(false);
    });

    it("stays open while interacting with the floating element", () => {
      const floating = document.createElement("div");
      floating.innerHTML = "<input type='text' />";
      document.body.append(floating);
      const { result } = setup({ floatingRef: { current: floating } });
      act(() => select(textNode(), 4, 9));
      settle();

      pointer("mousedown", floating);
      act(() => {
        floating.querySelector("input")!.focus();
        clearSelection();
      });
      settle();
      pointer("mouseup", floating);
      settle();
      expect(result.current).toMatchObject({ isOpen: true, selectedText: "quick" });
    });
  });

  describe("touch devices", () => {
    it("does not open while a finger adjusts the selection, then opens after touchend", () => {
      const { result } = setup();
      touch("touchstart");
      for (const end of [6, 9, 15]) {
        act(() => select(textNode(), 4, end));
        settle(150);
      }
      expect(result.current.isOpen).toBe(false);

      touch("touchend");
      settle();
      expect(result.current).toMatchObject({ isOpen: true, selectedText: "quick brown" });
    });

    it("treats touchcancel (long-press handed to the browser) as a release", () => {
      const { result } = setup();
      touch("touchstart");
      act(() => select(textNode(), 4, 9));
      settle();
      expect(result.current.isOpen).toBe(false);
      touch("touchcancel");
      settle();
      expect(result.current.isOpen).toBe(true);
    });

    it("ignores the emulated mouse events that follow a tap", () => {
      const { result } = setup();
      touch("touchstart");
      act(() => select(textNode(), 4, 9));
      touch("touchend");
      // Compat events arrive after touchend. A stuck mousedown would keep the anchor closed.
      pointer("mousedown");
      settle();
      expect(result.current).toMatchObject({ isOpen: true, selectedText: "quick" });
      pointer("mouseup");
      settle();
      expect(result.current.isOpen).toBe(true);
    });

    it("evaluates once per gesture when both touchend and mouseup are delivered", () => {
      const renders = vi.fn();
      const { result } = renderHook(() => {
        const anchor = useSelectionAnchor({ containerRef: { current: container } });
        renders(anchor.isOpen);
        return anchor;
      });
      touch("touchstart");
      act(() => select(textNode(), 4, 9));
      touch("touchend");
      pointer("mousedown");
      pointer("mouseup");
      settle();
      expect(result.current.isOpen).toBe(true);
      // Initial closed render, then exactly one transition to open.
      expect(renders.mock.calls.map(([open]) => open)).toEqual([false, true]);
    });

    it("waits for the last finger to lift", () => {
      const { result } = setup();
      touch("touchstart", 1);
      touch("touchstart", 2);
      act(() => select(textNode(), 4, 9));
      touch("touchend", 1);
      settle();
      expect(result.current.isOpen).toBe(false);
      touch("touchend", 0);
      settle();
      expect(result.current.isOpen).toBe(true);
    });

    it("accepts real mouse input again once the touch guard window has passed", () => {
      const { result } = setup();
      touch("touchstart");
      touch("touchend");
      settle(1000);
      pointer("mousedown");
      act(() => select(textNode(), 4, 9));
      settle();
      expect(result.current.isOpen).toBe(false);
      pointer("mouseup");
      settle();
      expect(result.current.isOpen).toBe(true);
    });

    it("ignores touches that start inside the floating element", () => {
      const floating = document.createElement("div");
      document.body.append(floating);
      const { result } = setup({ floatingRef: { current: floating } });
      act(() => select(textNode(), 4, 9));
      settle();
      touch("touchstart", 1, floating);
      act(() => select(textNode(), 4, 15));
      settle();
      expect(result.current).toMatchObject({ isOpen: true, selectedText: "quick brown" });
    });

    it("releases a held press when the window loses focus", () => {
      const { result } = setup();
      touch("touchstart");
      act(() => select(textNode(), 4, 9));
      settle();
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      settle();
      expect(result.current.isOpen).toBe(true);
    });
  });

  describe("virtual element", () => {
    it("measures the union of non-empty line boxes and exposes a context element", () => {
      lineRects = [
        rect({ x: 120, y: 200, width: 200, height: 18 }),
        rect({ x: 40, y: 218, width: 150, height: 18 }),
        rect({ x: 40, y: 236, width: 0, height: 18 }), // trailing line break from a triple-click
      ];
      const { result } = setup();
      act(() => select(textNode(), 4, 30));
      settle();

      const ve = result.current.virtualElement!;
      expect(ve.getBoundingClientRect()).toMatchObject({ left: 40, top: 200, right: 320, bottom: 236 });
      expect(ve.getClientRects()).toHaveLength(2);
      expect(ve.contextElement).toBe(container.querySelector("p"));
    });

    it("measures live and keeps the last good rect when the range becomes unmeasurable", () => {
      const { result } = setup();
      act(() => select(textNode(), 4, 9));
      settle();
      const ve = result.current.virtualElement!;

      lineRects = [rect({ x: 100, y: 50, width: 80, height: 18 })];
      expect(ve.getBoundingClientRect().top).toBe(50);

      lineRects = [];
      expect(ve.getBoundingClientRect()).toMatchObject({ top: 50, width: 80 });
    });
  });

  describe("scrolling", () => {
    it("auto-hides when scrolled out of the viewport and reopens when back", () => {
      const { result } = setup();
      act(() => select(textNode(), 4, 9));
      settle();

      lineRects = [rect({ x: 100, y: -40, width: 80, height: 18 })];
      scroll();
      expect(result.current.isOpen).toBe(false);
      expect(result.current.selectedText).toBe("quick");

      lineRects = [rect({ x: 100, y: 300, width: 80, height: 18 })];
      scroll();
      expect(result.current.isOpen).toBe(true);
    });

    it("hides when clipped by an overflow ancestor", () => {
      container.style.overflowY = "auto";
      container.getBoundingClientRect = () => rect({ x: 0, y: 100, width: 500, height: 200 });
      const { result } = setup();
      act(() => select(textNode(), 4, 9));
      settle();
      expect(result.current.isOpen).toBe(true);

      lineRects = [rect({ x: 100, y: 320, width: 80, height: 18 })]; // inside viewport, below the scroller
      scroll(container);
      expect(result.current.isOpen).toBe(false);
    });

    it("re-checks at most once per animation frame", () => {
      const spy = vi.fn(() => lineRects as unknown as DOMRectList);
      Range.prototype.getClientRects = spy;
      setup();
      act(() => select(textNode(), 4, 9));
      settle();
      spy.mockClear();

      act(() => {
        for (let i = 0; i < 10; i++) document.dispatchEvent(new Event("scroll"));
        window.dispatchEvent(new Event("resize"));
        vi.advanceTimersByTime(20);
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("drops the anchor when the selected content is removed", () => {
      const { result } = setup();
      act(() => select(textNode(), 4, 9));
      settle();
      act(() => container.querySelector("p")!.remove());
      scroll();
      expect(result.current).toMatchObject({ isOpen: false, virtualElement: null });
    });
  });

  describe("close()", () => {
    it("hides until a different selection is made", () => {
      const { result } = setup();
      act(() => select(textNode(), 4, 9));
      settle();
      act(() => result.current.close());
      expect(result.current).toMatchObject({ isOpen: false, selectedText: "quick" });

      scroll();
      act(() => select(textNode(), 4, 9));
      settle();
      expect(result.current.isOpen).toBe(false);

      act(() => select(textNode(), 10, 15));
      settle();
      expect(result.current).toMatchObject({ isOpen: true, selectedText: "brown" });
    });
  });

  describe("restoreSelection()", () => {
    function currentSelection() {
      return document.getSelection()!.toString();
    }

    it("re-selects the original nodes and offsets", () => {
      const { result } = setup();
      act(() => select(textNode(), 4, 9));
      settle();
      act(() => clearSelection());
      settle();

      let restored = false;
      act(() => {
        restored = result.current.restoreSelection();
      });
      expect(restored).toBe(true);
      const range = document.getSelection()!.getRangeAt(0);
      expect(range.startContainer).toBe(textNode());
      expect([range.startOffset, range.endOffset]).toEqual([4, 9]);
      expect(currentSelection()).toBe("quick");
    });

    it("does not change isOpen", () => {
      const { result } = setup();
      act(() => select(textNode(), 4, 9));
      settle();
      act(() => result.current.close());
      act(() => {
        result.current.restoreSelection();
      });
      settle();
      expect(result.current.isOpen).toBe(false);
      expect(result.current.selectedText).toBe("quick");
    });

    it("falls back to character offsets when the text nodes were re-rendered", () => {
      const { result } = setup();
      act(() => select(textNode(), 10, 19));
      settle();

      // Simulate a framework re-render that replaces the nodes and splits the text.
      act(() => {
        container.querySelector("p")!.innerHTML = "The quick <em>brown</em> fox jumps over the lazy dog.";
      });
      act(() => {
        expect(result.current.restoreSelection()).toBe(true);
      });
      expect(currentSelection()).toBe("brown fox");
      expect(document.getSelection()!.getRangeAt(0).startContainer.parentElement?.tagName).toBe("EM");
    });

    it("finds the nearest occurrence when the text shifted", () => {
      const { result } = setup();
      act(() => select(textNode(), 10, 15));
      settle();
      act(() => {
        // Originally at 10; now at 14 and 39 — the closer one wins.
        container.querySelector("p")!.textContent = "Hi. The quick brown fox jumps over the brown dog.";
      });
      act(() => {
        expect(result.current.restoreSelection()).toBe(true);
      });
      const range = document.getSelection()!.getRangeAt(0);
      expect(currentSelection()).toBe("brown");
      expect(range.startOffset).toBe(14);
    });

    it("returns false when the text no longer exists or nothing was captured", () => {
      const { result } = setup();
      expect(result.current.restoreSelection()).toBe(false);

      act(() => select(textNode(), 4, 9));
      settle();
      act(() => {
        container.querySelector("p")!.textContent = "Completely rewritten.";
      });
      expect(result.current.restoreSelection()).toBe(false);
    });

    it("focuses the contenteditable host before selecting", () => {
      container.setAttribute("contenteditable", "true");
      const { result } = setup();
      act(() => select(textNode(), 4, 9));
      settle();
      act(() => (document.getElementById("field") as HTMLTextAreaElement).focus());
      act(() => {
        result.current.restoreSelection();
      });
      expect(document.activeElement).toBe(container);
      expect(currentSelection()).toBe("quick");
    });
  });

  describe("lifecycle", () => {
    it("does nothing while disabled and resets when disabled", () => {
      const { result, rerender } = setup({ enabled: false });
      act(() => select(textNode(), 4, 9));
      settle();
      expect(result.current.isOpen).toBe(false);

      rerender({ containerRef: { current: container }, enabled: true });
      act(() => select(textNode(), 4, 10));
      settle();
      expect(result.current.isOpen).toBe(true);

      rerender({ containerRef: { current: container }, enabled: false });
      expect(result.current).toMatchObject({ isOpen: false, virtualElement: null });
    });

    it("reads the latest minChars without re-subscribing", () => {
      const { result, rerender } = setup({ minChars: 10 });
      rerender({ containerRef: { current: container }, minChars: 3 });
      act(() => select(textNode(), 4, 9));
      settle();
      expect(result.current.isOpen).toBe(true);
    });

    it("clears pending timers and listeners on unmount", () => {
      const added = vi.spyOn(document, "addEventListener");
      const removed = vi.spyOn(document, "removeEventListener");
      const measure = vi.spyOn(Range.prototype, "getClientRects");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { unmount } = setup();
      act(() => select(textNode(), 4, 9));
      unmount();

      const types = (spy: typeof added) => spy.mock.calls.map(([type]) => type).sort();
      expect(types(removed)).toEqual(types(added));
      measure.mockClear();
      document.dispatchEvent(new Event("selectionchange"));
      document.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS * 2);
      expect(measure).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    });

    it("keeps action identities stable", () => {
      const { result } = setup();
      const { close, restoreSelection } = result.current;
      act(() => select(textNode(), 4, 9));
      settle();
      expect(result.current.close).toBe(close);
      expect(result.current.restoreSelection).toBe(restoreSelection);
    });
  });
});

describe("selection snapshots", () => {
  it("records node offsets and root-relative character offsets", () => {
    const [, second] = container.querySelectorAll("p");
    const range = document.createRange();
    range.setStart(textNode(second), 7);
    range.setEnd(textNode(second), 16);
    const snapshot = captureSelectionSnapshot(range, container);
    expect(snapshot).toMatchObject({ text: "paragraph", startOffset: 7, endOffset: 16, start: 51, end: 60 });
    expect(resolveSelectionSnapshot(snapshot)?.toString()).toBe("paragraph");
  });
});
