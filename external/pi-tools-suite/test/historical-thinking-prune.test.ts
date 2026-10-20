import { describe, expect, test } from "bun:test";
import { pruneHistoricalThinking, turnBoundaryIndex } from "../src/historical-thinking-prune/prune.ts";

const assistant = (content: unknown[], timestamp: number) => ({ role: "assistant", content, timestamp });
const user = (content: string, timestamp: number) => ({ role: "user", content, timestamp });
const result = (id: string, timestamp: number) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "r" }], isError: false, timestamp });

function history() {
	return [
		user("first", 1),
		assistant([{ type: "thinking", thinking: "old-only" }], 2),
		assistant([{ type: "thinking", thinking: "old-with-call", thinkingSignature: "sig" }, { type: "toolCall", id: "c1", name: "read", arguments: {} }], 3),
		result("c1", 4),
		assistant([{ type: "thinking", thinking: "old-answer" }, { type: "text", text: "answer" }], 5),
		user("second", 6),
		assistant([{ type: "thinking", thinking: "current-loop" }, { type: "toolCall", id: "c2", name: "read", arguments: {} }], 7),
		result("c2", 8),
	];
}

describe("historical thinking pruning", () => {
	test("drops thinking before the latest turn and keeps the current tool loop", () => {
		const input = history();
		const snapshot = structuredClone(input);
		const { messages, prunedBlocks, droppedMessages } = pruneHistoricalThinking(input);
		expect(prunedBlocks).toBe(3);
		expect(droppedMessages).toBe(1);
		const text = JSON.stringify(messages);
		for (const marker of ["old-only", "old-with-call", "old-answer"]) expect(text).not.toContain(marker);
		expect(text).toContain("current-loop");
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant", "user", "assistant", "toolResult"]);
		expect((messages[1] as any).content).toEqual([{ type: "toolCall", id: "c1", name: "read", arguments: {} }]);
		expect((messages[3] as any).content).toEqual([{ type: "text", text: "answer" }]);
		// Unchanged messages are reused and the input is not mutated.
		expect(messages[5]).toBe(input[6]);
		expect(input).toEqual(snapshot);
	});

	test("a user message after a tool result is a steer, not a new turn", () => {
		const input = [...history(), user("steer", 9)];
		expect(turnBoundaryIndex(input)).toBe(5);
		expect(JSON.stringify(pruneHistoricalThinking(input).messages)).toContain("current-loop");
	});

	test("keeps the pruned prefix stable while the turn grows", () => {
		const first = pruneHistoricalThinking(history()).messages;
		const grown = [...history(), assistant([{ type: "thinking", thinking: "later" }, { type: "text", text: "done" }], 9)];
		const second = pruneHistoricalThinking(grown).messages;
		expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
	});

	test("is a no-op without an earlier turn or without thinking", () => {
		const single = [user("only", 1), assistant([{ type: "thinking", thinking: "t" }, { type: "text", text: "a" }], 2)];
		expect(pruneHistoricalThinking(single).prunedBlocks).toBe(0);
		const plain = [user("a", 1), assistant([{ type: "text", text: "b" }], 2), user("c", 3)];
		const out = pruneHistoricalThinking(plain);
		expect(out.prunedBlocks).toBe(0);
		expect(out.messages).toEqual(plain);
	});
});
