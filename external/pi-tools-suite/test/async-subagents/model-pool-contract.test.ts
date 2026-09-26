import { afterEach, describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	resolveAgentTaskConfig,
	type SubagentConfig,
} from "../../src/async-subagents/core/config.js";
import { selectAvailableAgentModels, type SubagentModelRegistry } from "../../src/async-subagents/core/model-selection.js";
import {
	nextFallbackModel,
	rememberSessionModelFallback,
	resetSessionModelFallbacks,
	selectSessionModelWithFallback,
} from "../../src/async-subagents/core/model-fallback.js";

const ranked: SubagentConfig = {
	types: { research: { models: ["a/small", "a/medium", "b/large"], thinking: "low", promptAppend: "Evidence only." } },
};

function resolve(config: SubagentConfig = ranked, type = "research") {
	return resolveAgentTaskConfig({ id: "worker", task: "Investigate", subagentType: type }, config);
}

function registeredModel(provider: string, id: string, input: Array<"text" | "image"> = ["text"]): Model<Api> {
	return {
		provider, id, name: id, api: "openai-completions", baseUrl: "https://example.invalid",
		reasoning: false, input, contextWindow: 8192, maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

afterEach(() => resetSessionModelFallbacks());

describe("role candidate and runtime selection contract", () => {
	test("role order is authoritative and runtime availability only removes candidates", async () => {
		const resolved = resolve();
		expect(resolved.task.model).toBe("a/small");
		expect(resolved.fallbackModels).toEqual(["a/medium", "b/large"]);
		expect(resolved.task.thinking).toBe("low");
		expect(resolved.task.promptAppend).toBe("Evidence only.");

		const registry: SubagentModelRegistry = {
			find: (provider, id) => registeredModel(provider, id),
			getApiKeyAndHeaders: async (model) => ({ ok: model.id !== "small" }),
		};
		const selected = await selectAvailableAgentModels(resolved, ranked, registry);
		expect(selected.task.model).toBe("a/medium");
		expect(selected.fallbackModels).toEqual(["b/large"]);
	});

	test("runtime selection cannot invent candidates outside the role chain", async () => {
		const registry: SubagentModelRegistry = {
			find: (provider, id) => registeredModel(provider, id),
			getAvailable: () => [registeredModel("outside", "frontier")],
			getApiKeyAndHeaders: async () => ({ ok: true }),
		};
		await expect(selectAvailableAgentModels(resolve(), ranked, registry)).rejects.toThrow(/No configured candidate/);
	});

	test("require-other filters the entire fallback chain before runtime selection", async () => {
		const config: SubagentConfig = { types: { oracle: {
			models: ["openai/frontier", "anthropic/frontier", "zai/frontier", "openai/backup"],
			parentProviderPolicy: "require-other",
		} } };
		const resolved = resolveAgentTaskConfig({ id: "o", task: "Second opinion", subagentType: "oracle" }, config, { parentModel: "openai/parent" });
		expect(resolved.task.model).toBe("anthropic/frontier");
		expect(resolved.fallbackModels).toEqual(["zai/frontier"]);

		const registry: SubagentModelRegistry = {
			find: (provider, id) => registeredModel(provider, id),
			getApiKeyAndHeaders: async (model) => ({ ok: model.provider !== "anthropic" }),
		};
		const selected = await selectAvailableAgentModels(resolved, config, registry);
		expect(selected.task.model).toBe("zai/frontier");
		expect(selected.fallbackModels).toEqual([]);
	});

	test("fallback navigation follows the candidate chain rather than encoding provider diversity", () => {
		expect(nextFallbackModel("a/small", ["a/medium", "b/large"])).toBe("a/medium");
		rememberSessionModelFallback("a/small", "b/large");
		expect(selectSessionModelWithFallback("a/small", ["a/medium", "b/large"])?.model).toBe("b/large");
	});

	test("cached fallback mappings cannot escape the original candidate chain", () => {
		rememberSessionModelFallback("a/small", "outside/frontier");
		const resolved = resolve();
		expect(selectSessionModelWithFallback(resolved.task.model, resolved.fallbackModels)?.model).toBe("b/large");
	});

	test("image tasks retain only confirmed image-capable candidates", async () => {
		const config: SubagentConfig = { types: { implement: { models: ["vision/primary", "blind/backup", "vision/backup"] } } };
		const resolved = resolveAgentTaskConfig({
			id: "ui", task: "Implement the mockup", imagePaths: ["mock.png"], subagentType: "implement",
		}, config);
		const registry: SubagentModelRegistry = {
			find: (provider, id) => registeredModel(provider, id, provider === "vision" ? ["text", "image"] : ["text"]),
		};
		const selected = await selectAvailableAgentModels(resolved, config, registry);
		expect(selected.task.model).toBe("vision/primary");
		expect(selected.fallbackModels).toEqual(["vision/backup"]);
		await expect(selectAvailableAgentModels(resolved, config)).rejects.toThrow(/image support/i);
	});

	test("auth error details remain redacted", async () => {
		const registry: SubagentModelRegistry = {
			find: (provider, id) => registeredModel(provider, id),
			getApiKeyAndHeaders: async () => { throw new Error("SYNTHETIC_SECRET_DO_NOT_PRINT"); },
		};
		try {
			await selectAvailableAgentModels(resolve(), ranked, registry);
			throw new Error("Expected selection failure");
		} catch (error) {
			expect(String(error)).toContain("No configured candidate");
			expect(String(error)).not.toContain("SYNTHETIC_SECRET_DO_NOT_PRINT");
		}
	});
});
