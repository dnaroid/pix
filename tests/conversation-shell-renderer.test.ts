import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderConversationShellEntry } from "../src/app/rendering/conversation-shell-renderer.js";
import type { PixConfig } from "../src/config.js";
import { THEMES } from "../src/theme.js";

describe("renderConversationShellEntry", () => {
	it("renders running shell output with stdin guidance", () => {
		const text = renderShell({ status: "running", output: "building\n", expanded: true });

		assert.match(text, /building/u);
		assert.match(text, /running — submit editor text/u);
	});

	it("marks failed starts, signals, and non-zero exits as errors", () => {
		assert.match(renderShell({ status: "done", output: "", error: "ENOENT" }), /failed to start: ENOENT/u);
		assert.match(renderShell({ status: "done", output: "", signal: "SIGINT" }), /terminated by SIGINT/u);
		assert.match(renderShell({ status: "done", output: "", exitCode: 2 }), /exit 2/u);
		assert.match(renderShell({ status: "done", output: "", exitCode: 0 }), /exit 0/u);
	});
});

function renderShell(overrides: Partial<Parameters<typeof renderConversationShellEntry>[0]>): string {
	return renderConversationShellEntry({
		id: "shell-1",
		kind: "shell",
		command: "npm test",
		status: "done",
		expanded: true,
		output: "",
		...overrides,
	} as Parameters<typeof renderConversationShellEntry>[0], 80, {
		cwd: process.cwd(),
		colors: THEMES.dark.colors,
		pixConfig: minimalPixConfig(),
	}).map((line) => line.text).join("\n");
}

function minimalPixConfig(): PixConfig {
	return {
		toolRenderer: { default: { previewLines: 0, direction: "head", color: "toolTitle" }, tools: {} },
		outputFilters: { patterns: [] },
		promptEnhancer: { modelRef: "" },
		autocomplete: { modelRef: "", debounceMs: 0, timeoutMs: 0, maxTokens: 0, maxPromptTokens: 0, includeRecentMessages: 0 },
		modelColors: { rules: {} },
		iconTheme: { name: "fallback" },
		dictation: { languages: {} },
	};
}
