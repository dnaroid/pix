/** Reserved RPC widget key consumed by Pix ACP as a structured event envelope. */
export const RPC_SESSION_STATE_WIDGET_KEY = "pix.session-state";
export const RPC_SESSION_STATE_ENV = "PIX_ACP_SESSION_STATE_BRIDGE";

export interface RpcSessionStateContext {
	readonly mode?: unknown;
	readonly ui?: {
		setWidget?: (key: string, lines: string[] | undefined) => void;
	};
}

/**
 * Publish structured extension state through pi's supported RPC UI protocol.
 *
 * TUI/print/json modes keep using their native event consumers. Serialization
 * is best-effort so an optional external UI can never break the source tool.
 */
export function publishRpcSessionState(
	ctx: RpcSessionStateContext | undefined,
	channel: string,
	data: unknown,
): void {
	if (
		process.env[RPC_SESSION_STATE_ENV] !== "1"
		|| ctx?.mode !== "rpc"
		|| !ctx.ui?.setWidget
		|| !channel.trim()
	) return;
	try {
		ctx.ui.setWidget(RPC_SESSION_STATE_WIDGET_KEY, [channel, JSON.stringify(data)]);
	} catch {
		// The event bus remains authoritative when RPC UI transport is absent.
	}
}
