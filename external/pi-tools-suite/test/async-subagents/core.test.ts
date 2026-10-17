import { afterEach, describe, expect, test } from "bun:test";
import { spawn as spawnChild } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildStructuredResult,
	buildSubagentCatalogPrompt,
	compactStructuredResult,
	settleStructuredResult,
	createSemaphore,
	currentModelRef,
	DEFAULT_AGENT_TIMEOUT_MS,
	DEFAULT_RPC_EVENT_LINE_MAX_CHARS,
	DEFAULT_STDERR_LOG_MAX_BYTES,
	findCleanupCandidates,
	filterSubagentConfigForParentModel,
	generatePrompt,
	getAgentState,
	getBuiltinSubagentDefinitionsDir,
	getBrowserQaRunnerPath,
	getUiQaRunnerPath,
	getPiInvocation,
	getRunRoot,
	getRunState,
	isBlindModelRef,
	isQuotaLimitCompletion,
	isSubagentTypeAvailableForParent,
	loadSubagentConfig,
	projectAgentDefinitionFiles,
	readAgentDefinitionsFromDir,
	readProjectAgentDefinitions,
	readResult,
	rememberSessionModelFallback,
	resetSessionModelFallbacks,
	resolveAgentTaskConfig,
	routeSubagentTasks,
	resolveSubagentLogLimits,
	selectSessionModelWithFallback,
	selectSubagentType,
	shouldForceCurrentSubagentModel,
	spawnAgent,
	spawnAgentWithRetry,
	stopAgents,
	validateBasename,
	validateStopSignal,
	waitForAgents,
} from "../../src/async-subagents/lib.js";
import { isRecord, isoNow, serializeJsonLine } from "../../src/async-subagents/core/utils.js";
import { batchBaseName, parseRunKey, runKey, scopeDir } from "../../src/async-subagents/core/paths.js";
import { createBatch, forgetRecord, getLive, getRecord, resetSubagentStoreForTest, resolveScope, updateLive, updateRecord, type SubagentRecordPatch } from "../../src/async-subagents/core/store.js";
import { normalizeRunDir, resolveSubagentAgentRunDir, resolveSubagentRunDir } from "../../src/async-subagents/core/lookup.js";
import { readResultText } from "../../src/async-subagents/core/state.js";
import { agentStrategyPrompt, appendAgentStrategyPrompt, SUBAGENT_DELEGATION_GUIDANCE } from "../../src/async-subagents/core/agent-strategy.js";
import { DEFAULT_OWNED_LAUNCH_TIMEOUTS } from "../../src/async-subagents/core/owned-launch/launcher.js";
import { activityFromRpcEvent } from "../../src/async-subagents/core/activity.js";
import { buildAgentCompletionNotification, isTerminalAgentStatus } from "../../src/async-subagents/core/notifications.js";
import type { AgentTask } from "../../src/async-subagents/lib.js";

const tempDirs: string[] = [];
let originalArgv1 = process.argv[1];
const originalAsyncSubagentsModel = process.env.ASYNC_SUBAGENTS_MODEL;
const originalPiSubagentsModel = process.env.PI_SUBAGENTS_MODEL;
const originalAsyncSubagentsForceCurrentModel = process.env.ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL;
const originalPiSubagentsForceCurrentModel = process.env.PI_SUBAGENTS_FORCE_CURRENT_MODEL;
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

function writeLegacyAgent(runDir: string, id: string, files: Record<string, string> = {}): string {
	const agentDir = path.join(runDir, id);
	writeFile(path.join(agentDir, "prompt.md"), `prompt for ${id}`);
	for (const [name, content] of Object.entries(files)) {
		writeFile(path.join(agentDir, name), content);
	}
	return agentDir;
}

function newRun(cwd = tempDir(), name = "2026-01-01T00-00-00-run"): string {
	return runKey(cwd, resolveScope(undefined), name);
}

function createAgent(runDir: string, id: string, patch: SubagentRecordPatch & { resultText?: string; stderr?: string; active?: boolean } = {}): void {
	const { resultText, stderr, active, ...record } = patch;
	const status = record.status ?? (record.exitCode === undefined ? "running" : record.exitCode === 0 ? "done" : "failed");
	updateRecord(runDir, id, { turn: 1, ...record, status });
	if (resultText !== undefined || stderr !== undefined || active !== undefined) {
		updateLive(runDir, id, {
			...(resultText !== undefined ? { resultText } : {}),
			...(stderr !== undefined ? { stderrTail: stderr } : {}),
			...(active !== undefined ? { active } : {}),
		});
	}
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
	resetSessionModelFallbacks();
	resetSubagentStoreForTest();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.serial("core paths", () => {
	test.serial("builds batch run keys without creating directories", () => {
		const cwd = tempDir();
		expect(getRunRoot(cwd)).toBe(path.join(cwd, ".pi", "subagents"));
		expect(batchBaseName("my-run_1")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-my-run_1$/);
		const scope = resolveScope(undefined);
		const runDir = createBatch(cwd, scope, "my-run_1");
		expect(parseRunKey(runDir)).toMatchObject({ cwd, scope, batch: path.basename(runDir) });
		expect(fs.existsSync(runDir)).toBe(false);
		expect(parseRunKey(path.join(cwd, ".pi", "subagents", "legacy-run"))).toBeUndefined();
		expect(normalizeRunDir(cwd, scope, path.basename(runDir))).toBe(runDir);
		expect(normalizeRunDir(cwd, scope, runDir)).toBe(runDir);
		expect(() => normalizeRunDir(cwd, scope, "/elsewhere/run")).toThrow("Run not found");
	});

	test.serial("rejects unsafe basenames", () => {
		expect(() => validateBasename("agent-1.ok", "agentId")).not.toThrow();
		expect(() => validateBasename("../escape", "agentId")).toThrow("Invalid agentId");
		expect(() => validateBasename("has space", "agentId")).toThrow("Invalid agentId");
		expect(() => validateBasename("agent..x", "agentId")).toThrow('Must not contain ".."');
		expect(() => batchBaseName("bad/slug")).toThrow("Invalid slug");
	});

	test.serial("resolves omitted runDir from the session store", () => {
		const cwd = tempDir();
		const scope = resolveScope(undefined);
		expect(() => resolveSubagentRunDir({ cwd })).toThrow("no sub-agent runs");
		const runA = runKey(cwd, scope, "2026-01-01T00-00-00-a");
		updateRecord(runA, "agent-1", { cwd, status: "planned", createdAt: "2026-01-01T00:00:00.000Z" });
		expect(resolveSubagentRunDir({ cwd })).toBe(runA);
		expect(resolveSubagentAgentRunDir({ cwd }, "agent-1")).toBe(runA);
		const runB = runKey(cwd, scope, "2026-01-02T00-00-00-b");
		updateRecord(runB, "agent-2", { cwd, status: "planned", createdAt: "2026-01-02T00:00:00.000Z" });
		expect(resolveSubagentRunDir({ cwd })).toBe(runB);
		expect(resolveSubagentAgentRunDir({ cwd }, "agent-1")).toBe(runA);
		expect(resolveSubagentAgentRunDir({ cwd }, "agent-2")).toBe(runB);
		expect(() => resolveSubagentAgentRunDir({ cwd }, "missing-agent")).toThrow('agent "missing-agent" was not found');
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

	test.serial("resolves bounded sub-agent log limits from env", () => {
		expect(resolveSubagentLogLimits({})).toEqual({
			stderrMaxBytes: DEFAULT_STDERR_LOG_MAX_BYTES,
			rpcEventLineMaxChars: DEFAULT_RPC_EVENT_LINE_MAX_CHARS,
			debugLogs: false,
		});
		expect(resolveSubagentLogLimits({ ASYNC_SUBAGENTS_DEBUG_LOGS: "1" })).toEqual({
			stderrMaxBytes: DEFAULT_STDERR_LOG_MAX_BYTES,
			rpcEventLineMaxChars: DEFAULT_RPC_EVENT_LINE_MAX_CHARS,
			debugLogs: true,
		});
		expect(resolveSubagentLogLimits({
			ASYNC_SUBAGENTS_MAX_STDERR_BYTES: "456",
			ASYNC_SUBAGENTS_MAX_RPC_LINE_CHARS: "789",
		})).toEqual({ stderrMaxBytes: 456, rpcEventLineMaxChars: 789, debugLogs: false });
		expect(resolveSubagentLogLimits({
			PI_SUBAGENTS_MAX_STDERR_BYTES: "654",
			PI_SUBAGENTS_MAX_RPC_LINE_CHARS: "987",
		})).toEqual({ stderrMaxBytes: 654, rpcEventLineMaxChars: 987, debugLogs: false });
	});

	test.serial("formats utility values", () => {
		expect(isoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
		expect(serializeJsonLine({ ok: true })).toBe('{"ok":true}\n');
		expect(isRecord({})).toBe(true);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("x")).toBe(false);
	});

	test.serial("instructs parents to brief sub-agents in English without translating literal content", () => {
		expect(SUBAGENT_DELEGATION_GUIDANCE).toContain("Write sub-agent briefs in English to save tokens.");
		expect(SUBAGENT_DELEGATION_GUIDANCE).toContain("Preserve exact literals and required user-facing text");
		expect(SUBAGENT_DELEGATION_GUIDANCE).toContain("reply to the user in their language");
	});

	test.serial("uses economical context-aware orchestration regardless of parent tier", () => {
		for (const modelRef of ["zai/glm-5-turbo", "openai/gpt-5.4", "openai-codex/gpt-6-luna", "openai-codex/gpt-6-sol"]) {
			const prompt = agentStrategyPrompt({ modelRef, env: {} })!;
			expect(prompt).toContain('name="cost-aware-orchestrator"');
			expect(prompt).toContain("Delegation triggers and mandatory gates are defined in the subagents tool description");
			expect(prompt).toContain("Give each worker a scoped task");
			expect(prompt).not.toContain("Write code in the parent by default");
			expect(prompt).toContain("wait only when a child result blocks the next decision");
			expect(prompt).toContain("decide in the parent whether an oracle is justified");
			expect(prompt).not.toContain("escalate deep");
		}
		expect(agentStrategyPrompt({ modelRef: "openai/gpt-5.5", customPrompt: true, env: {} })).toBeUndefined();
		expect(agentStrategyPrompt({ modelRef: "zai/glm-5.2", env: { PI_AGENT_STRATEGY: "off" } })).toBeUndefined();
		for (const strategy of ["deep-work", "parallel_first", "escalation"]) {
			expect(agentStrategyPrompt({ env: { PI_AGENT_STRATEGY: strategy } })).toContain('name="cost-aware-orchestrator"');
		}
		expect(agentStrategyPrompt({ modelRef: "openai/gpt-5.4", env: { PI_AGENT_STRATEGY: "cost-aware" } })).toContain('name="cost-aware-orchestrator"');
		expect(appendAgentStrategyPrompt("base\n", "strategy")).toBe("base\n\nstrategy");
	});

	test.serial("generates and writes prompts with defaults and scope", () => {
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
		expect(prompt).toContain("unique task/run directories under the current project's .pi/artifacts/");
		expect(prompt).toContain("never use project-root artifacts/ or .artifacts/ for scratch output");
		expect(prompt).toContain("Harness-owned sub-agent/QA workspaces live in .pi/artifacts/subagents/");
		expect(prompt).toContain("user-requested deliverable paths are exceptions");

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
	test.serial("loads bundled roles and runtime defaults without public sub-agent config", () => {
		const cwd = tempDir();
		const config = loadSubagentConfig(cwd, {});
		expect(config.maxConcurrent).toBe(5);
		expect(config.maxResultBytes).toBe(100_000);
		expect(config.routing).toMatchObject({ maxRetries: 1, timeoutMs: 12_000 });
		expect(isBlindModelRef("zai/glm-5.3", config)).toBe(true);
		expect(isBlindModelRef("zai/glm-5.3-flash", config)).toBe(false);
		expect(Object.keys(config.types).sort()).toEqual(["implement-core", "knowledge-auditor", "mechanical", "oracle", "research", "ui-qa", "verify"]);
		expect(config.types.research.description).toContain("review");
		expect(config.types.oracle.modelSelection).toBe("frontier");
		expect(config.types.oracle.parentProviderPolicy).toBe("require-other");
		expect(config.types["oracle"].forParentTier).toBeUndefined();
		expect(buildSubagentCatalogPrompt(config, "openai-codex/gpt-6-astra")).toContain("- oracle:");
		expect(buildSubagentCatalogPrompt(config, "openai-codex/gpt-6-luna")).toContain("- oracle:");
		expect(buildSubagentCatalogPrompt(config, "openai-codex/gpt-6.1-sol")).toContain("- oracle:");
		expect(buildSubagentCatalogPrompt(config, "zai/glm-5.3")).toContain("- oracle:");
		expect(selectSubagentType({ id: "s", task: "vulnerability secret token" }, config)).toBe("research");
	});

	test.serial("uses the built-in watchdog only when the task has no timeout override", () => {
		const config = loadSubagentConfig(tempDir(), {});
		const task = { id: "probe", task: "Inspect", subagentType: "research" };
		expect(resolveAgentTaskConfig(task, config).timeoutMs).toBeUndefined();
		expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(3 * 60 * 60 * 1000);
		expect(resolveAgentTaskConfig({ ...task, timeoutMs: 4 * 60 * 60 * 1000 }, config).timeoutMs)
			.toBe(4 * 60 * 60 * 1000);
		expect(resolveAgentTaskConfig(task, config, { timeoutMs: 10_000 }).timeoutMs).toBe(10_000);
	});

	test.serial("can hide selected bundled roles while allowing project-local replacements with the same names", async () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		writeFile(
			path.join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"),
			JSON.stringify({ disabledBuiltinAgents: ["oracle", "research", "ui-qa"] }),
		);
		writeFile(path.join(cwd, ".pi", "agents", "research.md"), `---
description: Project-specific research role.
models: [zai/glm-5-turbo]
---
Research only this project.
`);

		const config = loadSubagentConfig(cwd, { HOME: homeDir });
		expect(config.types.oracle).toBeUndefined();
		expect(config.types["ui-qa"]).toBeUndefined();
		expect(config.types.research?.description).toBe("Project-specific research role.");
		expect(buildSubagentCatalogPrompt(config)).not.toContain("- oracle:");
		expect(buildSubagentCatalogPrompt(config)).not.toContain("- ui-qa:");
		expect(buildSubagentCatalogPrompt(config)).toContain("- research: Project-specific research role.");
		expect(buildSubagentCatalogPrompt(config)).toContain("Active project replacements of built-ins: research.");
		await expect(routeSubagentTasks([
			{ id: "oracle", task: "second opinion", subagentType: "oracle" },
		], config, {})).rejects.toThrow(/Unknown subagentType/);
	});

	test.serial("filters roles by parent model with deny taking precedence over allow", () => {
		const profile = {
			forParentModels: ["openai-codex/*", "zai/*"],
			notForParentModels: ["openai-codex/gpt-6-sol*"],
		};
		expect(isSubagentTypeAvailableForParent(profile, "openai-codex/gpt-6-luna")).toBe(true);
		expect(isSubagentTypeAvailableForParent(profile, "openai-codex/gpt-6-sol")).toBe(false);
		expect(isSubagentTypeAvailableForParent(profile, "anthropic/claude-opus")).toBe(false);
		expect(isSubagentTypeAvailableForParent(profile, undefined)).toBe(false);
		expect(isSubagentTypeAvailableForParent({ notForParentModels: ["zai/glm-5.3"] }, undefined)).toBe(true);

		const config = loadSubagentConfig(tempDir(), {});
		expect(filterSubagentConfigForParentModel(config, "openai-codex/gpt-6-luna").types["oracle"]).toBeDefined();
		expect(filterSubagentConfigForParentModel(config, "openai-codex/gpt-6.1-sol").types["oracle"]).toBeDefined();
		expect(filterSubagentConfigForParentModel(config, "zai/glm-5.3").types["oracle"]).toBeDefined();
	});

	test.serial("resolves the built-in balanced role models and UI QA profile", () => {
		const cwd = tempDir();
		const config = loadSubagentConfig(cwd, {});
		const resolved = resolveAgentTaskConfig({ id: "qa", task: "verify the browser bug", subagentType: "ui-qa" }, config);
		const runner = getBrowserQaRunnerPath();
		const uiRunner = getUiQaRunnerPath();

		expect(config.routing).toMatchObject({
			model: "zai/glm-5-turbo",
			fallbackModels: ["openai-codex/gpt-6-luna"],
		});
		for (const [subagentType, model, fallbackModels] of [
			["research", "openai-codex/gpt-6-luna", ["zai/glm-5.3-flash"]],
			["implement-core", "openai-codex/gpt-6.1-sol", []],
			["verify", "openai-codex/gpt-6-luna", ["zai/glm-5.3-flash"]],
		] as const) {
			const role = resolveAgentTaskConfig({ id: subagentType, task: subagentType, subagentType }, config);
			expect(role.task.model).toBe(model);
			expect(role.fallbackModels).toEqual([...fallbackModels]);
		}
		const oracle = resolveAgentTaskConfig(
			{ id: "oracle", task: "oracle", subagentType: "oracle" },
			config,
			{ parentModel: "openai-codex/gpt-6-luna" },
		);
		expect(oracle.task.thinking).toBe("high");
		expect(resolved.task.model).toBe("openai-codex/gpt-6-luna");
		expect(resolved.task.subagentType).toBe("ui-qa");
		expect(resolved.task.thinking).toBe("medium");
		expect(resolved.fallbackModels).toEqual(["zai/glm-5.3-flash", "pi-claude-code-provider/haiku"]);
		expect(resolved.task.tools).toEqual(["read", "grep", "bash"]);
		expect(resolved.timeoutMs).toBe(600_000);
		expect(fs.existsSync(runner)).toBe(true);
		expect(path.isAbsolute(runner)).toBe(true);
		expect(runner).toContain(path.join("agents", "ui-qa", "browser"));
		expect(fs.existsSync(uiRunner)).toBe(true);
		expect(path.isAbsolute(uiRunner)).toBe(true);
		const instructions = config.types["ui-qa"].promptAppend!;
		expect(instructions).not.toContain("playwright-cli");
		expect(instructions).not.toMatch(/SKILL\.md|references\//);
		expect(instructions).toContain("actual user-facing surface requested by the task");
		expect(instructions).toContain("An explicitly named project, path, URL");
		expect(instructions).toContain("Never silently redirect that check to a sandbox");
		expect(instructions).toContain("docs/qa-sandbox.md");
		// The bundled role is a thin common contract plus a deterministic
		// guide-routing workflow plus the escalation contract; backend specifics
		// load via `guide` at runtime.
		expect(instructions.length).toBeLessThan(6_500);
		expect(instructions).toContain("PI_UI_QA_RUNNER");
		expect(instructions).toContain('guide --backend browser');
		expect(instructions).toContain('guide --backend tui');
		expect(instructions).toContain('guide --backend desktop');
		expect(instructions).toContain("target.application");
		expect(instructions).toContain("never a bare application-id string");
		expect(instructions).toContain("selection.guide");
		expect(instructions).toContain("probe --flow");
		expect(instructions).toContain("run --flow");
		expect(instructions).toContain("$PI_SUBAGENT_AGENT_DIR/ui-qa/");
		expect(instructions).toContain("chmod 600");
		expect(instructions).toMatch(/safe deterministic control path/);
		expect(instructions).toMatch(/return\s+`BLOCKED`/);
		// Backend-specific guidance must live only in the backend guides.
		for (const section of ["Playwright", "Chrome DevTools", "native-terminal", "iTerm2", "Windows Terminal", "AT-SPI", "ScreenCaptureKit", "expectResponse", "snapshotAccessibility", "waitForStable", "asciicast", "pseudo-terminal", ".pi/qa_auth.jsonc"]) {
			expect(instructions).not.toContain(section);
		}
		// The base prompt must not embed provider action/auth vocabulary.
		expect(instructions).not.toContain("assertDOMMetric");
		expect(instructions).not.toContain("auth scaffold");
		expect(instructions).not.toContain("PI_BROWSER_QA_RUNNER");
		expect(generatePrompt(resolved.task)).toContain(instructions);
		expect(generatePrompt(resolved.task)).toContain("verify the browser bug");
		const parentCatalog = buildSubagentCatalogPrompt(config)!;
		expect(parentCatalog).toContain(config.types["ui-qa"].description!);
		expect(parentCatalog).not.toContain("## Flow contract");
		expect(parentCatalog).not.toContain("PI_BROWSER_QA_RUNNER");
		expect(parentCatalog).not.toContain("PI_UI_QA_RUNNER");
		const ordinary = resolveAgentTaskConfig({ id: "ordinary", task: "Review", subagentType: "research" }, config);
		expect(generatePrompt(ordinary.task)).not.toContain("PI_BROWSER_QA_RUNNER");
		expect(generatePrompt(ordinary.task)).not.toContain("PI_UI_QA_RUNNER");
	});

	test.serial("defines bundled sub-agent roles as individual markdown agent files", () => {
		const definitionsDir = getBuiltinSubagentDefinitionsDir();
		const definitions = readAgentDefinitionsFromDir(definitionsDir);

		expect(Object.keys(definitions).sort()).toEqual([
			"implement-core",
			"knowledge-auditor",
			"mechanical",
			"oracle",
			"research",
			"ui-qa",
			"verify",
		]);
		expect(definitions["implement-core"]?.raw.description).toContain("code/docs/tests/UI");
		expect(definitions["oracle"]?.raw.forParentTier).toBeUndefined();
		expect(definitions["knowledge-auditor"]?.raw.requiresIndexedProject).toBeUndefined();
		expect(definitions["knowledge-auditor"]?.raw.tools).toEqual(["read", "grep", "bash", "edit", "write"]);
		expect(definitions["implement-core"]?.raw.promptAppend).toContain("For UI work");
		expect(definitions.oracle?.raw.promptAppend).toContain("# Oracle agent");
		expect(definitions.oracle?.raw.promptAppend).toContain("# Review scope and budget");
		expect(definitions.oracle?.raw.promptAppend).toContain("exclude unrelated");
		expect(definitions.oracle?.raw.promptAppend).toContain("explicit coverage gaps");
		expect(definitions.oracle?.raw.promptAppend).toContain("Stop at an evidence-backed verdict");
		expect(definitions.oracle?.raw.timeoutSeconds).toBeUndefined();
		expect(definitions["ui-qa"]?.raw.tools).toEqual(["read", "grep", "bash"]);
		expect(definitions.verify?.raw.promptAppend).toContain(".pi/artifacts/");
		expect(definitions.verify?.raw.promptAppend).not.toContain("Keep noisy output in artifacts");
	});

	test.serial("ships the ui-qa progressive-disclosure guides in the package/sync payload without new roles", () => {
		const definitionsDir = getBuiltinSubagentDefinitionsDir();
		const guidesDir = path.join(definitionsDir, "ui-qa", "guides");
		const guides = [
			"browser.md", "browser-auth.md", "browser-playwright.md", "browser-chrome-devtools.md",
			"tui.md", "tui-pty.md", "tui-native-terminal.md",
			"desktop.md", "desktop-macos.md", "desktop-windows.md", "desktop-linux.md",
		];
		for (const guide of guides) {
			const file = path.join(guidesDir, guide);
			expect(fs.existsSync(file)).toBe(true);
			// The guide tree must stay inside the suite source: the host sync
			// mirrors `src/` and the package `files` list publishes it.
			expect(file).toContain(path.join("src", "async-subagents", "agents", "ui-qa", "guides"));
			expect(fs.statSync(file).size).toBeGreaterThan(0);
			expect(fs.statSync(file).size).toBeLessThanOrEqual(256 * 1024);
		}
		const packageManifest = JSON.parse(fs.readFileSync(path.resolve(definitionsDir, "..", "..", "..", "package.json"), "utf8"));
		expect(packageManifest.files).toContain("src");
		// Guides are non-role assets: agent discovery stays top-level *.md only.
		const definitions = readAgentDefinitionsFromDir(definitionsDir);
		expect(Object.keys(definitions).sort()).not.toContain("browser");
		expect(Object.keys(definitions).sort()).not.toContain("tui");
		expect(Object.keys(definitions).sort()).not.toContain("desktop");
	});

	test.serial("desktop QA guide separates native window discovery from application readiness", () => {
		const guide = fs.readFileSync(path.join(getBuiltinSubagentDefinitionsDir(), "ui-qa", "guides", "desktop.md"), "utf8");
		expect(guide).toContain("documented launch contract");
		expect(guide).toContain("separate frontend server");
		expect(guide).toContain("Do not launch a raw debug");
		expect(guide).toContain("application-content readiness marker");
		expect(guide).toContain("window title, process name, or empty WebView is not a readiness");
		expect(guide).toContain("visually blank/unloaded window");
		expect(guide).toContain("accessibility tree is empty");
	});

	test.serial("treats project browser-qa as an ordinary independent role, not a ui-qa alias", () => {
		const cwd = tempDir();
		writeFile(path.join(cwd, ".pi", "agents", "browser-qa.md"), `---
model: custom/qa
---
	Independent project browser role.
`);
		const config = loadSubagentConfig(cwd, {});
		const resolved = resolveAgentTaskConfig({
			id: "qa", task: "verify the browser bug", subagentType: "browser-qa",
			promptOverride: "Custom brief: {task}", promptAppend: "Check the mobile layout too.",
		}, config);

		expect(resolved.task.subagentType).toBe("browser-qa");
		expect(resolved.task.model).toBe("custom/qa");
		expect(generatePrompt(resolved.task)).toStartWith("Custom brief: verify the browser bug");
		expect(generatePrompt(resolved.task)).not.toContain("guide --backend browser");
		expect(generatePrompt(resolved.task)).toContain("Check the mobile layout too.");
		expect(config.projectAgentMetadata?.["browser-qa"]).toEqual({
			sourceName: "browser-qa",
			replacesBuiltin: false,
		});
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

	test.serial("loads project agent candidates and resolves role-owned defaults", () => {
		const cwd = tempDir();
		writeFile(path.join(cwd, ".pi", "agents", "research.md"), `---
models: zai/fast, zai/backup, openai/backup
thinking: off
extraArgs: --temperature, 0
---
Research quickly.
`);
		writeFile(path.join(cwd, ".pi", "agents", "review.md"), `---
models: openai/review-fast, openai/review-backup
thinking: medium
extraArgs: --review-fast
---
Review carefully.
`);

		const config = loadSubagentConfig(cwd, {});
		const resolved = resolveAgentTaskConfig({ id: "a", task: "Read quickly" }, config);
		expect(resolved.task.model).toBe("zai/fast");
		expect(resolved.fallbackModels).toEqual(["zai/backup", "openai/backup"]);
		expect(resolved.task.thinking).toBe("off");
		expect(resolved.extraArgs).toEqual(["--temperature", "0"]);

		const perType = resolveAgentTaskConfig({ id: "r", task: "Review", subagentType: "review" }, config);
		expect(perType.task.model).toBe("openai/review-fast");
		expect(perType.fallbackModels).toEqual(["openai/review-backup"]);
		expect(perType.task.thinking).toBe("medium");
		expect(perType.extraArgs).toEqual(["--review-fast"]);

		const explicit = resolveAgentTaskConfig({ id: "b", task: "Review", model: "manual/model", thinking: "minimal" }, config);
		expect(explicit.task.model).toBe("manual/model");
		expect(explicit.fallbackModels).toEqual([]);
		expect(explicit.task.thinking).toBe("minimal");
	});

	test.serial("uses internal runtime defaults plus per-agent retry and max result config", () => {
		const cwd = tempDir();
		writeFile(path.join(cwd, ".pi", "agents", "research.md"), `---
models: [zai/glm-5.3-flash]
maxResultBytes: 3
retry:
  maxRetries: 2
  retryableExitCodes: []
---
Research with stricter result bounds.
`);

		const config = loadSubagentConfig(cwd, {});
		expect(config.maxConcurrent).toBe(5);
		const base = resolveAgentTaskConfig({ id: "a", task: "base", subagentType: "implement-core" }, config);
		expect(base.retry).toEqual({ maxRetries: 0, backoffMs: 2000 });
		expect(base.maxResultBytes).toBe(100_000);
		const research = resolveAgentTaskConfig({ id: "r", task: "review", subagentType: "research" }, config);
		expect(research.retry).toEqual({ maxRetries: 2, backoffMs: 2000, retryableExitCodes: [] });
		expect(research.maxResultBytes).toBe(3);
	});

	test.serial("loads Markdown type profiles and resolves model/thinking/tools", () => {
		const cwd = tempDir();
		writeFile(path.join(cwd, ".pi", "agents", "scan.md"), `---
model: fast/file-model
thinking: off
tools: read, grep
extraArgs: --temperature, 0
---
Use grep first.
Return paths before findings.
`);
		writeFile(path.join(cwd, ".pi", "agents", "review.md"), `---
model: smart/review-model
thinking: high
promptOverride: Review prompt for {task}
---
`);

		const config = loadSubagentConfig(cwd, {
			ASYNC_SUBAGENTS_SCAN_MODEL: "env/fast-scan",
		});

		expect(config.defaultType).toBe("research");
		expect(config.types.scan.model).toBe("env/fast-scan");
		expect(selectSubagentType({ id: "a", task: "Do a repo-wide scan for auth files" }, config)).toBe("research");
		expect(selectSubagentType({ id: "b", task: "Careful code review", subagentType: "review" }, config)).toBe("review");
		expect(selectSubagentType({ id: "c", task: "Read this note" }, config)).toBe("research");

		const scan = resolveAgentTaskConfig({ id: "a", task: "Scan files for auth", subagentType: "scan" }, config);
		expect(scan.task).toMatchObject({ subagentType: "scan", model: "env/fast-scan", thinking: "off", tools: ["read", "grep"] });
		expect(scan.task.promptAppend).toBe("Use grep first.\nReturn paths before findings.");
		expect(scan.extraArgs).toEqual(["--temperature", "0"]);

		const review = resolveAgentTaskConfig({ id: "r", task: "review payments", subagentType: "review", promptAppend: "Task-specific note." }, config);
		expect(review.task.promptOverride).toBe("Review prompt for {task}");
		expect(review.task.promptAppend).toContain("Task-specific note.");
		expect(generatePrompt(review.task)).toStartWith("Review prompt for review payments");

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

	describe("project agent definitions (.pi/agents)", () => {
		test.serial("loads .pi/agents/*.md as local sub-agent types", () => {
			const cwd = tempDir();
			writeFile(path.join(cwd, ".pi", "agents", "local-reviewer.md"), `---
name: local-reviewer
description: Use for reviewing this project's code.
model: zai/glm-5.3
thinking: high
tools: read, grep, bash
fallbackModels:
  - openai-codex/gpt-5.6-luna
---

You are the project's staff reviewer.
Check repo rules before approving.
`);
			writeFile(path.join(cwd, ".pi", "agents", "README.md"), "# Notes\n\nNot an agent.\n");

			const files = projectAgentDefinitionFiles(cwd);
			expect(files.map((file) => path.basename(file))).toEqual(["README.md", "local-reviewer.md"]);
			expect(Object.keys(readProjectAgentDefinitions(cwd))).toEqual(["local-reviewer"]);

			const config = loadSubagentConfig(cwd, {});
			const profile = config.types["local-reviewer"];
			expect(profile?.description).toBe("Use for reviewing this project's code.");
			expect(profile?.model).toBe("zai/glm-5.3");
			expect(profile?.thinking).toBe("high");
			expect(profile?.tools).toEqual(["read", "grep", "bash"]);
			expect(profile?.fallbackModels).toEqual(["openai-codex/gpt-5.6-luna"]);
			expect(profile?.promptAppend).toBe("You are the project's staff reviewer.\nCheck repo rules before approving.");

			const resolved = resolveAgentTaskConfig({ id: "r", task: "Review the diff", subagentType: "local-reviewer" }, config);
			expect(resolved.task.model).toBe("zai/glm-5.3");
			expect(resolved.task.thinking).toBe("high");
			expect(resolved.task.tools).toEqual(["read", "grep", "bash"]);
			expect(generatePrompt(resolved.task)).toContain("Additional instructions from sub-agent profile:\nYou are the project's staff reviewer.");
			expect(generatePrompt(resolved.task)).toContain("Review the diff");
		});

		test.serial("parses nested modelByParent and retry from frontmatter", () => {
			const cwd = tempDir();
			writeFile(path.join(cwd, ".pi", "agents", "local-oracle.md"), `---
description: Second opinion.
forParentModels: openai-codex/*, zai/*
notForParentModels: [openai-codex/gpt-5.6-sol*]
modelByParent:
  zai/*: zai/glm-5.3
  openai-codex/*:
    model: openai-codex/gpt-5.6-sol
    fallbackModels: [zai/glm-5.3]
retry:
  maxRetries: 2
  backoffMs: 250
  retryableExitCodes: [1, 124]
timeoutMs: 600000
---

Advise only.
`);
			const config = loadSubagentConfig(cwd, {});
			const profile = config.types["local-oracle"];
			expect(profile?.modelByParent).toEqual({
				"zai/*": { model: "zai/glm-5.3", fallbackModels: [] },
				"openai-codex/*": { model: "openai-codex/gpt-5.6-sol", fallbackModels: ["zai/glm-5.3"] },
			});
			expect(profile?.forParentModels).toEqual(["openai-codex/*", "zai/*"]);
			expect(profile?.notForParentModels).toEqual(["openai-codex/gpt-5.6-sol*"]);
			expect(profile?.retry).toEqual({ maxRetries: 2, backoffMs: 250, retryableExitCodes: [1, 124] });
			expect(profile?.timeoutMs).toBe(600000);

			const resolved = resolveAgentTaskConfig(
				{ id: "o", task: "Sanity check the plan", subagentType: "local-oracle" },
				config,
				{ parentModel: "openai-codex/gpt-5.6-luna" },
			);
			expect(resolved.task.model).toBe("openai-codex/gpt-5.6-sol");
			expect(resolved.fallbackModels).toEqual(["zai/glm-5.3"]);
		});

		test.serial("walks up to find .pi/agents and ignores legacy project config type fields", () => {
			const cwd = tempDir();
			writeFile(path.join(cwd, ".pi", "pi-tools-suite.jsonc"), JSON.stringify({
				asyncSubagents: { types: { "shared-name": { model: "jsonc/model", thinking: "low" } } },
			}));
			writeFile(path.join(cwd, ".pi", "agents", "shared-name.md"), "---\ndescription: md wins\nmodel: md/model\n---\nRole text.\n");

			const config = loadSubagentConfig(path.join(cwd, "packages", "app"), {});
			expect(config.types["shared-name"].model).toBe("md/model");
			expect(config.types["shared-name"].description).toBe("md wins");
			expect(config.types["shared-name"].thinking).toBeUndefined();
			expect(config.types["shared-name"].promptAppend).toBe("Role text.");
		});

		test.serial("parses icon frontmatter and does not inherit legacy JSONC type fields", () => {
			const cwd = tempDir();
			writeFile(path.join(cwd, ".pi", "pi-tools-suite.jsonc"), JSON.stringify({
				asyncSubagents: { types: { "shared-name": { model: "jsonc/model", icon: "book" } } },
			}));
			writeFile(path.join(cwd, ".pi", "agents", "shared-name.md"), "---\ndescription: md wins\nmodel: md/model\n---\nRole text.\n");

			const config = loadSubagentConfig(path.join(cwd, "packages", "app"), {});
			expect(config.types["shared-name"].icon).toBeUndefined();

			const mdCwd = tempDir();
			writeFile(path.join(mdCwd, ".pi", "agents", "local-searcher.md"), "---\ndescription: finder\nicon: search\n---\nFind things.\n");
			const mdConfig = loadSubagentConfig(mdCwd, {});
			expect(mdConfig.types["local-searcher"]?.icon).toBe("search");

			// Built-in bundled agents ship icons.
			const builtin = loadSubagentConfig(tempDir(), {});
			expect(builtin.types.research?.icon).toBe("search");
			expect(builtin.types["implement-core"]?.icon).toBe("code");
			expect(builtin.types.verify?.icon).toBe("flask");
			expect(builtin.types["ui-qa"]?.icon).toBe("bug");
			expect(builtin.types["knowledge-auditor"]?.icon).toBe("book-open");
			expect(builtin.types.oracle?.icon).toBe("sparkles");
		});

		test.serial("ignores removed ASYNC_SUBAGENTS_CONFIG while keeping .pi/agents authoritative", () => {
			const cwd = tempDir();
			writeFile(path.join(cwd, ".pi", "agents", "local-only.md"), "---\ndescription: x\n---\nBody.\n");
			const explicit = path.join(cwd, "explicit.json");
			writeFile(explicit, "{ this is intentionally invalid legacy config");

			const config = loadSubagentConfig(cwd, { ASYNC_SUBAGENTS_CONFIG: explicit });
			expect(config.types["local-only"]?.description).toBe("x");
			expect(config.types["local-only"]?.model).toBeUndefined();
		});

		test.serial("rejects name mismatch, invalid names, and unsupported YAML", () => {
			const cwd = tempDir();
			const agentsDir = path.join(cwd, ".pi", "agents");

			writeFile(path.join(agentsDir, "foo.md"), "---\nname: bar\ndescription: x\n---\n");
			expect(() => loadSubagentConfig(cwd, {})).toThrow(/does not match the file name/);
			fs.rmSync(agentsDir, { recursive: true });

			writeFile(path.join(agentsDir, "bad name.md"), "---\ndescription: x\n---\n");
			expect(() => readProjectAgentDefinitions(cwd)).toThrow(/not a valid sub-agent type name/);
			fs.rmSync(agentsDir, { recursive: true });

			writeFile(path.join(agentsDir, "flow.md"), "---\ndescription: {a: b}\n---\n");
			expect(() => loadSubagentConfig(cwd, {})).toThrow(/Flow maps/);
			fs.rmSync(agentsDir, { recursive: true });

			writeFile(path.join(agentsDir, "tabs.md"), "---\nmodel: x\n\ttools: read\n---\n");
			expect(() => loadSubagentConfig(cwd, {})).toThrow(/Tabs are not allowed/);
			fs.rmSync(agentsDir, { recursive: true });

			writeFile(path.join(agentsDir, "unknown.md"), "---\ntool: read\n---\n");
			expect(() => loadSubagentConfig(cwd, {})).toThrow(/Unknown agent frontmatter key "tool"/);
			fs.rmSync(agentsDir, { recursive: true });

			writeFile(path.join(agentsDir, "skills.md"), "---\nisolatedSkills: private/review.md\n---\n");
			expect(() => loadSubagentConfig(cwd, {})).toThrow(/Unknown agent frontmatter key "isolatedSkills"/);
		});

		test.serial("reloads .pi/agents without caching (respects /reload and live edits)", () => {
			const cwd = tempDir();
			const agentFile = path.join(cwd, ".pi", "agents", "live.md");
			writeFile(agentFile, "---\ndescription: first\nmodel: first/model\n---\nFirst body.\n");
			const before = loadSubagentConfig(cwd, {});
			expect(before.types.live?.model).toBe("first/model");
			expect(before.types.live?.promptAppend).toBe("First body.");

			writeFile(agentFile, "---\ndescription: second\nmodel: second/model\n---\nSecond body.\n");
			const after = loadSubagentConfig(cwd, {});
			expect(after.types.live?.model).toBe("second/model");
			expect(after.types.live?.promptAppend).toBe("Second body.");

			fs.rmSync(agentFile);
			const gone = loadSubagentConfig(cwd, {});
			expect(gone.types.live).toBeUndefined();
		});
	});

	test.serial("resolves modelByParent from the current parent model", () => {
		const cwd = tempDir();
		writeFile(path.join(cwd, ".pi", "agents", "quick.md"), `---
model: zai/glm-4.5-air
thinking: off
---
Quick work.
`);
		writeFile(path.join(cwd, ".pi", "agents", "oracle.md"), `---
description: Cross-provider second opinion.
model: openai-codex/gpt-5.5
fallbackModels: zai/glm-5.2, openai-codex/gpt-5.5
parentProviderPolicy: any
thinking: xhigh
modelByParent:
  zai/*:
    model: openai-codex/gpt-5.5
    fallbackModels: zai/glm-5.2
  openai-codex/*: zai/glm-5.2
  antigravity/*:
    model: zai/glm-5.2
    fallbackModels: openai-codex/gpt-5.5
---
Give a second opinion.
`);
		const config = loadSubagentConfig(cwd, {});

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
			{ id: "f", task: "tiny", subagentType: "quick" },
			config,
			{ parentModel: "zai/glm-5.2" },
		);
		expect(quick.task.model).toBe("zai/glm-4.5-air");
	});

	test.serial("does not map removed builtin role names onto canonical roles", async () => {
		const cwd = tempDir();
		const config = loadSubagentConfig(cwd, {});

		for (const subagentType of ["review", "deep"] as const) {
			await expect(routeSubagentTasks([
				{ id: subagentType, task: subagentType, subagentType },
			], config, {})).rejects.toThrow(/Unknown subagentType/);
		}
	});

	test.serial("detects force-current-model env flags and formats current model refs", () => {
		expect(shouldForceCurrentSubagentModel({})).toBe(false);
		expect(shouldForceCurrentSubagentModel({ ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL: "1" })).toBe(true);
		expect(shouldForceCurrentSubagentModel({ PI_SUBAGENTS_FORCE_CURRENT_MODEL: "yes" })).toBe(true);
		expect(shouldForceCurrentSubagentModel({ ASYNC_SUBAGENTS_USE_CURRENT_MODEL: "on" })).toBe(true);
		expect(currentModelRef({ provider: "zai", id: "glm-5-turbo" })).toBe("zai/glm-5-turbo");
		expect(currentModelRef({ provider: "zai", id: "zai/glm-5-turbo" })).toBe("zai/glm-5-turbo");
		expect(currentModelRef({ providerId: "openai-codex", modelId: "gpt-5.6-sol" })).toBe("openai-codex/gpt-5.6-sol");
		expect(currentModelRef("openai-codex/gpt-5.6-luna")).toBe("openai-codex/gpt-5.6-luna");
		expect(currentModelRef({ id: "openai/gpt-5" })).toBe("openai/gpt-5");
		expect(currentModelRef(undefined)).toBeUndefined();
	});
});

describe.serial("run and agent state", () => {
	test.serial("maps only user-visible RPC activity in memory", () => {
		const at = "2026-09-08T12:00:00.000Z";
		expect(activityFromRpcEvent({ type: "tool_execution_start", toolName: "Grep" }, at)).toEqual({ label: "Grep", at });
		expect(activityFromRpcEvent({ type: "tool_execution_end", toolName: "Grep" }, at)).toBeUndefined();
		expect(activityFromRpcEvent({ type: "message_start", message: { role: "assistant" } }, at)).toEqual({ label: "Thinking", at });
		expect(activityFromRpcEvent({ type: "message_end", role: "assistant" }, at)).toEqual({ label: "Thinking", at });
		expect(activityFromRpcEvent({ type: "message_start", message: { role: "user" } }, at)).toBeUndefined();
		expect(activityFromRpcEvent({ type: "turn_start" }, at)).toBeUndefined();
	});

	test.serial("detects planned, running, done, failed, and stopped agents", () => {
		const runDir = newRun();
		createAgent(runDir, "planned", { status: "planned", active: true });
		createAgent(runDir, "done", { exitCode: 0, startedAt: "2024-01-01T00:00:00Z", finishedAt: "2024-01-01T00:00:02Z", resultText: "a\nb\n" });
		createAgent(runDir, "failed", { exitCode: 2 });
		createAgent(runDir, "stopped", { status: "stopped", stopRequested: true });
		createAgent(runDir, "running", { pid: process.pid, active: true, stderr: "warn\nerr" });
		createAgent(runDir, "dead-pid", { pid: 99999999 });

		expect(getAgentState(runDir, "missing")).toBeNull();
		expect(getAgentState(runDir, "done")).toMatchObject({ id: "done", status: "done", exitCode: 0, resultLines: 2 });
		expect(getAgentState(runDir, "failed")).toMatchObject({ id: "failed", status: "failed", exitCode: 2 });
		expect(getAgentState(runDir, "stopped")).toMatchObject({ id: "stopped", status: "stopped" });
		expect(getAgentState(runDir, "running")).toMatchObject({ id: "running", status: "running", pid: process.pid, stderrLines: 2 });
		expect(getAgentState(runDir, "dead-pid")).toMatchObject({ id: "dead-pid", status: "stopped", pid: 99999999 });
		expect(getAgentState(runDir, "planned")).toMatchObject({ id: "planned", status: "planned" });

		expect(getAgentState(runDir, "done", { includeLineCounts: false })?.resultLines).toBeUndefined();
		expect(getRunState(runDir, ["done"], { includeLineCounts: false }).agents[0].resultLines).toBeUndefined();

		const all = getRunState(runDir).agents.map((a) => a.id).sort();
		expect(all).toEqual(["dead-pid", "done", "failed", "planned", "running", "stopped"]);
		expect(getRunState(runDir, ["planned", "done"]).agents.map((a) => a.id).sort()).toEqual(["done", "planned"]);
		expect(getRunState(newRun(tempDir(), "missing")).agents).toEqual([]);
	});

	test.serial("reads result and stderr for an agent", () => {
		const runDir = newRun();
		createAgent(runDir, "agent-1", { exitCode: 0, resultText: "final answer", stderr: "warning\n" });

		expect(readResult(runDir, "missing")).toBeNull();
		expect(readResult(runDir, "agent-1")).toMatchObject({
			result: "final answer",
			stderr: "warning\n",
			exitCode: 0,
			state: { id: "agent-1", status: "done" },
		});
	});

	test.serial("settles a compact structured result on the parent record", () => {
		const runDir = newRun();
		createAgent(runDir, "agent-structured", {
			exitCode: 0,
			startedAt: "2026-01-01T00:00:00Z",
			finishedAt: "2026-01-01T00:00:03Z",
			resultText: "abcdef",
		});

		const structured = settleStructuredResult(runDir, "agent-structured", {
			state: getAgentState(runDir, "agent-structured")!,
			subagentType: "scan",
			model: "test/model",
			maxResultBytes: 3,
		});
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
		expect(getRecord(runDir, "agent-structured")?.structured).toEqual(compactStructuredResult(structured));
		expect(getRecord(runDir, "agent-structured")?.structured?.resultText).toBeUndefined();
		expect(readResult(runDir, "agent-structured")?.structured).toEqual(compactStructuredResult(structured));
		expect(readResultText(runDir, "agent-structured")).toBe("abcdef");
	});

	test.serial("structured result extracts chaining fields without truncating the full result", () => {
		const text = [
			"Summary: inspect retry behavior.",
			"- High: bug in pi-tools-suite/src/async-subagents/core/retry.ts:42 should be fixed.",
			"- Risk: queued work may launch after stop.",
			"- Next: add regression tests.",
			"Confidence: high",
		].join("\n");
		const structured = buildStructuredResult({
			agentId: "agent-rich",
			state: { id: "agent-rich", status: "done", exitCode: 0 },
			maxResultBytes: 40,
			resultText: text,
		});
		expect(structured.schemaVersion).toBe(2);
		expect(structured.resultTruncated).toBe(true);
		expect(structured.summary).toContain("Summary");
		expect(structured.findings?.[0]).toMatchObject({ severity: "high" });
		expect(structured.files?.[0]).toMatchObject({ path: "pi-tools-suite/src/async-subagents/core/retry.ts", line: 42 });
		expect(structured.confidence).toBe("high");
		expect(structured.nextActions?.join("\n") ?? "").toContain("add regression tests");
	});

	test.serial("waits until launched agents are terminal, timeout/abort/failFast aware", async () => {
		const runDir = newRun();
		createAgent(runDir, "running", { pid: process.pid, active: true });
		setTimeout(() => {
			updateRecord(runDir, "running", { status: "done", exitCode: 0 });
			updateLive(runDir, "running", { active: false });
		}, 20);
		const completed = await waitForAgents(runDir, undefined, { timeout: 1, interval: 0.01 });
		expect(completed.agents).toContainEqual(expect.objectContaining({ id: "running", status: "done" }));

		const failFastRun = newRun(tempDir(), "fail-fast");
		createAgent(failFastRun, "failed", { exitCode: 1 });
		createAgent(failFastRun, "still-running", { pid: process.pid, active: true });
		const failFast = await waitForAgents(failFastRun, undefined, { timeout: 10, interval: 1, failFast: true });
		expect(failFast.agents).toContainEqual(expect.objectContaining({ id: "failed", status: "failed" }));
		expect(failFast.agents).toContainEqual(expect.objectContaining({ id: "still-running", status: "running" }));

		const plannedOnly = newRun(tempDir(), "planned-only");
		createAgent(plannedOnly, "planned", { status: "planned", active: true });
		expect((await waitForAgents(plannedOnly, undefined, { timeout: 1, interval: 0 })).agents).toEqual([{ id: "planned", status: "planned" }]);

		const abortRun = newRun(tempDir(), "abort");
		createAgent(abortRun, "running", { pid: process.pid, active: true });
		const controller = new AbortController();
		controller.abort();
		expect((await waitForAgents(abortRun, undefined, { timeout: 10, interval: 1, signal: controller.signal })).agents[0].status).toBe("running");

		const timeoutRun = newRun(tempDir(), "timeout");
		createAgent(timeoutRun, "running", { pid: process.pid, active: true });
		expect((await waitForAgents(timeoutRun, undefined, { timeout: 0, interval: 1 })).agents[0].status).toBe("running");
	});

	test.serial("stops running agents and records stopped metadata", async () => {
		const runDir = newRun();
		const child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
		if (!child.pid) throw new Error("child process did not start");
		createAgent(runDir, "running", { pid: child.pid });
		createAgent(runDir, "done", { exitCode: 0 });

		try {
			expect(validateStopSignal("SIGKILL")).toBe("SIGKILL");
			expect(() => validateStopSignal("SIGHUP")).toThrow("Unsupported stop signal");

			const results = stopAgents(runDir, undefined, { signal: "SIGKILL" });
			expect(results).toContainEqual(expect.objectContaining({ id: "running", stopped: true, signal: "SIGKILL", pid: child.pid }));
			expect(results).toContainEqual(expect.objectContaining({ id: "done", stopped: false, previousStatus: "done" }));
			expect(getRecord(runDir, "running")).toMatchObject({ status: "stopped", stopRequested: true, stopSignal: "SIGKILL" });
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

	test.serial("stops the launcher-owned POSIX process group", async () => {
		if (process.platform === "win32") return;
		const scratch = tempDir();
		const runDir = newRun();
		const ready = path.join(scratch, "descendant-ready");
		const signalled = path.join(scratch, "descendant-signalled");
		const descendantSource = `
const fs = require("node:fs");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(signalled)}, "SIGTERM");
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => {}, 1000);
`;
		const rootSource = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`;
		const root = spawnChild(process.execPath, ["-e", rootSource], { detached: true, stdio: "ignore" });
		if (!root.pid) throw new Error("process-group root did not start");
		createAgent(runDir, "owned-group", { pid: root.pid, processGroup: true });

		try {
			await waitUntil(() => fs.existsSync(ready), 2000);
			const [result] = stopAgents(runDir, ["owned-group"], { signal: "SIGTERM" });
			expect(result).toMatchObject({ id: "owned-group", stopped: true, signal: "SIGTERM", pid: root.pid });
			// The descendant creates the file before writing it; wait for content, not existence.
			await waitUntil(() => fs.existsSync(signalled) && fs.readFileSync(signalled, "utf-8") === "SIGTERM", 2000);
			expect(fs.readFileSync(signalled, "utf-8")).toBe("SIGTERM");
		} finally {
			try {
				process.kill(-root.pid, "SIGKILL");
			} catch {
				/* group already stopped */
			}
		}
	});

	test.serial("stops planned queued agents before they launch", () => {
		const runDir = newRun();
		createAgent(runDir, "queued", { status: "planned", active: true });

		const [result] = stopAgents(runDir, ["queued"], { signal: "SIGTERM" });
		expect(result).toMatchObject({ id: "queued", previousStatus: "planned", stopped: true, signal: "SIGTERM" });
		expect(getAgentState(runDir, "queued")).toMatchObject({ id: "queued", status: "stopped" });
		expect(getRecord(runDir, "queued")).toMatchObject({ status: "stopped", stopRequested: true });
		expect(getRecord(runDir, "queued")?.structured).toMatchObject({ agentId: "queued", status: "stopped" });
	});
});

describe.serial("cleanup candidates", () => {
	test.serial("keeps newest runs, skips incomplete/non-agent dirs, and filters by mtime", () => {
		const root = tempDir();
		const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		const recent = new Date();

		for (const name of ["2024-01-01-old-a", "2024-01-02-old-b", "2024-01-03-recent", "2024-01-04-newest"]) {
			const dir = path.join(root, name);
			writeLegacyAgent(dir, "agent-1", { exit_code: "0" });
			fs.utimesSync(dir, recent, name.includes("recent") || name.includes("newest") ? recent : old);
		}
		const incomplete = path.join(root, "2024-01-00-incomplete");
		writeLegacyAgent(incomplete, "agent-1");
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
	test.serial("delivers the inline QA workflow while disabling skills for every child", async () => {
		const cwd = path.join(tempDir(), "project with spaces");
		const config = loadSubagentConfig(cwd, {});
		const runDir = createBatch(cwd, resolveScope(undefined), "inline-qa");
		const captured = path.join(cwd, "captured-prompt.json");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "prompt") return;
  const runner = process.env.PI_BROWSER_QA_RUNNER;
  const uiRunner = process.env.PI_UI_QA_RUNNER;
  const probe = runner ? spawnSync(process.execPath, [runner, "profiles"], { encoding: "utf8" }) : undefined;
  fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify({
    message: request.message,
    runner: runner ?? null,
    uiRunner: uiRunner ?? null,
    agentDir: process.env.PI_SUBAGENT_AGENT_DIR ?? null,
    probeExit: probe?.status,
    probeOutput: probe?.stdout,
  }));
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] }));
  console.log(JSON.stringify({ type: "agent_settled" }));
});
setTimeout(() => {}, 2000);
`);
		process.argv[1] = piScript;
		const oldRunner = process.env.PI_BROWSER_QA_RUNNER;
		const oldUiRunner = process.env.PI_UI_QA_RUNNER;
		const oldAgentDir = process.env.PI_SUBAGENT_AGENT_DIR;
		try {
			// The launcher must replace inherited QA paths, and strip them for other roles.
			process.env.PI_BROWSER_QA_RUNNER = path.join(cwd, "wrong-runner.mjs");
			process.env.PI_UI_QA_RUNNER = path.join(cwd, "wrong-ui-runner.mjs");
			process.env.PI_SUBAGENT_AGENT_DIR = path.join(cwd, "wrong-agent");
			for (const id of ["qa-default", "ordinary"]) {
				const qa = id !== "ordinary";
				const resolved = resolveAgentTaskConfig({ id, task: "Check the requested target", subagentType: qa ? "ui-qa" : "research" }, config);
				await withTimeout(new Promise<any>((resolve) => {
					spawnAgent(runDir, resolved.task, cwd,
						["--skill", "injected.md", "--skill=injected-inline.md", "--no-skills", "--thinking", "high"],
						undefined, resolve);
				}), `Timed out waiting for ${id}`);
				const payload = JSON.parse(fs.readFileSync(captured, "utf8"));
				const args = (getLive(runDir, id)?.launchArgs ?? []).join("\n").split("\n");
				expect(payload.message).toBe(generatePrompt(resolved.task));
				expect(args.filter((arg) => arg === "--no-skills")).toHaveLength(1);
				expect(args).not.toContain("injected.md");
				expect(args).not.toContain("--skill=injected-inline.md");
				expect(args).not.toContain("--skill");
				expect(args).toContain("--thinking");
				expect(args).toContain("high");
				if (qa) {
					expect(payload.message).toContain('node "$PI_UI_QA_RUNNER"');
					expect(payload.message).toContain("guide --backend browser");
					// The thin prompt knows only the unified progressive router;
					// provider-specific runner details live in routed guides.
					expect(payload.message).toContain("selection.guide");
					expect(payload.message).not.toContain("PI_BROWSER_QA_RUNNER");
					expect(payload.message).not.toContain('node "$PI_BROWSER_QA_RUNNER"');
					expect(payload.message).not.toContain("## Detailed scenario-design guidance");
					 expect(payload.runner).toBe(getBrowserQaRunnerPath());
					expect(payload.uiRunner).toBe(getUiQaRunnerPath());
					expect(payload.agentDir).toBe(fs.realpathSync(path.join(cwd, ".pi", "artifacts", "subagents", `${parseRunKey(runDir)!.batch}-${id}`)));
					expect(payload.probeExit).toBe(0);
					expect(JSON.parse(payload.probeOutput).profiles).toEqual([]);
				} else {
					expect(payload.runner).toBeNull();
					expect(payload.uiRunner).toBeNull();
					expect(payload.agentDir).toBeNull();
					expect(payload.message).not.toContain("PI_BROWSER_QA_RUNNER");
					expect(payload.message).not.toContain("PI_UI_QA_RUNNER");
				}
			}
			expect(fs.existsSync(path.join(cwd, ".pi", "qa_auth.jsonc"))).toBe(false);
		} finally {
			if (oldRunner === undefined) delete process.env.PI_BROWSER_QA_RUNNER;
			else process.env.PI_BROWSER_QA_RUNNER = oldRunner;
			if (oldUiRunner === undefined) delete process.env.PI_UI_QA_RUNNER;
			else process.env.PI_UI_QA_RUNNER = oldUiRunner;
			if (oldAgentDir === undefined) delete process.env.PI_SUBAGENT_AGENT_DIR;
			else process.env.PI_SUBAGENT_AGENT_DIR = oldAgentDir;
		}
	});

	test.serial("provides UI QA with native and browser-backend workspaces and clears stale evidence on reuse", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "ui-qa-workspace");
		const agentDir = path.join(cwd, ".pi", "artifacts", "subagents", `${parseRunKey(runDir)!.batch}-qa-agent`);
		const staleEvidence = path.join(agentDir, "ui-qa", "browser", "evidence", "stale.png");
		const staleNativeEvidence = path.join(agentDir, "ui-qa", "evidence", "stale.txt");
		const capturedEnv = path.join(cwd, "captured-ui-qa-agent-dir");
		writeFile(staleEvidence, "stale");
		writeFile(staleNativeEvidence, "stale");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(capturedEnv)}, process.env.PI_SUBAGENT_AGENT_DIR || "missing");
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] }));
  setTimeout(() => process.exit(0), 0);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "qa-agent", task: "Run UI QA", subagentType: "ui-qa" }, cwd, [], undefined, resolve);
		}), "Timed out waiting for UI QA workspace spawn");

		expect(fs.readFileSync(capturedEnv, "utf8")).toBe(fs.realpathSync(agentDir));
		expect(fs.existsSync(staleEvidence)).toBe(false);
		expect(fs.existsSync(staleNativeEvidence)).toBe(false);
		expect(fs.statSync(path.join(agentDir, "ui-qa")).isDirectory()).toBe(true);
		expect(fs.statSync(path.join(agentDir, "ui-qa", "flows")).isDirectory()).toBe(true);
		expect(fs.statSync(path.join(agentDir, "ui-qa", "browser", "flows")).isDirectory()).toBe(true);
		if (process.platform !== "win32") {
			expect(fs.statSync(path.join(agentDir, "ui-qa")).mode & 0o777).toBe(0o700);
			expect(fs.statSync(path.join(agentDir, "ui-qa", "flows")).mode & 0o777).toBe(0o700);
			expect(fs.statSync(path.join(agentDir, "ui-qa", "browser")).mode & 0o777).toBe(0o700);
			expect(fs.statSync(path.join(agentDir, "ui-qa", "browser", "flows")).mode & 0o777).toBe(0o700);
		}
	});

	test.serial("streams child todo counts before live callbacks and resets old attempt counts", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "todo-progress");
		updateRecord(runDir, "worker", { status: "done", turn: 1 });
		updateLive(runDir, "worker", { todoProgress: { completed: 4, total: 5 } });
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
if (process.env.PIX_ACP_SESSION_STATE_BRIDGE !== "1") process.exit(1);
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "extension_ui_request", method: "setWidget", widgetKey: "pix.session-state",
    widgetLines: ["pi-tools-suite:todo:state", JSON.stringify({ version: 1, details: { tasks: [{ status: "completed" }, { status: "pending" }] } })] }));
  console.log(JSON.stringify({ type: "agent_end", messages: [] }));
  setTimeout(() => process.exit(0), 0);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;
		let observed: unknown;
		await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "worker", task: "Work" }, cwd, [], (event) => {
				if (event.type === "extension_ui_request") observed = getAgentState(runDir, "worker")?.todoProgress;
			}, resolve);
			expect(getLive(runDir, "worker")?.todoProgress).toBeUndefined();
		}), "Timed out waiting for todo progress spawn");
		expect(observed).toEqual({ completed: 1, total: 2 });
		expect(getAgentState(runDir, "worker")).toMatchObject({ status: "done", todoProgress: { completed: 1, total: 2 } });
	});

	test.serial("writes metadata, captures agent_end output, and notifies completion", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-ok");
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
			expect(fs.existsSync(spawned.agentDir)).toBe(false);
		});

		const completed = await withTimeout(completion, "Timed out waiting for spawn completion");
		expect(completed).toMatchObject({ runDir, agentId: "agent-1", exitCode: 0, state: { status: "done" } });
		expect(seenEvent).toMatchObject({ type: "agent_end" });
		const agentDir = path.join(runDir, "agent-1");
		expect(getRecord(runDir, "agent-1")?.cwd).toBe(cwd);
		expect((getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n")).toContain("--session-dir");
		expect((getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n")).not.toContain("--no-session");
		expect(fs.existsSync(agentDir)).toBe(false);
		expect((getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n")).toContain("--extension\n");
		expect((getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n")).toContain(path.join("model-tools", "index.ts"));
		expect((getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n")).toContain(path.join("todo", "subagent.ts"));
		expect((getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n")).toContain(path.join("repo-discovery", "subagent.ts"));
		expect((getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n")).toContain(path.join("dcp", "subagent.ts"));
		// Environment fallback models do not opt provider extensions back in.
		expect((getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n")).not.toContain(path.join("antigravity-auth", "index.ts"));
		expect((getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n")).toContain("--model\nzai/glm-5-turbo");
		expect((getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n")).toContain("--models\nzai/glm-5-turbo");
		expect((getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n")).toContain("--tools\nRead,Grep");
		expect(readResultText(runDir, "agent-1")).toBe("done result");
		expect(getRecord(runDir, "agent-1")?.exitCode).toBe(0);
		expect(fs.existsSync(path.join(agentDir, "events.jsonl"))).toBe(false);
		if (process.platform !== "win32") {
			expect(getRecord(runDir, "agent-1")?.processGroup).toBe(true);
		}
	});

	test.serial("loads Antigravity auth only for an explicitly selected Antigravity model", async () => {
		const cwd = tempDir();
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] }));
  setTimeout(() => process.exit(0), 0);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;
		process.env.ASYNC_SUBAGENTS_MODEL = "antigravity/gemini-from-env";

		const spawnAndReadArgs = async (id: string, task: AgentTask, extraArgs: string[] = []) => {
			const runDir = createBatch(cwd, resolveScope(undefined), id);
			await withTimeout(new Promise<any>((resolve) => {
				spawnAgent(runDir, task, cwd, extraArgs, undefined, resolve);
			}), `Timed out waiting for ${id}`);
			return (getLive(runDir, task.id)?.launchArgs ?? []).join("\n");
		};

		const envOnlyArgs = await spawnAndReadArgs("env-only", { id: "env-only", task: "Do work" });
		expect(envOnlyArgs).toContain("--model\nantigravity/gemini-from-env");
		expect(envOnlyArgs).not.toContain(path.join("antigravity-auth", "index.ts"));

		const taskModelArgs = await spawnAndReadArgs("task-model", {
			id: "task-model",
			task: "Do work",
			model: "antigravity/gemini-explicit",
		});
		expect(taskModelArgs).toContain(path.join("antigravity-auth", "index.ts"));
		expect(taskModelArgs).toContain("--models\nantigravity/gemini-explicit");

		const cliModelArgs = await spawnAndReadArgs(
			"cli-model",
			{ id: "cli-model", task: "Do work" },
			["--model=antigravity/gemini-cli"],
		);
		expect(cliModelArgs).toContain(path.join("antigravity-auth", "index.ts"));

		const overriddenArgs = await spawnAndReadArgs(
			"overridden-model",
			{ id: "overridden-model", task: "Do work", model: "antigravity/gemini-explicit" },
			["--model", "zai/glm-5-turbo"],
		);
		expect(overriddenArgs).not.toContain(path.join("antigravity-auth", "index.ts"));
		expect(overriddenArgs.trim().split("\n").slice(-4, -2)).toEqual(["--models", "zai/glm-5-turbo"]);

		const overriddenScopeArgs = await spawnAndReadArgs(
			"overridden-scope",
			{ id: "overridden-scope", task: "Do work", model: "zai/glm-5-turbo" },
			["--models", "antigravity/*"],
		);
		const overriddenScopeArgv = overriddenScopeArgs.trim().split("\n");
		expect(overriddenScopeArgv.slice(overriddenScopeArgv.lastIndexOf("--models"), overriddenScopeArgv.lastIndexOf("--models") + 2)).toEqual([
			"--models",
			"zai/glm-5-turbo",
		]);
	});

	test.serial("notifies completion when the pi process cannot be spawned", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-error");
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
			expect(readResultText(runDir, "agent-1")).toContain("pi");
			expect(getRecord(runDir, "agent-1")?.exitCode).toBe(1);
			expect((getLive(runDir, "agent-1")?.stderrTail ?? "")).toContain("pi");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});

	test.serial("writes session metadata when sub-agent sessions are enabled", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-session");
		const piScript = path.join(tempDir(), "pi.js");
		writeFile(piScript, `
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] }));
  setTimeout(() => process.exit(0), 0);
});
setTimeout(() => {}, 1000);
`);
		process.argv[1] = piScript;

		await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "agent-1", task: "Do work" }, cwd, [], undefined, resolve);
		}), "Timed out waiting for session spawn completion");

		const piArgs = (getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n");
		expect(piArgs).toContain("--session-dir");
		expect(piArgs).not.toContain("--no-session");
		expect(fs.existsSync(scopeDir(cwd, resolveScope(undefined)))).toBe(true);
	});

	test.serial("captures final assistant text when pi exits without agent_end", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-message-end");
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
		expect(readResultText(runDir, "agent-1")).toBe("final assistant result");
	});

	test.serial("keeps RPC stdin open until async prompt emits a result", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-rpc-stdin-open");
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
		expect(readResultText(runDir, "agent-1")).toBe("delayed rpc result");
	});

	test.serial("keeps opted-in runtime logs compact and bounded", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-compact-logs");
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
		process.env.ASYNC_SUBAGENTS_MAX_STDERR_BYTES = "256";
		process.env.ASYNC_SUBAGENTS_MAX_RPC_LINE_CHARS = "4096";
		process.env.ASYNC_SUBAGENTS_DEBUG_LOGS = "1";

		const completed = await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "agent-1", task: "Do work" }, cwd, [], undefined, resolve);
		}), "Timed out waiting for compact-log spawn completion");

		const agentDir = path.join(runDir, "agent-1");
		expect(completed).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(readResultText(runDir, "agent-1")).toBe("compact final");
		expect(fs.existsSync(path.join(agentDir, "events.jsonl"))).toBe(false);
		const stderr = (getLive(runDir, "agent-1")?.stderrTail ?? "");
		expect(stderr.length).toBeGreaterThan(0);
		expect(stderr.length).toBeLessThanOrEqual(1024);
	});

	test.serial("waits for agent_settled across a delayed continuation", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-agent-settled-delayed-continuation");
		const controlDir = tempDir();
		const readyPath = path.join(controlDir, "continuation-ready");
		const continuePath = path.join(controlDir, "continue");
		const piScript = path.join(controlDir, "pi.js");
		writeFile(piScript, `
const fs = require("node:fs");
const readyPath = ${JSON.stringify(readyPath)};
const continuePath = ${JSON.stringify(continuePath)};
process.on("SIGTERM", () => {});
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "intermediate result" }] }], willRetry: false }));
  fs.writeFileSync(readyPath, "ready");
  const continuationGate = setInterval(() => {
    if (!fs.existsSync(continuePath)) return;
    clearInterval(continuationGate);
    console.log(JSON.stringify({ type: "compaction_start", reason: "threshold" }));
    console.log(JSON.stringify({ type: "agent_start" }));
    console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "final result after continuation" }] }], willRetry: false }));
    console.log(JSON.stringify({ type: "agent_settled" }));
  }, 10);
});
setTimeout(() => process.exit(0), 5000);
setInterval(() => {}, 1000);
`);
		process.argv[1] = piScript;

		let resolved = false;
		const completion = new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "agent-1", task: "Do work" }, cwd, [], undefined, (value) => {
				resolved = true;
				resolve(value);
			});
		});
		await waitUntil(() => fs.existsSync(readyPath), 2000);
		expect(resolved).toBe(false);
		writeFile(continuePath, "continue");
		const completed = await withTimeout(completion, "Timed out waiting for agent_settled completion", 3000);

		expect(completed).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(readResultText(runDir, "agent-1")).toBe("final result after continuation");
	});

	test.serial("attaches task image paths to the RPC prompt", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-image");
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
		expect(getRecord(runDir, "agent-image")?.task?.imagePaths).toEqual(["@screen.png"]);
	});

	test.serial("turns RPC prompt failures into failed results", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-fail");
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
		expect(readResultText(runDir, "agent-1")).toBe("bad prompt");
	});

	test.serial("retries failed agents with pending state and then succeeds", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-retry-ok");
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
		expect(getRecord(runDir, "agent-1")?.nextRetryAt).toBeDefined();
		await withTimeout(retry.done, "Timed out waiting for retrying agent completion", 15000);
		expect(completed).toMatchObject({ exitCode: 0, state: { status: "done", retryCount: 1 } });
		expect(readResultText(runDir, "agent-1")).toBe("retry ok");
		expect(getRecord(runDir, "agent-1")?.status).not.toBe("retrying");
	});

	test.serial("falls back to configured provider models on quota limit failures in the current session", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-model-fallback");
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
		}, { retry: { maxRetries: 0, backoffMs: 10 }, extraArgs: ["--skill", "injected-skill.md"], fallbackModels: ["fallback/model"] });
		await withTimeout(first.done, "Timed out waiting for model-fallback first completion", 15000);

		expect(firstCompletion).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(JSON.parse(fs.readFileSync(attemptFile, "utf-8"))).toEqual(["primary/model", "fallback/model"]);
		expect(readResultText(runDir, "agent-1")).toBe("fallback ok on fallback/model");
		expect(getRecord(runDir, "agent-1")?.modelFallback?.from).toBe("primary/model");
		expect(getRecord(runDir, "agent-1")?.modelFallback?.to).toBe("fallback/model");
		const fallbackArgs = (getLive(runDir, "agent-1")?.launchArgs ?? []).join("\n").split("\n");
		expect(fallbackArgs).toContain("--no-skills");
		expect(fallbackArgs).not.toContain("--skill");
		expect(fallbackArgs).not.toContain("injected-skill.md");

		const secondRun = createBatch(cwd, resolveScope(undefined), "spawn-model-fallback-session");
		let secondCompletion: any;
		const second = spawnAgentWithRetry(secondRun, { id: "agent-2", task: "Fallback again", model: "primary/model" }, cwd, (completion) => {
			secondCompletion = completion;
		}, { retry: { maxRetries: 0, backoffMs: 10 }, extraArgs: [], fallbackModels: ["fallback/model"] });
		await withTimeout(second.done, "Timed out waiting for model-fallback second completion", 15000);

		expect(secondCompletion).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(JSON.parse(fs.readFileSync(attemptFile, "utf-8"))).toEqual(["primary/model", "fallback/model", "fallback/model"]);
		expect(getRecord(secondRun, "agent-2")?.task?.model).toBe("fallback/model");

		const thirdRun = createBatch(cwd, resolveScope(undefined), "spawn-provider-fallback-session");
		let thirdCompletion: any;
		const third = spawnAgentWithRetry(thirdRun, { id: "agent-3", task: "Same provider again", model: "primary/other" }, cwd, (completion) => {
			thirdCompletion = completion;
		}, { retry: { maxRetries: 0, backoffMs: 10 }, extraArgs: [], fallbackModels: ["fallback/other"] });
		await withTimeout(third.done, "Timed out waiting for model-fallback third completion", 15000);

		expect(thirdCompletion).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(JSON.parse(fs.readFileSync(attemptFile, "utf-8"))).toEqual(["primary/model", "fallback/model", "fallback/model", "fallback/other"]);
		expect(getRecord(thirdRun, "agent-3")?.task?.model).toBe("fallback/other");
	});

	test.serial("waits for Antigravity all-accounts exhaustion before provider fallback", async () => {
		const runDir = newRun(tempDir(), "quota");
		createAgent(runDir, "agent-1", { exitCode: 1 });
		const agentDir = path.join(runDir, "agent-1");
		const baseCompletion = {
			runDir,
			agentId: "agent-1",
			agentDir,
			exitCode: 1,
			state: getAgentState(runDir, "agent-1")!,
		};

		updateLive(runDir, "agent-1", { resultText: "429 quota exceeded on one Antigravity account; rotated account may still work" });
		expect(isQuotaLimitCompletion(baseCompletion, "antigravity/gemini-3-flash-preview")).toBe(false);
		expect(isQuotaLimitCompletion(baseCompletion, "openai-codex/gpt-5.5")).toBe(true);

		updateLive(runDir, "agent-1", { resultText: "ANTIGRAVITY_ALL_ACCOUNTS_EXHAUSTED model=gemini status=429: all configured Antigravity accounts are exhausted for this model" });
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
		const stoppedRun = createBatch(stoppedCwd, resolveScope(undefined), "spawn-retry-stopped");
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
		await withTimeout(stopped.done, "Timed out waiting for stopped agent completion", 15000);
		expect(stoppedCompletion.state.status).toBe("stopped");
		expect(fs.readFileSync(stoppedAttemptFile, "utf-8")).toBe("1");
		expect(getRecord(stoppedRun, "agent-stopped")?.status).not.toBe("retrying");

		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-retry-disabled");
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
		await withTimeout(disabled.done, "Timed out waiting for no-retry completion", 15000);
		expect(disabledCompletion).toMatchObject({ exitCode: 1, state: { status: "failed" } });
		expect(fs.readFileSync(attemptFile, "utf-8")).toBe("1");
		expect(getRecord(runDir, "agent-1")?.status).not.toBe("retrying");
	});

	test.serial("terminates agents that exceed the execution timeout", async () => {
		expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(3 * 60 * 60 * 1000);
		expect(DEFAULT_OWNED_LAUNCH_TIMEOUTS.watchdogSeconds * 1000).toBe(DEFAULT_AGENT_TIMEOUT_MS);
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-timeout");
		const piScript = path.join(tempDir(), "pi.js");
		const descendantReady = path.join(cwd, "descendant-ready");
		const descendantSignalled = path.join(cwd, "descendant-signalled");
		const descendantSource = `
const fs = require("node:fs");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(descendantSignalled)}, "SIGTERM");
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(descendantReady)}, String(process.pid));
setInterval(() => {}, 1000);
`;
		writeFile(piScript, `
const { spawn } = require("node:child_process");
process.stdin.on("data", () => {
  spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });
});
setTimeout(() => {}, 10000);
`);
		process.argv[1] = piScript;

		const completed = await withTimeout(new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "agent-1", task: "Hang" }, cwd, [], undefined, resolve, { timeoutMs: 500 });
		}), "Timed out waiting for timeout spawn completion");

		expect(completed.exitCode).toBe(124);
		expect(completed.state.status).toBe("failed");
		expect(getRecord(runDir, "agent-1")?.exitCode).toBe(124);
		expect(getRecord(runDir, "agent-1")).toMatchObject({ timedOut: true, timeoutMs: 500 });
		expect(readResultText(runDir, "agent-1")).toContain("timed out");
		if (process.platform !== "win32") {
			expect(fs.existsSync(descendantReady)).toBe(true);
			await waitUntil(() => fs.existsSync(descendantSignalled), 2000);
			expect(fs.readFileSync(descendantSignalled, "utf-8")).toBe("SIGTERM");
		}
	});

	test.serial("records invalid final JSON lines and exits with process status", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-invalid-json");
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
		expect((getLive(runDir, "agent-1")?.stderrTail ?? "")).toContain("Invalid RPC JSON line");
	});

	test.serial("falls back to synthetic completion state if agent state disappears", async () => {
		const cwd = tempDir();
		const runDir = createBatch(cwd, resolveScope(undefined), "spawn-fallback-state");
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
		void spawnedAgentDir;
		forgetRecord(runDir, "agent-1");
		const completed = await withTimeout(completedPromise, "Timed out waiting for fallback-state spawn completion");

		expect(completed).toMatchObject({ exitCode: 0, state: { id: "agent-1", status: "done", exitCode: 0 } });
	});
});
