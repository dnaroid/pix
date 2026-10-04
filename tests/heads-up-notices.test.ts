import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { HeadsUpNotices } from "../src/bundled-extensions/heads-up/notices.js";
import { parseHeadsUpResponse } from "../src/bundled-extensions/heads-up/parser.js";
import { HeadsUpContext } from "../src/bundled-extensions/heads-up/context.js";

const card = (id: string, createdAt = 0) => ({ id, title: id, consequence: `Consequence ${id}`, evidence: [{ id: "t", text: "result" }], createdAt, expiresAt: createdAt + 30_000 });

test("stack merges exact topics, preserves identity/expiry/order, and replaces resolved cards", () => {
	const stack = new HeadsUpNotices();
	stack.apply([card("one"), card("two"), card("three")]);
	stack.select(1); assert.equal(stack.current?.id, "two");
	stack.apply([{ ...card("two", 1000), consequence: "Updated consequence" }, card("one", 1000), card("four", 1000)]);
	assert.deepEqual(stack.all.map((item) => item.id), ["one", "two", "four"]);
	assert.equal(stack.current?.id, "two"); assert.equal(stack.current?.expiresAt, 30_000);
	stack.apply([card("one"), { ...card("one"), id: "duplicate" }, card("four", 1000)]);
	assert.deepEqual(stack.all.map((item) => item.id), ["one", "four"]);
	assert.equal(stack.current?.id, "four", "removal advances to the next survivor");
});

test("individual expiry and feedback remove only the target; known wording stays suppressed", () => {
	const stack = new HeadsUpNotices();
	stack.apply([card("one"), card("two", 1000), card("three", 2000)]);
	const version = stack.version; stack.select(-1);
	assert.equal(stack.current?.id, "three"); assert.equal(stack.version, version, "navigation is not a content mutation");
	assert.equal(stack.expire(30_000), true);
	assert.deepEqual(stack.all.map((item) => item.id), ["two", "three"]);
	assert.equal(stack.feedback("missing", "dismiss"), false);
	assert.equal(stack.feedback("two", "known"), true);
	stack.apply([{ ...card("two", 4000), id: "repeated" }, card("three", 4000)]);
	assert.deepEqual(stack.all.map((item) => item.id), ["three"]);
	assert.equal(stack.all[0]?.expiresAt, 32_000);
	assert.match(stack.previous.join("\n"), /known: two/);
	stack.clear(); assert.equal(stack.current, null);
});

test("selected removal chooses a surviving neighbor, not a newly appended card at the old index", () => {
	const stack = new HeadsUpNotices(); stack.apply([card("one"), card("two"), card("three")]); stack.select(1);
	stack.apply([card("three"), card("four", 1000)]);
	assert.equal(stack.current?.id, "three");
});

test("a duplicate of old wording cannot overwrite a retained updated card", () => {
	const stack = new HeadsUpNotices(); stack.apply([card("one")]);
	stack.apply([{ ...card("one"), consequence: "Updated evidence" }, { ...card("one"), id: "duplicate" }]);
	assert.equal(stack.all.length, 1); assert.equal(stack.current?.consequence, "Updated evidence");
});

test("stack response strictly validates the entire set and existing identities", () => {
	const active = [card("one"), card("two")];
	const item = (id: string | null) => ({ id, title: "Conflict", consequence: "Concrete consequence", evidenceIds: ["t"] });
	const parse = (notices: unknown[]) => parseHeadsUpResponse({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ kind: "heads_up", notices }) }] } as AssistantMessage, [{ id: "t", kind: "tool", text: "Observed conflict" }], 100, 30_000, active);
	const valid = parse([item("one"), item("two"), item(null)]);
	assert.equal(valid.kind, "notice");
	if (valid.kind === "notice") {
		assert.equal(valid.notices.length, 3); assert.equal(valid.notices[0]?.id, "one");
		assert.ok(valid.notices[2]?.id); assert.notEqual(valid.notices[2]?.id, "one");
	}
	for (const notices of [[], Array(4).fill(item(null)), [item("foreign")], [item("one"), item("one")],
		[item(null), { ...item(null), evidenceIds: ["invented"] }], [item(null), { ...item(null), action: "execute" }]]) assert.equal(parse(notices).kind, "invalid");
});

test("three long review descriptors stay within minimum payload limit with evidence and explicit clipping", () => {
	const context = new HeadsUpContext();
	context.add({ id: "u", kind: "user", text: "Keep API compatibility" });
	context.add({ id: "t", kind: "tool", text: "Observed incompatible changes" });
	const cards = ["one", "two", "three"].map((id) => ({ id, title: '"'.repeat(160), consequence: '"'.repeat(500) }));
	const input = context.toInput(2000, Array(16).fill("old topic".repeat(30)), cards);
	assert.ok(input.body.length <= 2000);
	assert.deepEqual(input.records.map((record) => record.id), ["u", "t"]);
	const active = JSON.parse(input.body).activeNotices;
	assert.deepEqual(active.map((item: { id: string }) => item.id), ["one", "two", "three"]);
	assert.ok(active.every((item: { clipped: boolean }) => item.clipped));
});
