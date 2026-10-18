import { readUsageCache, writeUsageCache } from "../usage-cache-file.js";
import type { LocalUsageCollectResult, LocalUsageCollector, LocalUsagePartial } from "./local-source.js";
import type { UsageStatsLog } from "./service.js";
import type { UsageSourceSnapshot } from "./types.js";

const MAX_BYTES = 64 * 1024 * 1024;
const VALUE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens", "calls", "cost"];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";
const optionalNumber = (value: unknown): boolean => value === undefined || number(value);

/** Disk snapshots are complete observations, never partial/error payloads. */
export function isUsageSnapshot(value: unknown): value is UsageSourceSnapshot {
	if (!record(value) || value.source !== "pix-sessions" || value.status !== "ready" || value.unit !== "tokens"
		|| !number(value.fetchedAtMs) || !Array.isArray(value.buckets)) return false;
	const coverage = value.coverage;
	if (coverage !== null && (!record(coverage) || !number(coverage.fromMs) || !number(coverage.toMs) || coverage.fromMs > coverage.toMs)) return false;
	if (!optionalNumber(value.skippedFiles) || !optionalNumber(value.untimedRecords)) return false;
	if (!value.buckets.every((bucket: unknown) => record(bucket) && number(bucket.startMs)
		&& (bucket.width === "hour" || bucket.width === "day")
		&& (bucket.provider === null || typeof bucket.provider === "string")
		&& (bucket.model === null || typeof bucket.model === "string")
		&& optionalString(bucket.sessionId) && optionalString(bucket.projectCwd)
		&& record(bucket.values) && VALUE_KEYS.every((key) => optionalNumber((bucket.values as Record<string, unknown>)[key]))
		&& (bucket.values.costEstimated === undefined || typeof bucket.values.costEstimated === "boolean"))) return false;
	return value.sessions === undefined || (Array.isArray(value.sessions) && value.sessions.every((session: unknown) => record(session)
		&& typeof session.sessionId === "string" && optionalString(session.sessionFile) && optionalString(session.name)
		&& optionalString(session.projectCwd) && optionalNumber(session.firstAtMs) && optionalNumber(session.lastAtMs) && number(session.userTurns)));
}

/** Runs alongside the collector (in its worker by default), not on Desktop's UI thread. */
export class CachedUsageCollector implements LocalUsageCollector {
	private readonly reported = new Set<string>();
	constructor(private readonly source: LocalUsageCollector, private readonly path: string, private readonly log?: UsageStatsLog) {}
	get id() { return this.source.id; }

	async restore(): Promise<UsageSourceSnapshot | undefined> {
		try {
			return await readUsageCache(this.path, isUsageSnapshot, MAX_BYTES);
		} catch (error) {
			this.report("read", error);
			return undefined;
		}
	}

	async collect(signal?: AbortSignal, onPartial?: LocalUsagePartial): Promise<LocalUsageCollectResult> {
		const result = await this.source.collect(signal, onPartial);
		if (!signal?.aborted && result.snapshot.status === "ready") {
			try {
				await writeUsageCache(this.path, result.snapshot, MAX_BYTES);
			} catch (error) { this.report("write", error); }
		}
		return result;
	}

	dispose(): void { this.source.dispose?.(); }

	private report(operation: string, error: unknown): void {
		if (this.reported.has(operation)) return;
		this.reported.add(operation);
		try { this.log?.("warn", `usage_stats.cache_${operation}_failed`, { error: error instanceof Error ? error.name : "Error" }); } catch { /* Diagnostic only. */ }
	}
}
