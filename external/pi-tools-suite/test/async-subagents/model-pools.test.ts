import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadSubagentConfig,
	resolveAgentTaskConfig,
	type SubagentConfig,
} from "../../src/async-subagents/core/config.js";
import { buildSubagentCatalogPrompt } from "../../src/async-subagents/core/agent-catalog.js";
import { routeSubagentTasks } from "../../src/async-subagents/core/routing.js";

const dirs: string[] = [];

function temp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-model-policy-"));
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

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("role-owned model candidates", () => {
	test("ships one oracle role selecting from the frontier list with a cross-vendor policy", () => {
		const config = loadSubagentConfig(temp(), {});
		expect(Object.keys(config.types).sort()).toEqual([
			"delivery-review", "frontier-review", "implement", "knowledge-auditor", "oracle", "research", "ui-qa", "verify",
		]);
		expect(config.types.oracle.models).toBeUndefined();
		expect(config.types.oracle.modelSelection).toBe("frontier");
		expect(config.types.oracle.parentProviderPolicy).toBe("require-other-if-frontier");
		expect(buildSubagentCatalogPrompt(config, "openai-codex/gpt-6-luna")).toContain("- oracle:");

		// Non-frontier parent: other-vendor frontier first, same-vendor frontier after.
		const fromLuna = resolveAgentTaskConfig(task("oracle"), config, { parentModel: "openai-codex/gpt-6-luna" });
		expect(fromLuna.task.model).toBe("zai/glm-5.3");
		expect(fromLuna.fallbackModels).toEqual(["openai-codex/gpt-6-astra", "openai-codex/gpt-6.1-sol"]);

		const fromTurbo = resolveAgentTaskConfig(task("oracle"), config, { parentModel: "zai/glm-5-turbo" });
		expect(fromTurbo.task.model).toBe("openai-codex/gpt-6-astra");
		expect(fromTurbo.fallbackModels).toEqual(["openai-codex/gpt-6.1-sol", "zai/glm-5.3"]);
		expect(() => resolveAgentTaskConfig(task("oracle"), config)).toThrow(/parent model/i);
	});

	test("require-other is N-provider and preserves configured order after filtering", () => {
		const config = agentConfig("independent", [
			"models: [openai/frontier, anthropic/frontier, zai/frontier]",
			"parentProviderPolicy: require-other",
		].join("\n"));

		const openaiParent = resolveAgentTaskConfig(task("independent"), config, { parentModel: "openai/parent" });
		expect(openaiParent.task.model).toBe("anthropic/frontier");
		expect(openaiParent.fallbackModels).toEqual(["zai/frontier"]);

		const anthropicParent = resolveAgentTaskConfig(task("independent"), config, { parentModel: "anthropic/parent" });
		expect(anthropicParent.task.model).toBe("openai/frontier");
		expect(anthropicParent.fallbackModels).toEqual(["zai/frontier"]);

		const zaiParent = resolveAgentTaskConfig(task("independent"), config, { parentModel: "zai/parent" });
		expect(zaiParent.task.model).toBe("openai/frontier");
		expect(zaiParent.fallbackModels).toEqual(["anthropic/frontier"]);

		expect(() => resolveAgentTaskConfig(
			{ ...task("independent"), model: "anthropic/forced" },
			config,
			{ parentModel: "anthropic/parent" },
		)).toThrow(/cross-vendor/i);
		expect(resolveAgentTaskConfig(
			{ ...task("independent"), model: "zai/forced" },
			config,
			{ parentModel: "anthropic/parent" },
		).task.model).toBe("zai/forced");
	});

	test("prefer-other stable-partitions candidates without overriding an explicit model", () => {
		const config: SubagentConfig = { types: { reviewer: {
			models: ["openai/a", "anthropic/a", "openai/b", "zai/a"],
			parentProviderPolicy: "prefer-other",
		} } };
		const selected = resolveAgentTaskConfig(task("reviewer"), config, { parentModel: "openai/parent" });
		expect(selected.task.model).toBe("anthropic/a");
		expect(selected.fallbackModels).toEqual(["zai/a", "openai/a", "openai/b"]);
		const explicit = resolveAgentTaskConfig({ ...task("reviewer"), model: "openai/forced" }, config, { parentModel: "openai/parent" });
		expect(explicit.task.model).toBe("openai/forced");
		expect(explicit.fallbackModels).toEqual([]);
	});

	test("any preserves the role's configured candidate order", () => {
		const config: SubagentConfig = { types: { research: {
			models: ["openai/a", "anthropic/a", "zai/a"],
			parentProviderPolicy: "any",
		} } };
		const selected = resolveAgentTaskConfig(task(), config, { parentModel: "openai/parent" });
		expect(selected.task.model).toBe("openai/a");
		expect(selected.fallbackModels).toEqual(["anthropic/a", "zai/a"]);
	});

	test("legacy requireDifferentProvider remains a compatibility alias", () => {
		const config = agentConfig("legacy", "models: [openai/a, anthropic/a]\nrequireDifferentProvider: true");
		expect(config.types.legacy.parentProviderPolicy).toBe("require-other");
		expect(resolveAgentTaskConfig(task("legacy"), config, { parentModel: "openai/parent" }).task.model).toBe("anthropic/a");
		expect(() => agentConfig("bad", "models: [other/a]\nrequireDifferentProvider: yes")).toThrow(/boolean/);
	});

	test("validates provider policy and rejects conflicting legacy input", () => {
		expect(() => agentConfig("bad", "models: [a/one]\nparentProviderPolicy: sometimes")).toThrow(/parentProviderPolicy/);
		expect(() => agentConfig("bad", [
			"models: [a/one]",
			"parentProviderPolicy: prefer-other",
			"requireDifferentProvider: true",
		].join("\n"))).toThrow(/conflicts/);
	});

	test("models are normalized and empty candidates never inherit the parent", () => {
		const normalized = agentConfig("custom", 'models: [" a/first ", b/second, a/first]');
		expect(normalized.types.custom.models).toEqual(["a/first", "b/second"]);
		const empty = agentConfig("research", "models: []");
		expect(empty.types.research.models).toEqual([]);
		expect(() => resolveAgentTaskConfig(task(), empty, { parentModel: "expensive/parent" })).toThrow(/No model candidates/);
		for (const modelsSource of ["[unqualified]", "[a/]", "[a/*]", "[null]", "[1]"]) {
			expect(() => agentConfig("custom", `models: ${modelsSource}`)).toThrow(/models must be an array/);
		}
	});

	test("explicit task, CLI and forced model overrides have no implicit fallbacks", () => {
		const config: SubagentConfig = { types: { research: { models: ["a/one", "b/two"] } } };
		const explicit = resolveAgentTaskConfig({ ...task(), model: "manual/model" }, config);
		expect(explicit.task.model).toBe("manual/model");
		expect(explicit.fallbackModels).toEqual([]);
		const cli = resolveAgentTaskConfig(task(), config, { extraArgs: ["--model=cli/model"] });
		expect(cli.task.model).toBe("cli/model");
		expect(cli.fallbackModels).toEqual([]);
		const forced = resolveAgentTaskConfig({ ...task(), model: "manual/model", extraArgs: ["-m", "cli/model"] }, config, { forcedModel: "forced/model" });
		expect(forced.task.model).toBe("forced/model");
		expect(forced.extraArgs).toEqual([]);
		expect(forced.fallbackModels).toEqual([]);
	});

	test("legacy model/fallbackModels and project-local custom role names still work", async () => {
		const legacy = agentConfig("research", "model: legacy/main\nfallbackModels: [legacy/backup]");
		const selected = resolveAgentTaskConfig(task(), legacy);
		expect(selected.task.model).toBe("legacy/main");
		expect(selected.fallbackModels).toEqual(["legacy/backup"]);

		const cwd = temp();
		const dir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "scan.md"), "---\nmodel: custom/scan\nthinking: off\n---\nScan.\n");
		const config = loadSubagentConfig(cwd, {});
		expect(resolveAgentTaskConfig(task("scan"), config).task).toMatchObject({ subagentType: "scan", model: "custom/scan" });
		expect(buildSubagentCatalogPrompt(config)).toContain("- scan:");
		for (const oldName of ["quick", "review", "deep", "docs", "frontend", "tests"]) {
			await expect(routeSubagentTasks([task(oldName)], config, {})).rejects.toThrow(/Unknown subagentType/);
		}
	});
});
