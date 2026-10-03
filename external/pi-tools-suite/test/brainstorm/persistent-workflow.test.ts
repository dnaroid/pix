import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBrainstorm, type RunRound, type RunRoundInput } from "../../src/brainstorm/workflow.js";
import { finalizeBrainstormRun, reviewBrainstorm } from "../../src/brainstorm/continuation.js";
import { createBrainstormRunner } from "../../src/brainstorm/desktop-sessions.js";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function start() {
	const cwd = await mkdtemp(path.join(tmpdir(), "persistent-council-")); dirs.push(cwd);
	const calls: RunRoundInput[] = [];
	const terminal: string[] = [];
	const runner: RunRound = Object.assign(async (input: RunRoundInput) => {
		calls.push(input);
		return input.tasks.map((task, i) => ({ id: task.id, model: task.model, text: `ANSWER_R${input.round}_P${i + 1}` }));
	}, { execution: "desktop-sessions" as const, onTerminal: async (_id: string, status: string) => { terminal.push(status); } });
	const result = await runBrainstorm({ cwd, topic: "Storage", brief: "UNIQUE ORIGINAL BRIEF", config: { models: ["v/a", "v/b"], thinking: "high", timeoutSeconds: 30 }, runRound: runner });
	return { cwd, calls, terminal, runner, result };
}

test("one stable run identity; Desktop prompts append only new peer answers through round five", async () => {
	const { cwd, calls, runner, result, terminal } = await start();
	expect(result.status).toBe("awaiting_synthesis");
	await reviewBrainstorm({ cwd, runDir: result.runDir, proposal: "PARENT DRAFT", runRound: runner });
	expect(calls.map((call) => call.round)).toEqual([1, 2, 3, 4, 5]);
	expect(new Set(calls.map((call) => call.runId)).size).toBe(1);
	for (const call of calls) {
		expect(call.runDir).toBe(result.runDir);
		expect(call.execution).toBe("desktop-sessions");
		const prompt = call.tasks[0]!.task;
		if (call.round === 1) { expect(prompt).toContain("UNIQUE ORIGINAL BRIEF"); expect(prompt).not.toContain("ANSWER_"); }
		else {
			expect(prompt).not.toContain("UNIQUE ORIGINAL BRIEF");
			expect(prompt).toContain(`ANSWER_R${call.round - 1}_P2`);
			expect(prompt).not.toContain(`ANSWER_R${call.round - 1}_P1`);
			if (call.round > 2) expect(prompt).not.toContain(`ANSWER_R${call.round - 2}_`);
		}
	}
	expect(calls[4]!.tasks[0]!.task).toContain("PARENT DRAFT");
	const manifest = JSON.parse(await readFile(path.join(result.runDir, "manifest.json"), "utf8"));
	expect(manifest.execution).toBe("desktop-sessions");
	expect(Object.keys(manifest.rounds)).toHaveLength(5);
	await finalizeBrainstormRun(cwd, result.runDir, "FINAL", "All objections addressed", { onTerminal: runner.onTerminal });
	expect(terminal).toEqual(["complete"]);
});

test("missing host is rejected before draft/state mutation, never silently replaced with fresh workers", async () => {
	const { cwd, result } = await start();
	const manifestPath = path.join(result.runDir, "manifest.json");
	const before = await readFile(manifestPath, "utf8");
	const runner = createBrainstormRunner({ cwd, tools: [], ui: { notify() {} } } as unknown as ExtensionToolContext);
	await expect(reviewBrainstorm({ cwd, runDir: result.runDir, proposal: "DRAFT", runRound: runner })).rejects.toThrow("original Desktop session host");
	expect(await readFile(manifestPath, "utf8")).toBe(before);
	await expect(access(path.join(result.runDir, "draft-proposal.md"))).rejects.toThrow();
	await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(before), execution: "unknown" }));
	await expect(reviewBrainstorm({ cwd, runDir: result.runDir, proposal: "DRAFT", runRound: runner })).rejects.toThrow("Unknown council execution");
});

test("failed review releases ownership and preserves incomplete protocol", async () => {
	const { cwd, result, runner, terminal } = await start();
	const fail: RunRound = Object.assign(async () => { throw new Error("host disconnected"); }, { onTerminal: runner.onTerminal });
	const reviewed = await reviewBrainstorm({ cwd, runDir: result.runDir, proposal: "DRAFT", runRound: fail });
	expect(reviewed.status).toBe("incomplete");
	expect(terminal).toEqual(["incomplete"]);
});
