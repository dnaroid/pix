import { setTimeout as delay } from "node:timers/promises";

export function parseRssKb(output) {
	const value = output.trim();
	if (!/^\d+$/u.test(value)) throw new Error("ps did not return RSS in KiB");
	const rssKb = Number(value);
	if (!Number.isSafeInteger(rssKb)) throw new Error("invalid RSS value");
	return rssKb;
}

/** One poll/capture at a time, owned by an external process rather than Pix's event loop. */
export class PixMemoryProfiler {
	constructor({ readRss, writeEvent, capture, thresholdMb = 1024, intervalMs = 1000, maxSamples = 3600 }) {
		if (!Number.isFinite(thresholdMb) || thresholdMb <= 0) throw new Error("invalid RSS threshold");
		if (!Number.isSafeInteger(intervalMs) || intervalMs < 10) throw new Error("invalid sample interval");
		if (!Number.isSafeInteger(maxSamples) || maxSamples < 1) throw new Error("invalid sample limit");
		Object.assign(this, { readRss, writeEvent, capture, thresholdMb, intervalMs, maxSamples });
		this.controller = new AbortController();
		this.manualRequested = false;
		this.thresholdCaptured = false;
		this.captureCount = 0;
		this.sampleCount = 0;
		this.peakRssMb = 0;
	}

	requestCapture() {
		if (!this.controller.signal.aborted && this.captureCount < 2) this.manualRequested = true;
	}

	start() {
		this.running ??= this.run();
		return this.running;
	}

	async stop() {
		this.controller.abort();
		await this.running;
	}

	async run() {
		const { signal } = this.controller;
		try {
			while (!signal.aborted && this.sampleCount < this.maxSamples) {
				const rssMb = await this.readRss(signal) / 1024;
				if (signal.aborted) break;
				if (!Number.isFinite(rssMb) || rssMb < 0) throw new Error("invalid RSS sample");
				this.sampleCount += 1;
				this.peakRssMb = Math.max(this.peakRssMb, rssMb);
				await this.writeEvent({ event: "sample", at: new Date().toISOString(), rssMb });
				if (signal.aborted) break;
				let reason;
				if (this.manualRequested) reason = "manual";
				else if (!this.thresholdCaptured && rssMb >= this.thresholdMb) reason = "rss-threshold";
				if (reason && this.captureCount < 2) {
					this.manualRequested = false;
					if (reason === "rss-threshold") this.thresholdCaptured = true;
					const index = ++this.captureCount;
					await this.writeEvent({ event: "capture-start", at: new Date().toISOString(), reason, index, rssMb });
					if (signal.aborted) break;
					await this.capture({ reason, index, signal });
					if (signal.aborted) break;
					await this.writeEvent({ event: "capture-finished", at: new Date().toISOString(), index });
				}
				if (this.sampleCount < this.maxSamples) await delay(this.intervalMs, undefined, { signal });
			}
		} catch (error) {
			if (!signal.aborted) throw error;
		}
		return { samples: this.sampleCount, peakRssMb: this.peakRssMb, captureAttempts: this.captureCount };
	}
}

/**
 * Own child-exit and signal subscriptions before awaiting any report I/O.
 * @param {import("node:events").EventEmitter & { kill: (signal: string) => unknown }} child
 * @param {PixMemoryProfiler} profiler
 * @param {{ signalSource?: Pick<import("node:events").EventEmitter, "on" | "off">,
 * onStarted?: () => void | Promise<void>, onMonitorError?: (message: string) => void,
 * onSampleLimit?: () => void }} options
 */
export async function supervisePix(child, profiler, {
	signalSource = process, onStarted = async () => {}, onMonitorError = () => {}, onSampleLimit = () => {},
} = {}) {
	let exited = false;
	let stopping = false;
	let monitorError;
	let resolveExit;
	const done = new Promise((resolve) => { resolveExit = resolve; });
	const childError = (error) => { exited = true; resolveExit({ error: error.message }); };
	const childExit = (code, signal) => { exited = true; resolveExit({ code, signal }); };
	child.once("error", childError);
	child.once("exit", childExit);
	const requestCapture = () => profiler.requestCapture();
	const terminalSignal = (signal) => {
		if (!exited && !stopping) { stopping = true; child.kill(signal); }
	};
	const interrupt = () => terminalSignal("SIGINT");
	const terminate = () => terminalSignal("SIGTERM");
	signalSource.on("SIGINT", interrupt);
	signalSource.on("SIGTERM", terminate);
	signalSource.on("SIGUSR1", requestCapture);
	function reportError(error) {
		monitorError ??= error.message;
		try { onMonitorError(error.message); } catch { /* Diagnostics must not kill Pix. */ }
	}
	try {
		await Promise.resolve().then(onStarted).catch(reportError);
		if (!exited) void profiler.start().then((summary) => {
			if (!exited && summary.samples === profiler.maxSamples) onSampleLimit();
		}).catch(reportError);
		const exit = await done;
		await profiler.stop().catch(reportError);
		return {
			...exit, samples: profiler.sampleCount, peakRssMb: profiler.peakRssMb,
			captureAttempts: profiler.captureCount, monitorError,
		};
	} finally {
		await profiler.stop().catch(() => {});
		signalSource.off("SIGINT", interrupt);
		signalSource.off("SIGTERM", terminate);
		signalSource.off("SIGUSR1", requestCapture);
		child.off("error", childError);
		child.off("exit", childExit);
	}
}
