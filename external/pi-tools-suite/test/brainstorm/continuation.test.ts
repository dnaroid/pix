import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finalizeBrainstorm, reviewBrainstorm } from "../../src/brainstorm/continuation.js";
import { runBrainstorm, type BrainstormConfig, type RunRound } from "../../src/brainstorm/workflow.js";

const dirs: string[] = [];
const brief = "Goal: durable data. Constraints: bounded cost. Non-goals: implementation. Success: recoverable state. Assumptions: verify throughput.";
const config: BrainstormConfig = { models: ["one/a", "two/b"], thinking: "high", timeoutSeconds: 30 };
const goodRound: RunRound = async ({ round, tasks }) => tasks.map(({ id, model }) => ({ id, model, text: `Round ${round} evidence from ${model}` }));
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(runRound = goodRound) {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "brainstorm-review-"));
	dirs.push(cwd);
	const result = await runBrainstorm({ cwd, topic: "storage", brief, config, runRound });
	const manifestPath = path.join(result.runDir, "manifest.json");
	return { cwd, ...result, manifest: async () => JSON.parse(await readFile(manifestPath, "utf8")), manifestPath };
}

test("all five rounds preserve provenance, draft, original settings, review and final dispositions", async () => {
	const f = await fixture();
	expect(await readFile(path.join(f.runDir, "brief.md"), "utf8")).toContain(brief);
	await expect(finalizeBrainstorm(f.cwd, f.runDir, "Premature", "none")).rejects.toThrow("awaiting_finalization");
	const draft = "# Draft\nPrefer option A; minority prefers B.";
	const calls: Parameters<RunRound>[0][] = [];
	const reviewed = await reviewBrainstorm({ cwd: f.cwd, runDir: path.relative(f.cwd, f.runDir), proposal: draft, runRound: async (input) => {
		calls.push(input);
		expect((await f.manifest()).status).toBe("reviewing_synthesis");
		expect(await readFile(path.join(f.runDir, "draft-proposal.md"), "utf8")).toBe(draft);
		return goodRound(input);
	} });
	expect(reviewed.status).toBe("awaiting_finalization");
	expect(calls.map((call) => call.round)).toEqual([5]);
	expect(calls[0]!.tasks.map(({ model, thinking, timeoutSeconds }) => ({ model, thinking, timeoutSeconds }))).toEqual(config.models.map((model) => ({ model, thinking: config.thinking, timeoutSeconds: config.timeoutSeconds })));
	for (const task of calls[0]!.tasks) {
		expect(task.task).toContain(draft);
		expect(task.task).toContain("omitted minority views");
		for (const round of [1, 2, 3, 4]) for (const model of config.models) expect(task.task).toContain(`Round ${round} evidence from ${model}`);
	}
	const notes = "round-5-participant-2: accepted missing caveat; B still unresolved, run durability test.";
	await finalizeBrainstorm(f.cwd, f.runDir, "# Final\nA with caveat, B remains unresolved.", notes);
	expect(await readFile(reviewed.draftPath, "utf8")).toBe(draft);
	expect(await readFile(path.join(f.runDir, "revision-notes.md"), "utf8")).toBe(notes);
	expect(await readFile(f.discussionPath, "utf8")).toContain("## Round 5: Synthesis review");
	expect((await f.manifest()).status).toBe("complete");
	expect(Object.keys((await f.manifest()).rounds)).toEqual(["1", "2", "3", "4", "5"]);
	await expect(reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "replacement", runRound: goodRound })).rejects.toThrow();
});

test("failures in critique or revision retain all completed earlier rounds", async () => {
	for (const failure of [3, 4]) {
		const f = await fixture(async (input) => { if (input.round === failure) throw new Error("provider unavailable"); return goodRound(input); });
		expect(f.status).toBe("incomplete");
		expect(Object.keys((await f.manifest()).rounds)).toHaveLength(failure - 1);
		await expect(reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "draft", runRound: goodRound })).rejects.toThrow();
	}
});

test("failed, malformed, oversized and cancelled fifth rounds preserve draft and prevent finalization", async () => {
	for (const mode of ["failed", "missing", "oversized", "cancelled"]) {
		const f = await fixture();
		const controller = new AbortController();
		const result = await reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "# Retained draft", signal: controller.signal, runRound: async (input) => {
			if (mode === "failed") throw new Error("review failed");
			if (mode === "cancelled") controller.abort();
			if (mode === "missing") return [];
			const output = await goodRound(input);
			if (mode === "oversized") output[0]!.text = "x".repeat(40_001);
			return output;
		} });
		expect(result.status).toBe("incomplete");
		expect(Object.keys((await f.manifest()).rounds)).toEqual(["1", "2", "3", "4"]);
		expect(await readFile(result.draftPath, "utf8")).toBe("# Retained draft");
		expect(await readFile(f.discussionPath, "utf8")).toContain("Round 4 evidence");
		expect(await readFile(f.proposalPath, "utf8")).toContain("pending synthesis");
		await expect(finalizeBrainstorm(f.cwd, f.runDir, "final", "notes")).rejects.toThrow();
		await expect(access(path.join(f.runDir, ".finalize.lock"))).rejects.toThrow();
	}
});

test("concurrent review/finalize cannot launch duplicate reviews or bypass an active review", async () => {
	const f = await fixture();
	let release!: () => void, entered!: () => void, calls = 0;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const first = reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "first draft", runRound: async (input) => { calls++; entered(); await gate; return goodRound(input); } });
	try {
		await started;
		await expect(reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "second draft", runRound: goodRound })).rejects.toThrow("in progress");
		await expect(finalizeBrainstorm(f.cwd, f.runDir, "early final", "notes")).rejects.toThrow("in progress");
	} finally { release(); await first; }
	expect(calls).toBe(1);
	expect(await readFile(path.join(f.runDir, "draft-proposal.md"), "utf8")).toBe("first draft");
	expect((await f.manifest()).status).toBe("awaiting_finalization");
});

test("review contender delayed before acquiring lock cannot overwrite a reviewed winner", async () => {
	const f = await fixture();
	let release!: () => void, entered!: () => void, delayed = false;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const paused = new Promise<void>((resolve) => { entered = resolve; });
	const original = fs.open;
	const spy = spyOn(fs, "open").mockImplementation(async (...args) => {
		if (!delayed && String(args[0]).endsWith(".finalize.lock")) { delayed = true; entered(); await gate; }
		return original(...args);
	});
	const contender = reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "stale draft", runRound: goodRound }).then(() => "unexpected", () => "rejected");
	try {
		await paused;
		await reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "winner", runRound: goodRound });
		release();
		expect(await contender).toBe("rejected");
		expect(await readFile(path.join(f.runDir, "draft-proposal.md"), "utf8")).toBe("winner");
		expect((await f.manifest()).status).toBe("awaiting_finalization");
	} finally { release(); await contender; spy.mockRestore(); }
});

test("pre-cancelled review and invalid draft do not change waiting state or launch work", async () => {
	const f = await fixture();
	let calls = 0;
	const runRound: RunRound = async (input) => { calls++; return goodRound(input); };
	await expect(reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "draft", signal: AbortSignal.abort(), runRound })).rejects.toThrow();
	await expect(reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "x".repeat(40_001), runRound })).rejects.toThrow();
	expect(calls).toBe(0);
	expect((await f.manifest()).status).toBe("awaiting_synthesis");
	await expect(access(path.join(f.runDir, "draft-proposal.md"))).rejects.toThrow();
});

test("modified or symlinked draft and absent revision notes cannot be finalized", async () => {
	for (const mode of ["modified", "symlink", "missing-notes"]) {
		const f = await fixture();
		const result = await reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "draft", runRound: goodRound });
		if (mode === "modified") await writeFile(result.draftPath, "changed");
		if (mode === "symlink") {
			const target = path.join(f.cwd, "original.md");
			await writeFile(target, "draft"); await rm(result.draftPath); await symlink(target, result.draftPath);
		}
		await expect(finalizeBrainstorm(f.cwd, f.runDir, "final", mode === "missing-notes" ? "" : "notes")).rejects.toThrow();
		expect((await f.manifest()).status).toBe("awaiting_finalization");
		expect(await readFile(f.proposalPath, "utf8")).toContain("pending synthesis");
	}
});

test("legacy and malformed persisted rounds cannot bypass review prerequisites", async () => {
	for (const mode of ["legacy", "missing", "wrong-model"]) {
		const f = await fixture();
		const manifest = await f.manifest();
		if (mode === "legacy") manifest.format = "pi-brainstorm-v1";
		if (mode === "missing") manifest.rounds[4].pop();
		if (mode === "wrong-model") manifest.rounds[4][0].model = "other/model";
		await writeFile(f.manifestPath, JSON.stringify(manifest));
		let calls = 0;
		await expect(reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "draft", runRound: async (input) => { calls++; return goodRound(input); } })).rejects.toThrow();
		expect(calls).toBe(0);
	}
});

test("cumulative five-round budget failure retains four rounds rather than silently truncating", async () => {
	const f = await fixture(async (input) => (await goodRound(input)).map((response) => ({ ...response, text: "x".repeat(24_000) })));
	const result = await reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "draft", runRound: async (input) => (await goodRound(input)).map((response) => ({ ...response, text: "y".repeat(5_000) })) });
	expect(result.status).toBe("incomplete");
	expect((await f.manifest()).error).toContain("total document size limit");
	expect(Object.keys((await f.manifest()).rounds)).toHaveLength(4);
});

test("review uses persisted settings after the original caller changes its configuration", async () => {
	const f = await fixture();
	const original = { ...config, models: [...config.models] };
	const run = await runBrainstorm({ cwd: f.cwd, topic: "snapshot", brief, config: original, runRound: goodRound });
	original.models.reverse(); original.thinking = "low"; original.timeoutSeconds = 120;
	await reviewBrainstorm({ cwd: f.cwd, runDir: run.runDir, proposal: "draft", runRound: async (input) => {
		expect(input.tasks.map((task) => task.model)).toEqual(config.models);
		expect(input.tasks.every((task) => task.thinking === "high" && task.timeoutSeconds === 30)).toBe(true);
		return goodRound(input);
	} });
});

test("finalization write failures cannot leave a complete manifest", async () => {
	for (const failure of ["proposal", "manifest"]) {
		const f = await fixture();
		await reviewBrainstorm({ cwd: f.cwd, runDir: f.runDir, proposal: "preserved draft", runRound: goodRound });
		const original = fs.rename;
		let injected = false;
		const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			const target = String(to);
			if (!injected && ((failure === "proposal" && target === f.proposalPath) ||
				(failure === "manifest" && target === f.manifestPath && JSON.parse(await readFile(String(from), "utf8")).status === "complete"))) {
				injected = true; throw new Error("injected write failure");
			}
			return original(from, to);
		});
		try { await expect(finalizeBrainstorm(f.cwd, f.runDir, "final", "accepted correction")).rejects.toThrow("injected"); }
		finally { spy.mockRestore(); }
		expect(injected).toBe(true);
		expect((await f.manifest()).status).toBe("incomplete");
		expect(await readFile(path.join(f.runDir, "draft-proposal.md"), "utf8")).toBe("preserved draft");
		await expect(finalizeBrainstorm(f.cwd, f.runDir, "retry", "notes")).rejects.toThrow();
	}
});
