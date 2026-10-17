import { aggregateLocalUsage } from "./buckets.js";
import { stat } from "node:fs/promises";
import { JsonlTailCache, listJsonlFiles, type JsonlParser, type JsonlSkippedFile } from "./jsonl-tail-cache.js";
import type { LocalUsageEvent, UsageSourceId, UsageSourceSnapshot } from "./types.js";

export type LocalUsageCollectResult = {
	snapshot: UsageSourceSnapshot;
	/** Diagnostics for the caller's logger; never shown verbatim in the UI. */
	skipped: JsonlSkippedFile[];
	malformedLines: number;
	duplicateRecords: number;
};

export type LocalUsageSourceOptions<S> = {
	id: UsageSourceId;
	/** Resolved on every collection so environment/config changes apply. */
	roots: () => readonly string[];
	parser: JsonlParser<S, LocalUsageEvent>;
	now?: () => number;
	/** Cold collections first emit a partial snapshot of files modified within this window. */
	partialWindowMs?: number;
};

/** Receives an interim snapshot while a cold collection continues with older files. */
export type LocalUsagePartial = (snapshot: UsageSourceSnapshot) => void;

/** Collector contract shared by in-process and worker-backed local sources. */
export type LocalUsageCollector = {
	readonly id: UsageSourceId;
	collect(signal?: AbortSignal, onPartial?: LocalUsagePartial): Promise<LocalUsageCollectResult>;
	dispose?(): void;
};

const DEFAULT_PARTIAL_WINDOW_MS = 7 * 24 * 3_600_000;
const STAT_BATCH = 64;

/** A local JSONL log source with an incremental per-file cache. */
export class LocalUsageSource<S> {
	private readonly cache: JsonlTailCache<S, LocalUsageEvent>;
	/** Set after the first full collection; warm refreshes skip the partial pass. */
	private primed = false;

	constructor(private readonly options: LocalUsageSourceOptions<S>) {
		this.cache = new JsonlTailCache(options.parser);
	}

	get id(): UsageSourceId {
		return this.options.id;
	}

	async collect(signal?: AbortSignal, onPartial?: LocalUsagePartial): Promise<LocalUsageCollectResult> {
		const listings = await Promise.all(this.options.roots().map((root) => listJsonlFiles(root)));
		signal?.throwIfAborted();
		const fetchedAtMs = (this.options.now ?? Date.now)();
		if (listings.every((listing) => listing === undefined)) {
			this.clear();
			return {
				snapshot: { source: this.options.id, status: "unavailable", unit: "tokens", coverage: null, buckets: [], fetchedAtMs, message: "No local logs found." },
				skipped: [],
				malformedLines: 0,
				duplicateRecords: 0,
			};
		}
		const files = listings.flatMap((listing) => listing ?? []);
		if (!this.primed && onPartial) await this.emitPartial(files, fetchedAtMs, signal, onPartial);
		const read = await this.cache.read(files, signal);
		this.primed = true;
		const aggregate = aggregateLocalUsage(read.files);
		return {
			snapshot: {
				source: this.options.id,
				status: "ready",
				unit: "tokens",
				coverage: aggregate.coverage,
				buckets: aggregate.buckets,
				sessions: aggregate.sessions,
				fetchedAtMs,
				...(read.skipped.length > 0 ? { skippedFiles: read.skipped.length } : {}),
				...(aggregate.untimedRecords > 0 ? { untimedRecords: aggregate.untimedRecords } : {}),
			},
			skipped: read.skipped,
			malformedLines: read.malformedLines,
			duplicateRecords: aggregate.duplicateRecords,
		};
	}

	clear(): void {
		this.cache.clear();
		this.primed = false;
	}

	/** Parse recently modified files first (append-only logs: older files cannot hold recent events). */
	private async emitPartial(files: readonly string[], fetchedAtMs: number, signal: AbortSignal | undefined, onPartial: LocalUsagePartial): Promise<void> {
		const since = fetchedAtMs - (this.options.partialWindowMs ?? DEFAULT_PARTIAL_WINDOW_MS);
		const recent: string[] = [];
		for (let i = 0; i < files.length; i += STAT_BATCH) {
			signal?.throwIfAborted();
			const batch = files.slice(i, i + STAT_BATCH);
			const times = await Promise.all(batch.map((path) => stat(path).then((info) => info.mtimeMs, () => 0)));
			batch.forEach((path, index) => { if ((times[index] ?? 0) >= since) recent.push(path); });
		}
		// Nothing to gain when every file is recent (or none is).
		if (recent.length === 0 || recent.length === files.length) return;
		const read = await this.cache.read(recent, signal, { prune: false });
		signal?.throwIfAborted();
		const aggregate = aggregateLocalUsage(read.files);
		try {
			onPartial({
				source: this.options.id,
				status: "loading",
				unit: "tokens",
				// Partial coverage would falsely flag longer periods as truncated.
				coverage: null,
				buckets: aggregate.buckets,
				sessions: aggregate.sessions,
				fetchedAtMs,
				message: "Showing recent sessions while older history loads.",
			});
		} catch {
			// A failing listener must not abort the full collection.
		}
	}
}
