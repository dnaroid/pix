import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadSubagentConfig, resolveAgentTaskConfig,
	type SubagentConfig, type SubagentPreset,
} from "../../src/async-subagents/core/config.js";
import { selectAvailableAgentModels, type SubagentModelRegistry } from "../../src/async-subagents/core/model-selection.js";
import { routeSubagentTasks } from "../../src/async-subagents/core/routing.js";
import { nextFallbackModel, rememberSessionModelFallback, resetSessionModelFallbacks, selectSessionModelWithFallback } from "../../src/async-subagents/core/model-fallback.js";

const dirs: string[] = [];
function fixture(value: object = {}): { cwd: string; file: string; config: SubagentConfig } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "model-pool-contract-"));
	dirs.push(cwd);
	const file = path.join(cwd, "config.json");
	fs.writeFileSync(file, JSON.stringify(value));
	return { cwd, file, config: loadSubagentConfig(cwd, { ASYNC_SUBAGENTS_CONFIG: file }) };
}
function writeAgent(cwd: string, name: string, frontmatter: string, body = "Agent body."): void {
	const file = path.join(cwd, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `---\n${frontmatter}\n---\n${body}\n`);
}
function writePresets(cwd: string, presets: object): void {
	const file = path.join(cwd, ".pi", "agents", "presets.jsonc");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(presets));
}
function resolve(config: SubagentConfig, preset?: SubagentPreset, type = "research") {
	return resolveAgentTaskConfig({ id: "worker", task: "Investigate the assigned question", subagentType: type }, config, { preset });
}
const ranked: SubagentConfig = {
	types: { research: { models: ["a/small", "b/medium", "c/large"], thinking: "low", promptAppend: "Evidence only." } },
};

function registeredModel(provider: string, id: string, input: Array<"text" | "image"> = ["text"]): NonNullable<ReturnType<SubagentModelRegistry["find"]>> {
	return {
		provider, id, name: id, api: "openai-completions", baseUrl: "https://example.invalid",
		reasoning: false, input, contextWindow: 8192, maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

afterEach(() => {
	resetSessionModelFallbacks();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.serial("model-pool selection contract", () => {
	test("uses agent.models ordering, not preset.models ordering", () => {
		const selected = resolve(ranked, { models: ["c/large", "b/medium"] });
		expect(selected.task.model).toBe("b/medium");
		expect(selected.fallbackModels).toEqual(["c/large"]);
		expect(selected.task.thinking).toBe("low");
		expect(selected.task.promptAppend).toBe("Evidence only.");
		expect(resolve(ranked).task.model).toBe("a/small");
	});

	test("treats model as an optional leading candidate for old/configured profiles", () => {
		const cfg: SubagentConfig = { types: { research: { model: "a/primary", fallbackModels: ["b/backup", "a/primary", "c/last"] } } };
		const selected = resolve(cfg, { models: ["c/last", "b/backup"] });
		expect(selected.task.model).toBe("b/backup");
		expect(selected.fallbackModels).toEqual(["c/last"]);
	});

	for (const models of [[], ["other/unlisted"]]) {
		test(`rejects an empty intersection (${JSON.stringify(models)}) rather than picking an arbitrary model`, () => {
			expect(() => resolve(ranked, { models })).toThrow(/pool/i);
		});
	}

	test("filters custom parent-dependent candidates by the active pool", () => {
		const cfg: SubagentConfig = { types: { research: {
			fallbackModels: ["a/small"],
			modelByParent: { "parent/*": { model: "expensive/flagship", fallbackModels: ["a/small"] } },
		} } };
		const selected = resolveAgentTaskConfig({ id: "r", task: "Research", subagentType: "research" }, cfg, {
			parentModel: "parent/model", preset: { models: ["a/small"] },
		});
		expect(selected.task.model).toBe("a/small");
		expect(selected.fallbackModels).toEqual([]);
	});

	test("preserves deliberate explicit overrides without automatic fallback", () => {
		for (const options of [{}, { forcedModel: "forced/model" }, { extraArgs: ["--model=cli/model"] }]) {
			const selected = resolveAgentTaskConfig({ id: "r", task: "Research", subagentType: "research", model: "explicit/model" }, ranked, {
				preset: { models: ["a/small"] }, ...options,
			});
			expect(selected.task.model).toBe(options.forcedModel ?? (options.extraArgs ? "cli/model" : "explicit/model"));
			expect(selected.fallbackModels).toEqual([]);
		}
	});

	test("session quota fallback cannot escape the filtered chain through a cached mapping", () => {
		rememberSessionModelFallback("a/small", "c/large");
		const selected = resolve(ranked, { models: ["a/small", "b/medium"] });
		expect(selectSessionModelWithFallback(selected.task.model, selected.fallbackModels)?.model).toBe("b/medium");
		expect(nextFallbackModel("a/small", selected.fallbackModels)).toBe("b/medium");
		expect(nextFallbackModel("b/medium", selected.fallbackModels)).toBeUndefined();
	});

	test("new-install pools do not redefine agents or change worker instructions", () => {
		const { cwd } = fixture();
		const config = loadSubagentConfig(cwd, {});
		expect(Object.keys(config.types).sort()).toEqual(["browser-qa", "implement", "oracle", "research", "verify"]);
		for (const preset of Object.values(config.presets ?? {})) {
			expect(preset.models?.length).toBeGreaterThan(0);
			expect(preset.types).toBeUndefined();
			expect(preset.model).toBeUndefined();
			for (const type of ["research", "implement", "verify", "browser-qa"]) {
				const selected = resolve(config, preset, type);
				expect(preset.models).toContain(selected.task.model);
				expect(selected.task.promptAppend).toBe(config.types[type].promptAppend);
				expect(selected.task.model).not.toMatch(/sol|glm-5\.3$/);
				for (const fallback of selected.fallbackModels) {
					expect(preset.models).toContain(fallback);
					expect(fallback).not.toMatch(/sol|glm-5\.3$/);
				}
			}
		}
	});

	test("oracle uses a strong candidate inside the pool, preferring an independent provider", () => {
		const { config } = fixture();
		const task = { id: "o", task: "Second opinion", subagentType: "oracle" };
		const models = ["openai-codex/gpt-5.6-sol", "zai/glm-5.3"];
		const selected = resolveAgentTaskConfig(task, config, { parentModel: "openai-codex/gpt-5.6-luna", preset: { models } });
		expect(selected.task.model).toBe("zai/glm-5.3");
		const sameProvider = resolveAgentTaskConfig(task, config, { parentModel: "zai/glm-5-turbo", preset: { models: ["zai/glm-5.3"] } });
		expect(sameProvider.task.model).toBe("zai/glm-5.3");
		expect(() => resolveAgentTaskConfig(task, config, { preset: { models: ["zai/glm-5-turbo"] } })).toThrow(/pool/i);
	});

	test("rejects removed builtin role names unless explicitly configured", async () => {
		const { config } = fixture();
		for (const old of ["quick", "scan", "review", "deep", "docs", "frontend", "tests"]) {
			await expect(routeSubagentTasks([{ id: "r", task: "Bounded work", subagentType: old }], config, {}))
				.rejects.toThrow(/Unknown subagentType/);
		}
	});

	test("ignores legacy asyncSubagents type overrides without rewriting the file", () => {
		const input = { types: { scan: { model: "old/scan" }, review: { model: "old/review", promptAppend: "Audit carefully." } } };
		const { config, file } = fixture(input);
		expect(config.types.scan).toBeUndefined();
		expect(config.types.review).toBeUndefined();
		expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(input));
	});

	test("project preset files override bundled pools without redefining agents", () => {
		const { cwd } = fixture();
		writePresets(cwd, { cheap: { description: "project cheap", models: ["zai/glm-5-turbo"] } });
		const config = loadSubagentConfig(cwd, {});
		expect(config.presets?.cheap).toEqual({ description: "project cheap", models: ["zai/glm-5-turbo"] });
		expect(Object.keys(config.types).sort()).toEqual(["browser-qa", "implement", "oracle", "research", "verify"]);
		expect(resolve(config, config.presets!.cheap).task.model).toBe("zai/glm-5-turbo");
	});

	test("a project pool replaces a legacy pool and agent Markdown remains authoritative", () => {
		const { cwd } = fixture();
		const configDir = path.join(cwd, "global");
		fs.mkdirSync(configDir);
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(configDir, "pi-tools-suite.jsonc"), JSON.stringify({ asyncSubagents: {
			presets: { "pool-contract": { models: ["legacy/large"] } },
		} }));
		writeAgent(cwd, "pool-worker", "models: [a/small, b/medium]\nthinking: low", "Pool worker.");
		writePresets(cwd, { "pool-contract": { models: ["a/small", "b/medium"] } });
		const config = loadSubagentConfig(cwd, { PI_CONFIG_DIR: configDir });
		const pool = config.presets!["pool-contract"];
		expect(pool.model).toBeUndefined();
		expect(pool.types).toBeUndefined();
		const selected = resolve(config, pool, "pool-worker");
		expect(selected.task.model).toBe("a/small");
		expect(selected.task.thinking).toBe("low");
	});

	test("project preset files can add a custom pool", () => {
		const { cwd } = fixture();
		writeAgent(cwd, "pool-worker", "models: [custom/a, custom/b]", "Pool worker.");
		writePresets(cwd, { custom: { description: "custom pool", models: ["custom/b"] } });
		const config = loadSubagentConfig(cwd, {});
		expect(config.presets?.custom?.description).toBe("custom pool");
		expect(resolve(config, config.presets!.custom, "pool-worker").task.model).toBe("custom/b");
	});

	test("a model pool filters an agent without changing its thinking", () => {
		const { cwd } = fixture();
		writeAgent(cwd, "pool-worker", "models: [a/small, b/medium]\nthinking: low", "Pool worker.");
		writePresets(cwd, { migrated: { models: ["a/small"] } });
		const config = loadSubagentConfig(cwd, {});
		const selected = resolve(config, config.presets!.migrated, "pool-worker");
		expect(selected.task.model).toBe("a/small");
		expect(selected.task.thinking).toBe("low");
		expect(selected.fallbackModels).toEqual([]);
	});

	test("an explicit empty agent.models does not revive inherited candidates or parent escalation", () => {
		const { cwd } = fixture();
		writeAgent(cwd, "research", "models: []", "Research.");
		const config = loadSubagentConfig(cwd, {});
		expect(() => resolve(config)).toThrow(/No model candidates/);
	});

	test("legacy model fields in an agent file still replace the shipped agent.models primary", () => {
		const { cwd } = fixture();
		writeAgent(cwd, "research", "model: custom/research\nfallbackModels: []", "Research.");
		const config = loadSubagentConfig(cwd, {});
		const selected = resolve(config);
		expect(selected.task.model).toBe("custom/research");
		expect(selected.fallbackModels).toEqual([]);
	});

	test("keeps images on confirmed image models and excludes blind quota fallbacks", async () => {
		const cfg: SubagentConfig = { types: { implement: { fallbackModels: ["vision/primary", "blind/backup", "vision/backup"] } } };
		const resolved = resolveAgentTaskConfig({ id: "ui", task: "Implement the mockup", imagePaths: ["mock.png"], subagentType: "implement" }, cfg, {
			preset: { models: ["vision/primary", "blind/backup", "vision/backup"] },
		});
		const registry: SubagentModelRegistry = { find: (provider, id) => registeredModel(provider, id, provider === "vision" ? ["text", "image"] : ["text"]) };
		const selected = await selectAvailableAgentModels(resolved, cfg, registry);
		expect(selected.task.model).toBe("vision/primary");
		expect(selected.fallbackModels).toEqual(["vision/backup"]);
		await expect(selectAvailableAgentModels(resolved, cfg)).rejects.toThrow(/image support/i);
	});

	test("skips unavailable runtime candidates but cannot invent a model outside the pool", async () => {
		const resolved = resolve(ranked, { models: ["b/medium", "c/large"] });
		const registry: SubagentModelRegistry = {
			find: (provider, id) => registeredModel(provider, id),
			getApiKeyAndHeaders: async (model) => ({ ok: model.provider !== "b" }),
		};
		const selected = await selectAvailableAgentModels(resolved, ranked, registry);
		expect(selected.task.model).toBe("c/large");
		expect(selected.fallbackModels).toEqual([]);
		const limited = resolve(ranked, { models: ["b/medium"] });
		await expect(selectAvailableAgentModels(limited, ranked, registry)).rejects.toThrow(/No configured candidate/);
	});

	test("auth failure details are not copied into the model-selection error", async () => {
		const registry: SubagentModelRegistry = {
			find: (provider, id) => registeredModel(provider, id),
			getApiKeyAndHeaders: async () => { throw new Error("SYNTHETIC_SECRET_DO_NOT_PRINT"); },
		};
		try {
			await selectAvailableAgentModels(resolve(ranked), ranked, registry);
			throw new Error("Expected selection failure");
		} catch (error) {
			expect(String(error)).toContain("No configured candidate");
			expect(String(error)).not.toContain("SYNTHETIC_SECRET_DO_NOT_PRINT");
		}
	});
});
