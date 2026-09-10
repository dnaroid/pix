import type { SessionStateNotification } from "./session-state";

export const AGENT_CONTROL_CHANNEL = "agent-control";

export type AgentControlAction = "state" | "pause" | "continue";
export type AgentControlState = "idle" | "pause-requested" | "paused" | "resuming" | "continuable";

export function isAgentControlState(value: unknown): value is AgentControlState {
  return value === "idle"
    || value === "pause-requested"
    || value === "paused"
    || value === "resuming"
    || value === "continuable";
}

export function agentControlStateFromSessionState(
  notification: SessionStateNotification,
): AgentControlState | undefined {
  if (notification.channel !== AGENT_CONTROL_CHANNEL || !isRecord(notification.data)) return undefined;
  return isAgentControlState(notification.data.state) ? notification.data.state : undefined;
}

export function agentControlAllowsAutoQueue(state: AgentControlState | undefined): boolean {
  return (state ?? "idle") === "idle";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
