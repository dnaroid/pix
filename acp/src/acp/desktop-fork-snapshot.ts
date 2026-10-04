import { Worker } from "node:worker_threads";

/** Captured in the RPC process synchronously at a safe turn boundary. */
export interface DesktopForkSnapshot {
	readonly sessionPath: string;
	readonly leafId: string | null;
	readonly cwd: string;
	/** A fresh SDK session can have model/settings entries not flushed to disk yet. */
	readonly unflushedEntries?: readonly Record<string, unknown>[];
}

export interface DesktopForkChild {
	readonly sessionPath: string;
	readonly piSessionId: string;
}

/** SDK file loading/branch serialization is synchronous: keep it off the host loop. */
export function createDesktopForkSnapshot(snapshot: DesktopForkSnapshot): Promise<DesktopForkChild> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./desktop-fork-snapshot-worker.js", import.meta.url), { workerData: snapshot });
		let settled = false;
		worker.once("message", (result: { child?: DesktopForkChild; error?: string }) => {
			settled = true;
			if (result.child) resolve(result.child);
			else reject(new Error(result.error ?? "fork snapshot worker returned no child"));
		});
		worker.once("error", reject);
		worker.once("exit", (code) => {
			if (!settled) reject(new Error(`fork snapshot worker exited before completion (${code})`));
		});
	});
}
