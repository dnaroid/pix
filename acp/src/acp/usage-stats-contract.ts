/**
 * Desktop usage-statistics wire contract. Dependency-free so Desktop can
 * import it directly. Mirrors `src/app/usage-stats/types.ts` (root build);
 * kept as a structural copy because the ACP/Desktop builds cannot import
 * root sources across their rootDir boundaries.
 */
export const PIX_USAGE_STATS_METHOD = "pix/usage/stats";
/** Notification: a newer snapshot for `source` is available (re-request it). */
export const PIX_USAGE_STATS_CHANGED_METHOD = "pix/usage/stats_changed";

export const USAGE_SOURCE_IDS = ["pix-sessions"] as const;
export type UsageSourceId = typeof USAGE_SOURCE_IDS[number];

export const USAGE_SOURCE_STATUSES = ["loading", "ready", "stale", "unavailable", "auth", "rate-limited", "unsupported", "error"] as const;
export type UsageSourceStatus = typeof USAGE_SOURCE_STATUSES[number];
export const USAGE_UNITS = ["tokens"] as const;
export type UsageUnit = typeof USAGE_UNITS[number];

export type UsageValues = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	totalTokens?: number;
	calls?: number;
	cost?: number;
	costEstimated?: boolean;
};

export type UsageBucket = {
	startMs: number;
	width: "hour" | "day";
	provider: string | null;
	model: string | null;
	sessionId?: string;
	projectCwd?: string;
	values: UsageValues;
};

export type UsageSessionSummary = {
	sessionId: string;
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
	skippedFiles?: number;
	untimedRecords?: number;
	message?: string;
};

export type UsageStatsRequest = {
	cwd: string;
	/** Omitted = every source. */
	sources?: UsageSourceId[];
	/** Force a refresh (still throttled by each source's minimum interval). */
	refresh?: boolean;
};

export type UsageStatsResponse = { snapshots: UsageSourceSnapshot[] };

/** Usage covers every project; Desktop filters buckets by `projectCwd`. */
export type UsageStatsChangedNotification = { source: UsageSourceId };

export function isUsageSourceId(value: unknown): value is UsageSourceId {
	return typeof value === "string" && (USAGE_SOURCE_IDS as readonly string[]).includes(value);
}
