import type { LocalUsageCollector } from "./local-source.js";
import type { UsageSourceId, UsageSourceSnapshot, UsageSourceStatus, UsageUnit } from "./types.js";

/** One collectable usage source as seen by the service. */
export type UsageStatsSource = {
	/** Restore a complete disk snapshot without collecting or polling. */
	restore?(): Promise<UsageSourceSnapshot | undefined>;
	readonly id: UsageSourceId;
	readonly unit: UsageUnit;
	/** Automatic refresh interval for `request()` without `refresh`. */
	readonly refreshIntervalMs: number;
	/** Floor between attempts even for explicit refreshes. */
	readonly minIntervalMs: number;
	/**
	 * Must reject (not resolve) when `signal` aborts. `onPartial` may deliver
	 * interim `loading` snapshots before the final result.
	 */
	collect(signal: AbortSignal, onPartial?: (snapshot: UsageSourceSnapshot) => void): Promise<UsageSourceSnapshot>;
	/** Releases owned resources (e.g. worker threads). */
	dispose?(): void;
};

export type UsageStatsLog = (level: "info" | "warn" | "error", event: string, details?: Record<string, unknown>) => void;

export type UsageStatsServiceOptions = {
	sources: readonly UsageStatsSource[];
	/** Called when a newer snapshot for `source` is retained. */
	onChange?: (source: UsageSourceId) => void;
	log?: UsageStatsLog;
	now?: () => number;
	/** Cap for exponential backoff after `error`/`rate-limited` results. */
	maxBackoffMs?: number;
};

type Entry = {
	readonly source: UsageStatsSource;
	snapshot?: UsageSourceSnapshot;
	running?: Promise<void> | undefined;
	controller?: AbortController | undefined;
	lastAttemptMs?: number;
	lastResultStatus?: UsageSourceStatus;
	failures: number;
};

const DEFAULT_MAX_BACKOFF_MS = 30 * 60_000;
const TRANSIENT: ReadonlySet<UsageSourceStatus> = new Set(["error", "rate-limited"]);
const LOGGED: ReadonlySet<UsageSourceStatus> = new Set(["error", "rate-limited", "auth", "unsupported"]);

/**
 * Coalesces collections per source (one in flight), throttles refreshes,
 * backs off after transient failures, retains the last good snapshot as
 * `stale` while refreshing or after a transient failure, and aborts all
 * collections on dispose. Stale completions after dispose are dropped.
 */
export class UsageStatsService {
	private readonly entries = new Map<UsageSourceId, Entry>();
	private readonly now: () => number;
	private disposed = false;
	private restoring: Promise<void> | undefined;

	constructor(private readonly options: UsageStatsServiceOptions) {
		this.now = options.now ?? Date.now;
		for (const source of options.sources) this.entries.set(source.id, { source, failures: 0 });
	}

	/** One coalesced restore before the host's first request; no source collection. */
	restore(): Promise<void> {
		return this.restoring ??= Promise.all([...this.entries.values()].map(async (entry) => {
			try {
				const snapshot = await entry.source.restore?.();
				if (!this.disposed && !entry.snapshot && snapshot?.source === entry.source.id && snapshot.status === "ready") {
					entry.snapshot = { ...snapshot, status: "stale" };
				}
			} catch (error) {
				this.log("warn", "usage_stats.cache_restore_failed", { source: entry.source.id, error: error instanceof Error ? error.name : "Error" });
			}
		})).then(() => {});
	}

	/** Retained snapshots, immediately; schedules collection when due. */
	request(options: { sources?: readonly UsageSourceId[]; refresh?: boolean } = {}): UsageSourceSnapshot[] {
		const ids = options.sources ?? [...this.entries.keys()];
		const snapshots: UsageSourceSnapshot[] = [];
		for (const id of ids) {
			const entry = this.entries.get(id);
			if (!entry) continue;
			if (!this.disposed) this.maybeCollect(entry, options.refresh === true);
			snapshots.push(this.view(entry));
		}
		return snapshots;
	}

	/** Resolves when every in-flight collection has finished (tests, shutdown). */
	async settled(): Promise<void> {
		await Promise.all([...this.entries.values()].map((entry) => entry.running));
	}

	dispose(): void {
		this.disposed = true;
		for (const entry of this.entries.values()) {
			entry.controller?.abort();
			try {
				entry.source.dispose?.();
			} catch (error) {
				this.log("warn", "usage_stats.dispose_failed", { source: entry.source.id, error: error instanceof Error ? error.name : "Error" });
			}
		}
	}

	private maybeCollect(entry: Entry, force: boolean): void {
		if (entry.running) return;
		const now = this.now();
		const { refreshIntervalMs, minIntervalMs } = entry.source;
		if (entry.lastAttemptMs !== undefined) {
			let interval = force ? minIntervalMs : refreshIntervalMs;
			if (entry.failures > 0) {
				const backoff = Math.min(this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, minIntervalMs * 2 ** entry.failures);
				interval = Math.max(interval, backoff);
			}
			if (now - entry.lastAttemptMs < interval) return;
		}
		const controller = new AbortController();
		entry.controller = controller;
		entry.lastAttemptMs = now;
		const run = this.run(entry, controller.signal).finally(() => {
			if (entry.controller !== controller) return;
			entry.controller = undefined;
			entry.running = undefined;
		});
		entry.running = run;
	}

	private async run(entry: Entry, signal: AbortSignal): Promise<void> {
		const { id, unit } = entry.source;
		let result: UsageSourceSnapshot;
		try {
			result = await entry.source.collect(signal, (partial) => this.applyPartial(entry, signal, partial));
		} catch (error) {
			if (this.disposed || signal.aborted) return;
			this.log("error", "usage_stats.collect_failed", { source: id, error: error instanceof Error ? error.name : "Error" });
			result = { source: id, status: "error", unit, coverage: null, buckets: [], fetchedAtMs: this.now(), message: "Collection failed." };
		}
		if (this.disposed || signal.aborted) return;
		this.apply(entry, result);
		try {
			this.options.onChange?.(id);
		} catch (error) {
			this.log("warn", "usage_stats.change_listener_failed", { source: id, error: error instanceof Error ? error.name : "Error" });
		}
	}

	/** Interim data only fills a cold entry; it never replaces a retained snapshot. */
	private applyPartial(entry: Entry, signal: AbortSignal, partial: UsageSourceSnapshot): void {
		if (this.disposed || signal.aborted) return;
		if (entry.snapshot && entry.snapshot.status !== "loading") return;
		entry.snapshot = { ...partial, status: "loading" };
		try {
			this.options.onChange?.(entry.source.id);
		} catch (error) {
			this.log("warn", "usage_stats.change_listener_failed", { source: entry.source.id, error: error instanceof Error ? error.name : "Error" });
		}
	}

	private apply(entry: Entry, result: UsageSourceSnapshot): void {
		const previous = entry.snapshot;
		const transient = TRANSIENT.has(result.status);
		entry.failures = transient ? entry.failures + 1 : 0;
		if (result.status !== entry.lastResultStatus && LOGGED.has(result.status)) {
			this.log("warn", "usage_stats.source_status", { source: entry.source.id, status: result.status, failures: entry.failures });
		}
		entry.lastResultStatus = result.status;
		const keepPrevious = transient && previous !== undefined && previous.buckets.length > 0
			&& (previous.status === "ready" || previous.status === "stale");
		if (keepPrevious) {
			const { message: _old, ...rest } = previous;
			entry.snapshot = { ...rest, status: "stale", ...(result.message ? { message: result.message } : {}) };
		} else {
			entry.snapshot = result;
		}
	}

	private view(entry: Entry): UsageSourceSnapshot {
		const { snapshot } = entry;
		if (!snapshot) {
			return { source: entry.source.id, status: entry.running ? "loading" : "unavailable", unit: entry.source.unit, coverage: null, buckets: [], fetchedAtMs: 0 };
		}
		return entry.running && snapshot.status === "ready" ? { ...snapshot, status: "stale" } : snapshot;
	}

	private log(level: "info" | "warn" | "error", event: string, details: Record<string, unknown>): void {
		try {
			this.options.log?.(level, event, details);
		} catch {
			// Logging must never change collection behavior.
		}
	}
}

/** Adapt a local JSONL source; repeated identical diagnostics are logged once. */
export function localUsageStatsSource(
	source: LocalUsageCollector,
	options: { refreshIntervalMs?: number; minIntervalMs?: number; log?: UsageStatsLog } = {},
): UsageStatsSource {
	let lastDiagnostics = "";
	return {
		id: source.id,
		...(source.restore ? { restore: () => source.restore!() } : {}),
		unit: "tokens",
		refreshIntervalMs: options.refreshIntervalMs ?? 15_000,
		minIntervalMs: options.minIntervalMs ?? 2_000,
		dispose: () => source.dispose?.(),
		async collect(signal, onPartial) {
			const result = await source.collect(signal, onPartial);
			const diagnostics = `${result.skipped.length}:${result.malformedLines}`;
			if (diagnostics !== lastDiagnostics && (result.skipped.length > 0 || result.malformedLines > 0)) {
				try {
					options.log?.("warn", "usage_stats.local_diagnostics", {
						source: source.id,
						skippedFiles: result.skipped.length,
						malformedLines: result.malformedLines,
						errors: [...new Set(result.skipped.map((file) => file.error))],
					});
				} catch {
					// Logging must never change collection behavior.
				}
			}
			lastDiagnostics = diagnostics;
			return result.snapshot;
		},
	};
}
