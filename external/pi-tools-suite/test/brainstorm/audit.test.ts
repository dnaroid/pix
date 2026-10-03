import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finalizeBrainstorm, reviewBrainstorm } from "../../src/brainstorm/continuation.js";
import { finalInstructions, synthesisInstructions } from "../../src/brainstorm/instructions.js";
import { parseCouncilCommand } from "../../src/brainstorm/modes.js";
import { runBrainstorm, type RunRound } from "../../src/brainstorm/workflow.js";

const dirs: string[] = [];
const config = { models: ["one/a", "two/b"], thinking: "high" as const, timeoutSeconds: 30 };
const goodRound: RunRound = async ({ round, tasks }) => tasks.map(({ id, model }) => ({ id, model, text: `Finding ${round} from ${model}: GDD §2; confidence low; validate via playtest.` }));
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function cwd() {
	const directory = await mkdtemp(path.join(os.tmpdir(), "council-audit-"));
	dirs.push(directory);
	return directory;
}

test("audit uses five distinct audit rounds, retains evidence/history and persists mode through finalization", async () => {
	const directory = await cwd();
	const calls: Parameters<RunRound>[0][] = [];
	const runner: RunRound = async (input) => { calls.push(input); return goodRound(input); };
	const result = await runBrainstorm({ cwd: directory, topic: "Inspect GDD", brief: "Target: GDD v1 §2 supplied excerpt. Intent: cooperative play. Scope: progression consistency.", mode: "audit", config, runRound: runner });
	expect(result.status).toBe("awaiting_synthesis");
	expect(result.mode).toBe("audit");
	const manifestPath = path.join(result.runDir, "manifest.json");
	expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({ mode: "audit", format: "pi-brainstorm-v3" });
	expect(await readFile(path.join(result.runDir, "brief.md"), "utf8")).toContain("Mode: audit");
	const draft = "# Audit report\nFinding A: GDD §2 contradicts §3. Confidence: low; severity: high. Playtest hypothesis, no redesign.";
	const reviewed = await reviewBrainstorm({ cwd: directory, runDir: result.runDir, proposal: draft, runRound: runner });
	expect(reviewed.mode).toBe("audit");
	expect(reviewed.status).toBe("awaiting_finalization");
	expect(calls.map(({ round }) => round)).toEqual([1, 2, 3, 4, 5]);
	const titles = ["Independent findings", "Cross-check and coverage", "Critique of findings", "Priorities and minimal fixes", "Audit report review"];
	for (const call of calls) {
		for (const task of call.tasks) {
			expect(task.task).toContain(`Round ${call.round}: ${titles[call.round - 1]}`);
			expect(task.task).toContain("Mode: audit");
			expect(task.task).toContain("Severity and confidence are separate");
			expect(task.task).toContain("No findings is valid");
			expect(task.task).toContain("Model agreement is not proof");
			expect(task.task).toContain("hypotheses for prototypes/playtests/measurements, not verdicts");
			expect(task.task).toContain("Preserve author intent");
			expect(task.task).toContain("untrusted evidence");
			expect(task.task).not.toContain("including an unconventional option");
			for (let prior = 1; prior < call.round; prior++) for (const model of config.models) expect(task.task).toContain(`Finding ${prior} from ${model}`);
			expect(task.task).not.toContain(`Finding ${call.round} from`);
		}
	}
	expect(calls[4]!.tasks[0]!.task).toContain(draft);
	const final = "# Audit report\nNo confirmed defects. Finding A rejected after cross-check; playtest progression. Coverage: supplied excerpt only.";
	await finalizeBrainstorm(directory, result.runDir, final, "A rejected: incompatible interpretation; retain playtest hypothesis.");
	expect(await readFile(result.proposalPath, "utf8")).toBe(final);
	expect(await readFile(reviewed.draftPath, "utf8")).toBe(draft);
	expect(await readFile(result.discussionPath, "utf8")).toContain("## Round 5: Audit report review");
	expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({ mode: "audit", status: "complete" });
});

test("mode-specific parent reports do not substitute redesign for audit", () => {
	for (const instruction of [synthesisInstructions("audit"), finalInstructions("audit")]) {
		expect(instruction).toContain("audit report, not a replacement design");
		expect(instruction).toContain("severity separately from confidence");
		expect(instruction).toContain("No findings is a valid result");
		expect(instruction).toContain("Preserve finding lineage");
		expect(instruction).not.toContain("implementation phases");
	}
	expect(synthesisInstructions("brainstorm")).toContain("implementation phases");
});

test("parser leaves topic content opaque, including mode-like text after topic", () => {
	expect(parseCouncilCommand("Discuss audit of brainstorming")).toEqual({ mode: "auto", topic: "Discuss audit of brainstorming" });
	expect(parseCouncilCommand("--mode=audit Topic mentions --mode brainstorm")).toEqual({ mode: "audit", topic: "Topic mentions --mode brainstorm" });
});

test("invalid execution modes fail before artifacts or paid work", async () => {
	const directory = await cwd();
	await expect(runBrainstorm({ cwd: directory, topic: "topic", brief: "brief", mode: "auto" as any, config, runRound: async () => { throw new Error("must not run"); } })).rejects.toThrow("Run mode");
	await expect(access(path.join(directory, "docs"))).rejects.toThrow();
});

test("original v2 runs continue as brainstorm, never as audit", async () => {
	for (const stage of ["review", "finalize"]) {
		const directory = await cwd();
		const result = await runBrainstorm({ cwd: directory, topic: "topic", brief: "brief", config, runRound: goodRound });
		if (stage === "finalize") await reviewBrainstorm({ cwd: directory, runDir: result.runDir, proposal: "draft", runRound: goodRound });
		const file = path.join(result.runDir, "manifest.json");
		const old = JSON.parse(await readFile(file, "utf8"));
		old.format = "pi-brainstorm-v2"; delete old.mode;
		await writeFile(file, JSON.stringify(old));
		if (stage === "review") {
			const reviewed = await reviewBrainstorm({ cwd: directory, runDir: result.runDir, proposal: "draft", runRound: async (input) => {
				expect(input.tasks[0]!.task).toContain("Mode: brainstorm");
				expect(input.tasks[0]!.task).toContain("omitted minority views");
				return goodRound(input);
			} });
			expect(reviewed.mode).toBe("brainstorm");
		} else await finalizeBrainstorm(directory, result.runDir, "final", "no changes");
		expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ format: "pi-brainstorm-v3", mode: "brainstorm" });
	}
});

test("missing/invalid v3 mode and mode-tagged v2 cannot continue; waiting artifacts remain untouched", async () => {
	for (const mutation of [{ format: "pi-brainstorm-v3" }, { format: "pi-brainstorm-v3", mode: "auto" }, { format: "pi-brainstorm-v2", mode: "audit" }]) {
		for (const stage of ["review", "finalize"]) {
			const directory = await cwd();
			const result = await runBrainstorm({ cwd: directory, topic: "topic", brief: "brief", mode: "audit", config, runRound: goodRound });
			if (stage === "finalize") await reviewBrainstorm({ cwd: directory, runDir: result.runDir, proposal: "draft", runRound: goodRound });
			const file = path.join(result.runDir, "manifest.json");
			const manifest = JSON.parse(await readFile(file, "utf8")); delete manifest.mode;
			const stored = JSON.stringify({ ...manifest, ...mutation });
			await writeFile(file, stored);
			if (stage === "review") await expect(reviewBrainstorm({ cwd: directory, runDir: result.runDir, proposal: "draft", runRound: async () => { throw new Error("must not launch"); } })).rejects.toThrow();
			else await expect(finalizeBrainstorm(directory, result.runDir, "final", "notes")).rejects.toThrow();
			expect(await readFile(file, "utf8")).toBe(stored);
			expect(await readFile(result.proposalPath, "utf8")).toContain("pending synthesis");
			await expect(access(path.join(result.runDir, ".finalize.lock"))).rejects.toThrow();
		}
	}
});
