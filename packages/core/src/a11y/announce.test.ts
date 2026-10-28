// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { announce } from "./announce";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("announce", () => {
  it("creates a polite status region and writes the message", () => {
    announce("Hello");
    const node = document.querySelector('[role="status"]');
    expect(node?.getAttribute("aria-live")).toBe("polite");
    expect(node?.textContent).toBe("Hello");
  });

  it("uses an alert region for assertive messages and reuses regions", () => {
    announce("Oops", "assertive");
    announce("Again", "assertive");
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Again");
  });

  it("re-announces identical text", () => {
    announce("Same");
    announce("Same");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Same\u00a0");
  });

  it("clears the region after a delay", () => {
    vi.useFakeTimers();
    announce("Temp");
    vi.advanceTimersByTime(5001);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("");
  });
});
