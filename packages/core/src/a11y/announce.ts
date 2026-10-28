export type AnnouncePoliteness = "polite" | "assertive";

const REGION_ATTR = "data-anky-ui-live";
const CLEAR_AFTER_MS = 5000;

const hiddenStyle =
  "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0";

const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function region(politeness: AnnouncePoliteness): HTMLElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  const existing = document.body.querySelector<HTMLElement>(`[${REGION_ATTR}="${politeness}"]`);
  if (existing) return existing;
  const node = document.createElement("div");
  node.setAttribute(REGION_ATTR, politeness);
  node.setAttribute("role", politeness === "assertive" ? "alert" : "status");
  node.setAttribute("aria-live", politeness);
  node.setAttribute("aria-atomic", "true");
  node.setAttribute("style", hiddenStyle);
  document.body.appendChild(node);
  return node;
}

/**
 * Send a message to screen readers through a shared, visually hidden live region.
 *
 * The region is created lazily in `document.body` (client only; a no-op during SSR) and emptied
 * after a few seconds. Repeating an identical message is still announced.
 *
 * @example
 * announce("Suggestion ready: 3 insertions, 1 deletion.");
 */
export function announce(message: string, politeness: AnnouncePoliteness = "polite"): void {
  const node = region(politeness);
  if (!node || !message) return;
  const previous = timers.get(node);
  if (previous) clearTimeout(previous);
  // Re-announce identical text by toggling a trailing non-breaking space.
  node.textContent = node.textContent === message ? `${message}\u00a0` : message;
  timers.set(
    node,
    setTimeout(() => {
      node.textContent = "";
    }, CLEAR_AFTER_MS),
  );
}
