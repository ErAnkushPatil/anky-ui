"use client";

import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { streamTextReader, type StreamFraming, type StreamTextSource } from "../stream/parser";

/** Maximum number of entries kept in each of the undo (`past`) and redo (`future`) stacks. */
export const HISTORY_LIMIT = 20;

export interface UseOptimisticAIStateOptions<T> {
  /** Initial value for both `currentState` and `confirmedState`. Only read on first render. */
  initialState: T;
  /** Default URL used by `streamFromEndpoint`. May change between renders. */
  endpoint?: string;
  /** Invoked after every change to `currentState` (streamed tokens, rollbacks, undo/redo, ...). */
  onStateChange?: (state: T) => void;
}

/**
 * Anything that yields a streamed body. Pass a factory to let the hook abort the
 * underlying request (e.g. `fetch`) and not just the body read.
 */
export type StreamSource =
  | Promise<Response | ReadableStream<Uint8Array>>
  | Response
  | ReadableStream<Uint8Array>
  | ((signal: AbortSignal) => Promise<Response | ReadableStream<Uint8Array>> | Response | ReadableStream<Uint8Array>);

/** Pure reducer applied per streamed token. Must not mutate `current`. */
export type StreamTransform<T> = (current: T, chunk: string) => T;

export interface MutateWithStreamOptions {
  /** Framing passed to the stream parser. Defaults to `'auto'` (SSE detection with raw fallback). */
  framing?: StreamFraming;
  /** External cancellation, treated the same as calling `abort()`. */
  signal?: AbortSignal;
}

/**
 * Why a stream stopped early.
 * - `user`: `abort()` or the external `signal` fired (rolled back, `error` set).
 * - `superseded`: another `mutateWithStream` call started (rolled back, no `error`).
 * - `interrupted`: `undo`/`redo`/`accept`/`reject`/`update` was called mid-stream.
 * - `disposed`: the owning component unmounted.
 */
export type StreamAbortCause = "user" | "superseded" | "interrupted" | "disposed";

export type MutationOutcome<T> =
  | { status: "completed"; state: T }
  | { status: "aborted"; cause: StreamAbortCause }
  | { status: "error"; error: Error };

export interface OptimisticAIHistory<T> {
  /** Undo stack, oldest first. The last entry is restored by `undo()`. */
  readonly past: readonly T[];
  /** Redo stack, next first. The first entry is restored by `redo()`. */
  readonly future: readonly T[];
}

export interface OptimisticAISnapshot<T> {
  /** Optimistic state, including partially streamed output. */
  readonly currentState: T;
  /** Last state committed through `accept()`. */
  readonly confirmedState: T;
  readonly history: OptimisticAIHistory<T>;
  readonly isStreaming: boolean;
  /** Last stream failure or user abort. Cleared when a new mutation starts, or by `accept()`/`reject()`. */
  readonly error: Error | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface OptimisticAIActions<T> {
  /**
   * Stream tokens into `currentState` optimistically.
   *
   * An atomic snapshot of `currentState` is captured synchronously before any
   * await. Each token is folded in with `transformFn`. On completion, the
   * snapshot is pushed to the undo stack and the redo stack is cleared. On
   * error or abort, `currentState` is restored to the snapshot.
   *
   * Concurrency: last call wins. Starting a stream while another is in flight
   * cancels the older one (outcome `superseded`) and rolls it back first, so the
   * new stream builds on the same pre-mutation snapshot. Stale streams can
   * never write state.
   *
   * The promise never rejects. Inspect the returned outcome or `error`.
   */
  mutateWithStream(
    source: StreamSource,
    transformFn: StreamTransform<T>,
    options?: MutateWithStreamOptions,
  ): Promise<MutationOutcome<T>>;
  /**
   * POST `body` as JSON to the configured `endpoint` and stream the response
   * through `mutateWithStream`. Throws synchronously if no endpoint is configured.
   */
  streamFromEndpoint(
    body: unknown,
    transformFn: StreamTransform<T>,
    options?: MutateWithStreamOptions & { init?: RequestInit },
  ): Promise<MutationOutcome<T>>;
  /** Cancel the in-flight stream, roll back, and set `error` to an `AbortError`. Returns `false` if idle. */
  abort(): boolean;
  /**
   * Restore the previous history entry. While streaming, this instead cancels
   * the stream and restores its snapshot (the in-flight mutation is what gets undone).
   */
  undo(): boolean;
  /** Re-apply the next undone entry. No-op while streaming or after an intervening mutation. */
  redo(): boolean;
  /**
   * Commit `currentState` as the new `confirmedState` and clear both history stacks.
   * While streaming, the stream is stopped and the partial output so far is committed.
   */
  accept(): void;
  /**
   * Revert `currentState` to `confirmedState`. Cancels any in-flight stream.
   * The rejection is itself undoable.
   */
  reject(): void;
  /** Apply a synchronous, undoable change (e.g. a manual user edit). Cancels any in-flight stream first. */
  update(next: T | ((current: T) => T)): void;
}

export type UseOptimisticAIStateResult<T> = OptimisticAISnapshot<T> & OptimisticAIActions<T>;

/** Raised when a streamed `Response` has a non-2xx status. */
export class StreamResponseError extends Error {
  readonly status: number;
  constructor(response: Response) {
    super(`Stream request failed with ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    this.name = "StreamResponseError";
    this.status = response.status;
  }
}

interface ActiveRun<T> {
  readonly controller: AbortController;
  readonly snapshot: T;
  cause: StreamAbortCause | null;
}

/**
 * Framework-agnostic state machine behind {@link useOptimisticAIState}.
 * Compatible with `useSyncExternalStore`. Every transition produces a new
 * immutable snapshot and notifies listeners exactly once.
 */
export class OptimisticAIStore<T> implements OptimisticAIActions<T> {
  onStateChange: ((state: T) => void) | undefined;
  endpoint: string | undefined;

  private state: OptimisticAISnapshot<T>;
  private readonly listeners = new Set<() => void>();
  private active: ActiveRun<T> | null = null;

  constructor(initialState: T, options: Omit<UseOptimisticAIStateOptions<T>, "initialState"> = {}) {
    this.onStateChange = options.onStateChange;
    this.endpoint = options.endpoint;
    this.state = {
      currentState: initialState,
      confirmedState: initialState,
      history: { past: [], future: [] },
      isStreaming: false,
      error: null,
      canUndo: false,
      canRedo: false,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): OptimisticAISnapshot<T> => this.state;

  mutateWithStream = async (
    source: StreamSource,
    transformFn: StreamTransform<T>,
    options: MutateWithStreamOptions = {},
  ): Promise<MutationOutcome<T>> => {
    const superseded = this.detach("superseded");
    const snapshot = superseded ? superseded.snapshot : this.state.currentState;
    const run: ActiveRun<T> = { controller: new AbortController(), snapshot, cause: null };
    this.active = run;
    this.commit({ currentState: snapshot, isStreaming: true, error: null });

    const external = options.signal;
    const onExternalAbort = () => {
      if (this.active === run) this.abort();
    };
    if (external?.aborted) onExternalAbort();
    else external?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const body = await resolveSource(source, run.controller.signal);
      if (this.active !== run) {
        disposeBody(body);
        return { status: "aborted", cause: run.cause ?? "interrupted" };
      }

      let working = snapshot;
      for await (const chunk of streamTextReader(body, { signal: run.controller.signal, framing: options.framing })) {
        if (this.active !== run) break;
        working = transformFn(working, chunk);
        this.commit({ currentState: working });
      }
      if (this.active !== run) return { status: "aborted", cause: run.cause ?? "interrupted" };

      this.active = null;
      const { past } = this.state.history;
      this.commit({
        isStreaming: false,
        history: working === snapshot ? this.state.history : { past: pushCapped(past, snapshot), future: [] },
      });
      return { status: "completed", state: working };
    } catch (err) {
      if (this.active !== run) return { status: "aborted", cause: run.cause ?? "interrupted" };
      this.active = null;
      const error = toError(err);
      this.commit({ currentState: snapshot, isStreaming: false, error });
      return { status: "error", error };
    } finally {
      external?.removeEventListener("abort", onExternalAbort);
    }
  };

  streamFromEndpoint = (
    body: unknown,
    transformFn: StreamTransform<T>,
    options: MutateWithStreamOptions & { init?: RequestInit } = {},
  ): Promise<MutationOutcome<T>> => {
    const endpoint = this.endpoint;
    if (!endpoint) throw new TypeError("useOptimisticAIState: `endpoint` option is required for streamFromEndpoint()");
    const { init, ...mutateOptions } = options;
    // `Headers` accepts every HeadersInit shape; spreading a `Headers` instance or tuple array would drop them.
    const headers = new Headers(init?.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (!headers.has("Accept")) headers.set("Accept", "text/event-stream");
    return this.mutateWithStream(
      (signal) =>
        fetch(endpoint, {
          method: "POST",
          ...init,
          headers,
          body: JSON.stringify(body),
          signal,
        }),
      transformFn,
      mutateOptions,
    );
  };

  abort = (): boolean => {
    const run = this.detach("user");
    if (!run) return false;
    this.commit({ currentState: run.snapshot, isStreaming: false, error: createAbortError() });
    return true;
  };

  undo = (): boolean => {
    const run = this.detach("interrupted");
    if (run) {
      this.commit({ currentState: run.snapshot, isStreaming: false });
      return true;
    }
    const { past, future } = this.state.history;
    if (past.length === 0) return false;
    this.commit({
      currentState: past[past.length - 1],
      history: { past: past.slice(0, -1), future: [this.state.currentState, ...future].slice(0, HISTORY_LIMIT) },
    });
    return true;
  };

  redo = (): boolean => {
    if (this.active) return false;
    const { past, future } = this.state.history;
    if (future.length === 0) return false;
    this.commit({
      currentState: future[0],
      history: { past: pushCapped(past, this.state.currentState), future: future.slice(1) },
    });
    return true;
  };

  accept = (): void => {
    this.detach("interrupted");
    this.commit({
      confirmedState: this.state.currentState,
      isStreaming: false,
      error: null,
      history: { past: [], future: [] },
    });
  };

  reject = (): void => {
    const run = this.detach("interrupted");
    const base = run ? run.snapshot : this.state.currentState;
    const { confirmedState, history } = this.state;
    this.commit({
      currentState: confirmedState,
      isStreaming: false,
      error: null,
      history: base === confirmedState ? history : { past: pushCapped(history.past, base), future: [] },
    });
  };

  update = (next: T | ((current: T) => T)): void => {
    const run = this.detach("interrupted");
    const base = run ? run.snapshot : this.state.currentState;
    const value = typeof next === "function" ? (next as (current: T) => T)(base) : next;
    const { history } = this.state;
    this.commit({
      currentState: value,
      isStreaming: false,
      history: value === base ? history : { past: pushCapped(history.past, base), future: [] },
    });
  };

  /** Cancel any in-flight stream (rolling it back) without permanently disabling the store. */
  dispose = (): void => {
    const run = this.detach("disposed");
    if (run) this.commit({ currentState: run.snapshot, isStreaming: false });
  };

  /** Detach and abort the active run without touching state, so callers can apply one combined update. */
  private detach(cause: StreamAbortCause): ActiveRun<T> | null {
    const run = this.active;
    if (!run) return null;
    this.active = null;
    run.cause = cause;
    run.controller.abort(createAbortError(cause));
    return run;
  }

  private commit(patch: Partial<Omit<OptimisticAISnapshot<T>, "canUndo" | "canRedo">>): void {
    const prev = this.state;
    const next = { ...prev, ...patch };
    next.canUndo = next.isStreaming || next.history.past.length > 0;
    next.canRedo = !next.isStreaming && next.history.future.length > 0;
    this.state = next;

    for (const listener of [...this.listeners]) listener();

    if (next.currentState !== prev.currentState && this.onStateChange) {
      try {
        this.onStateChange(next.currentState);
      } catch (err) {
        // Consumer errors must not be mistaken for stream failures; surface them asynchronously.
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }
}

/**
 * Optimistic, undoable React state driven by streamed AI output.
 *
 * Holds three layers: `confirmedState` (last accepted baseline), `currentState`
 * (optimistic, may include partial stream output), and a bounded undo/redo
 * `history` of {@link HISTORY_LIMIT} entries per direction.
 *
 * Action identities are stable across renders. An in-flight stream is
 * cancelled and rolled back when the component unmounts.
 *
 * @example
 * const ai = useOptimisticAIState({ initialState: "", endpoint: "/api/rewrite" });
 * await ai.streamFromEndpoint({ prompt }, (text, token) => text + token);
 * if (ai.error) toast(ai.error.message);
 * <button onClick={ai.accept} disabled={ai.isStreaming}>Keep</button>
 */
export function useOptimisticAIState<T>(options: UseOptimisticAIStateOptions<T>): UseOptimisticAIStateResult<T> {
  const [store] = useState(
    () => new OptimisticAIStore<T>(options.initialState, { endpoint: options.endpoint, onStateChange: options.onStateChange }),
  );

  useIsomorphicLayoutEffect(() => {
    store.onStateChange = options.onStateChange;
    store.endpoint = options.endpoint;
  });

  useEffect(() => store.dispose, [store]);

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return useMemo(
    () => ({
      ...snapshot,
      mutateWithStream: store.mutateWithStream,
      streamFromEndpoint: store.streamFromEndpoint,
      abort: store.abort,
      undo: store.undo,
      redo: store.redo,
      accept: store.accept,
      reject: store.reject,
      update: store.update,
    }),
    [snapshot, store],
  );
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function pushCapped<T>(stack: readonly T[], item: T): readonly T[] {
  const next = stack.length >= HISTORY_LIMIT ? stack.slice(stack.length - HISTORY_LIMIT + 1) : stack.slice();
  next.push(item);
  return next;
}

function createAbortError(cause?: StreamAbortCause): Error {
  const message = cause && cause !== "user" ? `The stream was cancelled (${cause}).` : "The stream was aborted.";
  return new DOMException(message, "AbortError");
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function resolveSource(source: StreamSource, signal: AbortSignal): Promise<StreamTextSource> {
  const pending = Promise.resolve(typeof source === "function" ? source(signal) : source);
  const body = await raceAbort(pending, signal);
  if (typeof Response !== "undefined" && body instanceof Response && !body.ok) {
    disposeBody(body);
    throw new StreamResponseError(body);
  }
  return body;
}

/** Reject as soon as `signal` aborts. A late-arriving body is cancelled so it does not leak. */
function raceAbort<V extends StreamTextSource>(pending: Promise<V>, signal: AbortSignal): Promise<V> {
  return new Promise<V>((resolve, reject) => {
    const onAbort = () => {
      pending.then(disposeBody, () => undefined);
      reject(signal.reason);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (!signal.aborted) resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        if (!signal.aborted) reject(err);
      },
    );
  });
}

function disposeBody(body: StreamTextSource): void {
  const stream = typeof Response !== "undefined" && body instanceof Response ? body.body : (body as ReadableStream);
  if (stream && !stream.locked) stream.cancel().catch(() => undefined);
}
