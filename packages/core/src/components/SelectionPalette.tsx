"use client";

import {
  FloatingPortal,
  autoUpdate,
  flip,
  hide,
  inline,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  type OpenChangeReason,
  type Placement,
} from "@floating-ui/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { announce } from "../a11y/announce";
import { useSelectionAnchor, type UseSelectionAnchorResult } from "../dom/useSelectionAnchor";

/**
 * Keeps the palette on-screen while the selection scrolls: `flip` switches sides when one side runs out of
 * room, `shift` clamps it inside the viewport on both axes (for selections taller than the viewport), and
 * `hide` reports when the selection itself is scrolled out of view.
 */
const paletteMiddleware = (sideOffset: number) => [
  inline(),
  offset(sideOffset),
  flip({ padding: 8 }),
  shift({ padding: 8, crossAxis: true }),
  hide({ strategy: "referenceHidden" }),
];

/**
 * `autoUpdate` only watches the overflow *ancestors* of a virtual element's `contextElement`. When the
 * selection sits directly inside a scrollable editor (e.g. `<div contenteditable style="overflow:auto">`),
 * that editor is the context element itself, so its scrolling would leave the palette stranded.
 */
const autoUpdateSelection: typeof autoUpdate = (reference, floating, update, options) => {
  const cleanup = autoUpdate(reference, floating, update, options);
  const context = reference instanceof Element ? undefined : reference.contextElement;
  if (!context) return cleanup;
  context.addEventListener("scroll", update, { passive: true });
  return () => {
    cleanup();
    context.removeEventListener("scroll", update);
  };
};

/** A preset prompt rendered as a pill in the palette. */
export interface SelectionPaletteAction {
  label: string;
  icon?: ReactNode;
  prompt: string;
}

/** Extra class names merged onto each slot, after the semantic `anky-ui-palette-*` class. */
export interface SelectionPaletteClassNames {
  root?: string;
  actions?: string;
  action?: string;
  actionIcon?: string;
  input?: string;
}

export interface SelectionPaletteProps {
  /** Preset pills. Defaults to {@link DEFAULT_PALETTE_ACTIONS}; pass `[]` to render none. */
  actions?: SelectionPaletteAction[];
  /** Called with the chosen preset prompt or freeform input, plus the text that was highlighted. */
  onSelectPrompt: (prompt: string, selectedText: string) => void;
  customInputPlaceholder?: string;
  /** Extra content rendered at the end of the bar (e.g. a model picker or a loading indicator). */
  children?: ReactNode;

  /** Only selections inside this element open the palette. Defaults to the whole document. */
  containerRef?: RefObject<HTMLElement | null>;
  /**
   * Drive the palette from a rich-text editor instead of the DOM selection: pass the result of
   * `useEditorAnchor(adapter)`. `containerRef`/`minChars` are then ignored (set them on the hook).
   */
  anchor?: UseSelectionAnchorResult;
  /** Minimum selected characters (whitespace-trimmed) required to open. @default 1 */
  minChars?: number;
  /** @default true */
  enabled?: boolean;
  /** @default "top" */
  placement?: Placement;
  /** Gap between the selection and the bar, in px. @default 8 */
  sideOffset?: number;
  /** Close the palette and re-select the original text after a prompt is chosen. @default true */
  closeOnSelect?: boolean;
  classNames?: SelectionPaletteClassNames;
  /** Accessible name of the toolbar. @default "AI actions" */
  "aria-label"?: string;
}

export const DEFAULT_PALETTE_ACTIONS: readonly SelectionPaletteAction[] = Object.freeze([
  { label: "Fix Grammar", prompt: "Fix the grammar and spelling of the following text without changing its meaning." },
  { label: "Shorten", prompt: "Make the following text shorter while preserving its meaning." },
  { label: "Translate", prompt: "Translate the following text to English." },
]);

/**
 * Tailwind utility classes for every palette slot. Use via {@link StyledSelectionPalette}, or pass
 * to `classNames` and override individual slots.
 *
 * Tailwind only generates classes it can see: add the package to your sources, e.g.
 * `@source "../node_modules/@erankushpatil/anky-ui/dist";` (v4) or the `content` array (v3).
 */
export const selectionPaletteTailwindPreset = Object.freeze({
  root:
    "z-50 flex max-w-[min(36rem,calc(100vw-1rem))] items-center gap-1 rounded-xl border border-zinc-200 " +
    "bg-white/95 p-1 text-sm text-zinc-900 shadow-lg backdrop-blur " +
    "dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-100",
  actions: "flex shrink-0 items-center gap-1",
  action:
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 font-medium " +
    "hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 " +
    "dark:hover:bg-zinc-800",
  actionIcon: "inline-flex size-4 items-center justify-center",
  input:
    "min-w-0 flex-1 rounded-lg bg-transparent px-2.5 py-1.5 placeholder:text-zinc-400 " +
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
} satisfies Required<SelectionPaletteClassNames>);

function cx(...classes: Array<string | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Floating AI action bar anchored to the user's text selection.
 *
 * Unstyled: only the semantic classes `anky-ui-palette-root`, `anky-ui-palette-actions`,
 * `anky-ui-palette-action`, `anky-ui-palette-action-icon` and `anky-ui-palette-input` are applied, plus
 * whatever is passed in `classNames`. See {@link StyledSelectionPalette} for a Tailwind preset.
 *
 * Keyboard: `Enter` in the input submits the freeform prompt (ignored while an IME is composing);
 * `Escape` anywhere closes the palette and returns focus and the selection to the editor;
 * `ArrowLeft`/`ArrowRight`/`Home`/`End` move between pills (WAI-ARIA toolbar pattern).
 *
 * Clicking a pill does not steal focus, so the editor selection stays intact.
 */
export function SelectionPalette({
  actions = DEFAULT_PALETTE_ACTIONS as SelectionPaletteAction[],
  onSelectPrompt,
  customInputPlaceholder = "Ask AI to edit…",
  children,
  containerRef,
  anchor,
  minChars,
  enabled = true,
  placement = "top",
  sideOffset = 8,
  closeOnSelect = true,
  classNames,
  "aria-label": ariaLabel = "AI actions",
}: SelectionPaletteProps) {
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [inputValue, setInputValue] = useState("");

  const domAnchor = useSelectionAnchor({
    enabled: enabled && !anchor,
    minChars,
    containerRef,
    floatingRef,
  });
  const active = anchor ?? domAnchor;
  const { selectedText, close, restoreSelection } = active;
  const isOpen = enabled && active.isOpen;
  const virtualElement = enabled ? active.virtualElement : null;

  /** Closes the palette and hands focus + selection back to the editor. */
  const dismiss = useCallback(() => {
    // Move focus out first: blurring the input after re-selecting can drop the restored range.
    const active = document.activeElement;
    if (active instanceof HTMLElement && floatingRef.current?.contains(active)) {
      const target = returnFocusRef.current;
      if (target?.isConnected && target !== document.body) target.focus({ preventScroll: true });
      else active.blur();
    }
    close();
    restoreSelection();
  }, [close, restoreSelection]);

  const onOpenChange = useCallback(
    (open: boolean, _event?: Event, reason?: OpenChangeReason) => {
      if (!open && reason === "escape-key") dismiss();
    },
    [dismiss],
  );

  const { refs, floatingStyles, context, isPositioned, middlewareData } = useFloating({
    open: isOpen,
    onOpenChange,
    placement,
    middleware: paletteMiddleware(sideOffset),
    whileElementsMounted: autoUpdateSelection,
  });
  const referenceHidden = !!middlewareData.hide?.referenceHidden;

  // Clicks outside are handled by useSelectionAnchor (a new selection replaces the old one);
  // floating-ui only owns the Escape key.
  const { getFloatingProps } = useInteractions([useDismiss(context, { outsidePress: false })]);

  useLayoutEffect(() => {
    refs.setPositionReference(virtualElement);
  }, [refs, virtualElement]);

  // Remember where focus was when this selection opened the palette, to return it on Escape.
  useLayoutEffect(() => {
    if (!virtualElement) return;
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && !floatingRef.current?.contains(active) ? active : null;
  }, [virtualElement]);

  // A new selection starts with a fresh prompt.
  useEffect(() => {
    setInputValue("");
  }, [virtualElement]);

  // Selecting text with a pointer or keyboard never moves focus, so tell screen readers the palette
  // exists and offer Alt+/ as a keyboard route into it.
  useEffect(() => {
    if (!isOpen || !virtualElement) return;
    announce(`AI actions available for the selected text. Press Alt plus slash to focus them.`);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== "Slash") return;
      const first = floatingRef.current?.querySelector<HTMLElement>(".anky-ui-palette-action, .anky-ui-palette-input");
      if (!first) return;
      event.preventDefault();
      first.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, virtualElement]);

  const setFloating = useCallback(
    (node: HTMLDivElement | null) => {
      floatingRef.current = node;
      refs.setFloating(node);
    },
    [refs],
  );

  const submit = (prompt: string) => {
    const text = selectedText;
    setInputValue("");
    if (closeOnSelect) dismiss();
    onSelectPrompt(prompt, text);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Enter during IME composition confirms the composition, not the prompt.
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const prompt = inputValue.trim();
    if (prompt) submit(prompt);
  };

  const onToolbarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT") return; // arrows move the caret there
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(".anky-ui-palette-action, .anky-ui-palette-input"),
    );
    const index = items.indexOf(target);
    if (index === -1) return;
    const next =
      event.key === "ArrowRight" ? items[(index + 1) % items.length]
      : event.key === "ArrowLeft" ? items[(index - 1 + items.length) % items.length]
      : event.key === "Home" ? items[0]
      : event.key === "End" ? items[items.length - 1]
      : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  if (!isOpen || !virtualElement) return null;

  return (
    <FloatingPortal>
      <div
        {...getFloatingProps({
          ref: setFloating,
          role: "toolbar",
          "aria-label": ariaLabel,
          "aria-orientation": "horizontal",
          "aria-keyshortcuts": "Alt+/",
          className: cx("anky-ui-palette-root", classNames?.root),
          // Hidden until the first position is computed, so it never flashes at (0, 0).
          style: { ...floatingStyles, visibility: isPositioned && !referenceHidden ? undefined : "hidden" },
          onKeyDown: onToolbarKeyDown,
        })}
        data-placement={context.placement}
      >
        {actions.length > 0 && (
          <div className={cx("anky-ui-palette-actions", classNames?.actions)} role="group">
            {actions.map((action, i) => (
              <button
                key={`${i}:${action.label}`}
                type="button"
                className={cx("anky-ui-palette-action", classNames?.action)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => submit(action.prompt)}
              >
                {action.icon != null && (
                  <span className={cx("anky-ui-palette-action-icon", classNames?.actionIcon)} aria-hidden="true">
                    {action.icon}
                  </span>
                )}
                {action.label}
              </button>
            ))}
          </div>
        )}
        <input
          type="text"
          className={cx("anky-ui-palette-input", classNames?.input)}
          placeholder={customInputPlaceholder}
          aria-label={customInputPlaceholder}
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          onKeyDown={onInputKeyDown}
          autoComplete="off"
        />
        {children}
      </div>
    </FloatingPortal>
  );
}

/** {@link SelectionPalette} pre-styled with {@link selectionPaletteTailwindPreset}; `classNames` are appended. */
export function StyledSelectionPalette({ classNames, ...props }: SelectionPaletteProps) {
  const preset = selectionPaletteTailwindPreset;
  return (
    <SelectionPalette
      {...props}
      classNames={{
        root: cx(preset.root, classNames?.root),
        actions: cx(preset.actions, classNames?.actions),
        action: cx(preset.action, classNames?.action),
        actionIcon: cx(preset.actionIcon, classNames?.actionIcon),
        input: cx(preset.input, classNames?.input),
      }}
    />
  );
}
