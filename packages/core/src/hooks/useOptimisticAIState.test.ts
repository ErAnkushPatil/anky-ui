// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useOptimisticAIState } from "./useOptimisticAIState";
import { controllableStream, flush } from "../../test/streams";

const append = (state: string, chunk: string) => state + chunk;
const sse = (...tokens: string[]) => tokens.map((t) => `data: ${t}\n\n`).join("");

describe("useOptimisticAIState", () => {
  it("re-renders with streamed tokens and settles on completion", async () => {
    const src = controllableStream();
    const { result } = renderHook(() => useOptimisticAIState({ initialState: "Hello" }));

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateWithStream(src.stream, append);
    });
    expect(result.current.isStreaming).toBe(true);

    await act(async () => {
      src.push(sse(" wor", "ld"));
      await flush();
    });
    expect(result.current.currentState).toBe("Hello world");
    expect(result.current.confirmedState).toBe("Hello");

    await act(async () => {
      src.close();
      await pending;
    });
    expect(result.current).toMatchObject({ isStreaming: false, canUndo: true, error: null });

    act(() => result.current.accept());
    expect(result.current).toMatchObject({ confirmedState: "Hello world", canUndo: false });
  });

  it("keeps action identities stable across renders", async () => {
    const { result, rerender } = renderHook(() => useOptimisticAIState({ initialState: 0 }));
    const first = result.current;
    act(() => result.current.update(1));
    rerender();
    for (const key of ["mutateWithStream", "streamFromEndpoint", "abort", "undo", "redo", "accept", "reject", "update"] as const) {
      expect(result.current[key]).toBe(first[key]);
    }
    expect(result.current.currentState).toBe(1);
  });

  it("exposes errors after rollback", async () => {
    const src = controllableStream();
    const { result } = renderHook(() => useOptimisticAIState({ initialState: "base" }));
    await act(async () => {
      const pending = result.current.mutateWithStream(src.stream, append);
      src.push(sse("!"));
      await flush();
      src.error(new Error("stream failed"));
      await pending;
    });
    expect(result.current.currentState).toBe("base");
    expect(result.current.error?.message).toBe("stream failed");
  });

  it("uses the latest onStateChange callback", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ cb }) => useOptimisticAIState({ initialState: "", onStateChange: cb }),
      { initialProps: { cb: first } },
    );
    rerender({ cb: second });
    act(() => result.current.update("x"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("x");
  });

  it("uses the latest endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse("ok")));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { result, rerender } = renderHook(
        ({ endpoint }) => useOptimisticAIState({ initialState: "", endpoint }),
        { initialProps: { endpoint: "/v1" } },
      );
      rerender({ endpoint: "/v2" });
      await act(async () => {
        await result.current.streamFromEndpoint({}, append);
      });
      expect(fetchMock.mock.calls[0][0]).toBe("/v2");
      expect(result.current.currentState).toBe("ok");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels an in-flight stream on unmount", async () => {
    const src = controllableStream();
    const { result, unmount } = renderHook(() => useOptimisticAIState({ initialState: "" }));
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateWithStream(src.stream, append);
    });
    unmount();
    await expect(pending).resolves.toEqual({ status: "aborted", cause: "disposed" });
    expect(src.cancelled).toBe(true);
  });

  it("survives StrictMode double-mounting", async () => {
    const src = controllableStream();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);
    const { result } = renderHook(() => useOptimisticAIState({ initialState: "" }), { wrapper });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateWithStream(src.stream, append);
    });
    await act(async () => {
      src.push(sse("ok"));
      src.close();
      await pending;
    });
    expect(result.current.currentState).toBe("ok");
  });
});
