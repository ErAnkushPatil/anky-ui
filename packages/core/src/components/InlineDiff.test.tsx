// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InlineDiff,
  StyledInlineDiff,
  inlineDiffTailwindPreset,
  toRenderSegments,
  type InlineDiffProps,
} from "./InlineDiff";

function renderDiff(props: Partial<InlineDiffProps> = {}) {
  const onAccept = vi.fn();
  const onReject = vi.fn();
  const utils = render(
    <p data-testid="host">
      Before{" "}
      <InlineDiff
        originalText="The quick brown fox"
        modifiedText="The swift brown fox"
        onAccept={onAccept}
        onReject={onReject}
        {...props}
      />{" "}
      after.
    </p>,
  );
  const rerender = (next: Partial<InlineDiffProps>) =>
    utils.rerender(
      <p data-testid="host">
        Before{" "}
        <InlineDiff
          originalText="The quick brown fox"
          modifiedText="The swift brown fox"
          onAccept={onAccept}
          onReject={onReject}
          {...props}
          {...next}
        />{" "}
        after.
      </p>,
    );
  return { ...utils, rerender, onAccept, onReject };
}

const root = () => document.querySelector(".anky-ui-diff-root") as HTMLSpanElement;
const acceptButton = () => screen.getByRole("button", { name: /accept/i }) as HTMLButtonElement;
const rejectButton = () => screen.getByRole("button", { name: /reject/i }) as HTMLButtonElement;

/** Serializes the diff as `[-deleted-]{+inserted+}(pending)`. */
function markup(el: Element = root()): string {
  return Array.from(el.childNodes)
    .map((node) => {
      if (!(node instanceof HTMLElement)) return node.textContent;
      if (node.classList.contains("anky-ui-diff-toolbar")) return "";
      if (node.tagName === "DEL") return `[-${node.textContent}-]`;
      if (node.tagName === "INS") return `{+${node.textContent}+}`;
      if (node.classList.contains("anky-ui-diff-pending")) return `(${node.textContent})`;
      return node.textContent;
    })
    .join("");
}

beforeEach(() => {
  // jsdom has no layout: without a viewport and a sized reference, floating-ui's `hide` reports the
  // toolbar's anchor as clipped and hides it.
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(768);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const sized = this.classList.contains("anky-ui-diff-root");
    const r = { x: 100, y: 200, width: sized ? 160 : 0, height: sized ? 18 : 0 };
    const box = { ...r, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height };
    return { ...box, toJSON: () => box } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InlineDiff", () => {
  describe("rendering", () => {
    it("renders word-level deletions and insertions inline", () => {
      renderDiff();
      expect(markup()).toBe("The [-quick-]{+swift+} brown fox");
      expect(root().tagName).toBe("SPAN");
      expect(screen.getByTestId("host").textContent).toMatch(/^Before The quickswift brown fox after\.$/);
    });

    it("supports char mode", () => {
      renderDiff({ originalText: "colour", modifiedText: "color", mode: "char" });
      expect(markup()).toBe("colo[-u-]r");
    });

    it("styles changes red/green by default with themable variables", () => {
      renderDiff();
      const del = document.querySelector("del")!;
      const ins = document.querySelector("ins")!;
      expect(del.className).toBe("anky-ui-diff-delete");
      expect(del.style.textDecoration).toBe("line-through");
      expect(del.style.backgroundColor).toBe("var(--anky-ui-diff-delete-bg, #FEE2E2)");
      expect(ins.className).toBe("anky-ui-diff-insert");
      expect(ins.style.backgroundColor).toBe("var(--anky-ui-diff-insert-bg, #DCFCE7)");
      expect(ins.style.textDecoration).toBe("none");
    });

    it("emits only classes when unstyled", () => {
      renderDiff({
        unstyled: true,
        classNames: { root: "r", delete: "d", insert: "i" },
      });
      expect(root().className).toBe("anky-ui-diff-root r");
      expect(document.querySelector("del")!.getAttribute("style")).toBeNull();
      expect(document.querySelector("ins")!.className).toBe("anky-ui-diff-insert i");
      expect(document.querySelector("del")!.className).toBe("anky-ui-diff-delete d");
    });

    it("renders identical texts without changes", () => {
      renderDiff({ originalText: "Same text", modifiedText: "Same text" });
      expect(markup()).toBe("Same text");
      expect(document.querySelector("del, ins")).toBeNull();
    });

    it("updates as the modified text streams in", () => {
      const { rerender } = renderDiff({ modifiedText: "The", isStreaming: true });
      expect(markup()).toBe("The( quick brown fox)");
      rerender({ modifiedText: "The swift", isStreaming: true });
      expect(markup()).toBe("The {+swift+}(quick brown fox)");
      rerender({ modifiedText: "The swift brown fox", isStreaming: true });
      expect(markup()).toBe("The [-quick-]{+swift+} brown fox");
      rerender({ modifiedText: "The swift brown", isStreaming: false });
      expect(markup()).toBe("The [-quick-]{+swift+} brown[- fox-]");
    });
  });

  describe("streaming", () => {
    it("marks the root busy and pulses it with the Web Animations API", () => {
      const cancel = vi.fn();
      const animate = vi.fn(() => ({ cancel }) as unknown as Animation);
      HTMLElement.prototype.animate = animate;
      const { rerender } = renderDiff({ isStreaming: true });

      expect(root().dataset.streaming).toBe("true");
      expect(root().getAttribute("aria-busy")).toBe("true");
      expect(animate).toHaveBeenCalledOnce();
      expect(animate.mock.calls[0]).toEqual([
        expect.arrayContaining([{ opacity: 0.6 }]),
        expect.objectContaining({ iterations: Infinity }),
      ]);

      rerender({ isStreaming: false });
      expect(cancel).toHaveBeenCalledOnce();
      expect(root().hasAttribute("data-streaming")).toBe(false);
      expect(root().hasAttribute("aria-busy")).toBe(false);
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    });

    it("skips the pulse when reduced motion is preferred", () => {
      const animate = vi.fn();
      HTMLElement.prototype.animate = animate;
      window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
      renderDiff({ isStreaming: true });
      expect(animate).not.toHaveBeenCalled();
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
      delete (window as Partial<Window>).matchMedia;
    });

    it("disables Accept until the stream finishes", () => {
      const { rerender, onAccept } = renderDiff({ isStreaming: true, toolbar: "inline" });
      expect(acceptButton().disabled).toBe(true);
      fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true });
      expect(onAccept).not.toHaveBeenCalled();
      rerender({ isStreaming: false });
      expect(acceptButton().disabled).toBe(false);
    });

    it("still allows Reject while streaming", async () => {
      const { onReject } = renderDiff({ isStreaming: true });
      await act(async () => {}); // floating toolbar becomes visible once positioned
      fireEvent.click(rejectButton());
      expect(onReject).toHaveBeenCalledOnce();
    });
  });

  describe("toolbar", () => {
    it("floats the actions in a portal by default", async () => {
      renderDiff();
      await act(async () => {});
      const toolbar = screen.getByRole("toolbar", { name: "Review AI edit" });
      expect(toolbar.parentElement?.parentElement).toBe(document.body);
      expect(root().contains(toolbar)).toBe(false);
      expect(toolbar.style.visibility).toBe("");
    });

    it("hides the floating toolbar once the diff is scrolled out of view", async () => {
      renderDiff();
      await act(async () => {});
      const toolbar = screen.getByRole("toolbar", { name: "Review AI edit" });
      expect(toolbar.style.visibility).toBe("");

      const offscreen = { x: 100, y: -400, width: 160, height: 18, top: -400, left: 100, right: 260, bottom: -382 };
      vi.spyOn(root(), "getBoundingClientRect").mockReturnValue({ ...offscreen, toJSON: () => offscreen } as DOMRect);
      await act(async () => {
        window.dispatchEvent(new Event("scroll"));
      });
      expect(toolbar.style.visibility).toBe("hidden");
    });

    it("can render inline, non-editable, or not at all", () => {
      const { rerender } = renderDiff({ toolbar: "inline" });
      const toolbar = screen.getByRole("toolbar");
      expect(root().contains(toolbar)).toBe(true);
      expect(toolbar.getAttribute("contenteditable")).toBe("false");

      rerender({ toolbar: "none" });
      expect(screen.queryByRole("toolbar")).toBeNull();
    });

    it("labels the buttons with their shortcuts", () => {
      renderDiff({ toolbar: "inline" });
      expect(acceptButton().textContent).toBe("AcceptCtrl+Enter");
      expect(acceptButton().getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
      expect(rejectButton().textContent).toBe("RejectEsc");
      expect(rejectButton().getAttribute("aria-keyshortcuts")).toBe("Escape");
      expect(document.querySelector(".anky-ui-diff-kbd")!.getAttribute("aria-hidden")).toBe("true");
    });

    it("shows the Cmd shortcut on macOS", () => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      renderDiff({ toolbar: "inline" });
      expect(acceptButton().textContent).toBe("Accept⌘ Enter");
      expect(acceptButton().getAttribute("aria-keyshortcuts")).toBe("Meta+Enter");
    });

    it("calls onAccept / onReject on click without stealing focus", () => {
      const { onAccept, onReject } = renderDiff({ toolbar: "inline", acceptLabel: "Keep", rejectLabel: "Discard" });
      const keep = screen.getByRole("button", { name: /keep/i });
      expect(fireEvent.mouseDown(keep)).toBe(false);
      fireEvent.click(keep);
      fireEvent.click(screen.getByRole("button", { name: /discard/i }));
      expect(onAccept).toHaveBeenCalledOnce();
      expect(onReject).toHaveBeenCalledOnce();
    });

    it("merges class names, and StyledInlineDiff applies the Tailwind preset", () => {
      render(
        <StyledInlineDiff
          originalText="a"
          modifiedText="b"
          onAccept={() => {}}
          onReject={() => {}}
          toolbar="inline"
          classNames={{ accept: "extra" }}
        />,
      );
      expect(screen.getByRole("toolbar").className).toBe(`anky-ui-diff-toolbar ${inlineDiffTailwindPreset.toolbar}`);
      expect(acceptButton().className).toBe(
        `anky-ui-diff-action anky-ui-diff-accept ${inlineDiffTailwindPreset.action} ${inlineDiffTailwindPreset.accept} extra`,
      );
    });
  });

  describe("keyboard shortcuts", () => {
    it("accepts with Ctrl+Enter or Cmd+Enter and rejects with Escape", () => {
      const { onAccept, onReject } = renderDiff();
      expect(fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true })).toBe(false);
      fireEvent.keyDown(document.body, { key: "Enter", metaKey: true });
      expect(onAccept).toHaveBeenCalledTimes(2);
      expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
      expect(onReject).toHaveBeenCalledOnce();
    });

    it("ignores plain or extra-modified Enter and modified Escape", () => {
      const { onAccept, onReject } = renderDiff();
      fireEvent.keyDown(document.body, { key: "Enter" });
      fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true, shiftKey: true });
      fireEvent.keyDown(document.body, { key: "Escape", shiftKey: true });
      expect(onAccept).not.toHaveBeenCalled();
      expect(onReject).not.toHaveBeenCalled();
    });

    it("ignores events that were handled or come from text fields", () => {
      const { onAccept, onReject } = renderDiff();
      const input = document.createElement("input");
      const editable = document.createElement("div");
      editable.setAttribute("contenteditable", "true");
      document.body.append(input, editable);

      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.keyDown(editable, { key: "Enter", ctrlKey: true });
      const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      handled.preventDefault();
      document.body.dispatchEvent(handled);
      fireEvent.keyDown(document.body, { key: "Escape", isComposing: true } as KeyboardEventInit);

      expect(onAccept).not.toHaveBeenCalled();
      expect(onReject).not.toHaveBeenCalled();
    });

    it("can be disabled and is removed on unmount", () => {
      const { rerender, unmount, onReject } = renderDiff({ shortcuts: false });
      fireEvent.keyDown(document.body, { key: "Escape" });
      rerender({ shortcuts: true });
      unmount();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(onReject).not.toHaveBeenCalled();
    });

    it("always calls the latest callbacks", () => {
      const { rerender, onReject } = renderDiff();
      const next = vi.fn();
      rerender({ onReject: next });
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(onReject).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
    });
  });
});

describe("toRenderSegments", () => {
  it("passes segments through when not streaming", () => {
    const segments = [
      { type: "equal" as const, value: "a" },
      { type: "delete" as const, value: "b" },
    ];
    expect(toRenderSegments(segments, false)).toBe(segments);
  });

  it("turns the trailing deletion into pending text after the inserted text", () => {
    expect(
      toRenderSegments(
        [
          { type: "delete", value: "x" },
          { type: "equal", value: "a " },
          { type: "delete", value: "b c" },
          { type: "insert", value: "B" },
        ],
        true,
      ),
    ).toEqual([
      { type: "delete", value: "x" },
      { type: "equal", value: "a " },
      { type: "insert", value: "B" },
      { type: "pending", value: "b c" },
    ]);
  });

  it("keeps a trailing pure insertion as is", () => {
    expect(toRenderSegments([{ type: "insert", value: "new" }], true)).toEqual([{ type: "insert", value: "new" }]);
  });
});
