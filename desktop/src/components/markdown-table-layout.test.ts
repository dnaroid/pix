import { describe, expect, it } from "vitest";
import markdownSource from "./MarkdownText.svelte?raw";

function declarations(selector: string): string {
  const start = markdownSource.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return markdownSource.slice(start, markdownSource.indexOf("}", start) + 1);
}

describe("Markdown table wrapping", () => {
  it("preserves word widths when fitting Preview columns, including inline identifiers", () => {
    const cells = declarations(".markdown-text.fit-tables :global(td)");
    // Unlike anywhere, break-word does not count letter breaks in min-content sizing.
    expect(cells).toContain("overflow-wrap: break-word;");
    expect(cells).toContain("word-break: normal;");
    expect(cells).toContain("white-space: normal;");
    expect(cells).not.toContain("overflow-wrap: anywhere;");
    expect(declarations(".markdown-text.fit-tables :global(table)")).toContain("table-layout: auto;");
  });

  it("retains a scroll fallback for intrinsically wide tables without changing transcript layout", () => {
    expect(declarations(".markdown-text :global(.table-scroll)")).toContain("overflow-x: auto;");
    expect(declarations(".markdown-text.fit-tables :global(.table-scroll)")).not.toContain("overflow-x:");
    expect(declarations(".markdown-text :global(table)")).toContain("width: max-content;");
    expect(declarations(".markdown-text.fit-tables :global(table)")).toContain("width: 100%;");
  });
});
