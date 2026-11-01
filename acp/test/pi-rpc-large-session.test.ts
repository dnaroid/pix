import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PiRpcClient } from "../src/pi/pi-rpc-client.js";

test("SDK RPC receives image-heavy history and entries intact alongside concurrent state requests", { timeout: 60_000 }, async (t) => {
	const client = new PiRpcClient({
		piEntry: fileURLToPath(new URL("./fixtures/large-pi-rpc.mjs", import.meta.url)),
		cwd: fileURLToPath(new URL("../../", import.meta.url)),
	});
	t.after(() => client.stop());
	const events: string[] = [];
	client.onEvent((event) => events.push(event.type));
	await client.start();
	const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const expected = Array.from({ length: 74 }, (_, index) => ({
		role: "user",
		content: [
			{ type: "text", text: `message ${index}: Привет 😀\u2028\u2029` },
			{ type: "image", data: "aGVsbG8=".repeat(128 * 1024), mimeType: "image/png" },
		],
		timestamp: index,
	}));
	const expectedHash = hash(expected);
	const [messages, state] = await Promise.all([client.getMessages(), client.getState()]);
	assert.equal(messages.length, 74);
	assert.equal(hash(messages), expectedHash, "all text, image data and ordering survive transport");
	assert.equal(state.sessionId, "large-fixture");
	const [{ entries, leafId }, nextState] = await Promise.all([client.getEntries(), client.getState()]);
	assert.equal(leafId, "entry-73");
	assert.equal(hash(entries.map((entry) => entry.message)), expectedHash);
	assert.equal(nextState.sessionId, state.sessionId);
	assert.deepEqual(events, ["extension_ui_request"], "startup event is neither lost nor duplicated");
	await assert.rejects(client.abort(), /process exited/i, "partial response on exit rejects outstanding work");
});
