import assert from "node:assert/strict";
import { test } from "node:test";
import { DelegatedEvidence } from "../src/bundled-extensions/heads-up/delegated.js";
import { beginDelegatedEvidence } from "../external/pi-tools-suite/src/async-subagents/delegated-evidence.js";
import { createBatch, forgetRecord, resolveScope, updateRecord } from "../external/pi-tools-suite/src/async-subagents/core/store.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const launch = { version: 1, phase: "started", launchId: "launch-1", sessionId: "parent", anchorId: "spawn-entry", runDir: "/run/one", agentId: "child" };
const completed = { ...launch, phase: "completed", status: "done", report: "Done. Tests pass. Changed getUser to return Promise<User>.", clipped: false };

test("delegated evidence requires an observed launch in the same parent and projected branch", () => {
	const evidence = new DelegatedEvidence();
	assert.equal(evidence.accept(completed, "parent"), false);
	assert.equal(evidence.accept(launch, "other"), false);
	evidence.accept(launch, "parent");
	assert.equal(evidence.accept({ ...completed, agentId: "other" }, "parent"), false);
	assert.equal(evidence.accept(completed, "parent"), true);
	assert.equal(evidence.accept(completed, "parent"), false);
	assert.equal(evidence.records(new Set()).length, 0);
	const records = evidence.records(new Set(["spawn-entry"]));
	assert.equal(records.length, 1);
	assert.equal(records[0]?.kind, "delegated");
	assert.match(records[0]!.text, /child-reported/);
	assert.match(records[0]!.text, /Promise<User>/);
});

test("branch/session invalidation retires launches, including late completions", () => {
	const evidence = new DelegatedEvidence(); evidence.accept(launch, "parent");
	evidence.clear(); assert.equal(evidence.accept(completed, "parent"), false);
	evidence.accept(launch, "parent"); assert.equal(evidence.accept(completed, "replacement"), false);
});

test("reports are bounded, redacted and generic custom notices supply no evidence", () => {
	const evidence = new DelegatedEvidence();
	assert.equal(evidence.accept({ role: "custom", customType: "async-subagents-agent-completion", content: "done" }, "parent"), false);
	evidence.accept(launch, "parent");
	evidence.accept({ ...completed, report: "api_key=secret-value\n" + "x".repeat(10000) }, "parent");
	const record = evidence.records(new Set(["spawn-entry"]))[0]!;
	assert.ok(record.text.length <= 3000); assert.equal(record.clipped, true);
	assert.doesNotMatch(record.text, /secret-value/);
});

test("suite producer captures launch synchronously and forwards final structured report once", async () => {
	await mkdir(".pi/artifacts", { recursive: true });
	const dir = await mkdtemp(".pi/artifacts/delegated-bridge-");
	const runDir = createBatch(path.resolve(dir), resolveScope(), "heads-up-bridge");
	try {
		const evidence = new DelegatedEvidence(); const events: any[] = [];
		let finish!: () => void; const received = new Promise<void>((resolve) => { finish = resolve; });
		const capture = beginDelegatedEvidence({ emit: (channel, value) => {
			assert.equal(channel, "async-subagents:delegated-evidence"); events.push(value); evidence.accept(value, "parent");
			if ((value as any).phase === "completed") finish();
		} }, { sessionId: "parent", anchorId: "spawn-entry" }, "child");
		assert.equal(events.length, 1); // before routing/auth awaits or a run directory exists
		const childSessionFile = path.join(dir, "child.jsonl");
		await writeFile(childSessionFile, [
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Originally broke getUser." }] } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Then restored User return and reran tests. Done." }] } }),
		].join("\n") + "\n");
		updateRecord(runDir, "child", { status: "done", childSessionFile });
		const completed = capture.bind(runDir);
		capture.releaseUnbound(); // A successful spawn returning must not retire background ownership.
		const result = { runDir, agentId: "child", agentDir: dir, exitCode: 0, state: { id: "child", status: "done" as const } };
		completed({ ...result, agentId: "wrong" }); completed(result); completed(result); await received;
		assert.equal(events.length, 2);
		const record = evidence.records(new Set(["spawn-entry"]))[0]!;
		assert.match(record.text, /Then restored/);
		assert.doesNotMatch(record.text, /Originally broke/); // Only the last final answer is evidence.
	} finally { forgetRecord(runDir, "child"); await rm(dir, { recursive: true, force: true }); }
});

test("retired preflight captures do not evict legitimate in-flight children", () => {
	const evidence = new DelegatedEvidence();
	evidence.accept(launch, "parent");
	for (let i = 0; i < 80; i++) {
		const capture = beginDelegatedEvidence({ emit: (_channel, value) => { evidence.accept(value, "parent"); } }, { sessionId: "parent", anchorId: "spawn-entry" }, `rejected-${i}`);
		capture.releaseUnbound();
	}
	assert.equal(evidence.accept(completed, "parent"), true);
	const events: { phase: string }[] = [];
	const capture = beginDelegatedEvidence({ emit: (_channel, value) => { events.push(value as { phase: string }); } }, { sessionId: "parent", anchorId: "spawn-entry" }, "cancelled");
	const complete = capture.bind("/run/cancelled");
	capture.cancel(); capture.cancel(); capture.releaseUnbound();
	complete({ runDir: "/run/cancelled", agentId: "cancelled", agentDir: "/missing", exitCode: 0, state: { id: "cancelled", status: "done" } });
	assert.deepEqual(events.map((event) => event.phase), ["started", "retired"]);
});

test("missing, unreadable, foreign or errored child sessions cannot become delegated evidence", async () => {
	await mkdir(".pi/artifacts", { recursive: true });
	const dir = await mkdtemp(".pi/artifacts/delegated-invalid-");
	try {
		const scenarios = [
			{ content: undefined },
			{ content: "not json" },
			{ content: JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "not this child" }] } }), agentId: "other" },
			{ content: JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "failed response" }] } }) },
		];
		for (const [index, scenario] of scenarios.entries()) {
			const runDir = createBatch(path.resolve(dir), resolveScope(), `heads-up-invalid-${index}`);
			const childSessionFile = path.join(dir, `child-${index}.jsonl`);
			if (scenario.content !== undefined) await writeFile(childSessionFile, scenario.content);
			updateRecord(runDir, scenario.agentId ?? "child", { status: "done", childSessionFile });
			const evidence = new DelegatedEvidence();
			let finish!: (value: unknown) => void;
			const received = new Promise<unknown>((resolve) => { finish = resolve; });
			const complete = beginDelegatedEvidence({ emit: (_channel, value) => {
				evidence.accept(value, "parent");
				if ((value as { phase: string }).phase === "completed") finish(value);
			} }, { sessionId: "parent", anchorId: "spawn-entry" }, "child").bind(runDir);
			complete({ runDir, agentId: "child", agentDir: dir, exitCode: 0, state: { id: "child", status: "done" } });
			assert.equal((await received as { report?: string }).report, undefined);
			assert.deepEqual(evidence.records(new Set(["spawn-entry"])), []);
			forgetRecord(runDir, scenario.agentId ?? "child");
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("oversized session-native child reports are clipped before reaching the observer", async () => {
	await mkdir(".pi/artifacts", { recursive: true });
	const dir = await mkdtemp(".pi/artifacts/delegated-large-");
	const runDir = createBatch(path.resolve(dir), resolveScope(), "heads-up-large");
	try {
		const childSessionFile = path.join(dir, "child.jsonl");
		await writeFile(childSessionFile, JSON.stringify({
			type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(128 * 1024) }] },
		}) + "\n");
		updateRecord(runDir, "child", { status: "done", childSessionFile });
		const evidence = new DelegatedEvidence();
		let resolveCompletion!: (value: any) => void;
		const received = new Promise<any>((resolve) => { resolveCompletion = resolve; });
		const complete = beginDelegatedEvidence({ emit: (_channel, value) => {
			evidence.accept(value, "parent");
			if ((value as { phase: string }).phase === "completed") resolveCompletion(value);
		} }, { sessionId: "parent", anchorId: "spawn-entry" }, "child").bind(runDir);
		complete({ runDir, agentId: "child", agentDir: dir, exitCode: 0, state: { id: "child", status: "done" } });
		const result = await received as { report?: string; clipped?: boolean };
		assert.equal(result.report?.length, 6000);
		assert.equal(result.clipped, true);
		const record = evidence.records(new Set(["spawn-entry"]))[0]!;
		assert.equal(record.clipped, true);
		assert.ok(record.text.length <= 3000);
	} finally { forgetRecord(runDir, "child"); await rm(dir, { recursive: true, force: true }); }
});
