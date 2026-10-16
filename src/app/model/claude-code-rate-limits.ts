import type { ModelUsageLimitWindow, ModelUsageStatus } from "./model-usage-status.js";

export const CLAUDE_CODE_RATE_LIMIT_EVENT = "pix:claude-code:rate-limit";
export const CLAUDE_CODE_USAGE_CHANNEL = "claude-code-usage";

export interface ClaudeCodeRateLimitSample {
	version: 1;
	sessionId: string;
	modelRef: string;
	status: "allowed" | "allowed_warning" | "rejected";
	rateLimitType: "five_hour" | "seven_day";
	utilization?: number;
	resetsAt: number;
	observedAt: number;
	resetPrecision?: "minute";
}

export function parseClaudeCodeRateLimitSample(value: unknown, now = Date.now()): ClaudeCodeRateLimitSample | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const sample = value as Record<string, unknown>;
	if (sample.version !== 1 || typeof sample.sessionId !== "string" || !sample.sessionId
		|| typeof sample.modelRef !== "string" || !/^pi-claude-code-provider\/.+$/u.test(sample.modelRef)
		|| !["allowed", "allowed_warning", "rejected"].includes(String(sample.status))
		|| !["five_hour", "seven_day"].includes(String(sample.rateLimitType))
		|| typeof sample.resetsAt !== "number" || !Number.isFinite(sample.resetsAt) || sample.resetsAt <= now
		|| typeof sample.observedAt !== "number" || !Number.isFinite(sample.observedAt) || sample.observedAt > now
		|| (sample.utilization !== undefined && (typeof sample.utilization !== "number"
			|| !Number.isFinite(sample.utilization) || sample.utilization < 0 || sample.utilization > 1))
		|| (sample.status !== "rejected" && sample.utilization === undefined)) return undefined;
	if (sample.resetPrecision !== undefined && sample.resetPrecision !== "minute") return undefined;
	return { version: 1, sessionId: sample.sessionId, modelRef: sample.modelRef,
		status: sample.status as ClaudeCodeRateLimitSample["status"],
		rateLimitType: sample.rateLimitType as ClaudeCodeRateLimitSample["rateLimitType"],
		resetsAt: sample.resetsAt, observedAt: sample.observedAt,
		...(sample.resetPrecision === "minute" ? { resetPrecision: "minute" as const } : {}),
		...(typeof sample.utilization === "number" ? { utilization: sample.utilization } : {}) };
}

/** Session/model-owned telemetry; never parses localized warning text or performs I/O. */
export class ClaudeCodeRateLimitCache {
	private readonly samples = new Map<string, Map<ClaudeCodeRateLimitSample["rateLimitType"], ClaudeCodeRateLimitSample>>();

	observe(value: unknown, now = Date.now()): ClaudeCodeRateLimitSample | undefined {
		const sample = parseClaudeCodeRateLimitSample(value, now);
		if (!sample) return undefined;
		const key = `${sample.sessionId}\0${sample.modelRef}`;
		const windows = this.samples.get(key) ?? new Map();
		const previous = windows.get(sample.rateLimitType);
		const sameReset = previous && Math.abs(previous.resetsAt - sample.resetsAt)
			<= (previous.resetPrecision === "minute" || sample.resetPrecision === "minute" ? 59_999 : 999);
		if (previous && (previous.observedAt > sample.observedAt || (!sameReset && previous.resetsAt > sample.resetsAt))) return undefined;
		windows.set(sample.rateLimitType, sameReset ? {
			...sample,
			status: previous.status === "rejected" ? "rejected" : sample.status,
			utilization: Math.max(previous.utilization ?? 0, sample.utilization ?? 0),
		} : sample);
		this.samples.set(key, windows);
		return sample;
	}

	merge(previous: ModelUsageStatus | undefined, sessionId: string, modelKey: string, now = Date.now()): ModelUsageStatus | undefined {
		const key = `${sessionId}\0${modelKey}`;
		const windows = this.samples.get(key);
		if (!windows) return previous;
		let status = previous?.modelKey === modelKey ? previous : undefined;
		for (const [type, sample] of windows) {
			const field = type === "five_hour" ? "hourly" : "weekly";
			const baseline = status?.[field];
			// CLI resets have whole-second precision; OAuth can include fractions.
			const tolerance = sample.resetPrecision === "minute" ? 59_999 : 999;
			if (sample.resetsAt <= now || (baseline && !baseline.resetAtEstimated && baseline.resetAt > sample.resetsAt + tolerance)) {
				windows.delete(type);
				continue;
			}
			const remaining = sample.status === "rejected" ? 0 : (1 - sample.utilization!) * 100;
			const window: ModelUsageLimitWindow = {
				remainingPercent: baseline && Math.abs(baseline.resetAt - sample.resetsAt) <= tolerance ? Math.min(baseline.remainingPercent, remaining) : remaining,
				resetAt: sample.resetsAt,
				windowSeconds: type === "five_hour" ? 5 * 3600 : 7 * 86400,
				hasKnownWindowDuration: true,
			};
			status = { ...status, provider: "anthropic", modelKey, updatedAt: Math.max(status?.updatedAt ?? 0, sample.observedAt), [field]: window };
		}
		if (!windows.size) this.samples.delete(key);
		return status ?? previous;
	}

	forget(sessionId: string): void {
		for (const key of this.samples.keys()) if (key.startsWith(`${sessionId}\0`)) this.samples.delete(key);
	}

	clear(): void { this.samples.clear(); }
}
