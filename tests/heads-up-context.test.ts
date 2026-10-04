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
	const good = { kind: "heads_up", title: "Changed API", consequence: "Old clients fail.", evidenceIds: ["t"] };
	const records = [{ id: "t", kind: "tool" as const, text: "removed API" }];
	const parse = (value: unknown, stopReason = "stop") => parseHeadsUpResponse({ content: [{ type: "text", text: JSON.stringify(value) }], stopReason } as AssistantMessage, records, 1, 30000);
	assert.equal(parse(good).kind, "notice"); assert.equal(parse({ kind: "none" }).kind, "none");
	for (const value of [null, [], { ...good, evidenceIds: ["invented"] }, { ...good, evidenceIds: ["t", "t"] }, { ...good, title: "" }, { ...good, title: "x".repeat(161) }, { ...good, action: "run shell" }, { kind: "none", extra: true }]) assert.equal(parse(value).kind, "invalid");
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
