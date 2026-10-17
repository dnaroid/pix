/**
 * Display-only model/context summary of a persisted sub-agent JSONL.
 *
 * Viewers have no Pi runtime, so the status bar reads the last recorded model,
 * thinking level and assistant usage from the file. Reads are incremental per
 * file (only appended complete lines are parsed) and the cache is bounded.
 */

import { open } from "node:fs/promises";

export interface SubagentSessionSummary {
	readonly provider?: string;
	readonly modelId?: string;
	readonly thinking?: string;
	/** Context tokens of the last valid assistant turn; null after compaction. */
	readonly contextTokens?: number | null;
}

interface ScanState {
	offset: number;
	summary: SubagentSessionSummary;
}

const MAX_CACHED_FILES = 16;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const cache = new Map<string, ScanState>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 512 ? value : undefined;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Same rule as Pi's calculateContextTokens over a valid assistant usage. */
function assistantContextTokens(message: Record<string, unknown>): number | undefined {
	if (message.stopReason === "aborted" || message.stopReason === "error" || !isRecord(message.usage)) return undefined;
	const usage = message.usage;
	const tokens = count(usage.totalTokens)
		|| count(usage.input) + count(usage.output) + count(usage.cacheRead) + count(usage.cacheWrite);
	return tokens > 0 ? tokens : undefined;
}

export function applySummaryLine(summary: SubagentSessionSummary, line: string): SubagentSessionSummary {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return summary;
	}
	if (!isRecord(entry)) return summary;
	if (entry.type === "model_change") {
		const provider = text(entry.provider);
		const modelId = text(entry.modelId);
		return provider && modelId ? { ...summary, provider, modelId } : summary;
	}
	if (entry.type === "thinking_level_change") {
		const thinking = text(entry.thinkingLevel);
		return thinking ? { ...summary, thinking } : summary;
	}
	if (entry.type === "compaction") return { ...summary, contextTokens: null };
	if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant") return summary;
	const message = entry.message;
	const provider = text(message.provider);
	const modelId = text(message.model);
	const tokens = assistantContextTokens(message);
	return {
		...summary,
		...(provider && modelId ? { provider, modelId } : {}),
		...(tokens !== undefined ? { contextTokens: tokens } : {}),
	};
}

/**
 * Incrementally summarize `sessionFile`. A shrunk file is rescanned; partial
 * trailing lines are left for the next read. Never throws.
 */
export async function readSubagentSessionSummary(sessionFile: string): Promise<SubagentSessionSummary> {
	let state = cache.get(sessionFile);
	try {
		const handle = await open(sessionFile, "r");
		try {
			const { size } = await handle.stat();
			if (!state || size < state.offset) state = { offset: 0, summary: {} };
			let skipFragment = false;
			// Very large backlogs only need the tail for the latest usage; model
			// and thinking entries normally sit near the header and the tail.
			if (size - state.offset > MAX_READ_BYTES) {
				const head = Buffer.alloc(Math.min(size, 64 * 1024));
				const { bytesRead } = await handle.read(head, 0, head.length, 0);
				const headText = head.subarray(0, bytesRead).toString("utf8");
				for (const line of headText.slice(0, Math.max(0, headText.lastIndexOf("\n"))).split("\n")) {
					state.summary = applySummaryLine(state.summary, line);
				}
				state.offset = size - MAX_READ_BYTES;
				skipFragment = true;
			}
			if (size > state.offset) {
				const buffer = Buffer.alloc(size - state.offset);
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
				const chunk = buffer.subarray(0, bytesRead);
				const end = chunk.lastIndexOf(0x0a);
				if (end >= 0) {
					const lines = chunk.subarray(0, end).toString("utf8").split("\n");
					// A tail read may start mid-line; drop that fragment.
					if (skipFragment) lines.shift();
					for (const line of lines) state.summary = applySummaryLine(state.summary, line);
					state.offset += end + 1;
				}
			}
		} finally {
			await handle.close();
		}
	} catch {
		return state?.summary ?? {};
	}
	cache.delete(sessionFile);
	cache.set(sessionFile, state);
	while (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value!);
	return state.summary;
}
