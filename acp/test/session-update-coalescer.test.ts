import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { SessionUpdateCoalescer } from "../src/acp/session-update-coalescer.js";

function note(update: Record<string, unknown>, sessionId = "s1"): SessionNotification {
	return { sessionId, update: update as SessionUpdate };
}

const text = (kind: "agent_message_chunk" | "agent_thought_chunk", value: string, extra: Record<string, unknown> = {}) =>
	note({ sessionUpdate: kind, content: { type: "text", text: value }, ...extra });

const partial = (toolCallId: string, value: string) =>
	note({ sessionUpdate: "tool_call_update", toolCallId, content: [{ type: "content", content: { type: "text", text: value } }] });

function harness() {
	const sent: SessionNotification[] = [];
	return { sent, coalescer: new SessionUpdateCoalescer((notification) => sent.push(notification)) };
}

test("merges a synchronous burst of text deltas into one notification at the end of the microtask", async () => {
	const { sent, coalescer } = harness();
	coalescer.push(text("agent_message_chunk", "Hel"));
	coalescer.push(text("agent_message_chunk", "lo"));
	coalescer.push(text("agent_message_chunk", "!"));
	assert.equal(sent.length, 0);
	await Promise.resolve();
	assert.deepEqual(sent, [text("agent_message_chunk", "Hello!")]);
});

test("never merges across kinds, message ids, sessions or _meta", async () => {
	const { sent, coalescer } = harness();
	coalescer.push(text("agent_thought_chunk", "a"));
	coalescer.push(text("agent_message_chunk", "b"));
	coalescer.push(text("agent_message_chunk", "c", { messageId: "m2" }));
	coalescer.push(text("agent_message_chunk", "d", { _meta: { k: 1 } }));
	coalescer.push(note({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "e" } }, "s2"));
	await Promise.resolve();
	assert.deepEqual(sent.map((entry) => (entry.update as { content: { text: string } }).content.text), ["a", "b", "c", "d", "e"]);
});

test("keeps only the latest partial tool update but preserves terminal updates", async () => {
	const { sent, coalescer } = harness();
	coalescer.push(partial("t1", "one"));
	coalescer.push(partial("t1", "one two"));
	coalescer.push(partial("t2", "other"));
	coalescer.push(partial("t2", "other more"));
	assert.equal(sent.length, 0);
	coalescer.push(note({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed" }));
	// Non-streaming updates flush synchronously, in order, after pending ones.
	assert.deepEqual(sent, [
		partial("t1", "one two"),
		partial("t2", "other more"),
		note({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed" }),
	]);
});

test("explicit flush preserves order before a later message, and dispose drops later pushes", async () => {
	const { sent, coalescer } = harness();
	coalescer.push(text("agent_message_chunk", "x"));
	coalescer.flush();
	assert.equal(sent.length, 1);
	coalescer.push(text("agent_message_chunk", "y"));
	coalescer.dispose();
	assert.equal(sent.length, 2);
	coalescer.push(text("agent_message_chunk", "z"));
	await Promise.resolve();
	assert.equal(sent.length, 2);
});
