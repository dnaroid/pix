import * as fs from "node:fs";
import * as path from "node:path";
import { getRunState, listRunDirs, readParentSessionLink, type AgentState } from "./lib.js";
import { getLiveRun } from "./live.js";
import type { LiveAgent } from "./types.js";

/**
 * Tracks live sub-agents for the event system. TUI widget rendering has been
 * removed — extensions should not render custom TUI components.
 */
export class SubagentOverlay {
	constructor(private liveAgents: Map<string, Map<string, LiveAgent>>) {}

	restoreRunningAgents(cwd: string, parentSession?: string): void {
		for (const runDir of listRunDirs(cwd)) {
			const running = getRunState(runDir, undefined, {
				includeLineCounts: false,
				checkRpcPromptFailure: false,
			}).agents.filter((agent) => agent.status === "running");
			if (running.length === 0) continue;
			const liveRun = getLiveRun(this.liveAgents, runDir);
			for (const agent of running) {
				if (liveRun.has(agent.id)) continue;
				const agentDir = path.join(runDir, agent.id);
				const agentParentSession = readParentSessionLink(agentDir);
				if (parentSession && agentParentSession && !pathsEqual(parentSession, agentParentSession)) continue;
				liveRun.set(agent.id, { runDir, agentId: agent.id, parentSession: agentParentSession, completed: Promise.resolve() });
			}
			if (liveRun.size === 0) this.liveAgents.delete(runDir);
		}
	}

	update(): void {
		// Prune completed agents from liveAgents, but do not render any UI.
		for (const [runDir, liveRun] of [...this.liveAgents.entries()]) {
			const ids = [...liveRun.keys()];
			const states = new Map(
				getRunState(runDir, ids, {
					includeLineCounts: false,
					checkRpcPromptFailure: false,
				}).agents.map((agent) => [agent.id, agent]),
			);

			for (const [agentId] of [...liveRun.entries()]) {
				const agent = states.get(agentId);
				if (!agent || isTerminalStatus(agent.status)) {
					liveRun.delete(agentId);
					continue;
				}
			}

			if (liveRun.size === 0) this.liveAgents.delete(runDir);
		}
	}

	dispose(): void {
		// No UI state to clean up.
	}
}

function isTerminalStatus(status: AgentState["status"]): boolean {
	return status === "done" || status === "failed" || status === "stopped";
}


function pathsEqual(left: string, right: string): boolean {
	return normalizePath(left) === normalizePath(right);
}

function normalizePath(filePath: string): string {
	const resolved = path.resolve(filePath);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}
