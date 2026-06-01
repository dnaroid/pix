import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ScreenStyler } from "../src/app/screen-styler.js";
import { APP_ICONS } from "../src/app/icons.js";
import { colorize, THEMES } from "../src/theme.js";
import { stringDisplayWidth } from "../src/terminal-width.js";

describe("ScreenStyler", () => {
	it("applies syntax highlight segments for visible rendered lines", () => {
		const theme = THEMES.dark;
		const styler = new ScreenStyler({ theme, mouseSelection: undefined });

		const output = styler.styleBaseLine(1, {
			text: "    const count = 1;",
			colorOverride: theme.colors.statusForeground,
			syntaxHighlight: { language: "typescript", start: 4 },
		}, 24);

		assert.ok(output.includes(colorize("const", {
			foreground: theme.colors.accent,
			bold: true,
		})));
		assert.ok(output.includes(colorize("1", {
			foreground: theme.colors.warning,
		})));
	});

	it("renders markdown strong emphasis as bold text without markers", () => {
		const theme = THEMES.dark;
		const styler = new ScreenStyler({ theme, mouseSelection: undefined });

		const output = styler.styleBaseLine(1, {
			text: "  **Evaluating code issues**",
			colorOverride: theme.colors.statusForeground,
			syntaxHighlight: { language: "markdown", start: 2 },
		}, 32);

		assert.ok(!output.includes("**"));
		assert.ok(output.includes(colorize("Evaluating code issues", {
			foreground: theme.colors.statusForeground,
			bold: true,
		})));
	});

	it("combines explicit line segments with markdown styling", () => {
		const theme = THEMES.dark;
		const styler = new ScreenStyler({ theme, mouseSelection: undefined });

		const output = styler.styleBaseLine(1, {
			text: "│**Bold** text│",
			colorOverride: theme.colors.statusForeground,
			segments: [
				{ start: 0, end: 1, foreground: theme.colors.inputBorder },
				{ start: 14, end: 15, foreground: theme.colors.inputBorder },
			],
			syntaxHighlight: { language: "markdown", start: 1 },
		}, 15);

		assert.ok(!output.includes("**"));
		assert.ok(output.includes(colorize("│", { foreground: theme.colors.inputBorder })));
		assert.ok(output.includes(colorize("Bold", {
			foreground: theme.colors.statusForeground,
			bold: true,
		})));
	});

	it("highlights mouse selections on input lines", () => {
		const theme = THEMES.dark;
		const styler = new ScreenStyler({
			theme,
			mouseSelection: {
				anchor: { x: 3, y: 4 },
				current: { x: 6, y: 4 },
				moved: true,
			},
		});

		const output = styler.styleInputLine(4, "abcdef", undefined, 8, theme.colors.accent);

		assert.ok(output.includes(colorize("cde", {
			foreground: theme.colors.selectionForeground,
			background: theme.colors.selectionBackground,
			bold: true,
		})));
	});

	it("leaves unselected input lines on the terminal default background", () => {
		const theme = THEMES.dark;
		const styler = new ScreenStyler({ theme, mouseSelection: undefined });

		const output = styler.styleInputLine(4, "│hello│", undefined, 8, theme.colors.accent, theme.colors.inputBorder);

		assert.ok(output.includes(colorize("│", { foreground: theme.colors.inputBorder })));
		assert.doesNotMatch(output, /\x1b\[[0-9;]*48;2;9;13;19m/);
	});

	it("preserves status text cells after non-BMP icons", () => {
		const theme = THEMES.dark;
		const styler = new ScreenStyler({ theme, mouseSelection: undefined });
		const text = `${APP_ICONS.record} ready session name with spaces workspace`;
		const width = stringDisplayWidth(text);
		const sessionStart = text.indexOf("session");

		const output = styler.styleLineSegments(1, text, width, {
			foreground: theme.colors.statusForeground,
			background: theme.colors.statusBackground,
		}, [{ start: sessionStart, end: sessionStart + "session name with spaces".length, foreground: theme.colors.selectionForeground }]);

		assert.equal(stripAnsi(output), text);
	});

	it("renders visible file paths without OSC 8 hyperlinks", () => {
		const theme = THEMES.dark;
		const cwd = mkdtempSync(join(tmpdir(), "pix-links-"));
		const filePath = join(cwd, "src", "app.ts");
		mkdirSync(join(cwd, "src"));
		writeFileSync(filePath, "export {};\n", { flag: "wx" });
		const styler = new ScreenStyler({ theme, cwd, mouseSelection: undefined });

		const output = styler.styleLine(1, "open src/app.ts:12 please", 32, {
			foreground: theme.colors.foreground,
			background: theme.colors.background,
		});

		assert.ok(!output.includes("\x1b]8;;"));
		assert.ok(output.includes("src/app.ts:12"));
		assert.equal(stripTerminalControls(output), "open src/app.ts:12 please       ");
	});

	it("does not hyperlink URL-looking paths as local files", () => {
		const theme = THEMES.dark;
		const cwd = mkdtempSync(join(tmpdir(), "pix-links-"));
		const styler = new ScreenStyler({ theme, cwd, mouseSelection: undefined });

		const output = styler.styleLine(1, "visit https://example.com/src/app.ts", 40, {
			foreground: theme.colors.foreground,
			background: theme.colors.background,
		});

		assert.ok(!output.includes("\x1b]8;;file://"));
		assert.equal(stripTerminalControls(output), "visit https://example.com/src/app.ts    ");
	});
});

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function stripTerminalControls(text: string): string {
	return stripAnsi(text).replace(/\x1b\]8;;.*?(?:\x1b\\|\x07)/g, "");
}
