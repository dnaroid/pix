import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawn as spawnChild } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPiAiMock } from "../support/pi-ai-mock.js";

const typeMock = {
	Object: (properties: any, options?: any) => ({ kind: "object", properties, options }),
	Optional: (schema: any) => ({ kind: "optional", schema }),
	String: (options?: any) => ({ kind: "string", options }),
	Array: (items: any, options?: any) => ({ kind: "array", items, options }),
	Number: (options?: any) => ({ kind: "number", options }),
	Boolean: (options?: any) => ({ kind: "boolean", options }),
};

mock.module("@earendil-works/pi-tui", () => ({
	Container: class Container {
		children: any[] = [];
		addChild(child: any) { this.children.push(child); }
	},
	Text: class Text {
		constructor(public text: string, public x = 0, public y = 0) {}
		toString() { return this.text; }
	},
	visibleWidth: (text: string) => text.replace(/<[^>]+>/g, "").length,
	truncateToWidth: (text: string, width: number, ellipsis = "…") => {
		const visible = text.replace(/<[^>]+>/g, "");
		if (visible.length <= width) return text;
		if (width <= ellipsis.length) return ellipsis.slice(0, Math.max(0, width));
		return visible.slice(0, width - ellipsis.length) + ellipsis;
	},
}));

let routerResponseText = '{"routes":[]}';
const routerCompleteMock = mock(async () => ({
	content: [{ type: "text", text: routerResponseText }],
}));

mock.module("@earendil-works/pi-ai", () => createPiAiMock({ Type: typeMock, complete: routerCompleteMock }));

const tempDirs: string[] = [];
let originalArgv1 = process.argv[1];
const originalAsyncSubagentsModel = process.env.ASYNC_SUBAGENTS_MODEL;
const originalPiSubagentsModel = process.env.PI_SUBAGENTS_MODEL;
const originalAsyncSubagentsForceCurrentModel = process.env.ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL;
const originalPiSubagentsForceCurrentModel = process.env.PI_SUBAGENTS_FORCE_CURRENT_MODEL;
const originalAsyncSubagentsEnableSessions = process.env.ASYNC_SUBAGENTS_ENABLE_SESSIONS;
const originalAsyncSubagentsConfig = process.env.ASYNC_SUBAGENTS_CONFIG;
const originalPiSubagentsConfig = process.env.PI_SUBAGENTS_CONFIG;
const originalAsyncSubagentsActivePresetFile = process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE;
const originalPiSubagentsActivePresetFile = process.env.PI_SUBAGENTS_ACTIVE_PRESET_FILE;
const originalAgentsPreset = process.env.AGENTS_PRESET;
const originalUltrawork = process.env.ULTRAWORK;
const originalUltraworkAuto = process.env.ULTRAWORK_AUTO;

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagents-tools-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeFile(filePath: string, content = ""): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function createAgent(runDir: string, id: string, files: Record<string, string> = {}): string {
	const agentDir = path.join(runDir, id);
	writeFile(path.join(agentDir, "prompt.md"), `prompt for ${id}`);
	for (const [name, content] of Object.entries(files)) writeFile(path.join(agentDir, name), content);
	return agentDir;
}

function isolateSubagentConfig(cwd: string): void {
	delete process.env.ASYNC_SUBAGENTS_MODEL;
	delete process.env.PI_SUBAGENTS_MODEL;
	process.env.ASYNC_SUBAGENTS_CONFIG = path.join(cwd, "async-subagents-test-config.json");
	writeFile(process.env.ASYNC_SUBAGENTS_CONFIG, JSON.stringify({ types: {} }));
}

function isolateSubagentConfigWithPresets(cwd: string): void {
	delete process.env.ASYNC_SUBAGENTS_MODEL;
	delete process.env.PI_SUBAGENTS_MODEL;
	process.env.ASYNC_SUBAGENTS_CONFIG = path.join(cwd, "async-subagents-test-config.json");
	process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE = path.join(cwd, "active-subagent-preset.json");
	writeFile(process.env.ASYNC_SUBAGENTS_CONFIG, JSON.stringify({
		types: {},
		presets: {
			fast: { model: "preset/fast", thinking: "minimal", extraArgs: ["--temperature", "0"] },
			deep: { model: "preset/deep", thinking: "high" },
		},
	}));
}

class FakePi {
	tools = new Map<string, any>();
	commands = new Map<string, any>();
	renderers = new Map<string, any>();
	events = new Map<string, any[]>();
	userMessages: string[] = [];
	messages: any[] = [];
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	registerCommand(name: string, command: any) { this.commands.set(name, command); }
	registerMessageRenderer(name: string, renderer: any) { this.renderers.set(name, renderer); }
	sendUserMessage(message: string) { this.userMessages.push(message); }
	sendMessage(message: any, options?: any) { this.messages.push({ message, options }); }
	on(name: string, handler: any) {
		const handlers = this.events.get(name) ?? [];
		handlers.push(handler);
		this.events.set(name, handlers);
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForChildExit(child: ReturnType<typeof spawnChild>, timeoutMs = 2000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for child process exit")), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

afterEach(async () => {
	const { resetSessionModelFallbacks, setSessionSubagentPresetOverride } = await import("../../src/async-subagents/lib.js");
	setSessionSubagentPresetOverride(undefined);
	resetSessionModelFallbacks();
	process.argv[1] = originalArgv1;
	if (originalAsyncSubagentsModel === undefined) delete process.env.ASYNC_SUBAGENTS_MODEL;
	else process.env.ASYNC_SUBAGENTS_MODEL = originalAsyncSubagentsModel;
	if (originalPiSubagentsModel === undefined) delete process.env.PI_SUBAGENTS_MODEL;
	else process.env.PI_SUBAGENTS_MODEL = originalPiSubagentsModel;
	if (originalAsyncSubagentsForceCurrentModel === undefined) delete process.env.ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL;
	else process.env.ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL = originalAsyncSubagentsForceCurrentModel;
	if (originalPiSubagentsForceCurrentModel === undefined) delete process.env.PI_SUBAGENTS_FORCE_CURRENT_MODEL;
	else process.env.PI_SUBAGENTS_FORCE_CURRENT_MODEL = originalPiSubagentsForceCurrentModel;
	if (originalAsyncSubagentsEnableSessions === undefined) delete process.env.ASYNC_SUBAGENTS_ENABLE_SESSIONS;
	else process.env.ASYNC_SUBAGENTS_ENABLE_SESSIONS = originalAsyncSubagentsEnableSessions;
	if (originalAsyncSubagentsConfig === undefined) delete process.env.ASYNC_SUBAGENTS_CONFIG;
	else process.env.ASYNC_SUBAGENTS_CONFIG = originalAsyncSubagentsConfig;
	if (originalPiSubagentsConfig === undefined) delete process.env.PI_SUBAGENTS_CONFIG;
	else process.env.PI_SUBAGENTS_CONFIG = originalPiSubagentsConfig;
	if (originalAsyncSubagentsActivePresetFile === undefined) delete process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE;
	else process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE = originalAsyncSubagentsActivePresetFile;
	if (originalPiSubagentsActivePresetFile === undefined) delete process.env.PI_SUBAGENTS_ACTIVE_PRESET_FILE;
	else process.env.PI_SUBAGENTS_ACTIVE_PRESET_FILE = originalPiSubagentsActivePresetFile;
	if (originalAgentsPreset === undefined) delete process.env.AGENTS_PRESET;
	else process.env.AGENTS_PRESET = originalAgentsPreset;
	if (originalUltrawork === undefined) delete process.env.ULTRAWORK;
	else process.env.ULTRAWORK = originalUltrawork;
	if (originalUltraworkAuto === undefined) delete process.env.ULTRAWORK_AUTO;
	else process.env.ULTRAWORK_AUTO = originalUltraworkAuto;
	routerResponseText = '{"routes":[]}';
	routerCompleteMock.mockClear();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.serial("extension entrypoint", () => {
	test.serial("registers tools and default commands without UI renderers", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		delete process.env.ASYNC_SUBAGENTS_ENABLE_SESSIONS;
		const pi = new FakePi();
		registerExtension(pi as any);

		expect([...pi.tools.keys()].sort()).toEqual(["subagents"]);
		expect([...pi.commands.keys()]).toEqual(["subagent-preset", "subagent-preset-config", "ultrawork", "ulw", "hyperplan", "sub-status", "sub-stop"]);
		expect([...pi.renderers.keys()]).toEqual([]);
	});

	test.serial("injects model-specific parallel-first/deep-work strategy prompts", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		const pi = new FakePi();
		registerExtension(pi as any);
		const beforeStartHandlers = pi.events.get("before_agent_start") ?? [];
		expect(beforeStartHandlers).toHaveLength(1);

		const handler = beforeStartHandlers[0]!;
		const glmResult = await handler({ systemPrompt: "base" }, { model: { provider: "zai", id: "glm-5.2" } });
		expect(glmResult.systemPrompt).toContain('name="parallel-first"');
		expect(glmResult.systemPrompt).toContain("ultrawork mode");

		const gptResult = await handler({ systemPrompt: "base" }, { model: { provider: "openai-codex", id: "gpt-5.5" } });
		expect(gptResult.systemPrompt).toContain('name="deep-work"');
		expect(gptResult.systemPrompt).toContain("autonomous deep worker");

		const customPromptResult = await handler({ systemPrompt: "base", systemPromptOptions: { customPrompt: "SYSTEM.md" } }, { model: { provider: "zai", id: "glm-5.2" } });
		expect(customPromptResult?.systemPrompt ?? "base").not.toContain('name="parallel-first"');
		expect(customPromptResult?.systemPrompt ?? "base").not.toContain('name="deep-work"');
	});

	test.serial("registers session navigation commands when sub-agent sessions are enabled", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		process.env.ASYNC_SUBAGENTS_ENABLE_SESSIONS = "1";
		const pi = new FakePi();
		registerExtension(pi as any);

		expect([...pi.commands.keys()]).toEqual(["subagent-preset", "subagent-preset-config", "ultrawork", "ulw", "hyperplan", "sub-status", "sub-open", "sub-back", "sub-where", "sub-stop"]);
	});

	test.serial("session shutdown kills running sub-agent processes before deleting run state", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		const { createRunDir, recordSubagentRun } = await import("../../src/async-subagents/lib.js");
		const cwd = tempDir();
		const pi = new FakePi();
		registerExtension(pi as any);
		const runDir = createRunDir(cwd, "shutdown");
		const child = spawnChild(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"], { stdio: "ignore" });
		if (!child.pid) throw new Error("Failed to spawn child process for shutdown test");

		try {
			createAgent(runDir, "agent-1", { pid: String(child.pid), started_at: new Date().toISOString() });
			recordSubagentRun(cwd, runDir, ["agent-1"]);
			const shutdownHandlers = pi.events.get("session_shutdown") ?? [];
			expect(shutdownHandlers).toHaveLength(1);

			await shutdownHandlers[0]({ reason: "exit" }, { cwd });
			await waitForChildExit(child);

			expect(isProcessAlive(child.pid)).toBe(false);
			expect(fs.existsSync(runDir)).toBe(false);
		} finally {
			if (child.pid && isProcessAlive(child.pid)) child.kill("SIGKILL");
		}
	});

	test.serial("orchestration slash commands enqueue follow-up prompts", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		const pi = new FakePi();
		registerExtension(pi as any);
		const notifications: any[] = [];
		let idleWaits = 0;
		const ctx = {
			cwd: tempDir(),
			hasUI: true,
			ui: { notify: (...args: any[]) => notifications.push(args), select: async () => undefined },
			waitForIdle: async () => { idleWaits += 1; },
			sessionManager: { getSessionFile: () => undefined },
			switchSession: async () => ({ cancelled: false }),
		};

		await pi.commands.get("ulw").handler("fix failing tests", ctx);
		expect(idleWaits).toBe(1);
		expect(pi.userMessages).toHaveLength(1);
		expect(pi.userMessages[0]).toContain("Run ultrawork mode");
		expect(pi.userMessages[0]).toContain("fix failing tests");
		expect(notifications.pop()).toEqual(["Triggered /ultrawork.", "info"]);

		await pi.commands.get("hyperplan").handler("", ctx);
		expect(pi.userMessages[1]).toContain("Run hyperplan mode");
		expect(pi.userMessages[1]).toContain("deep, implement, frontend, tests, review, and docs");
	});

	test.serial("ULTRAWORK env transforms normal input into ultrawork mode", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		process.env.ULTRAWORK = "1";
		const pi = new FakePi();
		registerExtension(pi as any);
		const inputHandlers = pi.events.get("input") ?? [];
		expect(inputHandlers.length).toBeGreaterThan(0);
		const handler = inputHandlers[inputHandlers.length - 1]!;

		const transformed = await handler({ type: "input", text: "fix auth tests", source: "interactive" });
		expect(transformed).toMatchObject({ action: "transform" });
		expect(transformed.text).toContain("Run ultrawork mode");
		expect(transformed.text).toContain("Objective:\nfix auth tests");

		expect(await handler({ type: "input", text: "/help", source: "interactive" })).toEqual({ action: "continue" });
		expect(await handler({ type: "input", text: "queued", source: "extension" })).toEqual({ action: "continue" });
		process.env.ULTRAWORK = "0";
		expect(await handler({ type: "input", text: "fix auth tests", source: "interactive" })).toEqual({ action: "continue" });
	});

	test.serial("ULTRAWORK_AUTO uses weak-router decision only for first non-GPT input", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		process.env.ULTRAWORK_AUTO = "1";
		const cwd = tempDir();
		isolateSubagentConfig(cwd);
		const pi = new FakePi();
		registerExtension(pi as any);
		const inputHandlers = pi.events.get("input") ?? [];
		const handler = inputHandlers[inputHandlers.length - 1]!;
		const model = { provider: "zai", id: "glm-5-turbo" };
		const ctx = {
			cwd,
			model,
			modelRegistry: {
				find: mock((provider: string, modelId: string) => provider === "zai" && modelId === "glm-4.5-air" ? model : undefined),
				getApiKeyAndHeaders: mock(async () => ({ ok: true as const, apiKey: "test-key" })),
			},
		};

		routerResponseText = "ultrawork";
		const transformed = await handler({ type: "input", text: "review release readiness and split the investigation", source: "interactive" }, ctx);
		expect(transformed).toMatchObject({ action: "transform" });
		expect(transformed.text).toContain("Run ultrawork mode");
		expect(routerCompleteMock).toHaveBeenCalledTimes(1);

		routerResponseText = "hint";
		expect(await handler({ type: "input", text: "fix another vague issue", source: "interactive" }, ctx)).toEqual({ action: "continue" });
		expect(routerCompleteMock).toHaveBeenCalledTimes(1);
	});

	test.serial("ULTRAWORK_AUTO skips GPT-like models without disabling normal delegation", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		process.env.ULTRAWORK_AUTO = "1";
		const cwd = tempDir();
		isolateSubagentConfig(cwd);
		const pi = new FakePi();
		registerExtension(pi as any);
		const inputHandlers = pi.events.get("input") ?? [];
		const handler = inputHandlers[inputHandlers.length - 1]!;

		const result = await handler(
			{ type: "input", text: "review this repo and delegate if useful", source: "interactive" },
			{ cwd, model: { provider: "openai", id: "gpt-5-codex" } },
		);

		expect(result).toEqual({ action: "continue" });
		expect(routerCompleteMock).not.toHaveBeenCalled();
		expect(pi.tools.has("subagents")).toBe(true);
	});

	test.serial("ULTRAWORK_AUTO hint decision appends a soft delegation hint", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		process.env.ULTRAWORK_AUTO = "1";
		const cwd = tempDir();
		isolateSubagentConfig(cwd);
		const pi = new FakePi();
		registerExtension(pi as any);
		const inputHandlers = pi.events.get("input") ?? [];
		const handler = inputHandlers[inputHandlers.length - 1]!;
		const model = { provider: "zai", id: "glm-5-turbo" };
		routerResponseText = '{"decision":"hint"}';

		const transformed = await handler(
			{ type: "input", text: "fix this bug", source: "interactive" },
			{
				cwd,
				model,
				modelRegistry: {
					find: () => model,
					getApiKeyAndHeaders: async () => ({ ok: true as const }),
				},
			},
		);

		expect(transformed).toMatchObject({ action: "transform" });
		expect(transformed.text).toContain("fix this bug");
		expect(transformed.text).toContain("Auto-ultrawork hint");
		expect(transformed.text).not.toContain("Run ultrawork mode");
	});

	test.serial("sub-agent preset commands select persistent presets from the TUI", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		const cwd = tempDir();
		isolateSubagentConfigWithPresets(cwd);
		const pi = new FakePi();
		registerExtension(pi as any);
		const notifications: string[] = [];
		const selects: any[] = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				async select(title: string, labels: string[]) {
					selects.push({ title, labels });
					return labels.find((label) => label.startsWith("deep"));
				},
				notify(message: string) { notifications.push(message); },
			},
			sessionManager: { getSessionFile: () => undefined },
			switchSession: async () => ({ cancelled: false }),
		};

		await pi.commands.get("subagent-preset").handler("", ctx);
		expect(selects[0].title).toBe("Select active sub-agent preset");
		expect(selects[0].labels).toEqual(expect.arrayContaining([expect.stringContaining("deep — model:preset/deep"), expect.stringContaining("fast — model:preset/fast")]));
		expect(notifications[0]).toContain('Active sub-agent preset "deep"');
		expect(JSON.parse(fs.readFileSync(process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE!, "utf-8")).activePreset).toBe("deep");
	});

	test.serial("sub-agent preset session command overrides public spawn only for current process", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		const cwd = tempDir();
		isolateSubagentConfigWithPresets(cwd);
		writeFile(process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE!, JSON.stringify({ activePreset: "fast" }));
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `process.stdin.on("data", () => {}); setTimeout(() => process.exit(0), 50);`);
		process.argv[1] = piScript;
		const pi = new FakePi();
		registerExtension(pi as any);
		const notifications: string[] = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { async select() { return undefined; }, notify(message: string) { notifications.push(message); } },
			sessionManager: { getSessionFile: () => undefined },
			switchSession: async () => ({ cancelled: false }),
		};

		await pi.commands.get("subagent-preset").handler("session deep", ctx);
		expect(notifications[0]).toContain('Session-only sub-agent preset "deep"');
		expect(JSON.parse(fs.readFileSync(process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE!, "utf-8")).activePreset).toBe("fast");
		let result = await pi.tools.get("subagents").execute("call", {
			action: "spawn",
			tasks: [{ id: "agent-1", task: "Run with session preset" }],
			slug: "session-preset-spawn",
			watchSeconds: 0,
		}, undefined, undefined, { cwd, sessionManager: { getSessionFile: () => undefined } });
		let piArgs = fs.readFileSync(path.join(result.details.runDir, "agent-1", "pi_args"), "utf-8");
		expect(piArgs).toContain("--model\npreset/deep");
		expect(piArgs).toContain("--thinking\nhigh");
		await waitUntil(() => fs.existsSync(path.join(result.details.runDir, "agent-1", "exit_code")));

		await pi.commands.get("subagent-preset").handler("session-clear", ctx);
		expect(notifications[1]).toContain("Runtime session sub-agent preset override cleared");
		result = await pi.tools.get("subagents").execute("call", {
			action: "spawn",
			tasks: [{ id: "agent-1", task: "Run with saved preset" }],
			slug: "saved-preset-spawn",
			watchSeconds: 0,
		}, undefined, undefined, { cwd, sessionManager: { getSessionFile: () => undefined } });
		piArgs = fs.readFileSync(path.join(result.details.runDir, "agent-1", "pi_args"), "utf-8");
		expect(piArgs).toContain("--model\npreset/fast");
		expect(piArgs).toContain("--thinking\nminimal");
		await waitUntil(() => fs.existsSync(path.join(result.details.runDir, "agent-1", "exit_code")));
	});

	test.serial("sub-agent preset command copies bundled sample when config is missing", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		const cwd = tempDir();
		const targetPath = path.join(cwd, "config", "async-subagents.jsonc");
		process.env.ASYNC_SUBAGENTS_CONFIG = targetPath;
		const pi = new FakePi();
		registerExtension(pi as any);
		const notifications: string[] = [];
		const selects: any[] = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				async select(title: string, labels: string[]) {
					selects.push({ title, labels });
					return "Copy sample asyncSubagents config";
				},
				notify(message: string) { notifications.push(message); },
			},
			sessionManager: { getSessionFile: () => undefined },
			switchSession: async () => ({ cancelled: false }),
		};

		await pi.commands.get("subagent-preset").handler("", ctx);
		expect(selects[0]).toEqual({ title: "No asyncSubagents config found", labels: ["Copy sample asyncSubagents config"] });
		expect(notifications[0]).toContain("Copied sample asyncSubagents config");
		expect(fs.existsSync(targetPath)).toBe(true);
		expect(fs.readFileSync(targetPath, "utf-8")).toContain('"presets"');

		await pi.commands.get("subagent-preset").handler("init", ctx);
		expect(notifications[1]).toContain("already exists; not overwriting");
	});

	test.serial("cleans entrypoint live tracking when a registered spawn completes", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		const pi = new FakePi();
		registerExtension(pi as any);
		const cwd = tempDir();
		isolateSubagentConfig(cwd);
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "entrypoint ok" }] }] }));
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		const result = await pi.tools.get("subagents").execute("call", {
			action: "spawn",
			tasks: [{ id: "agent-1", task: "Run through entrypoint" }],
			slug: "entrypoint-spawn",
			watchSeconds: 1,
		}, undefined, undefined, { cwd });

		expect(result.content[0].text).toContain("All scheduled agents are no longer running or queued.");
		expect(fs.readFileSync(path.join(result.details.runDir, "agent-1", "result.md"), "utf-8")).toBe("entrypoint ok");
	});

	test.serial("removes project sub-agent files when the main session closes", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		const { recordSubagentRun, getSubagentRegistryPath } = await import("../../src/async-subagents/lib.js");
		const pi = new FakePi();
		registerExtension(pi as any);
		const cwd = tempDir();
		const runRoot = path.join(cwd, ".pi", "subagents");
		const completedRun = path.join(runRoot, "2026-01-01-completed");
		const incompleteRun = path.join(runRoot, "2026-01-02-incomplete");
		createAgent(completedRun, "done", { exit_code: "0", "result.md": "ok" });
		createAgent(incompleteRun, "planned");
		recordSubagentRun(cwd, completedRun, ["done"]);
		recordSubagentRun(cwd, incompleteRun, ["planned"]);

		await pi.events.get("session_shutdown")![0]({ reason: "quit" }, { cwd });

		expect(fs.existsSync(completedRun)).toBe(false);
		expect(fs.existsSync(incompleteRun)).toBe(false);
		expect(fs.existsSync(getSubagentRegistryPath(cwd))).toBe(false);
		expect(fs.existsSync(runRoot)).toBe(false);
	});

	test.serial("keeps project sub-agent files across reload and fork shutdowns", async () => {
		const { default: registerExtension } = await import("../../src/async-subagents/index.js");
		const pi = new FakePi();
		registerExtension(pi as any);
		const cwd = tempDir();
		const runRoot = path.join(cwd, ".pi", "subagents");
		const reloadRun = path.join(runRoot, "2026-01-01-reload");
		const forkRun = path.join(runRoot, "2026-01-02-fork");
		createAgent(reloadRun, "done", { exit_code: "0" });
		createAgent(forkRun, "done", { exit_code: "0" });

		await pi.events.get("session_shutdown")![0]({ reason: "reload" }, { cwd });
		expect(fs.existsSync(reloadRun)).toBe(true);

		await pi.events.get("session_shutdown")![0]({ reason: "fork" }, { cwd });
		expect(fs.existsSync(forkRun)).toBe(true);
	});
});

describe.serial("subagents tool", () => {
		test.serial("dispatches actions through one public tool", async () => {
		const { registerSubagentsTool } = await import("../../src/async-subagents/tools/subagents.js");
		const pi = new FakePi();
		registerSubagentsTool(pi as any, new Map(), () => {});
		const tool = pi.tools.get("subagents");
		expect(tool.parameters.properties.compact).toBeUndefined();
		const cwd = tempDir();
		const runDir = path.join(cwd, "run");
		createAgent(runDir, "done", { exit_code: "0", "result.md": "wrapped ok" });
		const projectRunDir = path.join(cwd, ".pi", "subagents", "registered-run");
		createAgent(projectRunDir, "registered", { exit_code: "0", "result.md": "registry ok" });
		const { recordSubagentRun } = await import("../../src/async-subagents/lib.js");
		recordSubagentRun(cwd, projectRunDir, ["registered"]);

		const invalid = await tool.execute("call", { action: "bad" }, undefined, undefined, { cwd });
		expect(invalid).toEqual({ content: [{ type: "text", text: "Invalid subagents action. Use one of: spawn, status, wait, result, stop, cleanup." }], isError: true });

		const status = await tool.execute("call", { action: "status", runDir: "run" }, undefined, undefined, { cwd });
		expect(status.content[0].text).toContain("[done] done exit=0");
		expect(tool.renderResult(status).children).toEqual([]);
		expect(tool.renderResult({ details: { runDir, agents: [{ id: "running", status: "running" }], mode: "spawn" } }).children).toEqual([]);

		const result = await tool.execute("call", { action: "result", runDir: "run", agentId: "done" }, undefined, undefined, { cwd });
		expect(result.content[0].text).toContain("summary unavailable");
		expect(result.content[0].text).not.toContain("wrapped ok");
		expect(tool.renderResult(result).children).toEqual([]);

		const defaultStatus = await tool.execute("call", { action: "status" }, undefined, undefined, { cwd });
		expect(defaultStatus.content[0].text).toContain("[done] registered exit=0");
		const resolvedResult = await tool.execute("call", { action: "result", agentId: "registered" }, undefined, undefined, { cwd });
		expect(resolvedResult.content[0].text).toContain("summary unavailable");
		expect(resolvedResult.content[0].text).not.toContain("registry ok");
	});
});

describe.serial("status tool", () => {
	test.serial("returns no-agent, filtered, and validated status results", async () => {
		const { registerStatusTool } = await import("../../src/async-subagents/tools/status.js");
		const pi = new FakePi();
		registerStatusTool(pi as any);
		const tool = pi.tools.get("async_subagents_status");
		expect(tool.label).toBe("Subagent Status Action");

		const cwd = tempDir();
		const empty = await tool.execute("call", { runDir: "missing" }, undefined, undefined, { cwd });
		expect(empty.content[0].text).toBe("No agents found in run directory.");
		expect(empty.details).toMatchObject({ runDir: path.join(cwd, "missing"), agents: [], mode: "status" });

		const runDir = path.join(cwd, "run");
		createAgent(runDir, "done", { exit_code: "0", started_at: "2024-01-01T00:00:00Z", finished_at: "2024-01-01T00:00:01Z" });
		createAgent(runDir, "failed", { exit_code: "3" });
		const result = await tool.execute("call", { runDir: "run", agentIds: ["done"] }, undefined, undefined, { cwd });
		expect(result.content[0].text).toContain("[done] done exit=0 started=2024-01-01T00:00:00Z finished=2024-01-01T00:00:01Z");
		expect(result.content[0].text).not.toContain("failed");
		expect(result.details.agents).toHaveLength(1);
		expect(tool.renderCall().children).toEqual([]);
		expect(tool.renderResult(result).children).toEqual([]);
		expect(tool.renderResult({ details: { agents: [] } }).text).toBe("No agents found.");
		expect(() => tool.execute("call", { runDir: "run", agentIds: ["../bad"] }, undefined, undefined, { cwd })).toThrow();
	});
});

describe.serial("result tool", () => {
	test.serial("reads missing and compact agent output without inlining raw logs", async () => {
		const { registerResultTool } = await import("../../src/async-subagents/tools/result.js");
		const pi = new FakePi();
		registerResultTool(pi as any);
		const tool = pi.tools.get("async_subagents_result");
		expect(tool.parameters.properties.compact).toBeUndefined();
		const cwd = tempDir();
		const runDir = path.join(cwd, "run");
		const { recordSubagentRun } = await import("../../src/async-subagents/lib.js");

		const missing = await tool.execute("call", { runDir: "run", agentId: "missing" }, undefined, undefined, { cwd });
		expect(missing.isError).toBe(true);
		expect(missing.content[0].text).toContain('Agent "missing" not found');

		createAgent(runDir, "agent-1", {
			exit_code: "0",
			"result.md": "r".repeat(9000),
			"stderr.log": "s".repeat(2500),
		});
		createAgent(runDir, "running", {
			pid: String(process.pid),
			"result.md": "partial",
		});
		recordSubagentRun(cwd, runDir, ["agent-1", "running"]);
		const compact = await tool.execute("call", { runDir: "run", agentId: "agent-1" }, undefined, undefined, { cwd });
		expect(compact.content[0].text).toContain("Status: done");
		expect(compact.content[0].text).toContain("Exit code: 0");
		expect(compact.content[0].text).toContain("summary unavailable");
		expect(compact.content[0].text).toContain(`Full result: ${path.join("run", "agent-1", "result.md")}`);
		expect(compact.details).toMatchObject({ runDir, agentId: "agent-1", exitCode: 0 });

		expect(compact.content[0].text).toContain(`Full stderr: ${path.join("run", "agent-1", "stderr.log")}`);
		expect(compact.content[0].text).not.toContain("r".repeat(9000));
		expect(compact.content[0].text).not.toContain("s".repeat(2500));
		const running = await tool.execute("call", { runDir: "run", agentId: "running" }, undefined, undefined, { cwd });
		expect(running.content[0].text).toContain("Agent is still running");
		const resolved = await tool.execute("call", { agentId: "agent-1" }, undefined, undefined, { cwd });
		expect(resolved.content[0].text).toContain("Status: done");
		expect(resolved.details.runDir).toBe(runDir);
		expect(tool.renderCall().children).toEqual([]);
		expect(tool.renderResult().children).toEqual([]);
		expect(() => tool.execute("call", { runDir: "run", agentId: "../bad" }, undefined, undefined, { cwd })).toThrow();
	});
});

describe.serial("wait tool", () => {
	test.serial("polls until completion or fail-fast", async () => {
		const { registerWaitTool } = await import("../../src/async-subagents/tools/wait.js");
		const pi = new FakePi();
		registerWaitTool(pi as any);
		const tool = pi.tools.get("async_subagents_wait");
		const cwd = tempDir();
		const runDir = path.join(cwd, "run");
		createAgent(runDir, "failed", { exit_code: "1" });
		createAgent(runDir, "running", { pid: String(process.pid) });
		const updates: any[] = [];
		const result = await tool.execute("call", { runDir: "run", timeout: 10, interval: 1, failFast: true }, undefined, (update: any) => updates.push(update), { cwd });
		expect(result.content[0].text).toContain("Wait complete: 0 done, 1 failed, 0 stopped, 1 still running");
		expect(result.details.mode).toBe("wait");
		expect(updates.length).toBeGreaterThan(0);
		expect(tool.renderCall().children).toEqual([]);
		expect(tool.renderResult().children).toEqual([]);
		expect(() => tool.execute("call", { runDir: "run", agentIds: ["bad/id"] }, undefined, undefined, { cwd })).toThrow();
	});
});

describe.serial("stop tool", () => {
	test.serial("stops running agents and validates inputs", async () => {
		const { registerStopTool } = await import("../../src/async-subagents/tools/stop.js");
		const pi = new FakePi();
		registerStopTool(pi as any);
		const tool = pi.tools.get("async_subagents_stop");
		const cwd = tempDir();
		const runDir = path.join(cwd, "run");
		const child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
		if (!child.pid) throw new Error("child process did not start");

		try {
			const missing = await tool.execute("call", { runDir: "missing" }, undefined, undefined, { cwd });
			expect(missing.content[0].text).toBe("No agents found in run directory.");

			createAgent(runDir, "running", { pid: String(child.pid) });
			createAgent(runDir, "done", { exit_code: "0" });
			const result = await tool.execute("call", { runDir: "run", agentIds: ["running"], force: true }, undefined, undefined, { cwd });
			expect(result.content[0].text).toContain("Stop requested in");
			expect(result.content[0].text).toContain(`[stopped] running (pid ${child.pid}) signal=SIGKILL`);
			expect(result.details).toMatchObject({ runDir, mode: "stop" });
			expect(fs.readFileSync(path.join(runDir, "running", "exit_code"), "utf-8")).toBe("stopped");
			expect(tool.renderCall().children).toEqual([]);
			expect(tool.renderResult().children).toEqual([]);
			expect(() => tool.execute("call", { runDir: "run", agentIds: ["bad/id"] }, undefined, undefined, { cwd })).toThrow();
			let invalidSignalError: unknown;
			try {
				await tool.execute("call", { runDir: "run", signal: "SIGHUP" }, undefined, undefined, { cwd });
			} catch (error) {
				invalidSignalError = error;
			}
			expect(invalidSignalError).toBeInstanceOf(Error);
			expect((invalidSignalError as Error).message).toContain("Unsupported stop signal");
		} finally {
			try {
				process.kill(child.pid, 0);
				process.kill(child.pid, "SIGKILL");
			} catch {
				/* already stopped */
			}
		}
	});
});

describe.serial("cleanup tool", () => {
	test.serial("refuses unsafe roots, dry-runs, and deletes candidates", async () => {
		const { registerCleanupTool } = await import("../../src/async-subagents/tools/cleanup.js");
		const pi = new FakePi();
		registerCleanupTool(pi as any);
		const tool = pi.tools.get("async_subagents_cleanup");
		const cwd = tempDir();
		const fileCwd = path.join(tempDir(), "not-a-directory");
		writeFile(fileCwd, "file blocks .pi creation");
		const rootFailure = await tool.execute("call", {}, undefined, undefined, { cwd: fileCwd });
		expect(rootFailure.isError).toBe(true);
		expect(rootFailure.content[0].text).toContain("Could not create or resolve run root");

		const missingRoot = await tool.execute("call", { runRoot: "missing" }, undefined, undefined, { cwd });
		expect(missingRoot.content[0].text).toContain("Run root does not exist");

		const outside = tempDir();
		const refused = await tool.execute("call", { runRoot: outside, delete: true }, undefined, undefined, { cwd });
		expect(refused.isError).toBe(true);
		expect(refused.content[0].text).toContain("Refusing to delete outside");

		const runRoot = path.join(cwd, ".pi", "subagents");
		const candidate = path.join(runRoot, "2024-01-01-old");
		createAgent(candidate, "agent-1", { exit_code: "0" });
		const old = new Date(Date.now() - 10_000);
		fs.utimesSync(candidate, old, old);

		const dryRun = await tool.execute("call", { days: 0, keep: 0 }, undefined, undefined, { cwd });
		expect(dryRun.content[0].text).toContain("Dry run. Would delete 1 completed run(s):");
		expect(dryRun.details).toEqual({ candidates: [candidate], deleted: false });
		expect(fs.existsSync(candidate)).toBe(true);

		const deleted = await tool.execute("call", { days: 0, keep: 0, delete: true }, undefined, undefined, { cwd });
		expect(deleted.content[0].text).toContain("Deleted 1 completed run(s):");
		expect(deleted.details).toEqual({ candidates: [candidate], deleted: true });
		expect(fs.existsSync(candidate)).toBe(false);

		const none = await tool.execute("call", { days: 0, keep: 0 }, undefined, undefined, { cwd });
		expect(none.content[0].text).toContain("No cleanup candidates");
	});
});

describe.serial("spawn tool", () => {
		test.serial("validates tasks, spawns agents, streams updates, renders results, and cleans live tracking", async () => {
		const { registerSpawnTool } = await import("../../src/async-subagents/tools/spawn.js");
		const pi = new FakePi();
		const liveAgents = new Map<string, Map<string, any>>();
		const handleCompletion = ({ runDir, agentId }: any) => {
			const liveRun = liveAgents.get(runDir);
			liveRun?.delete(agentId);
			if (liveRun?.size === 0) liveAgents.delete(runDir);
		};
		registerSpawnTool(pi as any, liveAgents, handleCompletion);
		const tool = pi.tools.get("async_subagents_spawn");
		const cwd = tempDir();
		isolateSubagentConfig(cwd);

		const invalid = await tool.execute("call", { tasks: [] }, undefined, undefined, { cwd });
		expect(invalid).toEqual({ content: [{ type: "text", text: "spawn requires at least one task in the tasks array." }], details: {}, isError: true });

		const blockedRunDir = path.join(cwd, "blocked-run");
		writeFile(blockedRunDir, "not a directory");
		let blockedRunError: unknown;
		try {
			await tool.execute("call", { tasks: [{ id: "agent-1", task: "will fail" }], runDir: "blocked-run" }, undefined, undefined, { cwd });
		} catch (error) {
			blockedRunError = error;
		}
		expect(blockedRunError).toBeInstanceOf(Error);
		expect(liveAgents.size).toBe(0);

		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  console.error("stderr from fake pi");
  console.log(JSON.stringify({ type: "response", command: "get_state", success: true, data: { sessionFile: "/tmp/fake-sub-session.jsonl" } }));
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "spawned ok" }] }] }));
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;
		const updates: any[] = [];
		const result = await tool.execute("call", {
			tasks: [{ id: "agent-1", task: "Run fake agent", scope: "test scope", tools: ["read"] }],
			slug: "tool-spawn",
			thinking: "low",
			extraArgs: ["--some-flag"],
			watchSeconds: 1,
		}, undefined, (update: any) => updates.push(update), { cwd });

		expect(result.content[0].text).toContain("Scheduled 1 agent(s) in");
		expect(result.content[0].text).toContain("Started 1 agent(s) so far; maxConcurrent=5 (project-wide).");
		expect(result.content[0].text).toContain("All scheduled agents are no longer running or queued.");
		expect(result.details.mode).toBe("spawn");
		expect(result.details.tasks).toEqual([{ id: "agent-1", task: "Run fake agent", scope: "test scope" }]);
		expect(updates.length).toBeGreaterThan(0);
		const runDir = result.details.runDir;
		const registry = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "subagents", "registry.json"), "utf-8"));
		expect(registry.latestRunDir).toBe(runDir);
		expect(registry.agents["agent-1"].runDir).toBe(runDir);
		expect(fs.readFileSync(path.join(runDir, "agent-1", "result.md"), "utf-8")).toBe("spawned ok");
		expect(fs.readFileSync(path.join(runDir, "agent-1", "session_file"), "utf-8")).toBe("/tmp/fake-sub-session.jsonl");
		expect(fs.readFileSync(path.join(runDir, "agent-1", "pi_args"), "utf-8")).toContain("--no-session");
		expect(fs.readFileSync(path.join(runDir, "agent-1", "pi_args"), "utf-8")).not.toContain("--session-dir");
		expect(fs.readFileSync(path.join(runDir, "agent-1", "pi_args"), "utf-8")).toContain("--thinking\nlow\n--some-flag");
		await waitUntil(() => liveAgents.size === 0);

		expect(tool.renderCall().children).toEqual([]);
		const rendered = tool.renderResult(result, { expanded: true }, { fg: (_: string, text: string) => text, bold: (text: string) => text }).render(80).join("\n");
		expect(rendered).toContain("Started 1 subagent");
		expect(rendered).toContain("agent-1:");
		expect(rendered).toContain("Run fake agent");
		expect(tool.renderResult({ content: [{ type: "text", text: "fallback" }] }, {}, {}).text).toBe("fallback");
	});

	test.serial("writes structured result.json with configured maxResultBytes from spawn", async () => {
		const { registerSpawnTool } = await import("../../src/async-subagents/tools/spawn.js");
		const pi = new FakePi();
		const liveAgents = new Map<string, Map<string, any>>();
		registerSpawnTool(pi as any, liveAgents, ({ runDir, agentId }: any) => {
			const liveRun = liveAgents.get(runDir);
			liveRun?.delete(agentId);
			if (liveRun?.size === 0) liveAgents.delete(runDir);
		});
		const tool = pi.tools.get("async_subagents_spawn");
		const cwd = tempDir();
		process.env.ASYNC_SUBAGENTS_CONFIG = path.join(cwd, "async-subagents-test-config.json");
		writeFile(process.env.ASYNC_SUBAGENTS_CONFIG, JSON.stringify({ maxResultBytes: 3, types: {} }));

		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "abcdef" }] }] }));
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		const result = await tool.execute("call", {
			tasks: [{ id: "agent-1", task: "Return long result" }],
			slug: "structured-max-bytes",
			watchSeconds: 1,
		}, undefined, undefined, { cwd });

		const structured = JSON.parse(fs.readFileSync(path.join(result.details.runDir, "agent-1", "result.json"), "utf-8"));
		expect(structured).toMatchObject({
			agentId: "agent-1",
			status: "done",
			resultText: "abc",
			resultTruncated: true,
			resultOriginalBytes: 6,
		});
		await waitUntil(() => liveAgents.size === 0);
	});

	test.serial("result tool defaults to summary-first output with artifact paths", async () => {
		const { registerResultTool } = await import("../../src/async-subagents/tools/result.js");
		const pi = new FakePi();
		registerResultTool(pi as any);
		const tool = pi.tools.get("async_subagents_result");
		const cwd = tempDir();
		const runDir = path.join(cwd, ".pi", "subagents", "run-1");
		createAgent(runDir, "agent-1", {
			"exit_code": "0",
			"result.md": "Short summary\n\nRAW-DETAIL-SHOULD-NOT-APPEAR",
			"stderr.log": "stderr raw detail",
			"result.json": JSON.stringify({
				schemaVersion: 2,
				agentId: "agent-1",
				status: "done",
				exitCode: 0,
				durationSeconds: 3,
				subagentType: "review",
				model: "test/model",
				summary: "Short summary",
				confidence: "high",
				findings: [{ text: "Fix thing", severity: "high", file: "src/foo.ts", line: 12 }],
				files: [{ path: "src/foo.ts", line: 12 }],
				risks: [{ text: "Risk detail", severity: "medium" }],
				nextActions: ["Add regression test"],
				stderrPreview: "stderr raw detail",
			}),
		});

		const compact = await tool.execute("call", { runDir, agentId: "agent-1" }, undefined, undefined, { cwd });
		const compactText = compact.content[0].text;
		expect(compactText).toContain("Summary:\nShort summary");
		expect(compactText).toContain("Findings:\n- Fix thing (severity=high, file=src/foo.ts:12)");
		expect(compactText).toContain("Referenced files:\n- src/foo.ts:12");
		expect(compactText).toContain("Risks:\n- [medium] Risk detail");
		expect(compactText).toContain("Next actions:\n- Add regression test");
		expect(compactText).toContain(`Full result: ${path.join(".pi", "subagents", "run-1", "agent-1", "result.md")}`);
		expect(compactText).toContain(`Structured result: ${path.join(".pi", "subagents", "run-1", "agent-1", "result.json")}`);
		expect(compactText).toContain(`Full stderr: ${path.join(".pi", "subagents", "run-1", "agent-1", "stderr.log")}`);
		expect(compactText).toContain("Raw result/stderr are intentionally not inlined");
		expect(compactText).not.toContain("--- Result ---");
		expect(compactText).not.toContain("RAW-DETAIL-SHOULD-NOT-APPEAR");
		expect(compact.details.artifacts).toEqual({
			resultMd: path.join(".pi", "subagents", "run-1", "agent-1", "result.md"),
			resultJson: path.join(".pi", "subagents", "run-1", "agent-1", "result.json"),
			stderrLog: path.join(".pi", "subagents", "run-1", "agent-1", "stderr.log"),
		});

		expect(compactText).not.toContain("--- Stderr ---");
	});

	test.serial("queues excess agents without blocking spawn when maxConcurrent is reached", async () => {
		const { registerSpawnTool } = await import("../../src/async-subagents/tools/spawn.js");
		const pi = new FakePi();
		const liveAgents = new Map<string, Map<string, any>>();
		registerSpawnTool(pi as any, liveAgents, ({ runDir, agentId }: any) => {
			const liveRun = liveAgents.get(runDir);
			liveRun?.delete(agentId);
			if (liveRun?.size === 0) liveAgents.delete(runDir);
		});
		const tool = pi.tools.get("async_subagents_spawn");
		const cwd = tempDir();
		process.env.ASYNC_SUBAGENTS_CONFIG = path.join(cwd, "async-subagents-test-config.json");
		writeFile(process.env.ASYNC_SUBAGENTS_CONFIG, JSON.stringify({ maxConcurrent: 1, types: {} }));

		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  setTimeout(() => {
    console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "queued ok" }] }] }));
  }, 700);
});
setTimeout(() => {}, 2000);
`);
		process.argv[1] = piScript;

		const startedAt = Date.now();
		const result = await tool.execute("call", {
			tasks: [
				{ id: "agent-1", task: "First queued task" },
				{ id: "agent-2", task: "Second queued task" },
			],
			slug: "queued-spawn",
			watchSeconds: 0,
		}, undefined, undefined, { cwd });
		const elapsedMs = Date.now() - startedAt;

		expect(elapsedMs).toBeLessThan(500);
		expect(result.content[0].text).toContain("Scheduled 2 agent(s) in");
		expect(result.content[0].text).toContain("maxConcurrent=1");
		expect(fs.existsSync(path.join(result.details.runDir, "prompts", "agent-1.md"))).toBe(true);
		expect(fs.existsSync(path.join(result.details.runDir, "prompts", "agent-2.md"))).toBe(true);
		expect(liveAgents.get(result.details.runDir)?.size).toBe(2);

		await waitUntil(() => liveAgents.size === 0, 2500);
		expect(fs.readFileSync(path.join(result.details.runDir, "agent-1", "result.md"), "utf-8")).toBe("queued ok");
		expect(fs.readFileSync(path.join(result.details.runDir, "agent-2", "result.md"), "utf-8")).toBe("queued ok");
	});

	test.serial("stops queued agents before their concurrency slot opens", async () => {
		const { registerSpawnTool } = await import("../../src/async-subagents/tools/spawn.js");
		const { registerStopTool } = await import("../../src/async-subagents/tools/stop.js");
		const pi = new FakePi();
		const liveAgents = new Map<string, Map<string, any>>();
		registerSpawnTool(pi as any, liveAgents, ({ runDir, agentId }: any) => {
			const liveRun = liveAgents.get(runDir);
			liveRun?.delete(agentId);
			if (liveRun?.size === 0) liveAgents.delete(runDir);
		});
		registerStopTool(pi as any, liveAgents);
		const spawnTool = pi.tools.get("async_subagents_spawn");
		const stopTool = pi.tools.get("async_subagents_stop");
		const cwd = tempDir();
		process.env.ASYNC_SUBAGENTS_CONFIG = path.join(cwd, "async-subagents-test-config.json");
		writeFile(process.env.ASYNC_SUBAGENTS_CONFIG, JSON.stringify({ maxConcurrent: 1, types: {} }));

		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {});
setInterval(() => {}, 1000);
`);
		process.argv[1] = piScript;

		const result = await spawnTool.execute("call", {
			tasks: [
				{ id: "agent-1", task: "Hold the slot" },
				{ id: "agent-2", task: "Queued task" },
			],
			slug: "queued-stop",
			watchSeconds: 0,
		}, undefined, undefined, { cwd });

		const runDir = result.details.runDir;
		expect(liveAgents.get(runDir)?.has("agent-2")).toBe(true);
		const stoppedQueued = await stopTool.execute("call", { runDir, agentIds: ["agent-2"] }, undefined, undefined, { cwd });
		expect(stoppedQueued.content[0].text).toContain("[stopped] agent-2");
		expect(fs.readFileSync(path.join(runDir, "agent-2", "exit_code"), "utf-8")).toBe("stopped");
		expect(liveAgents.get(runDir)?.has("agent-2")).not.toBe(true);

		await stopTool.execute("call", { runDir, agentIds: ["agent-1"], force: true }, undefined, undefined, { cwd });
		await waitUntil(() => liveAgents.size === 0, 1500);
		expect(fs.existsSync(path.join(runDir, "agent-2", "pid"))).toBe(false);
	});

	test.serial("AGENTS_PRESET overrides active persistent sub-agent preset for future spawns", async () => {
		const { registerSpawnTool } = await import("../../src/async-subagents/tools/spawn.js");
		const pi = new FakePi();
		const liveAgents = new Map<string, Map<string, any>>();
		registerSpawnTool(pi as any, liveAgents, ({ runDir, agentId }: any) => {
			const liveRun = liveAgents.get(runDir);
			liveRun?.delete(agentId);
			if (liveRun?.size === 0) liveAgents.delete(runDir);
		});
		const tool = pi.tools.get("async_subagents_spawn");
		const cwd = tempDir();
		isolateSubagentConfigWithPresets(cwd);
		writeFile(process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE!, JSON.stringify({ activePreset: "fast" }));
		process.env.AGENTS_PRESET = "deep";

		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "preset ok" }] }] }));
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		const result = await tool.execute("call", {
			tasks: [{ id: "agent-1", task: "Run with active preset" }],
			slug: "preset-spawn",
			watchSeconds: 1,
		}, undefined, undefined, { cwd });

		const piArgs = fs.readFileSync(path.join(result.details.runDir, "agent-1", "pi_args"), "utf-8");
		expect(piArgs).toContain("--model\npreset/deep");
		expect(piArgs).toContain("--thinking\nhigh");
		expect(piArgs).not.toContain("--temperature\n0");
		expect(JSON.parse(fs.readFileSync(process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE!, "utf-8")).activePreset).toBe("fast");
		await waitUntil(() => liveAgents.size === 0);
	});

	test.serial("spawn tool falls back from exhausted preset providers for the current process", async () => {
		const { registerSpawnTool } = await import("../../src/async-subagents/tools/spawn.js");
		const pi = new FakePi();
		const liveAgents = new Map<string, Map<string, any>>();
		registerSpawnTool(pi as any, liveAgents, ({ runDir, agentId }: any) => {
			const liveRun = liveAgents.get(runDir);
			liveRun?.delete(agentId);
			if (liveRun?.size === 0) liveAgents.delete(runDir);
		});
		const tool = pi.tools.get("async_subagents_spawn");
		const cwd = tempDir();
		const attemptFile = path.join(cwd, "models.json");
		process.env.ASYNC_SUBAGENTS_CONFIG = path.join(cwd, "async-subagents-test-config.json");
		process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE = path.join(cwd, "active-subagent-preset.json");
		writeFile(process.env.ASYNC_SUBAGENTS_CONFIG, JSON.stringify({
			types: { quick: {} },
			presets: { fast: { types: { quick: { model: "preset/primary", fallbackModels: ["fallback/quick"], thinking: "off" } } } },
		}));
		writeFile(process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE, JSON.stringify({ activePreset: "fast" }));

		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
const fs = require("node:fs");
const attemptFile = ${JSON.stringify(attemptFile)};
process.stdin.on("data", () => {
  const model = process.argv[process.argv.indexOf("--model") + 1];
  const models = fs.existsSync(attemptFile) ? JSON.parse(fs.readFileSync(attemptFile, "utf8")) : [];
  models.push(model);
  fs.writeFileSync(attemptFile, JSON.stringify(models));
  if (model === "preset/primary") {
    console.log(JSON.stringify({ type: "response", command: "prompt", success: false, error: "429 quota exceeded for preset/primary" }));
  } else {
    console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok " + model }] }] }));
  }
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		const first = await tool.execute("call", {
			tasks: [{ id: "agent-1", task: "Quick fallback check" }],
			slug: "preset-fallback-first",
			watchSeconds: 1,
		}, undefined, undefined, { cwd });
		await waitUntil(() => liveAgents.size === 0);
		expect(fs.readFileSync(path.join(first.details.runDir, "agent-1", "result.md"), "utf-8")).toBe("ok fallback/quick");
		expect(fs.readFileSync(path.join(first.details.runDir, "agent-1", "model_fallback_to"), "utf-8")).toBe("fallback/quick");

		const second = await tool.execute("call", {
			tasks: [{ id: "agent-2", task: "Quick fallback check again" }],
			slug: "preset-fallback-second",
			watchSeconds: 1,
		}, undefined, undefined, { cwd });
		await waitUntil(() => liveAgents.size === 0);

		expect(JSON.parse(fs.readFileSync(attemptFile, "utf-8"))).toEqual(["preset/primary", "fallback/quick", "fallback/quick"]);
		expect(fs.readFileSync(path.join(second.details.runDir, "agent-2", "model"), "utf-8")).toBe("fallback/quick");
	});

	test.serial("rejects unknown AGENTS_PRESET without falling back to saved preset", async () => {
		const { registerSpawnTool } = await import("../../src/async-subagents/tools/spawn.js");
		const pi = new FakePi();
		registerSpawnTool(pi as any, new Map(), () => {});
		const tool = pi.tools.get("async_subagents_spawn");
		const cwd = tempDir();
		isolateSubagentConfigWithPresets(cwd);
		writeFile(process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE!, JSON.stringify({ activePreset: "fast" }));
		process.env.AGENTS_PRESET = "missing";

		const result = await tool.execute("call", {
			tasks: [{ id: "agent-1", task: "Run with active preset" }],
			slug: "missing-preset-spawn",
			watchSeconds: 0,
		}, undefined, undefined, { cwd });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("AGENTS_PRESET=missing does not match any preset");
	});

	test.serial("does not terminate sub-agent auto-retries after an error agent_end", async () => {
		const { registerSpawnTool } = await import("../../src/async-subagents/tools/spawn.js");
		const pi = new FakePi();
		const liveAgents = new Map<string, Map<string, any>>();
		registerSpawnTool(pi as any, liveAgents, ({ runDir, agentId }: any) => {
			const liveRun = liveAgents.get(runDir);
			liveRun?.delete(agentId);
			if (liveRun?.size === 0) liveAgents.delete(runDir);
		});
		const tool = pi.tools.get("async_subagents_spawn");
		const cwd = tempDir();
		isolateSubagentConfig(cwd);

		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
let started = false;
process.stdin.on("data", () => {
  if (started) return;
  started = true;
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 Rate limit reached for requests" }] }));
  console.log(JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "429 Rate limit reached for requests" }));
  setTimeout(() => {
    console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "retried ok" }] }] }));
  }, 100);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		const result = await tool.execute("call", {
			tasks: [{ id: "agent-1", task: "Run fake retrying agent" }],
			slug: "tool-spawn-retry",
			watchSeconds: 1,
		}, undefined, undefined, { cwd });

		const runDir = result.details.runDir;
		expect(fs.readFileSync(path.join(runDir, "agent-1", "exit_code"), "utf-8")).toBe("0");
		expect(fs.readFileSync(path.join(runDir, "agent-1", "result.md"), "utf-8")).toBe("retried ok");
		await waitUntil(() => liveAgents.size === 0);
	});

	test.serial("routes agents through configured subagent type models", async () => {
		const { registerSpawnTool } = await import("../../src/async-subagents/tools/spawn.js");
		const pi = new FakePi();
		const liveAgents = new Map<string, Map<string, any>>();
		registerSpawnTool(pi as any, liveAgents, ({ runDir, agentId }: any) => {
			const liveRun = liveAgents.get(runDir);
			liveRun?.delete(agentId);
			if (liveRun?.size === 0) liveAgents.delete(runDir);
		});
		const tool = pi.tools.get("async_subagents_spawn");
		const cwd = tempDir();
		process.env.ASYNC_SUBAGENTS_CONFIG = path.join(cwd, ".pi", "async-subagents.json");
		delete process.env.ASYNC_SUBAGENTS_MODEL;
		delete process.env.PI_SUBAGENTS_MODEL;
		writeFile(process.env.ASYNC_SUBAGENTS_CONFIG, JSON.stringify({
			types: {
				scan: { model: "fast/scan", thinking: "off", tools: ["read", "grep"] },
				review: { model: "smart/review", thinking: "high", extraArgs: ["--temperature", "0.1"], promptAppend: "Review-only instruction for {task}" },
			},
		}));
		routerResponseText = JSON.stringify({
			routes: [
				{ id: "scan-agent", subagentType: "scan" },
				{ id: "review-agent", subagentType: "review" },
			],
		});

		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "response", command: "get_state", success: true, data: { sessionFile: "/tmp/fake-typed-session.jsonl" } }));
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "typed ok" }] }] }));
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		const result = await tool.execute("call", {
			tasks: [
				{ id: "scan-agent", task: "Scan files for API routes" },
				{ id: "review-agent", task: "Code review payment module" },
			],
			slug: "typed-spawn",
			watchSeconds: 1,
		}, undefined, undefined, {
			cwd,
			modelRegistry: {
				find: (provider: string, modelId: string) => ({ provider, id: modelId }),
				getApiKeyAndHeaders: async () => ({ ok: true }),
			},
		});

		const runDir = result.details.runDir;
		expect(result.content[0].text).toContain("LLM-routed 2 inferred subagent type(s).");
		expect(routerCompleteMock).toHaveBeenCalled();
		expect(fs.readFileSync(path.join(runDir, "scan-agent", "pi_args"), "utf-8")).toContain("--model\nfast/scan\n--tools\nRead,Grep\n--thinking\noff");
		expect(fs.readFileSync(path.join(runDir, "scan-agent", "subagent_type"), "utf-8")).toBe("scan");
		expect(fs.readFileSync(path.join(runDir, "review-agent", "pi_args"), "utf-8")).toContain("--model\nsmart/review\n--thinking\nhigh\n--temperature\n0.1");
		expect(fs.readFileSync(path.join(runDir, "review-agent", "subagent_type"), "utf-8")).toBe("review");
		expect(fs.readFileSync(path.join(runDir, "review-agent", "prompt.md"), "utf-8")).toContain("Additional instructions from sub-agent profile:\nReview-only instruction for Code review payment module");
		await waitUntil(() => liveAgents.size === 0);
	});

	test.serial("force-current-model env ignores task, config, env, and extra-arg model choices", async () => {
		const { registerSpawnTool } = await import("../../src/async-subagents/tools/spawn.js");
		const pi = new FakePi();
		const liveAgents = new Map<string, Map<string, any>>();
		registerSpawnTool(pi as any, liveAgents, ({ runDir, agentId }: any) => {
			const liveRun = liveAgents.get(runDir);
			liveRun?.delete(agentId);
			if (liveRun?.size === 0) liveAgents.delete(runDir);
		});
		const tool = pi.tools.get("async_subagents_spawn");
		const cwd = tempDir();
		process.env.ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL = "1";
		process.env.ASYNC_SUBAGENTS_MODEL = "env/fallback-model";
		process.env.ASYNC_SUBAGENTS_CONFIG = path.join(cwd, ".pi", "async-subagents.json");
		writeFile(process.env.ASYNC_SUBAGENTS_CONFIG, JSON.stringify({
			types: {
				scan: { model: "config/scan", extraArgs: ["--model", "config/arg-model", "--temperature", "0"] },
			},
		}));

		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "forced ok" }] }] }));
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		const result = await tool.execute("call", {
			tasks: [{ id: "scan-agent", task: "Scan files", subagentType: "scan", model: "task/model", extraArgs: ["--model=task/arg-model", "--foo"] }],
			slug: "forced-current-model",
			extraArgs: ["--model", "global/arg-model", "--bar"],
			watchSeconds: 1,
		}, undefined, undefined, { cwd, model: { provider: "zai", id: "glm-5-turbo" } });

		const runDir = result.details.runDir;
		const piArgs = fs.readFileSync(path.join(runDir, "scan-agent", "pi_args"), "utf-8");
		expect(piArgs).toContain("--model\nzai/glm-5-turbo");
		expect(piArgs).toContain("--temperature\n0");
		expect(piArgs).toContain("--foo");
		expect(piArgs).toContain("--bar");
		expect(piArgs).not.toContain("config/scan");
		expect(piArgs).not.toContain("task/model");
		expect(piArgs).not.toContain("env/fallback-model");
		expect(piArgs).not.toContain("arg-model");
		expect(fs.readFileSync(path.join(runDir, "scan-agent", "model"), "utf-8")).toBe("zai/glm-5-turbo");
		await waitUntil(() => liveAgents.size === 0);
	});
});
