// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { SELECTION_DEBOUNCE_MS } from "./dom/useSelectionAnchor";
import { SSRFixture } from "../test/ssrFixture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("hydration", () => {
  it("hydrates server HTML without mismatches or warnings", async () => {
    const html = renderToString(<SSRFixture />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const serverArticle = container.querySelector("#article")!;
    const serverMarkup = serverArticle.outerHTML;

    const consoleError = vi.spyOn(console, "error");
    const recoverable = vi.fn();
    await act(async () => {
      root = hydrateRoot(container, <SSRFixture />, { onRecoverableError: recoverable });
    });

    expect(recoverable).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    // The server nodes were adopted, not re-created.
    expect(container.querySelector("#article")).toBe(serverArticle);
    expect(serverArticle.outerHTML).toBe(serverMarkup);
    // Client-only pieces mount after hydration: the floating toolbar portal joins the inline one.
    expect(document.querySelectorAll(".anky-ui-diff-toolbar")).toHaveLength(2);
  });

  it("starts tracking selections only after hydration", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // jsdom has no layout; give ranges a visible box.
    const box = { x: 10, y: 10, width: 40, height: 16, top: 10, left: 10, right: 50, bottom: 26, toJSON: () => ({}) };
    const proto = Range.prototype as unknown as Record<string, unknown>;
    const originals = { getClientRects: proto.getClientRects, getBoundingClientRect: proto.getBoundingClientRect };
    proto.getClientRects = () => [box];
    proto.getBoundingClientRect = () => box;
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(768);
    onTestFinished(() => {
      Object.assign(proto, originals);
      vi.restoreAllMocks();
    });
    const onPrompt = vi.fn();
    const container = document.createElement("div");
    container.innerHTML = renderToString(<SSRFixture onPrompt={onPrompt} />);
    document.body.append(container);
    expect(document.querySelector(".anky-ui-palette-root")).toBeNull();

    await act(async () => {
      root = hydrateRoot(container, <SSRFixture onPrompt={onPrompt} />);
    });

    const text = container.querySelector("#article p")!.firstChild!;
    act(() => {
      const range = document.createRange();
      range.setStart(text, 4);
      range.setEnd(text, 9);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await act(async () => {
      vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS);
    });

    expect(container.querySelector("#article")!.getAttribute("data-anchor-open")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Fix Grammar" }));
    expect(onPrompt).toHaveBeenCalledWith(expect.any(String), "quick");
  });
});
