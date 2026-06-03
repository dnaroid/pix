import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { syntaxHighlightLanguageForMarkdownFence, syntaxHighlightLanguageForPath, syntaxHighlightSegmentsForLine } from "../src/syntax-highlight.js";
import { THEMES } from "../src/theme.js";

const colors = THEMES.dark.colors;

describe("syntax highlighting", () => {
	it("detects languages from file names, extensions, and markdown fences", () => {
		assert.equal(syntaxHighlightLanguageForPath("src/app.ts"), "typescript");
		assert.equal(syntaxHighlightLanguageForPath("types/app.d.ts"), "typescript");
		assert.equal(syntaxHighlightLanguageForPath("Dockerfile"), "shell");
		assert.equal(syntaxHighlightLanguageForPath("README.unknown"), undefined);
		assert.equal(syntaxHighlightLanguageForMarkdownFence(" {.tsx} title=demo "), "typescript");
		assert.equal(syntaxHighlightLanguageForMarkdownFence("py"), "python");
		assert.equal(syntaxHighlightLanguageForMarkdownFence(""), undefined);
	});

	it("highlights common code token styles across supported languages", () => {
		assertStyles("const answer: number = 42 // ok", "typescript", ["keyword", "property", "number", "comment"]);
		assertStyles("def f(x): return True # ok", "python", ["keyword", "number", "comment"]);
		assertStyles("package main // ok", "go", ["keyword", "comment"]);
		assertStyles("fn main() { let v: Option<i32> = None; }", "rust", ["keyword", "property", "number"]);
		assertStyles("public class App { String s = null; }", "java", ["keyword", "property", "number"]);
		assertStyles("int main() { return NULL; }", "c", ["property", "keyword", "number"]);
		assertStyles("auto value = nullptr; // ok", "cpp", ["keyword", "number", "comment"]);
		assertStyles("var ok = true;", "csharp", ["property", "number"]);
		assertStyles("if true; then echo 'ok'; fi # done", "shell", ["keyword", "number", "string", "comment"]);
	});

	it("highlights json, yaml, html, css, and markdown structures", () => {
		assertStyles('{ "name": "pix", "ok": true, "n": -1 } // note', "json", ["property", "string", "number", "comment"]);
		assertStyles('name: "pix" # comment', "yaml", ["property", "string", "comment"]);
		assertStyles('<a href="/docs">Docs</a><!-- note -->', "html", ["keyword", "property", "string", "comment"]);
		assertStyles('@media screen { color: #fff; width: 10px; content: "x"; }', "css", ["keyword", "property", "number", "string"]);
		assertStyles('# Title', "markdown", ["keyword"]);
		assertStyles('- [link](https://example.test) `code` **bold** *em*', "markdown", ["keyword", "string", "emphasis"]);
		assertStyles('escaped \\*not emphasis\\* but “*yes*”', "markdown", ["emphasis"]);
	});

	it("offsets line highlights and ignores out-of-range starts", () => {
		const text = "prefix const value = 1";
		const segments = syntaxHighlightSegmentsForLine(text, { language: "typescript", start: 7 }, colors);

		assert.ok(segments.every((segment) => segment.start >= 7));
		assert.deepEqual(syntaxHighlightSegmentsForLine(text, { language: "typescript", start: text.length }, colors), []);
	});
});

function assertStyles(text: string, language: Parameters<typeof syntaxHighlightSegmentsForLine>[1]["language"], expectedStyles: string[]): void {
	const found = new Set(syntaxHighlightSegmentsForLine(text, { language, start: 0 }, colors).map((segment) => styleForSegment(segment)));
	for (const style of expectedStyles) assert.equal(found.has(style), true, `${language} should include ${style} in ${text}`);
}

function styleForSegment(segment: { foreground?: string; bold?: boolean }): string {
	if (segment.foreground === colors.muted) return "comment";
	if (segment.foreground === colors.success) return "string";
	if (segment.foreground === colors.warning) return "number";
	if (segment.foreground === colors.info) return "property";
	if (segment.foreground === colors.accent && segment.bold) return "keyword";
	if (segment.foreground === colors.accent) return "emphasis";
	return "unknown";
}
