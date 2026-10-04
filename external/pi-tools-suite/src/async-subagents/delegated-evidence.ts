import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import * as path from "node:path";
import type { AgentCompletionHandler } from "./core/types.js";

const CHANNEL = "async-subagents:delegated-evidence";
const MAX_BYTES = 128 * 1024;
interface Owner { sessionId: string; anchorId: string; }
interface Bus { emit(channel: string, value: unknown): void; }
interface EvidenceCapture {
	bind(runDir: string): AgentCompletionHandler;
	cancel(): void;
	releaseUnbound(): void;
}

/** Final report only; never infer file ownership from a shared working-tree diff. */
async function readReport(agentDir: string, agentId: string): Promise<{ report: string; clipped: boolean } | undefined> {
	const file = await open(path.join(agentDir, "result.json"), "r");
	try {
		const buffer = Buffer.alloc(MAX_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = await file.read(buffer, size, buffer.length - size, null);
			if (!read.bytesRead) break;
			size += read.bytesRead;
		}
		if (size > MAX_BYTES) return undefined;
		const data = JSON.parse(buffer.subarray(0, size).toString("utf8"));
		if (data?.agentId !== agentId) return undefined;
		// Preserve the final report's ordering (including corrections/retests), not
		// a bag of extracted risks that could resurrect an already resolved issue.
		const report = typeof data.resultText === "string" ? data.resultText : typeof data.summary === "string" ? data.summary : "";
		return report.trim() ? { report: report.slice(0, 6000), clipped: data.resultTruncated === true || report.length > 6000 } : undefined;
	} finally { await file.close(); }
}

/** Start before launch; finish only on the final retry/fallback callback, independent of wait/follow-up arbitration. */
export function beginDelegatedEvidence(bus: Bus | undefined, owner: Owner | undefined, agentId: string): EvidenceCapture {
	if (!bus || !owner?.sessionId || !owner.anchorId) return { bind: () => () => {}, cancel: () => {}, releaseUnbound: () => {} };
	const identity = { version: 1, launchId: randomUUID(), ...owner, agentId };
	const emit = (value: unknown) => { try { bus.emit(CHANNEL, value); } catch { /* Optional observer never breaks completion. */ } };
	emit({ ...identity, phase: "started" });
	let finished = false;
	let bound = false;
	const cancel = () => {
		if (finished) return;
		finished = true;
		emit({ ...identity, phase: "retired" });
	};
	return {
		bind(runDir) {
			bound = true;
			return (completion) => {
				if (finished || completion.runDir !== runDir || completion.agentId !== agentId) return;
				finished = true;
				void readReport(completion.agentDir, agentId).then((report) => {
					emit({ ...identity, runDir, phase: "completed", status: completion.state.status, ...report });
				}).catch(() => { emit({ ...identity, runDir, phase: "completed", status: completion.state.status }); });
			};
		},
		cancel,
		releaseUnbound() { if (!bound) cancel(); },
	};
}
