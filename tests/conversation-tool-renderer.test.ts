import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PixConfig } from "../src/config.js";
import { renderConversationToolEntry } from "../src/app/rendering/conversation-tool-renderer.js";
import { THEMES } from "../src/theme.js";

const pixConfig: PixConfig = {
	toolRenderer: {
		default: { previewLines: 3, direction: "head", color: "muted" },
		tools: {},
	},
	outputFilters: { patterns: [] },
	promptEnhancer: { modelRef: "test/model" },
	autocomplete: { modelRef: "test/model", debounceMs: 350, timeoutMs: 3000, maxTokens: 48, maxPromptTokens: 1200, includeRecentMessages: 0 },
	modelColors: { rules: {} },
	iconTheme: { name: "nerdFont" },
	dictation: { languages: { en: { dirName: "vosk-model-small-en-us-0.15", url: "https://example.test/en.zip", label: "English" } } },
	ignoreContextFiles: false,
};

const renderOptions = {
	cwd: "/repo",
	colors: THEMES.dark.colors,
	pixConfig,
	superCompactTools: false,
	allThinkingExpanded: false,
};

describe("renderConversationToolEntry", () => {
	it("renders todo details with task rows instead of a generic tool body", () => {
		const lines = renderConversationToolEntry({
			id: "todo-1",
			kind: "tool",
			toolCallId: "call-1",
			toolName: "todo",
			argsText: JSON.stringify({ action: "create" }),
			output: "",
			details: {
				action: "create",
				params: {},
				tasks: [{ id: 1, subject: "Ship it", status: "pending" }],
				nextId: 2,
			},
			expanded: true,
			isError: false,
			status: "done",
		}, 80, renderOptions);

		assert.match(lines[0]?.text ?? "", /todo .*action=create nextId=2/u);
		assert.ok(lines.some((line) => line.text.includes("Ship it")));
	});

	it("renders subagent summaries and previews from run details", () => {
		const lines = renderConversationToolEntry({
			id: "subagents-1",
			kind: "tool",
			toolCallId: "call-2",
			toolName: "subagents",
			argsText: JSON.stringify({ action: "status" }),
			output: "",
			details: {
				runDir: "/runs/build-123",
				agents: [{ id: "agent-1", status: "running" }],
				tasks: [{ id: "agent-1", task: "Build docs", model: "anthropic/claude" }],
			},
			expanded: true,
			isError: false,
			status: "done",
		}, 80, renderOptions);

		assert.match(lines[0]?.text ?? "", /started=1\/1/u);
		assert.match(lines[0]?.text ?? "", /run=build-123/u);
		assert.ok(lines.some((line) => line.text.includes("task:Build docs")));
	});
});
