import { Worker } from "node:worker_threads";
import type { FileMentionMatch } from "./file-mentions.js";
import { logPixEvent } from "./app/logger.js";

/** One project per owner. All traversal, ignore rules, watching and ranking run off-thread. */
export class FileMentionIndex {
	private worker: Worker | undefined;
	private cwd = "";
	private sequence = 0;
	private readonly pending = new Map<number, { resolve: (matches: FileMentionMatch[]) => void; reject: (error: Error) => void; cleanup: () => void }>();

	query(cwd: string, query: string, signal?: AbortSignal): Promise<FileMentionMatch[]> {
		if (signal?.aborted) return Promise.resolve([]);
		if (this.cwd !== cwd || !this.worker) {
			this.dispose();
			this.cwd = cwd;
			const url = new URL(import.meta.url.endsWith(".ts") ? "./file-mention-worker.ts" : "./file-mention-worker.js", import.meta.url);
			// Production uses compiled JS; tsx registration is dev/test-only.
			const worker = url.pathname.endsWith(".ts")
				? new Worker(`import('tsx/esm/api').then(m => m.tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)}));`, { eval: true, workerData: { cwd } })
				: new Worker(url, { workerData: { cwd } });
			this.worker = worker;
			worker.on("message", (message: { id?: number; matches?: FileMentionMatch[]; error?: string; warning?: string }) => {
				if (this.worker !== worker) return;
				if (message.warning) logPixEvent("warn", "file_mentions.watch_failed", { message: message.warning });
				if (message.id === undefined) return;
				const request = this.pending.get(message.id);
				if (!request) return;
				if (message.error) { fail(new Error(message.error)); return; }
				this.pending.delete(message.id);
				request.cleanup();
				if (!this.pending.size) worker.unref();
				request.resolve(message.matches ?? []);
			});
			const fail = (error: Error) => {
				if (this.worker !== worker) return;
				logPixEvent("warn", "file_mentions.index_failed", { message: error.message });
				this.worker = undefined;
				for (const request of this.pending.values()) { request.cleanup(); request.reject(error); }
				this.pending.clear();
				void worker.terminate();
			};
			worker.on("error", fail);
			worker.on("exit", (code) => fail(new Error(`File mention worker exited (${code})`)));
			worker.unref();
		}
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const abort = () => {
				this.pending.delete(id);
				this.worker?.postMessage({ id, cancel: true });
				if (!this.pending.size) this.worker?.unref();
				resolve([]);
			};
			signal?.addEventListener("abort", abort, { once: true });
			this.pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) });
			this.worker!.ref();
			this.worker!.postMessage({ id, query: query.slice(0, 256) });
		});
	}

	dispose(): void {
		const worker = this.worker;
		this.worker = undefined;
		this.cwd = "";
		for (const request of this.pending.values()) { request.cleanup(); request.resolve([]); }
		this.pending.clear();
		if (worker) void worker.terminate();
	}
}
