import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configForRun, defaultBrainstormConfig, parseRunModels, thinkingForModel } from "../../src/brainstorm/config.js";
import { parseCouncilCommand } from "../../src/brainstorm/modes.js";
import { runBrainstorm, type RunRound, type RunRoundInput } from "../../src/brainstorm/workflow.js";
import { reviewBrainstorm } from "../../src/brainstorm/continuation.js";
import register from "../../src/brainstorm/index.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const roster = ["cheap/one:off", "cheap/two:low"];

test("leading mode/models options accept either order and equals, leaving the topic opaque", () => {
	for (const flags of [
		`--mode audit --models ${roster.join(",")}`,
		`--models=${roster.join(",")} --mode=audit`,
	]) {
		expect(parseCouncilCommand(`${flags} Тема --models stays literal`)).toEqual({ mode: "audit", models: roster, topic: "Тема --models stays literal" });
	}
	expect(parseCouncilCommand(`--models ${roster.join(",")} Topic`)).toEqual({ mode: "auto", models: roster, topic: "Topic" });
	expect(parseCouncilCommand(`--models ${roster.join(",")}`)).toEqual({ mode: "auto", models: roster, topic: "" });
	for (const args of ["--models", "--models= Topic", `--models ${roster.join(",")} --models ${roster.join(",")} Topic`, `--models ${roster.join(",")} --unknown x Topic`]) {
		expect(() => parseCouncilCommand(args)).toThrow();
	}
});

test("run models validate effort, exact refs, distinct model identities and roster bounds", () => {
	for (const value of [null, "cheap/one:low,cheap/two:low", [], ["cheap/one:off"],
		["cheap/one:off", "cheap/one:low"], ["cheap/one", "cheap/two:low"],
		["cheap/*:off", "cheap/two:low"], ["one:low", "cheap/two:low"],
		["cheap/one:invalid", "cheap/two:low"], ["cheap/one:", "cheap/two:low"],
		[" cheap/one:off", "cheap/two:low"], ["cheap/one:off ", "cheap/two:low"],
		[null, "cheap/two:low"], [...roster, ""], Array.from({ length: 7 }, (_, i) => `p/m${i}:low`)]) {
		expect(() => parseRunModels(value)).toThrow();
	}
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		expect(parseRunModels([`p/namespace/model:tag:${level}`, "p/other:low"])).toEqual({ models: ["p/namespace/model:tag", "p/other"], thinkingOverrides: { "p/namespace/model:tag": level, "p/other": "low" } });
	}
});

test("run config is an isolated copy; exact requested efforts beat all inherited overrides", () => {
	const base = defaultBrainstormConfig();
	base.thinkingOverrides = { "cheap/one": "max", two: "high" };
	const before = structuredClone(base);
	const config = configForRun(base, roster);
	expect(config.models).toEqual(["cheap/one", "cheap/two"]);
	expect(config.modelsExplicit).toBe(true);
	expect(config.models.map((model) => thinkingForModel(config, model))).toEqual(["off", "low"]);
	expect(config.timeoutSeconds).toBe(base.timeoutSeconds);
	expect(config.outputDir).toBe(base.outputDir);
	expect(base).toEqual(before);
	const unchanged = configForRun(base);
	expect(unchanged).toEqual(base);
	expect(unchanged.models).not.toBe(base.models);
	expect(unchanged.thinkingOverrides).not.toBe(base.thinkingOverrides);
	expect(() => configForRun({ ...base, quorum: 3 }, roster)).toThrow("quorum cannot exceed");
});

test("run-only roster and effort survive all five rounds and caller config changes in both execution modes", async () => {
	for (const execution of [undefined, "desktop-sessions"] as const) {
		for (const mode of ["brainstorm", "audit"] as const) {
			const cwd = await mkdtemp(path.join(tmpdir(), "council-run-models-")); dirs.push(cwd);
			const calls: RunRoundInput[] = [];
			const runner: RunRound = Object.assign(async (input: RunRoundInput) => {
				calls.push(input);
				return input.tasks.map(({ id, model }) => ({ id, model, text: "A bounded independent answer." }));
			}, execution ? { execution } : {});
			const config = configForRun(defaultBrainstormConfig(), roster);
			const result = await runBrainstorm({ cwd, topic: "Topic", brief: "Brief", mode, config, runRound: runner });
			expect(result.status).toBe("awaiting_synthesis");
			config.models = ["other/one", "other/two"];
			config.thinkingOverrides["cheap/one"] = "max";
			const reviewed = await reviewBrainstorm({ cwd, runDir: result.runDir, proposal: "Draft", runRound: runner });
			expect(reviewed.status).toBe("awaiting_finalization");
			expect(calls.map(({ round }) => round)).toEqual([1, 2, 3, 4, 5]);
			for (const call of calls) expect(call.tasks.map(({ model, thinking }) => ({ model, thinking }))).toEqual([
				{ model: "cheap/one", thinking: "off" }, { model: "cheap/two", thinking: "low" },
			]);
			const manifest = JSON.parse(await readFile(path.join(result.runDir, "manifest.json"), "utf8"));
			expect(manifest.config.models).toEqual(["cheap/one", "cheap/two"]);
			expect(manifest.config.thinkingOverrides["cheap/one"]).toBe("off");
			expect(manifest.execution).toBe(execution);
		}
	}
});

test("tool run forwards the override to the adapter and review keeps it after settings change", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "council-tool-models-")); dirs.push(cwd);
	const keys = ["HOME", "PI_CONFIG_DIR", "PIX_BRAINSTORM_HOST_URL", "PIX_BRAINSTORM_HOST_TOKEN", "ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL", "PI_SUBAGENTS_FORCE_CURRENT_MODEL"];
	const saved = keys.map((key) => process.env[key]);
	try {
		for (const key of keys) delete process.env[key];
		process.env.HOME = cwd;
		await mkdir(path.join(cwd, ".pi"));
		const settingsPath = path.join(cwd, ".pi", "pi-tools-suite.jsonc");
		const settings = JSON.stringify({ brainstorm: { models: ["default/a", "default/b"], thinking: "max" } });
		await writeFile(settingsPath, settings);
		let tool: any;
		register({ registerCommand() {}, registerTool(value: any) { tool = value; } } as any);
		const batches: any[][] = [];
		let current: any[] = [];
		const ctx = {
			cwd, tools: [{ name: "subagents" }], ui: { notify() {} },
			executeTool: async (_name: string, args: any) => {
				let details = {};
				if (args.action === "spawn") {
					current = args.tasks; batches.push(current);
					for (const task of current) {
						const dir = path.join(args.runDir, task.id);
						await mkdir(dir, { recursive: true });
						await writeFile(path.join(dir, "result.md"), "A deterministic response, no paid model.");
					}
				} else if (args.action === "wait") details = { agents: current.map(({ id }) => ({ id, status: "done" })) };
				else if (args.action === "result") details = { state: { status: "done" }, structured: { model: current.find(({ id }) => id === args.agentId).model } };
				else throw new Error(`Unexpected nested action: ${args.action}`);
				return { isError: false, result: { content: [], details } };
			},
		};
		const result = await tool.execute("run", { action: "run", mode: "brainstorm", topic: "Topic", brief: "Brief", models: roster }, undefined, undefined, ctx);
		expect(result.details.status).toBe("awaiting_synthesis");
		expect(await readFile(settingsPath, "utf8")).toBe(settings);
		await writeFile(settingsPath, JSON.stringify({ brainstorm: { models: ["changed/a", "changed/b"], thinking: "high" } }));
		const review = await tool.execute("review", { action: "review", runDir: result.details.runDir, proposal: "Draft" }, undefined, undefined, ctx);
		expect(review.details.status).toBe("awaiting_finalization");
		expect(batches).toHaveLength(5);
		for (const batch of batches) expect(batch.map(({ model, thinking }) => ({ model, thinking }))).toEqual([
			{ model: "cheap/one", thinking: "off" }, { model: "cheap/two", thinking: "low" },
		]);
	} finally {
		keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
	}
});
