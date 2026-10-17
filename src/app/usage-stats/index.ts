import { createPixSessionsSource } from "./pix-sessions.js";
import { pixSessionsRoots } from "./pix-sessions-roots.js";
import { localUsageStatsSource, type UsageStatsLog, type UsageStatsSource } from "./service.js";
import { WorkerCollector } from "./worker-collector.js";

export { UsageStatsService, type UsageStatsLog, type UsageStatsServiceOptions, type UsageStatsSource } from "./service.js";
export type * from "./types.js";

/**
 * Pix session usage across every project; Desktop filters by `projectCwd`.
 * Parsing runs in a worker thread (in-process when `inProcess` is set or the
 * worker cannot start).
 */
export function createUsageStatsSources(options: { log?: UsageStatsLog; agentDir?: string; inProcess?: boolean } = {}): UsageStatsSource[] {
	const local = options.log ? { log: options.log } : {};
	const roots = () => pixSessionsRoots(options.agentDir);
	const fallback = () => createPixSessionsSource({ roots });
	const collector = options.inProcess ? fallback() : new WorkerCollector({
		id: "pix-sessions",
		roots,
		fallback,
		...local,
	});
	return [localUsageStatsSource(collector, local)];
}
