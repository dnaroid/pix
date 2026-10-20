import { join } from "node:path";
import { createPixSessionsSource } from "./pix-sessions.js";
import { pixSessionsRoots } from "./pix-sessions-roots.js";
import { localUsageStatsSource, type UsageStatsLog, type UsageStatsSource } from "./service.js";
import { WorkerCollector } from "./worker-collector.js";
import { CachedUsageCollector } from "./snapshot-cache.js";

export { UsageStatsService, type UsageStatsLog, type UsageStatsServiceOptions, type UsageStatsSource } from "./service.js";
export type * from "./types.js";

/**
 * Pix session usage across every project; Desktop filters by `projectCwd`.
 * Parsing runs in a worker thread (in-process when `inProcess` is set or the
 * worker cannot start). The caller supplies `agentDir` so this module never
 * loads the Pi SDK barrel (a multi-second cold import on the host thread).
 */
export function createUsageStatsSources(options: { log?: UsageStatsLog; agentDir: string; inProcess?: boolean }): UsageStatsSource[] {
	const local = options.log ? { log: options.log } : {};
	const roots = () => pixSessionsRoots(options.agentDir);
	const snapshotPath = join(options.agentDir, "cache", "usage", "v1", "history.json");
	const fallback = () => new CachedUsageCollector(createPixSessionsSource({ roots }), snapshotPath, options.log);
	const collector = options.inProcess ? fallback() : new WorkerCollector({
		id: "pix-sessions",
		roots,
		fallback,
		snapshotPath,
		...local,
	});
	return [localUsageStatsSource(collector, local)];
}
