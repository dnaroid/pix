import type { StopReason } from "@agentclientprotocol/sdk";
import type { SessionStateNotification } from "./session-state";

export const AGENT_CONTROL_CHANNEL = "agent-control";

export type AgentControlAction = "state" | "pause" | "cancel-pause" | "continue";
export type AgentControlState = "idle" | "running" | "pause-requested" | "paused" | "resuming" | "continuable";

export function isAgentControlState(value: unknown): value is AgentControlState {
  return value === "idle"
    || value === "running"
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

export function isStopReason(value: unknown): value is StopReason {
  return value === "end_turn"
    || value === "max_tokens"
    || value === "max_turn_requests"
    || value === "refusal"
    || value === "cancelled";
}

/** Only a live adopted-run settlement carries a reason, never state rehydration. */
export function agentControlStopReasonFromSessionState(notification: SessionStateNotification): StopReason | undefined {
  if (!agentControlStateFromSessionState(notification) || !isRecord(notification.data)) return undefined;
  return isStopReason(notification.data.stopReason) ? notification.data.stopReason : undefined;
}

/** Loaded paused transcripts rehydrate as continuable; both need the pause tab glyph. */
export function agentControlShowsPausedTab(state: AgentControlState): boolean {
  return state === "paused" || state === "continuable";
}

export function agentPauseJustTriggered(
  previous: { sessionId: string | null; state: AgentControlState } | undefined,
  current: { sessionId: string | null; state: AgentControlState },
): boolean {
  return previous !== undefined
    && current.sessionId !== null
    && previous.sessionId === current.sessionId
    && previous.state !== "paused"
    && current.state === "paused";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
