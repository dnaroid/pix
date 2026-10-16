import type { DesktopModelUsageStatus } from "./desktop-commands.js";

export const CLAUDE_CODE_RATE_LIMIT_EVENT = "pix:claude-code:rate-limit";
export const CLAUDE_CODE_USAGE_CHANNEL = "claude-code-usage";

interface RateLimitSample { sessionId: string; modelRef: string; }
export interface ClaudeCodeRateLimitCache {
	observe(value: unknown): RateLimitSample | undefined;
	/** Account-wide: samples from any session apply to every Claude Code route. */
	merge(previous: DesktopModelUsageStatus | undefined, modelKey: string): DesktopModelUsageStatus | undefined;
	clear(): void;
}

/** Reuse the same parser/merge policy as the TUI, from Pix's root build. */
export async function loadClaudeCodeRateLimitCache(): Promise<ClaudeCodeRateLimitCache> {
	const url = new URL("../../../dist/app/model/claude-code-rate-limits.js", import.meta.url).href;
	const module = await import(url) as { ClaudeCodeRateLimitCache: new () => ClaudeCodeRateLimitCache };
	return new module.ClaudeCodeRateLimitCache();
}
