import type { AgentState } from "./types.js";
import { plural, statusLabel } from "../format.js";

export interface AgentCompletionNotificationOptions {
	agentId: string;
	runDir: string;
	state: AgentState;
	runAgents: AgentState[];
}

export interface AgentCompletionNotification {
	customType: "async-subagents-agent-completion";
	content: string;
	display: true;
	details: {
		agentId: string;
		runDir: string;
		status: AgentState["status"];
		exitCode?: number;
		remainingAgentIds: string[];
	};
}

export function buildAgentCompletionNotification(options: AgentCompletionNotificationOptions): AgentCompletionNotification {
	const remaining = options.runAgents.filter((agent) => agent.id !== options.agentId && !isTerminalAgentStatus(agent.status));
	const remainingSummary = remaining.length > 0
		? `${plural(remaining.length, "other sub-agent")} still active: ${remaining.map((agent) => `${agent.id} (${statusLabel(agent.status)})`).join(", ")}.`
		: "No other sub-agents are active in this run.";
	const exitCode = typeof options.state.exitCode === "number" ? `, exitCode=${options.state.exitCode}` : "";
	const content = [
		`Background sub-agent ${options.agentId} finished with status ${statusLabel(options.state.status)}${exitCode}.`,
		remainingSummary,
		`Use subagents({ action: "result", agentId: "${options.agentId}", runDir: "${options.runDir}" }) to collect its result.`,
		remaining.length > 0
			? "Do not poll for the remaining agents unless the user explicitly needs interim status; wait for their completion notifications."
			: "All known agents in this run are now terminal; collect any remaining results needed for the parent task.",
	].join("\n");

	return {
		customType: "async-subagents-agent-completion",
		content,
		display: true,
		details: {
			agentId: options.agentId,
			runDir: options.runDir,
			status: options.state.status,
			...(typeof options.state.exitCode === "number" ? { exitCode: options.state.exitCode } : {}),
			remainingAgentIds: remaining.map((agent) => agent.id),
		},
	};
}

export function isTerminalAgentStatus(status: AgentState["status"]): boolean {
	return status === "done" || status === "failed" || status === "stopped";
}
