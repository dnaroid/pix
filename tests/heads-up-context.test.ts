import assert from "node:assert/strict";
import { test } from "node:test";
import { HeadsUpContext, cleanObserverText, recordsFromMessage } from "../src/bundled-extensions/heads-up/context.js";
import { normalizeHeadsUpConfig } from "../src/bundled-extensions/heads-up/config.js";
import { parseHeadsUpResponse } from "../src/bundled-extensions/heads-up/parser.js";
import { requestHeadsUp } from "../src/bundled-extensions/heads-up/inference.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

test("context pins original user requirements through long tool sequences", () => {
	const context = new HeadsUpContext(); context.add({ id: "u", kind: "user", text: "Preserve public API" });
	for (let i = 0; i < 160; i++) context.add({ id: `t${i}`, kind: "tool", text: "a".repeat(1000) });
	const input = context.toInput(4000);
	assert.ok(input.records.some((entry) => entry.id === "u")); assert.ok(input.records.some((entry) => entry.id === "t159"));
	assert.ok(context.snapshot().length <= 64); assert.ok(input.body.length <= 4000);
});

test("serialized bound includes escapes and omitted data, and reset removes deleted branch content", () => {
	const context = new HeadsUpContext(); context.add({ id: "u", kind: "user", text: "current requirements" });
	for (let i = 0; i < 30; i++) context.add({ id: `t${i}`, kind: "tool", text: '"\\\n'.repeat(1000) });
	for (const bound of [2000, 4000, 16000]) assert.ok(context.toInput(bound).body.length <= bound);
	const withFeedback = context.toInput(2000, Array.from({ length: 16 }, () => "known topic ".repeat(50)));
	assert.ok(withFeedback.body.length <= 2000);
	assert.ok(withFeedback.records.some((entry) => entry.id === "u"));
	context.reset([{ id: "new", kind: "user", text: "new branch" }]);
	assert.doesNotMatch(context.toInput(2000).body, /current requirements/);
});

test("codemode failure and shell retest are retained in chronological order, not newest first", () => {
	const context = new HeadsUpContext();
	context.addMessage({ role: "user", content: "Refine HUD; verify the same six files" }, "u");
	context.addMessage({ role: "toolResult", toolName: "codemode", content: "Script completed\nOutput:\n5 failed | 77 passed (82)" }, "failed");
	context.addMessage({ role: "assistant", content: "Fixed h-7 expectation to h-6 and retained accessible quota label" }, "fix");
	context.addMessage({ role: "toolResult", toolName: "shell", content: "TEST_RESULT: passed\ncommand: six HUD files\n82 passed\nexit: 0" }, "passed");
	context.addMessage({ role: "toolResult", toolName: "shell", content: "npm --prefix desktop run check: 0 errors, 0 warnings" }, "check");
	const input = context.toInput(16000);
	assert.deepEqual(input.records.map((record) => record.id), ["u", "failed", "fix", "passed", "check"]);
	assert.match(input.records[1]!.text, /Tool codemode \(result\).*Script completed/s);
	assert.match(input.records[3]!.text, /Tool shell \(result\).*82 passed/s);
});

test("budget clipping cannot skip a large fresh retest and backfill an old small failure", () => {
	const context = new HeadsUpContext();
	context.add({ id: "u", kind: "user", text: "Verify HUD" });
	context.add({ id: "failed", kind: "tool", text: "5 failed, 77 passed" });
	context.addMessage({ role: "toolResult", toolName: "shell", content: `82 passed\n${"log ".repeat(1500)}` }, "retest");
	context.add({ id: "check", kind: "tool", text: "Typecheck passed" });
	const input = context.toInput(2000);
	assert.deepEqual(input.records.map((record) => record.id), ["u", "check"]);
	assert.equal(JSON.parse(input.body).omitted, 2);
	assert.ok(input.body.length <= 2000);
	const full = context.toInput(16000);
	assert.equal(full.records.find((record) => record.id === "retest")?.clipped, true);
});

test("review payload is inside the same serialized input budget", () => {
	const context = new HeadsUpContext();
	context.add({ id: "u", kind: "user", text: "Verify compatibility" });
	context.add({ id: "t", kind: "tool", text: "Compatibility still fails" });
	const review = [{ id: "old", title: "T".repeat(160), consequence: "C".repeat(500) }];
	const input = context.toInput(2000, ["old notice ".repeat(200)], review);
	assert.ok(input.body.length <= 2000);
	assert.deepEqual(JSON.parse(input.body).activeNotices, review);
	assert.deepEqual(input.records.map((entry) => entry.id), ["u", "t"]);
});

test("no hidden reasoning or images; tool requests include bounded arguments and failures stay labelled", () => {
	const records = recordsFromMessage({ role: "assistant", content: [
		{ type: "thinking", thinking: "PRIVATE THINKING" },
		{ type: "image", data: "PRIVATE IMAGE" },
		{ type: "toolCall", name: "edit", id: "c", arguments: { path: "loader.ts", replacement: "reject old format", api_key: "DONT_SEND_ME" } },
	] }, "a");
	const text = JSON.stringify(records);
	assert.match(text, /loader.ts/); assert.match(text, /reject old format/); assert.doesNotMatch(text, /PRIVATE|DONT_SEND_ME/);
	assert.equal(records[0]?.id, "a");
	assert.match(recordsFromMessage({ role: "toolResult", content: "failed", toolName: "edit", isError: true }, "t")[0]!.text, /\(error\)/);
});

test("common credentials, private keys, ANSI and invisible control characters are suppressed", () => {
	const text = cleanObserverText('API_KEY="dont-send-this" password=private Bearer verylongexampletoken\n\x1b[31mred\x1b[0m\u202eX\n-----BEGIN PRIVATE KEY-----\nPRIVATE\n-----END PRIVATE KEY-----');
	assert.doesNotMatch(text, /dont-send-this|password=private|verylongexampletoken|\x1b|\u202e|\nPRIVATE\n/);
});

test("response parser rejects fabricated references, duplicate IDs, extra keys, empty and overlong text", () => {
	const good = { kind: "heads_up", notices: [{ id: null, title: "Changed API", consequence: "Old clients fail.", evidenceIds: ["t"] }] };
	const records = [{ id: "t", kind: "tool" as const, text: "removed API" }];
	const parse = (value: unknown, stopReason = "stop") => parseHeadsUpResponse({ content: [{ type: "text", text: JSON.stringify(value) }], stopReason } as AssistantMessage, records, 1, 30000);
	assert.equal(parse(good).kind, "notice"); assert.equal(parse({ kind: "none" }).kind, "none");
	for (const change of [{ evidenceIds: ["invented"] }, { evidenceIds: ["t", "t"] }, { title: "" }, { title: "x".repeat(161) }, { action: "run shell" }, { id: "invented-card" }]) {
		assert.equal(parse({ ...good, notices: [{ ...good.notices[0], ...change }] }).kind, "invalid");
	}
	for (const value of [null, [], { ...good, extra: true }, { kind: "none", extra: true }, { ...good, notices: [] }, { ...good, notices: Array(4).fill(good.notices[0]) }]) assert.equal(parse(value).kind, "invalid");
	assert.equal(parse(good, "length").kind, "invalid");
});

test("hostile numeric settings are bounded and unknown fields are ignored", () => {
	const config = normalizeHeadsUpConfig({ maxChecksPerHour: 100000, maxInputChars: -1, minIntervalMs: NaN, maxTokens: Infinity, arbitrary: true });
	assert.equal(config.maxChecksPerHour, 100); assert.equal(config.maxInputChars, 2000); assert.equal(config.minIntervalMs, 60000); assert.equal(config.maxTokens, 900);
});

test("inference is exactly one registry request with no tools, no retries or parent context injection", async () => {
	let captured: unknown[] | undefined;
	const registry = { streamSimple: (...args: unknown[]) => { captured = args; return { result: async () => ({ stopReason: "stop" }) }; } };
	const abort = new AbortController();
	await requestHeadsUp(registry as Parameters<typeof requestHeadsUp>[0], { model: {} as never, input: "{}", signal: abort.signal, maxTokens: 900, timeoutMs: 20000 });
	assert.ok(captured);
	const context = captured[1] as { tools: unknown[]; messages: unknown[]; systemPrompt: string };
	const options = captured[2] as { toolChoice: string; maxRetries: number; signal: AbortSignal };
	assert.deepEqual(context.tools, []); assert.equal(context.messages.length, 1); assert.match(context.systemPrompt, /untrusted DATA/);
	assert.equal(options.toolChoice, "none"); assert.equal(options.maxRetries, 0); assert.equal(options.signal, abort.signal);
});
