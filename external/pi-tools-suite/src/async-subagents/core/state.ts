// Agent state read model over the session-native store (decision 0072).
// Non-owned agents derive status from their record plus in-process
// liveness; owned-launch agents keep the receipt-chain semantics and read
// their durable control records from the owned base directory.
import * as fs from "node:fs";
import * as path from "node:path";
import { isDir, ownedAgentDir, ownedBatchDir } from "./paths.js";
import { getLive, getRecord, listRunRecords, readChildLastAssistantText, type SubagentRecord } from "./store.js";
import type { AgentResult, AgentState, RunState } from "./types.js";
import { ownedOutcomeSync, ownedRecoveredExitSync, type OwnedRunOutcome } from "./owned-launch-integration.js";
import { ownedArtifactsPresentSync, ownedRetiredSync, reconcileOwnedRuns } from "./owned-retirement.js";

interface AgentStateReadOptions {
	includeLineCounts?: boolean;
}

interface AgentResultReadOptions {
	/** Include the full result/stderr text (internal callers only; the tool inlines a bounded copy). */
	includeRawFiles?: boolean;
}

export function getAgentState(
	runDir: string,
	agentId: string,
	options: AgentStateReadOptions = {},
): AgentState | null {
	const record = getRecord(runDir, agentId);
	const ownedDir = ownedAgentDir(runDir, agentId);
	// Unknown ownership fails closed: surviving owned-launch artifacts (even
	// without a store record, e.g. a crash before the parent entry flushed)
	// mark the run owned.
	const owned = ownedArtifactsPresentSync(ownedDir);
	if (!record && !owned) return null;
	const includeLineCounts = options.includeLineCounts ?? true;
	const live = getLive(runDir, agentId);

	const state: AgentState = { id: agentId, status: "planned" };
	if (record?.pid !== undefined) state.pid = record.pid;
	if (record?.startedAt) state.startedAt = record.startedAt;
	if (record?.finishedAt) state.finishedAt = record.finishedAt;
	if (record?.retryCount && record.retryCount > 0) state.retryCount = record.retryCount;
	if (live?.todoProgress) state.todoProgress = live.todoProgress;
	if (live?.lastActivity) state.lastActivity = live.lastActivity;

	if (owned) {
		deriveOwnedStatus(state, ownedDir);
		// A pending retry stays nonterminal so wait/poll do not return
		// "failed" for an attempt the retry chain will relaunch.
		if (record?.status === "retrying" && !record.stopRequested && state.status !== "running" && state.status !== "done") {
			state.status = "retrying";
			if (record.nextRetryAt) state.nextRetryAt = record.nextRetryAt;
		}
	} else if (record) {
		deriveRecordStatus(state, record, live?.active === true);
	}

	if (includeLineCounts) {
		const text = live?.resultText ?? record?.message;
		if (text !== undefined) state.resultLines = countLines(text);
		const stderrLines = live?.stderrTail ? countLines(live.stderrTail) : 0;
		if (stderrLines > 0) state.stderrLines = stderrLines;
	}
	return state;
}

function deriveRecordStatus(state: AgentState, record: SubagentRecord, activeHere: boolean): void {
	const status = record.status ?? "planned";
	if (record.stopRequested && !activeHere && status !== "done" && status !== "failed") {
		state.status = "stopped";
		return;
	}
	if (status === "done" || status === "failed") {
		state.status = status;
		if (record.exitCode !== undefined) state.exitCode = record.exitCode;
		return;
	}
	if (status === "stopped") {
		state.status = "stopped";
		return;
	}
	if (activeHere) {
		state.status = status;
		if (status === "retrying" && record.nextRetryAt) state.nextRetryAt = record.nextRetryAt;
		return;
	}
	// Not owned by this process (parent restart/reload in another process):
	// a live PID keeps it running; a lost queue/retry timer cannot resume.
	if (status === "running" && record.pid !== undefined && pidAlive(record.pid)) state.status = "running";
	else state.status = "stopped";
}

function deriveOwnedStatus(state: AgentState, ownedDir: string): void {
	const exitCodeFile = path.join(ownedDir, "exit_code");
	const rawExit = fs.existsSync(exitCodeFile) ? fs.readFileSync(exitCodeFile, "utf-8").trim() : undefined;
	// The bridge's PID, stale exit records, and RPC events cannot establish
	// that the owned coalition has drained; only the receipt chain can.
	const outcome = ownedOutcomeSync(ownedDir);
	// Receipt-before-bootout contract: a drained (or unproven-failure)
	// receipt is not terminal until BOTH exact UUID jobs are durably retired.
	const terminalReceipt = outcome.kind === "launch-failed" ||
		((outcome.kind === "drained-ok" || outcome.kind === "drained-fail" || outcome.kind === "unproven-fail" ||
			outcome.kind === "never-launched") && ownedRetiredSync(ownedDir));
	if (!terminalReceipt) {
		state.status = "running";
		return;
	}
	const recovered = ownedTerminalExit(ownedDir, outcome, rawExit);
	if (!recovered) state.status = "running";
	else if ("stopped" in recovered) state.status = "stopped";
	else {
		state.exitCode = recovered.exitCode;
		state.status = recovered.exitCode === 0 ? "done" : "failed";
	}
	const finishedAt = readTrimmed(path.join(ownedDir, "finished_at"));
	if (finishedAt && !state.finishedAt) state.finishedAt = finishedAt;
}

/**
 * Terminal exit for an owned run with a final receipt. A persisted exit
 * record from the in-process completion path wins when it is self-consistent
 * with the receipt; anything absent, unparsable, or contradicting the
 * receipt is recovered deterministically from the receipt chain instead.
 */
function ownedTerminalExit(
	ownedDir: string,
	outcome: OwnedRunOutcome,
	rawExitRecord: string | undefined,
): { exitCode: number } | { stopped: true } | undefined {
	if (rawExitRecord === "stopped") return { stopped: true };
	if (rawExitRecord !== undefined && /^-?\d+$/.test(rawExitRecord)) {
		const code = parseInt(rawExitRecord, 10);
		if (outcome.kind !== "drained-ok" && code === 0) return { exitCode: 1 };
		return { exitCode: code };
	}
	return ownedRecoveredExitSync(ownedDir, outcome);
}

function readTrimmed(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf-8").trim() || undefined;
	} catch {
		return undefined;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function countLines(text: string): number {
	if (!text) return 0;
	const newlines = text.split("\n").length - 1;
	return text.endsWith("\n") ? newlines : newlines + 1;
}

/** Agent ids with owned-launch directories but no record (crash before the parent entry flushed). */
function orphanOwnedAgentIds(runDir: string): string[] {
	// Owned agent dirs: `<scope>/owned/<batch>/<agentId>/`, or legacy `<run>/<agentId>/`.
	// Only directories carrying owned-launch artifacts count (fail closed).
	const batchDir = ownedBatchDir(runDir);
	if (!isDir(batchDir)) return [];
	return fs.readdirSync(batchDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && ownedArtifactsPresentSync(path.join(batchDir, entry.name)))
		.map((entry) => entry.name);
}

export function getRunState(
	runDir: string,
	filterIds?: string[],
	options: AgentStateReadOptions = {},
): RunState {
	const agents: AgentState[] = [];
	const seen = new Set<string>();
	const ids = [...listRunRecords(runDir).map((record) => record.agentId), ...orphanOwnedAgentIds(runDir)];
	for (const id of ids) {
		if (seen.has(id) || (filterIds && !filterIds.includes(id))) continue;
		seen.add(id);
		const state = getAgentState(runDir, id, options);
		if (state) agents.push(state);
	}
	return { runDir, agents };
}

/** Full result text: live final text, parent-authored message, then the child session's last answer. */
export function readResultText(runDir: string, agentId: string): string | undefined {
	const record = getRecord(runDir, agentId);
	const live = getLive(runDir, agentId);
	if (live?.resultText !== undefined) return live.resultText;
	if (record?.message !== undefined) return record.message;
	const child = readChildLastAssistantText(record?.childSessionFile);
	if (child !== undefined) return child;
	return readTrimmed(path.join(ownedAgentDir(runDir, agentId), "result.md"));
}

export function readResult(
	runDir: string,
	agentId: string,
	options: AgentResultReadOptions = {},
): AgentResult | null {
	const state = getAgentState(runDir, agentId);
	if (!state) return null;
	const record = getRecord(runDir, agentId);
	const live = getLive(runDir, agentId);
	const includeRawFiles = options.includeRawFiles ?? true;
	const text = readResultText(runDir, agentId);
	const stderr = live?.stderrTail?.trim() ? live.stderrTail : record?.stderrPreview;
	return {
		resultAvailable: text !== undefined,
		result: includeRawFiles ? text : undefined,
		stderrAvailable: Boolean(stderr?.trim()),
		stderr: includeRawFiles ? stderr : undefined,
		exitCode: state.exitCode,
		state,
		structured: record?.structured,
	};
}

export async function waitForAgents(
	runDir: string,
	agentIds: string[] | undefined,
	options: {
		timeout?: number;
		interval?: number;
		failFast?: boolean;
		signal?: AbortSignal;
	} = {},
): Promise<RunState> {
	const timeout = options.timeout ?? 300;
	const interval = options.interval ?? 3;
	const failFast = options.failFast ?? false;
	const start = Date.now();
	while (true) {
		// Self-heal owned runs left unpersisted by a parent restart (receipt
		// recovery + retirement markers); never blocks this loop.
		reconcileOwnedRuns(runDir, agentIds);
		const state = getRunState(runDir, agentIds);
		const terminal = state.agents.filter((a) => a.status === "done" || a.status === "failed" || a.status === "stopped");
		if (failFast && terminal.some((a) => a.status === "failed" || a.status === "stopped")) return state;
		if (state.agents.length === 0 || terminal.length === state.agents.length) return state;
		if (Date.now() - start >= timeout * 1000 || options.signal?.aborted) return state;
		await new Promise((resolve) => setTimeout(resolve, interval * 1000));
	}
}
