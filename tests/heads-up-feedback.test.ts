import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { HeadsUpNotices } from "../src/bundled-extensions/heads-up/notices.js";
import { HeadsUpContext } from "../src/bundled-extensions/heads-up/context.js";
import { parseHeadsUpResponse } from "../src/bundled-extensions/heads-up/parser.js";
import type { HeadsUpNotice } from "../src/bundled-extensions/heads-up/contract.js";

function card(id: string, patch: Partial<HeadsUpNotice> = {}): HeadsUpNotice {
	return { id, topic: "api-return-type", subject: "src/sdk.ts:getUser", title: "Public API changed",
		consequence: "Promise breaks synchronous callers", evidence: [{ id: "t", text: "Saved async getUser" }], createdAt: 0, expiresAt: 30_000, ...patch };
}

test("semantic keys merge paraphrases, but preserve independent subjects and stable review identity", () => {
	const stack = new HeadsUpNotices();
	stack.apply([card("one"), card("two", { title: "Async return breaks clients" }), card("three", { subject: "src/sdk.ts:getTeam" })]);
	assert.deepEqual(stack.all.map((item) => item.id), ["one", "three"]);
	stack.apply([card("new", { title: "Different wording", createdAt: 1000, expiresAt: 31_000 })]);
	assert.equal(stack.current?.id, "one"); assert.equal(stack.current?.expiresAt, 30_000);
	assert.equal(stack.memory.summary.shown, 2, "reviews are not extra shown findings");
});

test("feedback suppresses same evidence despite paraphrases/IDs; changed circumstances can recur", () => {
	for (const feedback of ["known", "irrelevant", "incorrect", "dismiss", "useful"] as const) {
		const stack = new HeadsUpNotices(); stack.apply([card("one")]); stack.feedback("one", feedback);
		stack.apply([card("two", { title: "Paraphrase", evidence: [{ id: "new-id", text: "Saved async getUser" }] })]);
		assert.equal(stack.current, null);
		assert.equal(stack.memory.records[0]?.outcome, feedback);
		stack.apply([card("three", { evidence: [{ id: "t2", text: "A new exported overload now returns Promise too" }] })]);
		assert.equal(stack.all[0]?.id, "three");
	}
});

test("task memory is bounded and resets independently of runtime feedback metrics", () => {
	const stack = new HeadsUpNotices();
	for (let i = 0; i < 40; i++) { stack.apply([card(`c${i}`, { subject: `subject${i}` })]); stack.feedback(`c${i}`, "known"); }
	assert.equal(stack.memory.records.length, 32); assert.equal(stack.memory.summary.known, 40);
	stack.memory.resetTask(); assert.equal(stack.memory.records.length, 0); assert.equal(stack.memory.summary.known, 40);
	stack.apply([card("again", { subject: "subject39" })]); assert.equal(stack.current?.id, "again");
});

test("only explicit negative feedback slows discovery; silence/known/dismiss do not", () => {
	const stack = new HeadsUpNotices();
	for (const [index, outcome] of ["known", "dismiss", "irrelevant", "incorrect", "irrelevant", "useful"].entries()) {
		const id = `c${index}`; stack.apply([card(id, { subject: id })]);
		stack.feedback(id, outcome as "known" | "dismiss" | "irrelevant" | "incorrect" | "useful");
		assert.equal(stack.memory.discoveryMultiplier, [1, 1, 2, 4, 4, 1][index]);
	}
	stack.expire(50_000); assert.equal(stack.memory.discoveryMultiplier, 1);
	assert.equal(stack.feedback("stale", "incorrect"), false); assert.equal(stack.memory.summary.incorrect, 1);
});

test("structured memory and three identity descriptors fit small budgets without displacing evidence", () => {
	const context = new HeadsUpContext(); context.add({ id: "u", kind: "user", text: "Keep synchronous API" });
	context.add({ id: "t", kind: "tool", text: "Saved async API" });
	const stack = new HeadsUpNotices();
	const cards = ["a", "b", "c"].map((id) => card(id, { subject: id.repeat(160), topic: "t".repeat(80), title: '"'.repeat(160), consequence: '"'.repeat(500) }));
	stack.apply(cards); stack.feedback("a", "known");
	const input = context.toInput(2000, [], cards, stack.memory.records);
	assert.ok(input.body.length <= 2000); assert.equal(input.records.length, 2);
	const parsed = JSON.parse(input.body); assert.equal(parsed.activeNotices.length, 3);
	assert.ok(parsed.activeNotices.every((item: { clipped: boolean }) => item.clipped));
	const full = JSON.parse(context.toInput(16_000, [], [], stack.memory.records).body);
	assert.equal(full.feedback.at(-1).outcome, "known"); assert.deepEqual(full.previousNotices, []);
});

test("identity parser requires a bounded pair and rejects repurposing an active ID", () => {
	const item = { id: null as string | null, topic: "api-return-type", subject: "src/sdk.ts:getUser", title: "Conflict", consequence: "Breaks callers", evidenceIds: ["t"] };
	const parse = (patch: Record<string, unknown>) => parseHeadsUpResponse({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ kind: "heads_up", notices: [{ ...item, ...patch }] }) }] } as AssistantMessage,
		[{ id: "t", kind: "tool", text: "Saved async getUser" }], 0, 30_000, [card("one")]);
	assert.equal(parse({}).kind, "notice");
	for (const patch of [{ topic: undefined }, { topic: "" }, { subject: "x".repeat(161) }, { topic: "a\nb" }, { id: "one", subject: "other" }, { extra: true }]) assert.equal(parse(patch).kind, "invalid");
	const legacy = parse({ id: "one", topic: undefined, subject: undefined });
	assert.equal(legacy.kind, "notice");
	if (legacy.kind === "notice") assert.equal(legacy.notices[0]?.topic, item.topic);
});

test("a legacy card can gain structured identity without a new shown count or extended TTL", () => {
	const stack = new HeadsUpNotices(); stack.apply([card("one", { topic: undefined, subject: undefined })]);
	const message = { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ kind: "heads_up", notices: [{
		id: "one", topic: "api-return-type", subject: "src/sdk.ts:getUser", title: "Same issue rephrased", consequence: "Still breaks callers", evidenceIds: ["t"],
	}] }) }] } as AssistantMessage;
	const parsed = parseHeadsUpResponse(message, [{ id: "t", kind: "tool", text: "Saved async getUser" }], 1000, 30_000, stack.all);
	assert.equal(parsed.kind, "notice");
	if (parsed.kind !== "notice") return;
	stack.apply(parsed.notices);
	assert.equal(stack.current?.id, "one"); assert.equal(stack.current?.expiresAt, 30_000);
	assert.equal(stack.current?.topic, "api-return-type"); assert.equal(stack.memory.summary.shown, 1);
	stack.feedback("one", "known"); stack.apply([card("repeat", { title: "Another paraphrase" })]);
	assert.equal(stack.current, null);
});
