import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { ASYNC_SUBAGENT_TOOL_DESCRIPTIONS } from "../../tool-descriptions.js";
import type { AgentCompletionHandler, RpcEventRecord } from "../lib.js";
import {
	DEFAULT_MAX_CONCURRENT,
	getAgentState,
	loadSubagentConfig,
	readSessionFileLink,
	resolveSubagentAgentRunDir,
	spawnAgent,
	validateBasename,
	writeStructuredResult,
} from "../lib.js";
import { isTerminalAgentStatus } from "../core/notifications.js";
import { archiveAgentTurn, readLaunchSpec, readTurnCount } from "../core/turns.js";
import { getLiveChannel, LiveChannelClosingError, type LiveSendMode } from "../core/live-channel.js";
import { maySelectOwnedProvider } from "../core/owned-launch-integration.js";
import { ownedArtifactsPresentSync, ownedDeletableSync } from "../core/owned-retirement.js";
import { recordSubagentUsage } from "../core/usage.js";
import { recordSubagentStateStatistics, recordSubagentToolStatistics } from "../core/statistics.js";
import { isoNow } from "../core/utils.js";
import { INLINE_RENDERING } from "../constants.js";
import { getLiveRun } from "../live.js";
import { emptyToolSlot } from "../ui.js";
import { diagnosticErrorType, suiteDiagnostics } from "../../lib/suite-diagnostics.js";
import type { LiveAgent } from "../types.js";
import { getProjectSemaphore, resolveOwnedLaunchOptions } from "./spawn.js";

/** Bounded wait for a settling live process before falling back to a cold resume. */
const CLOSING_CHANNEL_WAIT_MS = 15_000;

interface SendResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
}

function textResult(text: string, details: Record<string, unknown>, isError = false): SendResult {
	return { content: [{ type: "text", text }], details, ...(isError ? { isError: true } : {}) };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeMode(value: unknown): LiveSendMode | undefined {
	if (value === undefined || value === null || value === "") return "followUp";
	if (typeof value !== "string") return undefined;
	const mode = value.trim().toLowerCase();
	if (mode === "followup" || mode === "follow_up" || mode === "follow-up") return "followUp";
	if (mode === "steer") return "steer";
	return undefined;
}

async function waitWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([promise.then(() => true as const), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function registerSendTool(
	pi: ExtensionAPI,
	liveAgents: Map<string, Map<string, LiveAgent>>,
	handleAgentCompletion: AgentCompletionHandler,
	onLiveAgentsChange?: () => void,
	onAgentRpcEvent?: (runDir: string, agentId: string, event: RpcEventRecord) => void,
): void {
	pi.registerTool({
		...ASYNC_SUBAGENT_TOOL_DESCRIPTIONS.sendAction,
		...INLINE_RENDERING,
		parameters: Type.Object({
			agentId: Type.String({ description: "Agent ID to message" }),
			runDir: Type.Optional(Type.String({ description: "Run directory path. If omitted, resolves agentId through .pi/subagents/registry.json." })),
			message: Type.String({ description: "Message for the sub-agent" }),
			mode: Type.Optional(Type.String({ description: "Running agents only: followUp (default, after the current turn) or steer (interrupt the current turn)." })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			validateBasename(params.agentId, "agentId");
			const message = typeof params.message === "string" ? params.message.trim() : "";
			if (!message) return textResult("send requires a non-empty message.", {}, true);
			const mode = normalizeMode(params.mode);
			if (!mode) return textResult("send mode must be followUp or steer.", {}, true);
			const runDir = resolveSubagentAgentRunDir(ctx.cwd, params.agentId, params.runDir);
			const agentId = params.agentId;
			const agentDir = path.join(runDir, agentId);
			const details = { runDir, agentId, mode };

			// Live path: the agent runs in this parent process.
			const channel = getLiveChannel(agentDir);
			if (channel) {
				if (!channel.isClosing()) {
					try {
						const result = await channel.send(message, mode);
						onLiveAgentsChange?.();
						return textResult(
							`Delivered to running agent "${agentId}" (${mode}, ${result.disposition}). Its final result arrives as a completion follow-up.`,
							{ ...details, delivery: "live", disposition: result.disposition },
						);
					} catch (error) {
						if (!(error instanceof LiveChannelClosingError))
							return textResult(`Failed to deliver to running agent "${agentId}": ${errorMessage(error)}`, details, true);
					}
				}
				// The process is shutting down after its turn: resume once it is gone.
				if (!await waitWithTimeout(channel.finished, CLOSING_CHANNEL_WAIT_MS))
					return textResult(`Agent "${agentId}" is still finishing its turn; retry send shortly.`, details, true);
			}

			const state = getAgentState(runDir, agentId, { includeLineCounts: false });
			if (!state) return textResult(`Agent "${agentId}" not found in ${runDir}`, details, true);
			if (!isTerminalAgentStatus(state.status)) {
				return textResult(
					`Agent "${agentId}" is ${state.status} but not owned by this session process, so a live message cannot be delivered. Wait for it to finish, then send again.`,
					{ ...details, status: state.status }, true,
				);
			}

			// Cold path: resume the persisted session in a fresh process.
			const sessionFile = readSessionFileLink(agentDir);
			if (!sessionFile || !fs.existsSync(sessionFile))
				return textResult(`Agent "${agentId}" has no persisted session to resume (it never started).`, details, true);
			const spec = readLaunchSpec(agentDir);
			if (!spec) return textResult(`Agent "${agentId}" has no launch.json; it was launched before resume support and cannot be resumed.`, details, true);
			if (ownedArtifactsPresentSync(agentDir) && !ownedDeletableSync(agentDir))
				return textResult(`Agent "${agentId}" is still retiring its previous process; retry send shortly.`, details, true);

			const parentSessionManager = ctx.sessionManager;
			const parentSession = typeof ctx.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined;
			const parentSessionId = typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined;
			const config = loadSubagentConfig(ctx.cwd);
			const semaphore = getProjectSemaphore(ctx.cwd, config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
			const turn = archiveAgentTurn(agentDir, message) + 1;

			let resolveCompleted!: () => void;
			const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
			const liveRun = getLiveRun(liveAgents, runDir);
			const previous = liveRun.get(agentId);
			liveRun.set(agentId, {
				runDir, agentId, preview: previous?.preview ?? { id: agentId, task: spec.task.task, subagentType: spec.task.subagentType, model: spec.task.model },
				parentSession, completed, awaitingCompletion: true,
			});
			onLiveAgentsChange?.();

			const finish = (completion: Parameters<AgentCompletionHandler>[0]) => {
				recordSubagentStateStatistics(parentSessionManager, runDir, agentId, completion.state.status);
				resolveCompleted();
				handleAgentCompletion(completion);
			};
			const failLaunch = (error: unknown) => {
				const text = `Resume failed before the sub-agent process started: ${errorMessage(error)}`;
				if (diagnosticErrorType(error) !== "AbortError")
					suiteDiagnostics.report("error", "subagents", "resume-failed", ctx.cwd, { errorType: diagnosticErrorType(error) });
				if (fs.existsSync(agentDir)) {
					const now = isoNow();
					fs.writeFileSync(path.join(agentDir, "result.md"), text, "utf-8");
					fs.writeFileSync(path.join(agentDir, "exit_code"), "1", "utf-8");
					if (!fs.existsSync(path.join(agentDir, "started_at"))) fs.writeFileSync(path.join(agentDir, "started_at"), now, "utf-8");
					fs.writeFileSync(path.join(agentDir, "finished_at"), now, "utf-8");
				}
				const failed = getAgentState(runDir, agentId, { includeLineCounts: false }) ?? { id: agentId, status: "failed" as const, exitCode: 1 };
				try {
					writeStructuredResult({ agentDir, agentId, state: failed, subagentType: spec.task.subagentType, model: spec.task.model, maxResultBytes: spec.maxResultBytes });
				} catch { /* non-critical */ }
				finish({ runDir, agentId, agentDir, exitCode: 1, state: failed });
			};

			// Launch in the background: the project semaphore may queue this turn.
			void (async () => {
				let slotAcquired = false;
				let slotReleased = false;
				const releaseSlot = () => {
					if (!slotAcquired || slotReleased) return;
					slotReleased = true;
					semaphore.release();
				};
				try {
					await semaphore.acquire();
					slotAcquired = true;
					const ownedOptions = maySelectOwnedProvider(spec.task, spec.extraArgs, [])
						? await resolveOwnedLaunchOptions([ctx.cwd, runDir]) : {};
					spawnAgent(runDir, spec.task, ctx.cwd, spec.extraArgs, (event) => {
						recordSubagentUsage(parentSessionManager, event, agentId, runDir);
						recordSubagentToolStatistics(parentSessionManager, event, runDir, agentId);
						onAgentRpcEvent?.(runDir, agentId, event);
					}, (completion) => {
						releaseSlot();
						finish(completion);
					}, {
						resume: { message, sessionFile },
						parentSession,
						parentSessionId,
						timeoutMs: spec.timeoutMs,
						maxResultBytes: spec.maxResultBytes,
						...ownedOptions,
					});
					onLiveAgentsChange?.();
				} catch (error) {
					if (!(ownedArtifactsPresentSync(agentDir) && !ownedDeletableSync(agentDir))) releaseSlot();
					failLaunch(error);
				}
			})();

			if (signal?.aborted) throw new Error("Aborted");
			return textResult(
				`Resumed agent "${agentId}" (turn ${turn}) from its persisted session in ${runDir}. Previous turn artifacts are in turns/${readTurnCount(agentDir)}/. The result arrives as a completion follow-up; use subagents({ action: "result", agentId: "${agentId}" }) after it finishes.`,
				{ ...details, delivery: "resume", turn },
			);
		},

		renderCall() {
			return emptyToolSlot();
		},
	});
}
