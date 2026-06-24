import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ResolvedToolRule } from "../src/config.js";
import { APP_ICONS, setAppIconTheme } from "../src/app/icons.js";
import { renderToolBlock, type ToolBlockEntry } from "../src/app/rendering/tool-block-renderer.js";
import { THEMES } from "../src/theme.js";

const colors = THEMES.dark.colors;
const gutterSegment = { start: 0, end: 1, foreground: colors.statusDotBase };

const rule: ResolvedToolRule = {
	previewLines: 10,
	direction: "head",
	color: "muted",
};

function toolEntry(overrides: Partial<ToolBlockEntry> = {}): ToolBlockEntry {
	return {
		id: "tool-1",
		toolName: "apply_patch",
		expanded: true,
		status: "done",
		isError: false,
		output: "",
		collapsedBody: "",
		expandedText: "",
		...overrides,
	};
}

describe("renderToolBlock", () => {
	it("colors LSP diagnostic severities", () => {
		setAppIconTheme("nerdFont");
		const output = [
			"LSP diagnostics after mutation:",
			`${APP_ICONS.alert} tsserver:`,
			"src/a.ts:1:2 - error TS2322: bad assignment",
			"src/a.ts:2:2 - warning TS6133: unused variable",
			"src/a.ts:3:2 - hint: remove unreachable code",
		].join("\n");

		const lines = renderToolBlock(toolEntry({ output, expandedText: output }), rule, 100, colors);

		assert.deepEqual(lines[0]?.segments?.[0], { start: 0, end: APP_ICONS.alert.length, foreground: colors.error, bold: true });
		assert.deepEqual(lines[1]?.segments, [gutterSegment]);
		assert.deepEqual(lines[2]?.segments, [gutterSegment, { start: 2, end: 2 + APP_ICONS.alert.length, foreground: colors.warning, bold: true }]);
		assert.deepEqual(lines[3]?.segments, [gutterSegment, { start: 2, end: lines[3]?.text.length, foreground: colors.error }]);
		assert.deepEqual(lines[4]?.segments, [gutterSegment, { start: 2, end: lines[4]?.text.length, foreground: colors.warning }]);
		assert.deepEqual(lines[5]?.segments, [gutterSegment, { start: 2, end: lines[5]?.text.length, foreground: colors.muted }]);
		assert.equal(lines[5]?.text.startsWith("└ "), true);
	});

	it("colors edit tool LSP status icon yellow for warning-only reports", () => {
		setAppIconTheme("nerdFont");
		const output = [
			"LSP diagnostics after mutation:",
			`${APP_ICONS.alert} tsserver:`,
			"src/a.ts:2:2 - warning TS6133: unused variable",
			"0 errors, 1 warning",
		].join("\n");

		const lines = renderToolBlock(toolEntry({ output, expandedText: output }), rule, 100, colors);

		assert.deepEqual(lines[0]?.segments?.[0], { start: 0, end: APP_ICONS.alert.length, foreground: colors.warning, bold: true });
	});

	it("colors write tool LSP diagnostic severities", () => {
		setAppIconTheme("nerdFont");
		const output = [
			"LSP diagnostics after mutation:",
			"src/a.ts:2:2 - warning TS6133: unused variable",
		].join("\n");

		const lines = renderToolBlock(toolEntry({ toolName: "functions.write", output, expandedText: output }), rule, 100, colors);

		assert.deepEqual(lines[0]?.segments?.[0], { start: 0, end: APP_ICONS.alert.length, foreground: colors.warning, bold: true });
		assert.deepEqual(lines[2]?.segments, [gutterSegment, { start: 2, end: lines[2]?.text.length, foreground: colors.warning }]);
	});

	it("marks truncated collapsed previews with a plus-box in normal mode", () => {
		const output = "one\ntwo\nthree";

		const lines = renderToolBlock(toolEntry({ expanded: false, output, collapsedBody: output }), { ...rule, previewLines: 2 }, 100, colors);

		assert.match(lines[0]?.text ?? "", /apply_patch/u);
		assert.deepEqual(lines.slice(1).map((line) => line.text), ["│ one", "⊞ two"]);
		assert.deepEqual(lines[2]?.segments, [
			{ start: 0, end: 1, foreground: colors.statusDotBase },
		]);
	});

	it("does not mark collapsed previews that fit within previewLines", () => {
		const output = "one\ntwo";

		const lines = renderToolBlock(toolEntry({ expanded: false, output, collapsedBody: output }), { ...rule, previewLines: 2 }, 100, colors);

		assert.deepEqual(lines.slice(1).map((line) => line.text), ["│ one", "└ two"]);
	});

	it("marks the first tail preview line when earlier output was truncated", () => {
		const output = "one\ntwo\nthree";

		const lines = renderToolBlock(toolEntry({ expanded: false, output, collapsedBody: output }), { ...rule, direction: "tail", previewLines: 2 }, 100, colors);

		assert.deepEqual(lines.slice(1).map((line) => line.text), ["⊞ two", "└ three"]);
		assert.deepEqual(lines[1]?.segments, [
			{ start: 0, end: 1, foreground: colors.statusDotBase },
		]);
	});

	it("renders collapsed previews inline only in super-compact mode", () => {
		const output = "one\ntwo\nthree";

		const lines = renderToolBlock(toolEntry({ expanded: false, output, collapsedBody: output }), { ...rule, previewLines: 2 }, 100, colors, { superCompact: true });

		assert.equal(lines.length, 1);
		assert.match(lines[0]?.text ?? "", /apply_patch .*one two/u);
		assert.doesNotMatch(lines[0]?.text ?? "", /three/u);
		const markerStart = lines[0]?.text.indexOf("⊞") ?? -1;
		assert.ok(markerStart >= 0);
		assert.ok(lines[0]?.segments?.some((segment) => segment.start === markerStart && segment.end === markerStart + 1 && segment.foreground === colors.statusDotBase));
	});

	it("renders collapsed default-expanded tools as one inline row in super-compact mode", () => {
		const output = "patch line\nresult line";

		const lines = renderToolBlock(
			toolEntry({ expanded: false, output, collapsedBody: output }),
			{ ...rule, defaultExpanded: true },
			100,
			colors,
			{ superCompact: true },
		);

		assert.equal(lines.length, 1);
		assert.match(lines[0]?.text ?? "", /apply_patch .*patch line result line/u);
	});

	it("renders expanded tools with full body in super-compact mode", () => {
		const lines = renderToolBlock(toolEntry({ expanded: true, expandedText: "body\nline", collapsedBody: "preview" }), rule, 100, colors, { superCompact: true });

		assert.deepEqual(lines.map((line) => line.text), [
			`${APP_ICONS.checkCircle} apply_patch`,
			"│ body",
			"└ line",
		]);
		assert.doesNotMatch(lines[0]?.text ?? "", /preview/u);
	});

	it("does not mark read output as LSP diagnostics after mutation", () => {
		const output = [
			"LSP diagnostics after mutation:",
			"src/a.ts:2:2 - warning TS6133: unused variable",
		].join("\n");

		const lines = renderToolBlock(toolEntry({ toolName: "read", output, expandedText: output }), rule, 100, colors);

		assert.equal(lines[0]?.segments?.[0]?.foreground, colors.success);
		assert.deepEqual(lines[2]?.segments, [gutterSegment]);
	});

	it("renders styled body line ranges", () => {
		const lines = renderToolBlock(toolEntry({
			expandedText: "pattern: test\nlang: ts\n\noutput line",
			bodyLineStyles: [{ startLine: 0, endLine: 2, color: "muted" }],
		}), rule, 100, colors);

		assert.deepEqual(lines[1]?.segments, [gutterSegment, { start: 2, end: lines[1]?.text.length, foreground: colors.muted }]);
		assert.deepEqual(lines[2]?.segments, [gutterSegment, { start: 2, end: lines[2]?.text.length, foreground: colors.muted }]);
		assert.deepEqual(lines[4]?.segments, [gutterSegment]);
		assert.equal(lines[4]?.text.startsWith("└ "), true);
	});

	it("uses the corner glyph only on the real end of output", () => {
		const output = "one\ntwo\nthree";

		const headLines = renderToolBlock(toolEntry({ expanded: false, output, collapsedBody: output }), { ...rule, previewLines: 2 }, 100, colors);
		const tailLines = renderToolBlock(toolEntry({ expanded: false, output, collapsedBody: output }), { ...rule, direction: "tail", previewLines: 2 }, 100, colors);

		assert.equal(headLines[2]?.text.startsWith("└ "), false);
		assert.equal(tailLines[2]?.text.startsWith("└ "), true);
	});

	it("renders long collapsed head previews from only the preview edge", () => {
		const output = Array.from({ length: 1000 }, (_, index) => `line-${index}`).join("\n");

		const lines = renderToolBlock(toolEntry({ expanded: false, output, collapsedBody: output }), { ...rule, previewLines: 2 }, 100, colors);

		assert.deepEqual(lines.slice(1).map((line) => line.text), ["│ line-0", "⊞ line-1"]);
		assert.doesNotMatch(lines.map((line) => line.text).join("\n"), /line-500|line-999/u);
	});

	it("renders long collapsed tail previews from only the preview edge", () => {
		const output = Array.from({ length: 1000 }, (_, index) => `line-${index}`).join("\n");

		const lines = renderToolBlock(toolEntry({ expanded: false, output, collapsedBody: output }), { ...rule, direction: "tail", previewLines: 2 }, 100, colors);

		assert.deepEqual(lines.slice(1).map((line) => line.text), ["⊞ line-998", "└ line-999"]);
		assert.doesNotMatch(lines.map((line) => line.text).join("\n"), /line-0|line-500/u);
	});

	it("keeps absolute body line styles in long tail previews", () => {
		const output = Array.from({ length: 1000 }, (_, index) => `line-${index}`).join("\n");

		const lines = renderToolBlock(toolEntry({
			expanded: false,
			output,
			collapsedBody: output,
			bodyLineStyles: [{ startLine: 999, endLine: 1000, color: "error" }],
		}), { ...rule, direction: "tail", previewLines: 2 }, 100, colors);

		assert.deepEqual(lines[2]?.segments, [gutterSegment, { start: 2, end: lines[2]?.text.length, foreground: colors.error }]);
	});

	it("dims patch file headers without using warning color", () => {
		const output = [
			"*** Begin Patch",
			"*** Update File: src/app/model-usage-status.ts",
			"@@",
			"+ email?: string;",
		].join("\n");

		const lines = renderToolBlock(toolEntry({ bodyStyle: "diff", output, expandedText: output }), rule, 100, colors);
		const updateLine = lines.find((line) => line.text.includes("*** Update File:"));
		assert.ok(updateLine);

		assert.deepEqual(updateLine?.segments, [gutterSegment, { start: 2, end: updateLine.text.length, foreground: colors.statusForeground, bold: true }]);
		const updateForeground = updateLine?.segments?.find((segment) => segment.start === 2) as { foreground?: string } | undefined;
		assert.notEqual(updateForeground?.foreground, colors.warning);
	});

	it("does not color context markdown bullets as diff additions or deletions", () => {
		const output = [
			"*** Begin Patch",
			"*** Update File: docs/example.md",
			"@@",
			" - unchanged bullet",
			" + unchanged plus bullet",
			"-removed bullet",
			"+added bullet",
		].join("\n");

		const lines = renderToolBlock(toolEntry({ bodyStyle: "diff", output, expandedText: output }), rule, 100, colors);
		const contextDash = lines.find((line) => line.text.includes("unchanged bullet"));
		const contextPlus = lines.find((line) => line.text.includes("unchanged plus bullet"));
		const removed = lines.find((line) => line.text.includes("removed bullet"));
		const added = lines.find((line) => line.text.includes("added bullet"));
		assert.ok(contextDash);
		assert.ok(contextPlus);
		assert.ok(removed);
		assert.ok(added);

		assert.deepEqual(contextDash.segments, [gutterSegment]);
		assert.deepEqual(contextPlus.segments, [gutterSegment]);
		assert.deepEqual(removed.segments, [gutterSegment, { start: 2, end: removed.text.length, foreground: colors.error }]);
		assert.deepEqual(added.segments, [gutterSegment, { start: 2, end: added.text.length, foreground: colors.success }]);
	});

	it("returns no lines for hidden tool rules", () => {
		assert.deepEqual(renderToolBlock(toolEntry(), { ...rule, hidden: true }, 80, colors), []);
	});

	it("renders header args and body in the neutral output color", () => {
		const lines = renderToolBlock(toolEntry({
			expanded: true,
			toolName: "ls",
			headerArgs: "--flag value",
			expandedText: "output line",
		}), { ...rule, color: "success" }, 80, colors);

		assert.equal(lines.length, 2);
		assert.match(lines[0]?.text ?? "", /ls/u);
		assert.match(lines[0]?.text ?? "", /--flag value/u);
		assert.equal(lines[0]?.colorOverride, colors.success);
		assert.equal(lines[1]?.colorOverride, colors.statusForeground);
		assert.ok(lines[0]?.segments?.some((segment) => segment.foreground === colors.statusForeground));
		assert.equal((lines[0]?.segments ?? []).some((segment) => segment.foreground === colors.muted || segment.foreground === colors.info), false);
	});

	it("keeps syntax-highlighted body output on the neutral output color", () => {
		const lines = renderToolBlock(toolEntry({
			expandedText: "const value = 1;",
			syntaxHighlight: { language: "typescript", startLine: 0, startColumn: 0 },
		}), { ...rule, color: "success" }, 80, colors);

		assert.equal(lines[1]?.colorOverride, colors.statusForeground);
		assert.deepEqual(lines[1]?.syntaxHighlight, { language: "typescript", start: 2 });
	});

	it("preserves ANSI styling in expanded body output", () => {
		const lines = renderToolBlock(toolEntry({
			toolName: "shell",
			output: "\x1b[31mred\x1b[0m\tok",
			expandedText: "\x1b[31mred\x1b[0m\tok",
			preserveAnsi: true,
		}), rule, 20, colors);

		const bodyLine = lines.find((line) => line.text.includes("red"));
		assert.ok(bodyLine);
		assert.ok(bodyLine?.segments?.some((segment) => segment.foreground === "#cd3131"));
		assert.doesNotMatch(lines.map((line) => line.text).join("\n"), /\x1b/u);
	});
});
