import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { ASYNC_SUBAGENT_TOOL_DESCRIPTIONS } from "../../tool-descriptions.js";
import { SUBAGENT_TYPE_SELECTION_GUIDANCE } from "../core/agent-catalog.js";
import { selectAvailableAgentModels } from "../core/model-selection.js";
import { SubagentModelSelectionError } from "../core/config.js";
import type { AgentCompletionHandler, AgentTask, ResolvedAgentTaskConfig, RpcEventRecord, Semaphore, SpawnedAgent } from "../lib.js";
import {
	createSemaphore,
	currentModelRef,
	DEFAULT_MAX_CONCURRENT,
	getAgentState,
	getRunState,
	loadSubagentConfig,
	resolveAgentTaskConfig,
	routeSubagentTasks,
	SubagentRoutingError,
	selectSessionModelWithFallback,
	shouldForceCurrentSubagentModel,
	spawnAgent,
	stopAgents,
} from "../lib.js";
import { settleStructuredResult } from "../core/structured-result.js";
import { ownedAgentDir, parseRunKey, scopeDir } from "../core/paths.js";
import { createBatch, getLive, getRecord, updateLive, updateRecord } from "../core/store.js";
import { normalizeRunDir, scopeForContext } from "../core/lookup.js";
import { spawnAgentWithRetry } from "../core/retry.js";
import { recordSubagentUsage } from "../core/usage.js";
import { recordSubagentTaskStatistics, recordSubagentStateStatistics, recordSubagentToolStatistics } from "../core/statistics.js";
import { ensureOwnedLaunchBinaries, maySelectOwnedProvider, type OwnedLaunchBinaries } from "../core/owned-launch-integration.js";
import { launchdAccess } from "../core/owned-launch/access-probe.js";
import { ownedArtifactsPresentSync, ownedSlotReleasedSync } from "../core/owned-retirement.js";
import { DEFAULT_SPAWN_WATCH_SECONDS, DEFAULT_UPDATE_INTERVAL_SECONDS, INLINE_RENDERING } from "../constants.js";
import { formatAgentStatus } from "../format.js";
import { getLiveRun } from "../live.js";
import { clampWatchSeconds, pollRunWithUpdates } from "../polling.js";
import type { CompletionDelivery } from "../completion-delivery.js";
import { beginDelegatedEvidence } from "../delegated-evidence.js";
import type { RunState } from "../lib.js";
import { renderPlainRunSummary, renderSubagentRun, renderSubagentSpawnPrompts } from "../render.js";
import { normalizeAgentTasks, toTaskPreviews } from "../tasks.js";
import { emptyToolSlot } from "../ui.js";
import { diagnosticErrorType, suiteDiagnostics } from "../../lib/suite-diagnostics.js";
import type { LiveAgent, SubagentRunRenderDetails } from "../types.js";

interface LaunchQueuedAgentOptions {
	resolved: ResolvedAgentTaskConfig;
	runDir: string;
	cwd: string;
	parentSession?: string;
	parentSessionId?: string;
	semaphore: Semaphore;
	signal?: AbortSignal;
	onResult: (result: Pick<SpawnedAgent, "pid" | "agentDir">) => void;
	onComplete: AgentCompletionHandler;
	onCancelled: (reason: string) => void;
	onLaunchError: (error: unknown) => void;
	onUpdate: () => void;
	onRpcEvent?: (event: RpcEventRecord) => void;
}

/**
 * Owned launch needs launchd-started jobs to reach the project and run
 * directories. When launchd definitively cannot (TCC on external volumes, no
 * GUI domain), Claude-provider attempts fall back to the ordinary process-group
 * launch; an undecided probe keeps owned launch (fail closed).
 */
export async function resolveOwnedLaunchOptions(dirs: string[]): Promise<{ ownedBinaries: OwnedLaunchBinaries } | { ownedLaunchUnavailable: true }> {
	if (process.platform === "darwin" && await launchdAccess(dirs) === "denied") {
		suiteDiagnostics.report("warn", "subagents", "owned-launch-unavailable", dirs[0]);
		return { ownedLaunchUnavailable: true };
	}
	return { ownedBinaries: await ensureOwnedLaunchBinaries() };
}

const PROJECT_SEMAPHORES = new Map<string, Semaphore>();

export function getProjectSemaphore(cwd: string, limit: number): Semaphore {
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
	const { resolved, runDir, cwd, parentSession, parentSessionId, semaphore, signal, onResult, onComplete, onCancelled, onLaunchError, onUpdate, onRpcEvent } = options;
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

		const spawnOptions = {
			parentSession,
			parentSessionId,
			maxResultBytes: resolved.maxResultBytes,
			timeoutMs: resolved.timeoutMs,
			...(maySelectOwnedProvider(resolved.task, resolved.extraArgs, resolved.fallbackModels)
				? await resolveOwnedLaunchOptions([cwd, ownedProbeDir(cwd, runDir)]) : {}),
		};
		if (signal?.aborted) throw new Error("Aborted");
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
					onRpcEvent,
					...spawnOptions,
				},
			);
			onResult(retryResult.initial);
			retryResult.done.catch(onLaunchError);
		} else {
			const result = spawnAgent(runDir, resolved.task, cwd, resolved.extraArgs, onRpcEvent, completionHandler, spawnOptions);
			onResult(result);
		}
		onUpdate();
	} catch (error) {
		if (slotAcquired && !ownedLaunchHoldsSlot(runDir, resolved.task.id)) semaphore.release();
		if (errorMessage(error) === "Aborted") onCancelled("launch aborted before a concurrency slot opened");
		else onLaunchError(error);
		onUpdate();
	}
}

/**
 * A synchronous launch failure keeps the concurrency slot only while the
 * owned run could still own live artifacts: kernel-drained receipts and
 * provably never-started bridges release it; unproven failures wait for the
 * durable retirement marker (written by the bounded async verifier).
 */
function ownedLaunchHoldsSlot(runDir: string, agentId: string): boolean {
	const agentDir = ownedAgentDir(runDir, agentId);
	return ownedArtifactsPresentSync(agentDir) && !ownedSlotReleasedSync(agentDir);
}

function launchSkipReason(runDir: string, agentId: string): string | undefined {
	if (!getRecord(runDir, agentId)) return "run was removed before launch";
	const state = getAgentState(runDir, agentId, { includeLineCounts: false });
	if (state?.status === "stopped") return "agent was stopped before launch";
	return undefined;
}

/** launchd must reach the parent-scoped directory that will hold the owned base. */
export function ownedProbeDir(cwd: string, runDir: string): string {
	const parsed = parseRunKey(runDir);
	const dir = parsed ? scopeDir(parsed.cwd, parsed.scope) : runDir;
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		return cwd;
	}
	return dir;
}

function writeLaunchFailure(runDir: string, task: AgentTask, message: string, maxResultBytes?: number): void {
	const now = new Date().toISOString();
	updateRecord(runDir, task.id, {
		status: "failed", exitCode: 1, startedAt: getRecord(runDir, task.id)?.startedAt ?? now, finishedAt: now,
		message, stderrPreview: message,
	});
	updateLive(runDir, task.id, { active: false, resultText: message, stderrTail: `${message}\n` });
	const state = getAgentState(runDir, task.id) ?? { id: task.id, status: "failed" as const, exitCode: 1 };
	settleStructuredResult(runDir, task.id, { state, subagentType: task.subagentType, model: task.model, maxResultBytes });
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
	subagentType: Type.Optional(Type.String({ description: SUBAGENT_TYPE_SELECTION_GUIDANCE })),
	model: Type.Optional(Type.String({ description: "Explicit model override for this sub-agent. Prefer subagentType for reusable routing." })),
	thinking: Type.Optional(Type.String({ description: "Per-agent thinking level override (off, minimal, low, medium, high, xhigh, max)." })),
	promptAppend: Type.Optional(Type.String({ description: "Extra prompt instructions appended after the generated/type prompt." })),
	promptOverride: Type.Optional(Type.String({ description: "Full prompt replacement for this sub-agent. Prefer configuring this per subagentType." })),
	focus: Type.Optional(Type.String({ description: "Optional focus/attention instructions for attached images or scoped inspection." })),
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
	onAgentRpcEvent?: (runDir: string, agentId: string, event: RpcEventRecord) => void,
	completionDelivery?: CompletionDelivery,
): void {
	pi.registerTool({
		...ASYNC_SUBAGENT_TOOL_DESCRIPTIONS.spawnAction,
		...INLINE_RENDERING,
		parameters: Type.Object({
			tasks: Type.Array(AgentTaskSchema, { description: "Agent tasks to spawn" }),
			runDir: Type.Optional(Type.String({ description: "Existing batch name (or run key) to add agents to. Creates a new batch if omitted." })),
			slug: Type.Optional(Type.String({ description: "Slug for the new batch name" })),
			thinking: Type.Optional(Type.String({ description: "Thinking level for sub-agents (off, minimal, low, medium, high, xhigh, max)" })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Additional pi CLI args for sub-agents" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Wall-clock timeout in seconds for every spawned agent in this call. Task-level timeoutSeconds overrides this." })),
			watchSeconds: Type.Optional(Type.Number({ description: "Optional live watch window after spawning (default 0: return after scheduling; max 300s). Use a positive window only when no independent parent work remains.", default: DEFAULT_SPAWN_WATCH_SECONDS })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const parentSessionManager = ctx.sessionManager;
			const evidenceOwner = { sessionId: parentSessionManager?.getSessionId?.() ?? "", anchorId: parentSessionManager?.getLeafId?.() ?? "" };
			const parentSession = typeof ctx.sessionManager?.getSessionFile === "function"
				? ctx.sessionManager.getSessionFile()
				: undefined;
			const normalized = normalizeAgentTasks(params.tasks);
			if (normalized.error) {
				return {
					content: [{ type: "text", text: normalized.error }],
					details: {},
					isError: true,
				};
			}
			const config = loadSubagentConfig(ctx.cwd);
			const forceCurrentModel = shouldForceCurrentSubagentModel();
			const forcedModel = forceCurrentModel ? currentModelRef((ctx as { model?: unknown }).model) : undefined;
			if (forceCurrentModel && !forcedModel) {
				return {
					content: [{ type: "text", text: "ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL is enabled, but the current parent model is unavailable." }],
					details: {},
					isError: true,
				};
			}
			let routed: Awaited<ReturnType<typeof routeSubagentTasks>>;
			// Capture observer ownership before routing/auth awaits can switch the parent branch.
			const evidence = new Map((normalized.tasks ?? []).map((task) => [task.id, beginDelegatedEvidence(pi.events, evidenceOwner, task.id)]));
			try {
				try {
					routed = await routeSubagentTasks(normalized.tasks ?? [], config, ctx as any, signal ?? undefined);
				} catch (error) {
					if (!(error instanceof SubagentRoutingError)) throw error;
					return {
						content: [{ type: "text", text: `No agents were launched. Correct the roles and resubmit the whole batch.\n${error.message}` }],
						details: { error: "subagent_routing", taskIds: error.taskIds, allowedTypes: error.allowedTypes },
						isError: true,
					};
				}
				const timeoutMs = timeoutMsFromSeconds(params.timeoutSeconds);
				const parentModel = currentModelRef((ctx as { model?: unknown }).model);
				let resolvedTasks: ResolvedAgentTaskConfig[];
				try {
					resolvedTasks = await Promise.all(routed.tasks.map(async (task) => applySessionModelFallback(await selectAvailableAgentModels(
						resolveAgentTaskConfig(task, config, {
							thinking: params.thinking,
							extraArgs: Array.isArray(params.extraArgs) ? params.extraArgs : [],
							forcedModel,
							parentModel,
							timeoutMs,
						}), config, ctx.modelRegistry, signal,
					))));
				} catch (error) {
					if (!(error instanceof SubagentModelSelectionError)) throw error;
					return { content: [{ type: "text", text: error.message }], details: { error: "subagent_model_selection" }, isError: true };
				}
				let tasks: AgentTask[] = resolvedTasks.map((resolved) => resolved.task);
				if (signal?.aborted) throw new Error("Aborted");
				if (signal?.aborted) throw new Error("Aborted");
				// Resolve the entire batch before creating run state or launching children.
				const scope = scopeForContext(ctx);
				const runDir = params.runDir
					? normalizeRunDir(ctx.cwd, scope, params.runDir)
					: createBatch(ctx.cwd, scope, params.slug);
				// Never relaunch an agent this process still owns (queued, running or
				// retry pending): a duplicate spawn would reset its record and race a
				// second child against the first.
				const alreadyActive = resolvedTasks.filter((resolved) => agentStillActive(runDir, resolved.task.id)).map((resolved) => resolved.task.id);
				if (alreadyActive.length > 0) {
					resolvedTasks = resolvedTasks.filter((resolved) => !alreadyActive.includes(resolved.task.id));
					tasks = resolvedTasks.map((resolved) => resolved.task);
					if (tasks.length === 0) {
						return {
							content: [{ type: "text", text: `Not relaunched: ${alreadyActive.join(", ")} still active in batch ${path.basename(runDir)}. Wait for them or stop them first.` }],
							details: { runDir, agents: getRunState(runDir, alreadyActive).agents, mode: "spawn" } satisfies SubagentRunRenderDetails,
							isError: true,
						};
					}
				}
				const taskPreviews = toTaskPreviews(tasks).map((preview, index) => {
					// tasks[i] === resolvedTasks[i].task (positional), so the resolved
					// profile's icon rides along into every preview consumer (tool render
					// details, live-state events, and the desktop subagents panel).
					const icon = resolvedTasks[index]?.profile?.icon;
					return icon ? { ...preview, icon } : preview;
				});
				const results: { id: string; pid: number; agentDir: string }[] = [];
				const maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
				const semaphore = getProjectSemaphore(ctx.cwd, maxConcurrent);
				const launchErrors: { id: string; error: string }[] = [];
				// Record planned agents in the parent session up front so queued
				// agents appear in status/wait before their semaphore slot opens.
				for (const resolved of resolvedTasks) {
					const task = resolved.task;
					updateRecord(runDir, task.id, {
						cwd: ctx.cwd, task, extraArgs: resolved.extraArgs, timeoutMs: resolved.timeoutMs, maxResultBytes: resolved.maxResultBytes,
						subagentType: task.subagentType, model: task.model, parentSession, status: "planned", turn: 1,
						exitCode: null, startedAt: null, finishedAt: null, nextRetryAt: null, pid: null, processGroup: null, childSessionFile: null,
						stopRequested: null, stopSignal: null, timedOut: null, structured: null, message: null, stderrPreview: null, retryCount: 0,
					}, parentSessionManager);
					updateLive(runDir, task.id, { active: true, resultText: undefined, stderrTail: undefined, lastActivity: undefined, todoProgress: undefined });
				}
				for (const preview of taskPreviews) recordSubagentTaskStatistics(parentSessionManager, runDir, preview);
				const liveRun = getLiveRun(liveAgents, runDir);
				const reservation = completionDelivery?.begin(parentSession);
				let deliveredState: RunState | undefined;

				try {
					for (const resolved of resolvedTasks) {
						const task = resolved.task;
						const preview = taskPreviews.find((item) => item.id === task.id);
						let resolveCompleted: () => void = () => {};
						const completed = new Promise<void>((resolve) => {
							resolveCompleted = resolve;
						});
						liveRun.set(task.id, { runDir, agentId: task.id, preview, parentSession, completed, awaitingCompletion: true });
						reservation?.add(liveRun.get(task.id)!);
						const capture = evidence.get(task.id);
						const reportCompletion = capture?.bind(runDir);

						void launchQueuedAgent({
							resolved,
							runDir,
							cwd: ctx.cwd,
							parentSession,
							parentSessionId: parentSessionManager?.getSessionId?.() || undefined,
							semaphore,
							signal: signal ?? undefined,
							onResult: (result) => results.push({ id: task.id, pid: result.pid, agentDir: result.agentDir }),
							onComplete: (completion) => {
								if (completion.state.status === "failed") {
									suiteDiagnostics.report("warn", "subagents", "agent-failed", ctx.cwd);
								}
								recordSubagentStateStatistics(parentSessionManager, runDir, task.id, completion.state.status);
								reportCompletion?.(completion);
								resolveCompleted();
								handleAgentCompletion(completion);
							},
							onCancelled: () => {
								capture?.cancel();
								stopAgents(runDir, [task.id], { signal: "SIGTERM" });
								resolveCompleted();
								const state = getAgentState(runDir, task.id, { includeLineCounts: false }) ?? { id: task.id, status: "stopped" as const };
								recordSubagentStateStatistics(parentSessionManager, runDir, task.id, state.status);
								handleAgentCompletion({ runDir, agentId: task.id, agentDir: ownedAgentDir(runDir, task.id), exitCode: 0, state });
							},
							onLaunchError: (error) => {
								const message = errorMessage(error);
								launchErrors.push({ id: task.id, error: message });
								if (ownedLaunchHoldsSlot(runDir, task.id)) {
									// No terminal proof for the owned artifacts: preserve
									// ownership and the concurrency slot rather than
									// fabricating a terminal launch failure.
									onLiveAgentsChange?.();
									return;
								}
								if (!signal?.aborted && diagnosticErrorType(error) !== "AbortError") {
									suiteDiagnostics.report("error", "subagents", "launch-failed", ctx.cwd,
										{ errorType: diagnosticErrorType(error) });
								}
								writeLaunchFailure(runDir, task, message, resolved.maxResultBytes);
								capture?.cancel();
								resolveCompleted();
								const state = getAgentState(runDir, task.id, { includeLineCounts: false }) ?? { id: task.id, status: "failed" as const, exitCode: 1 };
								recordSubagentStateStatistics(parentSessionManager, runDir, task.id, state.status);
								handleAgentCompletion({ runDir, agentId: task.id, agentDir: ownedAgentDir(runDir, task.id), exitCode: 1, state });
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
						onRpcEvent: (event) => {
							recordSubagentUsage(parentSessionManager, event, task.id, runDir);
							recordSubagentToolStatistics(parentSessionManager, event, runDir, task.id);
							onAgentRpcEvent?.(runDir, task.id, event);
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
						settledState: completionDelivery ? (state) => completionDelivery.settledState(state) : undefined,
					});
					const details: SubagentRunRenderDetails = { runDir, agents: state.agents, tasks: taskPreviews, mode: "spawn" };
					onLiveAgentsChange?.();
					const hasActiveOrQueued = state.agents.some((agent) => agent.status === "planned" || agent.status === "running" || agent.status === "retrying");
					const lines = [
						`Scheduled ${tasks.length} agent(s) in batch ${path.basename(runDir)}`,
						`Started ${results.length} agent(s) so far; maxConcurrent=${semaphore.limit} (project-wide).`,
						...(routed.usedLlm
							? [`LLM-routed ${Object.keys(routed.routes).length} inferred subagent type(s).`]
							: []),
						...(routed.warnings.length > 0 ? [`Routing fallback: ${routed.warnings.join(" ")}`] : []),
						"",
						...state.agents.map(
							(a) => `${formatAgentStatus(a.status)} ${a.id}${a.pid ? ` (pid ${a.pid})` : ""}`,
						),
						...(alreadyActive.length > 0
							? ["", `Not relaunched (still active): ${alreadyActive.join(", ")}`]
							: []),
						...(launchErrors.length > 0
							? ["", "Launch errors:", ...launchErrors.map((item) => `- ${item.id}: ${item.error}`)]
							: []),
						"",
						hasActiveOrQueued
							? "Agents continue running or queued in the background after this watch window."
							: "All scheduled agents are no longer running or queued.",
						`Use subagents({ action: "status" }) for this session's latest batch, or include runDir: "${path.basename(runDir)}" for this batch.`,
						"Use subagents({ action: \"result\", agentId: \"<agent-id>\" }) to read output; runDir is optional because agent IDs resolve to their latest run in this session.",
					];

					deliveredState = state;
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details,
					};
				} finally {
					reservation?.finish(deliveredState, signal);
				}
			} finally {
				for (const capture of evidence.values()) capture.releaseUnbound();
			}
		},

		renderCall() {
			return emptyToolSlot();
		},

		renderResult(result, opts, theme) {
			const details = result.details as SubagentRunRenderDetails | undefined;
			if (!details || ("isError" in result && result.isError === true)) {
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

/** True while this process still owns a non-terminal launch of the agent. */
function agentStillActive(runDir: string, agentId: string): boolean {
	const record = getRecord(runDir, agentId);
	if (!record || !getLive(runDir, agentId)?.active) return false;
	return record.status === "planned" || record.status === "running" || record.status === "retrying";
}
