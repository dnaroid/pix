import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { EventTranslator } from "../src/acp/event-translator.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

const CONTEXT = { sessionId: "s1", cwd: "/work/repo" };

type ToolCall = Extract<SessionUpdate, { sessionUpdate: "tool_call" }>;
type ToolCallUpdated = Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>;

function asToolCall(update: SessionUpdate): ToolCall {
	assert.equal(update.sessionUpdate, "tool_call");
	return update as ToolCall;
}

function asToolCallUpdate(update: SessionUpdate): ToolCallUpdated {
	assert.equal(update.sessionUpdate, "tool_call_update");
	return update as ToolCallUpdated;
}

function updates(events: readonly JsonAgentSessionEvent[]): SessionUpdate[] {
	const translator = new EventTranslator(CONTEXT);
	return events.flatMap((event) => translator.translate(event).map((n) => n.update));
}

/** Run one event through a fresh translator (stateless cases). */
function one(event: JsonAgentSessionEvent): SessionUpdate[] {
	return updates([event]);
}

function messageUpdate(type: string, delta: string): JsonAgentSessionEvent {
	return {
		type: "message_update",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
		assistantMessageEvent: { type, contentIndex: 0, delta },
	} as unknown as JsonAgentSessionEvent;
}

test("text deltas stream as agent_message_chunk", () => {
	const [update] = one(messageUpdate("text_delta", "Hello"));
	assert.equal(update.sessionUpdate, "agent_message_chunk");
	assert.deepEqual(update.content, { type: "text", text: "Hello" });
});

test("thinking deltas stream as agent_thought_chunk", () => {
	const [update] = one(messageUpdate("thinking_delta", "hmm"));
	assert.equal(update.sessionUpdate, "agent_thought_chunk");
	assert.deepEqual(update.content, { type: "text", text: "hmm" });
});

test("non-delta message events produce nothing", () => {
	assert.deepEqual(one(messageUpdate("text_start", "")), []);
	assert.deepEqual(one(messageUpdate("done", "")), []);
});

test("tool_execution_start maps metadata, kind, and absolute locations", () => {
	const update = asToolCall(one({
		type: "tool_execution_start",
		toolCallId: "t1",
		toolName: "read",
		args: { path: "src/main.ts" },
	})[0]!);
	assert.equal(update.toolCallId, "t1");
	assert.equal(update.name, "read");
	assert.equal(update.title, "Read src/main.ts");
	assert.equal(update.kind, "read");
	assert.equal(update.status, "in_progress");
	assert.deepEqual(update.locations, [{ path: "/work/repo/src/main.ts" }]);
});

test("suite-style capitalized tool names map to the same kinds and locations", () => {
	const update = asToolCall(one({
		type: "tool_execution_start",
		toolCallId: "t1",
		toolName: "Write",
		args: { file_path: "out.ts", content: "x" },
	})[0]!);
	assert.equal(update.name, "Write");
	assert.equal(update.title, "Write out.ts");
	assert.equal(update.kind, "edit");
	assert.deepEqual(update.locations, [{ path: "/work/repo/out.ts" }]);
});

test("bash titles show the first command line, truncated to 80 chars", () => {
	const command = `echo ${"x".repeat(200)}`;
	const update = asToolCall(one({
		type: "tool_execution_start",
		toolCallId: "t2",
		toolName: "bash",
		args: { command },
	})[0]!);
	assert.equal(update.kind, "execute");
	assert.ok(update.title.startsWith("Bash: echo xxx"));
	assert.equal(update.title.length, 80);
});

test("tool_execution_end reports text content, status, and raw output", () => {
	const update = asToolCallUpdate(one({
		type: "tool_execution_end",
		toolCallId: "t3",
		toolName: "read",
		result: { content: [{ type: "text", text: "body" }], details: { lines: 1 } },
		isError: false,
	})[0]!);
	assert.equal(update.status, "completed");
	assert.deepEqual(update.content, [{ type: "content", content: { type: "text", text: "body" } }]);
	assert.deepEqual(update.rawOutput, { lines: 1 });
});

test("failed tool executions keep status failed without diffs", () => {
	const all = updates([
		{ type: "tool_execution_start", toolCallId: "t4", toolName: "edit", args: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] } },
		{ type: "tool_execution_end", toolCallId: "t4", toolName: "edit", result: { content: [{ type: "text", text: "boom" }] }, isError: true },
	]);
	const toolUpdate = asToolCallUpdate(all[all.length - 1]!);
	assert.equal(toolUpdate.status, "failed");
	assert.deepEqual(toolUpdate.content, [{ type: "content", content: { type: "text", text: "boom" } }]);
});

test("edit end emits a structured diff using args recorded at start", () => {
	const all = updates([
		{ type: "tool_execution_start", toolCallId: "t5", toolName: "edit", args: { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] } },
		{ type: "tool_execution_end", toolCallId: "t5", toolName: "edit", result: { content: [], details: { diff: "-old +new" } }, isError: false },
	]);
	const update = asToolCallUpdate(all[all.length - 1]!);
	assert.deepEqual(update.content, [{ type: "diff", path: "/work/repo/src/a.ts", oldText: "old", newText: "new" }]);
});

test("edit end without a recorded start emits no diffs", () => {
	const update = asToolCallUpdate(one({
		type: "tool_execution_end",
		toolCallId: "t-missing",
		toolName: "edit",
		result: { content: [] },
		isError: false,
	})[0]!);
	assert.equal(update.status, "completed");
	assert.equal(update.content, undefined);
});

test("write end emits a new-file diff without oldText", () => {
	const all = updates([
		{ type: "tool_execution_start", toolCallId: "t6", toolName: "write", args: { path: "new.ts", content: "hello" } },
		{ type: "tool_execution_end", toolCallId: "t6", toolName: "write", result: { content: [] }, isError: false },
	]);
	const update = asToolCallUpdate(all[all.length - 1]!);
	assert.deepEqual(update.content, [{ type: "diff", path: "/work/repo/new.ts", newText: "hello" }]);
});

test("tool_execution_update forwards partial text content", () => {
	const update = asToolCallUpdate(one({
		type: "tool_execution_update",
		toolCallId: "t7",
		toolName: "bash",
		args: {},
		partialResult: { content: [{ type: "text", text: "partial output" }] },
	})[0]!);
	assert.equal(update.toolCallId, "t7");
	assert.deepEqual(update.content, [{ type: "content", content: { type: "text", text: "partial output" } }]);
});

test("tool_execution_update without content is dropped", () => {
	assert.deepEqual(
		one({ type: "tool_execution_update", toolCallId: "t8", toolName: "bash", args: {}, partialResult: {} }),
		[],
	);
});

test("lifecycle and unmapped events produce nothing", () => {
	assert.deepEqual(one({ type: "agent_start" }), []);
	assert.deepEqual(one({ type: "agent_settled" }), []);
	assert.deepEqual(one({ type: "queue_update", steering: [], followUp: [] }), []);
	assert.deepEqual(one({ type: "bash_execution_update", delta: "out" }), []);
});
