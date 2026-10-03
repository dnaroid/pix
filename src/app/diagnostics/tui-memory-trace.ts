import { fork, type ChildProcess } from "node:child_process";
import { writeFile, rename, rm } from "node:fs/promises";
import { Session } from "node:inspector";
import { join } from "node:path";

export const TUI_MEMORY_TRACE_INTERVAL_MS = 1_000;
export const TUI_MEMORY_TRACE_PROFILE_EVERY = 30;
export const TUI_MEMORY_TRACE_MAX_PROFILE_BYTES = 8 * 1024 ** 2;

type Inspector = Pick<Session, "connect" | "disconnect"> & {
	post(method: string, params: Record<string, unknown>, callback: (error: Error | null, result?: any) => void): void;
};
type TraceRun = {
	controller: AbortController;
	child: ChildProcess;
	inspector?: Inspector;
	timer?: ReturnType<typeof setInterval>;
	active: boolean;
	sending: boolean;
	profiling: boolean;
	sampling: boolean;
	ticks: number;
	profiles: number;
	directory?: string;
	dispose(): void;
};
export type TuiMemoryTraceDeps = {
	enabled: boolean;
	fork(): ChildProcess;
	inspector(): Inspector;
	memoryUsage(): NodeJS.MemoryUsage;
	writeProfile(path: string, contents: string, signal: AbortSignal): Promise<void>;
	setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
	clearInterval(timer: ReturnType<typeof setInterval>): void;
	log(event: string, details: Record<string, unknown>): void;
};

/** Opt-in incident tooling. No draft/message contents cross this boundary. */
export class TuiMemoryTrace {
	private readonly deps: TuiMemoryTraceDeps;
	private run: TraceRun | undefined;

	get enabled(): boolean { return this.deps.enabled; }

	constructor(private readonly context: () => Record<string, unknown>, deps: Partial<TuiMemoryTraceDeps> = {}) {
		this.deps = {
			enabled: process.env.PIX_MEMORY_TRACE === "1" && process.platform === "darwin",
			fork: () => fork(new URL(import.meta.url.endsWith(".ts") ? "./tui-memory-trace-worker.ts" : "./tui-memory-trace-worker.js", import.meta.url), [], {
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [],
			}),
			inspector: () => new Session(),
			memoryUsage: () => process.memoryUsage(),
			writeProfile: async (path, contents, signal) => {
				try {
					await writeFile(`${path}.tmp`, contents, { mode: 0o600, signal });
					if (!signal.aborted) await rename(`${path}.tmp`, path);
				} finally {
					await rm(`${path}.tmp`, { force: true });
				}
			},
			setInterval, clearInterval,
			log: () => {},
			...deps,
		};
	}

	start(thresholdMb: number): void {
		if (!this.deps.enabled || this.run) return;
		try {
			const child = this.deps.fork();
			const run: TraceRun = { child, controller: new AbortController(), active: true, sending: false, profiling: false, sampling: false, ticks: 0, profiles: 0, dispose: () => {} };
			this.run = run;
			const dispose = () => {
				if (!run.active) return;
				run.active = false;
				run.controller.abort();
				if (run.timer) this.deps.clearInterval(run.timer);
				try { run.inspector?.disconnect(); } catch { /* Best effort. */ }
				child.off("message", message);
				child.off("exit", dispose);
				// Retain error handling until exit: shutdown can race an IPC failure.
				if (child.connected) child.disconnect();
				if (this.run === run) this.run = undefined;
			};
			run.dispose = dispose;
			const message = (value: any) => {
				if (!run.active || value?.event !== "ready" || typeof value.directory !== "string" || run.directory) return;
				run.directory = value.directory;
				this.log("memory.trace_started", { directory: value.directory, monitorPid: child.pid });
				this.heartbeat(run);
			};
			child.on("message", message);
			child.once("exit", dispose);
			const childError = (error: Error) => { this.log("memory.trace_error", { error: error.message }); dispose(); };
			child.on("error", childError);
			child.once("exit", () => child.off("error", childError));
			child.send({ event: "start", thresholdMb: Math.max(64, Math.min(1024, thresholdMb)) }, (error) => {
				if (error) { this.log("memory.trace_error", { error: error.message }); dispose(); }
			});
			child.unref();
			child.channel?.unref();
			if (!run.active) return;
			try {
				run.inspector = this.deps.inspector();
				run.inspector.connect();
				run.inspector.post("HeapProfiler.startSampling", { samplingInterval: 512 * 1024 }, (error) => {
					if (!run.active) return;
					if (error) this.log("memory.trace_profile_error", { error: error.message });
					else run.sampling = true;
				});
			} catch (error) { this.log("memory.trace_profile_error", { error: String(error) }); }
			if (run.active) {
				run.timer = this.deps.setInterval(() => this.heartbeat(run), TUI_MEMORY_TRACE_INTERVAL_MS);
				run.timer.unref();
			}
		} catch (error) {
			this.stop();
			this.log("memory.trace_error", { error: String(error) });
		}
	}

	stop(): void {
		this.run?.dispose();
	}

	private heartbeat(run: TraceRun): void {
		if (!run.active || !run.child.connected || run.sending) return;
		try {
			// Only primitive numeric/boolean counters, never arbitrary host strings/objects.
			const app = Object.fromEntries(Object.entries(this.context()).filter(([, value]) =>
				typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))));
			run.sending = true;
			run.child.send({ event: "heartbeat", at: Date.now(), memory: this.deps.memoryUsage(), app }, (error) => {
				run.sending = false;
				if (error && run.active) { this.log("memory.trace_error", { error: error.message }); run.dispose(); }
			});
			run.ticks += 1;
			if (run.sampling && run.directory && !run.profiling && run.ticks % TUI_MEMORY_TRACE_PROFILE_EVERY === 0) this.profile(run);
		} catch (error) { run.sending = false; this.log("memory.trace_error", { error: String(error) }); }
	}

	private profile(run: TraceRun): void {
		run.profiling = true;
		try {
			run.inspector!.post("HeapProfiler.getSamplingProfile", {}, (error, result) => {
				if (!run.active) { run.profiling = false; return; }
				if (error) {
					run.profiling = false;
					this.log("memory.trace_profile_error", { error: error.message });
					return;
				}
				try {
					const contents = JSON.stringify(result?.profile ?? {});
					if (Buffer.byteLength(contents) > TUI_MEMORY_TRACE_MAX_PROFILE_BYTES) {
						run.profiling = false;
						this.log("memory.trace_profile_skipped", { reason: "profile size limit" });
						return;
					}
					const path = join(run.directory!, `allocations-${run.profiles++ % 3}.heapprofile`);
					void this.deps.writeProfile(path, contents, run.controller.signal).catch((error: unknown) => {
						if (run.active) this.log("memory.trace_profile_error", { error: String(error) });
					}).finally(() => { run.profiling = false; });
				} catch (error) { run.profiling = false; this.log("memory.trace_profile_error", { error: String(error) }); }
			});
		} catch (error) { run.profiling = false; this.log("memory.trace_profile_error", { error: String(error) }); }
	}

	private log(event: string, details: Record<string, unknown>): void {
		try { this.deps.log(event, details); } catch { /* Incident tooling must not kill Pix. */ }
	}
}
