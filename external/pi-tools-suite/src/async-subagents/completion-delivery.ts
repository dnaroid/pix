import * as path from "node:path";
import * as fs from "node:fs";
import type { RunState } from "./lib.js";
import type { LiveAgent } from "./types.js";
import { isTerminalAgentStatus } from "./core/notifications.js";

function sessionPath(file: string): string {
	const resolved = path.resolve(file);
	try { return fs.realpathSync.native(resolved); }
	catch { return resolved; }
}

/** Arbitrates tool-result vs follow-up delivery within one extension instance. */
export class CompletionDelivery {
	private readonly waiters = new WeakMap<LiveAgent, number>();

	constructor(
		private readonly liveAgents: Map<string, Map<string, LiveAgent>>,
		private readonly onChange: () => void,
	) {}

	isReserved(agent: LiveAgent): boolean {
		return (this.waiters.get(agent) ?? 0) > 0;
	}

	/** An intermediate disk receipt is not the final retry/fallback outcome. */
	settledState(state: RunState): RunState {
		const liveRun = this.liveAgents.get(state.runDir);
		return {
			...state,
			agents: state.agents.map((agent) =>
				liveRun?.get(agent.id)?.awaitingCompletion && isTerminalAgentStatus(agent.status)
					? { ...agent, status: "running", exitCode: undefined }
					: agent),
		};
	}

	begin(parentSession: string | undefined, agents: Iterable<LiveAgent> = []) {
		const reserved = new Set<LiveAgent>();
		let finished = false;
		const add = (agent: LiveAgent): void => {
			const sameSession = parentSession && agent.parentSession
				? sessionPath(parentSession) === sessionPath(agent.parentSession)
				: parentSession === agent.parentSession;
			if (finished || !sameSession || reserved.has(agent)) return;
			reserved.add(agent);
			this.waiters.set(agent, (this.waiters.get(agent) ?? 0) + 1);
		};
		for (const agent of agents) add(agent);
		return {
			add,
			/** Commit only the final snapshot actually returned; errors/abort release it. */
			finish: (state?: RunState, signal?: AbortSignal): void => {
				if (finished) return;
				finished = true;
				const delivered = new Set(signal?.aborted ? [] : state?.agents
					.filter((agent) => isTerminalAgentStatus(agent.status)).map((agent) => agent.id));
				for (const agent of reserved) {
					const count = (this.waiters.get(agent) ?? 1) - 1;
					if (count) this.waiters.set(agent, count);
					else this.waiters.delete(agent);
					const liveRun = this.liveAgents.get(agent.runDir);
					if (state?.runDir === agent.runDir && delivered.has(agent.agentId)
						&& !agent.awaitingCompletion && liveRun?.get(agent.agentId) === agent) {
						liveRun.delete(agent.agentId);
						if (liveRun.size === 0) this.liveAgents.delete(agent.runDir);
					}
				}
				reserved.clear();
				// No await between acknowledgement, reservation release and reconciliation.
				this.onChange();
			},
		};
	}
}
