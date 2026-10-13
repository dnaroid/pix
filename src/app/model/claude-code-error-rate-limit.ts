import type { ClaudeCodeRateLimitSample } from "./claude-code-rate-limits.js";

/** Narrow fallback for Claude CLI's terminal subscription rejection, not generic 429s. */
export function claudeCodeErrorRateLimit(message: {
	role: string; provider?: string; model?: string; stopReason?: string; errorMessage?: string;
}, sessionId: string, now = Date.now()): ClaudeCodeRateLimitSample | undefined {
	if (message.role !== "assistant" || message.provider !== "pi-claude-code-provider"
		|| !message.model || message.stopReason !== "error") return undefined;
	const match = /^Claude Code request failed \(429\): You've hit your session limit · resets (\d{1,2})(?::(\d{2}))?(am|pm) \(([^()\r\n]+)\)$/u.exec(message.errorMessage ?? "");
	if (!match) return undefined;
	const hour = Number(match[1]), minute = Number(match[2] ?? 0);
	if (hour < 1 || hour > 12 || minute > 59) return undefined;
	const resetsAt = nextReset(hour % 12 + (match[3] === "pm" ? 12 : 0), minute, match[4]!, now);
	if (resetsAt === undefined) return undefined;
	return { version: 1, sessionId, modelRef: `${message.provider}/${message.model}`,
		status: "rejected", rateLimitType: "five_hour", resetsAt, observedAt: now, resetPrecision: "minute" };
}

function nextReset(hour: number, minute: number, timeZone: string, now: number): number | undefined {
	try {
		const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit",
			day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
		const wallTime = (time: number): number => {
			const parts = Object.fromEntries(format.formatToParts(time).map((part) => [part.type, part.value]));
			return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
				Number(parts.hour), Number(parts.minute), Number(parts.second));
		};
		const today = new Date(wallTime(now));
		const candidates = new Set<number>();
		for (const day of [0, 1]) {
			const target = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, hour, minute);
			// Both sides of a DST transition: validate candidates rather than guessing an offset.
			for (const delta of [-86400_000, 0, 86400_000]) {
				const probe = target + delta;
				const candidate = target - (wallTime(probe) - probe);
				if (candidate > now && candidate - now <= 5 * 3600_000 && wallTime(candidate) === target) candidates.add(candidate);
			}
		}
		// An ambiguous fall-back clock time is not reliable quota evidence.
		return candidates.size === 1 ? [...candidates][0] : undefined;
	} catch { return undefined; }
}
