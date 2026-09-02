import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinUsageError, parseBuiltinCommand } from "../src/acp/slash-commands.js";

test("parses built-ins with and without arguments", () => {
	assert.deepEqual(parseBuiltinCommand("/compact"), { kind: "compact", instructions: undefined });
	assert.deepEqual(parseBuiltinCommand("/compact focus on api"), {
		kind: "compact",
		instructions: "focus on api",
	});
	assert.deepEqual(parseBuiltinCommand("/name My Session"), { kind: "name", name: "My Session" });
	assert.deepEqual(parseBuiltinCommand("/export"), { kind: "export", outputPath: undefined });
	assert.deepEqual(parseBuiltinCommand("/model"), { kind: "model", value: undefined });
	assert.deepEqual(parseBuiltinCommand("/model anthropic/claude-4"), {
		kind: "model",
		value: "anthropic/claude-4",
	});
	assert.deepEqual(parseBuiltinCommand("/thinking high"), { kind: "thinking", level: "high" });
	assert.deepEqual(parseBuiltinCommand("/thought off"), { kind: "thinking", level: "off" });
	assert.deepEqual(parseBuiltinCommand("/autocompact off"), { kind: "autocompact", enabled: false });
	assert.deepEqual(parseBuiltinCommand("/autocompact"), { kind: "autocompact", enabled: true });
	assert.deepEqual(parseBuiltinCommand("/steering one-at-a-time"), {
		kind: "steering",
		mode: "one-at-a-time",
	});
	assert.deepEqual(parseBuiltinCommand("/follow-up all"), { kind: "followup", mode: "all" });
	assert.deepEqual(parseBuiltinCommand("/followup"), { kind: "followup", mode: "all" });
});

test("non-built-in slash commands pass through for pi-side handling", () => {
	assert.equal(parseBuiltinCommand("/skill:pix run checks"), undefined);
	assert.equal(parseBuiltinCommand("/my-template arg"), undefined);
	assert.equal(parseBuiltinCommand("plain text"), undefined);
	assert.equal(parseBuiltinCommand(""), undefined);
});

test("usage errors flag missing or malformed arguments", () => {
	assert.match(builtinUsageError({ kind: "name", name: "" }) ?? "", /usage: \/name/);
	assert.match(builtinUsageError({ kind: "thinking", level: "" }) ?? "", /usage: \/thinking/);
	assert.match(builtinUsageError({ kind: "model", value: "no-slash" }) ?? "", /usage: \/model/);
	assert.equal(builtinUsageError({ kind: "model", value: undefined }), undefined);
	assert.equal(builtinUsageError({ kind: "model", value: "a/b" }), undefined);
	assert.equal(builtinUsageError({ kind: "compact", instructions: undefined }), undefined);
});
