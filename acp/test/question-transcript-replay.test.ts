import assert from "node:assert/strict";
import { test } from "node:test";
import { applySessionUpdates, emptyTranscript, groupTranscriptItems } from "../../desktop/src/lib/transcript.ts";
import { deferredSessionHistoryFromMessages } from "../src/acp/session-replay.js";

const input = { questions: [
	{ id: "target", label: "Платформа", prompt: "На какой платформе проверять?" },
	{ id: "details", label: "Детали", prompt: "Что включить в проверку?" },
] };
const result = { canceled: false, answers: [
	{ id: "target", label: "Desktop", value: "desktop", wasCustom: false, index: 1 },
	{ id: "details", multiple: true, selections: [
		{ label: "Текст", value: "text", wasCustom: false, index: 1 },
		{ label: "Мой ответ\nс продолжением", value: "custom", wasCustom: true },
	] },
] };

test("actual deferred ACP history renders full question-answer pairs before tool expansion", () => {
	const messages = [
		{ role: "assistant", content: [
			{ type: "toolCall", id: "q1", name: "question", arguments: input },
			{ type: "toolCall", id: "read1", name: "read", arguments: { path: "/repo/file" } },
		] },
		{ role: "toolResult", toolCallId: "q1", toolName: "question", isError: false, details: result, content: [] },
	];
	const history = deferredSessionHistoryFromMessages(messages, { sessionId: "reopened", cwd: "/repo" });
	const grouped = groupTranscriptItems(applySessionUpdates(emptyTranscript, history.updates).items);
	assert.deepEqual(grouped.filter((item) => item.type === "message").map((item) => ({ role: item.role, text: item.text })), [
		{ role: "assistant", text: "На какой платформе проверять?" },
		{ role: "user", text: "Desktop" },
		{ role: "assistant", text: "Что включить в проверку?" },
		{ role: "user", text: "Текст; Мой ответ\nс продолжением" },
	]);
	const read = history.updates.find((update) => update.sessionUpdate === "tool_call" && update.toolCallId === "read1");
	assert.ok(read);
	assert.equal("rawInput" in read, false, "ordinary tool input must remain deferred");
});

test("unanswered question prompts remain visible on initial history replay", () => {
	const history = deferredSessionHistoryFromMessages([
		{ role: "assistant", content: [{ type: "toolCall", id: "q1", name: "question", arguments: input }] },
	], { sessionId: "pending", cwd: "/repo" });
	const grouped = groupTranscriptItems(applySessionUpdates(emptyTranscript, history.updates).items);
	assert.deepEqual(grouped.filter((item) => item.type === "message").map((item) => item.text), input.questions.map((question) => question.prompt));
});
