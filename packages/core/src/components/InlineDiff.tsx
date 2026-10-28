"use client";

import {
  FloatingPortal,
  autoUpdate,
  flip,
  hide,
  inline,
  offset,
  shift,
  useFloating,
  type Placement,
} from "@floating-ui/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { announce } from "../a11y/announce";
import { computeDiff, type DiffMode, type DiffSegment } from "../diff/myers";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export interface InlineDiffClassNames {
  root?: string;
  delete?: string;
  insert?: string;
  pending?: string;
  toolbar?: string;
  action?: string;
  accept?: string;
  reject?: string;
  kbd?: string;
}

export interface InlineDiffProps {
  originalText: string;
  modifiedText: string;
  /** @default "word" */
  mode?: DiffMode;
  onAccept: () => void;
  onReject: () => void;
  /**
   * While `true` the diff pulses, Accept is disabled, and the not-yet-rewritten tail of the
   * original is shown as pending instead of deleted.
   */
  isStreaming?: boolean;

  /** Where to render Accept / Reject. @default "floating" */
  toolbar?: "floating" | "inline" | "none";
  /** Floating toolbar placement relative to the diff. @default "bottom-start" */
  toolbarPlacement?: Placement;
  /**
   * Global `Cmd/Ctrl+Enter` (accept) and `Escape` (reject) shortcuts. Ignored while focus is in
   * another text field or the event was already handled. @default true
   */
  shortcuts?: boolean;
  /** Drop the default red/green inline colours and only emit the semantic classes. */
  unstyled?: boolean;
  classNames?: InlineDiffClassNames;
  acceptLabel?: ReactNode;
  rejectLabel?: ReactNode;
}

/** A rendered piece of the diff; `pending` is original text the stream has not reached yet. */
type RenderSegment = { type: DiffSegment["type"] | "pending"; value: string };

/**
 * While streaming, the trailing change region compares a partial rewrite against the whole
 * remaining original. Its deletions aren't real yet, so they are shown as `pending` after the
 * inserted text instead of being struck through.
 */
export function toRenderSegments(segments: DiffSegment[], isStreaming: boolean): RenderSegment[] {
  if (!isStreaming) return segments;
  let tail = segments.length;
  while (tail > 0 && segments[tail - 1].type !== "equal") tail--;
  const head: RenderSegment[] = segments.slice(0, tail);
  const region = segments.slice(tail);
  const inserted = region.filter((s) => s.type === "insert");
  const remaining = region.filter((s) => s.type === "delete").map((s) => s.value).join("");
  return [...head, ...inserted, ...(remaining ? [{ type: "pending" as const, value: remaining }] : [])];
}

const defaultSegmentStyles: Record<"delete" | "insert" | "pending", CSSProperties> = {
  delete: {
    backgroundColor: "var(--anky-ui-diff-delete-bg, #FEE2E2)",
    color: "var(--anky-ui-diff-delete-fg, #991B1B)",
    textDecoration: "line-through",
  },
  insert: {
    backgroundColor: "var(--anky-ui-diff-insert-bg, #DCFCE7)",
    color: "var(--anky-ui-diff-insert-fg, #166534)",
    textDecoration: "none",
  },
  pending: { opacity: 0.5 },
};

/** Tailwind classes for the toolbar. The diff colours are inline by default (see `unstyled`). */
export const inlineDiffTailwindPreset = Object.freeze({
  toolbar:
    "z-50 inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-1 text-xs shadow-md " +
    "dark:border-zinc-700 dark:bg-zinc-900",
  action:
    "inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium disabled:cursor-not-allowed " +
    "disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
  accept: "bg-emerald-600 text-white hover:bg-emerald-700",
  reject: "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800",
  kbd: "rounded border border-current/30 px-1 font-mono text-[0.7rem] opacity-80",
} satisfies InlineDiffClassNames);

function cx(...classes: Array<string | undefined | false>): string {
  return classes.filter(Boolean).join(" ");
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  if (target.tagName === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "range", "reset", "submit", "color", "file", "image"].includes(type);
  }
  if (target.isContentEditable) return true;
  const host = target.closest("[contenteditable]");
  return host !== null && host.getAttribute("contenteditable") !== "false";
}

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const PULSE_KEYFRAMES: Keyframe[] = [{ opacity: 1 }, { opacity: 0.6 }, { opacity: 1 }];

/**
 * Inline visual diff between `originalText` and `modifiedText` with Accept / Reject controls.
 *
 * Deletions render as `<del class="anky-ui-diff-delete">` (red + strikethrough) and insertions as
 * `<ins class="anky-ui-diff-insert">` (green); unchanged text is plain. Colours can be themed with
 * `--anky-ui-diff-{delete,insert}-{bg,fg}` or removed with `unstyled`.
 *
 * While `isStreaming`, the root gets `data-streaming` / `aria-busy` and a subtle opacity pulse via
 * the Web Animations API (skipped under `prefers-reduced-motion`), so no stylesheet is required.
 */
export function InlineDiff({
  originalText,
  modifiedText,
  mode = "word",
  onAccept,
  onReject,
  isStreaming = false,
  toolbar = "floating",
  toolbarPlacement = "bottom-start",
  shortcuts = true,
  unstyled = false,
  classNames,
  acceptLabel = "Accept",
  rejectLabel = "Reject",
}: InlineDiffProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => setIsMac(detectMac()), []);

  const segments = useMemo(
    () => toRenderSegments(computeDiff(originalText, modifiedText, mode), isStreaming),
    [originalText, modifiedText, mode, isStreaming],
  );

  const latest = useRef({ onAccept, onReject, isStreaming });
  latest.current = { onAccept, onReject, isStreaming };

  const accept = useCallback(() => {
    if (!latest.current.isStreaming) latest.current.onAccept();
  }, []);
  const reject = useCallback(() => latest.current.onReject(), []);

  useEffect(() => {
    if (!shortcuts) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isTextEntry(event.target)) return;
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        if (latest.current.isStreaming) return;
        event.preventDefault();
        accept();
      } else if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        reject();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shortcuts, accept, reject]);

  // Screen readers get a short status instead of every streamed token.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (isStreaming) {
      announce("AI is writing a suggestion.");
    } else if (wasStreaming.current) {
      const inserts = segments.filter((s) => s.type === "insert").length;
      const deletes = segments.filter((s) => s.type === "delete").length;
      announce(
        `Suggestion ready: ${plural(inserts, "insertion")}, ${plural(deletes, "deletion")}. ` +
          `Press ${isMac ? "Command" : "Control"} Enter to accept or Escape to reject.`,
      );
    }
    wasStreaming.current = isStreaming;
    // `segments` is intentionally omitted: the summary is only read when streaming ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  useEffect(() => {
    const el = rootRef.current;
    if (!isStreaming || !el || typeof el.animate !== "function") return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = el.animate(PULSE_KEYFRAMES, { duration: 1400, iterations: Infinity, easing: "ease-in-out" });
    return () => animation.cancel();
  }, [isStreaming]);

  const floating = toolbar === "floating";
  const { refs, floatingStyles, isPositioned, middlewareData } = useFloating({
    open: floating,
    placement: toolbarPlacement,
    // Long diffs: `shift` on both axes keeps the toolbar pinned inside the viewport while the diff is
    // partially visible; `hide` removes it once the diff is scrolled out entirely.
    middleware: [
      inline(),
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8, crossAxis: true }),
      hide({ strategy: "referenceHidden" }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const referenceHidden = !!middlewareData.hide?.referenceHidden;

  const setRoot = useCallback(
    (node: HTMLSpanElement | null) => {
      rootRef.current = node;
      refs.setReference(node);
    },
    [refs],
  );

  const segmentStyle = (type: RenderSegment["type"]) =>
    unstyled || type === "equal" ? undefined : defaultSegmentStyles[type];

  const actions = (
    <>
      <button
        type="button"
        className={cx("anky-ui-diff-action", "anky-ui-diff-accept", classNames?.action, classNames?.accept)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={accept}
        disabled={isStreaming}
        aria-keyshortcuts={isMac ? "Meta+Enter" : "Control+Enter"}
      >
        {acceptLabel}
        <kbd className={cx("anky-ui-diff-kbd", classNames?.kbd)} aria-hidden="true">
          {isMac ? "⌘ Enter" : "Ctrl+Enter"}
        </kbd>
      </button>
      <button
        type="button"
        className={cx("anky-ui-diff-action", "anky-ui-diff-reject", classNames?.action, classNames?.reject)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={reject}
        aria-keyshortcuts="Escape"
      >
        {rejectLabel}
        <kbd className={cx("anky-ui-diff-kbd", classNames?.kbd)} aria-hidden="true">
          Esc
        </kbd>
      </button>
    </>
  );

  const toolbarProps = {
    role: "toolbar",
    "aria-label": "Review AI edit",
    "data-streaming": isStreaming || undefined,
  } as const;

  return (
    <>
      <span
        ref={setRoot}
        className={cx("anky-ui-diff-root", classNames?.root)}
        role="group"
        aria-label="AI suggested edit"
        data-streaming={isStreaming || undefined}
        aria-busy={isStreaming || undefined}
      >
        {segments.map((segment, i) => {
          switch (segment.type) {
            case "equal":
              return <span key={i}>{segment.value}</span>;
            case "delete":
              return (
                <del key={i} className={cx("anky-ui-diff-delete", classNames?.delete)} style={segmentStyle("delete")}>
                  {segment.value}
                </del>
              );
            case "insert":
              return (
                <ins key={i} className={cx("anky-ui-diff-insert", classNames?.insert)} style={segmentStyle("insert")}>
                  {segment.value}
                </ins>
              );
            case "pending":
              return (
                <span key={i} className={cx("anky-ui-diff-pending", classNames?.pending)} style={segmentStyle("pending")}>
                  {segment.value}
                </span>
              );
          }
        })}
        {toolbar === "inline" && (
          <span {...toolbarProps} className={cx("anky-ui-diff-toolbar", classNames?.toolbar)} contentEditable={false}>
            {actions}
          </span>
        )}
      </span>
      {floating && (
        <FloatingPortal>
          <div
            {...toolbarProps}
            ref={refs.setFloating}
            className={cx("anky-ui-diff-toolbar", classNames?.toolbar)}
            style={{ ...floatingStyles, visibility: isPositioned && !referenceHidden ? undefined : "hidden" }}
          >
            {actions}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

/** {@link InlineDiff} with {@link inlineDiffTailwindPreset} applied; `classNames` are appended. */
export function StyledInlineDiff({ classNames, ...props }: InlineDiffProps) {
  const preset = inlineDiffTailwindPreset;
  return (
    <InlineDiff
      {...props}
      classNames={{
        ...classNames,
        toolbar: cx(preset.toolbar, classNames?.toolbar),
        action: cx(preset.action, classNames?.action),
        accept: cx(preset.accept, classNames?.accept),
        reject: cx(preset.reject, classNames?.reject),
        kbd: cx(preset.kbd, classNames?.kbd),
      }}
    />
  );
}
