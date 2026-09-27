import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentState, getRunState } from "./state.js";
import { terminateProcess, terminateProcessTree } from "./process.js";
import { writeStructuredResult } from "./structured-result.js";
import type { AgentState } from "./types.js";
import { isoNow } from "./utils.js";
import { readOwnedMetadata, requestOwnedCancel, verifiedOwnedDrainSync } from "./owned-launch-integration.js";
import { listOwnedLaunchRunDirs, ownedArtifactsPresentSync } from "./owned-retirement.js";
import { writeOwnedLaunchCancelMarker } from "./owned-launch/marker.js";

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
	const agentDir = path.join(runDir, agent.id);
	// Any surviving owned-launch artifact — the ownership pointer OR UUID run
	// directories — selects the owned cancellation path. A pointerless owned
	// run must NEVER fall through to the legacy PID signal or a terminal
	// "stopped" write: the saved PID may already name an unrelated process,
	// and only the durable receipt chain can prove the coalition drained.
	if (ownedArtifactsPresentSync(agentDir)) {
		if (verifiedOwnedDrainSync(agentDir) && agent.status !== "running")
			return { ...result, message: `agent is ${agent.status}` };
		try {
			// Durable intent first. Never signal a saved bridge PID or process group.
			fs.writeFileSync(path.join(agentDir, "stop_requested"), isoNow(), "utf8");
			fs.writeFileSync(path.join(agentDir, "stop_signal"), signal, "utf8");
		} catch (error) {
			return { ...result, signal, error: error instanceof Error ? error.message : String(error) };
		}
		if (!readOwnedMetadata(agentDir)) {
			// Pointerless owned artifacts: without a readable pointer there is
			// no in-process handle and no metadata-directed cancel, but the
			// durable cancel marker is addressed by run directory, which the
			// supervisor polls pre-release and on every monitoring iteration.
			// Write it into every surviving UUID run dir and stay non-terminal:
			// drain proof is still pending, so no PID signal and no exit_code.
			const markerErrors: string[] = [];
			for (const ownedRunDir of listOwnedLaunchRunDirs(agentDir)) {
				try {
					writeOwnedLaunchCancelMarker(ownedRunDir);
				} catch (error) {
					markerErrors.push(error instanceof Error ? error.message : String(error));
				}
			}
			return {
				...result,
				signal,
				stopped: false,
				message: "owned artifacts present without a readable pointer; durable cancel requested, drain pending",
				...(markerErrors.length > 0 ? { error: `cancel marker failed: ${markerErrors.join("; ")}` } : {}),
			};
		}
		try {
			requestOwnedCancel(agentDir);
			return { ...result, signal, message: "owned cancellation requested; drain pending" };
		} catch (error) {
			return { ...result, signal, error: error instanceof Error ? error.message : String(error) };
		}
	}

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
		const ownsProcessGroup = fs.existsSync(path.join(runDir, agent.id, "process_group"));
		if (ownsProcessGroup) terminateProcessTree(agent.pid, signal);
		else terminateProcess(agent.pid, signal);
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
