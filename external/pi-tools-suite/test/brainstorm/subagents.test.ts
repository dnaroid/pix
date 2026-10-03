import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCouncilRunner, preflightCouncil } from "../../src/brainstorm/subagents.js";
import { COUNCIL_RESEARCH_TOOLS } from "../../src/brainstorm/research-tools.js";

let root: string;
const envKeys = ["HOME", "PI_CONFIG_DIR", "ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL", "PI_SUBAGENTS_FORCE_CURRENT_MODEL"];
let oldEnv: Array<string | undefined>;
beforeEach(async () => {
	oldEnv = envKeys.map((key) => process.env[key]);
	for (const key of envKeys) delete process.env[key];
	root = await mkdtemp(join(tmpdir(), "brainstorm-adapter-"));
	process.env.HOME = root;
});
afterEach(async () => {
	envKeys.forEach((key, index) => { if (oldEnv[index] === undefined) delete process.env[key]; else process.env[key] = oldEnv[index]; });
	await rm(root, { recursive: true, force: true });
});

const config = { models: ["one/a", "two/b"], thinking: "high", timeoutSeconds: 30 };
const tasks = config.models.map((model, i) => ({ id: `member-${i}`, model, task: "Discuss only", thinking: "high", timeoutSeconds: 30 }));

function fixture(options: { onWait?: () => void; failWait?: boolean; failSpawn?: boolean; model?: string; truncated?: boolean; text?: string } = {}) {
	const calls: any[] = [];
	const ctx: any = {
		cwd: root, tools: [{ name: "subagents" }],
		executeTool: async (_name: string, args: any) => {
			calls.push(args);
			if (args.action === "spawn") {
				for (const task of args.tasks) {
					await mkdir(join(args.runDir, task.id), { recursive: true });
					await writeFile(join(args.runDir, task.id, "prompt.md"), task.task);
					await writeFile(join(args.runDir, task.id, "result.md"), options.text ?? "A proposal with dissent");
				}
				if (options.failSpawn) return { isError: true, result: { content: [{ type: "text", text: "Unavailable model" }], details: {} } };
			}
			if (args.action === "wait") options.onWait?.();
			const details = args.action === "wait" ? { agents: tasks.map((task) => ({ id: task.id, status: options.failWait ? "failed" : "done" })) }
				: args.action === "result" ? { state: { status: "done" }, structured: { model: options.model ?? tasks.find((task) => task.id === args.agentId)!.model, resultTruncated: options.truncated } } : {};
			return { isError: false, result: { content: [], details } };
		},
	};
	return { ctx, calls, run: (signal?: AbortSignal) => createCouncilRunner(ctx)({ round: 5, tasks, signal }) };
}

test("uses exact configured models and read-only research with no extra runner", async () => {
	const f = fixture();
	const reports = await f.run();
	expect(reports.map((report) => report.model)).toEqual(config.models);
	expect(reports[0].text).toContain("A proposal with dissent");
	expect(f.calls[0].tasks.map((task: any) => ({ model: task.model, tools: task.tools, role: task.subagentType, prompt: task.promptOverride }))).toEqual(config.models.map((model) => ({ model, tools: ["read"], role: "research", prompt: "{task}" })));
	for (const task of f.calls[0].tasks) {
		expect(task.extraArgs).toEqual(["--extension", expect.stringContaining(join("brainstorm", "research-extension.ts")), "--tools", COUNCIL_RESEARCH_TOOLS.join(",")]);
		expect(await readFile(task.extraArgs[1], "utf8")).toContain("function councilResearch");
	}
	expect(f.calls.map((call) => call.action)).toEqual(["spawn", "wait", "result", "result"]);
});

test("rejects absent tools and forced-current-model before launching", () => {
	expect(() => preflightCouncil({ cwd: root, tools: [] })).toThrow("active async-subagents");
	process.env.ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL = "1";
	expect(() => preflightCouncil(fixture().ctx)).toThrow("exact configured models");
});

test("cancel after an awaited nested call stops the owned queued tasks, without another nested call", async () => {
	const controller = new AbortController();
	const f = fixture({ onWait: () => controller.abort() });
	await expect(f.run(controller.signal)).rejects.toThrow("cancelled");
	expect(f.calls.map((call) => call.action)).toEqual(["spawn", "wait"]);
	for (const task of tasks) expect(await readFile(join(f.calls[0].runDir, task.id, "exit_code"), "utf8")).toContain("stopped");
});

test("pre-aborted invocation never launches", async () => {
	const f = fixture();
	await expect(f.run(AbortSignal.abort())).rejects.toThrow("cancelled");
	expect(f.calls).toHaveLength(0);
});

test("failed rounds, nested errors, substituted models, truncation and empty/oversize reports are rejected", async () => {
	for (const options of [{ failWait: true }, { failSpawn: true }, { model: "other/model" }, { truncated: true }, { text: " " }, { text: "x".repeat(65537) }]) {
		const f = fixture(options);
		await expect(f.run()).rejects.toThrow();
		for (const task of tasks) expect(await readFile(join(f.calls[0].runDir, task.id, "exit_code"), "utf8")).toContain("stopped");
	}
});
