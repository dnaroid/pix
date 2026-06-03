import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PixConfig } from "../src/config.js";
import { APP_ICONS } from "../src/app/icons.js";
import { ConversationViewport } from "../src/app/rendering/conversation-viewport.js";
import { renderConversationEntry, type ConversationEntryRenderOptions } from "../src/app/rendering/conversation-entry-renderer.js";
import type { Entry } from "../src/app/types.js";
import { stringDisplayWidth } from "../src/terminal-width.js";
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
};

const renderOptions: ConversationEntryRenderOptions = {
	cwd: "/repo",
	colors: THEMES.dark.colors,
	pixConfig,
	outputFilters: [],
	renderInlineUserMessageMenu: () => [],
};
describe("renderConversationEntry", () => {
	it("marks assistant messages as markdown for syntax highlighting", () => {
		const lines = renderConversationEntry({ id: "assistant-1", kind: "assistant", text: "# Title\nUse `code`." }, 80, renderOptions);

		assert.deepEqual(lines.map((line) => line.syntaxHighlight), [
			{ language: "markdown", start: 0 },
			{ language: "markdown", start: 0 },
		]);
	});

	it("uses the assistant foreground color for assistant messages", () => {
		const lines = renderConversationEntry({ id: "assistant-color", kind: "assistant", text: "Less bright text." }, 80, renderOptions);

		assert.deepEqual(lines.map((line) => line.colorOverride), [THEMES.dark.colors.assistantForeground]);
	});

	it("wraps assistant messages at word boundaries", () => {
		const lines = renderConversationEntry({ id: "assistant-wrap", kind: "assistant", text: "alpha beta gamma" }, 12, renderOptions);

		assert.deepEqual(lines.map((line) => line.text), ["alpha beta", "gamma"]);
	});

	it("hides assistant markdown reference metadata", () => {
		const lines = renderConversationEntry({
			id: "assistant-ref-metadata",
			kind: "assistant",
			text: "[dcp-id]: # (m159)\n\n[dcp-id]: # (m161)",
		}, 80, renderOptions);

		assert.deepEqual(lines, []);
	});


	it("formats assistant markdown tables before wrapping", () => {
		const lines = renderConversationEntry({
			id: "assistant-table",
			kind: "assistant",
			text: "| A | Wide |\n|:--:|:--:|\n| 1 | **30** |",
		}, 80, renderOptions);

		assert.deepEqual(lines.map((line) => line.text), [
			"┌──────┬──────┐",
			"│  A   │ Wide │",
			"├──────┼──────┤",
			"│  1   │  30  │",
			"└──────┴──────┘",
		]);
	});

	it("strips assistant strong markers before wrapping", () => {
		const lines = renderConversationEntry({
			id: "assistant-bold-wrap",
			kind: "assistant",
			text: "\u041a\u043e\u0440\u043e\u0442\u043a\u043e: **\u0434\u0430, \u043f\u0440\u0438 \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0438 \u0441\u0435\u0441\u0441\u0438\u0438 todo \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u0441\u044f \u0438\u0437 persisted plan.**",
		}, 48, renderOptions);

		assert(lines.every((line) => !line.text.includes("**")));
		assert.deepEqual(lines.map((line) => line.text), [
			"\u041a\u043e\u0440\u043e\u0442\u043a\u043e: \u0434\u0430, \u043f\u0440\u0438 \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0438 \u0441\u0435\u0441\u0441\u0438\u0438 todo",
			"\u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u0441\u044f \u0438\u0437 persisted plan.",
		]);
		assert.deepEqual(lines.map((line) => line.segments), [
			[{ start: 9, end: 40, bold: true }],
			[{ start: 0, end: 32, bold: true }],
		]);
	});

	it("marks user messages as markdown for syntax highlighting", () => {
		const lines = renderConversationEntry({ id: "user-1", kind: "user", text: "Use `code`." }, 40, renderOptions);

		assert.equal(lines[0]?.syntaxHighlight, undefined);
		assert.deepEqual(lines[1]?.syntaxHighlight, { language: "markdown", start: 1 });
		assert.equal(lines[2]?.syntaxHighlight, undefined);
	});

	it("keeps the user message bubble background", () => {
		const lines = renderConversationEntry({ id: "user-bg", kind: "user", text: "hello" }, 40, renderOptions);

		assert.deepEqual(lines.map((line) => line.backgroundOverride), [
			THEMES.dark.colors.userMessageBackground,
			THEMES.dark.colors.userMessageBackground,
			THEMES.dark.colors.userMessageBackground,
		]);
		assert.deepEqual(lines.map((line) => line.segments), [undefined, undefined, undefined]);
	});

	it("keeps queued messages on the user message bubble background", () => {
		const lines = renderConversationEntry({
			id: "queue-bg",
			kind: "queued",
			mode: "steering",
			text: "hello",
			queueSource: "sdk-steering",
			queueIndex: 0,
		}, 40, renderOptions);

		assert.deepEqual(lines.map((line) => line.backgroundOverride), [
			THEMES.dark.colors.userMessageBackground,
		]);
		assert.match(lines[0]?.text ?? "", new RegExp(`${APP_ICONS.timerSand} steer: hello`, "u"));
		assert.deepEqual(lines.map((line) => line.segments), [[{ start: 1, end: 1 + APP_ICONS.timerSand.length, foreground: THEMES.dark.colors.info }]]);
		assert.deepEqual(lines.map((line) => line.target), [
			{ kind: "queue-message", id: "queue-bg" },
		]);
	});

	it("uses concise queued labels with a blue icon", () => {
		const deferred = renderConversationEntry({
			id: "queue-deferred",
			kind: "queued",
			mode: "steering",
			text: "send later",
			queueSource: "deferred",
			queueIndex: 0,
		}, 40, renderOptions);
		const followUp = renderConversationEntry({
			id: "queue-follow",
			kind: "queued",
			mode: "follow-up",
			text: "next step",
			queueSource: "sdk-follow-up",
			queueIndex: 0,
		}, 40, renderOptions);

		assert.match(deferred[0]?.text ?? "", new RegExp(`${APP_ICONS.timerSand} queued: send later`, "u"));
		assert.match(followUp[0]?.text ?? "", new RegExp(`${APP_ICONS.timerSand} follow: next step`, "u"));
		assert.deepEqual(deferred[0]?.segments, [{ start: 1, end: 1 + APP_ICONS.timerSand.length, foreground: THEMES.dark.colors.info }]);
		assert.deepEqual(followUp[0]?.segments, [{ start: 1, end: 1 + APP_ICONS.timerSand.length, foreground: THEMES.dark.colors.info }]);
	});

	it("wraps user messages at word boundaries inside the padded bubble", () => {
		const lines = renderConversationEntry({ id: "user-wrap", kind: "user", text: "alpha beta gamma" }, 12, renderOptions);

		assert.deepEqual(lines.map((line) => line.text), ["            ", " alpha beta ", " gamma      ", "            "]);
	});

	it("marks user image labels as clickable image targets", () => {
		const image = { type: "image" as const, data: Buffer.from("png").toString("base64"), mimeType: "image/png" };
		const lines = renderConversationEntry({ id: "user-image", kind: "user", text: "[Image]", images: [image] }, 40, renderOptions);
		const imageLine = lines.find((line) => line.text.includes("[Image]"));

		assert.deepEqual(imageLine?.imageTargets, [{ start: 1, end: 8, entryId: "user-image", imageIndex: 0 }]);
		assert.deepEqual(imageLine?.segments, [{ start: 1, end: 8, foreground: THEMES.dark.colors.info, underline: true }]);
	});

	it("formats user markdown tables before wrapping", () => {
		const lines = renderConversationEntry({
			id: "user-table",
			kind: "user",
			text: "| \u041f\u043d | \u0421\u0431 |\n|:--:|:--:|\n| 1 | **30** |",
		}, 80, renderOptions);

		assert.match(lines[1]?.text ?? "", /┌──────┬──────┐/u);
		assert.match(lines[2]?.text ?? "", /│  \u041f\u043d  │  \u0421\u0431  │/u);
		assert.match(lines[3]?.text ?? "", /├──────┼──────┤/u);
		assert.match(lines[4]?.text ?? "", /│  1   │  30  │/u);
		assert.match(lines[5]?.text ?? "", /└──────┴──────┘/u);
	});

	it("renders expanded tool content in super-compact mode", () => {
		const lines = renderConversationEntry({
			id: "tool-compact",
			kind: "tool",
			toolCallId: "call-1",
			toolName: "read",
			argsText: JSON.stringify({ path: "file.txt" }),
			output: "expanded body",
			expanded: true,
			isError: false,
			status: "done",
		}, 80, { ...renderOptions, superCompactTools: true });

		assert.ok(lines.length > 1);
		assert.ok(lines.some((line) => line.text.includes("expanded body")));
	});

	it("keeps all thinking expanded without blank body rows in super-compact mode", () => {
		const lines = renderConversationEntry({
			id: "thinking-compact-expanded",
			kind: "thinking",
			text: "Plan\n\n- detail",
			expanded: false,
			status: "done",
		}, 80, { ...renderOptions, superCompactTools: true, allThinkingExpanded: true });

		assert.ok(lines.length > 1);
		assert.ok(lines.some((line) => line.text.includes("detail")));
		assert.ok(lines.every((line) => line.text.trim().length > 0));
	});

	it("marks tool image labels as clickable image targets", () => {
		const image = { type: "image" as const, data: Buffer.from("png").toString("base64"), mimeType: "image/png" };
		const lines = renderConversationEntry({
			id: "tool-image",
			kind: "tool",
			toolCallId: "call-image",
			toolName: "read",
			argsText: JSON.stringify({ path: "image.png" }),
			output: "[Image: image/png]",
			images: [image],
			expanded: true,
			isError: false,
			status: "done",
		}, 80, renderOptions);
		const imageLine = lines.find((line) => line.text.includes("[Image: image/png]"));

		assert.deepEqual(imageLine?.imageTargets, [{ start: 2, end: 20, entryId: "tool-image", imageIndex: 0 }]);
		assert.deepEqual(imageLine?.segments, [{ start: 2, end: 20, foreground: THEMES.dark.colors.info, underline: true }]);
	});

	it("renders ANSI colors in expanded shell output as styled segments", () => {
		const lines = renderConversationEntry({
			id: "tool-shell-ansi",
			kind: "tool",
			toolCallId: "call-shell-ansi",
			toolName: "shell",
			argsText: JSON.stringify({ command: "printf colors" }),
			output: "\x1b[31mred\x1b[0m ok",
			expanded: true,
			isError: false,
			status: "done",
		}, 80, renderOptions);

		const outputLine = lines.find((line) => line.text.includes("red ok"));
		assert.equal(outputLine?.text, "  red ok");
		assert.deepEqual(outputLine?.segments, [{ start: 2, end: 5, foreground: "#cd3131" }]);
	});

	it("strips ANSI escapes from collapsed shell previews", () => {
		const lines = renderConversationEntry({
			id: "tool-shell-ansi-collapsed",
			kind: "tool",
			toolCallId: "call-shell-ansi-collapsed",
			toolName: "shell",
			argsText: JSON.stringify({ command: "printf colors" }),
			output: "\x1b[32mgreen\x1b[0m",
			expanded: false,
			isError: false,
			status: "done",
		}, 80, renderOptions);

		assert(lines.some((line) => line.text === "  green"));
		assert.doesNotMatch(lines.map((line) => line.text).join("\n"), /\x1b/u);
	});

	it("keeps ANSI color segments across wrapped shell output", () => {
		const lines = renderConversationEntry({
			id: "tool-shell-ansi-wrap",
			kind: "tool",
			toolCallId: "call-shell-ansi-wrap",
			toolName: "shell",
			argsText: JSON.stringify({ command: "printf wrapped" }),
			output: "\x1b[31mabcdefghi\x1b[0m",
			expanded: true,
			isError: false,
			status: "done",
		}, 8, renderOptions);

		const outputLines = lines.filter((line) => line.text === "  abcdef" || line.text === "  ghi");
		assert.deepEqual(outputLines.map((line) => line.text), ["  abcdef", "  ghi"]);
		assert.deepEqual(outputLines.map((line) => line.segments), [
			[{ start: 2, end: 8, foreground: "#cd3131" }],
			[{ start: 2, end: 5, foreground: "#cd3131" }],
		]);
	});

	it("marks expanded thinking text as markdown for syntax highlighting", () => {
		const lines = renderConversationEntry({ id: "thinking-1", kind: "thinking", text: "- Use `code`", expanded: true, status: "done" }, 80, renderOptions);

		assert.equal(lines[0]?.syntaxHighlight, undefined);
		assert.deepEqual(lines[1]?.syntaxHighlight, { language: "markdown", start: 2 });
	});

	it("wraps expanded thinking text at word boundaries", () => {
		const lines = renderConversationEntry({ id: "thinking-wrap", kind: "thinking", text: "alpha beta gamma", expanded: true, status: "done" }, 12, renderOptions);

		assert.deepEqual(lines.slice(1).map((line) => line.text), ["  alpha beta", "  gamma"]);
	});

	it("removes trailing blank lines from expanded thinking text", () => {
		const lines = renderConversationEntry({ id: "thinking-trailing-blank", kind: "thinking", text: "alpha\n\n \t", expanded: true, status: "done" }, 80, renderOptions);

		assert.deepEqual(lines.slice(1).map((line) => line.text), ["  alpha"]);
	});


	it("uses fenced code languages inside expanded thinking text", () => {
		const lines = renderConversationEntry({
			id: "thinking-code",
			kind: "thinking",
			text: "```typescript\nconst answer = true;\n```",
			expanded: true,
			status: "done",
		}, 80, renderOptions);

		assert.deepEqual(lines.map((line) => line.syntaxHighlight?.language), [undefined, "markdown", "typescript", "markdown"]);
		assert.deepEqual(lines[2]?.syntaxHighlight, { language: "typescript", start: 2 });
	});

	it("wraps wide markdown tables inside expanded thinking text", () => {
		const lines = renderConversationEntry({
			id: "thinking-table",
			kind: "thinking",
			text: [
				"| A | B |",
				"|---|---|",
				"| short | one two three four five |",
				"| second | six seven |",
			].join("\n"),
			expanded: true,
			status: "done",
		}, 27, renderOptions);

		const bodyLines = lines.slice(1);
		assert(bodyLines.every((line) => stringDisplayWidth(line.text) <= 27));
		assert.deepEqual(bodyLines.map((line) => line.text), [
			"  ┌────────┬──────────────┐",
			"  │ A      │ B            │",
			"  ├────────┼──────────────┤",
			"  │ short  │ one two      │",
			"  │        │ three four   │",
			"  │        │ five         │",
			"  ├────────┼──────────────┤",
			"  │ second │ six seven    │",
			"  └────────┴──────────────┘",
		]);
	});

	it("does not rewrap markdown table rows with hidden strong markers", () => {
		const lines = renderConversationEntry({
			id: "thinking-bold-table",
			kind: "thinking",
			text: [
				"| \u041f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440 | \u0410\u0432\u0442\u043e\u0440\u0438\u0437\u0430\u0446\u0438\u044f | API-\u044d\u043d\u0434\u043f\u043e\u0438\u043d\u0442 |",
				"|---|---|---|",
				"| **OpenAI** | OAuth-token \u0438\u0437 `~/.local/share/opencode/auth.json` (fallback — `<piAgentDir>/auth.json`) | `chatgpt.com/backend-api/wham/usage` |",
			].join("\n"),
			expanded: true,
			status: "done",
		}, 100, renderOptions);

		const bodyLines = lines.slice(1);
		assert(bodyLines.every((line) => stringDisplayWidth(line.text) <= 100));
		assert(bodyLines.every((line) => /^  [┌│├└]/u.test(line.text)));
		assert(bodyLines.some((line) => line.text.includes("`chatgpt.com/backend-api/wham/usage`")));
	});
});

describe("ConversationViewport super-compact tools", () => {
	it("removes blank gaps between adjacent tool entries", () => {
		const entries: Entry[] = [
			toolEntry("tool-1", "read"),
			toolEntry("tool-2", "shell"),
		];
		const viewport = new ConversationViewport({
			entries,
			session: undefined,
			deferredUserMessages: [],
			entryRenderVersions: new Map(),
			cwd: "/repo",
			colors: THEMES.dark.colors,
			pixConfig,
			outputFilters: [],
			superCompactTools: true,
			isDynamicConversationBlock: () => false,
			renderInlineUserMessageMenu: () => [],
		});

		const lines = viewport.slice(80, 0, 3).map((line) => line.text);

		assert.equal(viewport.lineCount(80), 2);
		assert.match(lines[0] ?? "", /read/u);
		assert.match(lines[1] ?? "", /shell/u);
		assert.equal(lines[2], undefined);
	});

	it("removes blank gaps around thinking entries across empty assistant messages", () => {
		const entries: Entry[] = [
			toolEntry("tool-1", "read"),
			{ id: "thinking-1", kind: "thinking", text: "", expanded: true, status: "done" },
			{ id: "assistant-empty", kind: "assistant", text: "" },
			toolEntry("tool-2", "read"),
		];
		const viewport = new ConversationViewport({
			entries,
			session: undefined,
			deferredUserMessages: [],
			entryRenderVersions: new Map(),
			cwd: "/repo",
			colors: THEMES.dark.colors,
			pixConfig,
			outputFilters: [],
			superCompactTools: true,
			isDynamicConversationBlock: () => false,
			renderInlineUserMessageMenu: () => [],
		});

		const lines = viewport.slice(80, 0, 4).map((line) => line.text);

		assert.equal(viewport.lineCount(80), 3);
		assert.match(lines[0] ?? "", /read/u);
		assert.match(lines[1] ?? "", /thinking/u);
		assert.match(lines[2] ?? "", /read/u);
		assert.equal(lines[3], undefined);
	});

	it("removes blank gaps around expanded thinking entries in all-thinking mode", () => {
		const entries: Entry[] = [
			toolEntry("tool-1", "read"),
			{ id: "thinking-1", kind: "thinking", text: "Plan\n\n- detail", expanded: false, status: "done" },
			toolEntry("tool-2", "read"),
		];
		const viewport = new ConversationViewport({
			entries,
			session: undefined,
			deferredUserMessages: [],
			entryRenderVersions: new Map(),
			cwd: "/repo",
			colors: THEMES.dark.colors,
			pixConfig,
			outputFilters: [],
			superCompactTools: true,
			allThinkingExpanded: true,
			isDynamicConversationBlock: () => false,
			renderInlineUserMessageMenu: () => [],
		});

		const lines = viewport.slice(80, 0, 10).map((line) => line.text);

		assert.equal(viewport.lineCount(80), 5);
		assert.equal(lines.length, 5);
		assert.match(lines[0] ?? "", /read/u);
		assert.match(lines[1] ?? "", /thinking/u);
		assert.equal(lines[2], "  Plan");
		assert.equal(lines[3], "  - detail");
		assert.match(lines[4] ?? "", /read/u);
		assert.ok(lines.every((line) => line.trim().length > 0));
	});
});

function toolEntry(id: string, toolName: string): Entry {
	return {
		id,
		kind: "tool",
		toolCallId: id,
		toolName,
		argsText: "{}",
		output: "body",
		expanded: false,
		isError: false,
		status: "done",
	};
}
