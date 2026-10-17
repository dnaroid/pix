import { randomUUID } from "node:crypto";
import { readResultText } from "./core/state.js";
import { getRecord } from "./core/store.js";
import type { AgentCompletionHandler } from "./core/types.js";

const CHANNEL = "async-subagents:delegated-evidence";
const MAX_REPORT_CHARS = 6000;
interface Owner { sessionId: string; anchorId: string; }
interface Bus { emit(channel: string, value: unknown): void; }
interface EvidenceCapture {
	bind(runDir: string): AgentCompletionHandler;
	cancel(): void;
	releaseUnbound(): void;
}

/** Final report only; never infer file ownership from a shared working-tree diff. */
function readReport(runDir: string, agentId: string): { report: string; clipped: boolean } | undefined {
	const record = getRecord(runDir, agentId);
	// Preserve the final report's ordering (including corrections/retests), not
	// a bag of extracted risks that could resurrect an already resolved issue.
	const text = readResultText(runDir, agentId) ?? record?.structured?.summary ?? "";
	if (!text.trim()) return undefined;
	const clipped = record?.structured?.resultTruncated === true || text.length > MAX_REPORT_CHARS;
	return { report: text.slice(0, MAX_REPORT_CHARS), clipped };
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
				let report: ReturnType<typeof readReport>;
				try { report = readReport(runDir, agentId); } catch { report = undefined; }
				emit({ ...identity, runDir, phase: "completed", status: completion.state.status, ...report });
			};
		},
		cancel,
		releaseUnbound() { if (!bound) cancel(); },
	};
}
