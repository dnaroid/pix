import { describe, expect, it } from "vitest";
import { highlightCode, languageForFilePath, languageForReadTool } from "./syntax-highlight";

describe("syntax highlighting", () => {
  it("keeps large code as escaped, untruncated lines without token markup", () => {
    const line = 'const value = "<script>&\\\"";';
    const source = `${Array.from({ length: 4000 }, () => line).join("\n")}\n`;
    const result = highlightCode(source, "typescript");
    expect(result.language).toBe("plaintext");
    expect(result.html).not.toContain("sh__token");
    expect(result.html).not.toContain("<script>");
    expect(result.html.match(/class="sh__line"/g)).toHaveLength(4001);
    expect(result.html.match(/&lt;script&gt;&amp;/g)).toHaveLength(4000);
    expect(result.html.length).toBeLessThan(source.length * 4);
    expect(result.html.endsWith('<span class="sh__line"></span>')).toBe(true);
  });

  it("preserves empty lines and CRLF in plaintext fallback", () => {
    expect(highlightCode("\r\ntext\r\n\n").html).toBe([
      '<span class="sh__line">\r</span>',
      '<span class="sh__line">text\r</span>',
      '<span class="sh__line"></span>',
      '<span class="sh__line"></span>',
    ].join("\n"));
  });

  it("normalizes Markdown aliases and safely falls back to plaintext", () => {
    const typescript = highlightCode("const ready: boolean = true;", "tsx");
    const unknown = highlightCode("<script>alert(1)</script>", "not-a-language");

    expect(typescript.language).toBe("typescript");
    expect(typescript.html).toContain("sh__token--keyword");
    expect(unknown.language).toBe("plaintext");
    expect(unknown.html).toContain("&lt;script&gt;");
    expect(unknown.html).not.toContain("<script>");
  });

  it("detects languages from extensions and special filenames", () => {
    expect(languageForFilePath("/workspace/src/App.svelte.ts?raw=1")).toBe("typescript");
    expect(languageForFilePath("/workspace/src/App.svelte")).toBe("html");
    expect(languageForFilePath("C:\\workspace\\Dockerfile")).toBe("dockerfile");
    expect(languageForFilePath("/workspace/config.jsonc")).toBe("json");
    expect(languageForFilePath("/workspace/Makefile")).toBeUndefined();
  });

  it("highlights file reads without treating directory listings as code", () => {
    expect(languageForReadTool("read", "Read src/main.rs", "/workspace/src/main.rs")).toBe("rust");
    expect(languageForReadTool("read", "Read app.py")).toBe("python");
    expect(languageForReadTool("read", "Ls src", "/workspace/src")).toBeUndefined();
    expect(languageForReadTool("execute", "Read src/main.ts", "/workspace/src/main.ts")).toBeUndefined();
  });

  it("identifies Markdown file reads for Markdown rendering", () => {
    expect(languageForReadTool("read", "Read README.md", "/workspace/README.md")).toBe("markdown");
    expect(languageForReadTool("read", "Read docs/guide.markdown")).toBe("markdown");
    expect(languageForReadTool("read", "Ls docs", "/workspace/docs/readme.md")).toBeUndefined();
  });
});
