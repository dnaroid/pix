import { describe, expect, it } from "vitest";
import { isSafeWikiUrl, splitWikiMarkdown, unsupportedWikiMarkdownNode } from "./wiki-markdown-content";

describe("wiki Markdown preservation", () => {
  it("preserves YAML metadata bytes, including CRLF and BOM", () => {
    const prefix = "\uFEFF---\r\ntitle: 'Game: rules'\r\ndraft: false\r\n---\r\n";
    expect(splitWikiMarkdown(prefix + "# Rules\n")).toEqual({ prefix, body: "# Rules\n" });
  });

  it("preserves TOML frontmatter and does not consume a body horizontal rule", () => {
    const prefix = "+++\ntitle = 'Rules'\n+++\n";
    expect(splitWikiMarkdown(prefix + "Body\n\n---\n")).toEqual({ prefix, body: "Body\n\n---\n" });
    expect(splitWikiMarkdown("# Rules\n\n---\n")).toEqual({ prefix: "", body: "# Rules\n\n---\n" });
  });

  it("requires Source for nested HTML, while retaining code blocks as editable Markdown", () => {
    expect(unsupportedWikiMarkdownNode({ type: "root", children: [
      { type: "blockquote", children: [{ type: "html", value: "<details>" }] },
    ] })).toContain("Source");
    expect(unsupportedWikiMarkdownNode({ type: "root", children: [
      { type: "code", lang: "html", value: "<details>" },
      { type: "paragraph", children: [{ type: "text", value: "Use < to compare" }] },
    ] })).toBeUndefined();
  });
});

describe("wiki URL policy", () => {
  it("accepts document-relative links and images without rewriting them", () => {
    for (const value of ["../assets/game map.png", "./combat.md#damage", "#rules", "https://example.org/rules"])
      expect(isSafeWikiUrl(value)).toBe(true);
    expect(isSafeWikiUrl("images/map.png", true)).toBe(true);
    expect(isSafeWikiUrl("mailto:designer@example.org")).toBe(true);
  });

  it("blocks executable, embedded and unexpected protocols", () => {
    for (const value of ["javascript:alert(1)", "data:image/svg+xml,test", "file:///etc/passwd", "//evil.example/test", "java\nscript:alert(1)"])
      expect(isSafeWikiUrl(value)).toBe(false);
    expect(isSafeWikiUrl("mailto:designer@example.org", true)).toBe(false);
  });
});

