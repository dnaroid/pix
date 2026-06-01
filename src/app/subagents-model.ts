import { basename, isAbsolute, join, resolve } from "node:path";
import {
	SUBAGENT_ACTIVE_STATUSES,
	SUBAGENT_RENDER_MODES,
	SUBAGENT_STATUSES,
	SUBAGENT_TERMINAL_STATUSES,
	SUBAGENTS_TOOL_NAME,
	SUBAGENTS_TOOL_NAME_PREFIX,
} from "./constants.js";
import type {
	SubagentActiveStatus,
	SubagentAgentState,
	SubagentsLiveStateEvent,
	SubagentRegistry,
	SubagentRegistryAgent,
	SubagentRegistryRun,
	SubagentRenderMode,
	SubagentRunRenderDetails,
	SubagentStatus,
	SubagentTaskPreview,
	SubagentTerminalStatus,
} from "./types.js";
import { isRecord, isStringArray } from "./guards.js";
import { APP_ICONS } from "./icons.js";
import { stripProviderFromModelRef } from "./model-ref.js";

export function isSubagentsToolName(toolName: string): boolean {
	return toolName === SUBAGENTS_TOOL_NAME || toolName.startsWith(SUBAGENTS_TOOL_NAME_PREFIX);
}

export function isSubagentStatus(value: unknown): value is SubagentStatus {
	return typeof value === "string" && SUBAGENT_STATUSES.includes(value as SubagentStatus);
}

export function isSubagentActiveStatus(value: SubagentStatus): value is SubagentActiveStatus {
	return SUBAGENT_ACTIVE_STATUSES.includes(value as SubagentActiveStatus);
}

export function isSubagentTerminalStatus(value: SubagentStatus): value is SubagentTerminalStatus {
	return SUBAGENT_TERMINAL_STATUSES.includes(value as SubagentTerminalStatus);
}

export function isSubagentRenderMode(value: unknown): value is SubagentRenderMode {
	return typeof value === "string" && SUBAGENT_RENDER_MODES.includes(value as SubagentRenderMode);
}

export function isSubagentAgentState(value: unknown): value is SubagentAgentState {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || !value.id.trim()) return false;
	if (!isSubagentStatus(value.status)) return false;
	if (value.exitCode !== undefined && typeof value.exitCode !== "number") return false;
	if (value.startedAt !== undefined && typeof value.startedAt !== "string") return false;
	if (value.finishedAt !== undefined && typeof value.finishedAt !== "string") return false;
	if (value.nextRetryAt !== undefined && typeof value.nextRetryAt !== "string") return false;
	if (value.pid !== undefined && typeof value.pid !== "number") return false;
	if (value.resultLines !== undefined && typeof value.resultLines !== "number") return false;
	if (value.stderrLines !== undefined && typeof value.stderrLines !== "number") return false;
	if (value.eventLines !== undefined && typeof value.eventLines !== "number") return false;
	if (value.retryCount !== undefined && typeof value.retryCount !== "number") return false;
	return true;
}

export function isSubagentTaskPreview(value: unknown): value is SubagentTaskPreview {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || !value.id.trim()) return false;
	if (value.task !== undefined && typeof value.task !== "string") return false;
	if (value.scope !== undefined && typeof value.scope !== "string") return false;
	if (value.model !== undefined && typeof value.model !== "string") return false;
	if (value.thinking !== undefined && typeof value.thinking !== "string") return false;
	if (value.thinkingLevel !== undefined && typeof value.thinkingLevel !== "string") return false;
	return true;
}

export function isSubagentRunRenderDetails(value: unknown): value is SubagentRunRenderDetails {
	if (!isRecord(value)) return false;
	if (typeof value.runDir !== "string" || !value.runDir.trim()) return false;
	if (!Array.isArray(value.agents) || !value.agents.every(isSubagentAgentState)) return false;
	if (value.tasks !== undefined && (!Array.isArray(value.tasks) || !value.tasks.every(isSubagentTaskPreview))) return false;
	if (value.mode !== undefined && !isSubagentRenderMode(value.mode)) return false;
	if (value.agentId !== undefined && typeof value.agentId !== "string") return false;
	if (value.state !== undefined && !isSubagentAgentState(value.state)) return false;
	return true;
}

export function isSubagentsLiveStateEvent(value: unknown): value is SubagentsLiveStateEvent {
	if (!isRecord(value)) return false;
	if (value.version !== 1) return false;
	if (typeof value.count !== "number" || !Number.isFinite(value.count)) return false;
	if (!Array.isArray(value.runs)) return false;
	if (value.sessionFile !== undefined && typeof value.sessionFile !== "string") return false;
	if (typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) return false;
	return value.runs.every((run) => {
		if (!isRecord(run)) return false;
		if (typeof run.runDir !== "string" || !run.runDir.trim()) return false;
		if (!Array.isArray(run.agents) || !run.agents.every(isSubagentAgentState)) return false;
		if (run.tasks !== undefined && (!Array.isArray(run.tasks) || !run.tasks.every(isSubagentTaskPreview))) return false;
		return true;
	});
}

export function isSubagentRegistryRun(runId: string, value: unknown): value is SubagentRegistryRun {
	void runId;
	if (!isRecord(value)) return false;
	if (typeof value.runId !== "string") return false;
	if (typeof value.runDir !== "string") return false;
	if (!isStringArray(value.agentIds)) return false;
	if (typeof value.createdAt !== "string") return false;
	if (typeof value.updatedAt !== "string") return false;
	return true;
}

export function isSubagentRegistryAgent(agentId: string, value: unknown): value is SubagentRegistryAgent {
	void agentId;
	if (!isRecord(value)) return false;
	if (typeof value.agentId !== "string") return false;
	if (typeof value.runId !== "string") return false;
	if (typeof value.runDir !== "string") return false;
	if (typeof value.updatedAt !== "string") return false;
	return true;
}

export function isSubagentRegistry(value: unknown): value is SubagentRegistry {
	if (!isRecord(value)) return false;
	if (value.version !== 1) return false;
	if (value.latestRunId !== undefined && typeof value.latestRunId !== "string") return false;
	if (value.latestRunDir !== undefined && typeof value.latestRunDir !== "string") return false;
	if (!isRecord(value.runs) || !isRecord(value.agents)) return false;
	return Object.entries(value.runs).every(([runId, run]) => isSubagentRegistryRun(runId, run))
		&& Object.entries(value.agents).every(([agentId, agent]) => isSubagentRegistryAgent(agentId, agent));
}

export function subagentStatusIcon(status: SubagentStatus): string {
	switch (status) {
		case "planned":
			return APP_ICONS.circleOutline;
		case "running":
			return APP_ICONS.timerSand;
		case "retrying":
			return APP_ICONS.refresh;
		case "done":
			return APP_ICONS.checkCircle;
		case "failed":
			return APP_ICONS.closeCircle;
		case "stopped":
			return APP_ICONS.stopCircle;
	}
}

export function formatSubagentsPanelStats(agents: readonly SubagentAgentState[]): string {
	const stats = [
		{ count: agents.filter((agent) => agent.status === "planned").length, label: "planned" },
		{ count: agents.filter((agent) => agent.status === "running").length, label: "running" },
		{ count: agents.filter((agent) => agent.status === "retrying").length, label: "retrying" },
	]
		.filter(({ count }) => count > 0)
		.map(({ count, label }) => `${count} ${label}`);

	return stats.join(", ");
}

export function subagentModelThinkingLabel(preview: SubagentTaskPreview | undefined): string {
	const rawModel = preview?.model?.trim();
	const model = rawModel ? stripProviderFromModelRef(rawModel) : "model:unknown";
	const thinking = preview?.thinking?.trim() || preview?.thinkingLevel?.trim();
	if (!thinking || model.endsWith(`:${thinking}`)) return model;
	return `${model}:${thinking}`;
}

export function activeSubagentStates(agents: readonly SubagentAgentState[]): SubagentAgentState[] {
	return agents.filter((agent) => isSubagentActiveStatus(agent.status));
}

export function allSubagentStatesTerminal(agents: readonly SubagentAgentState[]): boolean {
	return agents.length > 0 && agents.every((agent) => isSubagentTerminalStatus(agent.status));
}

export function taskPreviewMap(tasks: readonly SubagentTaskPreview[] | undefined): Map<string, SubagentTaskPreview> {
	return new Map((tasks ?? []).map((task) => [task.id, task]));
}

export function formatSubagentTimestamp(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const time = Date.parse(value);
	if (!Number.isFinite(time)) return value;
	return new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatElapsedSince(value: string | undefined, now = Date.now()): string {
	if (!value) return "elapsed:—";
	const started = Date.parse(value);
	if (!Number.isFinite(started)) return "elapsed:—";
	const seconds = Math.max(0, Math.floor((now - started) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m${remainingSeconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h${remainingMinutes.toString().padStart(2, "0")}m`;
}

export function subagentRunName(runDir: string): string {
	return basename(runDir) || runDir;
}

export function resolveSubagentRunDir(cwd: string, runDir: string): string {
	return resolve(isAbsolute(runDir) ? runDir : join(cwd, runDir));
}
