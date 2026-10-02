import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { PixMemoryProfiler, parseRssKb, supervisePix } from "../scripts/pix-memory-profiler.mjs";
import { parseProfileArgs } from "../scripts/profile-pix-memory.mjs";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function fixture(overrides: Record<string, unknown> = {}) {
	const events: any[] = [];
	const captures: any[] = [];
	const profiler = new PixMemoryProfiler({
		readRss: async () => 128 * 1024,
		writeEvent: async (event: unknown) => { events.push(event); },
		capture: async (request: unknown) => { captures.push(request); },
		intervalMs: 10, maxSamples: 3,
		...overrides,
	});
	return { profiler, events, captures };
}

describe("external Pix memory profiler", () => {
	it("parses ps KiB and rejects malformed or unsafe measurements", () => {
		assert.equal(parseRssKb(" 123456\n"), 123456);
		assert.equal(parseRssKb("0\n"), 0);
		for (const value of ["", "-3", "12 34", "abc", "1.5", "99999999999999999999"]) {
			assert.throws(() => parseRssKb(value));
		}
	});

	it("passes Pix arguments verbatim only after the separator", () => {
		assert.deepEqual(parseProfileArgs(["--threshold-mb", "256", "--", "--session", "a b.jsonl"]), {
			thresholdMb: 256, output: undefined, pixArgs: ["--session", "a b.jsonl"],
		});
		for (const args of [["--session"], ["--threshold-mb"], ["--threshold-mb", "NaN"],
			["--threshold-mb", "0"], ["--threshold-mb", "65537"], ["--output"]]) {
			assert.throws(() => parseProfileArgs(args));
		}
	});

	it("bounds samples, converts RSS units, and does not capture below threshold", async () => {
		const { profiler, events, captures } = fixture();
		assert.deepEqual(await profiler.start(), { samples: 3, peakRssMb: 128, captureAttempts: 0 });
		assert.equal(events.length, 3);
		assert.equal(events[0].rssMb, 128);
		assert.equal(captures.length, 0);
	});

	it("captures a sustained runaway threshold only once", async () => {
		const { profiler, captures } = fixture({ readRss: async () => 2048 * 1024 });
		await profiler.start();
		assert.deepEqual(captures.map(({ reason, index }) => ({ reason, index })), [{ reason: "rss-threshold", index: 1 }]);
	});

	it("coalesces manual requests and caps all captures at two", async () => {
		let profiler: PixMemoryProfiler;
		const result = fixture({
			readRss: async () => { profiler.requestCapture(); profiler.requestCapture(); return 128 * 1024; },
		});
		profiler = result.profiler;
		await profiler.start();
		assert.equal(result.captures.length, 2);
		assert.ok(result.captures.every(({ reason }) => reason === "manual"));
	});

	it("starts once and serializes a slow log write with subsequent sampling", async () => {
		const entered = deferred();
		const release = deferred();
		let reads = 0;
		const { profiler } = fixture({
			readRss: async () => { reads += 1; return 128 * 1024; },
			writeEvent: async () => { entered.resolve(); await release.promise; },
		});
		const running = profiler.start();
		assert.equal(profiler.start(), running);
		await entered.promise;
		assert.equal(reads, 1);
		const stopping = profiler.stop();
		release.resolve();
		await stopping;
		assert.equal(reads, 1);
	});

	it("discards an RSS result that completes after shutdown", async () => {
		const read = deferred<number>();
		const { profiler, events, captures } = fixture({ readRss: () => read.promise });
		profiler.start();
		const stopping = profiler.stop();
		read.resolve(4096 * 1024);
		await stopping;
		assert.equal(events.length, 0);
		assert.equal(captures.length, 0);
	});

	it("aborts an in-flight capture and does not retain poll timers", async () => {
		const entered = deferred();
		const { profiler, events } = fixture({
			readRss: async () => 2048 * 1024,
			capture: async ({ signal }: { signal: AbortSignal }) => {
				entered.resolve();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			},
		});
		profiler.start();
		await entered.promise;
		await profiler.stop();
		assert.equal(profiler.sampleCount, 1);
		assert.ok(events.some(({ event }) => event === "capture-start"));
		assert.ok(!events.some(({ event }) => event === "capture-finished"));
		profiler.requestCapture();
		assert.equal(profiler.manualRequested, false);
	});

	it("surfaces failed measurement/log I/O instead of silently claiming coverage", async () => {
		for (const overrides of [{ readRss: async () => { throw new Error("ps unavailable"); } },
			{ writeEvent: async () => { throw new Error("disk full"); } }]) {
			const { profiler } = fixture(overrides);
			await assert.rejects(profiler.start(), /ps unavailable|disk full/u);
			await assert.rejects(profiler.stop(), /ps unavailable|disk full/u);
		}
	});

	it("rejects invalid scheduling bounds", () => {
		for (const overrides of [{ thresholdMb: NaN }, { thresholdMb: 0 }, { intervalMs: 0 }, { maxSamples: -1 }]) {
			assert.throws(() => fixture(overrides));
		}
	});
});

describe("profiled Pix child ownership", () => {
	function childFixture() {
		const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => void };
		const forwarded: string[] = [];
		child.kill = (signal: string) => { forwarded.push(signal); };
		return { child, forwarded, signalSource: new EventEmitter() };
	}

	function assertReleased(child: EventEmitter, signals: EventEmitter) {
		for (const event of ["SIGINT", "SIGTERM", "SIGUSR1"]) assert.equal(signals.listenerCount(event), 0);
		assert.equal(child.listenerCount("error"), 0);
		assert.equal(child.listenerCount("exit"), 0);
	}

	it("observes a fast child exit while initial report I/O is pending", async () => {
		const report = deferred();
		const { child, signalSource } = childFixture();
		let reads = 0;
		const { profiler } = fixture({ readRss: async () => { reads += 1; return 1024; } });
		const running = supervisePix(child, profiler, { signalSource, onStarted: () => report.promise });
		child.emit("exit", 7, null);
		report.resolve();
		assert.equal((await running).code, 7);
		assert.equal(reads, 0);
		assertReleased(child, signalSource);
	});

	it("handles asynchronous spawn failure without starting ps for an absent child", async () => {
		const report = deferred();
		const { child, signalSource } = childFixture();
		let reads = 0;
		const { profiler } = fixture({ readRss: async () => { reads += 1; throw new Error("absent PID"); } });
		const running = supervisePix(child, profiler, { signalSource, onStarted: () => report.promise });
		child.emit("error", new Error("spawn failed"));
		report.resolve();
		assert.equal((await running).error, "spawn failed");
		assert.equal(reads, 0);
		assertReleased(child, signalSource);
	});

	it("forwards monitor-only termination once and waits for owned Pix to exit", async () => {
		const { child, forwarded, signalSource } = childFixture();
		const started = deferred();
		const { profiler } = fixture({ readRss: async () => { started.resolve(); return 128 * 1024; } });
		const running = supervisePix(child, profiler, { signalSource });
		await started.promise;
		signalSource.emit("SIGTERM");
		signalSource.emit("SIGTERM");
		signalSource.emit("SIGINT");
		assert.deepEqual(forwarded, ["SIGTERM"]);
		assert.equal(profiler.controller.signal.aborted, false);
		// A blocked/ignoring Pix remains inspectable rather than being force-killed.
		signalSource.emit("SIGUSR1");
		assert.equal(profiler.manualRequested, true);
		child.emit("exit", null, "SIGTERM");
		assert.equal((await running).signal, "SIGTERM");
		assert.equal(profiler.controller.signal.aborted, true);
		assertReleased(child, signalSource);
	});

	it("does not orphan Pix when report or diagnostic logging fails", async () => {
		const { child, forwarded, signalSource } = childFixture();
		const started = deferred();
		const { profiler } = fixture({ readRss: async () => { started.resolve(); return 128 * 1024; } });
		const running = supervisePix(child, profiler, {
			signalSource,
			onStarted: () => { throw new Error("disk full"); },
			onMonitorError: () => { throw new Error("stderr unavailable"); },
		});
		await started.promise;
		child.emit("exit", 0, null);
		assert.equal((await running).monitorError, "disk full");
		assert.deepEqual(forwarded, []);
		assertReleased(child, signalSource);
	});

	it("handles a failed ps result racing with child exit and cancels owned work", async () => {
		const { child, signalSource } = childFixture();
		const entered = deferred();
		const result = deferred<number>();
		const { profiler, events } = fixture({ readRss: async () => { entered.resolve(); return result.promise; } });
		const running = supervisePix(child, profiler, { signalSource });
		await entered.promise;
		child.emit("error", new Error("late spawn failure"));
		await Promise.resolve();
		result.resolve(NaN);
		assert.equal((await running).error, "late spawn failure");
		assert.equal(events.length, 0);
		assertReleased(child, signalSource);
	});
});
