import { afterEach, describe, expect, test } from "bun:test";
import { spawn as spawnChild } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createRunDir,
	createSemaphore,
	copySubagentConfigSample,
	currentModelRef,
	DEFAULT_AGENT_TIMEOUT_MS,
	DEFAULT_DEBUG_EVENTS_LOG_MAX_BYTES,
	DEFAULT_EVENTS_LOG_MAX_BYTES,
	DEFAULT_RPC_EVENT_LINE_MAX_CHARS,
	DEFAULT_STDERR_LOG_MAX_BYTES,
	existingSubagentConfigFiles,
	findCleanupCandidates,
	findLatestSubagentRunDir,
	generatePrompt,
	getAgentState,
	getActiveSubagentPresetName,
	getSubagentRegistryPath,
	getSubagentConfigSamplePath,
	getPiInvocation,
	getRunRoot,
	getRunState,
	getSubagentPresetSelectionPath,
	isQuotaLimitCompletion,
	loadSubagentConfig,
	loadSubagentPresetSelection,
	loadSubagentRegistry,
	readResult,
	recordSubagentRun,
	removeSubagentRunsFromRegistry,
	readStructuredResult,
	rememberSessionModelFallback,
	resetSessionModelFallbacks,
	resolveAgentTaskConfig,
	resolveSubagentAgentRunDir,
	resolveSubagentRunDir,
	resolveRunDir,
	resolveSubagentLogLimits,
	saveSubagentPresetSelection,
	selectSessionModelWithFallback,
	selectSubagentType,
	setActiveSubagentPreset,
	setSessionSubagentPresetOverride,
	shouldForceCurrentSubagentModel,
	shouldPersistSubagentSessions,
	spawnAgent,
	spawnAgentWithRetry,
	stopAgents,
	validateBasename,
	validateStopSignal,
	waitForAgents,
	writePromptFile,
	writeStructuredResult,
} from "../../src/async-subagents/lib.js";
import { isRecord, isoNow, serializeJsonLine } from "../../src/async-subagents/core/utils.js";
import { agentStrategyPrompt, appendAgentStrategyPrompt } from "../../src/async-subagents/core/agent-strategy.js";
import { buildAgentCompletionNotification, isTerminalAgentStatus } from "../../src/async-subagents/core/notifications.js";
import type { AgentTask } from "../../src/async-subagents/lib.js";

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
const originalAsyncSubagentsMaxEventsBytes = process.env.ASYNC_SUBAGENTS_MAX_EVENTS_BYTES;
const originalPiSubagentsMaxEventsBytes = process.env.PI_SUBAGENTS_MAX_EVENTS_BYTES;
const originalAsyncSubagentsMaxStderrBytes = process.env.ASYNC_SUBAGENTS_MAX_STDERR_BYTES;
const originalPiSubagentsMaxStderrBytes = process.env.PI_SUBAGENTS_MAX_STDERR_BYTES;
const originalAsyncSubagentsMaxRpcLineChars = process.env.ASYNC_SUBAGENTS_MAX_RPC_LINE_CHARS;
const originalPiSubagentsMaxRpcLineChars = process.env.PI_SUBAGENTS_MAX_RPC_LINE_CHARS;
const originalAsyncSubagentsDebugLogs = process.env.ASYNC_SUBAGENTS_DEBUG_LOGS;
const originalPiSubagentsDebugLogs = process.env.PI_SUBAGENTS_DEBUG_LOGS;

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagents-test-"));
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
	for (const [name, content] of Object.entries(files)) {
		writeFile(path.join(agentDir, name), content);
	}
	return agentDir;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 3000): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
	]);
}

afterEach(() => {
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
	if (originalAsyncSubagentsMaxEventsBytes === undefined) delete process.env.ASYNC_SUBAGENTS_MAX_EVENTS_BYTES;
	else process.env.ASYNC_SUBAGENTS_MAX_EVENTS_BYTES = originalAsyncSubagentsMaxEventsBytes;
	if (originalPiSubagentsMaxEventsBytes === undefined) delete process.env.PI_SUBAGENTS_MAX_EVENTS_BYTES;
	else process.env.PI_SUBAGENTS_MAX_EVENTS_BYTES = originalPiSubagentsMaxEventsBytes;
	if (originalAsyncSubagentsMaxStderrBytes === undefined) delete process.env.ASYNC_SUBAGENTS_MAX_STDERR_BYTES;
	else process.env.ASYNC_SUBAGENTS_MAX_STDERR_BYTES = originalAsyncSubagentsMaxStderrBytes;
	if (originalPiSubagentsMaxStderrBytes === undefined) delete process.env.PI_SUBAGENTS_MAX_STDERR_BYTES;
	else process.env.PI_SUBAGENTS_MAX_STDERR_BYTES = originalPiSubagentsMaxStderrBytes;
	if (originalAsyncSubagentsMaxRpcLineChars === undefined) delete process.env.ASYNC_SUBAGENTS_MAX_RPC_LINE_CHARS;
	else process.env.ASYNC_SUBAGENTS_MAX_RPC_LINE_CHARS = originalAsyncSubagentsMaxRpcLineChars;
	if (originalPiSubagentsMaxRpcLineChars === undefined) delete process.env.PI_SUBAGENTS_MAX_RPC_LINE_CHARS;
	else process.env.PI_SUBAGENTS_MAX_RPC_LINE_CHARS = originalPiSubagentsMaxRpcLineChars;
	if (originalAsyncSubagentsDebugLogs === undefined) delete process.env.ASYNC_SUBAGENTS_DEBUG_LOGS;
	else process.env.ASYNC_SUBAGENTS_DEBUG_LOGS = originalAsyncSubagentsDebugLogs;
	if (originalPiSubagentsDebugLogs === undefined) delete process.env.PI_SUBAGENTS_DEBUG_LOGS;
	else process.env.PI_SUBAGENTS_DEBUG_LOGS = originalPiSubagentsDebugLogs;
	setSessionSubagentPresetOverride(undefined);
	resetSessionModelFallbacks();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.serial("core paths", () => {
	test.serial("builds, creates, and resolves run directories", () => {
		const cwd = tempDir();
		expect(getRunRoot(cwd)).toBe(path.join(cwd, ".pi", "subagents"));

		const runDir = createRunDir(cwd, "my-run_1");
		expect(runDir).toStartWith(path.join(cwd, ".pi", "subagents"));
		expect(path.basename(runDir)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-my-run_1$/);
		expect(fs.statSync(path.join(runDir, "prompts")).isDirectory()).toBe(true);

		expect(resolveRunDir(cwd, "relative/run")).toBe(path.join(cwd, "relative", "run"));
		expect(resolveRunDir(cwd, runDir)).toBe(runDir);
	});

	test.serial("rejects unsafe basenames", () => {
		expect(() => validateBasename("agent-1.ok", "agentId")).not.toThrow();
		expect(() => validateBasename("../escape", "agentId")).toThrow("Invalid agentId");
		expect(() => validateBasename("has space", "agentId")).toThrow("Invalid agentId");
		expect(() => validateBasename("agent..x", "agentId")).toThrow('Must not contain ".."');
		expect(() => createRunDir(tempDir(), "bad/slug")).toThrow("Invalid slug");
	});

	test.serial("records project registry entries and resolves omitted runDir", () => {
		const cwd = tempDir();
		const runA = createRunDir(cwd, "registry-a");
		createAgent(runA, "agent-1");
		recordSubagentRun(cwd, runA, ["agent-1"]);

		expect(getSubagentRegistryPath(cwd)).toBe(path.join(cwd, ".pi", "subagents", "registry.json"));
		expect(loadSubagentRegistry(cwd)).toMatchObject({
			latestRunDir: runA,
			agents: { "agent-1": { runDir: runA } },
		});
		expect(resolveSubagentRunDir(cwd)).toBe(runA);
		expect(resolveSubagentAgentRunDir(cwd, "agent-1")).toBe(runA);

		const runB = createRunDir(cwd, "registry-b");
		createAgent(runB, "agent-2");
		recordSubagentRun(cwd, runB, ["agent-2"]);
		expect(findLatestSubagentRunDir(cwd)).toBe(runB);
		expect(resolveSubagentRunDir(cwd)).toBe(runB);
		expect(resolveSubagentAgentRunDir(cwd, "agent-1")).toBe(runA);
		expect(resolveSubagentAgentRunDir(cwd, "agent-2")).toBe(runB);

		removeSubagentRunsFromRegistry(cwd, [runB]);
		expect(loadSubagentRegistry(cwd).agents["agent-2"]).toBeUndefined();
		expect(resolveSubagentRunDir(cwd)).toBe(runA);

		const scannedRun = path.join(cwd, ".pi", "subagents", "manually-created-run");
		createAgent(scannedRun, "manual-agent");
		expect(resolveSubagentAgentRunDir(cwd, "manual-agent")).toBe(scannedRun);
		expect(() => resolveSubagentAgentRunDir(cwd, "missing-agent")).toThrow('agent "missing-agent" was not found');
	});
});

describe.serial("core utils and prompt generation", () => {
	test.serial("builds per-agent completion notifications with remaining active agents", () => {
		const notification = buildAgentCompletionNotification({
			agentId: "agent-1",
			runDir: "/tmp/run",
			state: { id: "agent-1", status: "done", exitCode: 0 },
			runAgents: [
				{ id: "agent-1", status: "done", exitCode: 0 },
				{ id: "agent-2", status: "running" },
				{ id: "agent-3", status: "planned" },
				{ id: "agent-4", status: "failed", exitCode: 1 },
			],
		});

		expect(notification.customType).toBe("async-subagents-agent-completion");
		expect(notification.display).toBe(true);
		expect(notification.details).toEqual({
			agentId: "agent-1",
			runDir: "/tmp/run",
			status: "done",
			exitCode: 0,
			remainingAgentIds: ["agent-2", "agent-3"],
		});
		expect(notification.content).toContain("Background sub-agent agent-1 finished with status done, exitCode=0.");
		expect(notification.content).toContain("2 other sub-agents still active: agent-2 (in progress), agent-3 (planned).");
		expect(notification.content).toContain('subagents({ action: "result", agentId: "agent-1", runDir: "/tmp/run" })');
		expect(notification.content).toContain("Do not poll for the remaining agents");
	});

	test.serial("classifies terminal notification statuses", () => {
		expect(isTerminalAgentStatus("done")).toBe(true);
		expect(isTerminalAgentStatus("failed")).toBe(true);
		expect(isTerminalAgentStatus("stopped")).toBe(true);
		expect(isTerminalAgentStatus("running")).toBe(false);
		expect(isTerminalAgentStatus("planned")).toBe(false);
		expect(isTerminalAgentStatus("retrying")).toBe(false);
	});

	test.serial("limits concurrent work with an abortable semaphore", async () => {
		const semaphore = createSemaphore(1);
		await semaphore.acquire();
		let acquiredSecond = false;
		const second = semaphore.acquire().then(() => {
			acquiredSecond = true;
			semaphore.release();
		});

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(acquiredSecond).toBe(false);
		semaphore.release();
		await second;
		expect(acquiredSecond).toBe(true);

		const blocked = createSemaphore(1);
		await blocked.acquire();
		const controller = new AbortController();
		const rejected = blocked.acquire(controller.signal);
		controller.abort();
		await expect(rejected).rejects.toThrow("Aborted");
	});

	test.serial("persists sub-agent sessions only when explicitly enabled", () => {
		expect(shouldPersistSubagentSessions({})).toBe(false);
		expect(shouldPersistSubagentSessions({ ASYNC_SUBAGENTS_ENABLE_SESSIONS: "0" })).toBe(false);
		expect(shouldPersistSubagentSessions({ ASYNC_SUBAGENTS_ENABLE_SESSIONS: "1" })).toBe(true);
		expect(shouldPersistSubagentSessions({ ASYNC_SUBAGENTS_ENABLE_SESSIONS: "true" })).toBe(true);
	});

	test.serial("resolves bounded sub-agent log limits from env", () => {
		expect(resolveSubagentLogLimits({})).toEqual({
			eventsMaxBytes: DEFAULT_EVENTS_LOG_MAX_BYTES,
			stderrMaxBytes: DEFAULT_STDERR_LOG_MAX_BYTES,
			rpcEventLineMaxChars: DEFAULT_RPC_EVENT_LINE_MAX_CHARS,
			debugLogs: false,
		});
		expect(resolveSubagentLogLimits({ ASYNC_SUBAGENTS_DEBUG_LOGS: "1" })).toEqual({
			eventsMaxBytes: DEFAULT_DEBUG_EVENTS_LOG_MAX_BYTES,
			stderrMaxBytes: DEFAULT_STDERR_LOG_MAX_BYTES,
			rpcEventLineMaxChars: DEFAULT_RPC_EVENT_LINE_MAX_CHARS,
			debugLogs: true,
		});
		expect(resolveSubagentLogLimits({
			ASYNC_SUBAGENTS_MAX_EVENTS_BYTES: "123",
			ASYNC_SUBAGENTS_MAX_STDERR_BYTES: "456",
			ASYNC_SUBAGENTS_MAX_RPC_LINE_CHARS: "789",
		})).toEqual({ eventsMaxBytes: 123, stderrMaxBytes: 456, rpcEventLineMaxChars: 789, debugLogs: false });
		expect(resolveSubagentLogLimits({
			PI_SUBAGENTS_MAX_EVENTS_BYTES: "321",
			PI_SUBAGENTS_MAX_STDERR_BYTES: "654",
			PI_SUBAGENTS_MAX_RPC_LINE_CHARS: "987",
		})).toEqual({ eventsMaxBytes: 321, stderrMaxBytes: 654, rpcEventLineMaxChars: 987, debugLogs: false });
	});

	test.serial("formats utility values", () => {
		expect(isoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
		expect(serializeJsonLine({ ok: true })).toBe('{"ok":true}\n');
		expect(isRecord({})).toBe(true);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("x")).toBe(false);
	});

	test.serial("selects parallel-first/deep-work agent strategy prompts by model", () => {
		expect(agentStrategyPrompt({ modelRef: "zai/glm-5.2", env: {} })).toContain('name="parallel-first"');
		expect(agentStrategyPrompt({ modelRef: "antigravity/gemini-3.1-pro", env: {} })).toContain('name="parallel-first"');
		expect(agentStrategyPrompt({ modelRef: "openai-codex/gpt-5.5", env: {} })).toContain('name="deep-work"');
		expect(agentStrategyPrompt({ modelRef: "openai/gpt-5.4", env: {} })).toContain('name="deep-work"');
		expect(agentStrategyPrompt({ modelRef: "openai/gpt-5.5", customPrompt: true, env: {} })).toBeUndefined();
		expect(agentStrategyPrompt({ modelRef: "zai/glm-5.2", env: { PI_AGENT_STRATEGY: "off" } })).toBeUndefined();
		expect(agentStrategyPrompt({ modelRef: "zai/glm-5.2", env: { PI_AGENT_STRATEGY: "deep-work" } })).toContain('name="deep-work"');
		expect(agentStrategyPrompt({ modelRef: "openai/gpt-5.4", env: { PI_AGENT_STRATEGY: "parallel_first" } })).toContain('name="parallel-first"');
		expect(appendAgentStrategyPrompt("base\n", "strategy")).toBe("base\n\nstrategy");
	});

	test.serial("generates and writes prompts with defaults and scope", () => {
		const runDir = tempDir();
		const task: AgentTask = {
			id: "agent-1",
			task: "Inspect tests",
			scope: "async-subagents/core",
			parentObjective: "Improve coverage",
		};

		const prompt = generatePrompt(task);
		expect(prompt).toContain("Parent objective:\nImprove coverage");
		expect(prompt).toContain("Your focused task:\nInspect tests");
		expect(prompt).toContain("- Relevant files/areas: async-subagents/core");
		expect(prompt).toContain("Output format:");

		const defaultPrompt = generatePrompt({ id: "agent-2", task: "Run" });
		expect(defaultPrompt).toContain("Parent objective:\ncurrent user task");
		expect(defaultPrompt).not.toContain("Relevant files/areas");

		const appendedPrompt = generatePrompt({ id: "agent-3", task: "Review", subagentType: "review", promptAppend: "Act as {subagentType}: {task}" });
		expect(appendedPrompt).toContain("Additional instructions from sub-agent profile:\nAct as review: Review");

		const imagePrompt = generatePrompt({
			id: "agent-image",
			task: "Describe the screenshot",
			subagentType: "frontend",
			imagePaths: ["screen.png"],
			focus: "Pay attention to error banners.",
			promptAppend: "Focus: {focus}; images: {imagePaths}",
		});
		expect(imagePrompt).toContain("Visual focus / attention instructions:\nPay attention to error banners.");
		expect(imagePrompt).toContain("- Attached image files: screen.png");
		expect(imagePrompt).toContain("Focus: Pay attention to error banners.; images: screen.png");

		const overridePrompt = generatePrompt({
			id: "agent-4",
			task: "Deep debug",
			scope: "src/core",
			parentObjective: "Fix bug",
			promptOverride: "CUSTOM {parentObjective} / {task} / {scope}",
		});
		expect(overridePrompt).toBe("CUSTOM Fix bug / Deep debug / src/core");

		const promptPath = writePromptFile(runDir, task);
		expect(promptPath).toBe(path.join(runDir, "prompts", "agent-1.md"));
		expect(fs.readFileSync(promptPath, "utf-8")).toBe(prompt);
	});
});

describe.serial("pi invocation", () => {
	test.serial("uses the pi executable from a generic runtime", () => {
		process.argv[1] = path.join(tempDir(), "not-present.js");
		expect(getPiInvocation(["--mode", "rpc"])).toEqual({ command: "pi", args: ["--mode", "rpc"] });
	});

	test.serial("reuses the current pi entrypoint when available", () => {
		const script = path.join(tempDir(), "pi.js");
		writeFile(script, "console.log('pi')");
		process.argv[1] = script;
		const invocation = getPiInvocation(["--no-session"]);
		expect(invocation.command).toBe(process.execPath);
		expect(invocation.args).toEqual([script, "--no-session"]);
	});
});

describe.serial("subagent type config", () => {
	test.serial("copies bundled sample config only when no config exists", () => {
		const cwd = tempDir();
		const targetPath = path.join(cwd, "custom", "async-subagents.jsonc");
		const env = { ASYNC_SUBAGENTS_CONFIG: targetPath };

		expect(fs.existsSync(getSubagentConfigSamplePath())).toBe(true);
		expect(existingSubagentConfigFiles(cwd, env)).toEqual([]);

		const copied = copySubagentConfigSample(cwd, env);
		expect(copied).toMatchObject({ copied: true, targetPath, existingFiles: [] });
		expect(fs.existsSync(targetPath)).toBe(true);
		expect(fs.readFileSync(targetPath, "utf-8")).toContain("Full config schema: https://unpkg.com/pi-ui-extend/schemas/pi-tools-suite.json");
		const config = loadSubagentConfig(cwd, env);
		expect(Object.keys(config.presets ?? {}).sort()).toEqual(["cheap", "deep", "gpt"]);
		expect(Object.keys(config.types).sort()).toEqual(["deep", "docs", "frontend", "implement", "oracle", "quick", "research", "review", "scan", "tests"]);
		expect(config.types.review.description).toContain("security");
		expect(selectSubagentType({ id: "s", task: "vulnerability secret token" }, config)).toBe("quick");

		const before = fs.readFileSync(targetPath, "utf-8");
		const skipped = copySubagentConfigSample(cwd, env);
		expect(skipped).toMatchObject({ copied: false, targetPath, existingFiles: [targetPath] });
		expect(fs.readFileSync(targetPath, "utf-8")).toBe(before);
	});

	test.serial("selects explicit roles or falls back to the configured default", () => {
		const config = {
			defaultType: "quick",
			types: {
				quick: {},
				review: {},
				security: {},
			},
		};

		expect(selectSubagentType({ id: "r", task: "please do a code review" }, config)).toBe("quick");
		expect(selectSubagentType({ id: "s", task: "security review of auth" }, config)).toBe("quick");
		expect(selectSubagentType({ id: "d", task: "unmatched" }, config)).toBe("quick");
		expect(selectSubagentType({ id: "e", task: "security review", subagentType: "manual" }, config)).toBe("manual");
	});

	test.serial("loads config presets, persists active preset selection, and resolves spawn defaults", () => {
		const cwd = tempDir();
		const selectionPath = path.join(cwd, "subagent-preset-selection.json");
		process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE = selectionPath;
		const configPath = path.join(cwd, "async-subagents.json");
		writeFile(configPath, JSON.stringify({
			types: {},
			presets: {
				fast: {
					model: "zai/fast",
					fallbackModels: ["zai/backup", "openai/backup"],
					thinking: "off",
					extraArgs: ["--temperature", "0"],
					types: { review: { model: "openai/review-fast", fallbackModels: ["openai/review-backup"], thinking: "medium", extraArgs: ["--review-fast"] } },
				},
				deep: { description: "careful", model: "openai/deep", thinking: "high" },
			},
		}));

		expect(getSubagentPresetSelectionPath()).toBe(selectionPath);
		expect(loadSubagentPresetSelection()).toEqual({});
		saveSubagentPresetSelection({ activePreset: "fast" });

		const config = loadSubagentConfig(cwd, { ASYNC_SUBAGENTS_CONFIG: configPath });
		expect(config.presets?.deep.description).toBe("careful");
		const activePresetName = loadSubagentPresetSelection().activePreset;
		expect(activePresetName).toBe("fast");
		const activePreset = activePresetName ? config.presets?.[activePresetName] : undefined;
		const resolved = resolveAgentTaskConfig({ id: "a", task: "Read quickly" }, config, {
			preset: activePreset,
		});
		expect(resolved.task.model).toBe("zai/fast");
		expect(resolved.fallbackModels).toEqual(["zai/backup", "openai/backup"]);
		expect(resolved.task.thinking).toBe("off");
		expect(resolved.extraArgs).toEqual(["--temperature", "0"]);

		const perType = resolveAgentTaskConfig({ id: "r", task: "Review", subagentType: "review" }, config, { preset: activePreset });
		expect(perType.task.model).toBe("openai/review-fast");
		expect(perType.fallbackModels).toEqual(["openai/review-backup", "zai/backup", "openai/backup"]);
		expect(perType.task.thinking).toBe("medium");
		expect(perType.extraArgs).toEqual(["--review-fast", "--temperature", "0"]);

		const explicit = resolveAgentTaskConfig({ id: "b", task: "Review", model: "manual/model", thinking: "minimal" }, config, { preset: activePreset });
		expect(explicit.task.model).toBe("manual/model");
		expect(explicit.fallbackModels).toEqual([]);
		expect(explicit.task.thinking).toBe("minimal");

		setActiveSubagentPreset("deep");
		expect(loadSubagentPresetSelection().activePreset).toBe("deep");
		process.env.AGENTS_PRESET = "fast";
		expect(getActiveSubagentPresetName()).toBe("fast");
		setSessionSubagentPresetOverride("deep");
		expect(getActiveSubagentPresetName()).toBe("deep");
		setSessionSubagentPresetOverride(undefined);
		expect(getActiveSubagentPresetName()).toBe("fast");
		expect(loadSubagentPresetSelection().activePreset).toBe("deep");
		setActiveSubagentPreset(undefined);
		expect(loadSubagentPresetSelection().activePreset).toBeUndefined();
		expect(getActiveSubagentPresetName()).toBe("fast");
	});

	test.serial("resolves retry and max result config", () => {
		const cwd = tempDir();
		const configPath = path.join(cwd, "async-subagents.json");
		writeFile(configPath, JSON.stringify({
			maxConcurrent: 2,
			maxResultBytes: 10,
			retry: { maxRetries: 1, backoffMs: 5, retryableExitCodes: [1] },
			types: {
				review: {
					maxResultBytes: 3,
					retry: { maxRetries: 2, retryableExitCodes: [] },
				},
			},
		}));

		const config = loadSubagentConfig(cwd, { ASYNC_SUBAGENTS_CONFIG: configPath });
		expect(config.maxConcurrent).toBe(2);
		const base = resolveAgentTaskConfig({ id: "a", task: "base" }, config);
		expect(base.retry).toEqual({ maxRetries: 1, backoffMs: 5, retryableExitCodes: [1] });
		expect(base.maxResultBytes).toBe(10);
		const review = resolveAgentTaskConfig({ id: "r", task: "review", subagentType: "review" }, config);
		expect(review.retry).toEqual({ maxRetries: 2, backoffMs: 5, retryableExitCodes: [] });
		expect(review.maxResultBytes).toBe(3);
	});

	test.serial("loads JSONC type profiles and resolves model/thinking/tools", () => {
		const cwd = tempDir();
		const configPath = path.join(cwd, ".pi", "async-subagents.jsonc");
		writeFile(configPath, `{
			// project-level routing profiles
			"defaultType": "quick",
			"types": {
				"scan": {
					"model": "fast/file-model",
					"thinking": "off",
					"tools": ["read", "grep"],
					"extraArgs": ["--temperature", "0"],
					"promptAppend": ["Use grep first.", "Return paths before findings."],
				},
				"review": {
					"model": "smart/review-model",
					"thinking": "high",
					"promptOverride": "Review prompt for {task}"
				}
			}
		}`);

		const config = loadSubagentConfig(cwd, {
			ASYNC_SUBAGENTS_CONFIG: configPath,
			ASYNC_SUBAGENTS_SCAN_MODEL: "env/fast-scan",
		});

		expect(config.defaultType).toBe("quick");
		expect(config.types.scan.model).toBe("env/fast-scan");
		expect(selectSubagentType({ id: "a", task: "Do a repo-wide scan for auth files" }, config)).toBe("quick");
		expect(selectSubagentType({ id: "b", task: "Careful code review", subagentType: "review" }, config)).toBe("review");
		expect(selectSubagentType({ id: "c", task: "Read this note" }, config)).toBe("quick");

		const scan = resolveAgentTaskConfig({ id: "a", task: "Scan files for auth", subagentType: "scan" }, config);
		expect(scan.task).toMatchObject({ subagentType: "scan", model: "env/fast-scan", thinking: "off", tools: ["read", "grep"] });
		expect(scan.task.promptAppend).toBe("Use grep first.\nReturn paths before findings.");
		expect(scan.extraArgs).toEqual(["--temperature", "0"]);

		const review = resolveAgentTaskConfig({ id: "r", task: "review payments", subagentType: "review", promptAppend: "Task-specific note." }, config);
		expect(review.task.promptOverride).toBe("Review prompt for {task}");
		expect(review.task.promptAppend).toBe("Task-specific note.");

		const explicit = resolveAgentTaskConfig(
			{ id: "b", task: "review", subagentType: "review", model: "manual/model", thinking: "minimal", extraArgs: ["--foo"] },
			config,
			{ thinking: "medium", extraArgs: ["--bar"] },
		);
		expect(explicit.task).toMatchObject({ subagentType: "review", model: "manual/model", thinking: "medium" });
		expect(explicit.extraArgs).toEqual(["--foo", "--bar"]);

		const forced = resolveAgentTaskConfig(
			{ id: "f", task: "scan", subagentType: "scan", model: "manual/model", extraArgs: ["--model", "manual/arg-model", "--foo"] },
			config,
			{ forcedModel: "parent/current-model", extraArgs: ["--model=global/arg-model", "--bar"] },
		);
		expect(forced.task.model).toBe("parent/current-model");
		expect(forced.extraArgs).toEqual(["--temperature", "0", "--foo", "--bar"]);
	});

	test.serial("resolves modelByParent from the current parent model", () => {
		const cwd = tempDir();
		const configPath = path.join(cwd, "async-subagents.json");
		writeFile(configPath, JSON.stringify({
			defaultType: "quick",
			types: {
				quick: { model: "zai/glm-4.5-air", thinking: "off" },
				oracle: {
					description: "Cross-provider second opinion.",
					model: "openai-codex/gpt-5.5",
					fallbackModels: ["zai/glm-5.2", "openai-codex/gpt-5.5"],
					thinking: "xhigh",
					modelByParent: {
						"zai/*": { model: "openai-codex/gpt-5.5", fallbackModels: ["zai/glm-5.2"] },
						"openai-codex/*": "zai/glm-5.2",
						"antigravity/*": { model: "zai/glm-5.2", fallbackModels: ["openai-codex/gpt-5.5"] },
					},
				},
			},
		}));

		const config = loadSubagentConfig(cwd, { ASYNC_SUBAGENTS_CONFIG: configPath });

		// GLM parent -> GPT oracle, with entry-specific fallbacks.
		const fromGlm = resolveAgentTaskConfig(
			{ id: "a", task: "second opinion", subagentType: "oracle" },
			config,
			{ parentModel: "zai/glm-5.2" },
		);
		expect(fromGlm.task.model).toBe("openai-codex/gpt-5.5");
		expect(fromGlm.fallbackModels).toEqual(["zai/glm-5.2"]);

		// GPT parent -> GLM oracle (string shorthand), falls back to normal chain.
		const fromGpt = resolveAgentTaskConfig(
			{ id: "b", task: "second opinion", subagentType: "oracle" },
			config,
			{ parentModel: "openai-codex/gpt-5.5" },
		);
		expect(fromGpt.task.model).toBe("zai/glm-5.2");
		expect(fromGpt.fallbackModels).toEqual(["openai-codex/gpt-5.5"]);

		// Antigravity parent -> GLM oracle with entry fallbacks.
		const fromAg = resolveAgentTaskConfig(
			{ id: "c", task: "second opinion", subagentType: "oracle" },
			config,
			{ parentModel: "antigravity/gemini-3.1-pro-preview" },
		);
		expect(fromAg.task.model).toBe("zai/glm-5.2");
		expect(fromAg.fallbackModels).toEqual(["openai-codex/gpt-5.5"]);

		// No parent model -> static profile model.
		const noParent = resolveAgentTaskConfig(
			{ id: "d", task: "second opinion", subagentType: "oracle" },
			config,
		);
		expect(noParent.task.model).toBe("openai-codex/gpt-5.5");
		expect(noParent.fallbackModels).toEqual(["zai/glm-5.2"]);

		// Explicit task.model still wins over the parent-driven match.
		const explicit = resolveAgentTaskConfig(
			{ id: "e", task: "second opinion", subagentType: "oracle", model: "manual/model" },
			config,
			{ parentModel: "zai/glm-5.2" },
		);
		expect(explicit.task.model).toBe("manual/model");
		expect(explicit.fallbackModels).toEqual([]);

		// Non-oracle types are unaffected when no parent match exists.
		const quick = resolveAgentTaskConfig(
			{ id: "f", task: "tiny" },
			config,
			{ parentModel: "zai/glm-5.2" },
		);
		expect(quick.task.model).toBe("zai/glm-4.5-air");
	});

	test.serial("detects force-current-model env flags and formats current model refs", () => {
		expect(shouldForceCurrentSubagentModel({})).toBe(false);
		expect(shouldForceCurrentSubagentModel({ ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL: "1" })).toBe(true);
		expect(shouldForceCurrentSubagentModel({ PI_SUBAGENTS_FORCE_CURRENT_MODEL: "yes" })).toBe(true);
		expect(shouldForceCurrentSubagentModel({ ASYNC_SUBAGENTS_USE_CURRENT_MODEL: "on" })).toBe(true);
		expect(currentModelRef({ provider: "zai", id: "glm-5-turbo" })).toBe("zai/glm-5-turbo");
		expect(currentModelRef({ provider: "zai", id: "zai/glm-5-turbo" })).toBe("zai/glm-5-turbo");
		expect(currentModelRef({ id: "openai/gpt-5" })).toBe("openai/gpt-5");
		expect(currentModelRef(undefined)).toBeUndefined();
	});
});

describe.serial("run and agent state", () => {
		test.serial("detects planned, running, done, failed, stopped, and RPC prompt failures", () => {
		const runDir = tempDir();
		writeFile(path.join(runDir, "prompts", "planned.md"), "planned prompt");
		createAgent(runDir, "done", {
			"exit_code": "0",
			"started_at": "2024-01-01T00:00:00Z",
			"finished_at": "2024-01-01T00:00:02Z",
			"result.md": "a\nb\n",
			"stderr.log": "",
			"events.jsonl": "{}\n{}",
		});
		createAgent(runDir, "failed", { "exit_code": "2" });
		createAgent(runDir, "stopped", { "exit_code": "not-a-number" });
		createAgent(runDir, "rpc-failed", {
			"events.jsonl": `${JSON.stringify({ type: "response", command: "prompt", success: false })}\n`,
		});
		createAgent(runDir, "rpc-ok", {
			"events.jsonl": `${JSON.stringify({ type: "response", command: "prompt", success: true })}\n`,
		});
		createAgent(runDir, "rpc-invalid", { "events.jsonl": "{not json" });
		createAgent(runDir, "running", { pid: String(process.pid), "stderr.log": "warn\nerr" });
		createAgent(runDir, "dead-pid", { pid: "99999999" });

		expect(getAgentState(runDir, "missing")).toBeNull();
		expect(getAgentState(runDir, "done")).toMatchObject({ id: "done", status: "done", exitCode: 0, resultLines: 2, eventLines: 2 });
		expect(getAgentState(runDir, "failed")).toMatchObject({ id: "failed", status: "failed", exitCode: 2 });
		expect(getAgentState(runDir, "stopped")).toMatchObject({ id: "stopped", status: "stopped" });
		expect(getAgentState(runDir, "rpc-failed")).toMatchObject({ id: "rpc-failed", status: "failed", exitCode: 1 });
		expect(getAgentState(runDir, "rpc-ok")).toMatchObject({ id: "rpc-ok", status: "planned", eventLines: 1 });
		expect(getAgentState(runDir, "rpc-invalid")).toMatchObject({ id: "rpc-invalid", status: "planned", eventLines: 1 });
		expect(getAgentState(runDir, "running")).toMatchObject({ id: "running", status: "running", pid: process.pid, stderrLines: 2 });
		expect(getAgentState(runDir, "dead-pid")).toMatchObject({ id: "dead-pid", status: "stopped", pid: 99999999 });

		expect(getAgentState(runDir, "done", { includeLineCounts: false })).toMatchObject({ id: "done", status: "done", exitCode: 0 });
		expect(getAgentState(runDir, "done", { includeLineCounts: false })?.resultLines).toBeUndefined();
		expect(getAgentState(runDir, "done", { includeLineCounts: false })?.eventLines).toBeUndefined();
		expect(getAgentState(runDir, "rpc-failed", { checkRpcPromptFailure: false })).toMatchObject({ id: "rpc-failed", status: "planned" });
		expect(getRunState(runDir, ["done"], { includeLineCounts: false }).agents[0].resultLines).toBeUndefined();

		const all = getRunState(runDir).agents.map((a) => a.id).sort();
		expect(all).toEqual(["dead-pid", "done", "failed", "planned", "rpc-failed", "rpc-invalid", "rpc-ok", "running", "stopped"]);
		expect(getRunState(runDir, ["planned", "done"]).agents.map((a) => a.id).sort()).toEqual(["done", "planned"]);
		expect(getRunState(path.join(runDir, "missing")).agents).toEqual([]);
	});

	test.serial("reads result and stderr for an agent", () => {
		const runDir = tempDir();
		createAgent(runDir, "agent-1", {
			"exit_code": "0",
			"result.md": "final answer",
			"stderr.log": "warning\n",
		});

		expect(readResult(runDir, "missing")).toBeNull();
		expect(readResult(runDir, "agent-1")).toMatchObject({
			result: "final answer",
			stderr: "warning\n",
			exitCode: 0,
			state: { id: "agent-1", status: "done" },
		});
	});

	test.serial("reads structured result metadata when result.json exists", () => {
		const runDir = tempDir();
		const agentDir = createAgent(runDir, "agent-structured", {
			"exit_code": "0",
			"started_at": "2026-01-01T00:00:00Z",
			"finished_at": "2026-01-01T00:00:03Z",
			"result.md": "abcdef",
		});

		writeStructuredResult({
			agentDir,
			agentId: "agent-structured",
			state: getAgentState(runDir, "agent-structured")!,
			subagentType: "scan",
			model: "test/model",
			maxResultBytes: 3,
		});

		const structured = readStructuredResult(agentDir);
		expect(structured).toMatchObject({
			agentId: "agent-structured",
			status: "done",
			exitCode: 0,
			durationSeconds: 3,
			subagentType: "scan",
			model: "test/model",
			resultText: "abc",
			resultTruncated: true,
			resultOriginalBytes: 6,
		});
		expect(readResult(runDir, "agent-structured")?.structured).toEqual(structured);
	});

	test.serial("structured result extracts chaining fields without truncating raw result.md", () => {
		const runDir = tempDir();
		const agentDir = createAgent(runDir, "agent-rich", {
			"exit_code": "0",
			"result.md": [
				"Summary: inspect retry behavior.",
				"- High: bug in pi-tools-suite/src/async-subagents/core/retry.ts:42 should be fixed.",
				"- Risk: queued work may launch after stop.",
				"- Next: add regression tests.",
				"Confidence: high",
			].join("\n"),
		});

		writeStructuredResult({
			agentDir,
			agentId: "agent-rich",
			state: getAgentState(runDir, "agent-rich")!,
			maxResultBytes: 40,
		});

		const structured = readStructuredResult(agentDir)!;
		expect(structured.schemaVersion).toBe(2);
		expect(structured.resultTruncated).toBe(true);
		expect(structured.summary).toContain("Summary");
		expect(structured.findings?.[0]).toMatchObject({ severity: "high" });
		expect(structured.files?.[0]).toMatchObject({ path: "pi-tools-suite/src/async-subagents/core/retry.ts", line: 42 });
		expect(structured.confidence).toBe("high");
		expect(fs.readFileSync(path.join(agentDir, "result.md"), "utf-8")).toContain("add regression tests");
	});

	test.serial("waits until launched agents are terminal, timeout/abort/failFast aware", async () => {
		const runDir = tempDir();
		createAgent(runDir, "running", { pid: String(process.pid) });
		setTimeout(() => writeFile(path.join(runDir, "running", "exit_code"), "0"), 20);
		const completed = await waitForAgents(runDir, undefined, { timeout: 1, interval: 0.01 });
		expect(completed.agents).toContainEqual(expect.objectContaining({ id: "running", status: "done" }));

		const failFastRun = tempDir();
		createAgent(failFastRun, "failed", { exit_code: "1" });
		createAgent(failFastRun, "still-running", { pid: String(process.pid) });
		const failFast = await waitForAgents(failFastRun, undefined, { timeout: 10, interval: 1, failFast: true });
		expect(failFast.agents).toContainEqual(expect.objectContaining({ id: "failed", status: "failed" }));
		expect(failFast.agents).toContainEqual(expect.objectContaining({ id: "still-running", status: "running" }));

		const plannedOnly = tempDir();
		writeFile(path.join(plannedOnly, "prompts", "planned.md"), "prompt");
		expect((await waitForAgents(plannedOnly, undefined, { timeout: 1, interval: 0 })).agents).toEqual([{ id: "planned", status: "planned" }]);

		const abortRun = tempDir();
		createAgent(abortRun, "running", { pid: String(process.pid) });
		const controller = new AbortController();
		controller.abort();
		expect((await waitForAgents(abortRun, undefined, { timeout: 10, interval: 1, signal: controller.signal })).agents[0].status).toBe("running");

		const timeoutRun = tempDir();
		createAgent(timeoutRun, "running", { pid: String(process.pid) });
		expect((await waitForAgents(timeoutRun, undefined, { timeout: 0, interval: 1 })).agents[0].status).toBe("running");
	});

	test.serial("stops running agents and records stopped metadata", async () => {
		const runDir = tempDir();
		const child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
		if (!child.pid) throw new Error("child process did not start");
		createAgent(runDir, "running", { pid: String(child.pid) });
		createAgent(runDir, "done", { exit_code: "0" });

		try {
			expect(validateStopSignal("SIGKILL")).toBe("SIGKILL");
			expect(() => validateStopSignal("SIGHUP")).toThrow("Unsupported stop signal");

			const results = stopAgents(runDir, undefined, { signal: "SIGKILL" });
			expect(results).toContainEqual(expect.objectContaining({ id: "running", stopped: true, signal: "SIGKILL", pid: child.pid }));
			expect(results).toContainEqual(expect.objectContaining({ id: "done", stopped: false, previousStatus: "done" }));
			expect(fs.readFileSync(path.join(runDir, "running", "exit_code"), "utf-8")).toBe("stopped");
			expect(fs.readFileSync(path.join(runDir, "running", "stop_signal"), "utf-8")).toBe("SIGKILL");
			expect(fs.existsSync(path.join(runDir, "running", "stop_requested"))).toBe(true);
			expect(getAgentState(runDir, "running")).toMatchObject({ id: "running", status: "stopped", pid: child.pid });
		} finally {
			try {
				process.kill(child.pid, 0);
				process.kill(child.pid, "SIGKILL");
			} catch {
				/* already stopped */
			}
		}
	});

	test.serial("stops planned queued agents before they launch", () => {
		const runDir = tempDir();
		writeFile(path.join(runDir, "prompts", "queued.md"), "queued prompt");

		const [result] = stopAgents(runDir, ["queued"], { signal: "SIGTERM" });
		expect(result).toMatchObject({ id: "queued", previousStatus: "planned", stopped: true, signal: "SIGTERM" });
		expect(getAgentState(runDir, "queued")).toMatchObject({ id: "queued", status: "stopped" });
		expect(fs.readFileSync(path.join(runDir, "queued", "exit_code"), "utf-8")).toBe("stopped");
		expect(readStructuredResult(path.join(runDir, "queued"))).toMatchObject({ agentId: "queued", status: "stopped" });
	});
});

describe.serial("cleanup candidates", () => {
	test.serial("keeps newest runs, skips incomplete/non-agent dirs, and filters by mtime", () => {
		const root = tempDir();
		const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		const recent = new Date();

		for (const name of ["2024-01-01-old-a", "2024-01-02-old-b", "2024-01-03-recent", "2024-01-04-newest"]) {
			const dir = path.join(root, name);
			createAgent(dir, "agent-1", { exit_code: "0" });
			fs.utimesSync(dir, recent, name.includes("recent") || name.includes("newest") ? recent : old);
		}
		const incomplete = path.join(root, "2024-01-00-incomplete");
		createAgent(incomplete, "agent-1");
		fs.utimesSync(incomplete, old, old);
		fs.mkdirSync(path.join(root, "2024-01-00-empty"));

		expect(findCleanupCandidates(path.join(root, "missing"))).toEqual([]);
		expect(findCleanupCandidates(root, 7, 1)).toEqual([
			path.join(root, "2024-01-02-old-b"),
			path.join(root, "2024-01-01-old-a"),
		]);
		expect(findCleanupCandidates(root, 30, 1)).toEqual([]);
	});
});

describe.serial("spawning agents", () => {
	test.serial("writes metadata, captures agent_end output, and notifies completion", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-ok");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  process.stderr.write("diagnostic noise\\n");
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done result" }] }] }));
  setTimeout(() => process.exit(0), 0);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;
		process.env.ASYNC_SUBAGENTS_MODEL = "zai/glm-5-turbo";

		let seenEvent: unknown;
		const completion = new Promise<any>((resolve) => {
			const spawned = spawnAgent(runDir, { id: "agent-1", task: "Do work", tools: ["read", "grep"] }, cwd, ["--thinking", "low"], (event) => {
				seenEvent = event;
			}, resolve);
			expect(spawned.pid).toBeGreaterThan(0);
			expect(fs.existsSync(spawned.agentDir)).toBe(true);
		});

		const completed = await withTimeout(completion, "Timed out waiting for spawn completion");
		expect(completed).toMatchObject({ runDir, agentId: "agent-1", exitCode: 0, state: { status: "done" } });
		expect(seenEvent).toMatchObject({ type: "agent_end" });
		const agentDir = path.join(runDir, "agent-1");
		expect(fs.readFileSync(path.join(agentDir, "project_cwd"), "utf-8")).toBe(cwd);
		expect(fs.readFileSync(path.join(agentDir, "pi_args"), "utf-8")).toContain("--no-session");
		expect(fs.readFileSync(path.join(agentDir, "pi_args"), "utf-8")).not.toContain("--session-dir");
		expect(fs.existsSync(path.join(agentDir, "session_dir"))).toBe(false);
		expect(fs.readFileSync(path.join(agentDir, "pi_args"), "utf-8")).toContain("--extension\n");
		expect(fs.readFileSync(path.join(agentDir, "pi_args"), "utf-8")).toContain(path.join("model-tools", "index.ts"));
		expect(fs.readFileSync(path.join(agentDir, "pi_args"), "utf-8")).toContain("--model\nzai/glm-5-turbo");
		expect(fs.readFileSync(path.join(agentDir, "pi_args"), "utf-8")).toContain("--tools\nRead,Grep");
		expect(fs.readFileSync(path.join(agentDir, "result.md"), "utf-8")).toBe("done result");
		expect(fs.readFileSync(path.join(agentDir, "exit_code"), "utf-8")).toBe("0");
		expect(fs.existsSync(path.join(agentDir, "events.jsonl"))).toBe(false);
		expect(fs.existsSync(path.join(agentDir, "stderr.log"))).toBe(false);
	});

	test.serial("notifies completion when the pi process cannot be spawned", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-error");
		const originalPath = process.env.PATH;
		process.argv[1] = path.join(tempDir(), "not-present.js");
		process.env.PATH = tempDir();

		try {
			const completed = await Promise.race([
				new Promise<any>((resolve) => {
					spawnAgent(runDir, { id: "agent-1", task: "Do work" }, cwd, [], undefined, resolve);
				}),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for spawn error completion")), 1000)),
			]);

			expect(completed).toMatchObject({ runDir, agentId: "agent-1", exitCode: 1, state: { status: "failed" } });
			const agentDir = path.join(runDir, "agent-1");
			expect(fs.readFileSync(path.join(agentDir, "result.md"), "utf-8")).toContain("pi");
			expect(fs.readFileSync(path.join(agentDir, "exit_code"), "utf-8")).toBe("1");
			expect(fs.readFileSync(path.join(agentDir, "stderr.log"), "utf-8")).toContain("pi");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});

	test.serial("writes session metadata when sub-agent sessions are enabled", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-session");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] }));
  setTimeout(() => process.exit(0), 0);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;
		process.env.ASYNC_SUBAGENTS_ENABLE_SESSIONS = "1";

		await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "agent-1", task: "Do work" }, cwd, [], undefined, resolve);
		}), "Timed out waiting for session spawn completion");

		const agentDir = path.join(runDir, "agent-1");
		const piArgs = fs.readFileSync(path.join(agentDir, "pi_args"), "utf-8");
		expect(piArgs).toContain("--session-dir");
		expect(piArgs).not.toContain("--no-session");
		expect(fs.readFileSync(path.join(agentDir, "session_dir"), "utf-8")).toBe(path.join(agentDir, "sessions"));
	});

	test.serial("captures final assistant text when pi exits without agent_end", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-message-end");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final assistant result" }] } }));
  process.exit(0);
});
`);
		process.argv[1] = piScript;

		const completed = await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "agent-1", task: "Do work" }, cwd, [], undefined, resolve);
		}), "Timed out waiting for message-end spawn completion");

		expect(completed).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(fs.readFileSync(path.join(runDir, "agent-1", "result.md"), "utf-8")).toBe("final assistant result");
	});

	test.serial("keeps RPC stdin open until async prompt emits a result", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-rpc-stdin-open");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
let scheduled = false;
process.stdin.on("data", () => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "delayed rpc result" }] } }));
    console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "delayed rpc result" }] }] }));
    setTimeout(() => process.exit(0), 0);
  }, 100);
});
process.stdin.on("end", () => process.exit(0));
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		const completed = await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "agent-1", task: "Do work" }, cwd, [], undefined, resolve);
		}), "Timed out waiting for delayed RPC spawn completion");

		expect(completed).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(fs.readFileSync(path.join(runDir, "agent-1", "result.md"), "utf-8")).toBe("delayed rpc result");
	});

	test.serial("keeps opted-in runtime logs compact and bounded", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-compact-logs");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
const huge = "x".repeat(10000);
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: huge, partial: { role: "assistant", content: [{ type: "text", text: huge }] } } }));
  console.log(JSON.stringify({ type: "tool_execution_update", partialResult: { content: [{ type: "text", text: huge }] } }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "compact final" }] } }));
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "compact final" }] }, { role: "tool", content: huge }] }));
  process.stderr.write("e".repeat(10000));
  setTimeout(() => process.exit(0), 0);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;
		process.env.ASYNC_SUBAGENTS_MAX_EVENTS_BYTES = "4096";
		process.env.ASYNC_SUBAGENTS_MAX_STDERR_BYTES = "256";
		process.env.ASYNC_SUBAGENTS_MAX_RPC_LINE_CHARS = "4096";
		process.env.ASYNC_SUBAGENTS_DEBUG_LOGS = "1";

		const completed = await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "agent-1", task: "Do work" }, cwd, [], undefined, resolve);
		}), "Timed out waiting for compact-log spawn completion");

		const agentDir = path.join(runDir, "agent-1");
		expect(completed).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(fs.readFileSync(path.join(agentDir, "result.md"), "utf-8")).toBe("compact final");
		const events = fs.readFileSync(path.join(agentDir, "events.jsonl"), "utf-8");
		expect(events).toContain("suppressed_rpc_events");
		expect(events).toContain("agent_end");
		expect(events).not.toContain("x".repeat(1000));
		expect(fs.statSync(path.join(agentDir, "events.jsonl")).size).toBeLessThanOrEqual(4096);
		const stderr = fs.readFileSync(path.join(agentDir, "stderr.log"), "utf-8");
		expect(stderr).toContain("truncated");
		expect(fs.statSync(path.join(agentDir, "stderr.log")).size).toBeLessThanOrEqual(256);
	});

	test.serial("completes after agent_end even if the child ignores termination", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-agent-end-stubborn-child");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.on("SIGTERM", () => {});
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done despite stubborn child" }] }] }));
});
setTimeout(() => process.exit(0), 2500);
setInterval(() => {}, 1000);
`);
		process.argv[1] = piScript;

		const startedAt = Date.now();
		const completed = await Promise.race([
			new Promise<any>((resolve) => {
				spawnAgent(runDir, { id: "agent-1", task: "Do work" }, cwd, [], undefined, resolve);
			}),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for agent_end fallback completion")), 2000)),
		]);

		const agentDir = path.join(runDir, "agent-1");
		expect(Date.now() - startedAt).toBeLessThan(1500);
		expect(completed).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(fs.readFileSync(path.join(agentDir, "result.md"), "utf-8")).toBe("done despite stubborn child");
	});

	test.serial("attaches task image paths to the RPC prompt", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-image");
		const imagePath = path.join(cwd, "screen.png");
		const promptCapturePath = path.join(cwd, "captured-prompt.json");
		writeFile(imagePath, "fake-png-bytes");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
const fs = require("node:fs");
const capturePath = ${JSON.stringify(promptCapturePath)};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.id === "sub_prompt") {
      fs.writeFileSync(capturePath, JSON.stringify(event));
      console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "saw image" }] }] }));
      setTimeout(() => process.exit(0), 0);
    }
  }
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		const completed = await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, {
				id: "agent-image",
				task: "Describe screenshot",
				subagentType: "frontend",
				imagePaths: ["@screen.png"],
				focus: "Check the top banner",
			}, cwd, [], undefined, resolve);
		}), "Timed out waiting for image spawn completion");

		expect(completed).toMatchObject({ exitCode: 0, state: { status: "done" } });
		const captured = JSON.parse(fs.readFileSync(promptCapturePath, "utf-8"));
		expect(captured.images).toEqual([{ type: "image", data: Buffer.from("fake-png-bytes").toString("base64"), mimeType: "image/png" }]);
		expect(captured.message).toContain("Visual focus / attention instructions:\nCheck the top banner");
		expect(fs.readFileSync(path.join(runDir, "agent-image", "image_paths"), "utf-8")).toBe("@screen.png");
	});

	test.serial("turns RPC prompt failures into failed results", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-fail");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "response", command: "prompt", success: false, error: "bad prompt" }));
  setTimeout(() => process.exit(0), 0);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		const completed = await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "agent-1", task: "Do work" }, cwd, [], undefined, resolve);
		}), "Timed out waiting for prompt-failure spawn completion");

		expect(completed.exitCode).toBe(1);
		expect(completed.state.status).toBe("failed");
		expect(fs.readFileSync(path.join(runDir, "agent-1", "result.md"), "utf-8")).toBe("bad prompt");
	});

	test.serial("retries failed agents with pending state and then succeeds", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-retry-ok");
		const attemptFile = path.join(cwd, "attempt.txt");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
const fs = require("node:fs");
const attemptFile = ${JSON.stringify(attemptFile)};
process.stdin.on("data", () => {
  const attempt = fs.existsSync(attemptFile) ? Number(fs.readFileSync(attemptFile, "utf8")) + 1 : 1;
  fs.writeFileSync(attemptFile, String(attempt));
  if (attempt === 1) {
    console.log(JSON.stringify({ type: "response", command: "prompt", success: false, error: "transient" }));
  } else {
    console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "retry ok" }] }] }));
  }
  setTimeout(() => process.exit(0), 0);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		let completed: any;
		const retry = spawnAgentWithRetry(runDir, { id: "agent-1", task: "Retry" }, cwd, (completion) => {
			completed = completion;
		}, { retry: { maxRetries: 1, backoffMs: 50 }, extraArgs: [] });

		await waitUntil(() => getAgentState(runDir, "agent-1")?.status === "retrying", 500);
		expect(getAgentState(runDir, "agent-1")).toMatchObject({ status: "retrying", retryCount: 1 });
		expect(fs.existsSync(path.join(runDir, "agent-1", "next_retry_at"))).toBe(true);
		await retry.done;
		expect(completed).toMatchObject({ exitCode: 0, state: { status: "done", retryCount: 1 } });
		expect(fs.readFileSync(path.join(runDir, "agent-1", "result.md"), "utf-8")).toBe("retry ok");
		expect(fs.existsSync(path.join(runDir, "agent-1", "retry_pending"))).toBe(false);
	});

	test.serial("falls back to configured provider models on quota limit failures in the current session", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-model-fallback");
		const attemptFile = path.join(cwd, "attempts.json");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
const fs = require("node:fs");
const attemptFile = ${JSON.stringify(attemptFile)};
process.stdin.on("data", () => {
  const args = process.argv;
  const model = args[args.indexOf("--model") + 1];
  const attempts = fs.existsSync(attemptFile) ? JSON.parse(fs.readFileSync(attemptFile, "utf8")) : [];
  attempts.push(model);
  fs.writeFileSync(attemptFile, JSON.stringify(attempts));
  if (model === "primary/model") {
    console.log(JSON.stringify({ type: "response", command: "prompt", success: false, error: "429 Rate limit reached for primary/model" }));
  } else {
    console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "fallback ok on " + model }] }] }));
  }
  setTimeout(() => process.exit(0), 0);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		let firstCompletion: any;
		const first = spawnAgentWithRetry(runDir, { id: "agent-1", task: "Fallback", model: "primary/model" }, cwd, (completion) => {
			firstCompletion = completion;
		}, { retry: { maxRetries: 0, backoffMs: 10 }, extraArgs: [], fallbackModels: ["fallback/model"] });
		await first.done;

		expect(firstCompletion).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(JSON.parse(fs.readFileSync(attemptFile, "utf-8"))).toEqual(["primary/model", "fallback/model"]);
		expect(fs.readFileSync(path.join(runDir, "agent-1", "result.md"), "utf-8")).toBe("fallback ok on fallback/model");
		expect(fs.readFileSync(path.join(runDir, "agent-1", "model_fallback_from"), "utf-8")).toBe("primary/model");
		expect(fs.readFileSync(path.join(runDir, "agent-1", "model_fallback_to"), "utf-8")).toBe("fallback/model");

		const secondRun = createRunDir(cwd, "spawn-model-fallback-session");
		let secondCompletion: any;
		const second = spawnAgentWithRetry(secondRun, { id: "agent-2", task: "Fallback again", model: "primary/model" }, cwd, (completion) => {
			secondCompletion = completion;
		}, { retry: { maxRetries: 0, backoffMs: 10 }, extraArgs: [], fallbackModels: ["fallback/model"] });
		await second.done;

		expect(secondCompletion).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(JSON.parse(fs.readFileSync(attemptFile, "utf-8"))).toEqual(["primary/model", "fallback/model", "fallback/model"]);
		expect(fs.readFileSync(path.join(secondRun, "agent-2", "model"), "utf-8")).toBe("fallback/model");

		const thirdRun = createRunDir(cwd, "spawn-provider-fallback-session");
		let thirdCompletion: any;
		const third = spawnAgentWithRetry(thirdRun, { id: "agent-3", task: "Same provider again", model: "primary/other" }, cwd, (completion) => {
			thirdCompletion = completion;
		}, { retry: { maxRetries: 0, backoffMs: 10 }, extraArgs: [], fallbackModels: ["fallback/other"] });
		await third.done;

		expect(thirdCompletion).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(JSON.parse(fs.readFileSync(attemptFile, "utf-8"))).toEqual(["primary/model", "fallback/model", "fallback/model", "fallback/other"]);
		expect(fs.readFileSync(path.join(thirdRun, "agent-3", "model"), "utf-8")).toBe("fallback/other");
	});

	test.serial("waits for Antigravity all-accounts exhaustion before provider fallback", async () => {
		const runDir = tempDir();
		const agentDir = createAgent(runDir, "agent-1", { "exit_code": "1" });
		const baseCompletion = {
			runDir,
			agentId: "agent-1",
			agentDir,
			exitCode: 1,
			state: getAgentState(runDir, "agent-1")!,
		};

		writeFile(path.join(agentDir, "result.md"), "429 quota exceeded on one Antigravity account; rotated account may still work");
		expect(isQuotaLimitCompletion(baseCompletion, "antigravity/gemini-3-flash-preview")).toBe(false);
		expect(isQuotaLimitCompletion(baseCompletion, "openai-codex/gpt-5.5")).toBe(true);

		writeFile(path.join(agentDir, "result.md"), "ANTIGRAVITY_ALL_ACCOUNTS_EXHAUSTED model=gemini status=429: all configured Antigravity accounts are exhausted for this model");
		expect(isQuotaLimitCompletion(baseCompletion, "antigravity/gemini-3-flash-preview")).toBe(true);
		rememberSessionModelFallback("antigravity/gemini-3-flash-preview", "openai-codex/gpt-5.5");
		expect(selectSessionModelWithFallback("antigravity/gemini-3-flash-preview", ["openai-codex/gpt-5.5"])).toMatchObject({
			model: "openai-codex/gpt-5.5",
			fellBack: true,
		});
		expect(selectSessionModelWithFallback("antigravity/gemini-3.1-pro-preview", ["openai-codex/gpt-5.5"])).toEqual({
			model: "antigravity/gemini-3.1-pro-preview",
			fellBack: false,
		});
	});

	test.serial("does not retry stopped agents or explicitly empty retryable exit codes", async () => {
		const stoppedCwd = tempDir();
		const stoppedRun = createRunDir(stoppedCwd, "spawn-retry-stopped");
		const stoppedAttemptFile = path.join(stoppedCwd, "attempt.txt");
		const stoppedScript = path.join(tempDir(), "pi.js");
		writeFile(stoppedScript, `
const fs = require("node:fs");
const attemptFile = ${JSON.stringify(stoppedAttemptFile)};
process.stdin.on("data", () => {
  const attempt = fs.existsSync(attemptFile) ? Number(fs.readFileSync(attemptFile, "utf8")) + 1 : 1;
  fs.writeFileSync(attemptFile, String(attempt));
  console.log(JSON.stringify({ type: "response", command: "prompt", success: false, error: "stop before retry" }));
  setTimeout(() => process.exit(0), 0);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = stoppedScript;
		let stoppedCompletion: any;
		const stopped = spawnAgentWithRetry(stoppedRun, { id: "agent-stopped", task: "Stopped" }, stoppedCwd, (completion) => {
			stoppedCompletion = completion;
		}, { retry: { maxRetries: 1, backoffMs: 50 }, extraArgs: [] });
		await waitUntil(() => getAgentState(stoppedRun, "agent-stopped")?.status === "retrying", 500);
		const [stoppedResult] = stopAgents(stoppedRun, ["agent-stopped"], { signal: "SIGTERM" });
		expect(stoppedResult).toMatchObject({ id: "agent-stopped", stopped: true, previousStatus: "retrying" });
		await stopped.done;
		expect(stoppedCompletion.state.status).toBe("stopped");
		expect(fs.readFileSync(stoppedAttemptFile, "utf-8")).toBe("1");
		expect(fs.existsSync(path.join(stoppedRun, "agent-stopped", "retry_pending"))).toBe(false);

		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-retry-disabled");
		const attemptFile = path.join(cwd, "attempt.txt");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
const fs = require("node:fs");
const attemptFile = ${JSON.stringify(attemptFile)};
process.stdin.on("data", () => {
  const attempt = fs.existsSync(attemptFile) ? Number(fs.readFileSync(attemptFile, "utf8")) + 1 : 1;
  fs.writeFileSync(attemptFile, String(attempt));
  console.log(JSON.stringify({ type: "response", command: "prompt", success: false, error: "permanent" }));
  setTimeout(() => process.exit(0), 0);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;
		let disabledCompletion: any;
		const disabled = spawnAgentWithRetry(runDir, { id: "agent-1", task: "No retry" }, cwd, (completion) => {
			disabledCompletion = completion;
		}, { retry: { maxRetries: 2, backoffMs: 10, retryableExitCodes: [] }, extraArgs: [] });
		await disabled.done;
		expect(disabledCompletion).toMatchObject({ exitCode: 1, state: { status: "failed" } });
		expect(fs.readFileSync(attemptFile, "utf-8")).toBe("1");
		expect(fs.existsSync(path.join(runDir, "agent-1", "retry_pending"))).toBe(false);
	});

	test.serial("terminates agents that exceed the execution timeout", async () => {
		expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(30 * 60 * 1000);
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-timeout");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {});
setTimeout(() => {}, 10000);
`);
		process.argv[1] = piScript;

		const completed = await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "agent-1", task: "Hang" }, cwd, [], undefined, resolve, { timeoutMs: 30 });
		}), "Timed out waiting for timeout spawn completion");

		const agentDir = path.join(runDir, "agent-1");
		expect(completed.exitCode).toBe(124);
		expect(completed.state.status).toBe("failed");
		expect(fs.readFileSync(path.join(agentDir, "exit_code"), "utf-8")).toBe("124");
		expect(fs.readFileSync(path.join(agentDir, "timeout_ms"), "utf-8")).toBe("30");
		expect(fs.readFileSync(path.join(agentDir, "result.md"), "utf-8")).toContain("timed out");
	});

	test.serial("records invalid final JSON lines and exits with process status", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-invalid-json");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  process.stdout.write("{not json");
  process.exit(7);
});
`);
		process.argv[1] = piScript;

		const completed = await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "agent-1", task: "Do work" }, cwd, [], undefined, resolve);
		}), "Timed out waiting for invalid-json spawn completion");

		expect(completed.exitCode).toBe(7);
		expect(completed.state.status).toBe("failed");
		expect(fs.readFileSync(path.join(runDir, "agent-1", "stderr.log"), "utf-8")).toContain("Invalid RPC JSON line");
	});

	test.serial("falls back to synthetic completion state if agent state disappears", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "spawn-fallback-state");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  setTimeout(() => {
    console.log(JSON.stringify({ type: "agent_end", messages: [] }));
    setTimeout(() => process.exit(0), 0);
  }, 30);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		let spawnedAgentDir = "";
		const completedPromise = new Promise<any>((resolve) => {
			spawnedAgentDir = spawnAgent(runDir, { id: "agent-1", task: "Do work" }, cwd, [], undefined, resolve).agentDir;
		});
		fs.unlinkSync(path.join(spawnedAgentDir, "prompt.md"));
		const completed = await withTimeout(completedPromise, "Timed out waiting for fallback-state spawn completion");

		expect(completed).toMatchObject({ exitCode: 0, state: { id: "agent-1", status: "done", exitCode: 0 } });
	});
});
