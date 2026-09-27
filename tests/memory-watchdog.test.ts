import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	MEMORY_WATCHDOG_HISTORY_SAMPLES,
	MEMORY_WATCHDOG_MAX_REPORTS,
	MEMORY_WATCHDOG_MAX_SNAPSHOT_HEAP_BYTES,
	MEMORY_WATCHDOG_SAMPLE_INTERVAL_MS,
	MemoryWatchdog,
	type MemoryWatchdogDeps,
} from "../src/app/diagnostics/memory-watchdog.js";
import type { MemoryWatchdogConfig } from "../src/config.js";

const MB = 1024 ** 2;
const GB = 1024 * MB;

type Harness = {
	watchdog: MemoryWatchdog;
	setRss(bytes: number, heapUsed?: number): void;
	reports: Map<string, string>;
	snapshots: string[];
	toasts: Array<{ message: string; kind: string }>;
	logs: Array<{ level: string; event: string }>;
	intervals: Array<{ ms: number; cleared: boolean; unrefed: boolean }>;
	runTimeouts(): void;
	files: string[];
};

function createHarness(config: Partial<MemoryWatchdogConfig> = {}, overrides: Partial<MemoryWatchdogDeps> = {}): Harness {
	let rss = 100 * MB;
	let heapUsed = 50 * MB;
	let now = Date.parse("2026-09-27T10:00:00.000Z");
	const reports = new Map<string, string>();
	const snapshots: string[] = [];
	const toasts: Harness["toasts"] = [];
	const logs: Harness["logs"] = [];
	const intervals: Harness["intervals"] = [];
	const timeouts: Array<{ callback: () => void; cleared: boolean }> = [];
	const files: string[] = [];

	const watchdog = new MemoryWatchdog({
		appContext: () => ({ tabs: 2 }),
		showToast: (message, kind) => toasts.push({ message, kind }),
	}, { enabled: true, thresholdMb: 1024, heapSnapshot: true, ...config }, {
		now: () => (now += MEMORY_WATCHDOG_SAMPLE_INTERVAL_MS),
		memoryUsage: () => ({ rss, heapUsed, heapTotal: heapUsed, external: 0, arrayBuffers: 0 }),
		setInterval: (_callback, ms) => {
			const handle = { ms, cleared: false, unrefed: false, unref() { handle.unrefed = true; } };
			intervals.push(handle);
			return handle;
		},
		clearInterval: (handle) => {
			(handle as { cleared: boolean }).cleared = true;
		},
		setTimeout: (callback) => {
			const handle = { callback, cleared: false, unref() {} };
			timeouts.push(handle);
			return handle;
		},
		clearTimeout: (handle) => {
			(handle as { cleared: boolean }).cleared = true;
		},
		reportDir: () => "/reports",
		writeReport: async (path, contents) => {
			reports.set(path, contents);
			files.push(path.replace("/reports/", ""));
		},
		listReportFiles: async () => [...files],
		removeFile: async (path) => {
			const name = path.replace("/reports/", "");
			files.splice(files.indexOf(name), 1);
		},
		writeHeapSnapshot: (path) => {
			snapshots.push(path);
			files.push(path.replace("/reports/", ""));
			return path;
		},
		runtimeDiagnostics: () => ({ heapStatistics: {} }),
		log: (level, event) => logs.push({ level, event }),
		...overrides,
	});

	return {
		watchdog,
		setRss(bytes, nextHeapUsed = heapUsed) {
			rss = bytes;
			heapUsed = nextHeapUsed;
		},
		reports,
		snapshots,
		toasts,
		logs,
		intervals,
		files,
		runTimeouts() {
			for (const timeout of timeouts.splice(0)) if (!timeout.cleared) timeout.callback();
		},
	};
}

async function tickAndSnapshot(harness: Harness) {
	const pending = harness.watchdog.tick();
	// Let the report write settle, then fire the deferred snapshot timer.
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	harness.runTimeouts();
	return await pending;
}

describe("memory watchdog", () => {
	it("samples on an unref'd interval and never starts when disabled", () => {
		const enabled = createHarness();
		enabled.watchdog.start();
		enabled.watchdog.start();
		assert.equal(enabled.intervals.length, 1);
		assert.equal(enabled.intervals[0]?.ms, MEMORY_WATCHDOG_SAMPLE_INTERVAL_MS);
		assert.equal(enabled.intervals[0]?.unrefed, true);
		enabled.watchdog.stop();
		assert.equal(enabled.intervals[0]?.cleared, true);
		assert.equal(enabled.watchdog.isRunning(), false);

		const disabled = createHarness({ enabled: false });
		disabled.watchdog.start();
		assert.equal(disabled.intervals.length, 0);
		disabled.setRss(10 * GB);
		assert.equal(disabled.watchdog.tick(), undefined);
		assert.equal(disabled.reports.size, 0);
	});

	it("stays quiet below the threshold and bounds its sample history", () => {
		const harness = createHarness();
		for (let index = 0; index < MEMORY_WATCHDOG_HISTORY_SAMPLES + 10; index += 1) {
			assert.equal(harness.watchdog.tick(), undefined);
		}
		assert.equal(harness.watchdog.samples().length, MEMORY_WATCHDOG_HISTORY_SAMPLES);
		assert.equal(harness.reports.size, 0);
		assert.equal(harness.toasts.length, 0);
		assert.ok(harness.logs.every((log) => log.event === "memory.sample"));
	});

	it("writes a report plus one heap snapshot when RSS crosses the threshold", async () => {
		const harness = createHarness();
		harness.watchdog.tick();
		harness.setRss(1200 * MB, 300 * MB);
		const result = await tickAndSnapshot(harness);

		assert.ok(result);
		assert.equal(harness.reports.size, 1);
		const report = JSON.parse([...harness.reports.values()][0]!) as Record<string, any>;
		assert.equal(report.kind, "pix-memory-report");
		assert.match(report.reason, /RSS 1\.2 GB crossed 1\.0 GB/u);
		assert.deepEqual(report.app, { tabs: 2 });
		assert.equal(report.timeline.length, 2);
		assert.equal(report.current.rssMb, 1200);
		assert.equal(harness.snapshots.length, 1);
		assert.equal(result.heapSnapshotPath, harness.snapshots[0]);
		assert.match(harness.snapshots[0]!, /^\/reports\/pix-memory-.*\.heapsnapshot$/u);
		assert.ok(harness.toasts.some((toast) => toast.message.includes("UI may pause")));
		assert.match(harness.toasts.at(-1)!.message, /Leak report: \/reports\/pix-memory-/u);
		assert.ok(harness.logs.some((log) => log.event === "memory.threshold_exceeded" && log.level === "warn"));

		// Staying at the same level does not re-report.
		assert.equal(harness.watchdog.tick(), undefined);
		assert.equal(harness.reports.size, 1);
	});

	it("escalates by doubling and only snapshots the first report", async () => {
		const harness = createHarness();
		harness.setRss(1100 * MB);
		await tickAndSnapshot(harness);
		harness.setRss(1900 * MB);
		assert.equal(harness.watchdog.tick(), undefined);

		harness.setRss(2100 * MB);
		const second = await tickAndSnapshot(harness);
		assert.ok(second);
		assert.equal(second.heapSnapshotPath, undefined);
		assert.equal(second.thresholdBytes, 2048 * MB);
		assert.equal(harness.reports.size, 2);
		assert.equal(harness.snapshots.length, 1);

		// A jump over several doublings produces a single report.
		harness.setRss(20 * GB);
		const third = await tickAndSnapshot(harness);
		assert.equal(third?.thresholdBytes, 4096 * MB);
		assert.equal(harness.watchdog.tick(), undefined);
		harness.setRss(31 * GB);
		assert.equal(harness.watchdog.tick(), undefined);
	});

	it("does not count the snapshot's own RSS bump as the next doubling", async () => {
		let harness!: Harness;
		harness = createHarness({}, {
			writeHeapSnapshot: (path) => {
				// V8 serialization temporarily inflates RSS past the next doubling.
				harness.setRss(2200 * MB);
				return path;
			},
		});
		harness.setRss(1100 * MB);
		await tickAndSnapshot(harness);
		assert.equal(harness.watchdog.tick(), undefined);
		assert.equal(harness.reports.size, 1);
		harness.setRss(4200 * MB);
		assert.ok(await harness.watchdog.tick());
	});

	it("skips the heap snapshot when disabled or when the heap is too large", async () => {
		const disabled = createHarness({ heapSnapshot: false });
		disabled.setRss(2 * GB);
		const result = await tickAndSnapshot(disabled);
		assert.equal(result?.heapSnapshotPath, undefined);
		assert.equal(disabled.snapshots.length, 0);
		assert.equal(JSON.parse([...disabled.reports.values()][0]!).heapSnapshot, "disabled");

		const huge = createHarness();
		huge.setRss(9 * GB, MEMORY_WATCHDOG_MAX_SNAPSHOT_HEAP_BYTES + 1);
		await tickAndSnapshot(huge);
		assert.equal(huge.snapshots.length, 0);
		assert.match(JSON.parse([...huge.reports.values()][0]!).heapSnapshot, /^skipped: heap/u);
	});

	it("does not start a second report while one is still in flight", async () => {
		let releaseWrite!: () => void;
		const harness = createHarness({ heapSnapshot: false }, {
			writeReport: () => new Promise<void>((resolve) => {
				releaseWrite = resolve;
			}),
		});
		harness.setRss(1100 * MB);
		const first = harness.watchdog.tick();
		assert.ok(first);
		harness.setRss(5 * GB);
		assert.equal(harness.watchdog.tick(), undefined);
		releaseWrite();
		await first;
	});

	it("settles a pending snapshot on stop so a restart can report again", async () => {
		const harness = createHarness();
		harness.setRss(1100 * MB);
		const pending = harness.watchdog.tick();
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		harness.watchdog.stop();
		const result = await pending;
		assert.equal(result?.heapSnapshotPath, undefined);
		harness.runTimeouts();
		assert.equal(harness.snapshots.length, 0);

		harness.watchdog.updateConfig({ enabled: true, thresholdMb: 1024, heapSnapshot: true });
		assert.equal(harness.watchdog.isRunning(), true);
		harness.setRss(2100 * MB);
		const next = await tickAndSnapshot(harness);
		assert.ok(next);
		// The cancelled snapshot was never written, so the next report may take one.
		assert.equal(harness.snapshots.length, 1);
	});

	it("applies reloaded config: disable stops sampling, a new threshold re-arms", async () => {
		const harness = createHarness({ heapSnapshot: false });
		harness.watchdog.start();
		harness.watchdog.updateConfig({ enabled: false, thresholdMb: 1024, heapSnapshot: false });
		assert.equal(harness.watchdog.isRunning(), false);
		harness.setRss(3 * GB);
		assert.equal(harness.watchdog.tick(), undefined);

		harness.watchdog.updateConfig({ enabled: true, thresholdMb: 4096, heapSnapshot: false });
		assert.equal(harness.watchdog.isRunning(), true);
		assert.equal(harness.watchdog.tick(), undefined);
		harness.setRss(4100 * MB);
		assert.ok(await harness.watchdog.tick());
	});

	it("reports write failures without throwing and keeps only the newest reports", async () => {
		const failing = createHarness({ heapSnapshot: false }, {
			writeReport: async () => {
				throw new Error("disk full");
			},
		});
		failing.setRss(2 * GB);
		assert.equal(await failing.watchdog.tick(), undefined);
		assert.equal(failing.toasts.at(-1)?.kind, "error");
		assert.match(failing.toasts.at(-1)!.message, /disk full/u);

		const harness = createHarness();
		harness.files.push("unrelated.txt");
		let rss = 1100 * MB;
		for (let index = 0; index < MEMORY_WATCHDOG_MAX_REPORTS + 3; index += 1) {
			harness.setRss(rss);
			await tickAndSnapshot(harness);
			rss *= 2;
		}
		const reportFiles = harness.files.filter((name) => name.endsWith(".json"));
		assert.equal(reportFiles.length, MEMORY_WATCHDOG_MAX_REPORTS);
		// The first report's snapshot was pruned together with its report.
		assert.equal(harness.files.filter((name) => name.endsWith(".heapsnapshot")).length, 0);
		assert.ok(harness.files.includes("unrelated.txt"));
	});
});
