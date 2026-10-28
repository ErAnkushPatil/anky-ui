// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InlineDiff } from "./InlineDiff";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const status = () => document.querySelector('[role="status"]')?.textContent ?? "";

describe("InlineDiff accessibility", () => {
  it("labels the edit as a group and announces streaming start and completion", () => {
    const props = { originalText: "the cat sat", onAccept: () => undefined, onReject: () => undefined };
    const { rerender, container } = render(<InlineDiff {...props} modifiedText="the" isStreaming />);
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("AI suggested edit");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(status()).toBe("AI is writing a suggestion.");

    rerender(<InlineDiff {...props} modifiedText="the dog sat" isStreaming={false} />);
    expect(status()).toMatch(/^Suggestion ready: 1 insertion, 1 deletion\. Press (Control|Command) Enter to accept or Escape to reject\.$/);
  });

  it("does not announce when nothing streamed", () => {
    render(<InlineDiff originalText="a" modifiedText="b" onAccept={() => undefined} onReject={() => undefined} />);
    expect(status()).toBe("");
  });
});
