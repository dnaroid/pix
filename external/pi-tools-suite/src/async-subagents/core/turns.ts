import * as fs from "node:fs";
import * as path from "node:path";
import { TODO_PROGRESS_FILE } from "./todo-progress.js";
import type { AgentTask } from "./types.js";

/** Persisted launch configuration used to resume a finished sub-agent. */
export const LAUNCH_SPEC_FILE = "launch.json";
/** Number of completed turns archived under turns/<n>/ (current turn = count + 1). */
export const TURN_COUNT_FILE = "turn_count";
/** Message that started the current (resumed) turn. */
export const TURN_MESSAGE_FILE = "turn_message.md";
export const TURNS_DIR = "turns";

export interface AgentLaunchSpec {
	version: 1;
	task: AgentTask;
	extraArgs: string[];
	timeoutMs?: number;
	maxResultBytes?: number;
	/** Child argv of the most recent turn (diagnostics/tests only; never replayed). */
	piArgs?: string[];
}

/** Per-turn artifacts moved into turns/<n>/ before a resumed turn starts. */
const TURN_ARTIFACTS = [
	"result.md",
	"result.json",
	"progress.jsonl",
	"stderr.log",
	"exit_code",
	"started_at",
	"finished_at",
	"timeout_ms",
	"timed_out_at",
	TURN_MESSAGE_FILE,
	TODO_PROGRESS_FILE,
] as const;

export function writeLaunchSpec(agentDir: string, spec: Omit<AgentLaunchSpec, "version">): void {
	const payload: AgentLaunchSpec = { version: 1, ...spec };
	fs.writeFileSync(path.join(agentDir, LAUNCH_SPEC_FILE), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

/** Record the current turn's child argv in launch.json without touching the original task. */
export function recordLaunchPiArgs(agentDir: string, piArgs: readonly string[]): void {
	const spec = readLaunchSpec(agentDir);
	if (!spec) return;
	const { version: _version, ...rest } = spec;
	writeLaunchSpec(agentDir, { ...rest, piArgs: [...piArgs] });
}

export function readLaunchSpec(agentDir: string): AgentLaunchSpec | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(agentDir, LAUNCH_SPEC_FILE), "utf-8")) as Partial<AgentLaunchSpec>;
		if (parsed?.version !== 1 || !parsed.task || typeof parsed.task.id !== "string" || typeof parsed.task.task !== "string") return undefined;
		return {
			version: 1,
			task: parsed.task,
			extraArgs: Array.isArray(parsed.extraArgs) ? parsed.extraArgs.filter((arg): arg is string => typeof arg === "string") : [],
			timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : undefined,
			maxResultBytes: typeof parsed.maxResultBytes === "number" ? parsed.maxResultBytes : undefined,
			piArgs: Array.isArray(parsed.piArgs) ? parsed.piArgs.filter((arg): arg is string => typeof arg === "string") : undefined,
		};
	} catch {
		return undefined;
	}
}

export function readTurnCount(agentDir: string): number {
	try {
		const value = Number.parseInt(fs.readFileSync(path.join(agentDir, TURN_COUNT_FILE), "utf-8").trim(), 10);
		return Number.isFinite(value) && value > 0 ? value : 0;
	} catch {
		return 0;
	}
}

/**
 * Move the finished turn's artifacts into turns/<n>/ and record the next
 * turn's message. Returns the archived turn number. Session files and links
 * stay in place so the next launch resumes the same conversation.
 */
export function archiveAgentTurn(agentDir: string, nextMessage: string): number {
	const turn = readTurnCount(agentDir) + 1;
	const turnDir = path.join(agentDir, TURNS_DIR, String(turn));
	fs.mkdirSync(turnDir, { recursive: true });
	for (const name of TURN_ARTIFACTS) {
		const source = path.join(agentDir, name);
		if (!fs.existsSync(source)) continue;
		fs.renameSync(source, path.join(turnDir, name));
	}
	// Stop markers belong to the finished turn; a stale marker would mark the
	// resumed turn "stopped".
	// The dead pid would read as "stopped" while the resumed turn waits for a slot.
	for (const name of ["stop_requested", "stop_signal", "retry_pending", "next_retry_at", "pid", "process_group"]) {
		try { fs.unlinkSync(path.join(agentDir, name)); } catch { /* absent */ }
	}
	fs.writeFileSync(path.join(agentDir, TURN_COUNT_FILE), String(turn), "utf-8");
	fs.writeFileSync(path.join(agentDir, TURN_MESSAGE_FILE), nextMessage, "utf-8");
	return turn;
}
