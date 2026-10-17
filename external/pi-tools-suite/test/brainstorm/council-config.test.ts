import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { loadPiToolsSuiteConfig } from "../../src/config.js";
import { DEFAULT_FRONTIER_MODELS as SUITE_DEFAULT_FRONTIER } from "../../src/async-subagents/core/frontier-models.js";
import { PI_TOOLS_SUITE_MODULE_NAMES } from "../../src/module-catalog.js";
import {
	applyRunModels, assertRunnable, DEFAULT_FRONTIER_MODELS, loadCouncilConfig, normalizeOutputDir, parseRunModels, resolvedQuorum, rosterFromFrontier, thinkingForModel,
} from "../../src/brainstorm/skill/scripts/lib/config.mjs";

function layout(user: unknown, project?: unknown) {
	const homeDir = mkdtempSync(join(tmpdir(), "council-home-"));
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "council-project-")));
	mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
	writeFileSync(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), `// user layer\n${JSON.stringify(user, null, 2).replace(/\n}$/, ",\n}")}`);
	if (project !== undefined) {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "pi-tools-suite.jsonc"), JSON.stringify(project));
	}
	return { homeDir, cwd, env: {} as Record<string, string> };
}

const FRONTIER = [
	"openai/gpt-x",
	{ model: "anthropic/claude-y", expensive: true },
	{ model: "google/gemini-z", enabled: false },
	"openai/gpt-x",
	"no-provider",
	" zai/glm-5.3 ",
	"bad/*wildcard",
];

describe("council config", () => {
	test("frontier roster matches the suite loader (enabled, deduped, ordered)", () => {
		for (const [user, project] of [
			[{ frontierModels: FRONTIER }, undefined],
			[{ frontierModels: FRONTIER }, { frontierModels: ["x/one", { model: "y/two" }, { model: "z/three", enabled: false }] }],
			[{ frontierModels: FRONTIER }, { economy: true }],
			[{}, undefined],
			[{ frontierModels: FRONTIER }, { frontierModels: null }],
		] as const) {
			const options = layout(user, project);
			const suite = loadPiToolsSuiteConfig(PI_TOOLS_SUITE_MODULE_NAMES, { ...options, ensureUserConfig: false });
			const expected = rosterFromFrontier(suite.frontierModels.map((entry) => ({ model: entry.model, enabled: entry.enabled !== false })));
			const council = loadCouncilConfig(options);
			expect(council.models).toEqual(expected);
			expect(council.modelsExplicit).toBe(false);
			expect(council.models.length).toBeGreaterThan(1);
		}
	});

	test("explicit models, thinking overrides and layered settings", () => {
		const options = layout(
			{ frontierModels: ["a/one", "b/two"], brainstorm: { thinking: "medium", thinkingOverrides: { "zai/glm-5.3": "max" }, timeoutSeconds: 300 } },
			{ brainstorm: { models: ["c/three", "zai/glm-5.3", "d/four"], quorum: 3, outputDir: "notes/councils/" } },
		);
		const config = loadCouncilConfig(options);
		expect(config.models).toEqual(["c/three", "zai/glm-5.3", "d/four"]);
		expect(config.modelsExplicit).toBe(true);
		expect(config.timeoutSeconds).toBe(300);
		expect(config.outputDir).toBe("notes/councils");
		expect(resolvedQuorum(config)).toBe(3);
		expect(thinkingForModel(config, "zai/glm-5.3")).toBe("max");
		expect(thinkingForModel(config, "other/glm-5.3")).toBe("max");
		expect(thinkingForModel(config, "c/three")).toBe("medium");
		expect(config.sources).toHaveLength(2);
	});

	test("models: null in a later layer restores the frontier roster", () => {
		const config = loadCouncilConfig(layout({ frontierModels: ["a/one", "b/two"], brainstorm: { models: ["x/1", "y/2"] } }, { brainstorm: { models: null } }));
		expect(config.models).toEqual(["a/one", "b/two"]);
		expect(config.modelsExplicit).toBe(false);
	});

	test("invalid settings and empty rosters are rejected with usage code 2", () => {
		for (const brainstorm of [{ models: ["one/a"] }, { models: ["one/*", "two/b"] }, { thinking: "turbo" }, { timeoutSeconds: 10 }, { quorum: 1 }, { outputDir: "../outside" }]) {
			expect(() => loadCouncilConfig(layout({ brainstorm }))).toThrow();
		}
		const empty = loadCouncilConfig(layout({ frontierModels: [{ model: "a/one", enabled: false }] }));
		expect(empty.models).toEqual([]);
		try { assertRunnable(empty); throw new Error("expected failure"); }
		catch (error) { expect((error as { code?: number }).code).toBe(2); }
		expect(() => assertRunnable({ ...loadCouncilConfig(layout({ brainstorm: { models: ["a/1", "b/2"], quorum: 3 } })) })).toThrow(/quorum/);
	});

	test("built-in frontier and GLM effort defaults mirror the suite", () => {
		expect([...DEFAULT_FRONTIER_MODELS]).toEqual(SUITE_DEFAULT_FRONTIER.map((entry) => entry.model));
		const config = loadCouncilConfig(layout({}));
		expect(config.models).toEqual([...DEFAULT_FRONTIER_MODELS]);
		expect(thinkingForModel(config, "zai/glm-5.3")).toBe("max");
		expect(thinkingForModel(config, "anthropic/claude-opus-5-5")).toBe("high");
		const cleared = loadCouncilConfig(layout({ brainstorm: { thinkingOverrides: null } }));
		expect(thinkingForModel(cleared, "zai/glm-5.3")).toBe("high");
	});

	test("run-only models carry per-model effort", () => {
		const base = loadCouncilConfig(layout({ frontierModels: ["a/one", "b/two"] }));
		const run = applyRunModels(base, "p/one:low,q/two:max");
		expect(run.models).toEqual(["p/one", "q/two"]);
		expect(thinkingForModel(run, "q/two")).toBe("max");
		expect(() => parseRunModels("p/one:low")).toThrow();
		expect(() => parseRunModels("p/one,q/two")).toThrow(/effort/);
		expect(() => parseRunModels(["p/one:low", "p/one:high"])).toThrow();
	});

	test("output directories stay project-relative", () => {
		expect(normalizeOutputDir(".pi/brainstorms/")).toBe(".pi/brainstorms");
		for (const bad of ["/abs", "..", "../x", "a/../../b", "C:\\x", ""]) expect(() => normalizeOutputDir(bad)).toThrow();
	});
});
