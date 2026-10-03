import assert from "node:assert/strict";
import { test } from "node:test";
import { BrainstormHost, type BrainstormHostBackend, type BrainstormRun } from "../src/acp/brainstorm-host.js";
import { brainstormParticipantOptions, freshParticipantAnswer } from "../src/acp/brainstorm-participant.js";
import type { PiClient, PiSessionEntry } from "../src/pi/pi-rpc-client.js";
import { fileURLToPath } from "node:url";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(overrides: Partial<BrainstormHostBackend> = {}, deadline?: () => AbortSignal) {
	const created: string[] = [], stopped: string[] = [], rounds: string[] = [];
	let views: BrainstormRun[] = [];
	const host = new BrainstormHost({
		create: async (_, p) => { created.push(p.sessionId); },
		round: async (p) => { rounds.push(p.sessionId); return `answer ${p.round}`; },
		stop: async (id) => { stopped.push(id); }, link: async () => {},
		publish: async (_, snapshot) => { views = snapshot.runs; }, ...overrides,
	}, deadline);
	return { host, created, stopped, rounds, views: () => views };
}
function round(n: number, runId = "run-a", model = "zai/exact") {
	return { action: "round", runId, runDir: "/tmp/brainstorm-test", topic: "topic", round: n,
		tasks: [1, 2].map((slot) => ({ id: `round-${n}-participant-${slot}`, model, task: `task ${n}`, thinking: "high", timeoutSeconds: 30 })) };
}
async function post(env: Record<string, string>, body: unknown, signal?: AbortSignal) {
	return fetch(env.PIX_BRAINSTORM_HOST_URL!, { method: "POST", headers: { Authorization: `Bearer ${env.PIX_BRAINSTORM_HOST_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
}

test("persistent roster keeps exact slot session IDs through rounds 4 and synthesis review 5", async () => {
	const f = fixture({ round: async () => "x".repeat(40_000) });
	try {
		const env = await f.host.environment("parent");
		let ids: string[] = [];
		for (let n = 1; n <= 5; n++) {
			const response = await post(env, round(n)); assert.equal(response.status, 200);
			const result = await response.json() as { responses: { text: string; source: string }[]; missing: unknown[] };
			assert.equal(result.missing.length, 0); assert.equal(result.responses.length, 2);
			assert.equal(result.responses[0]!.text.length, 40_000);
			if (n === 1) ids = result.responses.map((r) => r.source);
			else assert.deepEqual(result.responses.map((r) => r.source), ids);
			assert.equal(f.created.length, 2);
			assert.equal(f.views()[0]!.status, n === 4 ? "awaiting_synthesis" : n === 5 ? "awaiting_finalization" : "running");
			assert.equal(f.host.metadata(ids[0]!)?.owned, true);
		}
		assert.equal((await post(env, { action: "finish", runId: "run-a", status: "complete" })).status, 200);
		assert.equal(f.host.metadata(ids[0]!)?.owned, false); assert.equal(f.views()[0]!.status, "complete");
		assert.deepEqual(f.stopped.sort(), ids.sort());
	} finally { await f.host.dispose(); }
});

test("terminal ownership stays locked until every durable link is released", async () => {
	const entered = deferred<void>(), release = deferred<void>();
	const f = fixture({ link: async (_id, link) => {
		assert.equal(link.owned, false);
		entered.resolve();
		await release.promise;
	} });
	try {
		const env = await f.host.environment("parent");
		await post(env, round(1));
		const finishing = post(env, { action: "finish", runId: "run-a", status: "incomplete" });
		await entered.promise;
		assert.equal(f.host.ownsRuns("parent"), true);
		assert.ok(f.created.every((id) => f.host.metadata(id)?.owned === true));
		release.resolve();
		assert.equal((await finishing).status, 200);
		assert.equal(f.host.ownsRuns("parent"), false);
		assert.ok(f.created.every((id) => f.host.metadata(id)?.owned === false));
	} finally { release.resolve(); await f.host.dispose(); }
});

test("oversize responses become explicit gaps rather than silently truncated evidence", async () => {
	const f = fixture({ round: async () => "x".repeat(40_001) });
	try {
		const env = await f.host.environment("parent");
		const result = await (await post(env, round(1))).json() as { responses: unknown[]; missing: { reason: string }[] };
		assert.equal(result.responses.length, 0); assert.equal(result.missing.length, 2);
		assert.match(result.missing[0]!.reason, /exceeds/);
	} finally { await f.host.dispose(); }
});

test("bounded full draft and peer evidence fit all six persistent prompts", async () => {
	const f = fixture();
	try {
		const env = await f.host.environment("parent");
		const body = round(1);
		body.tasks = Array.from({ length: 6 }, (_, i) => ({ ...body.tasks[0]!, id: `round-1-participant-${i + 1}`, task: "文".repeat(420_000) }));
		assert.equal((await post(env, body)).status, 200);
		assert.equal(f.created.length, 6);
		const oversize = round(2);
		oversize.tasks[0]!.task = "x".repeat(450_001);
		assert.equal((await post(env, oversize)).status, 400);
	} finally { await f.host.dispose(); }
});

test("capability scope, fixed roster, sequential rounds, bounded requests, and no resume fail closed", async () => {
	const f = fixture();
	try {
		const env = await f.host.environment("parent"), other = await f.host.environment("other");
		assert.equal((await post(env, round(2))).status, 400);
		assert.equal((await post(env, round(1))).status, 200);
		assert.equal((await post(other, round(2))).status, 400);
		assert.equal((await post(env, round(2, "run-a", "zai/changed"))).status, 400);
		assert.equal((await post(env, round(1))).status, 400);
		const duplicate = round(2); duplicate.tasks[1]!.id = duplicate.tasks[0]!.id;
		assert.equal((await post(env, duplicate)).status, 400);
		assert.equal((await fetch(env.PIX_BRAINSTORM_HOST_URL!, { method: "POST", headers: { Authorization: env.PIX_BRAINSTORM_HOST_TOKEN! }, body: "{}" })).status, 403);
		assert.equal((await post(env, { action: "finish", runId: "run-a", status: "complete" })).status, 400);
		assert.equal((await post(env, { ...round(2), topic: "x".repeat(1024 * 1024) })).status, 400);
		assert.equal(f.created.length, 2);
	} finally { await f.host.dispose(); }
});

test("deadline stops paid work, drops stale completion, and never replaces lost participants", async () => {
	const deadline = new AbortController(), gate = deferred<string>(), started = deferred<void>();
	const f = fixture({ round: async () => { started.resolve(); return gate.promise; } }, () => deadline.signal);
	try {
		const env = await f.host.environment("parent");
		const request = post(env, round(1)); await started.promise; deadline.abort(new Error("deadline exceeded"));
		const result = await (await request).json() as { responses: unknown[]; missing: unknown[] };
		assert.equal(result.responses.length, 0); assert.equal(result.missing.length, 2); assert.equal(f.stopped.length, 2);
		gate.resolve("stale paid answer");
		const next = await (await post(env, round(2))).json() as { responses: unknown[]; missing: unknown[] };
		assert.equal(next.responses.length, 0); assert.equal(next.missing.length, 2); assert.equal(f.created.length, 2);
	} finally { await f.host.dispose(); }
});

test("deadline during startup stops the reserved session and late startup cannot begin paid work", async () => {
	const deadline = new AbortController(), startup = deferred<void>(), started = deferred<void>();
	let prompts = 0;
	const f = fixture({ create: async () => { started.resolve(); await startup.promise; }, round: async () => { prompts++; return "unexpected"; } }, () => deadline.signal);
	try {
		const env = await f.host.environment("parent");
		const request = post(env, round(1)); await started.promise;
		deadline.abort(new Error("startup deadline"));
		const result = await (await request).json() as { responses: unknown[]; missing: unknown[] };
		assert.equal(result.responses.length, 0); assert.equal(result.missing.length, 2); assert.equal(f.stopped.length, 2);
		startup.resolve(); await Promise.resolve(); await Promise.resolve();
		assert.equal(prompts, 0);
	} finally { startup.resolve(); await f.host.dispose(); }
});

test("a participant lost while awaiting synthesis stays a gap in review rather than a replacement", async () => {
	const f = fixture();
	try {
		const env = await f.host.environment("parent");
		for (let n = 1; n <= 4; n++) assert.equal((await post(env, round(n))).status, 200);
		const lost = f.views()[0]!.participants[0]!.sessionId;
		await f.host.participantLost(lost);
		assert.equal(f.views()[0]!.participants[0]!.status, "failed");
		const review = await (await post(env, round(5))).json() as { responses: { source: string }[]; missing: { id: string }[] };
		assert.equal(review.responses.length, 1); assert.equal(review.missing[0]!.id, "round-5-participant-1");
		assert.notEqual(review.responses[0]!.source, lost); assert.equal(f.created.length, 2);
	} finally { await f.host.dispose(); }
});

test("caller fetch abort cancels its work and parent shutdown revokes capability", async () => {
	const gate = deferred<string>(), started = deferred<void>(), stopped = deferred<void>();
	const f = fixture({ round: async () => { started.resolve(); return gate.promise; }, stop: async () => { stopped.resolve(); } });
	try {
		const env = await f.host.environment("parent"), controller = new AbortController();
		const request = post(env, round(1), controller.signal); void request.catch(() => {});
		await started.promise; controller.abort(); await assert.rejects(request); await stopped.promise;
		await f.host.cancelParent("parent", true);
		assert.equal(f.views()[0]!.status, "incomplete");
		assert.equal((await post(env, round(2))).status, 403);
		gate.resolve("late answer");
	} finally { await f.host.dispose(); }
});

test("dispose drains active work without accepting late completions", async () => {
	const gate = deferred<string>(), started = deferred<void>();
	const f = fixture({ round: async () => { started.resolve(); return gate.promise; } });
	const env = await f.host.environment("parent");
	const request = post(env, round(1)); void request.catch(() => {}); await started.promise;
	await f.host.dispose(); gate.resolve("late");
	assert.equal(f.views()[0]!.status, "incomplete"); assert.ok(f.stopped.length >= 2);
	await assert.rejects(f.host.environment("parent"));
	await request.catch(() => {});
});

test("fresh answer is last assistant after the submitted prompt, never the stale round answer", async () => {
	let entries: PiSessionEntry[] = [{ id: "old", type: "message", message: { role: "assistant", content: [{ type: "text", text: "stale" }] } }];
	const pi = { getEntries: async () => ({ entries, leafId: null }) } as unknown as PiClient;
	const signal = new AbortController().signal;
	await assert.rejects(freshParticipantAnswer(pi, "fresh task", async () => ({ stopReason: "end_turn" }), signal), /no fresh/);
	const text = await freshParticipantAnswer(pi, "fresh task", async () => {
		entries = [...entries, { id: "user", message: { role: "user", content: [{ type: "text", text: "fresh task" }] } },
			{ id: "first", message: { role: "assistant", content: [{ type: "text", text: "intermediate" }] } },
			{ id: "last", message: { role: "assistant", content: [{ type: "text", text: "fresh last answer" }] } }];
		return { stopReason: "end_turn" };
	}, signal);
	assert.equal(text, "fresh last answer");
});

test("participant launch isolates extensions/tools and clears inherited capabilities", async () => {
	const options = await brainstormParticipantOptions("/pi", "/project", fileURLToPath(new URL("../../external/pi-tools-suite/src/index.ts", import.meta.url)), "antigravity/exact");
	assert.equal(options.provider, "antigravity"); assert.equal(options.model, "exact");
	assert.equal(options.env?.PIX_BRAINSTORM_HOST_TOKEN, ""); assert.equal(options.env?.PIX_BRAINSTORM_HOST_URL, "");
	assert.ok(options.args?.includes("--no-extensions"));
	const tools = options.args![options.args!.indexOf("--tools") + 1]!;
	assert.ok(!tools.split(",").some((tool) => ["bash", "write", "edit", "shell", "async_subagents"].includes(tool)));
	const extensions = options.args!.filter((_, i, args) => args[i - 1] === "--extension");
	assert.equal(extensions.length, 2); assert.ok(extensions[0]!.endsWith("research-extension.ts")); assert.ok(extensions[1]!.endsWith("antigravity-auth/index.ts"));
	const packaged = await brainstormParticipantOptions("/pi", "/project", fileURLToPath(new URL("../../external/pi-tools-suite/index.ts", import.meta.url)), "zai/exact");
	assert.deepEqual(packaged.args!.filter((_, i, args) => args[i - 1] === "--extension"), [extensions[0]]);
});
