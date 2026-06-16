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
		toolDefaultExpanded: () => true,
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

// Additional regression coverage for streaming/render edge cases found by
// probing the event stream with a mock LLM. Each test feeds a synthetic
// AgentSessionEvent sequence through the real controller and asserts on the
// rendered transcript.

it("does not wipe streamed assistant text when a late text_end carries empty content", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "PIX-KEEP-ME" },
	} as unknown as AgentSessionEvent);
	// Provider quirk: text_end arrives with empty content (content filtering,
	// truncation, or a buggy gateway). Already-rendered text must survive.
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "" },
	} as unknown as AgentSessionEvent);

	const transcript = renderTranscript(entries);
	assert.ok(transcript.includes("PIX-KEEP-ME"), `streamed text wiped by empty text_end\n\n${transcript}`);
});

it("keeps tool output when a later tool_execution_update carries empty content", () => {
	const { entries, controller } = createHarness();

	emit(controller, {
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "shell",
		args: { command: "echo partial" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "tool_execution_update",
		toolCallId: "call-1",
		toolName: "shell",
		args: { command: "echo partial" },
		partialResult: { content: [{ type: "text", text: "PIX-PARTIAL-OUT" }], details: {} },
	} as unknown as AgentSessionEvent);
	// A subsequent partial update with empty content must not erase the output
	// already shown to the user.
	emit(controller, {
		type: "tool_execution_update",
		toolCallId: "call-1",
		toolName: "shell",
		args: { command: "echo partial" },
		partialResult: { content: [], details: {} },
	} as unknown as AgentSessionEvent);

	const transcript = renderTranscript(entries);
	assert.ok(transcript.includes("PIX-PARTIAL-OUT"), `tool output wiped by empty-content update\n\n${transcript}`);
});

// CONSCIOUS TRADE-OFF (documents current behaviour, not a defect):
// Once assistant text has started within a turn, a NEW thinking block is
// suppressed. This guard is the dual of the trailing-thinking fix: relaxing it
// would re-introduce stale duplicate thinking after the answer (see
// "ignores stale thinking updates after assistant text has started" in
// session-event-controller.test.ts). The two cases are indistinguishable in pi's
// event model (only thinking_delta/thinking_end, no per-block start id), so the
// safer default — suppress — is locked in here. Providers that interleave
// reasoning and text (rare in coding contexts) will lose the later block.
it("suppresses a second reasoning block that arrives after assistant text has started", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "PIX-FIRST-THINKING" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", content: "PIX-FIRST-THINKING" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "PIX-MID-ANSWER" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "PIX-SECOND-THINKING" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", content: "PIX-SECOND-THINKING" },
	} as unknown as AgentSessionEvent);

	const transcript = renderTranscript(entries);
	assert.equal(countOccurrences(transcript, "PIX-SECOND-THINKING"), 0,
		`second reasoning block should be suppressed (conscious trade-off with trailing-thinking fix)\n\n${transcript}`);
	assert.ok(transcript.includes("PIX-FIRST-THINKING"), `first reasoning block should remain\n\n${transcript}`);
});

// CONSCIOUS TRADE-OFF (documents current behaviour, not a defect):
// Markdown reference-definition lines (`[label]: url`) are hidden from the
// rendered assistant text. This keeps control/reference metadata from leaking
// into the transcript. Legitimate model-authored reference definitions are
// caught by the same filter — see the dedicated coverage in
// markdown-format.test.ts ("hides markdown reference definitions outside fenced
// code blocks"). If that trade-off is ever revisited, this test will flag it.
it("hides markdown reference-definition lines from the rendered assistant text", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "See [pi][pi-link] for details.\n[pi-link]: https://example.com/pi\nDone.",
		},
	} as unknown as AgentSessionEvent);

	const transcript = renderTranscript(entries);
	assert.equal(countOccurrences(transcript, "[pi-link]: https://example.com/pi"), 0,
		`reference-definition line should be hidden (conscious trade-off)\n\n${transcript}`);
	assert.ok(transcript.includes("Done."), `non-reference text should still render\n\n${transcript}`);
});

it("does not clobber a later text block when an earlier text_end arrives late", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: { role: "assistant", content: [] } },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "PIX-BLOCK-ZERO" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: { role: "assistant", content: [{ type: "text", text: "PIX-BLOCK-ZERO" }] } },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "PIX-BLOCK-ONE" },
	} as unknown as AgentSessionEvent);
	// Late text_end for the already-finished block 0.
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "PIX-BLOCK-ZERO" },
	} as unknown as AgentSessionEvent);

	const transcript = renderTranscript(entries);
	assert.ok(transcript.includes("PIX-BLOCK-ONE"),
		`later text block clobbered by early-block late text_end\n\n${transcript}`);
	assert.equal(countOccurrences(transcript, "PIX-BLOCK-ZERO"), 1,
		`early block text duplicated or lost\n\n${transcript}`);
});

it("does not create a duplicate tool entry when execution starts before toolcall_end", () => {
	const { entries, controller } = createHarness();

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
	// Tool execution begins BEFORE toolcall_end finalises the call id (real race
	// when the SDK starts executing as soon as it sees enough of the call).
	emit(controller, {
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "shell",
		args: { command: "echo ok" },
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: { type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo ok" } },
			partial: { role: "assistant", content: [{ type: "text", text: "PIX-BEFORE-TOOL" }, { type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo ok" } }] },
		},
	} as unknown as AgentSessionEvent);
	emit(controller, {
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "shell",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	} as unknown as AgentSessionEvent);

	const toolEntries = entries.filter((entry) => entry.kind === "tool");
	assert.equal(toolEntries.length, 1,
		`duplicate tool entries for one logical tool call\n\n${JSON.stringify(entries.map((e) => ({ kind: e.kind, id: e.id, ...(e.kind === "tool" ? { toolCallId: e.toolCallId, toolName: e.toolName, status: e.status } : {}) })), null, 2)}`);
	assert.equal(toolEntries[0]?.kind === "tool" ? toolEntries[0].status : undefined, "done",
		`tool entry not marked done\n\n${renderTranscript(entries)}`);
});

it("does not clobber final tool args when a stale toolcall_delta arrives after toolcall_end", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	// toolcall_end delivers the final, complete tool call.
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: { type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo final-complete-args" } },
			partial: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo final-complete-args" } }] },
		},
	} as unknown as AgentSessionEvent);
	// A stale toolcall_delta with a *partial* version of the same block races in
	// after toolcall_end. The partial has only the first few chars of args.
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_delta",
			contentIndex: 0,
			delta: "{\"command\":\"echo",
			partial: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo" } }] },
		},
	} as unknown as AgentSessionEvent);

	const toolEntries = entries.filter((entry) => entry.kind === "tool");
	assert.equal(toolEntries.length, 1, `duplicate tool entries\n\n${renderTranscript(entries)}`);
	assert.ok(
		toolEntries[0]?.kind === "tool" && toolEntries[0].argsText.includes("final-complete-args"),
		`final tool args clobbered by stale toolcall_delta\n\n${JSON.stringify(toolEntries[0], null, 2)}`,
	);
});

it("strips carriage returns from streamed assistant text so CRLF line endings do not corrupt rendering", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	// Provider sends Windows-style CRLF (\r\n) line endings in a text delta.
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "PIX-CRLF-LINE\r\nPIX-CRLF-NEXT" },
	} as unknown as AgentSessionEvent);

	const assistantEntries = entries.filter((entry) => entry.kind === "assistant");
	assert.ok(assistantEntries.length >= 1, `no assistant entry rendered\n\n${renderTranscript(entries)}`);
	const text = assistantEntries.map((entry) => entry.kind === "assistant" ? entry.text : "").join("");
	assert.ok(!text.includes("\r"),
		`carriage return leaked into rendered assistant text\n\n${JSON.stringify(text)}`);
});

it("uses accumulated assistant text snapshots so split stream whitespace is not lost", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: "PIX-FIRST" }] },
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "PIX-FIRST",
			partial: { role: "assistant", content: [{ type: "text", text: "PIX-FIRST" }] },
		},
	} as unknown as AgentSessionEvent);
	// Regression shape: the delta path can be missing/lose the separator at a
	// chunk boundary, while the SDK event snapshot still carries the authoritative
	// accumulated text (the same source of truth pi's own TUI renders).
	emit(controller, {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: "PIX-FIRST PIX-SECOND" }] },
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "PIX-SECOND",
			partial: { role: "assistant", content: [{ type: "text", text: "PIX-FIRST PIX-SECOND" }] },
		},
	} as unknown as AgentSessionEvent);

	const transcript = renderTranscript(entries);
	assert.ok(transcript.includes("PIX-FIRST PIX-SECOND"),
		`assistant stream snapshot whitespace was not preserved\n\n${transcript}`);
	assert.equal(countOccurrences(transcript, "PIX-FIRSTPIX-SECOND"), 0,
		`assistant words were joined across stream chunks\n\n${transcript}`);
});

it("marks running tool entries as done when an error aborts the turn without tool_execution_end", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: { type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo ok" } },
			partial: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo ok" } }] },
		},
	} as unknown as AgentSessionEvent);
	// Tool execution starts but never finishes (session error, network timeout,
	// or user abort mid-execution). No tool_execution_end event arrives.
	emit(controller, {
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "shell",
		args: { command: "echo ok" },
	} as unknown as AgentSessionEvent);
	// The turn ends with an agent_end after an error.
	emit(controller, { type: "agent_end" } as AgentSessionEvent);

	const toolEntries = entries.filter((entry) => entry.kind === "tool");
	assert.equal(toolEntries.length, 1, `expected exactly one tool entry\n\n${renderTranscript(entries)}`);
	assert.notEqual(toolEntries[0]?.kind === "tool" ? toolEntries[0].status : undefined, "running",
		`tool entry stuck in running state after turn aborted without tool_execution_end\n\n${JSON.stringify(toolEntries[0], null, 2)}`);
});

it("renders a completed edit tool block instead of a running placeholder when only toolResult message_end arrives", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: { type: "toolCall", id: "call-1", name: "edit", arguments: { file_path: "tests/session-event-render.test.ts" } },
			partial: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: { file_path: "tests/session-event-render.test.ts" } }] },
		},
	} as unknown as AgentSessionEvent);
	// Persisted history replay can deliver only the toolResult message_end without
	// a matching live tool_execution_end event.
	emit(controller, {
		type: "message_end",
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "edit",
			content: [],
			isError: false,
		},
	} as unknown as AgentSessionEvent);

	const transcript = renderTranscript(entries);
	const toolEntries = entries.filter((entry) => entry.kind === "tool");

	assert.equal(toolEntries.length, 1, `expected exactly one tool entry\n\n${transcript}`);
	assert.equal(toolEntries[0]?.kind === "tool" ? toolEntries[0].status : undefined, "done",
		`tool entry did not finalize from toolResult message_end\n\n${JSON.stringify(toolEntries[0], null, 2)}`);
	assert.ok(/edit\b/u.test(transcript), `edit tool header missing\n\n${transcript}`);
	assert.ok(transcript.includes("(empty)"), `completed empty edit result should render as (empty)\n\n${transcript}`);
	assert.ok(!transcript.includes("running…") && !transcript.includes("running..."),
		`running placeholder leaked into completed tool block\n\n${transcript}`);
});

it("renders two consecutive tool calls as two distinct, correctly-ordered tool entries", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "PIX-PRE-TOOL", partial: { role: "assistant", content: [{ type: "text", text: "PIX-PRE-TOOL" }] } },
	} as unknown as AgentSessionEvent);
	// First tool call (contentIndex 1).
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "call-first", name: "shell", arguments: { command: "echo first" } }, partial: { role: "assistant", content: [{ type: "text", text: "PIX-PRE-TOOL" }, { type: "toolCall", id: "call-first", name: "shell", arguments: { command: "echo first" } }] } },
	} as unknown as AgentSessionEvent);
	// Second tool call (contentIndex 2).
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "call-second", name: "shell", arguments: { command: "echo second" } }, partial: { role: "assistant", content: [{ type: "text", text: "PIX-PRE-TOOL" }, { type: "toolCall", id: "call-first", name: "shell", arguments: { command: "echo first" } }, { type: "toolCall", id: "call-second", name: "shell", arguments: { command: "echo second" } }] } },
	} as unknown as AgentSessionEvent);

	const toolEntries = entries.filter((entry) => entry.kind === "tool");
	assert.equal(toolEntries.length, 2, `expected exactly two tool entries\n\n${JSON.stringify(entries.map((e) => ({ kind: e.kind, ...(e.kind === "tool" ? { toolCallId: e.toolCallId, status: e.status } : {}) })), null, 2)}`);
	const ids = toolEntries.map((entry) => entry.kind === "tool" ? entry.toolCallId : "");
	assert.deepEqual(ids, ["call-first", "call-second"], `tool entries out of order or mislabeled\n\n${renderTranscript(entries)}`);
});

it("handles tool execution starting without a preceding user message (no currentUserEntryId crash)", () => {
	const { entries, controller } = createHarness();
	// message_start assistant arrives with NO preceding message_start user.
	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo ok" } }, partial: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo ok" } }] } },
	} as unknown as AgentSessionEvent);
	// Tool execution starts; prepareToolWorkspaceMutation runs with no currentUserEntryId.
	emit(controller, {
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "shell",
		args: { command: "echo ok" },
	} as unknown as AgentSessionEvent);
	emit(controller, { type: "agent_end" } as AgentSessionEvent);

	const toolEntries = entries.filter((entry) => entry.kind === "tool");
	assert.equal(toolEntries.length, 1, `expected exactly one tool entry\n\n${renderTranscript(entries)}`);
	assert.equal(toolEntries[0]?.kind === "tool" ? toolEntries[0].status : undefined, "done",
		`tool entry should be done after agent_end\n\n${renderTranscript(entries)}`);
});

it("does not truncate already-streamed assistant text when a late text_end is shorter than the deltas", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	// Stream a long answer across multiple deltas.
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "PIX-LONG-STREAMED-ANSWER" },
	} as unknown as AgentSessionEvent);
	// Provider quirk: text_end arrives with a TRUNCATED version (the model
	// "edited" itself, or a gateway truncated). Already-shown text must survive.
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "PIX-LONG" },
	} as unknown as AgentSessionEvent);

	const transcript = renderTranscript(entries);
	assert.ok(transcript.includes("PIX-LONG-STREAMED-ANSWER"),
		`streamed answer truncated by shorter text_end\n\n${transcript}`);
});

it("finalizes the thinking entry when the session is aborted mid-streaming reasoning", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "PIX-PARTIAL-REASONING" },
	} as unknown as AgentSessionEvent);
	// User aborts while reasoning is still streaming.
	controller.addSessionAbortedEntry();

	const thinkingEntries = entries.filter((entry) => entry.kind === "thinking");
	assert.ok(thinkingEntries.length >= 1, `expected a thinking entry\n\n${renderTranscript(entries)}`);
	const status = thinkingEntries[0]?.kind === "thinking" ? thinkingEntries[0].status : undefined;
	assert.notEqual(status, "running",
		`thinking entry stuck in running state after session abort\n\n${JSON.stringify(thinkingEntries[0], null, 2)}`);
});

it("flushes the partial assistant text buffer before rendering an error entry", () => {
	const { entries, controller } = createHarness();

	emit(controller, { type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
	// Partial answer streamed but not newline-terminated (held in buffer tail).
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "PIX-PARTIAL-BUFFER-TEXT" },
	} as unknown as AgentSessionEvent);
	// Turn ends with an error before the message completes.
	emit(controller, {
		type: "message_update",
		assistantMessageEvent: { type: "error", error: { errorMessage: "upstream 500" }, reason: "upstream 500" },
	} as unknown as AgentSessionEvent);

	const transcript = renderTranscript(entries);
	assert.ok(transcript.includes("PIX-PARTIAL-BUFFER-TEXT"),
		`partial buffered assistant text lost when error arrives before flush\n\n${transcript}`);
});
