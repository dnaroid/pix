import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export const DESKTOP_OBSERVER_PREFERENCE = "pix-desktop-observer-enabled";

export function isDesktopObserver(ctx: Pick<ExtensionContext, "mode">): boolean {
	return ctx.mode === "rpc" && process.env.PIX_ACP_SESSION_STATE_BRIDGE === "1";
}

/** Session-owned preference, not conversation context or a branch-specific setting. */
export function desktopObserverPreference(entries: readonly SessionEntry[]): boolean | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || entry.type !== "custom" || entry.customType !== DESKTOP_OBSERVER_PREFERENCE) continue;
		const data = entry.data as { version?: unknown; enabled?: unknown } | null;
		if (data?.version === 1 && typeof data.enabled === "boolean") return data.enabled;
	}
	return undefined;
}
