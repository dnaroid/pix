import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { ASYNC_SUBAGENT_TOOL_DESCRIPTIONS } from "../../tool-descriptions.js";
import type { AgentCompletionHandler, AgentTask, ResolvedAgentTaskConfig, Semaphore, SpawnedAgent } from "../lib.js";
import {
	createRunDir,
	createSemaphore,
	currentModelRef,
	DEFAULT_MAX_CONCURRENT,
	getActiveSubagentPresetName,
	getAgentState,
	getRunState,
	getSessionSubagentPresetOverride,
	loadSubagentConfig,
	recordSubagentRun,
	resolveAgentTaskConfig,
	resolveRunDir,
	routeSubagentTasks,
	selectSessionModelWithFallback,
	shouldForceCurrentSubagentModel,
	spawnAgent,
	stopAgents,
	writePromptFile,
	writeStructuredResult,
} from "../lib.js";
import { spawnAgentWithRetry } from "../core/retry.js";
import { DEFAULT_SPAWN_WATCH_SECONDS, DEFAULT_UPDATE_INTERVAL_SECONDS, INLINE_RENDERING } from "../constants.js";
import { formatAgentStatus } from "../format.js";
import { getLiveRun } from "../live.js";
import { clampWatchSeconds, pollRunWithUpdates } from "../polling.js";
import { renderPlainRunSummary, renderSubagentRun, renderSubagentSpawnPrompts } from "../render.js";
import { normalizeAgentTasks, toTaskPreviews } from "../tasks.js";
import { emptyToolSlot } from "../ui.js";
import type { LiveAgent, SubagentRunRenderDetails } from "../types.js";

interface LaunchQueuedAgentOptions {
	resolved: ResolvedAgentTaskConfig;
	runDir: string;
	cwd: string;
	parentSession?: string;
	semaphore: Semaphore;
	signal?: AbortSignal;
	onResult: (result: Pick<SpawnedAgent, "pid" | "agentDir">) => void;
	onComplete: AgentCompletionHandler;
	onCancelled: (reason: string) => void;
	onLaunchError: (error: unknown) => void;
	onUpdate: () => void;
}

const PROJECT_SEMAPHORES = new Map<string, Semaphore>();

function getProjectSemaphore(cwd: string, limit: number): Semaphore {
	const key = path.resolve(cwd);
	const existing = PROJECT_SEMAPHORES.get(key);
	if (existing && existing.limit === normalizedLimit(limit)) return existing;
	if (existing && (existing.active > 0 || existing.waiting > 0)) return existing;
	const semaphore = createSemaphore(limit);
	PROJECT_SEMAPHORES.set(key, semaphore);
	return semaphore;
}

function normalizedLimit(limit: number): number {
	return limit > 0 ? limit : 0;
}

async function launchQueuedAgent(options: LaunchQueuedAgentOptions): Promise<void> {
	const { resolved, runDir, cwd, parentSession, semaphore, signal, onResult, onComplete, onCancelled, onLaunchError, onUpdate } = options;
	let slotAcquired = false;
	try {
		await semaphore.acquire(signal);
		slotAcquired = true;
		let slotReleased = false;
		const releaseSlot = () => {
			if (slotReleased) return;
			slotReleased = true;
			semaphore.release();
		};
		const completionHandler: AgentCompletionHandler = (completion) => {
			releaseSlot();
			onComplete(completion);
		};
		const skipReason = launchSkipReason(runDir, resolved.task.id);
		if (skipReason) {
			releaseSlot();
			onCancelled(skipReason);
			onUpdate();
			return;
		}

		const spawnOptions = { parentSession, maxResultBytes: resolved.maxResultBytes, timeoutMs: resolved.timeoutMs };
		if (resolved.retry.maxRetries > 0 || resolved.fallbackModels.length > 0) {
			const retryResult = spawnAgentWithRetry(
				runDir,
				resolved.task,
				cwd,
				completionHandler,
				{
					retry: resolved.retry,
					extraArgs: resolved.extraArgs,
					fallbackModels: resolved.fallbackModels,
					signal,
					...spawnOptions,
				},
			);
			onResult(retryResult.initial);
			retryResult.done.catch(onLaunchError);
		} else {
			const result = spawnAgent(runDir, resolved.task, cwd, resolved.extraArgs, undefined, completionHandler, spawnOptions);
			onResult(result);
		}
		onUpdate();
	} catch (error) {
		if (slotAcquired) semaphore.release();
		if (errorMessage(error) === "Aborted") onCancelled("launch aborted before a concurrency slot opened");
		else onLaunchError(error);
		onUpdate();
	}
}

function launchSkipReason(runDir: string, agentId: string): string | undefined {
	if (!fs.existsSync(runDir)) return "run directory was removed before launch";
	const state = getAgentState(runDir, agentId, { includeLineCounts: false });
	if (state?.status === "stopped") return "agent was stopped before launch";
	return undefined;
}

function writeLaunchFailure(runDir: string, task: AgentTask, message: string, maxResultBytes?: number): void {
	const agentDir = path.join(runDir, task.id);
	fs.mkdirSync(agentDir, { recursive: true });
	const now = new Date().toISOString();
	fs.writeFileSync(path.join(agentDir, "prompt.md"), `Launch failed before sub-agent process started.\n\n${message}\n`, "utf-8");
	fs.writeFileSync(path.join(agentDir, "result.md"), message, "utf-8");
	fs.writeFileSync(path.join(agentDir, "stderr.log"), `${message}\n`, "utf-8");
	fs.writeFileSync(path.join(agentDir, "exit_code"), "1", "utf-8");
	fs.writeFileSync(path.join(agentDir, "started_at"), now, "utf-8");
	fs.writeFileSync(path.join(agentDir, "finished_at"), now, "utf-8");
	const state = getAgentState(runDir, task.id) ?? { id: task.id, status: "failed" as const, exitCode: 1 };
	writeStructuredResult({ agentDir, agentId: task.id, state, subagentType: task.subagentType, model: task.model, maxResultBytes });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function applySessionModelFallback(resolved: ResolvedAgentTaskConfig): ResolvedAgentTaskConfig {
	const selected = selectSessionModelWithFallback(resolved.task.model, resolved.fallbackModels);
	if (!selected || !selected.fellBack) return resolved;
	return {
		...resolved,
		task: {
			...resolved.task,
			model: selected.model,
		},
	};
}

function timeoutMsFromSeconds(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.max(1, Math.round(value * 1000))
		: undefined;
}

const AgentTaskSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Short identifier for this agent (used as directory name). If omitted, the spawn action assigns agent-1, agent-2, etc." })),
	task: Type.String({ description: "Focused task description for the sub-agent" }),
	scope: Type.Optional(Type.String({ description: "Relevant files/areas for this task" })),
	subagentType: Type.Optional(Type.String({ description: "Logical sub-agent type/profile from config. Usually omit this so the router selects from the current config; set only for an explicit user-requested role, vision/image handling, deterministic tests, or another concrete override." })),
	model: Type.Optional(Type.String({ description: "Explicit model override for this sub-agent. Prefer subagentType for reusable routing." })),
	thinking: Type.Optional(Type.String({ description: "Per-agent thinking level override (off, minimal, low, medium, high, xhigh)." })),
	promptAppend: Type.Optional(Type.String({ description: "Extra prompt instructions appended after the generated/type prompt." })),
	promptOverride: Type.Optional(Type.String({ description: "Full prompt replacement for this sub-agent. Prefer configuring this per subagentType." })),
	focus: Type.Optional(Type.String({ description: "For vision sub-agents: what to pay special attention to while inspecting attached images." })),
	attention: Type.Optional(Type.String({ description: "Alias for focus, accepted for compatibility." })),
	imagePaths: Type.Optional(Type.Array(Type.String(), { description: "Local image paths to attach to this sub-agent prompt (jpg, png, gif, or webp). Relative paths resolve from cwd." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool names to enable (e.g. ['read','grep','bash'])" })),
	extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Additional pi CLI args for this sub-agent" })),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Per-agent wall-clock timeout in seconds. Overrides config/default timeout for this task." })),
	parentObjective: Type.Optional(Type.String({ description: "Parent task context (default: 'current user task')" })),
});

export function registerSpawnTool(
	pi: ExtensionAPI,
	liveAgents: Map<string, Map<string, LiveAgent>>,
	handleAgentCompletion: AgentCompletionHandler,
	onLiveAgentsChange?: () => void,
): void {
	pi.registerTool({
		...ASYNC_SUBAGENT_TOOL_DESCRIPTIONS.spawnAction,
		...INLINE_RENDERING,
		parameters: Type.Object({
			tasks: Type.Array(AgentTaskSchema, { description: "Agent tasks to spawn" }),
			runDir: Type.Optional(Type.String({ description: "Existing run directory. Creates new one if omitted." })),
			slug: Type.Optional(Type.String({ description: "Slug for new run directory name" })),
			thinking: Type.Optional(Type.String({ description: "Thinking level for sub-agents (off, minimal, low, medium, high, xhigh)" })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Additional pi CLI args for sub-agents" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Wall-clock timeout in seconds for every spawned agent in this call. Task-level timeoutSeconds overrides this." })),
			watchSeconds: Type.Optional(Type.Number({ description: "Live update watch window after spawning (default/max 300s; 0 returns immediately)", default: DEFAULT_SPAWN_WATCH_SECONDS })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const parentSession = typeof ctx.sessionManager?.getSessionFile === "function"
				? ctx.sessionManager.getSessionFile()
				: undefined;
			const runDir = params.runDir
				? resolveRunDir(ctx.cwd, params.runDir)
				: createRunDir(ctx.cwd, params.slug);

			const normalized = normalizeAgentTasks(params.tasks);
			if (normalized.error) {
				return {
					content: [{ type: "text", text: normalized.error }],
					details: {},
					isError: true,
				};
			}
			const config = loadSubagentConfig(ctx.cwd);
			const activePresetName = getActiveSubagentPresetName();
			const activePreset = activePresetName ? config.presets?.[activePresetName] : undefined;
			if (getSessionSubagentPresetOverride() && !activePreset) {
				return {
					content: [{ type: "text", text: `AGENTS_PRESET=${activePresetName} does not match any preset in asyncSubagents config.` }],
					details: {},
					isError: true,
				};
			}
			const forceCurrentModel = shouldForceCurrentSubagentModel();
			const forcedModel = forceCurrentModel ? currentModelRef((ctx as { model?: unknown }).model) : undefined;
			if (forceCurrentModel && !forcedModel) {
				return {
					content: [{ type: "text", text: "ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL is enabled, but the current parent model is unavailable." }],
					details: {},
					isError: true,
				};
			}
			const routed = await routeSubagentTasks(normalized.tasks ?? [], config, ctx as any, signal ?? undefined);
			const timeoutMs = timeoutMsFromSeconds(params.timeoutSeconds);
			const resolvedTasks = routed.tasks.map((task) => applySessionModelFallback(
				resolveAgentTaskConfig(task, config, {
					preset: activePreset,
					thinking: params.thinking,
					extraArgs: Array.isArray(params.extraArgs) ? params.extraArgs : [],
					forcedModel,
					timeoutMs,
				}),
			));
			const tasks: AgentTask[] = resolvedTasks.map((resolved) => resolved.task);
			const taskPreviews = toTaskPreviews(tasks);
			const results: { id: string; pid: number; agentDir: string }[] = [];
			const maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
			const semaphore = getProjectSemaphore(ctx.cwd, maxConcurrent);
			const launchErrors: { id: string; error: string }[] = [];
			recordSubagentRun(ctx.cwd, runDir, tasks.map((task) => task.id));

			// Materialize prompts up front so queued agents appear as planned in status/wait
			// output before their semaphore slot opens.
			for (const task of tasks) writePromptFile(runDir, task);
			const liveRun = getLiveRun(liveAgents, runDir);

			for (const resolved of resolvedTasks) {
				const task = resolved.task;
				const preview = taskPreviews.find((item) => item.id === task.id);
				let resolveCompleted: () => void = () => {};
				const completed = new Promise<void>((resolve) => {
					resolveCompleted = resolve;
				});
				liveRun.set(task.id, { runDir, agentId: task.id, preview, parentSession, completed });

				void launchQueuedAgent({
					resolved,
					runDir,
					cwd: ctx.cwd,
					parentSession,
					semaphore,
					signal: signal ?? undefined,
					onResult: (result) => results.push({ id: task.id, pid: result.pid, agentDir: result.agentDir }),
					onComplete: (completion) => {
						resolveCompleted();
						handleAgentCompletion(completion);
					},
					onCancelled: () => {
						stopAgents(runDir, [task.id], { signal: "SIGTERM" });
						resolveCompleted();
						const state = getAgentState(runDir, task.id, { includeLineCounts: false }) ?? { id: task.id, status: "stopped" as const };
						handleAgentCompletion({ runDir, agentId: task.id, agentDir: path.join(runDir, task.id), exitCode: 0, state });
					},
					onLaunchError: (error) => {
						const message = errorMessage(error);
						launchErrors.push({ id: task.id, error: message });
						writeLaunchFailure(runDir, task, message, resolved.maxResultBytes);
						resolveCompleted();
						const state = getAgentState(runDir, task.id, { includeLineCounts: false }) ?? { id: task.id, status: "failed" as const, exitCode: 1 };
						handleAgentCompletion({ runDir, agentId: task.id, agentDir: path.join(runDir, task.id), exitCode: 1, state });
					},
					onUpdate: () => {
						onLiveAgentsChange?.();
						const partialDetails: SubagentRunRenderDetails = {
							runDir,
							agents: getRunState(runDir).agents,
							tasks: taskPreviews,
							mode: "spawn",
						};
						onUpdate?.({
							content: [{ type: "text", text: renderPlainRunSummary(partialDetails) }],
							details: partialDetails,
						});
					},
				});
			}

			// Let immediately available semaphore slots start before the first status poll.
			await Promise.resolve();

			const state = await pollRunWithUpdates(runDir, undefined, {
				mode: "spawn",
				tasks: taskPreviews,
				timeoutSeconds: clampWatchSeconds(params.watchSeconds),
				intervalSeconds: DEFAULT_UPDATE_INTERVAL_SECONDS,
				signal: signal ?? undefined,
				onUpdate,
			});
			const details: SubagentRunRenderDetails = { runDir, agents: state.agents, tasks: taskPreviews, mode: "spawn" };
			onLiveAgentsChange?.();
			const hasActiveOrQueued = state.agents.some((agent) => agent.status === "planned" || agent.status === "running" || agent.status === "retrying");
			const lines = [
				`Scheduled ${tasks.length} agent(s) in ${runDir}`,
				`Started ${results.length} agent(s) so far; maxConcurrent=${semaphore.limit} (project-wide).`,
				...(routed.usedLlm
					? [`LLM-routed ${Object.keys(routed.routes).length} inferred subagent type(s).`]
					: []),
				...(routed.warnings.length > 0 ? [`Routing fallback: ${routed.warnings.join(" ")}`] : []),
				"",
				...state.agents.map(
					(a) => `${formatAgentStatus(a.status)} ${a.id}${a.pid ? ` (pid ${a.pid})` : ""}`,
				),
				...(launchErrors.length > 0
					? ["", "Launch errors:", ...launchErrors.map((item) => `- ${item.id}: ${item.error}`)]
					: []),
				"",
				hasActiveOrQueued
					? "Agents continue running or queued in the background after this watch window."
					: "All scheduled agents are no longer running or queued.",
				`Use subagents({ action: "status" }) for the latest project run, or include runDir: "${runDir}" for an exact run.`,
				"Use subagents({ action: \"result\", agentId: \"<agent-id>\" }) to read output; runDir is optional because .pi/subagents/registry.json maps agent IDs to their latest run.",
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details,
			};
		},

		renderCall() {
			return emptyToolSlot();
		},

		renderResult(result, opts, theme) {
			const details = result.details as SubagentRunRenderDetails | undefined;
			if (!details) {
				const fallback = result.content[0] && result.content[0].type === "text" ? result.content[0].text : "(no output)";
				return new Text(fallback, 0, 0);
			}
			if (details.mode === "spawn") {
				return renderSubagentSpawnPrompts(details, opts, theme);
			}

			return renderSubagentRun(details, opts, theme);
		},
	});
}
