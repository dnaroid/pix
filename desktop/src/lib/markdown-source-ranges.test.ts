import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("Markdown source range annotations", () => {
  it("is opt-in and does not change ordinary rendering", () => {
    expect(renderMarkdown("# Page\n\nText")).toBe("<h1>Page</h1><p>Text</p>");
  });

  it("maps original lines across every top-level block without extra wrappers", () => {
    const source = ["# Page", "", "Two", "lines", "", "- one", "- two", "", "> quote", "> next", "", "```ts", "code", "```", "", "| A |", "| - |", "| B |", "", "---"].join("\n");
    const html = renderMarkdown(source, { sourceLineRanges: true });
    for (const [tag, start, end] of [["h1", 1, 1], ["p", 3, 4], ["ul", 6, 7], ["blockquote", 9, 10], ["pre", 12, 14], ["div", 16, 18], ["hr", 20, 20]]) {
      expect(html).toContain(`<${tag} data-source-start-line="${start}" data-source-end-line="${end}"`);
    }
    expect(html.match(/data-source-start-line/g)).toHaveLength(7);
  });

  it("retains line positions after hidden DCP metadata and CRLF normalization", () => {
    const html = renderMarkdown("# Page\r\n<dcp-message-ids>\r\nprivate\r\n</dcp-message-ids>\r\n\r\nTarget", { sourceLineRanges: true });
    expect(html).not.toContain("private");
    expect(html).toContain('<p data-source-start-line="6" data-source-end-line="6">Target</p>');
  });

  it("annotates math and Mermaid blocks as well", () => {
    const html = renderMarkdown("$$\nx^2\n$$\n\n```mermaid\ngraph TD; A-->B\n```", { sourceLineRanges: true });
    expect(html).toContain('data-source-start-line="1" data-source-end-line="3"');
    expect(html).toContain('<figure data-source-start-line="5" data-source-end-line="7"');
  });
});
