import assert from "node:assert/strict";
import { it } from "node:test";

import { AppSessionEventController } from "../src/app/session/session-event-controller.js";
import { renderConversationEntry } from "../src/app/rendering/conversation-entry-renderer.js";
import { defaultPixConfig } from "../src/config.js";
import { THEMES } from "../src/theme.js";
import type { Entry, RenderedLine } from "../src/app/types.js";
import type { AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Integration-level regression tests for three streaming/render bugs that were
 * fixed in `AppSessionEventController`. Unlike the pure controller unit tests
 * (which assert on internal `entries` state), these feed a mocked event stream
 * through the *real* controller and then render the resulting entries through
 * the real `renderConversationEntry` pipeline, asserting on the flattened
 * user-visible transcript. This catches regressions that would only surface in
 * the rendered output (e.g. an empty `thinking` header, a duplicated assistant
 * block, or a trailing thinking block after the final answer).
 */

const RENDER_WIDTH = 80;
const COLORS = THEMES.dark.colors;
const PIX_CONFIG = defaultPixConfig();
const OUTPUT_FILTERS: readonly RegExp[] = [];

interface RenderHarness {
	readonly entries: Entry[];
	readonly controller: AppSessionEventController;
}

function createHarness(): RenderHarness {
	const entries: Entry[] = [];
	const controller = new AppSessionEventController({
		entries,
		runtime: () => ({ session: { isStreaming: false } }) as AgentSessionRuntime,
		conversationViewport: () => ({ deleteEntry: () => {} }) as never,
		isRunning: () => false,
		render: () => {},
		scheduleRender: () => {},
		setStatus: () => {},
		restoreSessionStatus: () => {},
		setSessionStatus: () => {},
		setSessionActivity: () => {},
		updateQueuedMessageStatus: () => {},
		flushAutoUserMessages: () => {},
		prepareWorkspaceMutation: () => undefined,
		workspaceMutationFromToolExecution: () => undefined,
		recordWorkspaceMutationForUserEntry: () => {},
		scheduleUserSessionEntryMetadataSync: () => {},
		toolDefaultExpanded: () => false,
		observeSubagentsToolResult: () => {},
		observeTodoToolResult: () => {},
		showToast: () => {},
	});
	return { entries, controller };
}

function renderTranscript(entries: readonly Entry[]): string {
	const options = {
		cwd: "/test",
		colors: COLORS,
		pixConfig: PIX_CONFIG,
		outputFilters: OUTPUT_FILTERS,
		renderInlineUserMessageMenu: () => [],
	};
	const lines: RenderedLine[] = [];
	for (const entry of entries) {
		lines.push(...renderConversationEntry(entry, RENDER_WIDTH, options));
	}
	// Strip trailing whitespace per line so assertions are layout-insensitive.
	return lines.map((line) => line.text.replace(/\s+$/u, "")).join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = 0;
	while ((index = haystack.indexOf(needle, index)) !== -1) {
		count += 1;
		index += needle.length;
	}
	return count;
}

function emit(controller: AppSessionEventController, event: AgentSessionEvent): void {
	controller.handleSessionEvent(event);
}

it("does not render trailing thinking after final answer", () => {
	const { entries, controller } = createHarness();

	// A realistic stream: thinking, then the final assistant answer, then the
	// stream closing — followed by stale thinking events that arrive late
	// (duplicated/out-of-order from the provider). Without the fix, a trailing
	// thinking block would appear in the transcript *after* the final answer.
	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "Initial reasoning" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", content: "Initial reasoning" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "PIX-FINAL-ANSWER" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "done" },
	} as unknown as AgentSessionEvent);
	// Stale thinking events arriving after the answer is complete.
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", content: "PIX-TRAILING-THINKING" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "PIX-TRAILING-DELTA" },
	} as unknown as AgentSessionEvent);

	const transcript = renderTranscript(entries);

	// The final answer must be present exactly once.
	assert.equal(countOccurrences(transcript, "PIX-FINAL-ANSWER"), 1);
	// No trailing thinking block or its content may leak into the transcript.
	assert.equal(countOccurrences(transcript, "PIX-TRAILING-THINKING"), 0);
	assert.equal(countOccurrences(transcript, "PIX-TRAILING-DELTA"), 0);
	// The final rendered entry must not be a thinking block: the answer must be
	// the last content the user sees.
	assert.notEqual(transcript.trim().endsWith("PIX-FINAL-ANSWER"), false,
		`expected transcript to end with the final answer\n\n${transcript}`);
});

it("does not render empty signature-only thinking blocks", () => {
	const { entries, controller } = createHarness();

	// Provider emits an empty thinking delta and a thinking_end carrying only an
	// empty/signature-only reasoning block, then a normal assistant answer and a
	// tool call. Without the fix, an empty `thinking` header (rendered as
	// "<icon> thinking" with an "(empty)" body) would appear in the transcript.
	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", content: "" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "PIX-ANSWER-WITH-TOOL" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: { type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo ok" } },
			partial: { role: "assistant", content: [] },
		},
	} as unknown as AgentSessionEvent);

	const transcript = renderTranscript(entries);

	// No empty thinking block: the thinking header must not appear as a lone
	// header with an "(empty)" body. (The header word "thinking" may legitimately
	// appear inside expanded content, so assert against the empty-body marker.)
	assert.equal(countOccurrences(transcript, "(empty)"), 0, `empty thinking body leaked\n\n${transcript}`);
	// The assistant answer and the tool call must both render normally.
	assert.ok(transcript.includes("PIX-ANSWER-WITH-TOOL"), `assistant answer missing\n\n${transcript}`);
	assert.ok(/shell\b/u.test(transcript), `tool call header missing\n\n${transcript}`);
	// Entry order: assistant, then tool — no thinking entry at all.
	assert.deepEqual(entries.map((entry) => entry.kind), ["assistant", "tool"]);
});

it("does not duplicate assistant text when late text_end arrives after tool call", () => {
	const { entries, controller } = createHarness();

	// text_delta for contentIndex 0, then a tool call at contentIndex 1 (which
	// flushes the in-flight assistant text), then a *late* text_end for the same
	// contentIndex 0 carrying the same content. Without the fix, the late
	// text_end would re-create a second assistant block with the duplicated text.
	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "PIX-BEFORE-TOOL",
			partial: { role: "assistant", content: [{ type: "text", text: "PIX-BEFORE-TOOL" }] },
		},
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_start",
			contentIndex: 1,
			partial: { role: "assistant", content: [{ type: "text", text: "PIX-BEFORE-TOOL" }, { type: "toolCall" }] },
		},
	} as unknown as AgentSessionEvent);
	// Late text_end for the already-flushed block 0, carrying the same text.
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_end",
			contentIndex: 0,
			content: "PIX-BEFORE-TOOL",
			partial: { role: "assistant", content: [{ type: "text", text: "PIX-BEFORE-TOOL" }] },
		},
	} as unknown as AgentSessionEvent);

	const transcript = renderTranscript(entries);

	// The assistant text must appear exactly once in the rendered transcript.
	assert.equal(countOccurrences(transcript, "PIX-BEFORE-TOOL"), 1,
		`assistant text duplicated in transcript\n\n${transcript}`);
	// Entry order: a single assistant block followed by the tool entry.
	assert.deepEqual(entries.map((entry) => entry.kind), ["assistant", "tool"]);
});
