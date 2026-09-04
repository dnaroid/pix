import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";

export const RPC_SESSION_STATE_WIDGET_KEY = "pix.session-state";
export const PIX_SESSION_STATE_METHOD = "pix/session-state";

export interface SessionStateEnvelope {
	readonly channel: string;
	readonly data: unknown;
}

export interface PixSessionStateNotification extends SessionStateEnvelope {
	readonly sessionId: string;
}

/** Decode the private structured-state convention carried by RPC setWidget. */
export function sessionStateEnvelopeFromUiRequest(
	request: RpcExtensionUIRequest,
): SessionStateEnvelope | undefined {
	if (
		request.method !== "setWidget"
		|| request.widgetKey !== RPC_SESSION_STATE_WIDGET_KEY
		|| request.widgetLines?.length !== 2
	) return undefined;

	const [channel, serialized] = request.widgetLines;
	if (!channel?.trim() || serialized === undefined) return undefined;
	try {
		return { channel, data: JSON.parse(serialized) as unknown };
	} catch {
		return undefined;
	}
}
