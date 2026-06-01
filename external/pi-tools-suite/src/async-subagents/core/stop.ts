import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentState, getRunState } from "./state.js";
import { terminateProcess } from "./process.js";
import { writeStructuredResult } from "./structured-result.js";
import type { AgentState } from "./types.js";
import { isoNow } from "./utils.js";

export type StopSignal = "SIGTERM" | "SIGINT" | "SIGKILL";

export interface StopAgentResult {
	id: string;
	previousStatus: AgentState["status"];
	pid?: number;
	stopped: boolean;
	signal?: StopSignal;
	message?: string;
	error?: string;
}

const stopSignals = new Set<StopSignal>(["SIGTERM", "SIGINT", "SIGKILL"]);

export function validateStopSignal(signal: string): StopSignal {
	if (stopSignals.has(signal as StopSignal)) return signal as StopSignal;
	throw new Error(`Unsupported stop signal "${signal}". Use SIGTERM, SIGINT, or SIGKILL.`);
}

export function stopAgents(
	runDir: string,
	agentIds?: string[],
	options: { signal?: StopSignal } = {},
): StopAgentResult[] {
	const signal = options.signal ?? "SIGTERM";
	const state = getRunState(runDir, agentIds);

	return state.agents.map((agent) => stopAgent(runDir, agent, signal));
}

function stopAgent(runDir: string, agent: AgentState, signal: StopSignal): StopAgentResult {
	const result: StopAgentResult = {
		id: agent.id,
		previousStatus: agent.status,
		pid: agent.pid,
		stopped: false,
	};

	if (agent.status === "planned" || agent.status === "retrying") {
		markStopped(runDir, agent.id, signal, agent.status === "planned" ? "Sub-agent stopped before launch." : "Sub-agent retry cancelled before relaunch.");
		return {
			...result,
			stopped: true,
			signal,
			message: `marked ${agent.status} agent stopped`,
		};
	}

	if (agent.status !== "running") {
		result.message = `agent is ${agent.status}`;
		return result;
	}

	if (!agent.pid) {
		markStopped(runDir, agent.id, signal);
		return {
			...result,
			stopped: true,
			signal,
			message: "running status had no pid; marked stopped",
		};
	}

	try {
		terminateProcess(agent.pid, signal);
		markStopped(runDir, agent.id, signal);
		return {
			...result,
			stopped: true,
			signal,
			message: "stop signal sent",
		};
	} catch (error) {
		const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : undefined;
		if (code === "ESRCH") {
			markStopped(runDir, agent.id, signal);
			const refreshed = getAgentState(runDir, agent.id);
			return {
				...result,
				previousStatus: refreshed?.status ?? agent.status,
				stopped: true,
				signal,
				message: "process was already gone; marked stopped",
			};
		}

		return {
			...result,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function markStopped(runDir: string, agentId: string, signal: StopSignal, resultText = "Sub-agent stop requested."): void {
	const agentDir = path.join(runDir, agentId);
	const now = isoNow();
	fs.mkdirSync(agentDir, { recursive: true });
	ensurePromptFile(runDir, agentId, agentDir, resultText);
	fs.writeFileSync(path.join(agentDir, "stop_requested"), now, "utf-8");
	fs.writeFileSync(path.join(agentDir, "stop_signal"), signal, "utf-8");
	fs.rmSync(path.join(agentDir, "retry_pending"), { force: true });
	fs.rmSync(path.join(agentDir, "next_retry_at"), { force: true });
	if (!fs.existsSync(path.join(agentDir, "result.md"))) fs.writeFileSync(path.join(agentDir, "result.md"), resultText, "utf-8");
	fs.writeFileSync(path.join(agentDir, "exit_code"), "stopped", "utf-8");
	fs.writeFileSync(path.join(agentDir, "finished_at"), now, "utf-8");
	const state = getAgentState(runDir, agentId, { includeLineCounts: false }) ?? { id: agentId, status: "stopped" as const, finishedAt: now };
	try {
		writeStructuredResult({ agentDir, agentId, state });
	} catch {
		// Stop is best-effort; failure to write metadata must not hide the stop result.
	}
}

function ensurePromptFile(runDir: string, agentId: string, agentDir: string, fallback: string): void {
	const promptFile = path.join(agentDir, "prompt.md");
	if (fs.existsSync(promptFile)) return;
	const queuedPromptFile = path.join(runDir, "prompts", `${agentId}.md`);
	if (fs.existsSync(queuedPromptFile)) {
		fs.copyFileSync(queuedPromptFile, promptFile);
		return;
	}
	fs.writeFileSync(promptFile, fallback, "utf-8");
}
