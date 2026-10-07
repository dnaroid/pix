import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import councilResearch from "../../src/brainstorm/research-extension.js";
import { COUNCIL_RESEARCH_TOOLS } from "../../src/brainstorm/research-tools.js";
import { installFakeIdxOnPath } from "../support/fake-idx.js";
import { SUBAGENT_WORK_TOOLS_ENV, subagentWorkTools, withSubagentCapabilities } from "../../src/async-subagents/core/child-tools.js";

const scratchRoot = resolve(import.meta.dir, "../../../../.pi/artifacts/council-research-tools");

test("council guard denies mutations, recursive tools and late activation", async () => {
	const handlers = new Map<string, Function>();
	let active = ["shell", "write"];
	const commands: string[] = [];
	const registered: string[] = [];
	councilResearch({
		registerCommand: (name: string) => commands.push(name),
		registerTool: (tool: any) => registered.push(tool.name),
		on: (event: string, handler: Function) => handlers.set(event, handler),
		getAllTools: () => [...COUNCIL_RESEARCH_TOOLS, "todo", "compress", "shell", "write"].map((name) => ({ name })),
		setActiveTools: (names: string[]) => { active = names; },
	} as any);
	expect(commands).toEqual([]);
	expect(registered).toEqual([]); // Common optional loader is the sole web owner.
	for (const event of ["session_start", "model_select", "before_agent_start"]) {
		active = ["shell", "write"];
		await handlers.get(event)!();
		expect(active).toEqual([...COUNCIL_RESEARCH_TOOLS, "todo", "compress"]);
	}
	for (const toolName of ["shell", "bash", "Bash", "write", "Edit", "apply_patch", "ast_apply", "subagents", "brainstorm", "pi_claude_code_provider_web_search", "unknown"]) {
		expect(handlers.get("tool_call")!({ toolName }).block).toBe(true);
	}
	for (const toolName of COUNCIL_RESEARCH_TOOLS) expect(handlers.get("tool_call")!({ toolName })).toBeUndefined();
	expect(handlers.get("tool_call")!({ toolName: "todo" })).toBeUndefined();
	expect(handlers.get("tool_call")!({ toolName: "compress" })).toBeUndefined();
});

for (const modelId of ["gpt-council-offline", "claude-council-offline"]) {
for (const indexed of [false, true]) test(`isolated SDK child loads actual research extension (${modelId}, indexed=${indexed})`, async () => {
	mkdirSync(scratchRoot, { recursive: true });
	const root = mkdtempSync(join(scratchRoot, "run-"));
	mkdirSync(join(root, ".git"));
	const oldCwd = process.cwd();
	const oldWorkTools = process.env[SUBAGENT_WORK_TOOLS_ENV];
	const restorePath = installFakeIdxOnPath(root);
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		process.chdir(root);
		process.env[SUBAGENT_WORK_TOOLS_ENV] = JSON.stringify(subagentWorkTools(withSubagentCapabilities(["--tools", COUNCIL_RESEARCH_TOOLS.join(",")])));
		if (indexed) mkdirSync(join(root, ".indexer-cli"));
		const agentDir = join(root, "agent");
		const settingsManager = SettingsManager.inMemory({ enableInstallTelemetry: false });
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			additionalExtensionPaths: ["../../src/model-tools/index.ts", "../../src/todo/subagent.ts", "../../src/repo-discovery/subagent.ts", "../../src/dcp/subagent.ts", "../../src/brainstorm/research-extension.ts", "../../src/async-subagents/work-tools.ts", "../../src/async-subagents/core/tool-guard.ts"].map((path) => fileURLToPath(new URL(path, import.meta.url))),
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions).toHaveLength(7);
		const model = fauxProvider().getModel();
		// Codex normally maps grep to shell. Council selection must not do so.
		model.id = modelId;
		const modelRuntime = { getModels: () => [model], getModel: () => model, getProviders: () => [], getAvailableSnapshot: () => [model], hasConfiguredAuth: () => true, isUsingOAuth: () => false } as any;
		({ session } = await createAgentSession({ cwd: root, agentDir, model, modelRuntime, settingsManager,
			sessionManager: SessionManager.inMemory(root), resourceLoader: loader, tools: [...COUNCIL_RESEARCH_TOOLS, "todo", "compress"] }));
		const errors: unknown[] = [];
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		expect(errors).toEqual([]);
		const active = session.getActiveToolNames();
		expect(active.sort()).toEqual([...COUNCIL_RESEARCH_TOOLS.filter((name) => indexed || !name.startsWith("repo_")), "todo", "compress"].sort());
		expect(session.getAllTools().some((tool) => tool.name === "subagents")).toBe(false);
	} finally {
		session?.dispose();
		process.chdir(oldCwd);
		if (oldWorkTools === undefined) delete process.env[SUBAGENT_WORK_TOOLS_ENV];
		else process.env[SUBAGENT_WORK_TOOLS_ENV] = oldWorkTools;
		restorePath();
		rmSync(root, { recursive: true, force: true });
	}
});
}
