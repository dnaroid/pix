import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const controller = new AbortController();
let profiler: { start(): Promise<unknown>; stop(): Promise<void>; requestCapture(): void } | undefined;
let started = false;
let lastHeartbeat = Date.now();
let heartbeat: unknown;
let stallCaptured = false;
process.on("disconnect", () => { controller.abort(); void profiler?.stop(); });
process.on("SIGTERM", () => { controller.abort(); void profiler?.stop(); });
process.on("message", (message: any) => {
	if (message?.event === "heartbeat") {
		lastHeartbeat = Date.now();
		heartbeat = message;
	} else if (!started && message?.event === "start") {
		started = true;
		void monitor(message.thresholdMb).catch(() => { controller.abort(); process.exitCode = 1; })
			.finally(() => { if (process.connected) process.disconnect?.(); });
	}
});

async function monitor(thresholdMb: number): Promise<void> {
	if (!Number.isFinite(thresholdMb) || thresholdMb < 64 || thresholdMb > 1024) throw new Error("invalid threshold");
	// These shared, bounded collectors are also used by the standalone launcher.
	const { PixMemoryProfiler, parseRssKb } = await import(new URL("../../../scripts/pix-memory-profiler.mjs", import.meta.url).href);
	const { captureMacProcess } = await import(new URL("../../../scripts/profile-pix-memory.mjs", import.meta.url).href);
	if (controller.signal.aborted) return;
	const root = join(homedir(), ".config", "pi", "memory-traces");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const directory = join(root, `${new Date().toISOString().replaceAll(":", "-")}-${process.ppid}`);
	await mkdir(directory, { mode: 0o700 });
	if (controller.signal.aborted) return;
	const pid = process.ppid;
	const monitorProfiler = new PixMemoryProfiler({
		thresholdMb,
		readRss: async (signal: AbortSignal) => {
			if (!stallCaptured && Date.now() - lastHeartbeat >= 10_000) {
				stallCaptured = true;
				monitorProfiler.requestCapture();
			}
			return parseRssKb((await execute("/bin/ps", ["-o", "rss=", "-p", String(pid)], {
				signal, timeout: 2000, killSignal: "SIGKILL", maxBuffer: 4096,
			})).stdout);
		},
		writeEvent: (event: Record<string, unknown>) => appendFile(join(directory, "trace.jsonl"), `${JSON.stringify({
			...event, heartbeatAgeMs: Date.now() - lastHeartbeat, lastMainThread: heartbeat,
		})}\n`, { mode: 0o600 }),
		capture: (request: unknown) => captureMacProcess(pid, directory, request),
	});
	profiler = monitorProfiler;
	controller.signal.addEventListener("abort", () => { void monitorProfiler.stop(); }, { once: true });
	await writeFile(join(directory, "run.json"), JSON.stringify({ pid, monitorPid: process.pid, thresholdMb, node: process.version }), { mode: 0o600 });
	if (controller.signal.aborted) return;
	process.send?.({ event: "ready", directory }, () => {});
	let summary;
	try { summary = await monitorProfiler.start(); }
	catch (error) { summary = { error: String(error) }; }
	finally { await monitorProfiler.stop(); }
	await writeFile(join(directory, "summary.json"), JSON.stringify(summary), { mode: 0o600 });
}
