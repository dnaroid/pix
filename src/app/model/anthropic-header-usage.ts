import type { ModelUsageLimitWindow, ModelUsageStatus } from "./model-usage-status.js";

/**
 * Anthropic Messages response-header usage (API-key sessions).
 *
 * API-key-authenticated Messages responses describe the per-minute service
 * limits through `anthropic-ratelimit-*` headers (mirrored under the
 * standardized `x-ratelimit-*` names) for up to four buckets: requests,
 * tokens, input tokens, and output tokens. A bucket is only usable when it is
 * COMPLETE: numeric limit/remaining counts plus a parseable reset instant for
 * that same bucket. The header view reports the SINGLE most limiting bucket —
 * the one closest to exhaustion — selected among complete buckets only, so a
 * bucket whose reset is missing or unparseable can never displace a complete
 * one (substituting `now` for a missing reset would fabricate a zero-length
 * countdown), and no status is produced at all when every bucket is
 * incomplete. The window duration is not announced by the headers and is
 * never fabricated (`hasKnownWindowDuration: false`).
 *
 * OAuth (Claude Pro/Max, `sk-ant-oat`) sessions are NOT served from these
 * headers: their binding constraint is the subscription quota, which the
 * existing `api/oauth/usage` endpoint reports. Subscription-shaped
 * `anthropic-ratelimit-unified-*` headers are speculative and are neither
 * forwarded nor parsed; the controller drops header samples entirely for
 * OAuth sessions (see `resolveAnthropicAuthKind`).
 *
 * Headers arrive per provider response, so captured statuses are owned by the
 * session/model that produced them; nothing is inferred for other models.
 */

export const MODEL_USAGE_RESPONSE_HEADERS_EVENT = "pix:model-usage:response-headers";

const ANTHROPIC_RATE_LIMIT_HEADER_PREFIX = "anthropic-ratelimit-";
const ANTHROPIC_UNIFIED_HEADER_PREFIX = "anthropic-ratelimit-unified-";
const X_RATE_LIMIT_HEADER_PREFIX = "x-ratelimit-";

/** Header families, in tie-break order when two buckets are equally limiting. */
const RATE_LIMIT_HEADER_FAMILIES = [
	{ family: "requests", label: "RPM" },
	{ family: "tokens", label: "TPM" },
	{ family: "input-tokens", label: "ITPM" },
	{ family: "output-tokens", label: "OTPM" },
] as const;

export interface ModelUsageResponseHeadersPayload {
	readonly version: 1;
	readonly sessionId: string;
	readonly modelRef: string;
	readonly status: number;
	readonly headers: Record<string, string>;
}

export function parseModelUsageResponseHeadersPayload(value: unknown): ModelUsageResponseHeadersPayload | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.version !== 1) return undefined;
	if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return undefined;
	if (typeof record.modelRef !== "string" || record.modelRef.length === 0) return undefined;
	if (typeof record.status !== "number" || !Number.isFinite(record.status)) return undefined;
	if (typeof record.headers !== "object" || record.headers === null || Array.isArray(record.headers)) return undefined;
	const headers: Record<string, string> = {};
	for (const [name, headerValue] of Object.entries(record.headers as Record<string, unknown>)) {
		if (typeof headerValue !== "string") continue;
		headers[name.toLowerCase()] = headerValue;
	}
	if (Object.keys(headers).length === 0) return undefined;
	return {
		version: 1,
		sessionId: record.sessionId,
		modelRef: record.modelRef,
		status: record.status,
		headers,
	};
}

/**
 * Extract the Anthropic API-key rate-limit header subset from a raw provider
 * response. Provider transports already deliver lowercase names; matching
 * stays case-insensitive for safety. Unrelated headers — and the speculative
 * OAuth `unified` quota headers — never reach the app bus.
 */
export function pickAnthropicRateLimitHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	if (!headers) return {};
	const picked: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value !== "string") continue;
		const lowerName = name.toLowerCase();
		if (lowerName.startsWith(ANTHROPIC_UNIFIED_HEADER_PREFIX)) continue;
		if (lowerName.startsWith(ANTHROPIC_RATE_LIMIT_HEADER_PREFIX) || lowerName.startsWith(X_RATE_LIMIT_HEADER_PREFIX)) {
			picked[lowerName] = value;
		}
	}
	return picked;
}

export function anthropicUsageStatusFromResponseHeaders(
	headers: Record<string, string>,
	modelKey: string,
	now = Date.now(),
): ModelUsageStatus | undefined {
	const rateWindows = RATE_LIMIT_HEADER_FAMILIES
		.map(({ family, label }) => anthropicRateWindowFromHeaders(headers, family, label, now))
		.filter((window): window is AnthropicHeaderRateWindow => window !== undefined);
	if (rateWindows.length === 0) return undefined;

	return {
		modelKey,
		provider: "anthropic",
		updatedAt: now,
		// Exactly one window: the most limiting COMPLETE bucket. The per-minute
		// buckets refill on the same cadence, so the closest-to-exhaustion one
		// is the binding constraint for the next request.
		rateWindows: [mostLimitingWindow(rateWindows)],
	};
}

type AnthropicHeaderRateWindow = ModelUsageLimitWindow & { readonly remainingRatio: number };

function anthropicRateWindowFromHeaders(
	headers: Record<string, string>,
	family: string,
	label: string,
	now: number,
): AnthropicHeaderRateWindow | undefined {
	const limit = readHeaderNumber(headers, `anthropic-ratelimit-${family}-limit`, `x-ratelimit-limit-${family}`);
	const remaining = readHeaderNumber(headers, `anthropic-ratelimit-${family}-remaining`, `x-ratelimit-remaining-${family}`);
	// A missing/zero limit says nothing about the ratio; a missing remaining
	// count cannot be turned into a percentage either.
	if (limit === undefined || limit <= 0 || remaining === undefined) return undefined;

	const resetAt = parseResetHeaderValue(
		readHeader(headers, `anthropic-ratelimit-${family}-reset`, `x-ratelimit-reset-${family}`),
		now,
	);
	// A bucket whose reset instant is missing or unparseable is incomplete: it
	// can neither be selected nor displace a complete bucket, because the
	// headers' remaining/limit ratio would then be shown with a fabricated
	// "resets now" countdown. When every bucket is incomplete, the caller
	// produces no status at all.
	if (resetAt === undefined) return undefined;

	return {
		remainingRatio: remaining / limit,
		remainingPercent: clampPercent(Math.round((remaining / limit) * 100)),
		resetAt,
		windowSeconds: Math.max(0, Math.round((resetAt - now) / 1000)),
		// The headers never state how long the window lasts; only the reset
		// instant is known.
		hasKnownWindowDuration: false,
		label,
	};
}

function mostLimitingWindow(windows: readonly AnthropicHeaderRateWindow[]): ModelUsageLimitWindow {
	// Compare exact ratios (not rounded percentages) so the truly most limiting
	// bucket wins; ties keep the earlier family for deterministic output.
	const binding = windows.reduce((best, window) => window.remainingRatio < best.remainingRatio ? window : best);
	const { remainingRatio: _remainingRatio, ...window } = binding;
	return window;
}

function readHeader(headers: Record<string, string>, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = headers[name];
		if (value !== undefined) return value;
	}
	for (const [name, value] of Object.entries(headers)) {
		if (names.some((candidate) => candidate === name.toLowerCase())) return value;
	}
	return undefined;
}

function readHeaderNumber(headers: Record<string, string>, ...names: string[]): number | undefined {
	const value = readHeader(headers, ...names);
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseResetHeaderValue(value: string | undefined, now: number): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const trimmed = value.trim();

	// Anthropic documents RFC 3339 reset instants. Do not infer a reset from
	// arbitrary dates or gateway-specific relative durations.
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(trimmed)) return undefined;

	const timestamp = Date.parse(trimmed);
	if (Number.isFinite(timestamp)) return Math.max(now, timestamp);

	return undefined;
}

function clampPercent(percent: number): number {
	return Math.max(0, Math.min(100, percent));
}
