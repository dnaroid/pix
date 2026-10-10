import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import workTools from "../../src/async-subagents/work-tools.js";
import { selectSubagentToolsForModel, subagentWorkTools, SUBAGENT_COMMON_TOOLS, SUBAGENT_WORK_TOOLS_ENV, withSubagentCapabilities } from "../../src/async-subagents/core/child-tools.js";
import { loadSubagentConfig } from "../../src/async-subagents/core/config.js";

const previous = process.env[SUBAGENT_WORK_TOOLS_ENV];
const roots: string[] = [];
afterEach(() => {
	if (previous === undefined) delete process.env[SUBAGENT_WORK_TOOLS_ENV];
	else process.env[SUBAGENT_WORK_TOOLS_ENV] = previous;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(tools: string[], extra: string[] = []) {
	return subagentWorkTools(withSubagentCapabilities(["--tools", tools.join(","), ...extra]));
}

function workspace(): string {
	const scratch = resolve(import.meta.dir, "../../../../.pi/artifacts/subagent-work-tools");
	mkdirSync(scratch, { recursive: true });
	const root = mkdtempSync(join(scratch, "run-"));
	roots.push(root);
	mkdirSync(join(root, ".pi", "agents"), { recursive: true });
	writeFileSync(join(root, ".pi", "pi-tools-suite.jsonc"), "{}");
	return root;
}

test("optional capabilities follow final CLI restrictions, not role names or universal grants", () => {
	expect(subagentWorkTools([])).toEqual({ optional: [] });
	expect(config(["ast_grep", "web_search"], ["--no-tools"])).toEqual({ optional: [] });
	expect(config(["ast_grep", "web_search"], ["-t", "read"])).toEqual({ optional: [] });
	expect(config(["read", "ast_grep", "web_search"], ["-xt", "ast_grep"])).toEqual({ optional: ["web_search"], readOnlySelection: ["read", "web_search", ...SUBAGENT_COMMON_TOOLS] });
	expect(selectSubagentToolsForModel("openai/gpt-test", ["read", "grep", "ast_grep", "web_fetch"])).toEqual(["read", "grep", "ast_grep", "web_fetch"]);
	expect(selectSubagentToolsForModel("openai/gpt-test", ["read", "bash", "edit", "ast_grep"])).toEqual(["read", "shell", "apply_patch", "ast_grep"]);
	expect(config(["read", "bash", "ast_grep"]).readOnlySelection).toBeUndefined();
});

test("facade registers only requested tools, no commands, and guards read-only lifecycle", async () => {
	process.env[SUBAGENT_WORK_TOOLS_ENV] = JSON.stringify(config(["read", "grep", "ast_grep", "web_search"]));
	const tools: any[] = [], commands: string[] = [];
	const handlers = new Map<string, Function>();
	const execCalls: string[][] = [];
	let active: string[] = [];
	workTools({
		registerCommand: (name: string) => commands.push(name),
		registerTool: (tool: any) => tools.push(tool),
		on: (event: string, handler: Function) => handlers.set(event, handler),
		getAllTools: () => [...tools, { name: "read" }, { name: "grep" }, { name: "shell" }, { name: "todo" }, { name: "compress" }],
		setActiveTools: (names: string[]) => { active = names; },
		exec: async (_bin: string, args: string[]) => { execCalls.push(args); return { stdout: "match", stderr: "", code: 0 }; },
	} as any);
	expect(tools.map((tool) => tool.name)).toEqual(["ast_grep", "web_search"]);
	expect(commands).toEqual([]);
	for (const event of ["session_start", "model_select", "before_agent_start"]) {
		active = ["shell", "ast_apply"];
		await handlers.get(event)!();
		expect(active).toEqual(["read", "grep", "ast_grep", "web_search", "todo", "compress"]);
	}
	for (const toolName of ["shell", "bash", "write", "Edit", "ast_apply", "web_fetch", "subagents", "question"]) expect(handlers.get("tool_call")!({ toolName }).block).toBe(true);
	for (const toolName of active) expect(handlers.get("tool_call")!({ toolName })).toBeUndefined();
	const ast = tools[0];
	await expect(ast.execute("call", { pattern: "foo()", updateAll: true }, undefined, undefined, { cwd: "." })).rejects.toThrow("read-only");
	const preview = await ast.execute("call", { pattern: "foo()", rewrite: "bar()", lang: "ts" }, undefined, undefined, { cwd: "." });
	expect(preview.details.mutated).toBe(false);
	expect(execCalls[0]).not.toContain("--update-all");
});

test("coding defaults opt into AST and research alone opts into public web", () => {
	const profiles = loadSubagentConfig(workspace(), {}).types;
	for (const name of ["implement", "implement-core", "mechanical", "oracle", "research"]) expect(profiles[name].tools).toContain("ast_grep");
	for (const [name, profile] of Object.entries(profiles)) {
		if (name === "research") {
			expect(profile.tools).toContain("web_search");
			expect(profile.tools).toContain("web_fetch");
		} else {
			expect(profile.tools ?? []).not.toContain("web_search");
			expect(profile.tools ?? []).not.toContain("web_fetch");
		}
		expect(profile.tools ?? []).not.toContain("ast_apply");
	}
});

test("project-local replacements do not inherit optional built-in work tools", () => {
	const root = workspace();
	writeFileSync(join(root, ".pi", "agents", "research.md"), "---\ndescription: Local read-only research.\ntools: [read]\n---\nRead only.\n");
	writeFileSync(join(root, ".pi", "agents", "implement.md"), "---\ndescription: Local implementation.\n---\nLocal policy.\n");
	const profiles = loadSubagentConfig(root, {}).types;
	expect(profiles.research.tools).toEqual(["read"]);
	expect(profiles.implement.tools).toBeUndefined();
	expect(config(profiles.research.tools!).optional).toEqual([]);
});

for (const modelId of ["gpt-work-offline", "claude-work-offline"]) test(`actual SDK research capabilities stay read-only (${modelId})`, async () => {
	const root = workspace();
	mkdirSync(join(root, ".git"));
	const selected = ["read", "grep", "ast_grep", "web_search", "web_fetch", ...SUBAGENT_COMMON_TOOLS];
	process.env[SUBAGENT_WORK_TOOLS_ENV] = JSON.stringify(config(selected));
	const agentDir = join(root, "agent");
	const settingsManager = SettingsManager.inMemory({ enableInstallTelemetry: false });
	const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		additionalExtensionPaths: ["../../src/model-tools/index.ts", "../../src/todo/subagent.ts", "../../src/dcp/subagent.ts", "../../src/async-subagents/work-tools.ts", "../../src/async-subagents/core/tool-guard.ts"].map((path) => fileURLToPath(new URL(path, import.meta.url))),
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const model = fauxProvider().getModel();
	model.id = modelId;
	const modelRuntime = { getModels: () => [model], getModel: () => model, getProviders: () => [], getAvailableSnapshot: () => [model], hasConfiguredAuth: () => true, isUsingOAuth: () => false } as any;
	const { session } = await createAgentSession({ cwd: root, agentDir, model, modelRuntime, settingsManager,
		sessionManager: SessionManager.inMemory(root), resourceLoader: loader, tools: selected });
	try {
		const errors: unknown[] = [];
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		expect(errors).toEqual([]);
		expect(session.getActiveToolNames().sort()).toEqual(["read", "grep", "ast_grep", "web_search", "web_fetch", "todo", "compress"].sort());
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("ast_apply");
	} finally { session.dispose(); }
});
