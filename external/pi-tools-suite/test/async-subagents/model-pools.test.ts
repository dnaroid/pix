import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	loadSubagentConfig,
	resolveAgentTaskConfig,
	type SubagentConfig,
} from "../../src/async-subagents/core/config.js";
import { buildSubagentCatalogPrompt } from "../../src/async-subagents/core/agent-catalog.js";
import { routeSubagentTasks } from "../../src/async-subagents/core/routing.js";
import { selectAvailableAgentModels } from "../../src/async-subagents/core/model-selection.js";
import { rememberSessionModelFallback, resetSessionModelFallbacks, selectSessionModelWithFallback } from "../../src/async-subagents/core/model-fallback.js";

const dirs: string[] = [];
function temp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-model-pools-"));
	dirs.push(dir);
	return dir;
}
function agentConfig(name: string, frontmatter: string, body = "Agent body."): SubagentConfig {
	const cwd = temp();
	const file = path.join(cwd, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `---\n${frontmatter}\n---\n${body}\n`);
	return loadSubagentConfig(cwd, {});
}
function task(subagentType = "research") {
	return { id: "worker", task: "Perform the bounded task", subagentType };
}
function poolConfig(): SubagentConfig {
	return {
		types: {
			research: { models: ["cheap/text", "fast/vision", "backup/vision"] },
			oracle: { models: ["strong/a", "independent/b"] },
			"browser-qa": { models: ["cheap/text", "fast/vision", "backup/vision"] },
		},
	};
}
function registry() {
	const find = mock((provider: string, id: string) => ({
		provider, id, input: id === "text" ? ["text"] : ["text", "image"],
	}) as unknown as Model<Api>);
	const auth = mock(async (_model: Model<Api>) => ({ ok: true }));
	return { find, getApiKeyAndHeaders: auth, complete: mock(() => { throw new Error("No LLM model selection"); }) };
}

afterEach(() => {
	resetSessionModelFallbacks();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ordered agent models and preset pools", () => {
	test("ships six Markdown modes and pool-only presets from a single defaults source", () => {
		const cfg = loadSubagentConfig(temp(), {});
		expect(Object.keys(cfg.types).sort()).toEqual(["browser-qa", "frontier-review", "implement", "oracle", "research", "verify"]);
		for (const [name, profile] of Object.entries(cfg.types)) {
			expect(profile.models?.length).toBeGreaterThan(0);
			expect(profile.model).toBeUndefined();
			expect(profile.fallbackModels).toBeUndefined();
			expect(profile.modelByParent).toBeUndefined();
			if (name !== "oracle" && name !== "frontier-review") expect(profile.models?.join(",")).not.toContain("gpt-5.6-sol");
		}
		for (const preset of Object.values(cfg.presets ?? {})) {
			expect(preset.models?.length).toBeGreaterThan(0);
			expect(preset.types).toBeUndefined();
			for (const role of Object.keys(cfg.types)) {
				const resolved = resolveAgentTaskConfig(task(role), cfg, { preset, parentModel: "openai-codex/gpt-5.6-luna" });
				expect(preset.models).toContain(resolved.task.model);
				expect(resolved.fallbackModels.every((model) => preset.models!.includes(model))).toBe(true);
			}
		}
	});

	test("intersects without reordering or appending pool-only models", () => {
		const result = resolveAgentTaskConfig(task(), poolConfig(), {
			preset: { models: ["unused/expensive", "backup/vision", "fast/vision"] },
		});
		expect(result.task.model).toBe("fast/vision");
		expect(result.fallbackModels).toEqual(["backup/vision"]);
	});

	test("no preset keeps the complete agent order", () => {
		const result = resolveAgentTaskConfig(task(), poolConfig());
		expect(result.task.model).toBe("cheap/text");
		expect(result.fallbackModels).toEqual(["fast/vision", "backup/vision"]);
	});

	for (const models of [[], ["outside/only"]]) {
		test(`fails on an empty intersection with ${JSON.stringify(models)}`, () => {
			expect(() => resolveAgentTaskConfig(task(), poolConfig(), { preset: { models } })).toThrow(/models pool/);
		});
	}

	test("empty candidate lists do not inherit the parent, even without a preset", () => {
		const cfg = agentConfig("research", "models: []");
		expect(cfg.types.research.models).toEqual([]);
		expect(() => resolveAgentTaskConfig(task(), cfg, { parentModel: "expensive/parent" })).toThrow(/No model candidates/);
	});

	test("preserves explicit task, CLI and forced model overrides with no implicit fallbacks", () => {
		const cfg = poolConfig();
		const options = { preset: { models: [] } };
		const explicit = resolveAgentTaskConfig({ ...task(), model: "manual/model" }, cfg, options);
		expect(explicit.task.model).toBe("manual/model");
		expect(explicit.fallbackModels).toEqual([]);
		const cli = resolveAgentTaskConfig(task(), cfg, { ...options, extraArgs: ["--model=cli/model"] });
		expect(cli.task.model).toBe("cli/model");
		expect(cli.fallbackModels).toEqual([]);
		const forced = resolveAgentTaskConfig({ ...task(), model: "manual/model", extraArgs: ["-m", "cli/model"] }, cfg,
			{ ...options, forcedModel: "parent/forced" });
		expect(forced.task.model).toBe("parent/forced");
		expect(forced.extraArgs).toEqual([]);
		expect(forced.fallbackModels).toEqual([]);
	});

	test("pool presets do not execute stale legacy role or thinking overrides", () => {
		const result = resolveAgentTaskConfig(task(), poolConfig(), { preset: {
			models: ["cheap/text"], model: "expensive/default", thinking: "max",
			types: { research: { model: "expensive/role", extraArgs: ["--model", "expensive/cli"] } },
		} });
		expect(result.task.model).toBe("cheap/text");
		expect(result.task.thinking).toBeUndefined();
		expect(result.extraArgs).toEqual([]);
	});

	test("oracle prefers a different provider without escaping the pool", () => {
		const cfg = poolConfig();
		const independent = resolveAgentTaskConfig(task("oracle"), cfg, { parentModel: "strong/parent" });
		expect(independent.task.model).toBe("independent/b");
		expect(independent.fallbackModels).toEqual(["strong/a"]);
		const restricted = resolveAgentTaskConfig(task("oracle"), cfg,
			{ parentModel: "strong/parent", preset: { models: ["strong/a"] } });
		expect(restricted.task.model).toBe("strong/a");
		expect(restricted.fallbackModels).toEqual([]);
		expect(() => resolveAgentTaskConfig(task("oracle"), cfg, { preset: { models: ["cheap/text"] } })).toThrow(/models pool/);
	});

	test("validates models and deduplicates candidates in stable order", () => {
		const cfg = agentConfig("custom", 'models: [" a/first ", b/second, a/first]');
		expect(cfg.types.custom.models).toEqual(["a/first", "b/second"]);
		expect(agentConfig("custom", "models: a/first").types.custom.models).toEqual(["a/first"]);
		for (const modelsSource of ["[unqualified]", "[a/]", "[a/*]", "[null]", "[1]"]) {
			expect(() => agentConfig("custom", `models: ${modelsSource}`)).toThrow(/models must be an array/);
		}
		for (const models of ["a/first", ["unqualified"], ["a/"], ["a/*"], [null], [1]]) {
			const cwd = temp();
			const file = path.join(cwd, ".pi", "agents", "presets.jsonc");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify({ custom: { models } }));
			expect(() => loadSubagentConfig(cwd, {})).toThrow(/models must be an array/);
		}
	});

	test("Markdown models ignore old JSONC type fields and retain bundled unrelated fields", () => {
		const cwd = temp();
		const dir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "pi-tools-suite.jsonc"), JSON.stringify({ asyncSubagents: {
			types: { research: { model: "old/main", fallbackModels: ["old/backup"], thinking: "high",
				modelByParent: { "parent/*": "old/escalation" } } },
		} }));
		fs.writeFileSync(path.join(dir, "research.md"), "---\nmodels:\n  - new/first\n  - new/second\n---\nRead only.\n");
		const cfg = loadSubagentConfig(cwd, {});
		expect(cfg.types.research.models).toEqual(["new/first", "new/second"]);
		expect(cfg.types.research.thinking).toBe("low");
		expect(cfg.types.research.model).toBeUndefined();
		expect(cfg.types.research.modelByParent).toBeUndefined();
		expect(resolveAgentTaskConfig(task(), cfg, { parentModel: "parent/model" }).task.model).toBe("new/first");
		fs.writeFileSync(path.join(dir, "research.md"), "---\nmodels: new/third, new/second\n---\nRead only.\n");
		expect(loadSubagentConfig(cwd, {}).types.research.models).toEqual(["new/third", "new/second"]);
	});

	test("new models wins over legacy fields in one Markdown profile", () => {
		const cfg = agentConfig("research", `models: [new/only]
model: old/main
fallbackModels: [old/backup]
modelByParent:
  parent/*: old/escalation`);
		const result = resolveAgentTaskConfig(task(), cfg, { parentModel: "parent/model" });
		expect(result.task.model).toBe("new/only");
		expect(result.fallbackModels).toEqual([]);
	});

	test("legacy model and fallbackModels fields still work inside an agent file", () => {
		const cfg = agentConfig("research", "model: legacy/main\nfallbackModels: [legacy/backup]");
		const result = resolveAgentTaskConfig(task(), cfg);
		expect(result.task.model).toBe("legacy/main");
		expect(result.fallbackModels).toEqual(["legacy/backup"]);
		const noFallback = agentConfig("research", "model: legacy/main\nfallbackModels: []");
		expect(resolveAgentTaskConfig(task(), noFallback).fallbackModels).toEqual([]);
	});

	test("old builtin role names are rejected unless explicitly configured", async () => {
		const cfg = loadSubagentConfig(temp(), {});
		for (const oldName of ["quick", "scan", "review", "deep", "docs", "frontend", "tests"]) {
			await expect(routeSubagentTasks([task(oldName)], cfg, {})).rejects.toThrow(/Unknown subagentType/);
		}
	});

	test("explicit custom Markdown types keep their own names and settings", () => {
		const cwd = temp();
		const dir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "scan.md"), "---\nmodel: custom/scan\nthinking: off\n---\nScan.\n");
		fs.writeFileSync(path.join(dir, "review.md"), "---\nmodel: custom/review\n---\nA private checklist.\n");
		const cfg = loadSubagentConfig(cwd, {});
		expect(resolveAgentTaskConfig(task("scan"), cfg).task).toMatchObject({ subagentType: "scan", model: "custom/scan" });
		expect(resolveAgentTaskConfig(task("review"), cfg).task).toMatchObject({ subagentType: "review", model: "custom/review" });
		expect(resolveAgentTaskConfig(task(), cfg).task.model).toBe("zai/glm-5-turbo");
		expect(buildSubagentCatalogPrompt(cfg)).toContain("- review:");
	});

	test("legacy preset role overrides apply only to explicitly configured matching types", async () => {
		const cwd = temp();
		const dir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "scan.md"), "---\nmodel: custom/scan\n---\nScan.\n");
		fs.writeFileSync(path.join(dir, "review.md"), "---\nmodel: custom/review\n---\nReview.\n");
		const cfg = loadSubagentConfig(cwd, {});
		const preset = { types: { scan: { model: "old/scanner" }, review: { model: "old/reviewer" } } };
		const routed = await routeSubagentTasks([task("scan")], cfg, {});
		expect(resolveAgentTaskConfig(routed.tasks[0], cfg, { preset }).task.model).toBe("old/scanner");
		expect(resolveAgentTaskConfig(task("review"), cfg, { preset }).task.model).toBe("old/reviewer");
		expect(resolveAgentTaskConfig(task(), cfg, { preset }).task.model).toBe("zai/glm-5-turbo");
	});
});

describe("model availability and capabilities", () => {
	test("an unconfigured provider cannot pass selection just because auth resolution returns ok", async () => {
		const cfg = poolConfig();
		const runtime = registry();
		const result = await selectAvailableAgentModels(resolveAgentTaskConfig(task(), cfg), cfg, {
			...runtime, getAvailable: () => [runtime.find("fast", "vision")],
		});
		expect(result.task.model).toBe("fast/vision");
		expect(result.fallbackModels).toEqual([]);
		await expect(selectAvailableAgentModels(resolveAgentTaskConfig(task(), cfg), cfg, {
			...runtime, getAvailable: () => [],
		})).rejects.toThrow(/No configured candidate/);
	});

	test("filters missing and unauthenticated candidates without calling an LLM", async () => {
		const cfg = poolConfig();
		const runtime = registry();
		runtime.getApiKeyAndHeaders.mockImplementation(async (model: Model<Api>) => ({ ok: model.provider !== "cheap" }));
		const result = await selectAvailableAgentModels(resolveAgentTaskConfig(task(), cfg), cfg, runtime);
		expect(result.task.model).toBe("fast/vision");
		expect(result.fallbackModels).toEqual(["backup/vision"]);
		expect(runtime.complete).not.toHaveBeenCalled();
	});

	test("image tasks and browser QA keep only confirmed image-capable candidates", async () => {
		const cfg = poolConfig();
		for (const work of [{ ...task(), imagePaths: ["screen.png"] }, task("browser-qa")]) {
			const result = await selectAvailableAgentModels(resolveAgentTaskConfig(work, cfg), cfg, registry());
			expect(result.task.model).toBe("fast/vision");
			expect(result.fallbackModels).toEqual(["backup/vision"]);
		}
	});

	test("image checks and explicit models never escape an incompatible choice", async () => {
		const cfg = poolConfig();
		const work = { ...task(), imagePaths: ["screen.png"] };
		const textOnly = resolveAgentTaskConfig(work, cfg, { preset: { models: ["cheap/text"] } });
		await expect(selectAvailableAgentModels(textOnly, cfg, registry())).rejects.toThrow(/image support/);
		await expect(selectAvailableAgentModels(textOnly, cfg)).rejects.toThrow(/image support/);
		const explicit = resolveAgentTaskConfig({ ...work, model: "cheap/text" }, cfg);
		await expect(selectAvailableAgentModels(explicit, cfg, registry())).rejects.toThrow(/image support/);
	});

	test("configured blind-model overrides take priority over runtime image metadata", async () => {
		const cfg = { ...poolConfig(), vision: { blindModelPatterns: ["fast/*"] } };
		const result = await selectAvailableAgentModels(resolveAgentTaskConfig(task("browser-qa"), cfg), cfg, registry());
		expect(result.task.model).toBe("backup/vision");
		expect(result.fallbackModels).toEqual([]);
	});

	test("auth errors remain redacted and cannot silently select the parent", async () => {
		const cfg = poolConfig();
		const runtime = registry();
		runtime.getApiKeyAndHeaders.mockImplementation(async () => { throw new Error("secret-value-must-not-leak"); });
		let message = "";
		try { await selectAvailableAgentModels(resolveAgentTaskConfig(task(), cfg), cfg, runtime); }
		catch (error) { message = (error as Error).message; }
		expect(message).toContain("No configured candidate");
		expect(message).not.toContain("secret-value");
	});

	test("quota history cannot introduce candidates outside the selected pool", async () => {
		const cfg = poolConfig();
		rememberSessionModelFallback("cheap/text", "outside/expensive");
		const scoped = resolveAgentTaskConfig(task(), cfg, { preset: { models: ["cheap/text", "fast/vision"] } });
		expect(selectSessionModelWithFallback(scoped.task.model, scoped.fallbackModels)?.model).toBe("fast/vision");
		const result = await selectAvailableAgentModels(scoped, cfg, registry());
		expect(result.task.model).toBe("fast/vision");
		expect(result.fallbackModels).toEqual([]);
		rememberSessionModelFallback("fast/vision", "outside/expensive");
		await expect(selectAvailableAgentModels(scoped, cfg, registry())).rejects.toThrow(/No configured candidate/);
	});

	test("cancellation during model auth does not produce a spawn plan", async () => {
		const cfg = poolConfig();
		const runtime = registry();
		const controller = new AbortController();
		runtime.getApiKeyAndHeaders.mockImplementation(async () => { controller.abort(); return { ok: true }; });
		await expect(selectAvailableAgentModels(resolveAgentTaskConfig(task(), cfg), cfg, runtime, controller.signal))
			.rejects.toThrow("Aborted");
	});
});
