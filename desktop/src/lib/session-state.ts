export const PIX_SESSION_STATE_METHOD = "pix/session-state";
export const PIX_CONTEXT_USAGE_CHANNEL = "context-usage";
export const PIX_DCP_TOKENS_SAVED_CHANNEL = "dcp-tokens-saved";
export const PIX_DCP_CONTEXT_MAP_CHANNEL = "dcp-context-map";

export interface SessionStateNotification {
  readonly sessionId: string;
  readonly channel: string;
  readonly data: unknown;
  readonly activityOwner?: string;
}

export function parseSessionStateNotification(value: unknown): SessionStateNotification | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.sessionId !== "string" || !value.sessionId.trim()) return undefined;
  if (typeof value.channel !== "string" || !value.channel.trim()) return undefined;
  return { sessionId: value.sessionId, channel: value.channel, data: value.data,
    ...(typeof value.activityOwner === "string" ? { activityOwner: value.activityOwner } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
