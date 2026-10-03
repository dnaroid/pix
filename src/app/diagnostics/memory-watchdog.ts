import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getHeapSpaceStatistics, getHeapStatistics, writeHeapSnapshot } from "node:v8";

import type { MemoryWatchdogConfig } from "../../config.js";
import { logPixEvent, type PixLogDetails, type PixLogLevel } from "../logger.js";
import { TuiMemoryTrace } from "./tui-memory-trace.js";

/** How often process memory is sampled. `process.memoryUsage()` is a cheap syscall-level read. */
export const MEMORY_WATCHDOG_SAMPLE_INTERVAL_MS = 15_000;
/** Samples kept for the report timeline (one hour at the sample interval). */
export const MEMORY_WATCHDOG_HISTORY_SAMPLES = 240;
/** Every Nth sample is also written to pix.log so gradual growth stays visible without a report. */
export const MEMORY_WATCHDOG_LOG_EVERY_SAMPLES = 20;
/** Reports (and their heap snapshots) kept on disk; older ones are pruned. */
export const MEMORY_WATCHDOG_MAX_REPORTS = 5;
/**
 * A heap snapshot is written synchronously and needs roughly as much memory
 * again as the heap it serializes. Above this heap size it would freeze the UI
 * for minutes and could push the machine into swap, so only the report is kept.
 */
export const MEMORY_WATCHDOG_MAX_SNAPSHOT_HEAP_BYTES = 4 * 1024 ** 3;
/** Yield to the renderer so the "writing snapshot" toast is painted before the blocking write. */
const HEAP_SNAPSHOT_DEFER_MS = 100;
const REPORT_FILE_PREFIX = "pix-memory-";
const MB = 1024 ** 2;

export type MemoryWatchdogSample = {
	at: number;
	rss: number;
	heapUsed: number;
	heapTotal: number;
	external: number;
	arrayBuffers: number;
};

export type MemoryWatchdogReportResult = {
	reportPath: string;
	heapSnapshotPath?: string;
	thresholdBytes: number;
	sample: MemoryWatchdogSample;
};

export type MemoryWatchdogHost = {
	/** Cheap, synchronous app-level counters that help attribute growth (tabs, entries, runtimes…). */
	appContext(): Record<string, unknown>;
	showToast(message: string, kind: "warning" | "error" | "info"): void;
};

type TimerHandle = { unref?(): unknown };

export type MemoryWatchdogDeps = {
	trace?: Pick<TuiMemoryTrace, "enabled" | "start" | "stop">;
	now(): number;
	memoryUsage(): NodeJS.MemoryUsage;
	setInterval(callback: () => void, ms: number): TimerHandle;
	clearInterval(handle: TimerHandle): void;
	setTimeout(callback: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
	reportDir(): string;
	writeReport(path: string, contents: string): Promise<void>;
	listReportFiles(dir: string): Promise<string[]>;
	removeFile(path: string): Promise<void>;
	/** Synchronous by nature (V8 API); returns the written path. */
	writeHeapSnapshot(path: string): string;
	runtimeDiagnostics(): Record<string, unknown>;
	log(level: PixLogLevel, event: string, details: PixLogDetails): void;
};

export function getMemoryReportDir(homeDir = homedir()): string {
	return join(homeDir, ".config", "pi", "memory-reports");
}

const defaultDeps: MemoryWatchdogDeps = {
	now: () => Date.now(),
	memoryUsage: () => process.memoryUsage(),
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	reportDir: () => getMemoryReportDir(),
	writeReport: async (path, contents) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, contents, "utf8");
	},
	listReportFiles: async (dir) => await readdir(dir).catch(() => []),
	removeFile: async (path) => {
		await rm(path, { force: true });
	},
	writeHeapSnapshot: (path) => writeHeapSnapshot(path),
	runtimeDiagnostics: () => ({
		heapStatistics: getHeapStatistics(),
		heapSpaces: getHeapSpaceStatistics().map((space) => ({
			name: space.space_name,
			size: space.space_size,
			used: space.space_used_size,
			available: space.space_available_size,
		})),
		resourceUsage: process.resourceUsage(),
		activeResources: countBy(process.getActiveResourcesInfo()),
	}),
	log: (level, event, details) => logPixEvent(level, event, details),
};

/**
 * Watches the TUI process for runaway memory growth.
 *
 * It samples memory on an unref'd timer and, once RSS crosses the configured
 * threshold, writes a JSON report (memory timeline, V8 heap spaces, active
 * handles, app counters) to ~/.config/pi/memory-reports and warns with a toast.
 * The first report may also carry a heap snapshot. Further reports are written
 * each time RSS doubles again, so a leak that keeps going leaves a trail
 * without flooding the disk. Disable it with `memoryWatchdog.enabled: false`.
 */
export class MemoryWatchdog {
	private config: MemoryWatchdogConfig;
	private readonly deps: MemoryWatchdogDeps;
	private readonly history: MemoryWatchdogSample[] = [];
	private timer: TimerHandle | undefined;
	private snapshotTimer: TimerHandle | undefined;
	private cancelPendingSnapshot: (() => void) | undefined;
	private nextReportBytes: number;
	private sampleCount = 0;
	private reportCount = 0;
	private reportInFlight: Promise<MemoryWatchdogReportResult | undefined> | undefined;
	private snapshotTaken = false;
	private readonly startedAt: number;
	private readonly trace: Pick<TuiMemoryTrace, "enabled" | "start" | "stop">;

	constructor(
		private readonly host: MemoryWatchdogHost,
		config: MemoryWatchdogConfig,
		deps: Partial<MemoryWatchdogDeps> = {},
	) {
		this.deps = { ...defaultDeps, ...deps };
		this.config = { ...config };
		this.nextReportBytes = thresholdBytes(config);
		this.startedAt = this.deps.now();
		this.trace = this.deps.trace ?? new TuiMemoryTrace(() => this.host.appContext(), {
			log: (event, details) => this.deps.log("info", event, details),
		});
	}

	start(): void {
		if (!this.config.enabled || this.timer) return;
		const timer = this.deps.setInterval(() => this.tick(), MEMORY_WATCHDOG_SAMPLE_INTERVAL_MS);
		// Diagnostics must never keep the process alive on its own.
		timer.unref?.();
		this.timer = timer;
		this.trace.start(this.config.thresholdMb);
	}

	stop(): void {
		this.trace.stop();
		if (this.timer) this.deps.clearInterval(this.timer);
		this.timer = undefined;
		if (this.snapshotTimer) this.deps.clearTimeout(this.snapshotTimer);
		this.snapshotTimer = undefined;
		// Settle a deferred snapshot that will now never run, so the in-flight
		// report completes and a later restart can report again.
		this.cancelPendingSnapshot?.();
		this.cancelPendingSnapshot = undefined;
	}

	/** Apply a reloaded config: toggles sampling and re-arms the threshold. */
	updateConfig(config: MemoryWatchdogConfig): void {
		const thresholdChanged = thresholdBytes(config) !== thresholdBytes(this.config);
		this.config = { ...config };
		if (thresholdChanged) {
			// Before any report the new threshold applies directly; afterwards never
			// re-report below the escalation level already reached.
			this.nextReportBytes = this.reportCount === 0
				? thresholdBytes(config)
				: Math.max(thresholdBytes(config), this.nextReportBytes);
		}
		if (!config.enabled) {
			this.stop();
			return;
		}
		this.start();
	}

	isRunning(): boolean {
		return this.timer !== undefined;
	}

	samples(): readonly MemoryWatchdogSample[] {
		return this.history;
	}

	/** One sampling step; public so tests can drive it without real timers. */
	tick(): Promise<MemoryWatchdogReportResult | undefined> | undefined {
		if (!this.config.enabled) return undefined;
		const sample = this.sample();
		this.sampleCount += 1;
		if (this.sampleCount % MEMORY_WATCHDOG_LOG_EVERY_SAMPLES === 0) {
			this.deps.log("info", "memory.sample", sampleInMb(sample));
		}
		if (sample.rss < this.nextReportBytes || this.reportInFlight) return undefined;

		const reportThreshold = this.nextReportBytes;
		// Escalate: the next report waits until RSS doubles past this one.
		while (this.nextReportBytes <= sample.rss) this.nextReportBytes *= 2;
		const promise = this.report(sample, reportThreshold).finally(() => {
			this.reportInFlight = undefined;
		});
		this.reportInFlight = promise;
		return promise;
	}

	private sample(): MemoryWatchdogSample {
		const usage = this.deps.memoryUsage();
		const sample = {
			at: this.deps.now(),
			rss: usage.rss,
			heapUsed: usage.heapUsed,
			heapTotal: usage.heapTotal,
			external: usage.external,
			arrayBuffers: usage.arrayBuffers,
		};
		this.history.push(sample);
		if (this.history.length > MEMORY_WATCHDOG_HISTORY_SAMPLES) this.history.splice(0, this.history.length - MEMORY_WATCHDOG_HISTORY_SAMPLES);
		return sample;
	}

	private async report(sample: MemoryWatchdogSample, threshold: number): Promise<MemoryWatchdogReportResult | undefined> {
		this.reportCount += 1;
		const dir = this.deps.reportDir();
		const baseName = `${REPORT_FILE_PREFIX}${fileTimestamp(sample.at)}-${process.pid}`;
		const reportPath = join(dir, `${baseName}.json`);
		// Allocation sampling avoids a multi-GB synchronous snapshot during the incident.
		const wantsSnapshot = this.config.heapSnapshot && !this.snapshotTaken && !this.trace.enabled;
		const snapshotAllowed = wantsSnapshot && sample.heapUsed <= MEMORY_WATCHDOG_MAX_SNAPSHOT_HEAP_BYTES;
		const heapSnapshotPath = snapshotAllowed ? join(dir, `${baseName}.heapsnapshot`) : undefined;

		const report = {
			kind: "pix-memory-report",
			version: 1,
			reason: `RSS ${formatMb(sample.rss)} crossed ${formatMb(threshold)}`,
			createdAt: new Date(sample.at).toISOString(),
			reportNumber: this.reportCount,
			process: {
				pid: process.pid,
				node: process.version,
				platform: process.platform,
				arch: process.arch,
				uptimeSeconds: Math.round((sample.at - this.startedAt) / 1000),
				execArgv: process.execArgv,
			},
			config: this.config,
			allocationTrace: this.trace.enabled,
			current: sampleInMb(sample),
			app: safeCall(() => this.host.appContext()),
			runtime: safeCall(() => this.deps.runtimeDiagnostics()),
			heapSnapshot: heapSnapshotPath
				?? (wantsSnapshot ? `skipped: heap ${formatMb(sample.heapUsed)} exceeds ${formatMb(MEMORY_WATCHDOG_MAX_SNAPSHOT_HEAP_BYTES)}` : "disabled"),
			timeline: this.history.map(sampleInMb),
		};

		try {
			await this.deps.writeReport(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		} catch (error) {
			this.deps.log("error", "memory.report_failed", { reportPath, error: errorMessage(error) });
			this.host.showToast(`Memory ${formatMb(sample.rss)}: could not write leak report (${errorMessage(error)})`, "error");
			return undefined;
		}
		this.deps.log("warn", "memory.threshold_exceeded", { reportPath, thresholdMb: toMb(threshold), ...sampleInMb(sample) });
		await this.pruneOldReports(dir);

		if (!heapSnapshotPath) {
			this.host.showToast(`High memory: ${formatMb(sample.rss)}. Leak report: ${reportPath}`, "warning");
			return { reportPath, thresholdBytes: threshold, sample };
		}

		this.snapshotTaken = true;
		this.host.showToast(`High memory: ${formatMb(sample.rss)}. Writing heap snapshot, the UI may pause…`, "warning");
		const written = await this.writeSnapshotDeferred(heapSnapshotPath);
		if (!written) {
			this.host.showToast(`High memory: ${formatMb(sample.rss)}. Leak report (no heap snapshot): ${reportPath}`, "warning");
			return { reportPath, thresholdBytes: threshold, sample };
		}
		// Serializing the heap inflates RSS by roughly the heap size; do not let
		// that self-inflicted bump count as the leak's next doubling.
		const rssAfterSnapshot = this.deps.memoryUsage().rss;
		while (this.nextReportBytes <= rssAfterSnapshot) this.nextReportBytes *= 2;
		this.deps.log("warn", "memory.heap_snapshot_written", { reportPath, heapSnapshotPath: written });
		this.host.showToast(`High memory: ${formatMb(sample.rss)}. Leak report: ${reportPath}`, "warning");
		return { reportPath, heapSnapshotPath: written, thresholdBytes: threshold, sample };
	}

	private writeSnapshotDeferred(path: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.cancelPendingSnapshot = () => {
				// Never written: the next report may still take the one snapshot.
				this.snapshotTaken = false;
				resolve(undefined);
			};
			this.snapshotTimer = this.deps.setTimeout(() => {
				this.snapshotTimer = undefined;
				this.cancelPendingSnapshot = undefined;
				try {
					resolve(this.deps.writeHeapSnapshot(path));
				} catch (error) {
					this.deps.log("error", "memory.heap_snapshot_failed", { path, error: errorMessage(error) });
					resolve(undefined);
				}
			}, HEAP_SNAPSHOT_DEFER_MS);
			this.snapshotTimer.unref?.();
		});
	}

	private async pruneOldReports(dir: string): Promise<void> {
		try {
			const files = (await this.deps.listReportFiles(dir)).filter((name) => name.startsWith(REPORT_FILE_PREFIX));
			const bases = [...new Set(files.map((name) => name.replace(/\.(json|heapsnapshot)$/u, "")))].sort();
			const stale = new Set(bases.slice(0, Math.max(0, bases.length - MEMORY_WATCHDOG_MAX_REPORTS)));
			for (const name of files) {
				if (stale.has(name.replace(/\.(json|heapsnapshot)$/u, ""))) await this.deps.removeFile(join(dir, name));
			}
		} catch {
			// Pruning is best-effort housekeeping.
		}
	}
}

function thresholdBytes(config: MemoryWatchdogConfig): number {
	return config.thresholdMb * MB;
}

function toMb(bytes: number): number {
	return Math.round(bytes / MB);
}

function formatMb(bytes: number): string {
	return bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(1)} GB` : `${toMb(bytes)} MB`;
}

function sampleInMb(sample: MemoryWatchdogSample): Record<string, number | string> {
	return {
		at: new Date(sample.at).toISOString(),
		rssMb: toMb(sample.rss),
		heapUsedMb: toMb(sample.heapUsed),
		heapTotalMb: toMb(sample.heapTotal),
		externalMb: toMb(sample.external),
		arrayBuffersMb: toMb(sample.arrayBuffers),
	};
}

function fileTimestamp(at: number): string {
	return new Date(at).toISOString().replace(/[:.]/gu, "-");
}

function countBy(values: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}

function safeCall(read: () => Record<string, unknown>): Record<string, unknown> {
	try {
		return read();
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
