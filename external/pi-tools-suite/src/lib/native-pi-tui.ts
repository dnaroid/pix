import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PIX_HOST_RUNTIME_SYMBOL = Symbol.for("pix.host.runtime");

type PixHostGlobal = typeof globalThis & {
	[PIX_HOST_RUNTIME_SYMBOL]?: boolean;
};

/**
 * Pix loads pi-tools-suite in-process for its TUI and through a Pix-owned RPC
 * subprocess for Desktop. Native pi widgets must never render in either host:
 * Pix owns presentation there and already consumes the suite's structured state.
 */
export function isPixOwnedHost(
	env: NodeJS.ProcessEnv = process.env,
	globalObject: PixHostGlobal = globalThis as PixHostGlobal,
): boolean {
	if (globalObject[PIX_HOST_RUNTIME_SYMBOL] === true) return true;
	return env.PIX_ACP_SESSION_STATE_BRIDGE === "1"
		|| env.PIX_QUESTION_RPC_BRIDGE === "1"
		|| env.PIX_CONFIG_PROFILE?.trim().toLowerCase() === "desktop";
}

export function isNativePiTui(
	ctx: Pick<ExtensionContext, "mode" | "hasUI">,
): boolean {
	return ctx.mode === "tui" && ctx.hasUI === true && !isPixOwnedHost();
}
