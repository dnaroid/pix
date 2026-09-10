import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
	deferredSessionHistoryFromMessages,
	deferredToolResultUpdate,
	replaySessionHistory,
} from "../src/acp/session-replay.js";
import type { PiAgentMessage, PiClient } from "../src/pi/pi-rpc-client.js";

test("replayed failed mutations retain failed status", async () => {
	const messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts", edits: [] } }],
		},
		{
			role: "toolResult",
			toolCallId: "edit-1",
			isError: true,
			content: [{ type: "text", text: "edit failed" }],
		},
	] as unknown as PiAgentMessage[];
	const notifications: SessionNotification[] = [];
	const pi = { getMessages: async () => messages } as unknown as PiClient;

	await replaySessionHistory(pi, { sessionId: "session-1", cwd: "/repo" }, async (notification) => {
		notifications.push(notification);
	});

	const result = notifications.find((notification) => notification.update.sessionUpdate === "tool_call_update");
	assert.equal(result?.update.sessionUpdate, "tool_call_update");
	assert.equal(result.update.status, "failed");
});

test("desktop lazy tool hydration preserves normalized details, images, and status without mutating history", () => {
	const messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "/repo/big.log" } }],
		},
		{
			role: "toolResult",
			toolCallId: "read-1",
			isError: false,
			content: [
				{ type: "text", text: "bounded result" },
				{ type: "image", data: "QUJDRA==", mimeType: "image/png" },
			],
			details: {
				truncation: {
					truncated: true,
					truncatedBy: "bytes",
					totalLines: 2300,
					outputLines: 400,
					totalBytes: 140000,
					outputBytes: 24000,
					lastLinePartial: false,
					firstLineExceedsLimit: false,
					maxLines: 2000,
					maxBytes: 51200,
				},
				fullOutputPath: "/tmp/pi-bash-final.log",
			},
		},
	] as unknown as PiAgentMessage[];
	const before = structuredClone(messages);

	const history = deferredSessionHistoryFromMessages(messages, { sessionId: "session-1", cwd: "/repo" });
	const light = history.updates.find((update) => update.sessionUpdate === "tool_call_update");
	assert.equal(light?.sessionUpdate, "tool_call_update");
	assert.equal(light.status, "completed");
	assert.equal("content" in light, false, "lazy history keeps tool body deferred");
	assert.equal("rawOutput" in light, false, "lazy history keeps details deferred");

	const deferred = history.toolResults.get("read-1");
	assert.ok(deferred);
	const hydrated = deferredToolResultUpdate({ sessionId: "session-1", cwd: "/repo" }, deferred);
	assert.ok(hydrated);
	const hydratedRecord = hydrated as unknown as Record<string, unknown>;
	assert.equal(hydratedRecord.status, "completed");
	assert.deepEqual(hydratedRecord.rawInput, { path: "/repo/big.log" });
	assert.deepEqual(hydratedRecord.content, [
		{ type: "content", content: { type: "text", text: "bounded result" } },
		{ type: "content", content: { type: "image", data: "QUJDRA==", mimeType: "image/png" } },
	]);
	const sourceDetails = (messages[1] as unknown as { details: unknown }).details;
	assert.deepEqual(hydratedRecord.rawOutput, sourceDetails);
	assert.equal(JSON.stringify(hydratedRecord.rawOutput).includes('"content"'), false, "normalized truncation metadata stays normalized on replay");
	assert.deepEqual(messages, before, "history translation is UI-only and does not rewrite stored messages");
});

test("desktop replay does not retroactively normalize legacy tool-result metadata", () => {
	const legacyDuplicate = "LEGACY_TRUNCATION_DUPLICATE";
	const messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "legacy-read", name: "read", arguments: { path: "/repo/legacy.log" } }],
		},
		{
			role: "toolResult",
			toolCallId: "legacy-read",
			isError: false,
			content: [{ type: "text", text: legacyDuplicate }],
			details: {
				truncation: {
					content: legacyDuplicate,
					truncated: true,
					truncatedBy: "bytes",
					totalLines: 2,
					outputLines: 1,
					totalBytes: 100,
					outputBytes: 50,
					lastLinePartial: false,
					firstLineExceedsLimit: false,
					maxLines: 2000,
					maxBytes: 51200,
				},
			},
		},
	] as unknown as PiAgentMessage[];

	const history = deferredSessionHistoryFromMessages(messages, { sessionId: "session-legacy", cwd: "/repo" });
	const deferred = history.toolResults.get("legacy-read");
	assert.ok(deferred);
	const hydrated = deferredToolResultUpdate({ sessionId: "session-legacy", cwd: "/repo" }, deferred);
	assert.ok(hydrated);
	const rawOutput = (hydrated as unknown as Record<string, unknown>).rawOutput;
	assert.equal(JSON.stringify(rawOutput).includes(legacyDuplicate), true, "replay reflects persisted history instead of rewriting it");
});

test("desktop history preserves thinking blocks and assistant/tool ordering", () => {
	const messages = [
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "inspect the implementation" },
				{ type: "toolCall", id: "read-ordered", name: "read", arguments: { path: "src/a.ts" } },
				{ type: "text", text: "First result." },
				{ type: "thinking", thinking: "compare the tests" },
				{ type: "text", text: "Second result." },
			],
		},
	] as unknown as PiAgentMessage[];

	const history = deferredSessionHistoryFromMessages(messages, { sessionId: "session-order", cwd: "/repo" });
	assert.deepEqual(history.updates.map((update) => update.sessionUpdate), [
		"agent_thought_chunk",
		"tool_call",
		"agent_message_chunk",
		"agent_thought_chunk",
		"agent_message_chunk",
	]);
	assert.deepEqual(
		history.updates
			.filter((update) => update.sessionUpdate === "agent_thought_chunk")
			.map((update) => update.content),
		[
			{ type: "text", text: "inspect the implementation" },
			{ type: "text", text: "compare the tests" },
		],
	);
	assert.deepEqual(
		history.updates
			.filter((update) => update.sessionUpdate === "agent_message_chunk")
			.map((update) => update.messageId),
		["replay-0:text:0", "replay-0:text:1"],
	);
});
