import type { AgentState } from "./types.js";

/**
 * Returns true if the agent status represents a terminal (no-longer-active) state.
 */
export function isTerminalAgentStatus(status: AgentState["status"]): boolean {
	return status === "done" || status === "failed" || status === "stopped";
}

interface AgentCompletionNotificationInput {
	agentId: string;
	runDir: string;
	state: AgentState;
	runAgents: AgentState[];
}

/**
 * Builds a custom notification for a completed sub-agent, including information
 * about remaining active agents.
 */
export function buildAgentCompletionNotification(input: AgentCompletionNotificationInput) {
	const { agentId, runDir, state, runAgents } = input;

	const remainingActive = runAgents.filter(
		(a) => a.id !== agentId && !isTerminalAgentStatus(a.status),
	);

	const statusLabel = (s: AgentState["status"]): string =>
		s === "running" ? "in progress" : s;

	const lines: string[] = [];
	lines.push(
		`Background sub-agent ${agentId} finished with status ${state.status}, exitCode=${state.exitCode ?? "n/a"}.`,
	);

	if (remainingActive.length > 0) {
		const remainingDesc = remainingActive
			.map((a) => `${a.id} (${statusLabel(a.status)})`)
			.join(", ");
		lines.push(
			`${remainingActive.length} other sub-agent${remainingActive.length > 1 ? "s" : ""} still active: ${remainingDesc}.`,
		);
	} else {
		lines.push("All other sub-agents have finished.");
	}

	lines.push(
		`To retrieve the result: subagents({ action: "result", agentId: "${agentId}", runDir: "${runDir}" })`,
	);
	lines.push("Do not poll for the remaining agents; you will receive a notification when each finishes.");

	return {
		customType: "async-subagents-agent-completion",
		display: true,
		details: {
			agentId,
			runDir,
			status: state.status,
			exitCode: state.exitCode,
			remainingAgentIds: remainingActive.map((a) => a.id),
		},
		content: lines.join("\n"),
	};
}
