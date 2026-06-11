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

	it("returns no lines for hidden tool rules", () => {
		assert.deepEqual(renderToolBlock(toolEntry(), { ...rule, hidden: true }, 80, colors), []);
	});

	it("clips header args and keeps custom header segments", () => {
		const lines = renderToolBlock(toolEntry({
			expanded: false,
			toolName: "ls",
			headerArgs: "--very-long-flag value",
			headerArgsSegments: [{ start: 0, end: 14, foreground: colors.info, bold: true }],
		}), rule, 14, colors);

		assert.equal(lines.length, 1);
		assert.match(lines[0]?.text ?? "", /ls/u);
		assert.doesNotMatch(lines[0]?.text ?? "", /very-long-flag value/u);
		assert.ok((lines[0]?.segments ?? []).some((segment) => segment.foreground === colors.info));
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
