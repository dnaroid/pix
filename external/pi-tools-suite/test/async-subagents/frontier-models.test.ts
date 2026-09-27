import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	currentModelRef,
	filterSubagentConfigForParentModel,
	loadSubagentConfig,
	resolveAgentTaskConfig,
	type SubagentConfig,
} from "../../src/async-subagents/core/config.js";
import {
	defaultFrontierConfig,
	isSameModel,
	modelVendor,
	normalizeFrontierModels,
	type FrontierModelEntry,
} from "../../src/async-subagents/core/frontier-models.js";
import { buildSubagentCatalogPrompt } from "../../src/async-subagents/core/agent-catalog.js";
import { loadPiToolsSuiteConfig } from "../../src/config.js";

const dirs: string[] = [];

function temp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-frontier-"));
	dirs.push(dir);
	return dir;
}

/** Load real bundled roles with a user-layer suite config. */
function configWith(suite: Record<string, unknown> = {}, env: Record<string, string> = {}): SubagentConfig {
	const home = temp();
	const file = path.join(home, ".config", "pi", "pi-tools-suite.jsonc");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(suite));
	return loadSubagentConfig(temp(), { HOME: home, ...env });
}

function oracle(config: SubagentConfig, parentModel?: string, extra: Partial<Parameters<typeof resolveAgentTaskConfig>[2]> = {}) {
	const resolved = resolveAgentTaskConfig({ id: "o", task: "second opinion", subagentType: "oracle" }, config, { parentModel, ...extra });
	return [resolved.task.model, ...resolved.fallbackModels];
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("model identity", () => {
	test("vendor comes from the model family, not the serving provider", () => {
		expect(modelVendor("openai-codex/gpt-6-astra")).toBe("openai");
		expect(modelVendor("openai/gpt-6-astra")).toBe("openai");
		expect(modelVendor("github-copilot/gpt-6-astra")).toBe("openai");
		expect(modelVendor("openrouter/~openai/gpt-astra-latest")).toBe("openai");
		expect(modelVendor("zai-coding/glm-5.3")).toBe("zai");
		expect(modelVendor("antigravity/antigravity-claude-opus-4-6-thinking")).toBe("anthropic");
		expect(modelVendor("antigravity/antigravity-gemini-3.1-pro")).toBe("google");
		expect(modelVendor("openai/o4-mini")).toBe("openai");
		expect(modelVendor("custom/house-model")).toBe("custom");
		expect(modelVendor(undefined)).toBeUndefined();
		const frontier = { models: [{ model: "custom/house-model", vendor: "acme" }], economy: false };
		expect(modelVendor("custom/house-model", frontier)).toBe("acme");
	});

	test("same model is recognized across providers and through aliases", () => {
		const frontier = defaultFrontierConfig();
		expect(isSameModel("openai/gpt-6-astra", "openai-codex/gpt-6-astra")).toBe(true);
		expect(isSameModel("openrouter/openai/gpt-6-sol", "openai-codex/gpt-6-sol")).toBe(true);
		expect(isSameModel("openrouter/~openai/gpt-astra-latest", "openai-codex/gpt-6-astra")).toBe(false);
		expect(isSameModel("openrouter/~openai/gpt-astra-latest", "openai-codex/gpt-6-astra", frontier)).toBe(true);
		expect(isSameModel("zai/glm-5.3-flash", "zai/glm-5.3", frontier)).toBe(false);
	});

	test("currentModelRef keeps the serving provider for slash-containing ids", () => {
		expect(currentModelRef({ provider: "openrouter", id: "~openai/gpt-astra-latest" })).toBe("openrouter/~openai/gpt-astra-latest");
		expect(currentModelRef({ provider: "zai", id: "zai/glm-5.3" })).toBe("zai/glm-5.3");
		expect(currentModelRef({ provider: "zai", id: "glm-5.3" })).toBe("zai/glm-5.3");
	});
});

describe("oracle frontier selection", () => {
	test("frontier GLM parent gets frontier GPT only", () => {
		const config = configWith();
		expect(oracle(config, "zai/glm-5.3")).toEqual(["openai-codex/gpt-6-astra", "openai-codex/gpt-6-sol"]);
		expect(oracle(config, "zai-coding/glm-5.3")).toEqual(["openai-codex/gpt-6-astra", "openai-codex/gpt-6-sol"]);
	});

	test("frontier non-GLM parent gets frontier GLM, whatever provider serves the parent", () => {
		const config = configWith();
		for (const parent of [
			"openai-codex/gpt-6-astra",
			"openai-codex/gpt-6-sol",
			"openai/gpt-6-astra",
			"github-copilot/gpt-6-astra",
			"openrouter/~openai/gpt-astra-latest",
		]) {
			expect(oracle(config, parent)).toEqual(["zai/glm-5.3"]);
		}
	});

	test("non-frontier parent gets any frontier with other vendors first", () => {
		const config = configWith();
		expect(oracle(config, "zai/glm-5.3-flash")).toEqual(["openai-codex/gpt-6-astra", "openai-codex/gpt-6-sol", "zai/glm-5.3"]);
		expect(oracle(config, "openai-codex/gpt-6-luna")).toEqual(["zai/glm-5.3", "openai-codex/gpt-6-astra", "openai-codex/gpt-6-sol"]);
		expect(oracle(config, "anthropic/claude-haiku-5")).toEqual(["openai-codex/gpt-6-astra", "openai-codex/gpt-6-sol", "zai/glm-5.3"]);
	});

	test("a third-vendor frontier parent follows list order among the other vendors", () => {
		const config = configWith({ frontierModels: [
			"zai/glm-5.3",
			"openai-codex/gpt-6-astra",
			"anthropic/claude-opus-5",
		] });
		expect(oracle(config, "anthropic/claude-opus-5")).toEqual(["zai/glm-5.3", "openai-codex/gpt-6-astra"]);
	});

	test("unknown parent fails closed and hides the role", () => {
		const config = configWith();
		expect(() => oracle(config)).toThrow(/known, permitted parent model/);
		expect(filterSubagentConfigForParentModel(config, undefined).types.oracle).toBeUndefined();
	});

	test("a new frontier release is a config edit, not an oracle edit", () => {
		const config = configWith({ frontierModels: [
			{ model: "openai-codex/gpt-7", expensive: true },
			{ model: "zai/glm-6" },
		] });
		expect(oracle(config, "zai/glm-6")).toEqual(["openai-codex/gpt-7"]);
		expect(oracle(config, "openai-codex/gpt-7")).toEqual(["zai/glm-6"]);
		// Previous frontier models are now ordinary parents.
		expect(oracle(config, "zai/glm-5.3")).toEqual(["openai-codex/gpt-7", "zai/glm-6"]);
	});

	test("disabled and role-restricted entries are not selected but stay frontier for parent detection", () => {
		const config = configWith({ frontierModels: [
			{ model: "openai-codex/gpt-6-astra", enabled: false },
			{ model: "openai-codex/gpt-6-sol", roles: ["frontier-review"] },
			{ model: "zai/glm-5.3" },
		] });
		expect(() => oracle(config, "zai/glm-5.3")).toThrow(/vendor other than the parent's \(zai\)/);
		expect(oracle(config, "openai-codex/gpt-6-astra")).toEqual(["zai/glm-5.3"]);
		expect(filterSubagentConfigForParentModel(config, "zai/glm-5.3").types.oracle).toBeUndefined();
	});

	test("explicit overrides and --provider cannot bypass the vendor boundary", () => {
		const config = configWith();
		expect(() => oracle(config, "openai-codex/gpt-6-astra", { extraArgs: ["--model", "openai/gpt-6-sol"] })).toThrow(/shares the parent's vendor/);
		expect(() => resolveAgentTaskConfig({ id: "o", task: "x", subagentType: "oracle", model: "github-copilot/gpt-6-sol" }, config, { parentModel: "openai-codex/gpt-6-astra" })).toThrow(/cross-vendor/);
		expect(() => oracle(config, "zai/glm-5.3", { extraArgs: ["--provider=zai"] })).toThrow(/--provider/);
		expect(oracle(config, "zai/glm-5.3", { extraArgs: ["--model", "openai/gpt-6-sol"] })).toEqual(["openai/gpt-6-sol"]);
	});

	test("a project oracle with explicit models replaces frontier selection", () => {
		const cwd = temp();
		const file = path.join(cwd, ".pi", "agents", "oracle.md");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "---\nmodels: [anthropic/claude-opus-5, zai/glm-5.3]\n---\nProject oracle.\n");
		const config = loadSubagentConfig(cwd, {});
		expect(config.types.oracle.modelSelection).toBeUndefined();
		expect(config.types.oracle.parentProviderPolicy).toBe("require-other-if-frontier");
		expect(oracle(config, "zai/glm-5.3")).toEqual(["anthropic/claude-opus-5"]);
	});

	test("rejects modelSelection combined with an explicit candidate list", () => {
		const cwd = temp();
		const file = path.join(cwd, ".pi", "agents", "bad.md");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "---\nmodelSelection: frontier\nmodels: [zai/glm-5.3]\n---\nBad.\n");
		expect(() => loadSubagentConfig(cwd, {})).toThrow(/conflicts with models/);
	});
});

describe("economy mode", () => {
	test("excludes expensive frontier models for every role", () => {
		const config = configWith({ economy: true });
		expect(oracle(config, "openai-codex/gpt-6-luna")).toEqual(["zai/glm-5.3"]);
		const implement = resolveAgentTaskConfig({ id: "i", task: "x", subagentType: "implement" }, config);
		expect([implement.task.model, ...implement.fallbackModels]).toEqual(["zai/glm-5.3"]);
		const review = resolveAgentTaskConfig({ id: "d", task: "x", subagentType: "delivery-review" }, config);
		expect([review.task.model, ...review.fallbackModels]).toEqual(["zai/glm-5.3"]);
	});

	test("reports economy as the reason when nothing remains, and hides the oracle", () => {
		const config = configWith({ economy: true });
		expect(() => oracle(config, "zai/glm-5.3")).toThrow(/economy mode excluded openai-codex\/gpt-6-astra, openai-codex\/gpt-6-sol/);
		expect(buildSubagentCatalogPrompt(config, "zai/glm-5.3")).not.toContain("- oracle:");
		expect(buildSubagentCatalogPrompt(config, "openai-codex/gpt-6-sol")).toContain("- oracle:");
	});

	test("blocks an explicit expensive override but not the forced current model", () => {
		const config = configWith({ economy: true });
		expect(() => resolveAgentTaskConfig({ id: "i", task: "x", subagentType: "implement", model: "openai/gpt-6-sol" }, config)).toThrow(/economy mode is on/);
		expect(resolveAgentTaskConfig({ id: "i", task: "x", subagentType: "implement" }, config, { forcedModel: "openai-codex/gpt-6-sol" }).task.model).toBe("openai-codex/gpt-6-sol");
	});

	test("env toggle overrides the file and is read fresh on every load", () => {
		expect(oracle(configWith({ economy: true }, { PI_TOOLS_SUITE_ECONOMY: "0" }), "zai/glm-5.3")).toEqual(["openai-codex/gpt-6-astra", "openai-codex/gpt-6-sol"]);
		const home = temp();
		const cwd = temp();
		const file = path.join(home, ".config", "pi", "pi-tools-suite.jsonc");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ economy: false }));
		expect(oracle(loadSubagentConfig(cwd, { HOME: home }), "openai-codex/gpt-6-luna")).toHaveLength(3);
		fs.writeFileSync(file, JSON.stringify({ economy: true }));
		expect(oracle(loadSubagentConfig(cwd, { HOME: home }), "openai-codex/gpt-6-luna")).toEqual(["zai/glm-5.3"]);
	});
});

describe("review roles share the frontier list", () => {
	test("frontier-review is hidden for every frontier parent and uses non-oracle entries", () => {
		const config = configWith();
		for (const parent of ["openai-codex/gpt-6-sol", "openai-codex/gpt-6-astra", "zai/glm-5.3", "openrouter/~openai/gpt-astra-latest"]) {
			expect(filterSubagentConfigForParentModel(config, parent).types["frontier-review"]).toBeUndefined();
		}
		expect(filterSubagentConfigForParentModel(config, "zai/glm-5.3-flash").types["frontier-review"]).toBeDefined();
		const review = resolveAgentTaskConfig({ id: "f", task: "x", subagentType: "frontier-review" }, config, { parentModel: "zai/glm-5.3-flash" });
		expect([review.task.model, ...review.fallbackModels]).toEqual(["openai-codex/gpt-6-sol", "zai/glm-5.3"]);
	});
});

describe("suite config", () => {
	test("frontierModels layers replace the list, null restores defaults, invalid entries are dropped", () => {
		const home = temp();
		const cwd = temp();
		const user = path.join(home, ".config", "pi", "pi-tools-suite.jsonc");
		fs.mkdirSync(path.dirname(user), { recursive: true });
		fs.writeFileSync(user, JSON.stringify({ frontierModels: ["zai/glm-6", { model: "bad" }, { model: "openai-codex/gpt-7", expensive: true, roles: ["oracle"] }, 5] }));
		const loaded = loadPiToolsSuiteConfig([], { cwd, homeDir: home, env: {} });
		expect(loaded.frontierModels).toEqual([
			{ model: "zai/glm-6" },
			{ model: "openai-codex/gpt-7", expensive: true, roles: ["oracle"] },
		] satisfies FrontierModelEntry[]);
		expect(loaded.economy).toBe(false);

		const project = path.join(cwd, ".pi", "pi-tools-suite.jsonc");
		fs.mkdirSync(path.dirname(project), { recursive: true });
		fs.writeFileSync(project, JSON.stringify({ frontierModels: null, economy: true }));
		const reset = loadPiToolsSuiteConfig([], { cwd, homeDir: home, env: {} });
		expect(reset.frontierModels).toEqual(defaultFrontierConfig().models);
		expect(reset.economy).toBe(true);
	});

	test("normalizeFrontierModels ignores non-arrays", () => {
		expect(normalizeFrontierModels("zai/glm-5.3")).toBeUndefined();
		expect(normalizeFrontierModels([" zai/glm-5.3 ", "zai/glm-5.3"])).toEqual([{ model: "zai/glm-5.3" }]);
	});
});
