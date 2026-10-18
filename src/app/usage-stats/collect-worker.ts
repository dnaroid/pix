import { parentPort, workerData } from "node:worker_threads";
import type { CollectWorkerData, CollectWorkerRequest, CollectWorkerResponse } from "./collect-worker-protocol.js";
import { createPixSessionsSource } from "./pix-sessions.js";
import { CachedUsageCollector } from "./snapshot-cache.js";

/**
 * Worker-thread entry: owns the Pix session JSONL cache so cold parsing of
 * large session logs never blocks the host event loop. Roots arrive with
 * every request; the main thread resolves them.
 */
const port = parentPort;
if (port) {
	const data = (workerData ?? {}) as CollectWorkerData;
	let roots: string[] = [];
	const local = createPixSessionsSource({
		roots: () => roots,
		...(data.partialWindowMs === undefined ? {} : { partialWindowMs: data.partialWindowMs }),
	});
	const controllers = new Map<number, AbortController>();
	const post = (message: CollectWorkerResponse) => port.postMessage(message);
	const source = data.snapshotPath ? new CachedUsageCollector(local, data.snapshotPath,
		(level, event, details) => post({ type: "log", level, event, ...(details ? { details } : {}) })) : local;

	port.on("message", (message: CollectWorkerRequest) => {
		if (message.type === "restore") {
			void (source instanceof CachedUsageCollector ? source.restore() : Promise.resolve(undefined))
				.then((snapshot) => post({ type: "restored", id: message.id, ...(snapshot ? { snapshot } : {}) }));
			return;
		}
		if (message.type === "abort") {
			controllers.get(message.id)?.abort();
			return;
		}
		const controller = new AbortController();
		controllers.set(message.id, controller);
		roots = message.roots;
		source.collect(controller.signal, (snapshot) => post({ type: "partial", id: message.id, snapshot }))
			.then(
				(result) => { if (!controller.signal.aborted) post({ type: "result", id: message.id, result }); },
				(error: unknown) => {
					if (!controller.signal.aborted) post({ type: "error", id: message.id, error: error instanceof Error ? error.name : "Error" });
				},
			)
			.finally(() => { controllers.delete(message.id); });
	});
	post({ type: "ready" });
}
