import type { AgentState, RunState } from "./lib.js";
import { getRunState } from "./lib.js";
import { DEFAULT_SPAWN_WATCH_SECONDS, DEFAULT_UPDATE_INTERVAL_SECONDS, MAX_WATCH_SECONDS } from "./constants.js";
import { renderPlainRunSummary } from "./render.js";
import type { SubagentRunRenderDetails, TextToolUpdate } from "./types.js";

function isTerminalAgent(agent: AgentState): boolean {
	return agent.status === "done" || agent.status === "failed" || agent.status === "stopped";
}

function isRunTerminal(state: RunState, failFast: boolean): boolean {
	if (state.agents.length === 0) return true;
	if (failFast && state.agents.some((agent) => agent.status === "failed" || agent.status === "stopped")) return true;
	return state.agents.every(isTerminalAgent);
}

export function clampWatchSeconds(value: unknown, fallback = DEFAULT_SPAWN_WATCH_SECONDS): number {
	const seconds = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.max(0, Math.min(MAX_WATCH_SECONDS, seconds));
}

function emitRunUpdate(
	onUpdate: ((partialResult: TextToolUpdate) => void) | undefined,
	details: SubagentRunRenderDetails,
): void {
	onUpdate?.({
		content: [{ type: "text", text: renderPlainRunSummary(details) }],
		details,
	});
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted) return;
	await new Promise<void>((resolve) => {
		let timeout: NodeJS.Timeout | undefined;
		const abort = () => {
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		timeout = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export async function pollRunWithUpdates(
	runDir: string,
	agentIds: string[] | undefined,
	options: {
		mode: SubagentRunRenderDetails["mode"];
		tasks?: SubagentRunRenderDetails["tasks"];
		timeoutSeconds: number;
		intervalSeconds?: number;
		failFast?: boolean;
		signal?: AbortSignal;
		onUpdate?: (partialResult: TextToolUpdate) => void;
	},
): Promise<RunState> {
	const start = Date.now();
	const intervalMs = Math.max(250, (options.intervalSeconds ?? DEFAULT_UPDATE_INTERVAL_SECONDS) * 1000);
	const timeoutMs = Math.max(0, options.timeoutSeconds * 1000);
	let state = getRunState(runDir, agentIds);

	while (true) {
		state = getRunState(runDir, agentIds);
		emitRunUpdate(options.onUpdate, {
			runDir,
			agents: state.agents,
			tasks: options.tasks,
			mode: options.mode,
		});

		if (isRunTerminal(state, options.failFast ?? false)) return state;
		if (options.signal?.aborted) return state;
		const elapsedMs = Date.now() - start;
		if (elapsedMs >= timeoutMs) return state;

		await sleepWithAbort(Math.min(intervalMs, timeoutMs - elapsedMs), options.signal);
	}
}
