import type { LocalUsageCollectResult } from "./local-source.js";
import type { UsageSourceSnapshot } from "./types.js";

/** Worker data for `collect-worker`. */
export type CollectWorkerData = { partialWindowMs?: number };

export type CollectWorkerRequest =
	| { type: "collect"; id: number; roots: string[] }
	| { type: "abort"; id: number };

export type CollectWorkerResponse =
	| { type: "ready" }
	| { type: "partial"; id: number; snapshot: UsageSourceSnapshot }
	| { type: "result"; id: number; result: LocalUsageCollectResult }
	| { type: "error"; id: number; error: string };
