import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_ICONS, setAppIconTheme } from "../src/app/icons.js";
import type { ToolStatusEntry } from "../src/app/types.js";
import {
	alertIconPrefixLength,
	hasLspDiagnosticsAfterMutation,
	hasToolLspDiagnosticsAfterMutation,
	horizontalPaddingLayout,
	ellipsizeDisplay,
	lspDiagnosticSeverityForLine,
	normalizePastedTextForDuplicateKey,
	padHorizontalText,
	shortHash,
	sanitizeText,
	toolLspDiagnosticsAfterMutationSeverity,
	toolStatusIcon,
	toolStatusIconColor,
	wrapText,
} from "../src/app/rendering/render-text.js";
import { THEMES } from "../src/theme.js";

describe("render-text helpers", () => {
	it("detects diagnostic prefixes and LSP mutation reports", () => {
		setAppIconTheme("nerdFont");

		assert.equal(alertIconPrefixLength(`${APP_ICONS.alert} issue`), APP_ICONS.alert.length);
		assert.equal(alertIconPrefixLength("\u{f0026} issue"), 2);
		assert.equal(alertIconPrefixLength("⚠ issue"), 1);
		assert.equal(hasLspDiagnosticsAfterMutation("LSP diagnostics: 2 warnings"), true);
		assert.equal(hasLspDiagnosticsAfterMutation("nothing useful"), false);
		assert.equal(hasToolLspDiagnosticsAfterMutation({ toolName: "apply_patch", output: "LSP diagnostics: 1 error" } as ToolStatusEntry), true);
		assert.equal(hasToolLspDiagnosticsAfterMutation({ toolName: "read", output: "LSP diagnostics: 1 error" } as ToolStatusEntry), false);
		assert.equal(lspDiagnosticSeverityForLine("2 warnings"), "warning");
		assert.equal(lspDiagnosticSeverityForLine("0 errors"), undefined);
		assert.equal(lspDiagnosticSeverityForLine("diagnosticSeverity.error"), "error");
		assert.equal(toolLspDiagnosticsAfterMutationSeverity({ toolName: "apply_patch", output: "LSP diagnostics: 1 warning" } as ToolStatusEntry), "warning");
		assert.equal(toolLspDiagnosticsAfterMutationSeverity({ toolName: "apply_patch", output: "LSP diagnostics: 1 error" } as ToolStatusEntry), "error");
		assert.equal(toolStatusIcon({ toolName: "read", status: "running", isError: false, output: "" } as ToolStatusEntry), APP_ICONS.timerSand);
		assert.equal(toolStatusIcon({ toolName: "read", status: "done", isError: true, output: "" } as ToolStatusEntry), APP_ICONS.closeCircle);
		assert.equal(toolStatusIcon({ toolName: "apply_patch", status: "done", isError: false, output: "LSP diagnostics: 1 warning" } as ToolStatusEntry), APP_ICONS.alert);
		assert.equal(toolStatusIcon({ toolName: "read", status: "done", isError: false, output: "" } as ToolStatusEntry), APP_ICONS.checkCircle);
		assert.equal(toolStatusIconColor({ toolName: "read", status: "running", isError: false, output: "" } as ToolStatusEntry, THEMES.dark.colors), THEMES.dark.colors.muted);
		assert.equal(toolStatusIconColor({ toolName: "read", status: "done", isError: true, output: "" } as ToolStatusEntry, THEMES.dark.colors), THEMES.dark.colors.error);
		assert.equal(toolStatusIconColor({ toolName: "apply_patch", status: "done", isError: false, output: "LSP diagnostics: 1 error" } as ToolStatusEntry, THEMES.dark.colors), THEMES.dark.colors.error);
		assert.equal(toolStatusIconColor({ toolName: "apply_patch", status: "done", isError: false, output: "LSP diagnostics: 1 warning" } as ToolStatusEntry, THEMES.dark.colors), THEMES.dark.colors.warning);
		assert.equal(toolStatusIconColor({ toolName: "read", status: "done", isError: false, output: "" } as ToolStatusEntry, THEMES.dark.colors), THEMES.dark.colors.success);
	});

	it("normalizes pasted text and handles padding and ellipses", () => {
		assert.equal(normalizePastedTextForDuplicateKey("a\r\nb\rc"), "a\nb\nc");
		assert.notEqual(shortHash("pix-ui-extend"), shortHash("pix-ui-extend!"));
		assert.deepEqual(horizontalPaddingLayout(1), { left: 0, right: 0, contentWidth: 1 });
		assert.deepEqual(horizontalPaddingLayout(4), { left: 1, right: 1, contentWidth: 2 });
		assert.equal(padHorizontalText("abc", 1), "a");
		assert.equal(padHorizontalText("abc", 4), " ab ");
		assert.deepEqual(wrapText("alpha beta", 5), ["alpha", " beta"]);
		assert.equal(ellipsizeDisplay("abcdef", 0), "");
		assert.equal(ellipsizeDisplay("abcdef", 1), "…");
		assert.equal(ellipsizeDisplay("abcdef", 4), "abc…");
		assert.match(sanitizeText("line1\r\nline2\t⚠"), new RegExp(`line1\\nline2.*${APP_ICONS.alert}`, "u"));
	});
});
