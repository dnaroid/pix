import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPiToolsSuiteConfig } from "../../src/config.js";
import { loadSubagentConfig, resolveAgentTaskConfig, type SubagentConfig } from "../../src/async-subagents/core/config.js";

const roots: string[] = [];

function fixture(user: Record<string, unknown> = {}, project: Record<string, unknown> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-agent-models-"));
	roots.push(root);
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	const userFile = path.join(home, ".config", "pi", "pi-tools-suite.jsonc");
	const projectFile = path.join(cwd, ".pi", "pi-tools-suite.jsonc");
	for (const file of [userFile, projectFile]) fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(userFile, JSON.stringify(user));
	fs.writeFileSync(projectFile, JSON.stringify(project));
	return { cwd, home, projectFile, env: { HOME: home } };
}

function chain(config: SubagentConfig, model?: string, forcedModel?: string): string[] {
	const result = resolveAgentTaskConfig({ id: "r", task: "inspect", subagentType: "research", model }, config, { forcedModel });
	return [result.task.model!, ...result.fallbackModels];
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("merges user and project choices by role, with null clearing inherited choices", () => {
	const f = fixture({ builtinAgentModels: { research: "user/first", verify: "user/verify", mechanical: "openrouter/vendor/model:low" } }, {
		builtinAgentModels: { research: " project/first:high ", verify: null },
	});
	const merged = loadPiToolsSuiteConfig([], { cwd: f.cwd, homeDir: f.home, env: {} });
	expect(merged.builtinAgentModels).toEqual({ research: "project/first:high", mechanical: "openrouter/vendor/model:low" });
});

test("ignores malformed refs and does not erase a valid earlier layer", () => {
	const f = fixture({ builtinAgentModels: { research: "user/first" } }, {
		builtinAgentModels: { research: "invalid", verify: false, mechanical: ["provider/model"], "bad/name": "provider/model", "ui-qa": "provider/with space", oracle: "pix:auto", "knowledge-auditor": "provider/model:bogus" },
	});
	expect(loadPiToolsSuiteConfig([], { cwd: f.cwd, homeDir: f.home, env: {} }).builtinAgentModels).toEqual({ research: "user/first" });
});

test("changes only the primary, preserving fallback order and authored profile", () => {
	const f = fixture();
	const original = loadSubagentConfig(f.cwd, f.env);
	const originalChain = chain(original);
	fs.writeFileSync(f.projectFile, JSON.stringify({ builtinAgentModels: { research: "choice/primary:high" } }));
	const configured = loadSubagentConfig(f.cwd, f.env);
	expect(chain(configured)).toEqual(["choice/primary:high", ...originalChain.slice(1)]);
	expect(configured.types.research).toEqual(original.types.research);
	fs.writeFileSync(f.projectFile, JSON.stringify({ builtinAgentModels: { research: originalChain[1] } }));
	expect(chain(loadSubagentConfig(f.cwd, f.env))).toEqual([originalChain[1]!, ...originalChain.slice(2)]);
});

test("fresh launches read edits; removing a choice restores the current bundled chain", () => {
	const f = fixture();
	const oldConfig = loadSubagentConfig(f.cwd, f.env);
	const defaults = chain(oldConfig);
	fs.writeFileSync(f.projectFile, JSON.stringify({ builtinAgentModels: { research: "new/primary" } }));
	expect(chain(loadSubagentConfig(f.cwd, f.env))[0]).toBe("new/primary");
	expect(chain(oldConfig)).toEqual(defaults);
	fs.writeFileSync(f.projectFile, "{}");
	expect(chain(loadSubagentConfig(f.cwd, f.env))).toEqual(defaults);
});

test("reset of a project layer inherits user choice; null restores bundled default", () => {
	const f = fixture({ builtinAgentModels: { research: "user/primary" } }, { builtinAgentModels: { research: "project/primary" } });
	expect(chain(loadSubagentConfig(f.cwd, f.env))[0]).toBe("project/primary");
	fs.writeFileSync(f.projectFile, "{}");
	expect(chain(loadSubagentConfig(f.cwd, f.env))[0]).toBe("user/primary");
	fs.writeFileSync(f.projectFile, JSON.stringify({ builtinAgentModels: { research: null } }));
	expect(loadSubagentConfig(f.cwd, f.env).builtinModelOverrides).toEqual({});
	expect(chain(loadSubagentConfig(f.cwd, f.env))[0]).not.toBe("user/primary");
});

test("does not affect project-local replacements or their Registry choices", () => {
	const f = fixture({ disabledBuiltinAgents: ["research"], builtinAgentModels: { research: "builtin/choice" } });
	const dir = path.join(f.cwd, ".pi", "agents");
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, "research.md"), "---\nmodels: [local/primary, local/fallback]\n---\nLocal research");
	expect(chain(loadSubagentConfig(f.cwd, f.env))).toEqual(["local/primary", "local/fallback"]);
	fs.writeFileSync(path.join(f.cwd, ".pi", "agent-model-overrides.json"), JSON.stringify({ version: 1, models: { research: "registry/choice" } }));
	expect(chain(loadSubagentConfig(f.cwd, f.env))).toEqual(["registry/choice", "local/fallback"]);
});

test("ignores disabled, unknown and frontier roles without adding roles", () => {
	const f = fixture({ disabledBuiltinAgents: ["verify"], builtinAgentModels: { oracle: "wrong/oracle", verify: "wrong/verify", ghost: "wrong/ghost", research: "valid/research" } });
	const config = loadSubagentConfig(f.cwd, f.env);
	expect(config.builtinModelOverrides).toEqual({ research: "valid/research" });
	expect(config.types.verify).toBeUndefined();
	expect(config.types.ghost).toBeUndefined();
	const oracle = resolveAgentTaskConfig({ id: "o", task: "review", subagentType: "oracle" }, config, { parentModel: "openai-codex/gpt-6-luna" });
	expect(oracle.task.model).not.toBe("wrong/oracle");
});

test("keeps task, forced, global and per-role environment model priorities", () => {
	const f = fixture({ builtinAgentModels: { research: "config/primary" } });
	const config = loadSubagentConfig(f.cwd, f.env);
	expect(chain(config, "task/primary")[0]).toBe("task/primary");
	expect(chain(config, "task/primary", "forced/primary")[0]).toBe("forced/primary");
	const cli = resolveAgentTaskConfig({ id: "r", task: "inspect", subagentType: "research", extraArgs: ["--model", "cli/primary"] }, config);
	expect(cli.task.model).toBe("cli/primary");
	expect(cli.fallbackModels).toEqual([]);
	const global = resolveAgentTaskConfig({ id: "r", task: "inspect", subagentType: "research" }, config, { model: "global/primary" });
	expect(global.task.model).toBe("global/primary");
	const perRole = loadSubagentConfig(f.cwd, { ...f.env, ASYNC_SUBAGENTS_RESEARCH_MODEL: "env/primary" });
	expect(perRole.builtinModelOverrides?.research).toBeUndefined();
	expect(chain(perRole)[0]).toBe("env/primary");
});

test("continues to enforce economy and different-vendor policies", () => {
	const f = fixture({ economy: true, builtinAgentModels: { research: "openai/gpt-6-astra" } });
	expect(chain(loadSubagentConfig(f.cwd, f.env))).not.toContain("openai/gpt-6-astra");
	fs.writeFileSync(f.projectFile, JSON.stringify({ economy: false, builtinAgentModels: { research: "openai/custom" } }));
	const config = loadSubagentConfig(f.cwd, f.env);
	config.types.research = { ...config.types.research, parentProviderPolicy: "require-other" };
	const resolved = resolveAgentTaskConfig({ id: "r", task: "inspect", subagentType: "research" }, config, { parentModel: "openai/parent" });
	expect([resolved.task.model, ...resolved.fallbackModels]).not.toContain("openai/custom");
});
