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
	frontierOracleCandidates,
	isFrontierModel,
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
	test("Sol is not frontier; Opus is frontier across serving providers", () => {
		const frontier = defaultFrontierConfig();
		expect(isFrontierModel("openai-codex/gpt-6.1-sol", frontier)).toBe(false);
		expect(isFrontierModel("openai-codex/gpt-6-sol", frontier)).toBe(false);
		expect(isSameModel("openai-codex/gpt-6-sol", "openai-codex/gpt-6.1-sol", frontier)).toBe(false);
		for (const ref of ["anthropic/claude-opus-5-5", "pi-claude-code-provider/opus", "antigravity/antigravity-claude-opus-4-6-thinking", "openrouter/anthropic/claude-opus-5-5"]) {
			expect(isFrontierModel(ref, frontier)).toBe(true);
		}
	});

	test("vendor comes from the model family, not the serving provider", () => {
		expect(modelVendor("openai-codex/gpt-6-astra")).toBe("openai");
		expect(modelVendor("openai/gpt-6-astra")).toBe("openai");
		expect(modelVendor("github-copilot/gpt-6-astra")).toBe("openai");
		expect(modelVendor("openrouter/~openai/gpt-astra-latest")).toBe("openai");
		expect(modelVendor("zai-coding/glm-5.3")).toBe("zai");
		expect(modelVendor("antigravity/antigravity-claude-opus-4-6-thinking")).toBe("anthropic");
		// Claude Code provider exposes bare family aliases without "claude".
		expect(modelVendor("pi-claude-code-provider/opus")).toBe("anthropic");
		expect(modelVendor("pi-claude-code-provider/sonnet")).toBe("anthropic");
		expect(modelVendor("pi-claude-code-provider/haiku")).toBe("anthropic");
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
	test("frontier GLM parent gets frontier GPT and Opus", () => {
		const config = configWith();
		expect(oracle(config, "zai/glm-5.3")).toEqual(["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"]);
		expect(oracle(config, "zai-coding/glm-5.3")).toEqual(["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"]);
	});

	test("an OpenAI parent is paired with Anthropic, whatever provider serves the parent", () => {
		const config = configWith();
		for (const parent of [
			"openai-codex/gpt-6-astra",
			"openai/gpt-6-astra",
			"github-copilot/gpt-6-astra",
			"openrouter/~openai/gpt-astra-latest",
		]) {
			expect(oracle(config, parent)).toEqual(["anthropic/claude-opus-5-5"]);
		}
		expect(oracle(config, "pi-claude-code-provider/opus")).toEqual(["openai-codex/gpt-6-astra"]);
	});

	test("non-frontier parent excludes its vendor from the entire chain", () => {
		const config = configWith();
		expect(oracle(config, "zai/glm-5.3-flash")).toEqual(["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"]);
		expect(oracle(config, "openai-codex/gpt-6-luna")).toEqual(["anthropic/claude-opus-5-5"]);
		expect(oracle(config, "openai-codex/gpt-6.1-sol")).toEqual(["anthropic/claude-opus-5-5"]);
		expect(oracle(config, "anthropic/claude-haiku-5")).toEqual(["openai-codex/gpt-6-astra"]);
	});

	test("vendor pairing, not frontier list order, chooses the oracle vendor", () => {
		const config = configWith({ frontierModels: [
			"zai/glm-5.3",
			"anthropic/claude-opus-5",
			"openai-codex/gpt-6-astra",
		] });
		expect(oracle(config, "anthropic/claude-opus-5")).toEqual(["openai-codex/gpt-6-astra"]);
		expect(oracle(config, "zai/glm-5.3")).toEqual(["openai-codex/gpt-6-astra", "anthropic/claude-opus-5"]);
		expect(oracle(config, "xai/grok-5")).toEqual(["openai-codex/gpt-6-astra", "anthropic/claude-opus-5"]);
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
			{ model: "anthropic/claude-opus-6", expensive: true },
		] });
		expect(oracle(config, "zai/glm-6")).toEqual(["openai-codex/gpt-7", "anthropic/claude-opus-6"]);
		expect(oracle(config, "openai-codex/gpt-7")).toEqual(["anthropic/claude-opus-6"]);
		expect(oracle(config, "anthropic/claude-opus-6")).toEqual(["openai-codex/gpt-7"]);
		// Previous frontier models are now ordinary parents.
		expect(oracle(config, "zai/glm-5.3")).toEqual(["openai-codex/gpt-7", "anthropic/claude-opus-6"]);
	});

	test("disabled and role-restricted entries are not selected but stay frontier for parent detection", () => {
		const config = configWith({ frontierModels: [
			{ model: "openai-codex/gpt-6-astra", enabled: false },
			{ model: "openai-codex/gpt-6.1-sol", roles: ["research"] },
			{ model: "zai/glm-5.3" },
			{ model: "anthropic/claude-opus-5-5" },
		] });
		expect(oracle(config, "zai/glm-5.3")).toEqual(["anthropic/claude-opus-5-5"]);
		expect(isFrontierModel("openai-codex/gpt-6-astra", config.frontier!)).toBe(true);
		expect(() => oracle(config, "anthropic/claude-opus-5-5")).toThrow(/vendor other than the parent's \(anthropic\)/);
		expect(filterSubagentConfigForParentModel(config, "anthropic/claude-opus-5-5").types.oracle).toBeUndefined();
	});

	test("explicit overrides and --provider cannot bypass the vendor boundary", () => {
		const config = configWith();
		expect(() => oracle(config, "openai-codex/gpt-6-astra", { extraArgs: ["--model", "openai/gpt-6.1-sol"] })).toThrow(/shares the parent's vendor/);
		expect(() => resolveAgentTaskConfig({ id: "o", task: "x", subagentType: "oracle", model: "github-copilot/gpt-6.1-sol" }, config, { parentModel: "openai-codex/gpt-6-astra" })).toThrow(/cross-vendor/);
		expect(() => oracle(config, "zai/glm-5.3", { extraArgs: ["--provider=zai"] })).toThrow(/--provider/);
		expect(oracle(config, "zai/glm-5.3", { extraArgs: ["--model", "openai/gpt-6.1-sol"] })).toEqual(["openai/gpt-6.1-sol"]);
	});

	test("a project oracle with explicit models replaces frontier selection", () => {
		const cwd = temp();
		const file = path.join(cwd, ".pi", "agents", "oracle.md");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// Same-name project roles replace built-ins completely, so the project
		// oracle owns its cross-vendor policy instead of inheriting the built-in's.
		fs.writeFileSync(file, "---\nmodels: [anthropic/claude-opus-5, zai/glm-5.3]\nparentProviderPolicy: require-other-if-frontier\n---\nProject oracle.\n");
		const config = loadSubagentConfig(cwd, {});
		expect(config.types.oracle.modelSelection).toBeUndefined();
		expect(config.types.oracle.parentProviderPolicy).toBe("require-other-if-frontier");
		expect(oracle(config, "zai/glm-5.3")).toEqual(["anthropic/claude-opus-5"]);
	});

	test("an omitted vendor policy does not fall through to the replaced built-in oracle", () => {
		const cwd = temp();
		const file = path.join(cwd, ".pi", "agents", "oracle.md");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "---\nmodels: [anthropic/claude-opus-5, zai/glm-5.3]\n---\nProject oracle.\n");
		const config = loadSubagentConfig(cwd, {});
		expect(config.types.oracle.parentProviderPolicy).toBeUndefined();
		expect(oracle(config, "zai/glm-5.3")).toEqual(["anthropic/claude-opus-5", "zai/glm-5.3"]);
	});

	test("rejects modelSelection combined with an explicit candidate list", () => {
		const cwd = temp();
		const file = path.join(cwd, ".pi", "agents", "bad.md");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "---\nmodelSelection: frontier\nmodels: [zai/glm-5.3]\n---\nBad.\n");
		expect(() => loadSubagentConfig(cwd, {})).toThrow(/conflicts with models/);
	});
});

describe("frontierOracleCandidates", () => {
	test("matches the resolver's oracle chain for every parent class and economy state", () => {
		for (const economy of [false, true]) {
			const config = configWith({ economy });
			for (const parent of ["zai/glm-5.3", "openai-codex/gpt-6.1-sol", "openai/gpt-6-astra", "zai/glm-5.3-flash", "openai-codex/gpt-6-luna", "anthropic/claude-haiku-5"]) {
				const expected = frontierOracleCandidates(parent, config.frontier!, "oracle", config.types.oracle.vendorsByParentVendor);
				if (expected.length === 0) expect(() => oracle(config, parent)).toThrow();
				else expect(oracle(config, parent)).toEqual(expected);
			}
		}
	});
});

describe("economy mode", () => {
	test("excludes expensive frontier models for every role", () => {
		const config = configWith({ economy: true });
		expect(() => oracle(config, "openai-codex/gpt-6-luna")).toThrow(/economy mode excluded anthropic\/claude-opus-5-5/);
		const core = resolveAgentTaskConfig({ id: "i", task: "x", subagentType: "implement-core" }, config);
		expect([core.task.model, ...core.fallbackModels]).toEqual(["openai-codex/gpt-6.1-sol"]);
		const mechanical = resolveAgentTaskConfig({ id: "m", task: "x", subagentType: "mechanical" }, config);
		expect([mechanical.task.model, ...mechanical.fallbackModels]).toEqual(["zai/glm-5.3"]);
	});

	test("reports economy as the reason when nothing remains, and hides the oracle", () => {
		const config = configWith({ economy: true });
		expect(() => oracle(config, "zai/glm-5.3")).toThrow(/economy mode excluded openai-codex\/gpt-6-astra, anthropic\/claude-opus-5-5/);
		expect(buildSubagentCatalogPrompt(config, "zai/glm-5.3")).not.toContain("- oracle:");
		expect(buildSubagentCatalogPrompt(config, "openai-codex/gpt-6.1-sol")).not.toContain("- oracle:");
		expect(buildSubagentCatalogPrompt(configWith(), "openai-codex/gpt-6.1-sol")).toContain("- oracle:");
	});

	test("blocks an explicit expensive override but not the forced current model", () => {
		const config = configWith({ economy: true });
		expect(() => resolveAgentTaskConfig({ id: "i", task: "x", subagentType: "implement-core", model: "openai/gpt-6-astra" }, config)).toThrow(/economy mode is on/);
		expect(resolveAgentTaskConfig({ id: "i", task: "x", subagentType: "implement-core", model: "openai/gpt-6.1-sol" }, config).task.model).toBe("openai/gpt-6.1-sol");
		expect(resolveAgentTaskConfig({ id: "i", task: "x", subagentType: "implement-core" }, config, { forcedModel: "openai-codex/gpt-6.1-sol" }).task.model).toBe("openai-codex/gpt-6.1-sol");
	});

	test("env toggle overrides the file and is read fresh on every load", () => {
		expect(oracle(configWith({ economy: true }, { PI_TOOLS_SUITE_ECONOMY: "0" }), "zai/glm-5.3")).toEqual(["openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"]);
		const home = temp();
		const cwd = temp();
		const file = path.join(home, ".config", "pi", "pi-tools-suite.jsonc");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ economy: false }));
		expect(oracle(loadSubagentConfig(cwd, { HOME: home }), "openai-codex/gpt-6-luna")).toEqual(["anthropic/claude-opus-5-5"]);
		fs.writeFileSync(file, JSON.stringify({ economy: true }));
		expect(() => oracle(loadSubagentConfig(cwd, { HOME: home }), "openai-codex/gpt-6-luna")).toThrow(/economy mode/);
	});
});

describe("merged oracle architectural review", () => {
	test("exposes oracle to frontier and ordinary parents and removes the duplicate role", () => {
		const config = configWith();
		expect(config.types["frontier-review"]).toBeUndefined();
		for (const parent of ["openai-codex/gpt-6-astra", "zai/glm-5.3", "openrouter/~openai/gpt-astra-latest", "openai-codex/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"]) {
			expect(filterSubagentConfigForParentModel(config, parent).types.oracle).toBeDefined();
			expect(oracle(config, parent).every(model => modelVendor(model, config.frontier!) !== modelVendor(parent, config.frontier!))).toBe(true);
		}
	});

	test("cross-vendor review fails closed when a custom frontier list has no other vendor", () => {
		const config = configWith({ frontierModels: ["openai-codex/gpt-6-astra"] });
		for (const parentModel of ["openai-codex/gpt-6.1-sol", "openai/gpt-6.1-sol", "openrouter/openai/gpt-6.1-sol"]) {
			expect(isFrontierModel(parentModel, config.frontier!)).toBe(false);
			expect(buildSubagentCatalogPrompt(config, parentModel)).not.toContain("- oracle:");
			expect(filterSubagentConfigForParentModel(config, parentModel).types["oracle"]).toBeUndefined();
		}
		expect(filterSubagentConfigForParentModel(config, "openai-codex/gpt-6-luna").types["oracle"]).toBeUndefined();
		expect(() => resolveAgentTaskConfig({ id: "f", task: "Review architecture", subagentType: "oracle" }, config, { parentModel: "openai-codex/gpt-6-luna" })).toThrow();
		expect(filterSubagentConfigForParentModel(config, "anthropic/claude-sonnet-5-5").types["oracle"]).toBeDefined();
		const custom = configWith({ frontierModels: ["openai-codex/gpt-7", "zai/glm-6"] });
		const resolved = resolveAgentTaskConfig({ id: "f", task: "Review architecture", subagentType: "oracle" }, custom, { parentModel: "anthropic/claude-sonnet-5-5" });
		expect([resolved.task.model, ...resolved.fallbackModels]).toEqual(["openai-codex/gpt-7"]);
	});
});

describe("vendorsByParentVendor", () => {
	// Unrestricted list: the built-in default limits Astra to the oracle role.
	const unrestricted = { frontierModels: ["openai-codex/gpt-6-astra", "zai/glm-5.3", "anthropic/claude-opus-5-5"] };
	function projectAgent(frontmatter: string, suite: Record<string, unknown> = unrestricted): SubagentConfig {
		const home = temp();
		const cwd = temp();
		const suiteFile = path.join(home, ".config", "pi", "pi-tools-suite.jsonc");
		fs.mkdirSync(path.dirname(suiteFile), { recursive: true });
		fs.writeFileSync(suiteFile, JSON.stringify(suite));
		const file = path.join(cwd, ".pi", "agents", "reviewer.md");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `---\n${frontmatter}\n---\nReviewer.\n`);
		return loadSubagentConfig(cwd, { HOME: home });
	}
	const reviewer = (config: SubagentConfig, parentModel: string) => {
		const resolved = resolveAgentTaskConfig({ id: "r", task: "x", subagentType: "reviewer" }, config, { parentModel });
		return [resolved.task.model, ...resolved.fallbackModels];
	};

	test("orders by listed vendors; an unmatched parent without * has no candidates", () => {
		const config = projectAgent("modelSelection: frontier\nvendorsByParentVendor:\n  zai: [anthropic, openai]\n  openai: anthropic\nparentProviderPolicy: require-other");
		expect(config.types.reviewer.vendorsByParentVendor).toEqual({ zai: ["anthropic", "openai"], openai: ["anthropic"] });
		expect(reviewer(config, "zai/glm-5.3")).toEqual(["anthropic/claude-opus-5-5", "openai-codex/gpt-6-astra"]);
		expect(reviewer(config, "openai/gpt-6-luna")).toEqual(["anthropic/claude-opus-5-5"]);
		expect(() => reviewer(config, "anthropic/claude-opus-5-5")).toThrow(/vendor other than the parent's/);
		expect(filterSubagentConfigForParentModel(config, "anthropic/claude-opus-5-5").types.reviewer).toBeUndefined();
	});

	test("the provider policy still removes a same-vendor pairing", () => {
		const config = projectAgent("modelSelection: frontier\nvendorsByParentVendor:\n  \"*\": [openai, zai]\nparentProviderPolicy: require-other");
		expect(reviewer(config, "openai-codex/gpt-6-luna")).toEqual(["zai/glm-5.3"]);
	});

	test("rejects invalid maps and use without frontier selection", () => {
		expect(() => projectAgent("models: [zai/glm-5.3]\nvendorsByParentVendor:\n  openai: [zai]")).toThrow(/requires modelSelection: frontier/);
		expect(() => projectAgent("modelSelection: frontier\nvendorsByParentVendor:\n  OpenAI: [zai]")).toThrow(/lowercase vendor names/);
		expect(() => projectAgent("modelSelection: frontier\nvendorsByParentVendor:\n  openai: []")).toThrow(/non-empty vendor lists/);
		expect(() => projectAgent("modelSelection: frontier\nvendorsByParentVendor: openai")).toThrow(/vendorsByParentVendor must map/);
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
