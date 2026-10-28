"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type CompositionEvent,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
  type TextareaHTMLAttributes,
  type UIEvent,
} from "react";

export const DEFAULT_GHOST_DEBOUNCE_MS = 300;

type NativeTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "defaultValue" | "onChange" | "children" | "className" | "style"
>;

export interface GhostInputProps extends NativeTextareaProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Returns the text to append after `current` (not the full text). Return `""` for no suggestion.
   * `signal` aborts when the request becomes stale, so it can be passed straight to `fetch`.
   * Results for text that no longer matches the field are discarded either way.
   */
  fetchSuggestion: (current: string, options: { signal: AbortSignal }) => Promise<string>;
  /** Idle time after the last keystroke before `fetchSuggestion` is called. @default 300 */
  debounceMs?: number;
  /** Called when `fetchSuggestion` rejects (aborts excluded). Failures never surface in the UI. */
  onSuggestionError?: (error: unknown) => void;
  /** Called after a suggestion is accepted with Tab / ArrowRight. */
  onAcceptSuggestion?: (suggestion: string) => void;
  /**
   * Applied to the root, which owns the box and typography: font, line-height, letter-spacing,
   * padding, border, background, colour. Both layers inherit from it, so they always line up.
   * Style focus with `:focus-within`.
   */
  className?: string;
  style?: CSSProperties;
}

export interface GhostInputHandle {
  /** The underlying textarea, for focus management etc. */
  readonly textarea: HTMLTextAreaElement | null;
  /** Accepts the visible suggestion, if any. */
  acceptSuggestion(): boolean;
  /** Clears the current suggestion and cancels pending requests. */
  dismissSuggestion(): void;
}

interface Suggestion {
  /** Field text the suggestion was produced for. */
  base: string;
  /** Continuation to append after `base`. */
  text: string;
}

/**
 * Remaining ghost text for `value`, or `""`. Typing that matches the suggestion keeps the rest
 * visible (type-through); anything else invalidates it.
 */
function remainingGhost(suggestion: Suggestion | null, value: string): string {
  if (!suggestion || !value.startsWith(suggestion.base)) return "";
  const full = suggestion.base + suggestion.text;
  return full.length > value.length && full.startsWith(value) ? full.slice(value.length) : "";
}

const wrapping: CSSProperties = {
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  wordBreak: "normal",
  tabSize: "inherit",
};

// Both layers inherit every typographic property from the root and have no box of their own
// (padding / border live on the root), so their text lays out identically by construction.
const layerReset: CSSProperties = {
  ...wrapping,
  margin: 0,
  padding: 0,
  border: 0,
  boxSizing: "border-box",
  font: "inherit",
  fontKerning: "inherit",
  fontFeatureSettings: "inherit",
  fontVariationSettings: "inherit",
  lineHeight: "inherit",
  letterSpacing: "inherit",
  wordSpacing: "inherit",
  textTransform: "inherit",
  textIndent: "inherit",
  textAlign: "inherit",
  textRendering: "inherit",
  direction: "inherit",
  color: "inherit",
};

const innerStyle: CSSProperties = { position: "relative", height: "100%" };

const mirrorStyle: CSSProperties = {
  ...layerReset,
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  pointerEvents: "none",
  userSelect: "none",
};

const textareaStyle: CSSProperties = {
  ...layerReset,
  position: "relative",
  display: "block",
  width: "100%",
  height: "100%",
  background: "transparent",
  outline: "none",
  resize: "none",
  // Hide the glyphs but keep `color` intact so the caret (currentColor) stays visible.
  WebkitTextFillColor: "transparent",
};

const ghostStyle: CSSProperties = { color: "var(--anky-ui-ghost-color, #9CA3AF)" };

const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * Copilot-style inline autocomplete.
 *
 * Two stacked layers: a bottom `div` renders the value plus the ghost suggestion (`#9CA3AF`,
 * overridable with `--anky-ui-ghost-color`), and a transparent `textarea` on top handles input,
 * caret and selection. Scrolling is mirrored between them.
 *
 * - Suggestions are fetched `debounceMs` after the user stops typing and shown only while the
 *   field is focused, the caret is at the end, and no IME composition is active.
 * - `Tab`, or `ArrowRight` with the caret at the end, accepts. `Escape` dismisses. Otherwise
 *   those keys keep their default behaviour (Tab still moves focus when there is no suggestion).
 * - Typing invalidates the suggestion unless it matches the suggestion's next characters.
 * - Stale or out-of-order responses are discarded.
 *
 * `placeholder` is drawn by the bottom layer (exposed as `aria-placeholder`), because the
 * textarea's own glyphs are transparent.
 */
export const GhostInput = forwardRef<GhostInputHandle, GhostInputProps>(function GhostInput(
  {
    value,
    onChange,
    fetchSuggestion,
    debounceMs = DEFAULT_GHOST_DEBOUNCE_MS,
    onSuggestionError,
    onAcceptSuggestion,
    className,
    style,
    placeholder,
    disabled,
    readOnly,
    onKeyDown,
    onSelect,
    onFocus,
    onBlur,
    onScroll,
    onCompositionStart,
    onCompositionEnd,
    ...textareaProps
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [focused, setFocused] = useState(false);
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  const [composing, setComposing] = useState(false);

  const latest = useRef({ value, suggestion, fetchSuggestion, debounceMs, onSuggestionError });
  latest.current = { value, suggestion, fetchSuggestion, debounceMs, onSuggestionError };
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestRef = useRef<AbortController | null>(null);
  const caretToEndRef = useRef(false);

  const ghost = remainingGhost(suggestion, value);
  const visibleGhost = focused && caretAtEnd && !composing && !disabled && !readOnly ? ghost : "";

  const cancelPending = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  useEffect(() => cancelPending, [cancelPending]);

  const requestSuggestion = useCallback(
    (text: string) => {
      cancelPending();
      // Type-through: the current suggestion still covers this text.
      if (remainingGhost(latest.current.suggestion, text)) return;
      setSuggestion(null);
      if (!text) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        const controller = new AbortController();
        requestRef.current = controller;
        let request: Promise<string>;
        try {
          request = Promise.resolve(latest.current.fetchSuggestion(text, { signal: controller.signal }));
        } catch (error) {
          request = Promise.reject(error);
        }
        request.then(
          (result) => {
            if (controller.signal.aborted || latest.current.value !== text) return;
            requestRef.current = null;
            setSuggestion(typeof result === "string" && result ? { base: text, text: result } : null);
          },
          (error: unknown) => {
            if (requestRef.current === controller) requestRef.current = null;
            if (!controller.signal.aborted && !isAbort(error)) latest.current.onSuggestionError?.(error);
          },
        );
      }, latest.current.debounceMs);
    },
    [cancelPending],
  );

  const dismissSuggestion = useCallback(() => {
    cancelPending();
    setSuggestion(null);
  }, [cancelPending]);

  const syncCaret = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    setCaretAtEnd(el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length);
  }, []);

  const syncScroll = useCallback(() => {
    const el = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!el || !mirror) return;
    // Reserve the same scrollbar gutter on the mirror so both layers wrap at the same width.
    mirror.style.overflowY = el.scrollHeight > el.clientHeight ? "scroll" : "hidden";
    mirror.scrollTop = el.scrollTop;
    mirror.scrollLeft = el.scrollLeft;
  }, []);

  const accept = useCallback((): boolean => {
    const el = textareaRef.current;
    const { value: current, suggestion: currentSuggestion } = latest.current;
    const text = remainingGhost(currentSuggestion, current);
    if (!text || !el) return false;
    const next = current + text;
    caretToEndRef.current = true;
    onChange(next);
    onAcceptSuggestion?.(text);
    requestSuggestion(next);
    return true;
  }, [onChange, onAcceptSuggestion, requestSuggestion]);

  useImperativeHandle(
    ref,
    () => ({
      get textarea() {
        return textareaRef.current;
      },
      acceptSuggestion: accept,
      dismissSuggestion,
    }),
    [accept, dismissSuggestion],
  );

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el && caretToEndRef.current) {
      caretToEndRef.current = false;
      el.setSelectionRange(el.value.length, el.value.length);
    }
    syncCaret();
    syncScroll();
  }, [value, visibleGhost, syncCaret, syncScroll]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncScroll());
    observer.observe(el);
    return () => observer.disconnect();
  }, [syncScroll]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    onChange(next);
    if (!disabled && !readOnly) requestSuggestion(next);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing || composing || !visibleGhost) return;
    const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    if (!plain) return;
    const el = event.currentTarget;
    const atEnd = el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length;
    if (event.key === "Tab" || (event.key === "ArrowRight" && atEnd)) {
      if (accept()) event.preventDefault();
    } else if (event.key === "Escape") {
      event.preventDefault();
      dismissSuggestion();
    }
  };

  const handleSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    onSelect?.(event);
    syncCaret();
  };

  const handleFocus = (event: FocusEvent<HTMLTextAreaElement>) => {
    onFocus?.(event);
    setFocused(true);
    syncCaret();
  };

  const handleBlur = (event: FocusEvent<HTMLTextAreaElement>) => {
    onBlur?.(event);
    setFocused(false);
  };

  const handleScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    onScroll?.(event);
    syncScroll();
  };

  const handleCompositionStart = (event: CompositionEvent<HTMLTextAreaElement>) => {
    onCompositionStart?.(event);
    setComposing(true);
  };

  const handleCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    onCompositionEnd?.(event);
    setComposing(false);
  };

  return (
    <div className={className ? `anky-ui-ghost-root ${className}` : "anky-ui-ghost-root"} style={style}>
      <div style={innerStyle}>
        <div ref={mirrorRef} className="anky-ui-ghost-mirror" style={mirrorStyle} aria-hidden="true">
          {value && <span className="anky-ui-ghost-value">{value}</span>}
          {visibleGhost ? (
            <span className="anky-ui-ghost-suggestion" style={ghostStyle}>
              {visibleGhost}
            </span>
          ) : (
            !value &&
            placeholder && (
              <span className="anky-ui-ghost-placeholder" style={ghostStyle}>
                {placeholder}
              </span>
            )
          )}
          {/* Keeps a trailing newline's empty line measurable, as it is in the textarea. */}
          {"\u200b"}
        </div>
        <textarea
          {...textareaProps}
          ref={textareaRef}
          className="anky-ui-ghost-input"
          style={textareaStyle}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          aria-placeholder={placeholder}
          aria-autocomplete="inline"
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onScroll={handleScroll}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
        />
      </div>
      <div className="anky-ui-ghost-status" style={visuallyHidden} aria-live="polite">
        {visibleGhost ? `Suggestion: ${visibleGhost.trim()}${/[.!?]$/.test(visibleGhost.trim()) ? "" : "."} Press Tab to accept.` : ""}
      </div>
    </div>
  );
});
