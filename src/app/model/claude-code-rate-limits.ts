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

const CLAUDE_CODE_ROUTE = /^pi-claude-code-provider\/.+$/u;

export function parseClaudeCodeRateLimitSample(value: unknown, now = Date.now()): ClaudeCodeRateLimitSample | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const sample = value as Record<string, unknown>;
	if (sample.version !== 1 || typeof sample.sessionId !== "string" || !sample.sessionId
		|| typeof sample.modelRef !== "string" || !CLAUDE_CODE_ROUTE.test(sample.modelRef)
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

/**
 * Account-wide telemetry: Claude Code quota belongs to the subscription, not to
 * the session or model route that happened to observe it, so a sample from any
 * session updates every Claude Code route. Assumes one Claude Code account per
 * process (account rotation disabled). Never parses localized warning text or
 * performs I/O. Bounded to one sample per window; expired windows drop on merge.
 */
export class ClaudeCodeRateLimitCache {
	private readonly samples = new Map<ClaudeCodeRateLimitSample["rateLimitType"], ClaudeCodeRateLimitSample>();

	observe(value: unknown, now = Date.now()): ClaudeCodeRateLimitSample | undefined {
		const sample = parseClaudeCodeRateLimitSample(value, now);
		if (!sample) return undefined;
		const previous = this.samples.get(sample.rateLimitType);
		const sameReset = previous && Math.abs(previous.resetsAt - sample.resetsAt)
			<= (previous.resetPrecision === "minute" || sample.resetPrecision === "minute" ? 59_999 : 999);
		if (previous && (previous.observedAt > sample.observedAt || (!sameReset && previous.resetsAt > sample.resetsAt))) return undefined;
		this.samples.set(sample.rateLimitType, sameReset ? {
			...sample,
			status: previous.status === "rejected" ? "rejected" : sample.status,
			utilization: Math.max(previous.utilization ?? 0, sample.utilization ?? 0),
		} : sample);
		return sample;
	}

	/** Overlay account samples on `previous` for a Claude Code route; other routes pass through. */
	merge(previous: ModelUsageStatus | undefined, modelKey: string, now = Date.now()): ModelUsageStatus | undefined {
		if (!CLAUDE_CODE_ROUTE.test(modelKey) || !this.samples.size) return previous;
		let status = previous?.modelKey === modelKey ? previous : undefined;
		for (const [type, sample] of this.samples) {
			const field = type === "five_hour" ? "hourly" : "weekly";
			const baseline = status?.[field];
			// CLI resets have whole-second precision; OAuth can include fractions.
			const tolerance = sample.resetPrecision === "minute" ? 59_999 : 999;
			if (sample.resetsAt <= now || (baseline && !baseline.resetAtEstimated && baseline.resetAt > sample.resetsAt + tolerance)) {
				this.samples.delete(type);
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
		return status ?? previous;
	}

	clear(): void { this.samples.clear(); }
}
