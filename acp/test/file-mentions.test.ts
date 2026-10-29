import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { parseFileMentionsRequest } from "../src/acp/file-mentions.js";

test("file mention completion accepts an absolute workspace without requiring a session", () => {
	const cwd = resolve(".");
	assert.deepEqual(parseFileMentionsRequest({ cwd, query: "src" }), { cwd, query: "src" });
	for (const value of [{ cwd: ".", query: "src" }, { cwd, query: "x".repeat(257) }, { cwd }, null]) {
		assert.throws(() => parseFileMentionsRequest(value), /requires absolute cwd and query/u);
	}
});
