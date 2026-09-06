import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPersistedHistoryTail, readPersistedToolResult } from "../src/acp/session-history-file.js";

test("persisted history tail defers large tool-result JSON until requested", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pix-history-tail-"));
	const sessionPath = join(dir, "session.jsonl");
	const hugeOutput = "x".repeat(300_000);
	const lines = [
		{ type: "session", version: 3, id: "s1", timestamp: "2026-09-06T00:00:00.000Z", cwd: "/repo" },
		{ type: "message", id: "u1", parentId: null, timestamp: "2026-09-06T00:00:01.000Z", message: { role: "user", content: "inspect" } },
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-09-06T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/repo/big.log" } }],
			},
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: "2026-09-06T00:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: "tool-1",
				isError: false,
				content: [{ type: "text", text: hugeOutput }],
				details: { bytes: hugeOutput.length },
			},
		},
	];
	await writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

	const tail = await readPersistedHistoryTail(sessionPath);
	assert.ok(tail);
	assert.equal(tail.messages.length, 3);
	assert.deepEqual(tail.messages[0], { role: "user", content: "inspect" });
	assert.deepEqual((tail.messages[2] as { content?: unknown }).content, [], "tool body stays unmaterialized in the initial tail");

	const ref = tail.toolResultRefs.get("tool-1");
	assert.ok(ref);
	const hydrated = await readPersistedToolResult(ref);
	assert.equal((hydrated as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text, hugeOutput);
	assert.deepEqual((hydrated as { details?: unknown } | undefined)?.details, { bytes: hugeOutput.length });
});
