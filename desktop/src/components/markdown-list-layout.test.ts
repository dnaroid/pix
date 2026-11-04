import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../lib/markdown";
import markdownSource from "./MarkdownText.svelte?raw";

describe("Markdown list marker gutters", () => {
  it.each([
    ["1. One", 1, 1],
    ["19. First\n20. Second\n21. Third", 19, 2],
    ["9. First\n1. Second", 9, 2],
    ["99. First\n1. Second", 99, 3],
    ["999999999. First\n1. Second", 999999999, 10],
    ["0. Zero", 0, 1],
  ])("sizes the gutter from native numbering: %s", (source, start, digits) => {
    const html = renderMarkdown(source);
    expect(html).toContain(`style="--list-marker-width: ${digits}ch"`);
    if (start !== 1) expect(html).toContain(`start="${start}"`);
  });

  it("does not add numeric gutters to bullets or change task checkboxes", () => {
    expect(renderMarkdown("- Bullet")).not.toContain("--list-marker-width");
    expect(renderMarkdown("- [x] Done")).toContain('type="checkbox" disabled checked');
  });

  it("reserves a font-relative outside-marker gutter without changing wrapped text alignment", () => {
    expect(markdownSource).toContain("list-style: decimal outside;");
    expect(markdownSource).toContain("padding-inline-start: calc(var(--list-marker-width, 2ch) + 1em);");
    expect(markdownSource).toContain("font-variant-numeric: tabular-nums;");
  });
});
