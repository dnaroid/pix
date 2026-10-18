import { Worker } from "node:worker_threads";
import type { CollectWorkerData, CollectWorkerRequest, CollectWorkerResponse } from "./collect-worker-protocol.js";
import type { LocalUsageCollectResult, LocalUsageCollector, LocalUsagePartial } from "./local-source.js";
import type { UsageStatsLog } from "./service.js";
import type { UsageSourceId, UsageSourceSnapshot } from "./types.js";

type Pending = {
	resolve: (result: LocalUsageCollectResult) => void;
	reject: (error: unknown) => void;
	onPartial: LocalUsagePartial | undefined;
	cleanup: () => void;
};

export type WorkerCollectorOptions = {
	id: UsageSourceId;
	roots: () => readonly string[];
	/** Used permanently when the worker cannot start. */
	fallback: () => LocalUsageCollector;
	log?: UsageStatsLog;
	partialWindowMs?: number;
	/** Test seam; defaults to the sibling `collect-worker` module. */
	workerUrl?: URL;
	readyTimeoutMs?: number;
	snapshotPath?: string;
};

const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** Sibling `collect-worker` with the extension of this module (`.js` in dist, `.ts` under tsx). */
export function defaultCollectWorkerUrl(): URL {
	const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
	return new URL(`./collect-worker${extension}`, import.meta.url);
}

/**
 * Runs a local JSONL collector in a worker thread. The worker keeps the warm
 * per-file cache between collections; a crash rejects in-flight calls and the
 * next collection respawns it. If the worker cannot start at all, collection
 * falls back to an in-process collector for the rest of the session.
 */
export class WorkerCollector implements LocalUsageCollector {
	private worker: Worker | undefined;
	private starting: Promise<Worker | undefined> | undefined;
	private inProcess: LocalUsageCollector | undefined;
	private readonly pending = new Map<number, Pending>();
	private readonly restores = new Map<number, { resolve: (snapshot: UsageSourceSnapshot | undefined) => void; reject: (error: unknown) => void }>();
	private nextId = 1;
	private disposed = false;

	constructor(private readonly options: WorkerCollectorOptions) {}

	get id(): UsageSourceId {
		return this.options.id;
	}

	async restore(): Promise<UsageSourceSnapshot | undefined> {
		if (this.disposed) return undefined;
		const worker = this.inProcess ? undefined : await this.ensureWorker();
		if (this.disposed) return undefined;
		if (!worker) return this.inProcess?.restore?.();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.restores.set(id, { resolve, reject });
			worker.ref();
			this.post(worker, { type: "restore", id });
		});
	}

	async collect(signal?: AbortSignal, onPartial?: LocalUsagePartial): Promise<LocalUsageCollectResult> {
		signal?.throwIfAborted();
		if (this.disposed) throw new Error("Usage collector disposed");
		const worker = this.inProcess ? undefined : await this.ensureWorker();
		signal?.throwIfAborted();
		if (!worker) {
			this.inProcess ??= this.options.fallback();
			return await this.inProcess.collect(signal, onPartial);
		}
		const id = this.nextId++;
		return await new Promise<LocalUsageCollectResult>((resolve, reject) => {
			const abort = () => {
				this.settle(id)?.reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
				this.post(worker, { type: "abort", id });
			};
			signal?.addEventListener("abort", abort, { once: true });
			this.pending.set(id, { resolve, reject, onPartial, cleanup: () => signal?.removeEventListener("abort", abort) });
			worker.ref();
			this.post(worker, { type: "collect", id, roots: [...this.options.roots()] });
		});
	}

	dispose(): void {
		this.disposed = true;
		const error = new Error("Usage collector disposed");
		for (const id of [...this.pending.keys()]) this.settle(id)?.reject(error);
		for (const entry of this.restores.values()) entry.reject(error);
		this.restores.clear();
		void this.worker?.terminate().catch(() => undefined);
		this.worker = undefined;
		this.inProcess?.dispose?.();
	}

	private ensureWorker(): Promise<Worker | undefined> {
		if (this.worker) return Promise.resolve(this.worker);
		this.starting ??= this.start().finally(() => { this.starting = undefined; });
		return this.starting;
	}

	private start(): Promise<Worker | undefined> {
		return new Promise((resolve) => {
			let worker: Worker;
			const data: CollectWorkerData = {
				...(this.options.partialWindowMs === undefined ? {} : { partialWindowMs: this.options.partialWindowMs }),
				...(this.options.snapshotPath ? { snapshotPath: this.options.snapshotPath } : {}),
			};
			try {
				worker = new Worker(this.options.workerUrl ?? defaultCollectWorkerUrl(), { workerData: data });
			} catch (error) {
				resolve(this.startFailed(error));
				return;
			}
			worker.unref();
			let ready = false;
			// `error` and `exit` both fire for a failed start; settle the start once.
			let settled = false;
			const fail = (error: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				void worker.terminate().catch(() => undefined);
				resolve(this.startFailed(error));
			};
			const timer = setTimeout(() => fail(new Error("ReadyTimeout")), this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
			timer.unref();

			worker.on("message", (message: CollectWorkerResponse) => {
				if (message.type === "ready") {
					if (ready || settled) return;
					ready = true;
					settled = true;
					clearTimeout(timer);
					if (this.disposed) {
						void worker.terminate().catch(() => undefined);
						resolve(undefined);
						return;
					}
					this.worker = worker;
					resolve(worker);
					return;
				}
				this.handle(message);
			});
			worker.on("error", (error) => {
				if (!ready) {
					fail(error);
					return;
				}
				this.crashed(worker, error instanceof Error ? error : new Error("WorkerError"));
			});
			worker.on("exit", (code) => {
				if (!ready) {
					fail(new Error(`Exit ${code}`));
					return;
				}
				this.crashed(worker, new Error(`Usage worker exited (${code})`));
			});
		});
	}

	private startFailed(error: unknown): undefined {
		if (!this.disposed) {
			this.log("warn", "usage_stats.worker_unavailable", { source: this.options.id, error: error instanceof Error ? error.name : "Error" });
			// Fall back for the rest of the session instead of retrying a broken worker.
			this.inProcess ??= this.options.fallback();
		}
		return undefined;
	}

	private crashed(worker: Worker, error: Error): void {
		if (this.worker !== worker) return;
		this.worker = undefined;
		if (this.disposed) return;
		this.log("warn", "usage_stats.worker_crashed", { source: this.options.id, error: error.name });
		for (const id of [...this.pending.keys()]) this.settle(id)?.reject(error);
		for (const entry of this.restores.values()) entry.reject(error);
		this.restores.clear();
	}

	private handle(message: CollectWorkerResponse): void {
		if (message.type === "ready") return;
		if (message.type === "log") {
			this.log(message.level, message.event, message.details ?? {});
			return;
		}
		if (message.type === "restored") {
			const entry = this.restores.get(message.id);
			this.restores.delete(message.id);
			entry?.resolve(message.snapshot);
			this.unrefIfIdle();
			return;
		}
		if (message.type === "partial") {
			try {
				this.pending.get(message.id)?.onPartial?.(message.snapshot);
			} catch {
				// A failing listener must not break collection.
			}
			return;
		}
		const entry = this.settle(message.id);
		if (!entry) return;
		if (message.type === "result") entry.resolve(message.result);
		else entry.reject(Object.assign(new Error("Usage collection failed in worker"), { name: message.error }));
	}

	private settle(id: number): Pending | undefined {
		const entry = this.pending.get(id);
		if (!entry) return undefined;
		this.pending.delete(id);
		entry.cleanup();
		this.unrefIfIdle();
		return entry;
	}

	private unrefIfIdle(): void {
		if (this.pending.size === 0 && this.restores.size === 0) this.worker?.unref();
	}

	private post(worker: Worker, message: CollectWorkerRequest): void {
		try {
			worker.postMessage(message);
		} catch {
			// The exit/error handler rejects pending calls.
		}
	}

	private log(level: "info" | "warn" | "error", event: string, details: Record<string, unknown>): void {
		try {
			this.options.log?.(level, event, details);
		} catch {
			// Logging must never change collection behavior.
		}
	}
}
