import { join } from "node:path";
import { usageFromEntry } from "../session/session-usage.js";
import type { JsonlParser } from "./jsonl-tail-cache.js";
import { LocalUsageSource } from "./local-source.js";
import { isRecord, stringValue, timestampMs } from "./parse-utils.js";
import type { LocalUsageEvent } from "./types.js";

type PixState = { sessionId: string; file: string; cwd?: string };

/**
 * Pix/Pi session JSONL of every project, using the shared `usageFromEntry`
 * accounting of `wiki/usage/session-usage.md`. The project comes from each
 * session header `cwd`. Forked session files copy ancestor entries with
 * their ids and timestamps, so records are keyed by `(entry id, timestamp)`
 * and counted once.
 */
export const pixSessionsParser: JsonlParser<PixState, LocalUsageEvent> = {
	initial: (path) => ({ sessionId: path, file: path }),
	clone: (state) => ({ ...state }),
	line(state, value, emit) {
		if (!isRecord(value)) return;
		const time = timestampMs(value.timestamp);
		const timed = time === undefined ? {} : { timestampMs: time };
		const cwd = state.cwd ? { projectCwd: state.cwd } : {};

		if (value.type === "session") {
			const id = stringValue(value.id);
			if (id) state.sessionId = id;
			const headerCwd = stringValue(value.cwd);
			if (headerCwd) state.cwd = headerCwd;
			emit({ kind: "session", sessionId: state.sessionId, sessionFile: state.file, ...(state.cwd ? { projectCwd: state.cwd } : {}), ...timed });
			return;
		}
		if (value.type === "session_info") {
			emit({ kind: "session", sessionId: state.sessionId, name: stringValue(value.name) ?? null, ...cwd });
			return;
		}
		if (value.type === "message" && isRecord(value.message) && value.message.role === "user") {
			emit({ kind: "session", sessionId: state.sessionId, userTurn: true, ...cwd, ...timed });
			return;
		}
		const record = usageFromEntry(value);
		if (!record || record.totals.totalTokens + record.totals.cost === 0) return;
		const entryId = stringValue(value.id);
		const { totals } = record;
		emit({
			kind: "usage",
			provider: record.provider ?? null,
			model: record.provider ? record.model ?? null : null,
			sessionId: state.sessionId,
			values: {
				input: totals.input,
				output: totals.output,
				cacheRead: totals.cacheRead,
				cacheWrite: totals.cacheWrite,
				totalTokens: totals.totalTokens,
				cost: totals.cost,
				calls: 1,
				...(totals.costEstimated ? { costEstimated: true } : {}),
			},
			...(entryId ? { key: `pix:${entryId}:${record.timestampMs ?? ""}` } : {}),
			...(record.timestampMs === undefined ? {} : { timestampMs: record.timestampMs }),
			...cwd,
		});
	},
};

/**
 * Sessions below an explicit agent dir, or caller-resolved roots. Kept free of
 * the Pi SDK import so the collection worker starts quickly; the default agent
 * dir is resolved by `pix-sessions-roots`.
 */
export type PixSessionsSourceOptions = ({ agentDir: string } | { roots: () => readonly string[] }) & { partialWindowMs?: number };

export function createPixSessionsSource(options: PixSessionsSourceOptions): LocalUsageSource<PixState> {
	return new LocalUsageSource({
		id: "pix-sessions",
		roots: "roots" in options ? options.roots : () => [join(options.agentDir, "sessions")],
		parser: pixSessionsParser,
		...(options.partialWindowMs === undefined ? {} : { partialWindowMs: options.partialWindowMs }),
	});
}
