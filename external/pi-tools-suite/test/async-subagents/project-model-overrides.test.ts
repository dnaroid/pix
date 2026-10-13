import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSubagentConfig, resolveAgentTaskConfig } from "../../src/async-subagents/core/config.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(profile = "models: [original/primary, fallback/one, fallback/two]"): string {
	const cwd = mkdtempSync(join(tmpdir(), "pix-agent-models-"));
	directories.push(cwd);
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "reviewer.md"), `---\ndescription: Review\n${profile}\n---\nReview code.\n`);
	return cwd;
}

function overrides(cwd: string, models: Record<string, string>): void {
	writeFileSync(join(cwd, ".pi", "agent-model-overrides.json"), JSON.stringify({ version: 1, models }));
}

const task = { id: "review", task: "Review code", subagentType: "reviewer" };

function candidates(resolved: ReturnType<typeof resolveAgentTaskConfig>): string[] {
	return [resolved.task.model!, ...resolved.fallbackModels];
}

test("project primary choice preserves fallbacks, authored profile, and already-loaded launches", () => {
	const cwd = fixture();
	const authored = readFileSync(join(cwd, ".pi", "agents", "reviewer.md"), "utf8");
	const old = loadSubagentConfig(cwd, {});
	overrides(cwd, { reviewer: "chosen/primary:high" });
	const config = loadSubagentConfig(cwd, {});
	expect(candidates(resolveAgentTaskConfig(task, config))).toEqual(["chosen/primary:high", "fallback/one", "fallback/two"]);
	expect(candidates(resolveAgentTaskConfig(task, old))).toEqual(["original/primary", "fallback/one", "fallback/two"]);
	expect(config.types.reviewer.models).toEqual(old.types.reviewer.models);
	expect(readFileSync(join(cwd, ".pi", "agents", "reviewer.md"), "utf8")).toBe(authored);
	overrides(cwd, {});
	writeFileSync(join(cwd, ".pi", "agents", "reviewer.md"), authored.replace("original/primary", "updated/primary"));
	expect(candidates(resolveAgentTaskConfig(task, loadSubagentConfig(cwd, {})))).toEqual(["updated/primary", "fallback/one", "fallback/two"]);
});

test("nested launches use the same owning project, without leaking into nested projects", () => {
	const cwd = fixture();
	overrides(cwd, { reviewer: "chosen/primary" });
	const nested = join(cwd, "src");
	mkdirSync(nested);
	expect(resolveAgentTaskConfig(task, loadSubagentConfig(nested, {})).task.model).toBe("chosen/primary");
	mkdirSync(join(nested, ".pi", "agents"), { recursive: true });
	writeFileSync(join(nested, ".pi", "agents", "reviewer.md"), "---\nmodel: nested/primary\n---\nReview\n");
	expect(resolveAgentTaskConfig(task, loadSubagentConfig(nested, {})).task.model).toBe("nested/primary");
});

test("project choices still obey parent provider policy", () => {
	const cwd = fixture("model: original/primary\nfallbackModels: [other/fallback]\nparentProviderPolicy: require-other");
	overrides(cwd, { reviewer: "parent/chosen" });
	expect(candidates(resolveAgentTaskConfig(task, loadSubagentConfig(cwd, {}), { parentModel: "parent/main" }))).toEqual(["other/fallback"]);
});

test("parent branches keep their fallback chains, and reset restores parent-dependent primary", () => {
	const cwd = fixture(`modelByParent:\n  parent/*:\n    model: original/parent\n    fallbackModels: [fallback/parent]\nmodel: original/default\nfallbackModels: [fallback/default]`);
	overrides(cwd, { reviewer: "chosen/primary" });
	const config = loadSubagentConfig(cwd, {});
	expect(candidates(resolveAgentTaskConfig(task, config, { parentModel: "parent/main" }))).toEqual(["chosen/primary", "fallback/parent"]);
	expect(candidates(resolveAgentTaskConfig(task, config, { parentModel: "other/main" }))).toEqual(["chosen/primary", "fallback/default"]);
	overrides(cwd, {});
	expect(resolveAgentTaskConfig(task, loadSubagentConfig(cwd, {}), { parentModel: "parent/main" }).task.model).toBe("original/parent");
});

test("explicit task, CLI, global and role environment selections retain priority", () => {
	const cwd = fixture();
	overrides(cwd, { reviewer: "chosen/primary" });
	const config = loadSubagentConfig(cwd, {});
	expect(candidates(resolveAgentTaskConfig({ ...task, model: "task/primary" }, config))).toEqual(["task/primary"]);
	expect(candidates(resolveAgentTaskConfig({ ...task, extraArgs: ["--model", "cli/primary"] }, config))).toEqual(["cli/primary"]);
	expect(resolveAgentTaskConfig(task, config, { model: "global/primary" }).task.model).toBe("global/primary");
	expect(candidates(resolveAgentTaskConfig(task, config, { forcedModel: "forced/primary" }))).toEqual(["forced/primary"]);
	expect(resolveAgentTaskConfig(task, loadSubagentConfig(cwd, { PI_SUBAGENTS_REVIEWER_MODEL: "env/primary" })).task.model).toBe("env/primary");
});

test("legacy profiles retain fallbacks and duplicates are removed", () => {
	const cwd = fixture("model: original/primary\nfallbackModels: [chosen/primary, fallback/one]");
	overrides(cwd, { reviewer: "chosen/primary" });
	expect(candidates(resolveAgentTaskConfig(task, loadSubagentConfig(cwd, {})))).toEqual(["chosen/primary", "fallback/one"]);
});

test("stale, builtin and automatic profile overrides are ignored", () => {
	const cwd = fixture("modelSelection: frontier");
	overrides(cwd, { reviewer: "chosen/primary", missing: "chosen/primary", research: "chosen/primary" });
	expect(loadSubagentConfig(cwd, {}).projectModelOverrides).toEqual({});
	writeFileSync(join(cwd, ".pi", "agents", "reviewer.md"), "---\ndescription: Automatic\n---\nReview\n");
	expect(loadSubagentConfig(cwd, {}).projectModelOverrides).toEqual({});
});

test("malformed, invalid and symbolic override files fail closed", () => {
	const cwd = fixture();
	const file = join(cwd, ".pi", "agent-model-overrides.json");
	for (const contents of ["{", '{"version":2,"models":{}}', '{"version":1,"models":{"reviewer":"pix:auto"}}', '{"version":1,"models":{"../bad":"chosen/primary"}}']) {
		writeFileSync(file, contents);
		expect(() => loadSubagentConfig(cwd, {})).toThrow();
	}
	rmSync(file);
	const target = join(cwd, "outside.json");
	writeFileSync(target, '{"version":1,"models":{}}');
	symlinkSync(target, file);
	expect(() => loadSubagentConfig(cwd, {})).toThrow("regular project-local file");
});
