// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SSRFixture } from "../test/ssrFixture";

describe("server rendering (no DOM globals)", () => {
  it("runs without window/document", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
  });

  it("renders every component and hook without touching browser APIs", () => {
    const html = renderToString(<SSRFixture />);
    // Diff and ghost input render their content on the server…
    expect(html).toContain('class="anky-ui-diff-root"');
    expect(html).toContain("<del");
    expect(html).toContain("<ins");
    expect(html).toContain('class="anky-ui-ghost-input"');
    expect(html).toContain("Draft text");
    // …selection-driven UI and the floating toolbar portal only appear on the client (the inline toolbar renders).
    expect(html).not.toContain("anky-ui-palette-root");
    expect(html.match(/class="anky-ui-diff-toolbar"/g)).toHaveLength(1);
    expect(html).toContain('contentEditable="false"');
    expect(html).toContain('data-anchor-open="false"');
  });
});
