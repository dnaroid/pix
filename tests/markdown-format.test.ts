import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatMarkdownTables, isOnlyHiddenMetadata, renderMarkdownLine, renderMarkdownTextLines, stripDcpControlMetadata } from "../src/markdown-format.js";
import { stringDisplayWidth } from "../src/terminal-width.js";

describe("formatMarkdownTables", () => {
	it("aligns markdown tables by display width", () => {
		const input = [
			"| \u041f\u043d | \u0412\u0442 | \u0421\u0440 | \u0427\u0442 | \u041f\u0442 | \u0421\u0431 | \u0412\u0441 |",
			"|:--:|:--:|:--:|:--:|:--:|:--:|:--:|",
			"| | | | | 1 | 2 | 3 |",
			"| 4 | 5 | 6 | 7 | 8 | 9 | 10 |",
			"| 11 | 12 | 13 | 14 | 15 | 16 | 17 |",
			"| 18 | 19 | 20 | 21 | 22 | 23 | 24 |",
			"| 25 | 26 | 27 | 28 | 29 | **30** | 31 |",
		].join("\n");

		assert.equal(formatMarkdownTables(input), [
			"┌──────┬──────┬──────┬──────┬──────┬──────┬──────┐",
			"│  \u041f\u043d  │  \u0412\u0442  │  \u0421\u0440  │  \u0427\u0442  │  \u041f\u0442  │  \u0421\u0431  │  \u0412\u0441  │",
			"├──────┼──────┼──────┼──────┼──────┼──────┼──────┤",
			"│      │      │      │      │  1   │  2   │  3   │",
			"├──────┼──────┼──────┼──────┼──────┼──────┼──────┤",
			"│  4   │  5   │  6   │  7   │  8   │  9   │  10  │",
			"├──────┼──────┼──────┼──────┼──────┼──────┼──────┤",
			"│  11  │  12  │  13  │  14  │  15  │  16  │  17  │",
			"├──────┼──────┼──────┼──────┼──────┼──────┼──────┤",
			"│  18  │  19  │  20  │  21  │  22  │  23  │  24  │",
			"├──────┼──────┼──────┼──────┼──────┼──────┼──────┤",
			"│  25  │  26  │  27  │  28  │  29  │  **30**  │  31  │",
			"└──────┴──────┴──────┴──────┴──────┴──────┴──────┘",
		].join("\n"));
	});

	it("adds row separators between markdown table body rows", () => {
		const input = [
			"| Provider | Notes |",
			"|---|---|",
			"| OpenAI | one two three four five |",
			"| Google | six seven |",
		].join("\n");

		assert.equal(formatMarkdownTables(input, 32), [
			"┌──────────┬───────────────────┐",
			"│ Provider │ Notes             │",
			"├──────────┼───────────────────┤",
			"│ OpenAI   │ one two three     │",
			"│          │ four five         │",
			"├──────────┼───────────────────┤",
			"│ Google   │ six seven         │",
			"└──────────┴───────────────────┘",
		].join("\n"));
	});

	it("measures bold markdown table cells by rendered width", () => {
		const formatted = formatMarkdownTables("| Day | Value |\n|:--:|:--:|\n| Fri | **30** |");

		assert.deepEqual(formatted.split("\n").map((line) => renderMarkdownLine(line).text), [
			"┌──────┬───────┐",
			"│ Day  │ Value │",
			"├──────┼───────┤",
			"│ Fri  │  30   │",
			"└──────┴───────┘",
		]);
	});

	it("keeps table borders aligned around emoji-status cells", () => {
		const formatted = formatMarkdownTables([
			"| Metric | Current | Threshold | Status |",
			"|---|---:|---:|---|",
			"| Lines | 80.65% | 95% | ❌ -14.35% |",
			"| Branches | 71.41% | 80% | ✅ +1.41% |",
		].join("\n"));

		const widths = formatted.split("\n").map((line) => stringDisplayWidth(renderMarkdownLine(line).text));
		assert.deepEqual([...new Set(widths)], [widths[0]]);
		assert(formatted.includes("❌ -14.35%"));
	});

	it("renders strong markdown without marker characters", () => {
		assert.deepEqual(renderMarkdownLine("before **bold** after"), {
			text: "before bold after",
			segments: [{ start: 7, end: 11, bold: true }],
		});
	});

	it("keeps strong markers inside inline code", () => {
		assert.deepEqual(renderMarkdownLine("`**code**` and **bold**"), {
			text: "`**code**` and bold",
			segments: [{ start: 15, end: 19, bold: true }],
		});
	});

	it("does not format tables inside fenced code blocks", () => {
		const input = [
			"```md",
			"| A | B |",
			"|---|---|",
			"| 1 | 2 |",
			"```",
		].join("\n");

		assert.equal(formatMarkdownTables(input), input);
	});

	it("hides markdown reference definitions outside fenced code blocks", () => {
		const input = [
			"visible before",
			"[note]: # (m159)",
			"  [doc]: https://example.test/docs",
			"```md",
			"[literal]: # (kept)",
			"```",
			"visible after",
		].join("\n");

		assert.equal(formatMarkdownTables(input), [
			"visible before",
			"```md",
			"[literal]: # (kept)",
			"```",
			"visible after",
		].join("\n"));
	});

	it("wraps wide table cells while keeping columns aligned", () => {
		const input = [
			"| A | B |",
			"|---|---|",
			"| short | one two three four five |",
		].join("\n");

		assert.equal(formatMarkdownTables(input, 25), [
			"┌───────┬───────────────┐",
			"│ A     │ B             │",
			"├───────┼───────────────┤",
			"│ short │ one two three │",
			"│       │ four five     │",
			"└───────┴───────────────┘",
		].join("\n"));
	});

	it("budgets hidden strong markers when wrapping wide tables", () => {
		const formatted = formatMarkdownTables([
			"| Name | Endpoint |",
			"|---|---|",
			"| **OpenAI** | `chatgpt.com/backend-api/wham/usage` |",
		].join("\n"), 52);

		assert(formatted.split("\n").every((line) => stringDisplayWidth(line) <= 52));
		assert.deepEqual(formatted.split("\n").map((line) => renderMarkdownLine(line).text), [
			"┌────────┬─────────────────────────────────────┐",
			"│ Name   │ Endpoint                            │",
			"├────────┼─────────────────────────────────────┤",
			"│ OpenAI │ `chatgpt.com/backend-api/wham`      │",
			"│        │ `/usage`                            │",
			"└────────┴─────────────────────────────────────┘",
		]);
	});

	it("wraps wide markdown tables before display-line wrapping", () => {
		const lines = renderMarkdownTextLines([
			"| \u041f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440 | \u0410\u0432\u0442\u043e\u0440\u0438\u0437\u0430\u0446\u0438\u044f | API-\u044d\u043d\u0434\u043f\u043e\u0438\u043d\u0442 |",
			"|---|---|---|",
			"| OpenAI | OAuth-token \u0438\u0437 ~/.local/share/opencode/auth.json (fallback — auth.json) | chatgpt.com/backend-api/wham/usage |",
		].join("\n"), 60);

		assert(lines.every((line) => stringDisplayWidth(line.text) <= 60));
		assert(lines.every((line) => /^[┌│├└]/u.test(line.text.trim())));
		assert(lines.some((line) => line.text.includes("fallback")));
	});

	it("strips strong markers before wrapping markdown text lines", () => {
		const lines = renderMarkdownTextLines("\u041a\u043e\u0440\u043e\u0442\u043a\u043e: **\u0434\u0430, \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0441\u0435\u0441\u0441\u0438\u0438 \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u0441\u044f**", 28);

		assert.deepEqual(lines.map((line) => line.text), [
			"\u041a\u043e\u0440\u043e\u0442\u043a\u043e: \u0434\u0430, \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435",
			"\u0441\u0435\u0441\u0441\u0438\u0438 \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u0441\u044f",
		]);
		assert(lines.every((line) => !line.text.includes("**")));
		assert.deepEqual(lines.map((line) => line.segments), [
			[{ start: 9, end: 24, bold: true }],
			[{ start: 0, end: 20, bold: true }],
		]);
	});
});

describe("renderMarkdownTextLines", () => {
	it("uses the fenced code language for code block contents", () => {
		const lines = renderMarkdownTextLines("```typescript\nconst answer = true;\n```", 80);

		assert.deepEqual(lines.map((line) => line.syntaxHighlight?.language), ["markdown", "typescript", "markdown"]);
	});

	it("does not render markdown emphasis inside unknown fenced code blocks", () => {
		const lines = renderMarkdownTextLines("```unknown\n**literal**\n```\n**bold**", 80);

		assert.equal(lines[1]?.text, "**literal**");
		assert.equal(lines[1]?.syntaxHighlight, undefined);
		assert.equal(lines[3]?.syntaxHighlight?.language, "markdown");
	});

	it("applies the provided syntax start offset", () => {
		const [line] = renderMarkdownTextLines("```ts", 80, 2);

		assert.equal(line?.syntaxHighlight?.start, 2);
	});

	it("does not render markdown reference metadata", () => {
		const lines = renderMarkdownTextLines("[note]: # (m159)\n\nanswer\n[block]: # (b5)", 80);

		assert.deepEqual(lines.map((line) => line.text), ["answer"]);
	});

	it("renders incomplete bracketed text without DCP-prefix compatibility filtering", () => {
		assert.deepEqual(renderMarkdownTextLines("[d", 80).map((line) => line.text), ["[d"]);
		assert.deepEqual(renderMarkdownTextLines("[dcp-id]", 80).map((line) => line.text), ["[dcp-id]"]);
		assert.deepEqual(renderMarkdownTextLines("[dcp-id]: # (m", 80), []);
	});

	it("keeps bracketed text while hiding trailing markdown reference definitions", () => {
		const lines = renderMarkdownTextLines("[details]\nanswer\n[note]: # (m159", 80);

		assert.deepEqual(lines.map((line) => line.text), ["[details]", "answer"]);
	});

	it("does not render leaked DCP message-id control blocks", () => {
		const text = [
			"before",
			"<dcp-message-ids>",
			"internal ids",
			"</dcp-message-ids>",
			"after",
		].join("\n");

		assert.deepEqual(renderMarkdownTextLines(text, 80).map((line) => line.text), ["before", "after"]);
		assert.equal(stripDcpControlMetadata(text), "before\nafter");
	});
});

describe("isOnlyHiddenMetadata", () => {
	it("returns true for markdown reference definitions", () => {
		assert.equal(isOnlyHiddenMetadata("\n[note]: # (m008)"), true);
		assert.equal(isOnlyHiddenMetadata("[note]: # (m123)"), true);
	});

	it("returns true for multiple hidden lines", () => {
		assert.equal(isOnlyHiddenMetadata("[note]: # (m1)\n[block]: # (b2)"), true);
	});

	it("returns true for empty string", () => {
		assert.equal(isOnlyHiddenMetadata(""), false);
	});

	it("returns false for text with visible content", () => {
		assert.equal(isOnlyHiddenMetadata("Hello\n[note]: # (m1)"), false);
		assert.equal(isOnlyHiddenMetadata("Some answer"), false);
	});

	it("returns true for whitespace-only lines with dcp markers", () => {
		assert.equal(isOnlyHiddenMetadata("\n\n[note]: # (m008)\n"), true);
	});

	it("does not hide incomplete DCP prefixes", () => {
		assert.equal(isOnlyHiddenMetadata("[dcp-id]: # (m159"), true);
		assert.equal(isOnlyHiddenMetadata("[d"), false);
	});

	it("treats leaked DCP message-id control blocks as hidden metadata", () => {
		assert.equal(isOnlyHiddenMetadata("<dcp-message-ids>\ninternal ids\n</dcp-message-ids>"), true);
		assert.equal(isOnlyHiddenMetadata("answer\n<dcp-message-ids>\ninternal ids\n</dcp-message-ids>"), false);
	});
});
