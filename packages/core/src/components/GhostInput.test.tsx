// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GHOST_DEBOUNCE_MS, GhostInput, type GhostInputHandle, type GhostInputProps } from "./GhostInput";

type Fetch = GhostInputProps["fetchSuggestion"];

function Harness({
  initial = "",
  ...props
}: Partial<GhostInputProps> & { initial?: string; fetchSuggestion: Fetch; ref?: Ref<GhostInputHandle> }) {
  const [value, setValue] = useState(initial);
  return <GhostInput value={value} onChange={setValue} aria-label="Body" {...props} />;
}

const textarea = () => screen.getByRole("textbox", { name: "Body" }) as HTMLTextAreaElement;
const ghost = () => document.querySelector(".anky-ui-ghost-suggestion")?.textContent ?? "";
const mirror = () => document.querySelector(".anky-ui-ghost-mirror") as HTMLDivElement;

function type(value: string) {
  fireEvent.change(textarea(), { target: { value } });
}

function moveCaret(position: number) {
  act(() => {
    textarea().setSelectionRange(position, position);
    fireEvent.select(textarea());
  });
}

async function flushDebounce(ms = DEFAULT_GHOST_DEBOUNCE_MS) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function key(k: string, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(textarea(), { key: k, ...init });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("GhostInput", () => {
  describe("layers", () => {
    it("stacks a mirror under a transparent textarea that inherits the root typography", () => {
      render(
        <GhostInput
          value="Hello"
          onChange={() => {}}
          fetchSuggestion={async () => ""}
          className="box"
          style={{ fontSize: 18 }}
          rows={4}
          id="body"
        />,
      );
      const root = document.querySelector(".anky-ui-ghost-root") as HTMLDivElement;
      const input = document.getElementById("body") as HTMLTextAreaElement;

      expect(root.className).toBe("anky-ui-ghost-root box");
      expect(root.style.fontSize).toBe("18px");
      expect(input.className).toBe("anky-ui-ghost-input");
      expect(input.rows).toBe(4);
      expect(mirror().getAttribute("aria-hidden")).toBe("true");
      expect(mirror().nextElementSibling).toBe(input); // painted below the textarea

      for (const el of [mirror(), input]) {
        expect(el.style).toMatchObject({
          font: "inherit",
          lineHeight: "inherit",
          letterSpacing: "inherit",
          padding: "0px",
          whiteSpace: "pre-wrap",
          boxSizing: "border-box",
        });
        expect(el.style.border).toMatch(/^0(px)?$/);
      }
      expect(input.style.background).toBe("transparent");
      expect(input.style.getPropertyValue("-webkit-text-fill-color")).toBe("transparent");
      expect(mirror().textContent).toBe("Hello\u200b");
    });

    it("draws the placeholder in the mirror and exposes it as aria-placeholder", () => {
      render(<GhostInput value="" onChange={() => {}} fetchSuggestion={async () => ""} placeholder="Write…" />);
      const placeholder = document.querySelector(".anky-ui-ghost-placeholder") as HTMLSpanElement;
      expect(placeholder.textContent).toBe("Write…");
      expect(placeholder.style.color).toBe("var(--anky-ui-ghost-color, #9CA3AF)");
      const input = document.querySelector("textarea")!;
      expect(input.hasAttribute("placeholder")).toBe(false);
      expect(input.getAttribute("aria-placeholder")).toBe("Write…");
    });

    it("mirrors the textarea scroll position", () => {
      render(<Harness fetchSuggestion={async () => ""} initial={"a\n".repeat(50)} />);
      const input = textarea();
      Object.defineProperties(input, {
        scrollHeight: { configurable: true, value: 500 },
        clientHeight: { configurable: true, value: 100 },
      });
      input.scrollTop = 120;
      fireEvent.scroll(input);
      expect(mirror().scrollTop).toBe(120);
      expect(mirror().style.overflowY).toBe("scroll");
    });
  });

  describe("fetching", () => {
    it("debounces requests and asks for the latest text", async () => {
      const fetchSuggestion = vi.fn<Fetch>(async () => "");
      render(<Harness fetchSuggestion={fetchSuggestion} debounceMs={200} />);
      act(() => textarea().focus());
      type("H");
      type("He");
      await flushDebounce(199);
      type("Hel");
      await flushDebounce(199);
      expect(fetchSuggestion).not.toHaveBeenCalled();
      await flushDebounce(1);
      expect(fetchSuggestion).toHaveBeenCalledOnce();
      expect(fetchSuggestion.mock.calls[0][0]).toBe("Hel");
    });

    it("shows the suggestion as gray ghost text after the value", async () => {
      render(<Harness fetchSuggestion={async (text) => (text === "Thanks for" ? " the update." : "")} />);
      act(() => textarea().focus());
      type("Thanks for");
      await flushDebounce();

      expect(ghost()).toBe(" the update.");
      const span = document.querySelector(".anky-ui-ghost-suggestion") as HTMLSpanElement;
      expect(span.style.color).toBe("var(--anky-ui-ghost-color, #9CA3AF)");
      expect(span.previousElementSibling?.textContent).toBe("Thanks for");
      expect(document.querySelector(".anky-ui-ghost-status")?.textContent).toBe(
        "Suggestion: the update. Press Tab to accept.",
      );
    });

    it("does not fetch for empty text, programmatic changes or read-only fields", async () => {
      const fetchSuggestion = vi.fn<Fetch>(async () => "x");
      const { rerender } = render(<GhostInput value="" onChange={() => {}} fetchSuggestion={fetchSuggestion} />);
      rerender(<GhostInput value="external" onChange={() => {}} fetchSuggestion={fetchSuggestion} />);
      fireEvent.change(document.querySelector("textarea")!, { target: { value: "" } });
      await flushDebounce();
      rerender(<GhostInput value="a" onChange={() => {}} fetchSuggestion={fetchSuggestion} readOnly />);
      fireEvent.change(document.querySelector("textarea")!, { target: { value: "ab" } });
      await flushDebounce();
      expect(fetchSuggestion).not.toHaveBeenCalled();
    });

    it("aborts and ignores stale responses", async () => {
      const resolvers: Array<(value: string) => void> = [];
      const signals: AbortSignal[] = [];
      const fetchSuggestion = vi.fn<Fetch>(
        (_text, { signal }) =>
          new Promise<string>((resolve) => {
            resolvers.push(resolve);
            signals.push(signal);
          }),
      );
      render(<Harness fetchSuggestion={fetchSuggestion} />);
      act(() => textarea().focus());
      type("Hi");
      await flushDebounce();
      type("Hi t");
      expect(signals[0].aborted).toBe(true);

      await act(async () => resolvers[0](" there"));
      expect(ghost()).toBe("");

      await flushDebounce();
      await act(async () => resolvers[1]("eam,"));
      expect(ghost()).toBe("eam,");
    });

    it("reports failures without showing anything", async () => {
      const onSuggestionError = vi.fn();
      const error = new Error("boom");
      render(<Harness fetchSuggestion={() => Promise.reject(error)} onSuggestionError={onSuggestionError} />);
      act(() => textarea().focus());
      type("Hello");
      await flushDebounce();
      expect(onSuggestionError).toHaveBeenCalledExactlyOnceWith(error);
      expect(ghost()).toBe("");
    });

    it("treats synchronous throws as failures", async () => {
      const onSuggestionError = vi.fn();
      render(
        <Harness
          fetchSuggestion={() => {
            throw new Error("sync");
          }}
          onSuggestionError={onSuggestionError}
        />,
      );
      type("Hello");
      await flushDebounce();
      expect(onSuggestionError).toHaveBeenCalledOnce();
    });

    it("cancels pending work on unmount", async () => {
      const fetchSuggestion = vi.fn<Fetch>(async () => "x");
      const { unmount } = render(<Harness fetchSuggestion={fetchSuggestion} />);
      type("Hello");
      unmount();
      await flushDebounce();
      expect(fetchSuggestion).not.toHaveBeenCalled();
    });
  });

  describe("visibility", () => {
    async function withSuggestion(props: Partial<GhostInputProps> = {}) {
      const fetchSuggestion = vi.fn<Fetch>(async (text) => (text.startsWith("Let me know") ? " if you have questions." : ""));
      const utils = render(<Harness fetchSuggestion={fetchSuggestion} {...props} />);
      act(() => textarea().focus());
      type("Let me know");
      await flushDebounce();
      expect(ghost()).toBe(" if you have questions.");
      return { ...utils, fetchSuggestion };
    }

    it("hides while unfocused and shows again on focus", async () => {
      await withSuggestion();
      act(() => textarea().blur());
      expect(ghost()).toBe("");
      act(() => textarea().focus());
      expect(ghost()).toBe(" if you have questions.");
    });

    it("hides while the caret is not at the end", async () => {
      await withSuggestion();
      moveCaret(3);
      expect(ghost()).toBe("");
      moveCaret(11);
      expect(ghost()).toBe(" if you have questions.");
    });

    it("hides during IME composition", async () => {
      await withSuggestion();
      fireEvent.compositionStart(textarea());
      expect(ghost()).toBe("");
      fireEvent.compositionEnd(textarea());
      expect(ghost()).toBe(" if you have questions.");
    });

    it("keeps the remainder while typing matches it, without refetching", async () => {
      const { fetchSuggestion } = await withSuggestion();
      type("Let me know i");
      expect(ghost()).toBe("f you have questions.");
      type("Let me know if ");
      await flushDebounce();
      expect(ghost()).toBe("you have questions.");
      expect(fetchSuggestion).toHaveBeenCalledOnce();
    });

    it("invalidates immediately when typing diverges, then refetches", async () => {
      const { fetchSuggestion } = await withSuggestion();
      type("Let me know w");
      expect(ghost()).toBe("");
      await flushDebounce();
      expect(fetchSuggestion).toHaveBeenLastCalledWith("Let me know w", expect.anything());
    });

    it("invalidates when deleting text", async () => {
      await withSuggestion();
      type("Let me kno");
      expect(ghost()).toBe("");
    });
  });

  describe("keyboard", () => {
    async function ready(props: Partial<GhostInputProps> = {}) {
      const onAcceptSuggestion = vi.fn();
      const fetchSuggestion = vi.fn<Fetch>(async (text) => (text === "Best" ? " regards,\nAnky" : ""));
      render(<Harness fetchSuggestion={fetchSuggestion} onAcceptSuggestion={onAcceptSuggestion} {...props} />);
      act(() => textarea().focus());
      type("Best");
      await flushDebounce();
      return { onAcceptSuggestion, fetchSuggestion };
    }

    it("accepts with Tab, places the caret at the end and fetches the next suggestion", async () => {
      const { onAcceptSuggestion, fetchSuggestion } = await ready();
      expect(key("Tab")).toBe(false);
      expect(textarea().value).toBe("Best regards,\nAnky");
      expect(textarea().selectionStart).toBe(18);
      expect(onAcceptSuggestion).toHaveBeenCalledExactlyOnceWith(" regards,\nAnky");
      expect(ghost()).toBe("");
      await flushDebounce();
      expect(fetchSuggestion).toHaveBeenLastCalledWith("Best regards,\nAnky", expect.anything());
    });

    it("accepts with ArrowRight only when the caret is at the end", async () => {
      await ready();
      expect(key("ArrowRight")).toBe(false);
      expect(textarea().value).toBe("Best regards,\nAnky");
    });

    it("leaves Tab, arrows and Escape alone when there is no visible suggestion", async () => {
      await ready();
      moveCaret(2);
      expect(key("ArrowRight")).toBe(true);
      expect(key("Tab")).toBe(true);
      expect(key("Escape")).toBe(true);
      expect(textarea().value).toBe("Best");
    });

    it("ignores modified Tab (focus navigation) and composition", async () => {
      await ready();
      expect(key("Tab", { shiftKey: true })).toBe(true);
      expect(key("ArrowRight", { ctrlKey: true })).toBe(true);
      expect(key("Tab", { isComposing: true } as KeyboardEventInit)).toBe(true);
      expect(textarea().value).toBe("Best");
    });

    it("dismisses with Escape until the user types again", async () => {
      const { fetchSuggestion } = await ready();
      expect(key("Escape")).toBe(false);
      expect(ghost()).toBe("");
      await flushDebounce();
      expect(fetchSuggestion).toHaveBeenCalledOnce();
      expect(key("Tab")).toBe(true);
    });

    it("runs the consumer's onKeyDown first and respects preventDefault", async () => {
      const onKeyDown = vi.fn((event: ReactKeyboardEvent) => event.preventDefault());
      await ready({ onKeyDown });
      key("Tab");
      expect(onKeyDown).toHaveBeenCalled();
      expect(textarea().value).toBe("Best");
    });
  });

  it("exposes an imperative handle", async () => {
    const ref = createRef<GhostInputHandle>();
    render(<Harness ref={ref} fetchSuggestion={async () => " world"} />);
    act(() => textarea().focus());
    type("Hello");
    await flushDebounce();
    expect(ref.current?.textarea).toBe(textarea());
    act(() => ref.current!.dismissSuggestion());
    expect(ghost()).toBe("");
    type("Hello!");
    await flushDebounce();
    act(() => {
      expect(ref.current!.acceptSuggestion()).toBe(true);
    });
    expect(textarea().value).toBe("Hello! world");
  });
});
