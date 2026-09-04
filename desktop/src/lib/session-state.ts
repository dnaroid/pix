export const PIX_SESSION_STATE_METHOD = "pix/session-state";

export interface SessionStateNotification {
  readonly sessionId: string;
  readonly channel: string;
  readonly data: unknown;
}

export function parseSessionStateNotification(value: unknown): SessionStateNotification | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.sessionId !== "string" || !value.sessionId.trim()) return undefined;
  if (typeof value.channel !== "string" || !value.channel.trim()) return undefined;
  return { sessionId: value.sessionId, channel: value.channel, data: value.data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
