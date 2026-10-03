import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";

export const RPC_SESSION_STATE_WIDGET_KEY = "pix.session-state";
export const PIX_SESSION_STATE_METHOD = "pix/session-state";
export const PIX_CONTEXT_USAGE_CHANNEL = "context-usage";
export const PIX_DCP_TOKENS_SAVED_CHANNEL = "dcp-tokens-saved";
export const PIX_DCP_CONTEXT_MAP_CHANNEL = "dcp-context-map";
/** Pushed Anthropic API-key response-header usage (parsed, no network refresh). */
export const PIX_MODEL_USAGE_CHANNEL = "model-usage";
/** Direct ACP-owned persistent council snapshots, scoped to the orchestrator. */
export const PIX_BRAINSTORM_CHANNEL = "pi-tools-suite:brainstorm:state";

export interface SessionStateEnvelope {
	readonly channel: string;
	readonly data: unknown;
}

export interface PixSessionStateNotification extends SessionStateEnvelope {
	readonly sessionId: string;
	readonly activityOwner?: string;
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
