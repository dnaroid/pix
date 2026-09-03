import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { replaySessionHistory } from "../src/acp/session-replay.js";
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
