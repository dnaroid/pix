import { describe, expect, test } from "bun:test";
import path from "node:path";
import { localMarkdownDiagnostics } from "../src/lsp/markdown-diagnostics";
import { markdownLinkText, parseMarkdownTokens } from "../src/lsp/markdown-parser";

const file = path.resolve("wiki-regression.md");
const metadata = '<!-- pix:wiki-report {"notices":["notice"],"coverage":{"limits":["query-sampling","candidate-limit"]},"quote":"[hidden][missing] [file](./absent-wiki-file.md)"} -->';

describe("Markdown LSP non-link regions", () => {
  test("returns HTML block maps needed by the language server link scanner", () => {
    const tokens = parseMarkdownTokens(`${metadata}\n\n# Heading\n\n[visible][missing]\n`);
    expect(tokens[0]).toMatchObject({ type: "html_block", map: [0, 1] });
    expect(tokens.find(token => token.type === "heading_open")).toMatchObject({ map: [2, 3] });
    expect(tokens.find(token => token.type === "inline" && token.content === "[visible][missing]")).toBeDefined();
  });

  test("ignores Wiki JSON, quoted links and definitions in comments", () => {
    const text = `${metadata}\n\n<!--\n[dup]: ./a.md\n[dup]: ./b.md\n[hidden][missing]\n-->\n`;
    expect(localMarkdownDiagnostics(file, text)).toEqual([]);
  });

  test.each(["\n", "\r\n"])("preserves real link diagnostics and positions with %j endings", newline => {
    const text = [metadata, "", "[visible][missing]", "[file](./absent-wiki-file.md)"].join(newline);
    const diagnostics = localMarkdownDiagnostics(file, text);
    expect(diagnostics.map(item => item.code)).toEqual(["link.no-such-reference", "link.no-such-file"]);
    expect(diagnostics[0].range.start).toEqual({ line: 2, character: 10 });
    expect(diagnostics[1].range.start).toEqual({ line: 3, character: 7 });
    expect(markdownLinkText(text).length).toBe(text.length);
  });

  test("hidden definitions cannot resolve visible references", () => {
    const diagnostics = localMarkdownDiagnostics(file, "<!--\n[missing]: ./a.md\n-->\n\n[visible][missing]");
    expect(diagnostics.map(item => item.code)).toEqual(["link.no-such-reference"]);
  });

  test("keeps valid, duplicate and unused visible definitions working", () => {
    const text = `${metadata}\n\n[ok][valid]\n[valid]: ./a.md\n[dup]: ./b.md\n[dup]: ./c.md`;
    const diagnostics = localMarkdownDiagnostics(file, text);
    expect(diagnostics.filter(item => item.code === "link.no-such-reference")).toEqual([]);
    expect(diagnostics.filter(item => item.code === "link.duplicate-definition")).toHaveLength(2);
    expect(diagnostics.filter(item => item.code === "link.unused-definition")).toHaveLength(2);
  });

  test("handles inline comments and code without hiding following links", () => {
    const text = 'Text <!-- [hidden][nope] --> `[code][nope]` `` ` [code][nope] `` [real][missing]';
    const diagnostics = localMarkdownDiagnostics(file, text);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].range.start.character).toBe(text.lastIndexOf("missing"));
  });

  test("code containing a comment opener does not hide subsequent prose", () => {
    expect(localMarkdownDiagnostics(file, '`<!--` [real][missing]').map(item => item.code)).toEqual(["link.no-such-reference"]);
    expect(localMarkdownDiagnostics(file, '` unmatched [real][missing]').map(item => item.code)).toEqual(["link.no-such-reference"]);
  });

  test("ignores fenced and indented examples but retains Mermaid checks", () => {
    const text = ['```md', '# Not a heading', '[example][missing]', '```', '', '    [example][missing]', '', '```mermaid', 'flowchart TD', 'A -> B', '```'].join('\n');
    expect(parseMarkdownTokens(text).some(token => token.type === "heading_open")).toBe(false);
    expect(localMarkdownDiagnostics(file, text).map(item => item.code)).toEqual(["mermaid.invalid-arrow"]);
  });
});
