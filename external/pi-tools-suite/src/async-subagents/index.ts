import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	filterSubagentConfigForContext,
	getRunState,
	isBlindModelRef,
	loadSubagentConfig,
	listSubagentSessionRecords,
	stopAgents,
	type AgentCompletionHandler,
	type RpcEventRecord,
	type StopSignal,
	type SubagentSessionRecord,
} from "./lib.js";
import { activityFromRpcEvent } from "./core/activity.js";
import { buildAgentCompletionNotification } from "./core/notifications.js";
import { CompletionDelivery } from "./completion-delivery.js";
import { buildUltraworkPrompt, isUltraworkEnvEnabled, registerCommands } from "./commands.js";
import { agentStrategyPrompt, appendAgentStrategyPrompt } from "./core/agent-strategy.js";
import { buildSubagentCatalogPrompt } from "./core/agent-catalog.js";
import {
	bridgeImageAttachments,
	type BridgedImageAttachment,
	type BridgeImageAttachmentsResult,
} from "./core/attachment-bridge.js";

import { appendUltraworkAutoHint, decideUltraworkAuto, isGptLikeModel, isUltraworkAutoEnvEnabled } from "./core/ultrawork-auto.js";
import { SubagentOverlay } from "./subagent-overlay.js";
import { registerSubagentsTool } from "./tools/subagents.js";
import type { LiveAgent, SubagentsLiveStateEvent } from "./types.js";
import type { AgentState } from "./core/types.js";
import { publishRpcSessionState } from "../lib/rpc-session-state.js";
import { clearSubagentsNativeWidget, updateSubagentsNativeWidget } from "./native-tui.js";
import { ownedArtifactsPresentSync } from "./core/owned-retirement.js";

function isTerminalAgentStatus(status: AgentState["status"]): boolean {
	return status === "done" || status === "failed" || status === "stopped";
}

const SUBAGENTS_LIVE_COUNT_EVENT = "pi-tools-suite:async-subagents:live-count";
const SUBAGENTS_LIVE_STATE_EVENT = "pi-tools-suite:async-subagents:live-state";
export const SUBAGENTS_CATALOG_STATE_EVENT = "pi-tools-suite:async-subagents:catalog";
const SESSION_SHUTDOWN_KILL_GRACE_MS = 500;
const COMPLETION_WATCH_INTERVAL_MS = 2_000;

interface ShutdownTarget {
	runDir: string;
	agentIds?: string[];
}

interface SubagentCatalogStateEvent {
	version: 1;
	sessionId?: string;
	sessionFile?: string;
	model?: string;
	types: string[];
}

function createLiveStatePayload(
	liveAgents: Map<string, Map<string, LiveAgent>>,
	sessionFile: string | undefined,
): SubagentsLiveStateEvent {
	const runs: SubagentsLiveStateEvent["runs"] = [];
	let count = 0;
	for (const [runDir, liveRun] of liveAgents.entries()) {
		const matchingLiveAgents = [...liveRun.values()].filter((agent) => agentMatchesSession(agent, sessionFile));
		if (matchingLiveAgents.length === 0) continue;
		const agentIds = matchingLiveAgents.map((agent) => agent.agentId);
		const state = getRunState(runDir, agentIds, { includeLineCounts: false, checkRpcPromptFailure: false });
		const liveAgentsById = new Map(matchingLiveAgents.map((agent) => [agent.agentId, agent]));
		const activeAgents = state.agents
			.filter((agent) => !isTerminalAgentStatus(agent.status))
			.map((agent) => {
				const lastActivity = liveAgentsById.get(agent.id)?.lastActivity;
				return lastActivity ? { ...agent, lastActivity } : agent;
			});
		if (activeAgents.length === 0) continue;
		count += activeAgents.length;
		const tasks = matchingLiveAgents.map((agent) => agent.preview).filter((preview): preview is NonNullable<typeof preview> => Boolean(preview));
		runs.push({
			runDir,
			agents: activeAgents,
			...(tasks.length > 0 ? { tasks } : {}),
		});
	}
	return {
		version: 1,
		count,
		runs,
		...(sessionFile ? { sessionFile } : {}),
		checkedAt: Date.now(),
	};
}

function createSubagentCatalogState(ctx: unknown): SubagentCatalogStateEvent {
	const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const model = modelRefFromContext(ctx);
	const config = safeLoadSubagentConfig(cwd);
	const effective = config ? filterSubagentConfigForContext(config, { parentModelRef: model, cwd }) : undefined;
	const sessionManager = (ctx as {
		sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined };
	} | undefined)?.sessionManager;
	const sessionId = typeof sessionManager?.getSessionId === "function" ? sessionManager.getSessionId() : undefined;
	const sessionFile = typeof sessionManager?.getSessionFile === "function" ? sessionManager.getSessionFile() : undefined;
	return {
		version: 1,
		...(sessionId ? { sessionId } : {}),
		...(sessionFile ? { sessionFile } : {}),
		...(model ? { model } : {}),
		types: Object.keys(effective?.types ?? {}).sort(),
	};
}

function agentMatchesSession(agent: LiveAgent, sessionFile: string | undefined): boolean {
	if (!sessionFile) return true;
	return agent.parentSession !== undefined && pathsEqual(sessionFile, agent.parentSession);
}

function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && /ctx is stale|stale ctx|stale after session replacement|stale after.*reload/i.test(error.message);
}

function ignoreStaleExtensionContextError(error: unknown): void {
	if (!isStaleExtensionContextError(error)) throw error;
}

export default function (pi: ExtensionAPI) {
	const liveAgents = new Map<string, Map<string, LiveAgent>>();
	const subagentOverlay = new SubagentOverlay(liveAgents);
	let sawAutoUltraworkCandidate = false;
	let currentSessionFile: string | undefined;
	let currentSessionStateContext: ExtensionContext | undefined;
	let completionWatchTimer: ReturnType<typeof setInterval> | undefined;
	let shuttingDown = false;
	const completionDelivery = new CompletionDelivery(liveAgents, refreshSubagentOverlay);

	function publishSubagentCatalogState(ctx: unknown): void {
		const state = createSubagentCatalogState(ctx);
		pi.events?.emit?.(SUBAGENTS_CATALOG_STATE_EVENT, state);
		publishRpcSessionState(ctx as Parameters<typeof publishRpcSessionState>[0], SUBAGENTS_CATALOG_STATE_EVENT, state);
	}

	function refreshSubagentOverlay(): void {
		try {
			reconcileLiveAgentCompletions();
			const liveState = createLiveStatePayload(liveAgents, currentSessionFile);
			pi.events?.emit?.(SUBAGENTS_LIVE_COUNT_EVENT, { count: liveState.count });
			pi.events?.emit?.(SUBAGENTS_LIVE_STATE_EVENT, liveState);
			publishRpcSessionState(currentSessionStateContext, SUBAGENTS_LIVE_STATE_EVENT, liveState);
			updateSubagentsNativeWidget(currentSessionStateContext, liveState);
			updateCompletionWatcher();
		} catch (error) {
			ignoreStaleExtensionContextError(error);
		}
	}

	function removeLiveAgent(runDir: string, agentId: string): void {
		const liveRun = liveAgents.get(runDir);
		liveRun?.delete(agentId);
		if (liveRun?.size === 0) liveAgents.delete(runDir);
	}

	function reconcileLiveAgentCompletions(): void {
		if (shuttingDown) return;
		for (const [runDir, liveRun] of [...liveAgents.entries()]) {
			const states = new Map(
				getRunState(runDir, [...liveRun.keys()], {
					includeLineCounts: false,
					checkRpcPromptFailure: false,
				}).agents.map((agent) => [agent.id, agent]),
			);
			for (const agentId of [...liveRun.keys()]) {
				const liveAgent = liveRun.get(agentId)!;
				// Disk receipts may describe an intermediate attempt. Only the
				// final callback can settle launches still owned by this instance.
				if (liveAgent.awaitingCompletion) continue;
				if (completionDelivery.isReserved(liveAgent)) continue;
				const state = states.get(agentId);
				if (!state) {
					removeLiveAgent(runDir, agentId);
					continue;
				}
				if (!isTerminalAgentStatus(state.status)) continue;
				// A shared runtime may have switched sessions while the child ran.
				// Keep its completion pending until its originating session is active.
				if (!agentMatchesSession(liveAgent, currentSessionFile)) continue;
				removeLiveAgent(runDir, agentId);
				pi.sendMessage(buildAgentCompletionNotification({
					agentId, runDir, state,
					runAgents: getRunState(runDir, undefined, {
						includeLineCounts: false, checkRpcPromptFailure: false,
					}).agents,
				}), { triggerTurn: true, deliverAs: "followUp" });
			}
		}
	}

	function hasLiveAgentsForCurrentSession(): boolean {
		return createLiveStatePayload(liveAgents, currentSessionFile).count > 0;
	}

	function updateCompletionWatcher(): void {
		if (hasLiveAgentsForCurrentSession()) {
			if (completionWatchTimer) return;
			completionWatchTimer = setInterval(refreshSubagentOverlay, COMPLETION_WATCH_INTERVAL_MS);
			completionWatchTimer.unref?.();
			return;
		}
		if (!completionWatchTimer) return;
		clearInterval(completionWatchTimer);
		completionWatchTimer = undefined;
	}

	const handleAgentCompletion: AgentCompletionHandler = ({ runDir, agentId }) => {
		const liveAgent = liveAgents.get(runDir)?.get(agentId);
		if (liveAgent) liveAgent.awaitingCompletion = false;
		refreshSubagentOverlay();
	};

	function handleAgentRpcEvent(runDir: string, agentId: string, event: RpcEventRecord): void {
		const activity = activityFromRpcEvent(event);
		if (!activity) return;
		const liveAgent = liveAgents.get(runDir)?.get(agentId);
		if (!liveAgent) return;
		liveAgent.lastActivity = activity;
		refreshSubagentOverlay();
	}

	registerSubagentsTool(pi, liveAgents, handleAgentCompletion, refreshSubagentOverlay, handleAgentRpcEvent, completionDelivery);
	registerCommands(pi);

	pi.on("session_start", async (_event, ctx) => {
		try {
			shuttingDown = false;
			sawAutoUltraworkCandidate = false;
			currentSessionFile = sessionFileFromContext(ctx);
			currentSessionStateContext = ctx;
			publishSubagentCatalogState(ctx);
			subagentOverlay.restoreRunningAgents(ctx.cwd, currentSessionFile);
			refreshSubagentOverlay();
		} catch (error) {
			ignoreStaleExtensionContextError(error);
		}
	});

	pi.on("model_select", (_event, ctx) => {
		try {
			publishSubagentCatalogState(ctx);
		} catch (error) {
			ignoreStaleExtensionContextError(error);
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== "subagents" && !event.toolName.startsWith("async_subagents_")) return;
		refreshSubagentOverlay();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const strategyPrompt = agentStrategyPrompt({
			modelRef: modelRefFromContext(ctx),
			customPrompt: Boolean(event?.systemPromptOptions?.customPrompt),
		});
		const visionPrompt = visionCapabilityPrompt(event, ctx);
		const catalogPrompt = selectedToolsInclude(event, "subagents")
			? subagentCatalogPrompt(
				(ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd(),
				modelRefFromContext(ctx),
			)
			: undefined;
		if (!strategyPrompt && !visionPrompt && !catalogPrompt) return undefined;
		let systemPrompt = event.systemPrompt ?? "";
		if (strategyPrompt) systemPrompt = appendAgentStrategyPrompt(systemPrompt, strategyPrompt);
		if (catalogPrompt) systemPrompt = appendAgentStrategyPrompt(systemPrompt, catalogPrompt);
		if (visionPrompt) systemPrompt = appendAgentStrategyPrompt(systemPrompt, visionPrompt);
		return { systemPrompt };
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		const text = event.text.trim();
		if (!text || text.startsWith("/")) return { action: "continue" as const };
		if (/^run ultrawork mode\b/i.test(text)) return { action: "continue" as const };
		if (isUltraworkEnvEnabled()) {
			return {
				action: "transform" as const,
				text: buildUltraworkPrompt(event.text),
				images: event.images,
			};
		}

		if (sawAutoUltraworkCandidate || !isUltraworkAutoEnvEnabled()) return { action: "continue" as const };
		sawAutoUltraworkCandidate = true;
		if (isGptLikeModel(modelRefFromContext(ctx))) return { action: "continue" as const };

		const config = safeLoadSubagentConfig(ctx?.cwd ?? process.cwd());
		if (!config) return { action: "continue" as const };
		const decision = await decideUltraworkAuto(event.text, config, ctx ?? {});
		if (decision === "none") return { action: "continue" as const };
		if (decision === "hint") {
			return {
				action: "transform" as const,
				text: appendUltraworkAutoHint(event.text),
				images: event.images,
			};
		}
		return {
			action: "transform" as const,
			text: buildUltraworkPrompt(event.text),
			images: event.images,
		};
	});

	pi.on("session_shutdown", async (event, ctx) => {
		try {
			shuttingDown = true;
			clearSubagentsNativeWidget(ctx);
			subagentOverlay.dispose();
			if (completionWatchTimer) {
				clearInterval(completionWatchTimer);
				completionWatchTimer = undefined;
			}
			if (event?.reason === "reload" || event?.reason === "fork") return;
			try {
				const shutdownSessionFile = sessionFileFromContext(ctx) ?? currentSessionFile;
				await stopProjectSubagents(ctx.cwd, liveAgents, { parentSession: shutdownSessionFile });
				liveAgents.clear();
				refreshSubagentOverlay();
			} catch {
				// Shutdown cleanup is best-effort and must never block the main session from closing.
			}
		} catch (error) {
			ignoreStaleExtensionContextError(error);
		}
	});
}
function sessionFileFromContext(ctx: unknown): string | undefined {
	const sessionManager = (ctx as { sessionManager?: { getSessionFile?: unknown } } | undefined)?.sessionManager;
	if (typeof sessionManager?.getSessionFile !== "function") return undefined;
	const sessionFile = sessionManager.getSessionFile();
	return typeof sessionFile === "string" && sessionFile.trim() ? sessionFile : undefined;
}

function pathsEqual(left: string, right: string): boolean {
	return normalizePath(left) === normalizePath(right);
}

function normalizePath(filePath: string): string {
	const resolved = path.resolve(filePath);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function safeLoadSubagentConfig(cwd: string) {
	try {
		return loadSubagentConfig(cwd);
	} catch {
		return undefined;
	}
}

function subagentCatalogPrompt(cwd: string, parentModelRef?: string): string | undefined {
	const config = safeLoadSubagentConfig(cwd);
	return config ? buildSubagentCatalogPrompt(config, parentModelRef, cwd) : undefined;
}

function modelRefFromContext(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const model = (ctx as { model?: unknown }).model;
	if (!model) return undefined;
	if (typeof model === "string") return model;
	if (typeof model === "object") {
		const candidate = model as { provider?: unknown; providerId?: unknown; id?: unknown; model?: unknown; modelId?: unknown; name?: unknown };
		const provider = typeof candidate.provider === "string" ? candidate.provider : typeof candidate.providerId === "string" ? candidate.providerId : undefined;
		const modelId = typeof candidate.modelId === "string"
			? candidate.modelId
			: typeof candidate.id === "string"
				? candidate.id
				: typeof candidate.model === "string"
					? candidate.model
					: typeof candidate.name === "string"
						? candidate.name
						: undefined;
		if (provider && modelId) return `${provider}/${modelId}`;
		return modelId;
	}
	return undefined;
}

function visionCapabilityPrompt(event: unknown, ctx: unknown): string | undefined {
	const support = parentModelImageSupport(ctx);
	if (support === true) return visionCapableParentPrompt(event);
	if (support !== false) return undefined;
	const imageCount = attachedImageCount(event);
	const subagentsAvailable = selectedToolsInclude(event, "subagents");
	const bridge = subagentsAvailable && imageCount > 0
		? bridgeImageAttachments((ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd(), event)
		: undefined;
	const attachmentWarning = imageCount > 0
		? `This turn includes ${imageCount} attached image(s), but the current parent model cannot inspect them directly.`
		: "The current parent model cannot inspect images/screenshots directly.";
	const delegation = subagentsAvailable
		? visionSubagentDelegationText(bridge?.attachments ?? [])
		: "If visual understanding is required, use the lookup tool if available; otherwise ask the user to switch to a vision-capable model or provide an inspectable image path.";
	const bridgeWarning = visionBridgeWarning(bridge);
	return [
		"Vision capability constraint:",
		attachmentWarning,
		"Do not claim to have viewed or understood image contents yourself.",
		bridgeWarning,
		delegation,
		bridge?.attachments.length
		? "Use those bridged paths exactly as lookup imagePaths if needed."
		: "If an image only arrived as an attachment and no local file path/reference is available to lookup, ask the user for a file path or to switch the parent model to one with image input support.",
	].filter(Boolean).join(" ");
}

function parentModelImageSupport(ctx: unknown): boolean | undefined {
	const model = (ctx as { model?: unknown } | undefined)?.model;
	const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const config = safeLoadSubagentConfig(cwd);
	const modelRef = modelRefFromContext(ctx);
	if (config && isBlindModelRef(modelRef, config)) return false;
	return modelImageInputSupport(model) === true ? true : undefined;
}

function visionCapableParentPrompt(event: unknown): string | undefined {
	if (attachedImageCount(event) === 0 && !promptContainsImagePath(event)) return undefined;
	return [
		"Vision capability note:",
		"The current parent model supports image input.",
		"If the user provided image attachments or local image file paths, inspect them directly first; for local paths, use the read tool on the image path.",
		"Do not delegate solely to gain visual access; use lookup for focused visual checks and subagents only for broader independent tracks.",
	].join(" ");
}

function visionSubagentDelegationText(attachments: BridgedImageAttachment[]): string {
	if (attachments.length === 0) {
		return "If visual understanding is required, use the lookup tool with imagePaths/focus when the image is available as a local file path.";
	}
	const imagePaths = attachments.map((attachment) => attachment.relativePath);
	return `Attached images were saved for lookup. If visual understanding is required, call lookup with imagePaths=${JSON.stringify(imagePaths)} and a focused question.`;
}

function visionBridgeWarning(bridge: BridgeImageAttachmentsResult | undefined): string | undefined {
	if (!bridge) return undefined;
	if (bridge.error) return `Attempted to save attached images for delegation, but failed: ${bridge.error}.`;
	if (bridge.skipped > 0) return `${bridge.skipped} attached image(s) could not be saved because their type or data was unsupported.`;
	return undefined;
}

function modelImageInputSupport(model: unknown): boolean | undefined {
	if (!model || typeof model !== "object") return undefined;
	const input = (model as { input?: unknown }).input;
	if (!Array.isArray(input)) return undefined;
	return input.some((value) => value === "image");
}

function attachedImageCount(event: unknown): number {
	const images = (event as { images?: unknown } | undefined)?.images;
	return Array.isArray(images) ? images.length : 0;
}

function promptContainsImagePath(event: unknown): boolean {
	const prompt = (event as { prompt?: unknown } | undefined)?.prompt;
	return typeof prompt === "string" && /(?:^|\s)(?:\.?\.?\/|~\/|\/)[^\s]+\.(?:png|jpe?g|gif|webp)\b/i.test(prompt);
}

function selectedToolsInclude(event: unknown, toolName: string): boolean {
	const selectedTools = (event as { systemPromptOptions?: { selectedTools?: unknown } } | undefined)?.systemPromptOptions?.selectedTools;
	return !Array.isArray(selectedTools) || selectedTools.includes(toolName);
}

async function stopProjectSubagents(
	cwd: string,
	liveAgents: Map<string, Map<string, LiveAgent>>,
	options: { parentSession?: string } = {},
): Promise<void> {
	const targets = collectShutdownTargets(cwd, liveAgents, options.parentSession);
	const signaled = signalShutdownTargets(targets, "SIGTERM");
	if (signaled > 0) await sleep(SESSION_SHUTDOWN_KILL_GRACE_MS);
	signalShutdownTargets(targets, "SIGKILL");

	for (const target of targets) stopRunBestEffort(target.runDir, target.agentIds, "SIGKILL");
	// Session lifetime is not evidence lifetime. Keep reports, attachments and
	// registry pointers for later reads; explicit/TTL cleanup owns deletion.
}


function collectShutdownTargets(
	cwd: string,
	liveAgents: Map<string, Map<string, LiveAgent>>,
	parentSession: string | undefined,
): ShutdownTarget[] {
	if (!parentSession) return [...liveAgents.entries()].map(([runDir, liveRun]) => ({
		runDir,
		agentIds: [...liveRun.keys()],
	}));

	const targets = new Map<string, Set<string>>();
	const recordsByRun = groupRecordsByRun(listSubagentSessionRecords(cwd));

	for (const [runDir, records] of recordsByRun) {
		const matchingRecords = records.filter((record) => recordMatchesSession(record, parentSession));
		if (matchingRecords.length === 0) continue;
		mergeTargetIds(targets, runDir, matchingRecords.map((record) => record.agentId));
	}

	for (const [runDir, liveRun] of liveAgents) {
		const matchingIds = [...liveRun.values()]
			.filter((agent) => liveAgentMatchesSession(agent, parentSession))
			.map((agent) => agent.agentId);
		if (matchingIds.length === 0) continue;
		mergeTargetIds(targets, runDir, matchingIds);
	}

	return targetMapToTargets(targets);
}

function groupRecordsByRun(records: SubagentSessionRecord[]): Map<string, SubagentSessionRecord[]> {
	const grouped = new Map<string, SubagentSessionRecord[]>();
	for (const record of records) {
		const existing = grouped.get(record.runDir) ?? [];
		existing.push(record);
		grouped.set(record.runDir, existing);
	}
	return grouped;
}

function recordMatchesSession(record: SubagentSessionRecord, sessionFile: string): boolean {
	return Boolean(record.parentSession && pathsEqual(record.parentSession, sessionFile));
}

function liveAgentMatchesSession(agent: LiveAgent, sessionFile: string): boolean {
	return Boolean(agent.parentSession && pathsEqual(agent.parentSession, sessionFile));
}

function mergeTargetIds(targets: Map<string, Set<string>>, runDir: string, agentIds: string[]): void {
	const target = targets.get(runDir) ?? new Set<string>();
	for (const agentId of agentIds) target.add(agentId);
	targets.set(runDir, target);
}

function targetMapToTargets(targets: Map<string, Set<string>>): ShutdownTarget[] {
	return [...targets.entries()].map(([runDir, agentIds]) => ({ runDir, agentIds: [...agentIds] }));
}

function signalShutdownTargets(targets: ShutdownTarget[], signal: StopSignal): number {
	let signaled = 0;
	for (const target of targets) {
		try {
			const state = getRunState(target.runDir, target.agentIds);
			for (const agent of state.agents) {
				// Session shutdown must not use a recorded bridge PID (nor its
				// group) for an owned run. stopAgents writes the durable cancel
				// marker. Artifacts alone (even without a pointer) mark the run
				// owned: unknown ownership never falls back to PID signaling.
				if (ownedArtifactsPresentSync(path.join(target.runDir, agent.id))) continue;
				if (agent.status !== "running" || !agent.pid || agent.pid <= 0) continue;
				try {
					process.kill(agent.pid, signal);
					signaled += 1;
				} catch {
					// Process may have exited between status read and signal delivery.
				}
			}
		} catch {
			// Keep shutdown best-effort even when run state cannot be read.
		}
	}
	return signaled;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopRunBestEffort(runDir: string, agentIds: string[] | undefined, signal: StopSignal): void {
	try {
		stopAgents(runDir, agentIds, { signal });
	} catch {
		// Keep cleanup best-effort even if a process is already gone or cannot be signaled.
	}
}
