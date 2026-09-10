import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Pix RPC installs the pause hook before starting a normal prompt", async () => {
	const source = await readFile(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");
	const promptPatchStart = source.indexOf("AgentSession.prototype.prompt =");
	assert.notEqual(promptPatchStart, -1, "prompt patch must exist");

	const promptPatch = source.slice(promptPatchStart);
	const bindIndex = promptPatch.indexOf("bindPause(this);");
	const originalPromptIndex = promptPatch.indexOf("return originalPrompt.call(this, text, options);");

	assert.notEqual(bindIndex, -1, "normal prompts must bind the pause controller");
	assert.notEqual(originalPromptIndex, -1, "normal prompts must delegate to AgentSession.prompt");
	assert.ok(
		bindIndex < originalPromptIndex,
		"pause hook must be installed before AgentSession captures shouldStopAfterTurn for the run",
	);
});
