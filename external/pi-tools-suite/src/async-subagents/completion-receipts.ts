import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { getRunState, resolveSubagentAgentRunDir, type AgentState } from "./lib.js";
import { isTerminalAgentStatus } from "./core/notifications.js";
import type { CompletionDelivery } from "./completion-delivery.js";
import type { LiveAgent } from "./types.js";

interface Receipt {
	agent: LiveAgent;
	state: AgentState;
	reservation: ReturnType<CompletionDelivery["begin"]>;
	file?: string;
	text?: string;
	session?: string;
}

async function boundedArtifact(file: string): Promise<string | undefined> {
	const handle = await fs.open(file, "r");
	try {
		const bytes = Buffer.alloc(50 * 1024 + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		return bytesRead > 50 * 1024 ? undefined : bytes.subarray(0, bytesRead).toString("utf8");
	} finally { await handle.close(); }
}

/** Successful result-tool/full artifact reads can consume an undelivered completion.
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
		let file: string | undefined;
		if (event.toolName === "read" && typeof input.path === "string") {
			if (input.offset != null && input.offset !== 1) return;
			const requested = input.path.startsWith("~/") ? path.join(os.homedir(), input.path.slice(2)) : path.resolve(ctx.cwd, input.path);
			// Only registered result artifacts are eligible, not arbitrary reads.
			if (path.basename(requested) !== "result.md") return;
			file = await fs.realpath(requested).catch(() => undefined);
			if (!file || generation !== this.generation) return;
			for (const run of this.live.values()) {
				for (const candidate of run.values()) {
					const artifact = path.join(candidate.runDir, candidate.agentId, "result.md");
					if (file === await fs.realpath(artifact).catch(() => undefined)) agent = candidate;
				}
			}
		} else if ((event.toolName === "subagents" && input.action === "result") || event.toolName === "async_subagents_result") {
			if (typeof input.agentId !== "string") return;
			try {
				const runDir = resolveSubagentAgentRunDir(ctx.cwd, input.agentId, typeof input.runDir === "string" ? input.runDir : undefined);
				agent = this.live.get(runDir)?.get(input.agentId);
			} catch { return; }
		} else return;
		if (!agent || generation !== this.generation || agent.awaitingCompletion || ctx.signal?.aborted) return;
		const state = this.state(agent);
		if (!state || !isTerminalAgentStatus(state.status)) return;
		const receipt: Receipt = {
			agent, state, file, session: ctx.sessionManager.getSessionFile(),
			reservation: this.delivery.begin(ctx.sessionManager.getSessionFile(), [agent]),
		};
		this.release(event.toolCallId);
		this.pending.set(event.toolCallId, receipt);
		if (file) {
			try {
				// The built-in read tool cannot return more than 50 KiB. Bound the
				// extra IO and require exact content, not a guessed line count.
				receipt.text = await boundedArtifact(file);
				if (receipt.text === undefined) this.release(event.toolCallId);
			} catch { this.release(event.toolCallId); }
		}
	}

	async finish(event: Pick<ToolResultEvent, "toolCallId" | "isError" | "content" | "details">, ctx: ExtensionContext): Promise<void> {
		const receipt = this.pending.get(event.toolCallId);
		if (!receipt) return;
		try {
			if (event.isError || ctx.signal?.aborted || receipt.session !== ctx.sessionManager.getSessionFile()
				|| !this.sameState(receipt.state, this.state(receipt.agent))) return;
			if (receipt.file) {
				if (receipt.text === undefined || event.content.length !== 1 || event.content[0]?.type !== "text"
					|| event.content[0].text !== receipt.text) return;
				// A late rewrite/error must not be silenced by an older artifact.
				if (await boundedArtifact(receipt.file) !== receipt.text) return;
			} else {
				const details = event.details as { state?: AgentState; runDir?: string; agentId?: string } | undefined;
				if (details?.runDir !== receipt.agent.runDir || details.agentId !== receipt.agent.agentId
					|| !this.sameState(receipt.state, details.state)) return;
			}
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
		return getRunState(agent.runDir, [agent.agentId], { includeLineCounts: false, checkRpcPromptFailure: false }).agents[0];
	}

	private sameState(expected: AgentState, actual?: AgentState): boolean {
		return actual?.id === expected.id && actual.status === expected.status && actual.exitCode === expected.exitCode;
	}
}
