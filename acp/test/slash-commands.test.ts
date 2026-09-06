import assert from "node:assert/strict";
import { test } from "node:test";
import {
	builtinUsageError,
	parseBuiltinCommand,
	rendererCommandName,
	unsupportedCommandName,
} from "../src/acp/slash-commands.js";

test("parses built-ins with and without arguments", () => {
	assert.deepEqual(parseBuiltinCommand("/compact"), { kind: "compact", instructions: undefined });
	assert.deepEqual(parseBuiltinCommand("/compact focus on api"), {
		kind: "compact",
		instructions: "focus on api",
	});
	assert.deepEqual(parseBuiltinCommand("/name My Session"), { kind: "name", name: "My Session" });
	assert.deepEqual(parseBuiltinCommand("/name"), { kind: "name", name: undefined });
	assert.deepEqual(parseBuiltinCommand("/export"), { kind: "export", outputPath: undefined });
	assert.deepEqual(parseBuiltinCommand("/no-context-files"), { kind: "no-context-files", value: undefined });
	assert.deepEqual(parseBuiltinCommand("/no-context-files on"), { kind: "no-context-files", value: "on" });
	assert.deepEqual(parseBuiltinCommand("/share"), { kind: "share", argumentsText: "" });
	assert.deepEqual(parseBuiltinCommand("/changelog"), { kind: "changelog", argumentsText: "" });
	assert.deepEqual(parseBuiltinCommand("/update --check"), { kind: "update", argumentsText: "--check" });
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
	assert.deepEqual(parseBuiltinCommand("/session"), { kind: "session", argumentsText: "" });
	assert.deepEqual(parseBuiltinCommand("/clone"), { kind: "clone", argumentsText: "" });
	assert.deepEqual(parseBuiltinCommand("/CLONE"), { kind: "clone", argumentsText: "" });
});

test("non-built-in slash commands pass through for pi-side handling", () => {
	assert.equal(parseBuiltinCommand("/skill:pix run checks"), undefined);
	assert.equal(parseBuiltinCommand("/my-template arg"), undefined);
	assert.equal(parseBuiltinCommand("plain text"), undefined);
	assert.equal(parseBuiltinCommand(""), undefined);
});

test("recognizes Pix commands that require renderer UI", () => {
	assert.equal(rendererCommandName("/no-context-files on"), undefined);
	assert.equal(rendererCommandName("/share"), undefined);
	assert.equal(rendererCommandName("/changelog"), undefined);
	assert.equal(rendererCommandName("/update --check"), undefined);
	assert.equal(rendererCommandName("/enhance"), "enhance");
	assert.equal(rendererCommandName("/queue later"), "queue");
	assert.equal(rendererCommandName("/resume /tmp/session.jsonl"), "resume");
	assert.equal(rendererCommandName("/trust"), undefined);
	assert.equal(rendererCommandName("/skill:pix run checks"), undefined);
	assert.equal(rendererCommandName("plain text"), undefined);
});

test("recognizes commands intentionally unsupported by Pix Desktop", () => {
	assert.equal(unsupportedCommandName("/trust"), "trust");
	assert.equal(unsupportedCommandName("/LOGIN"), "login");
	assert.equal(unsupportedCommandName("/logout extra"), "logout");
	assert.equal(unsupportedCommandName("/queue later"), undefined);
});

test("usage errors flag missing or malformed arguments", () => {
	assert.equal(builtinUsageError({ kind: "name", name: undefined }), undefined);
	assert.match(builtinUsageError({ kind: "thinking", level: "" }) ?? "", /usage: \/thinking/);
	assert.match(builtinUsageError({ kind: "model", value: "no-slash" }) ?? "", /usage: \/model/);
	assert.equal(builtinUsageError({ kind: "model", value: undefined }), undefined);
	assert.equal(builtinUsageError({ kind: "model", value: "a/b" }), undefined);
	assert.match(builtinUsageError({ kind: "no-context-files", value: "maybe" }) ?? "", /usage: \/no-context-files/);
	assert.equal(builtinUsageError({ kind: "no-context-files", value: "off" }), undefined);
	assert.match(builtinUsageError({ kind: "share", argumentsText: "extra" }) ?? "", /usage: \/share/);
	assert.equal(builtinUsageError({ kind: "compact", instructions: undefined }), undefined);
	assert.match(builtinUsageError({ kind: "clone", argumentsText: "extra" }) ?? "", /usage: \/clone/);
	assert.match(builtinUsageError({ kind: "session", argumentsText: "extra" }) ?? "", /usage: \/session/);
});
