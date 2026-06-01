import * as fs from "node:fs";
import * as path from "node:path";
import { isDir } from "./paths.js";
import { readStructuredResult } from "./structured-result.js";
import type { AgentResult, AgentState, RpcEventRecord, RunState } from "./types.js";

const MAX_RPC_EVENT_LINE_CHARS = 1024 * 1024;

interface AgentStateReadOptions {
	includeLineCounts?: boolean;
	checkRpcPromptFailure?: boolean;
}

export function getAgentState(
	runDir: string,
	agentId: string,
	options: AgentStateReadOptions = {},
): AgentState | null {
	const agentDir = path.join(runDir, agentId);
	if (!isDir(agentDir)) return null;
	if (!fs.existsSync(path.join(agentDir, "prompt.md"))) return null;
	const includeLineCounts = options.includeLineCounts ?? true;
	const checkRpcPromptFailure = options.checkRpcPromptFailure ?? true;

	const state: AgentState = { id: agentId, status: "planned" };
	const pid = readPid(path.join(agentDir, "pid"));
	if (pid !== undefined) state.pid = pid;

	const exitCodeFile = path.join(agentDir, "exit_code");
	if (fs.existsSync(exitCodeFile)) {
		const code = parseInt(fs.readFileSync(exitCodeFile, "utf-8").trim(), 10);
		if (isNaN(code)) {
			state.status = "stopped";
		} else {
			state.exitCode = code;
			state.status = code === 0 ? "done" : "failed";
		}
	} else if (
		checkRpcPromptFailure &&
		hasRpcPromptFailure(path.join(agentDir, "events.jsonl"))
	) {
		state.exitCode = 1;
		state.status = "failed";
	} else {
		if (pid !== undefined) {
			try {
				process.kill(pid, 0);
				state.status = "running";
			} catch {
				state.status = "stopped";
			}
		}
	}

	const startedAtFile = path.join(agentDir, "started_at");
	if (fs.existsSync(startedAtFile)) {
		state.startedAt = fs.readFileSync(startedAtFile, "utf-8").trim();
	}

	const finishedAtFile = path.join(agentDir, "finished_at");
	if (fs.existsSync(finishedAtFile)) {
		state.finishedAt = fs.readFileSync(finishedAtFile, "utf-8").trim();
	}

	const retryPendingFile = path.join(agentDir, "retry_pending");
	const stopRequestedFile = path.join(agentDir, "stop_requested");
	if (fs.existsSync(retryPendingFile) && !fs.existsSync(stopRequestedFile) && state.status !== "running" && state.status !== "done") {
		state.status = "retrying";
		const nextRetryAt = readTrimmed(path.join(agentDir, "next_retry_at"));
		if (nextRetryAt) state.nextRetryAt = nextRetryAt;
	}

	if (includeLineCounts) {
		const resultLines = countFileLines(path.join(agentDir, "result.md"));
		if (resultLines !== undefined) state.resultLines = resultLines;

		const stderrLines = countFileLines(path.join(agentDir, "stderr.log"));
		if (stderrLines !== undefined && stderrLines > 0)
			state.stderrLines = stderrLines;

		const eventLines = countFileLines(path.join(agentDir, "events.jsonl"));
		if (eventLines !== undefined) state.eventLines = eventLines;
	}

	// Read retry count if present.
	const retryCountFile = path.join(agentDir, "retry_count");
	if (fs.existsSync(retryCountFile)) {
		const count = parseInt(fs.readFileSync(retryCountFile, "utf-8").trim(), 10);
		if (!isNaN(count) && count > 0) state.retryCount = count;
	}

	return state;
}

function readTrimmed(filePath: string): string | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	const value = fs.readFileSync(filePath, "utf-8").trim();
	return value || undefined;
}

function readPid(pidFile: string): number | undefined {
	if (!fs.existsSync(pidFile)) return undefined;
	const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
	return isNaN(pid) ? undefined : pid;
}

function hasRpcPromptFailure(eventsFile: string): boolean {
	if (!fs.existsSync(eventsFile)) return false;
	let fd: number | undefined;
	try {
		fd = fs.openSync(eventsFile, "r");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		const decoder = new TextDecoder();
		let pending = "";

		while (true) {
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
			if (pending.length > MAX_RPC_EVENT_LINE_CHARS) return false;
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (isRpcPromptFailureLine(line)) return true;
			}
		}

		pending += decoder.decode();
		if (isRpcPromptFailureLine(pending)) return true;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	return false;
}

function isRpcPromptFailureLine(line: string): boolean {
	if (!line.trim()) return false;
	const event = JSON.parse(line) as RpcEventRecord;
	return event.type === "response" && event.command === "prompt" && event.success === false;
}

function countFileLines(filePath: string): number | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let newlines = 0;
		let bytesTotal = 0;
		let lastByte: number | undefined;

		while (true) {
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			bytesTotal += bytesRead;
			for (let i = 0; i < bytesRead; i++) {
				if (buffer[i] === 0x0a) newlines++;
			}
			lastByte = buffer[bytesRead - 1];
		}

		if (bytesTotal === 0) return 0;
		return lastByte === 0x0a ? newlines : newlines + 1;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

export function getRunState(
	runDir: string,
	filterIds?: string[],
	options: AgentStateReadOptions = {},
): RunState {
	const agents: AgentState[] = [];
	const launchedIds = new Set<string>();

	if (!isDir(runDir)) return { runDir, agents };

	// Read launched agent dirs
	for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!fs.existsSync(path.join(runDir, entry.name, "prompt.md"))) continue;
		if (filterIds && !filterIds.includes(entry.name)) continue;
		const state = getAgentState(runDir, entry.name, options);
		if (state) {
			agents.push(state);
			launchedIds.add(entry.name);
		}
	}

	// Check for planned agents (prompts without launched agent dirs)
	const promptsDir = path.join(runDir, "prompts");
	if (isDir(promptsDir)) {
		for (const pf of fs.readdirSync(promptsDir)) {
			if (!pf.endsWith(".md")) continue;
			const id = pf.slice(0, -3);
			if (launchedIds.has(id)) continue;
			if (filterIds && !filterIds.includes(id)) continue;
			agents.push({ id, status: "planned" });
		}
	}

	return { runDir, agents };
}

export function readResult(
	runDir: string,
	agentId: string,
): AgentResult | null {
	const state = getAgentState(runDir, agentId);
	if (!state) return null;

	const agentDir = path.join(runDir, agentId);
	let result: string | undefined;
	let stderr: string | undefined;

	const resultFile = path.join(agentDir, "result.md");
	if (fs.existsSync(resultFile)) {
		result = fs.readFileSync(resultFile, "utf-8");
	}

	const stderrFile = path.join(agentDir, "stderr.log");
	if (fs.existsSync(stderrFile)) {
		const content = fs.readFileSync(stderrFile, "utf-8");
		if (content.trim()) stderr = content;
	}

	const structured = readStructuredResult(agentDir);

	return { result, stderr, exitCode: state.exitCode, state, structured };
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
		const state = getRunState(runDir, agentIds);
		const terminal = state.agents.filter(
			(a) =>
				a.status === "done" || a.status === "failed" || a.status === "stopped",
		);

		if (
			failFast &&
			terminal.some((a) => a.status === "failed" || a.status === "stopped")
		) {
			return state;
		}

		if (state.agents.length === 0 || terminal.length === state.agents.length) {
			return state;
		}

		if (Date.now() - start >= timeout * 1000) {
			return state;
		}

		if (options.signal?.aborted) {
			return state;
		}

		await new Promise((resolve) => setTimeout(resolve, interval * 1000));
	}
}
