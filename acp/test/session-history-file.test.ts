import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFERRED_PERSISTED_IMAGE_PREFIX,
	readPersistedHistoryTail,
	readPersistedImage,
	readPersistedToolResult,
} from "../src/acp/session-history-file.js";

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
				timestamp: Date.parse("2026-09-06T00:00:01.250Z"),
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
	assert.deepEqual(tail.messages[0], {
		role: "user",
		content: "inspect",
		persistedAtMs: Date.parse("2026-09-06T00:00:01.000Z"),
	});
	assert.equal(tail.messages[1]?.timestamp, Date.parse("2026-09-06T00:00:01.250Z"));
	assert.equal(tail.messages[1]?.persistedAtMs, Date.parse("2026-09-06T00:00:02.000Z"));
	assert.deepEqual((tail.messages[2] as { content?: unknown }).content, [], "tool body stays unmaterialized in the initial tail");
	assert.equal((tail.messages[2] as { persistedAtMs?: number }).persistedAtMs, Date.parse("2026-09-06T00:00:03.000Z"));

	const ref = tail.toolResultRefs.get("tool-1");
	assert.ok(ref);
	const hydrated = await readPersistedToolResult(ref);
	assert.equal((hydrated as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text, hugeOutput);
	assert.deepEqual((hydrated as { details?: unknown } | undefined)?.details, { bytes: hugeOutput.length });
});

test("persisted history tail defers user image bodies until requested", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pix-history-image-"));
	const sessionPath = join(dir, "session.jsonl");
	const imageData = "A".repeat(600_000);
	const lines = [
		{ type: "session", version: 3, id: "s1", timestamp: "2026-09-06T00:00:00.000Z", cwd: "/repo" },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-09-06T00:00:01.000Z",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: imageData, mimeType: "image/png" },
				],
			},
		},
	];
	await writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

	const tail = await readPersistedHistoryTail(sessionPath);
	assert.ok(tail);
	assert.equal(tail.messages.length, 1);
	const content = (tail.messages[0] as { content?: Array<Record<string, unknown>> }).content;
	assert.equal(content?.[0]?.text, "look");
	const deferredId = content?.[1]?.data;
	assert.equal(typeof deferredId, "string");
	assert.ok(String(deferredId).startsWith(DEFERRED_PERSISTED_IMAGE_PREFIX));
	assert.equal(String(deferredId).includes(imageData.slice(0, 100)), false, "initial tail must not retain image body");

	const ref = tail.imageRefs.get(String(deferredId));
	assert.ok(ref);
	const hydrated = await readPersistedImage(ref);
	assert.deepEqual(hydrated, { data: imageData, mimeType: "image/png" });
});
