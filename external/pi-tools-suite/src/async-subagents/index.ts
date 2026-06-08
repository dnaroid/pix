import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	deleteRunDirs,
	getActiveSubagentPresetName,
	getRunState,
	getRunRoot,
	getSubagentRegistryPath,
	isBlindModelRef,
	loadSubagentConfig,
	listRunDirs,
	loadSubagentRegistry,
	removeSubagentRunsFromRegistry,
	stopAgents,
	type AgentCompletionHandler,
	type StopSignal,
} from "./lib.js";
import { buildUltraworkPrompt, isUltraworkEnvEnabled, registerCommands } from "./commands.js";
import { agentStrategyPrompt, appendAgentStrategyPrompt } from "./core/agent-strategy.js";
import {
	bridgeImageAttachments,
	removeImageAttachmentBridgeState,
	type BridgedImageAttachment,
	type BridgeImageAttachmentsResult,
} from "./core/attachment-bridge.js";

import { appendUltraworkAutoHint, decideUltraworkAuto, isGptLikeModel, isUltraworkAutoEnvEnabled } from "./core/ultrawork-auto.js";
import { SubagentOverlay } from "./subagent-overlay.js";
import { registerSubagentsTool } from "./tools/subagents.js";
import type { LiveAgent, SubagentsLiveStateEvent } from "./types.js";
import type { AgentState } from "./core/types.js";
import { publishStartupSection } from "../startup-section.js";

function isTerminalAgentStatus(status: AgentState["status"]): boolean {
	return status === "done" || status === "failed" || status === "stopped";
}

const SUBAGENTS_LIVE_COUNT_EVENT = "pi-tools-suite:async-subagents:live-count";
const SUBAGENTS_LIVE_STATE_EVENT = "pi-tools-suite:async-subagents:live-state";
const SESSION_SHUTDOWN_KILL_GRACE_MS = 500;
const COMPLETION_WATCH_INTERVAL_MS = 2_000;

interface ShutdownTarget {
	runDir: string;
	agentIds?: string[];
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
		const activeAgents = state.agents.filter((agent) => !isTerminalAgentStatus(agent.status));
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

function agentMatchesSession(agent: LiveAgent, sessionFile: string | undefined): boolean {
	if (!sessionFile || !agent.parentSession) return true;
	return pathsEqual(sessionFile, agent.parentSession);
}

export default function (pi: ExtensionAPI) {
	const liveAgents = new Map<string, Map<string, LiveAgent>>();
	const subagentOverlay = new SubagentOverlay(liveAgents);
	let sawAutoUltraworkCandidate = false;
	let currentSessionFile: string | undefined;
	let completionWatchTimer: ReturnType<typeof setInterval> | undefined;
	publishSubagentPresetsStartupSection();

	function refreshSubagentOverlay(): void {
		reconcileLiveAgentCompletions();
		const liveState = createLiveStatePayload(liveAgents, currentSessionFile);
		pi.events?.emit?.(SUBAGENTS_LIVE_COUNT_EVENT, { count: liveState.count });
		pi.events?.emit?.(SUBAGENTS_LIVE_STATE_EVENT, liveState);
		updateCompletionWatcher();
	}

	function removeLiveAgent(runDir: string, agentId: string): void {
		const liveRun = liveAgents.get(runDir);
		liveRun?.delete(agentId);
		if (liveRun?.size === 0) liveAgents.delete(runDir);
	}

	function reconcileLiveAgentCompletions(): void {
		for (const [runDir, liveRun] of [...liveAgents.entries()]) {
			const states = new Map(
				getRunState(runDir, [...liveRun.keys()], {
					includeLineCounts: false,
					checkRpcPromptFailure: false,
				}).agents.map((agent) => [agent.id, agent]),
			);
			for (const agentId of [...liveRun.keys()]) {
				const state = states.get(agentId);
				if (!state) {
					removeLiveAgent(runDir, agentId);
					continue;
				}
				if (!isTerminalAgentStatus(state.status)) continue;
				removeLiveAgent(runDir, agentId);
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

	const handleAgentCompletion: AgentCompletionHandler = () => {
		refreshSubagentOverlay();
	};

	registerSubagentsTool(pi, liveAgents, handleAgentCompletion, refreshSubagentOverlay);
	registerCommands(pi);

	pi.on("session_start", async (_event, ctx) => {
		sawAutoUltraworkCandidate = false;
		currentSessionFile = sessionFileFromContext(ctx);
		subagentOverlay.restoreRunningAgents(ctx.cwd, currentSessionFile);
		refreshSubagentOverlay();
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
		if (!strategyPrompt && !visionPrompt) return undefined;
		let systemPrompt = event.systemPrompt ?? "";
		if (strategyPrompt) systemPrompt = appendAgentStrategyPrompt(systemPrompt, strategyPrompt);
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
		subagentOverlay.dispose();
		if (completionWatchTimer) {
			clearInterval(completionWatchTimer);
			completionWatchTimer = undefined;
		}
		if (event?.reason === "reload" || event?.reason === "fork") return;
		try {
			await cleanupProjectSubagentState(ctx.cwd, liveAgents);
			liveAgents.clear();
			refreshSubagentOverlay();
		} catch {
			// Shutdown cleanup is best-effort and must never block the main session from closing.
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

function startupSubagentPresetList(cwd = process.cwd()): string {
	try {
		const config = loadSubagentConfig(cwd);
		const presets = config.presets ?? {};
		const activePreset = getActiveSubagentPresetName();
		const names = sortedStartupPresetNames(Object.keys(presets), activePreset);
		if (names.length === 0) return "no presets";
		return names.map((name) => formatStartupPresetName(name, activePreset)).join(", ");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `error loading presets: ${message}`;
	}
}

function sortedStartupPresetNames(names: string[], activePreset?: string): string[] {
	const sorted = names.sort();
	return activePreset && sorted.includes(activePreset)
		? [activePreset, ...sorted.filter((name) => name !== activePreset)]
		: sorted;
}

function formatStartupPresetName(name: string, activePreset?: string): string {
	return activePreset === name ? underlineText(name) : name;
}

function underlineText(text: string): string {
	return `\x1b[4m${text}\x1b[24m`;
}

function publishSubagentPresetsStartupSection(): void {
	publishStartupSection({
		id: "async-subagents-presets",
		title: "sub-agent presets (/subagent-preset)",
		body: startupSubagentPresetList(),
	});
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
		: "If visual understanding is required, ask the user to switch to a vision-capable model or provide a path that can be inspected by a vision-capable helper.";
	const bridgeWarning = visionBridgeWarning(bridge);
	return [
		"Vision capability constraint:",
		attachmentWarning,
		"Do not claim to have viewed or understood image contents yourself.",
		bridgeWarning,
		delegation,
		bridge?.attachments.length
			? "Use those bridged paths exactly as imagePaths if delegating."
			: "If an image only arrived as an attachment and no local file path/reference is available to subagents, ask the user for a file path or to switch the parent model to one with image input support.",
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
		"Do not delegate to a vision sub-agent solely to gain visual access; use a vision sub-agent only when the user explicitly asks to delegate/parallelize or a separate visual review is useful.",
	].join(" ");
}

function visionSubagentDelegationText(attachments: BridgedImageAttachment[]): string {
	if (attachments.length === 0) {
		return "If visual understanding is required, delegate to the subagents tool with subagentType='vision' plus imagePaths/focus when the image is available as a local file path.";
	}
	const imagePaths = attachments.map((attachment) => attachment.relativePath);
	return `Attached images were saved for vision delegation. If visual understanding is required, delegate to the subagents tool with subagentType='vision' and imagePaths=${JSON.stringify(imagePaths)} plus a focused task/focus.`;
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

async function cleanupProjectSubagentState(cwd: string, liveAgents: Map<string, Map<string, LiveAgent>>): Promise<void> {
	const shutdownTargets = collectShutdownTargets(cwd, liveAgents);
	const signaled = signalShutdownTargets(shutdownTargets, "SIGTERM");
	if (signaled > 0) await sleep(SESSION_SHUTDOWN_KILL_GRACE_MS);
	signalShutdownTargets(shutdownTargets, "SIGKILL");

	const runDirs = listRunDirs(cwd);
	for (const runDir of runDirs) stopRunBestEffort(runDir, undefined, "SIGKILL");
	deleteRunDirs(runDirs);
	removeSubagentRunsFromRegistry(cwd, runDirs);
	removeEmptySubagentState(cwd);
}

function collectShutdownTargets(cwd: string, liveAgents: Map<string, Map<string, LiveAgent>>): ShutdownTarget[] {
	const targets = new Map<string, Set<string> | undefined>();
	for (const runDir of listRunDirs(cwd)) targets.set(runDir, undefined);
	for (const [runDir, liveRun] of liveAgents) {
		const existing = targets.get(runDir);
		if (existing === undefined && targets.has(runDir)) continue;
		targets.set(runDir, new Set(liveRun.keys()));
	}
	return [...targets].map(([runDir, agentIds]) => ({
		runDir,
		...(agentIds ? { agentIds: [...agentIds] } : {}),
	}));
}

function signalShutdownTargets(targets: ShutdownTarget[], signal: StopSignal): number {
	let signaled = 0;
	for (const target of targets) {
		try {
			const state = getRunState(target.runDir, target.agentIds);
			for (const agent of state.agents) {
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

function removeEmptySubagentState(cwd: string): void {
	removeImageAttachmentBridgeState(cwd);
	const registry = loadSubagentRegistry(cwd);
	if (Object.keys(registry.runs).length === 0 && Object.keys(registry.agents).length === 0) {
		fs.rmSync(getSubagentRegistryPath(cwd), { force: true });
	}
	try {
		fs.rmdirSync(getRunRoot(cwd));
	} catch {
		// Leave non-empty or concurrently used state intact.
	}
}
