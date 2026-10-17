import type { ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { getRunState, type AgentState } from "./lib.js";
import { resolveSubagentAgentRunDir } from "./core/lookup.js";
import { isTerminalAgentStatus } from "./core/notifications.js";
import type { CompletionDelivery } from "./completion-delivery.js";
import type { LiveAgent } from "./types.js";

interface Receipt {
	agent: LiveAgent;
	state: AgentState;
	reservation: ReturnType<CompletionDelivery["begin"]>;
	session?: string;
}

/** A successful result-tool read can consume an undelivered completion.
 * Capture the launch and final version BEFORE execution; never acknowledge a
 * replacement launch or a completion that arrived after the read started.
 */
export class CompletionReceipts {
	private readonly pending = new Map<string, Receipt>();
	private generation = 0;

	constructor(
		private readonly live: Map<string, Map<string, LiveAgent>>,
		private readonly delivery: CompletionDelivery,
	) {}

	async start(event: ToolCallEvent, ctx: ExtensionContext): Promise<void> {
		const generation = this.generation;
		const input = event.input as Record<string, unknown>;
		let agent: LiveAgent | undefined;
		if ((event.toolName === "subagents" && input.action === "result") || event.toolName === "async_subagents_result") {
			if (typeof input.agentId !== "string") return;
			try {
				const runDir = resolveSubagentAgentRunDir(ctx, input.agentId, typeof input.runDir === "string" ? input.runDir : undefined);
				agent = this.live.get(runDir)?.get(input.agentId);
			} catch { return; }
		} else return;
		if (!agent || generation !== this.generation || agent.awaitingCompletion || ctx.signal?.aborted) return;
		const state = this.state(agent);
		if (!state || !isTerminalAgentStatus(state.status)) return;
		const receipt: Receipt = {
			agent, state, session: ctx.sessionManager.getSessionFile(),
			reservation: this.delivery.begin(ctx.sessionManager.getSessionFile(), [agent]),
		};
		this.release(event.toolCallId);
		this.pending.set(event.toolCallId, receipt);
	}

	async finish(event: Pick<ToolResultEvent, "toolCallId" | "isError" | "content" | "details">, ctx: ExtensionContext): Promise<void> {
		const receipt = this.pending.get(event.toolCallId);
		if (!receipt) return;
		try {
			if (event.isError || ctx.signal?.aborted || receipt.session !== ctx.sessionManager.getSessionFile()
				|| !this.sameState(receipt.state, this.state(receipt.agent))) return;
			const details = event.details as { state?: AgentState; runDir?: string; agentId?: string } | undefined;
			if (details?.runDir !== receipt.agent.runDir || details.agentId !== receipt.agent.agentId
				|| !this.sameState(receipt.state, details.state)) return;
			if (this.pending.get(event.toolCallId) !== receipt || ctx.signal?.aborted
				|| !this.sameState(receipt.state, this.state(receipt.agent))) return;
			receipt.reservation.finish({ runDir: receipt.agent.runDir, agents: [receipt.state] }, ctx.signal);
		} catch {
			// Missing/changed evidence is not acknowledgement and must not fail read.
		} finally { this.release(event.toolCallId); }
	}

	release(toolCallId: string): void {
		const receipt = this.pending.get(toolCallId);
		this.pending.delete(toolCallId);
		receipt?.reservation.finish();
	}

	clear(): void {
		this.generation++;
		for (const id of this.pending.keys()) this.release(id);
	}

	private state(agent: LiveAgent): AgentState | undefined {
		if (this.live.get(agent.runDir)?.get(agent.agentId) !== agent || agent.awaitingCompletion) return;
		return getRunState(agent.runDir, [agent.agentId], { includeLineCounts: false }).agents[0];
	}

	private sameState(expected: AgentState, actual?: AgentState): boolean {
		return actual?.id === expected.id && actual.status === expected.status && actual.exitCode === expected.exitCode;
	}
}
