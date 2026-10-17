export type UsageSourceId = "pix-sessions";
export type UsageSourceStatus = "loading" | "ready" | "stale" | "unavailable" | "auth" | "rate-limited" | "unsupported" | "error";
export type UsageUnit = "tokens";

export type UsageValues = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	totalTokens?: number;
	calls?: number;
	cost?: number;
	/** At least one contributing cost is an API-equivalent estimate. */
	costEstimated?: boolean;
};

export type UsageBucket = {
	/** UTC start of the bucket; `0` collects records without a usable timestamp. */
	startMs: number;
	width: "hour" | "day";
	/** `null` = Unattributed. */
	provider: string | null;
	model: string | null;
	sessionId?: string;
	projectCwd?: string;
	values: UsageValues;
};

export type UsageSessionSummary = {
	sessionId: string;
	/** Absolute session JSONL path; Desktop resolves its ACP session id by it. */
	sessionFile?: string;
	name?: string;
	projectCwd?: string;
	firstAtMs?: number;
	lastAtMs?: number;
	userTurns: number;
};

export type UsageSourceSnapshot = {
	source: UsageSourceId;
	status: UsageSourceStatus;
	unit: UsageUnit;
	coverage: { fromMs: number; toMs: number } | null;
	buckets: UsageBucket[];
	sessions?: UsageSessionSummary[];
	fetchedAtMs: number;
	/** Local sources: files that could not be read. */
	skippedFiles?: number;
	/** Local sources: usage counted only in `startMs: 0` buckets. */
	untimedRecords?: number;
	/** Short, user-safe status explanation. */
	message?: string;
};

/** One parsed event from a local JSONL log. */
export type LocalUsageEvent = LocalUsageRecord | LocalSessionEvent;

export type LocalUsageRecord = {
	kind: "usage";
	/** Cross-file identity; repeated keys are counted once (first occurrence wins). */
	key?: string;
	timestampMs?: number;
	provider: string | null;
	model: string | null;
	sessionId: string;
	projectCwd?: string;
	values: UsageValues;
};

export type LocalSessionEvent = {
	kind: "session";
	sessionId: string;
	sessionFile?: string;
	/** `null` clears a previously set name. */
	name?: string | null;
	projectCwd?: string;
	userTurn?: boolean;
	timestampMs?: number;
};
