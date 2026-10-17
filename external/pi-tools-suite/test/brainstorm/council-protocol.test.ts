import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
	abortCouncil, collectRound, councilStatus, finalizeCouncil, initCouncil, reviewCouncil,
} from "../../src/brainstorm/skill/scripts/lib/protocol.mjs";

const MODELS = ["one/alpha", "two/beta", "three/gamma"];

type Spawn = { runDir: string; tasks: Array<{ id: string; model: string; thinking: string; extraArgs: string[] }> };

function project(models: string[] = MODELS, extra: Record<string, unknown> = {}) {
	const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "council-run-")));
	const homeDir = mkdtempSync(path.join(tmpdir(), "council-home-"));
	mkdirSync(path.join(homeDir, ".config", "pi"), { recursive: true });
	writeFileSync(path.join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), JSON.stringify({ brainstorm: { models, ...extra } }));
	return { cwd, homeDir, env: {} as Record<string, string> };
}

async function start(base = project(), mode = "brainstorm") {
	const init = await initCouncil({ ...base, mode, topic: "Choose a cache", brief: "## Goal\nPick a cache strategy.\n\n## Fixed decisions\nnone" });
	return { base, init, spawn: init.spawn as Spawn, run: init.runDir as string };
}

const SCOPE = "0199f0c2-0000-7000-8000-00000000c0de";

type AnswerOptions = { status?: string; model?: string; turns?: number; thinking?: string; messages?: number; noRecord?: boolean };

/**
 * Simulate a settled participant the way async-subagents persists it
 * (decision 0072): a child session under `.pi/subagents/<scope>/` that starts
 * with `subagent_meta`, plus folded `pi-tools-suite:subagent` records in the
 * parent session.
 */
function answer(ctx: { base: { cwd: string }; spawn: Spawn }, slot: number, round: number, text: string, over: AnswerOptions = {}) {
	const task = ctx.spawn.tasks[slot - 1]!;
	const batch = ctx.spawn.runDir;
	const cwd = ctx.base.cwd;
	const parentSession = path.join(cwd, ".pi", "parent-session.jsonl");
	const scopeDir = path.join(cwd, ".pi", "subagents", SCOPE);
	mkdirSync(scopeDir, { recursive: true });
	const model = over.model ?? task.model;
	const turns = over.turns ?? round - 1;
	const meta = { version: 1, agentId: task.id, batch, runDir: path.join(cwd, ".pi", "subagents", SCOPE, batch), cwd, subagentType: "research", parentSession, parentSessionId: SCOPE, scope: SCOPE };
	const lines = [
		{ type: "session", version: 3, id: `child-${task.id}`, timestamp: new Date().toISOString(), cwd },
		{ type: "custom", customType: "subagent_meta", data: meta },
		...Array.from({ length: over.messages ?? round }, () => ({ type: "message", message: { role: "user", content: "round" } })),
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } },
	];
	writeFileSync(path.join(scopeDir, `${task.id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	if (over.noRecord) return;
	const record = {
		version: 1, scope: SCOPE, batch, agentId: task.id,
		task: { id: task.id, task: "council", model, subagentType: "research", thinking: over.thinking ?? task.thinking },
		extraArgs: task.extraArgs, status: over.status ?? "done", turn: turns + 1,
		structured: { schemaVersion: 2, agentId: task.id, status: over.status ?? "done", model },
	};
	appendFileSync(parentSession, JSON.stringify({ type: "custom", customType: "pi-tools-suite:subagent", data: record }) + "\n");
}

const ledger = (slot: number, round: number) => `Answer P${slot} R${round}.\n\n## Ledger\n\n| ID | Stance | Refs | Note |\n| --- | --- | --- | --- |\n| P${slot}-H1 | ${round === 1 ? "new" : "keep"} | | idea ${slot} |\n`;

async function failure(promise: Promise<unknown>): Promise<{ code?: number; message: string }> {
	try { await promise; } catch (error) { return error as { code?: number; message: string }; }
	throw new Error("expected rejection");
}

const manifestOf = (run: string) => JSON.parse(readFileSync(path.join(run, "manifest.json"), "utf8"));

describe("council protocol", () => {
	test("runs five rounds over persistent participants and finalizes", async () => {
		const ctx = await start();
		const { base, run, spawn } = ctx;
		expect(spawn.tasks.map((task) => task.id)).toEqual(["p1", "p2", "p3"]);
		expect(spawn.tasks[0]!.extraArgs.slice(2)).toEqual(["--tools", "read,grep,web_search,web_fetch,project_search"]);
		expect(spawn.tasks[0]!.thinking).toBe("high");
		expect(spawn.runDir).toMatch(/^[0-9T-]+-brainstorm-[0-9a-f]+$/);
		expect(existsSync(path.join(base.cwd, ".pi", "subagents", spawn.runDir))).toBe(false);
		expect(readFileSync(path.join(run, "prompts", "round-1-p1.md"), "utf8")).toContain("Pick a cache strategy");

		const pending = await collectRound({ ...base, run });
		expect(pending.status).toBe("pending");

		for (let round = 1; round <= 4; round++) {
			for (const slot of [1, 2, 3]) answer(ctx, slot, round, ledger(slot, round));
			const result = await collectRound({ ...base, run });
			if (round < 4) {
				expect(result.status).toBe("running");
				expect(result.sends.map((send: { agentId: string }) => send.agentId)).toEqual(["p1", "p2", "p3"]);
				const prompt = readFileSync(path.join(run, "prompts", `round-${round + 1}-p1.md`), "utf8");
				expect(prompt).toContain(`Answer P2 R${round}`);
				expect(prompt).not.toContain(`Answer P1 R${round}`);
			} else {
				expect(result.status).toBe("awaiting_synthesis");
			}
		}
		expect(readFileSync(path.join(run, "discussion.md"), "utf8")).toContain("## Position matrix");

		const draft = "# Draft\n\nRecommend P1-H1.";
		expect((await failure(finalizeCouncil({ ...base, run, proposal: "x", notes: "y" }))).code).toBe(2);
		const review = await reviewCouncil({ ...base, run, draft });
		expect(review.status).toBe("reviewing_synthesis");
		const round5 = readFileSync(path.join(run, "prompts", "round-5-p2.md"), "utf8");
		expect(round5).toContain("Recommend P1-H1");
		expect(round5).toContain("Answer P1 R4");
		expect(round5).not.toContain("## Ledger\" markdown table");

		for (const slot of [1, 2, 3]) answer(ctx, slot, 5, `Review ${slot}: no blocking correction.`);
		expect((await collectRound({ ...base, run })).status).toBe("awaiting_finalization");

		const done = await finalizeCouncil({ ...base, run, proposal: "# Final\n\nP1-H1.", notes: "Accepted all.", publish: true });
		expect(done.status).toBe("complete");
		expect(readFileSync(done.proposalPath, "utf8")).toContain("# Final");
		expect(existsSync(done.publishedPath)).toBe(true);
		expect(path.dirname(done.publishedPath)).toBe(path.join(base.cwd, "docs", "brainstorms"));
		expect(readFileSync(path.join(run, "draft-proposal.md"), "utf8")).toBe(draft);
		expect((await failure(finalizeCouncil({ ...base, run, proposal: "again", notes: "again" }))).code).toBe(2);
		expect((await councilStatus({ ...base, run })).status).toBe("complete");
	});

	test("failed participants become gaps and the quorum ends the run", async () => {
		const ctx = await start();
		const { base, run } = ctx;
		answer(ctx, 1, 1, ledger(1, 1));
		answer(ctx, 2, 1, ledger(2, 1));
		answer(ctx, 3, 1, "", { status: "failed" });
		const round1 = await collectRound({ ...base, run });
		expect(round1.status).toBe("running");
		expect(round1.gaps).toEqual([{ id: "round-1-participant-3", reason: "participant failed" }]);
		expect(round1.sends.map((send: { agentId: string }) => send.agentId)).toEqual(["p1", "p2"]);
		expect(readFileSync(path.join(run, "prompts", "round-2-p1.md"), "utf8")).toContain("coverage gap: participant failed");

		answer(ctx, 1, 2, ledger(1, 2));
		answer(ctx, 2, 2, "", { status: "stopped" });
		const error = await failure(collectRound({ ...base, run }));
		expect(error.code).toBe(1);
		expect(error.message).toContain("quorum not met");
		expect(manifestOf(run).status).toBe("incomplete");
		expect((await failure(collectRound({ ...base, run }))).code).toBe(2);
	});

	test("declared missing participants unblock a pending round", async () => {
		const ctx = await start();
		const { base, run } = ctx;
		answer(ctx, 1, 1, ledger(1, 1));
		answer(ctx, 2, 1, ledger(2, 1));
		const pending = await collectRound({ ...base, run });
		expect(pending.pending).toEqual([{ agentId: "p3", reason: "not launched (spawn it)" }]);
		expect((await failure(collectRound({ ...base, run, missing: "p9=x" }))).code).toBe(2);
		const result = await collectRound({ ...base, run, missing: "p3=stuck past timeout" });
		expect(result.gaps).toEqual([{ id: "round-1-participant-3", reason: "stuck past timeout" }]);
		expect(manifestOf(run).participants[2]).toMatchObject({ active: false, droppedRound: 1 });
	});

	test("model substitution, extra turns and tampering are refused", async () => {
		const substituted = await start();
		answer(substituted, 1, 1, ledger(1, 1), { model: "cheap/other" });
		answer(substituted, 2, 1, ledger(2, 1));
		answer(substituted, 3, 1, ledger(3, 1));
		const error = await failure(collectRound({ ...substituted.base, run: substituted.run }));
		expect(error.code).toBe(1);
		expect(error.message).toContain("model substitution");
		expect(manifestOf(substituted.run).status).toBe("incomplete");

		const thinking = await start();
		for (const slot of [1, 2, 3]) answer(thinking, slot, 1, ledger(slot, 1), slot === 2 ? { thinking: "low" } : {});
		expect((await failure(collectRound({ ...thinking.base, run: thinking.run }))).message).toContain("thinking");

		const extra = await start();
		for (const slot of [1, 2, 3]) answer(extra, slot, 1, ledger(slot, 1));
		await collectRound({ ...extra.base, run: extra.run });
		for (const slot of [1, 2, 3]) answer(extra, slot, 2, ledger(slot, 2), slot === 1 ? { turns: 2 } : {});
		expect((await failure(collectRound({ ...extra.base, run: extra.run }))).message).toContain("extra messages");

		const tampered = await start();
		for (const slot of [1, 2, 3]) answer(tampered, slot, 1, ledger(slot, 1));
		await collectRound({ ...tampered.base, run: tampered.run });
		writeFileSync(path.join(tampered.run, "rounds", "round-1-participant-1.md"), "forged");
		const tamperError = await failure(collectRound({ ...tampered.base, run: tampered.run }));
		expect(tamperError.code).toBe(1);
		expect(tamperError.message).toContain("changed after it was recorded");
		expect(manifestOf(tampered.run).status).toBe("incomplete");
		expect((await councilStatus({ ...tampered.base, run: tampered.run })).integrityError).toContain("changed after it was recorded");
		const stopped = await abortCouncil({ ...tampered.base, run: tampered.run, reason: "tampered" });
		expect(stopped.stop.agentIds).toEqual(["p1", "p2", "p3"]);
		expect(manifestOf(tampered.run).error).toContain("changed after it was recorded");
	});

	test("participants of a parent without a persisted session are refused", async () => {
		const ctx = await start();
		for (const slot of [1, 2, 3]) answer(ctx, slot, 1, ledger(slot, 1), slot === 1 ? { noRecord: true } : {});
		const error = await failure(collectRound({ ...ctx.base, run: ctx.run }));
		expect(error.code).toBe(1);
		expect(error.message).toContain("saved parent session");
	});

	test("live follow-ups that bypass the turn record are refused via the session", async () => {
		const live = await start();
		for (const slot of [1, 2, 3]) answer(live, slot, 1, ledger(slot, 1), slot === 2 ? { messages: 2 } : {});
		const error = await failure(collectRound({ ...live.base, run: live.run }));
		expect(error.code).toBe(1);
		expect(error.message).toContain("2 user messages");
		const lagging = await start();
		for (const slot of [1, 2, 3]) answer(lagging, slot, 1, ledger(slot, 1), slot === 3 ? { messages: 0 } : {});
		expect((await collectRound({ ...lagging.base, run: lagging.run })).status).toBe("pending");
	});

	test("symlinked rounds/ or prompts/ cannot redirect protocol writes", async () => {
		const ctx = await start();
		const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "council-outside-")));
		symlinkSync(outside, path.join(ctx.run, "rounds"));
		for (const slot of [1, 2, 3]) answer(ctx, slot, 1, ledger(slot, 1));
		const error = await failure(collectRound({ ...ctx.base, run: ctx.run }));
		expect(error.message).toContain("symlink");
		expect(readdirSync(outside)).toEqual([]);
	});

	test("undelivered spawns and sends come back as safe retry actions", async () => {
		const ctx = await start();
		answer(ctx, 1, 1, ledger(1, 1));
		answer(ctx, 2, 1, ledger(2, 1));
		const first = await collectRound({ ...ctx.base, run: ctx.run });
		expect(first.status).toBe("pending");
		expect(first.respawn.tasks.map((task: { id: string }) => task.id)).toEqual(["p3"]);
		expect((await councilStatus({ ...ctx.base, run: ctx.run })).respawn.tasks).toHaveLength(1);
		answer(ctx, 3, 1, ledger(3, 1));
		const next = await collectRound({ ...ctx.base, run: ctx.run });
		expect(next.status).toBe("running");
		answer(ctx, 1, 2, ledger(1, 2));
		answer(ctx, 2, 2, ledger(2, 2));
		const pending = await collectRound({ ...ctx.base, run: ctx.run });
		expect(pending.resend.map((send: { agentId: string }) => send.agentId)).toEqual(["p3"]);
		const status = await councilStatus({ ...ctx.base, run: ctx.run });
		expect(status.resend).toHaveLength(1);
		expect(status.next).toContain("resend");
	});

	test("oversized or empty answers are gaps, not failures", async () => {
		const ctx = await start();
		answer(ctx, 1, 1, ledger(1, 1));
		answer(ctx, 2, 1, "x".repeat(40_001));
		answer(ctx, 3, 1, "   ");
		const error = await failure(collectRound({ ...ctx.base, run: ctx.run }));
		expect(error.code).toBe(1);
		expect(error.message).toContain("exceeds 40000");
		expect(error.message).toContain("empty response");
	});

	test("init validates mode, roster, environment and run paths", async () => {
		const base = project();
		expect((await failure(initCouncil({ ...base, mode: "auto", topic: "t", brief: "b" }))).code).toBe(2);
		expect((await failure(initCouncil({ ...base, env: { PI_SUBAGENTS_FORCE_CURRENT_MODEL: "1" }, mode: "audit", topic: "t", brief: "b" }))).message).toContain("PI_SUBAGENTS_FORCE_CURRENT_MODEL");
		const thin = project([]);
		writeFileSync(path.join(thin.homeDir, ".config", "pi", "pi-tools-suite.jsonc"), JSON.stringify({ frontierModels: [{ model: "a/one", enabled: false }] }));
		expect((await failure(initCouncil({ ...thin, mode: "brainstorm", topic: "t", brief: "b" }))).message).toContain("at least 2 models");
		const override = await initCouncil({ ...base, mode: "audit", topic: "t", brief: "b", models: "x/a:low,y/b:max" });
		expect(override.spawn.tasks.map((task: { model: string; thinking: string }) => `${task.model}:${task.thinking}`)).toEqual(["x/a:low", "y/b:max"]);
		expect(override.quorum).toBe(2);
		expect((await failure(collectRound({ ...base, run: base.cwd }))).message).toContain("direct child");
	});

	test("abort marks the run incomplete and returns the stop call", async () => {
		const { base, run } = await start();
		const aborted = await abortCouncil({ ...base, run, reason: "user cancelled" });
		expect(aborted.stop).toMatchObject({ action: "stop", agentIds: ["p1", "p2", "p3"] });
		expect(manifestOf(run).error).toContain("user cancelled");
		expect((await abortCouncil({ ...base, run })).status).toBe("incomplete");
		expect(manifestOf(run).error).toContain("user cancelled");
	});
});
