import type { JsonlFileResult } from "./jsonl-tail-cache.js";
import type { LocalUsageEvent, UsageBucket, UsageSessionSummary, UsageValues } from "./types.js";

export type LocalUsageAggregate = {
	buckets: UsageBucket[];
	sessions: UsageSessionSummary[];
	coverage: { fromMs: number; toMs: number } | null;
	untimedRecords: number;
	duplicateRecords: number;
};

const HOUR_MS = 3_600_000;
const NUMERIC_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens", "calls", "cost"] as const;

/**
 * Fold parsed local events into sparse UTC-hour buckets keyed by
 * provider/model/session/project. Files are visited in the given order
 * and records with a repeated `key` are counted once.
 */
export function aggregateLocalUsage(files: readonly JsonlFileResult<LocalUsageEvent>[]): LocalUsageAggregate {
	const seen = new Set<string>();
	const buckets = new Map<string, UsageBucket>();
	const sessions = new Map<string, UsageSessionSummary>();
	let fromMs = Infinity;
	let toMs = -Infinity;
	let untimedRecords = 0;
	let duplicateRecords = 0;

	for (const file of files) {
		for (const event of file.records) {
			if (event.kind === "session") {
				const session = touchSession(sessions, event.sessionId, event.projectCwd, event.timestampMs);
				if (event.sessionFile !== undefined && session.sessionFile === undefined) session.sessionFile = event.sessionFile;
				if (event.name === null) delete session.name;
				else if (event.name !== undefined) session.name = event.name;
				if (event.userTurn) session.userTurns += 1;
				continue;
			}
			if (event.key !== undefined) {
				if (seen.has(event.key)) {
					duplicateRecords += 1;
					continue;
				}
				seen.add(event.key);
			}
			const time = event.timestampMs;
			if (time === undefined) untimedRecords += 1;
			else {
				fromMs = Math.min(fromMs, time);
				toMs = Math.max(toMs, time);
			}
			const startMs = time === undefined ? 0 : Math.floor(time / HOUR_MS) * HOUR_MS;
			const key = JSON.stringify([startMs, event.provider, event.model, event.sessionId, event.projectCwd ?? null]);
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = {
					startMs,
					width: "hour",
					provider: event.provider,
					model: event.model,
					sessionId: event.sessionId,
					...(event.projectCwd === undefined ? {} : { projectCwd: event.projectCwd }),
					values: {},
				};
				buckets.set(key, bucket);
			}
			addValues(bucket.values, event.values);
			touchSession(sessions, event.sessionId, event.projectCwd, time);
		}
	}

	return {
		buckets: [...buckets.entries()].sort(([a, left], [b, right]) => left.startMs - right.startMs || a.localeCompare(b)).map(([, bucket]) => bucket),
		sessions: [...sessions.values()].sort((a, b) => (b.lastAtMs ?? 0) - (a.lastAtMs ?? 0) || a.sessionId.localeCompare(b.sessionId)),
		coverage: Number.isFinite(fromMs) ? { fromMs, toMs } : null,
		untimedRecords,
		duplicateRecords,
	};
}

export function addValues(target: UsageValues, value: UsageValues): void {
	for (const key of NUMERIC_KEYS) {
		const amount = value[key];
		if (amount !== undefined) target[key] = (target[key] ?? 0) + amount;
	}
	if (value.costEstimated) target.costEstimated = true;
}

function touchSession(
	sessions: Map<string, UsageSessionSummary>,
	sessionId: string,
	projectCwd: string | undefined,
	time: number | undefined,
): UsageSessionSummary {
	let session = sessions.get(sessionId);
	if (!session) {
		session = { sessionId, userTurns: 0 };
		sessions.set(sessionId, session);
	}
	if (projectCwd !== undefined && session.projectCwd === undefined) session.projectCwd = projectCwd;
	if (time !== undefined) {
		session.firstAtMs = Math.min(session.firstAtMs ?? time, time);
		session.lastAtMs = Math.max(session.lastAtMs ?? time, time);
	}
	return session;
}
