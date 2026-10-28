"use client";

import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";

/** Delay after the last `selectionchange` before the selection is evaluated. */
export const SELECTION_DEBOUNCE_MS = 100;

/**
 * Reference object for `@floating-ui/react` (`refs.setPositionReference`).
 * Measurements are live: each call reads the current layout of the selection.
 * `contextElement` lets floating-ui's `autoUpdate` track scrolling of the
 * selection's overflow ancestors. `getClientRects` enables the `inline()` middleware.
 */
export interface SelectionVirtualElement {
  getBoundingClientRect(): DOMRect;
  getClientRects(): DOMRect[];
  contextElement?: Element;
}

export interface UseSelectionAnchorOptions {
  /** Set to `false` to detach all listeners and reset state. Defaults to `true`. */
  enabled?: boolean;
  /** Minimum length of the selected text, ignoring leading/trailing whitespace. Defaults to `1`. */
  minChars?: number;
  /** Only selections entirely inside this element are tracked. Defaults to `document.body`. */
  containerRef?: RefObject<HTMLElement | null>;
  /**
   * The floating UI itself. Focusing something inside it (e.g. a prompt input) or
   * clicking it collapses the document selection. Those changes are ignored so the
   * anchor stays open.
   */
  floatingRef?: RefObject<HTMLElement | null>;
}

export interface UseSelectionAnchorResult {
  /** A valid selection exists, is visible within its scroll containers, and has not been dismissed. */
  isOpen: boolean;
  /** Text of the tracked selection as rendered by the browser (`Selection.toString()`). Empty when none. */
  selectedText: string;
  /** Position reference for the tracked selection, or `null` when none. */
  virtualElement: SelectionVirtualElement | null;
  /** Hide the anchor until the user makes a different selection. Keeps the saved range for `restoreSelection`. */
  close: () => void;
  /**
   * Re-select the last captured selection, e.g. after an AI run re-rendered the text.
   * Does not change `isOpen`. Returns `false` if the original text can no longer be found.
   */
  restoreSelection: () => boolean;
}

/**
 * Description of a selection that survives DOM re-renders: the original
 * boundary nodes and offsets, plus character offsets relative to `root` for
 * when those nodes have been replaced.
 */
export interface SelectionSnapshot {
  readonly text: string;
  readonly startContainer: Node;
  readonly startOffset: number;
  readonly endContainer: Node;
  readonly endOffset: number;
  readonly root: Node;
  /** Character offset of the start boundary within `root.textContent`. */
  readonly start: number;
  /** Character offset of the end boundary within `root.textContent`. */
  readonly end: number;
}

/** Capture `range` relative to `root`, which must contain it. */
export function captureSelectionSnapshot(range: Range, root: Node): SelectionSnapshot {
  return {
    text: range.toString(),
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
    root,
    start: textOffset(root, range.startContainer, range.startOffset),
    end: textOffset(root, range.endContainer, range.endOffset),
  };
}

/**
 * Rebuild a `Range` that selects the snapshot's original text. Tries, in order:
 * 1. The original nodes and offsets, if still attached and still holding the same text.
 * 2. The same character offsets within `root` (nodes replaced, e.g. by a React re-render).
 * 3. The occurrence of the original text in `root` closest to its old position (text shifted).
 *
 * Returns `null` when the text no longer exists.
 */
export function resolveSelectionSnapshot(snapshot: SelectionSnapshot): Range | null {
  const { root, text } = snapshot;
  const doc = root.ownerDocument ?? (root as Document);

  if (isValidBoundary(snapshot.startContainer, snapshot.startOffset) && isValidBoundary(snapshot.endContainer, snapshot.endOffset)) {
    try {
      const range = doc.createRange();
      range.setStart(snapshot.startContainer, snapshot.startOffset);
      range.setEnd(snapshot.endContainer, snapshot.endOffset);
      if (range.toString() === text && root.contains(range.commonAncestorContainer)) return range;
    } catch {
      // Boundaries are no longer valid (e.g. nodes reordered); fall through.
    }
  }

  if (!root.isConnected || !text) return null;

  const content = root.textContent ?? "";
  if (content.slice(snapshot.start, snapshot.end) === text) return rangeFromTextOffsets(root, snapshot.start, snapshot.end);

  let best = -1;
  for (let i = content.indexOf(text); i !== -1; i = content.indexOf(text, i + 1)) {
    if (best === -1 || Math.abs(i - snapshot.start) < Math.abs(best - snapshot.start)) best = i;
    if (i > snapshot.start) break;
  }
  return best === -1 ? null : rangeFromTextOffsets(root, best, best + text.length);
}

/**
 * Track the user's text selection and expose it as a floating-ui virtual element.
 *
 * - `selectionchange` is debounced by {@link SELECTION_DEBOUNCE_MS}. While a mouse button or finger is
 *   held down (`mousedown`→`mouseup`, `touchstart`→`touchend`/`touchcancel`), the anchor can close but
 *   never opens, so it does not flicker. The selection is evaluated again on release. Emulated mouse
 *   events that browsers fire after a touch are ignored, so a tap is never counted twice.
 * - Collapsed, whitespace-only and shorter-than-`minChars` selections are ignored, as are
 *   selections outside `containerRef` and focus inside `<input>`/`<textarea>`.
 * - Scrolling any ancestor (captured at the document) or resizing re-checks visibility once
 *   per animation frame. The anchor hides while the selection is outside the viewport or
 *   clipped by an overflow container, and reopens when it scrolls back into view.
 *   The virtual element measures live; pair it with `whileElementsMounted: autoUpdate`.
 * - The selection is saved as nodes + offsets + character offsets, so `restoreSelection()`
 *   works even after the text nodes were re-rendered.
 *
 * Tip: call `event.preventDefault()` in `onMouseDown` on toolbar buttons so clicks do not
 * clear the user's visible highlight.
 *
 * @example
 * const anchor = useSelectionAnchor({ containerRef, floatingRef, minChars: 3 });
 * const { refs, floatingStyles } = useFloating({ open: anchor.isOpen, whileElementsMounted: autoUpdate });
 * useLayoutEffect(() => refs.setPositionReference(anchor.virtualElement), [anchor.virtualElement]);
 */
export function useSelectionAnchor(options: UseSelectionAnchorOptions = {}): UseSelectionAnchorResult {
  const [state, setState] = useState<AnchorState>(EMPTY_STATE);
  const [tracker] = useState(() => new SelectionTracker(setState));
  const enabled = options.enabled ?? true;

  useIsomorphicLayoutEffect(() => {
    tracker.options = options;
  });

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    return tracker.attach(document);
  }, [enabled, tracker]);

  return useMemo(
    () => ({ ...state, close: tracker.close, restoreSelection: tracker.restoreSelection }),
    [state, tracker],
  );
}

interface AnchorState {
  isOpen: boolean;
  selectedText: string;
  virtualElement: SelectionVirtualElement | null;
}

const EMPTY_STATE: AnchorState = { isOpen: false, selectedText: "", virtualElement: null };

interface TrackedSelection {
  /** Owned clone. Live ranges keep their boundaries updated as the DOM mutates. */
  readonly range: Range;
  readonly clipAncestors: readonly Element[];
  readonly virtualElement: SelectionVirtualElement;
  dismissed: boolean;
}

class SelectionTracker {
  options: UseSelectionAnchorOptions = {};

  private state: AnchorState = EMPTY_STATE;
  private tracked: TrackedSelection | null = null;
  private snapshot: SelectionSnapshot | null = null;
  private doc: Document | null = null;
  private mouseDown = false;
  private touchDown = false;
  /** `Date.now()` of the last touch event; mouse events shortly after are emulated ("compat") events. */
  private lastTouchAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;

  constructor(private readonly publish: (state: AnchorState) => void) {}

  attach(doc: Document): () => void {
    this.doc = doc;
    const win = doc.defaultView ?? window;
    const capturePassive = { capture: true, passive: true } as const;
    const listeners: Array<[EventTarget, string, EventListener]> = [
      [doc, "mousedown", this.onMouseDown as EventListener],
      [doc, "mouseup", this.onMouseUp as EventListener],
      [doc, "touchstart", this.onTouchStart as EventListener],
      [doc, "touchend", this.onTouchEnd as EventListener],
      [doc, "touchcancel", this.onTouchEnd as EventListener],
      [doc, "scroll", this.onViewportChange],
      [win, "resize", this.onViewportChange],
      [win, "blur", this.onBlur],
    ];

    doc.addEventListener("selectionchange", this.schedule);
    for (const [target, type, listener] of listeners) target.addEventListener(type, listener, capturePassive);

    return () => {
      doc.removeEventListener("selectionchange", this.schedule);
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener, capturePassive);
      clearTimeout(this.timer);
      if (this.frame !== undefined) cancelFrame(this.frame);
      this.timer = undefined;
      this.frame = undefined;
      this.mouseDown = false;
      this.touchDown = false;
      this.doc = null;
      this.clear();
    };
  }

  close = (): void => {
    if (this.tracked) this.tracked.dismissed = true;
    if (this.state.isOpen) this.commit({ ...this.state, isOpen: false });
  };

  restoreSelection = (): boolean => {
    const snapshot = this.snapshot;
    const doc = snapshot?.root.ownerDocument;
    const selection = doc?.getSelection();
    if (!snapshot || !doc || !selection) return false;

    const range = resolveSelectionSnapshot(snapshot);
    if (!range) return false;

    // Focusing an editing host moves the caret, so focus first and select afterwards.
    const host = closestElement(range.commonAncestorContainer)?.closest<HTMLElement>(
      "[contenteditable]:not([contenteditable='false'])",
    );
    if (host && doc.activeElement !== host) host.focus({ preventScroll: true });

    selection.removeAllRanges();
    selection.addRange(range);

    if (this.doc) {
      const wasOpen = this.state.isOpen;
      const tracked = this.track(range.cloneRange());
      tracked.dismissed = !wasOpen;
      this.commit({
        isOpen: wasOpen && isRangeVisible(tracked),
        selectedText: selection.toString(),
        virtualElement: tracked.virtualElement,
      });
    }
    return true;
  };

  private schedule = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.evaluate, SELECTION_DEBOUNCE_MS);
  };

  /*
   * Press tracking. Mouse/pen report mousedown/mouseup; touch reports touchstart/touchend (a long-press
   * selection may end in touchcancel instead). After a tap, browsers also fire emulated mouse events,
   * which are ignored so one gesture never counts as two presses. Releases only (re)start the debounce,
   * so a release reported twice still evaluates the selection once.
   */
  private get pressed(): boolean {
    return this.mouseDown || this.touchDown;
  }

  private onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || isEmulatedMouseEvent(event, this.lastTouchAt)) return;
    if (this.isInsideFloating(event.target as Node | null)) return;
    this.mouseDown = true;
  };

  private onMouseUp = (event: MouseEvent): void => {
    if (!this.mouseDown || event.button !== 0) return;
    this.mouseDown = false;
    this.release();
  };

  private onTouchStart = (event: TouchEvent): void => {
    this.lastTouchAt = Date.now();
    if (this.isInsideFloating(event.target as Node | null)) return;
    this.touchDown = true;
  };

  private onTouchEnd = (event: TouchEvent): void => {
    this.lastTouchAt = Date.now();
    // Another finger is still down (e.g. pinch): the gesture is not over.
    if (!this.touchDown || (event.touches?.length ?? 0) > 0) return;
    this.touchDown = false;
    this.release();
  };

  private onBlur = (): void => {
    // Releases outside the window are never delivered.
    if (!this.pressed) return;
    this.mouseDown = false;
    this.touchDown = false;
    this.release();
  };

  private release(): void {
    if (!this.pressed) this.schedule();
  }

  private onViewportChange = (): void => {
    if (!this.tracked || this.frame !== undefined) return;
    this.frame = requestFrame(() => {
      this.frame = undefined;
      this.refreshVisibility();
    });
  };

  private evaluate = (): void => {
    this.timer = undefined;
    const doc = this.doc;
    if (!doc) return;

    const selection = doc.getSelection();
    const active = doc.activeElement;
    if (this.isInsideFloating(active) || this.isInsideFloating(selection?.anchorNode ?? null)) return;

    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || isTextControl(active)) return this.clear();

    const range = selection.getRangeAt(0);
    const root = this.root();
    if (!root || !root.contains(range.commonAncestorContainer)) return this.clear();

    const text = selection.toString();
    if (text.trim().length < Math.max(1, this.options.minChars ?? 1)) return this.clear();

    const current = this.tracked;
    if (current && sameBoundaries(current.range, range)) return;

    // Mid-drag: a stale anchor may close, but a new one only opens on release.
    if (this.pressed) return this.clear();

    this.snapshot = captureSelectionSnapshot(range, root);
    const tracked = this.track(range.cloneRange());
    this.commit({ isOpen: isRangeVisible(tracked), selectedText: text, virtualElement: tracked.virtualElement });
  };

  private refreshVisibility(): void {
    const tracked = this.tracked;
    if (!tracked) return;
    if (tracked.range.collapsed) return this.clear();
    const isOpen = !tracked.dismissed && isRangeVisible(tracked);
    if (isOpen !== this.state.isOpen) this.commit({ ...this.state, isOpen });
  }

  private track(range: Range): TrackedSelection {
    const tracked: TrackedSelection = {
      range,
      clipAncestors: findClipAncestors(range),
      virtualElement: createVirtualElement(range),
      dismissed: false,
    };
    this.tracked = tracked;
    return tracked;
  }

  private clear(): void {
    this.tracked = null;
    this.commit(EMPTY_STATE);
  }

  private root(): HTMLElement | null {
    const { containerRef } = this.options;
    return containerRef ? containerRef.current : (this.doc?.body ?? null);
  }

  private isInsideFloating(node: Node | null): boolean {
    const floating = this.options.floatingRef?.current;
    return !!floating && !!node && floating.contains(node);
  }

  private commit(next: AnchorState): void {
    const prev = this.state;
    if (prev.isOpen === next.isOpen && prev.selectedText === next.selectedText && prev.virtualElement === next.virtualElement) {
      return;
    }
    this.state = next;
    this.publish(next);
  }
}

function createVirtualElement(range: Range): SelectionVirtualElement {
  let lastRect = makeRect(0, 0, 0, 0);
  const measure = () => {
    const rect = measureRange(range);
    // Keep the last good position while the range is unmeasurable (detached or mid re-render).
    if (rect) lastRect = rect;
    return lastRect;
  };
  return {
    getBoundingClientRect: measure,
    getClientRects() {
      const rects = visibleClientRects(range);
      return rects.length ? rects : [measure()];
    },
    contextElement: closestElement(range.startContainer) ?? undefined,
  };
}

/** Union of the range's non-empty line boxes. Zero-width boxes (e.g. a triple-click's trailing line break) are skipped. */
function measureRange(range: Range): DOMRect | null {
  if (range.collapsed) return null;
  const rects = visibleClientRects(range);
  if (rects.length) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const r of rects) {
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    return makeRect(left, top, right - left, bottom - top);
  }
  if (typeof range.getBoundingClientRect !== "function") return null;
  const box = range.getBoundingClientRect();
  return box.width > 0 || box.height > 0 ? box : null;
}

function visibleClientRects(range: Range): DOMRect[] {
  if (typeof range.getClientRects !== "function") return [];
  return Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
}

function isRangeVisible(tracked: TrackedSelection): boolean {
  const rect = measureRange(tracked.range);
  if (!rect) return false;
  const win = tracked.range.startContainer.ownerDocument?.defaultView;
  if (win && !intersects(rect, { top: 0, left: 0, bottom: win.innerHeight, right: win.innerWidth })) return false;
  for (const el of tracked.clipAncestors) {
    if (el.isConnected && !intersects(rect, el.getBoundingClientRect())) return false;
  }
  return true;
}

interface Box {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function intersects(a: Box, b: Box): boolean {
  return a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
}

/** Ancestors that clip their content. `<html>`/`<body>` are skipped because their overflow applies to the viewport. */
function findClipAncestors(range: Range): Element[] {
  const result: Element[] = [];
  const doc = range.startContainer.ownerDocument;
  const win = doc?.defaultView;
  if (!doc || !win) return result;
  for (
    let el = closestElement(range.commonAncestorContainer);
    el && el !== doc.body && el !== doc.documentElement;
    el = el.parentElement
  ) {
    const { overflowX, overflowY } = win.getComputedStyle(el);
    if (isClipping(overflowX) || isClipping(overflowY)) result.push(el);
  }
  return result;
}

const CLIPPING_OVERFLOW = new Set(["auto", "scroll", "hidden", "clip", "overlay"]);

function isClipping(overflow: string): boolean {
  return CLIPPING_OVERFLOW.has(overflow);
}

function sameBoundaries(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/** Compat mouse events follow a touch within a few hundred ms; 800ms also covers slow devices. */
export const TOUCH_MOUSE_GUARD_MS = 800;

function isEmulatedMouseEvent(event: MouseEvent, lastTouchAt: number): boolean {
  const capabilities = (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } | null })
    .sourceCapabilities;
  if (capabilities) return !!capabilities.firesTouchEvents;
  return Date.now() - lastTouchAt < TOUCH_MOUSE_GUARD_MS;
}

function isTextControl(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
}

function closestElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function isValidBoundary(node: Node, offset: number): boolean {
  if (!node.isConnected) return false;
  const length = node instanceof CharacterData ? node.length : node.childNodes.length;
  return offset >= 0 && offset <= length;
}

/** Number of text characters between the start of `root` and the boundary (`node`, `offset`). */
function textOffset(root: Node, node: Node, offset: number): number {
  const range = (root.ownerDocument ?? (root as Document)).createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** Build a range over `root`'s text content from character offsets. */
function rangeFromTextOffsets(root: Node, start: number, end: number): Range | null {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  let position = 0;
  let startSet = false;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const next = position + node.length;
    // Start inside the node holding the first character; end in the earliest node reaching the offset.
    if (!startSet && start < next) {
      range.setStart(node, start - position);
      startSet = true;
    }
    if (startSet && end <= next) {
      range.setEnd(node, end - position);
      return range;
    }
    position = next;
  }
  return null;
}

function makeRect(x: number, y: number, width: number, height: number): DOMRect {
  if (typeof DOMRect === "function") return new DOMRect(x, y, width, height);
  const rect = { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
  return { ...rect, toJSON: () => rect } as DOMRect;
}

function requestFrame(callback: () => void): number {
  return typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : (setTimeout(callback, 16) as unknown as number);
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
