import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { ASYNC_SUBAGENT_TOOL_DESCRIPTIONS } from "../../tool-descriptions.js";
import { resolveSubagentRunDir, validateBasename } from "../lib.js";
import { INLINE_RENDERING } from "../constants.js";
import { formatAgentStatus } from "../format.js";
import { pollRunWithUpdates } from "../polling.js";
import { emptyToolSlot } from "../ui.js";
import type { LiveAgent, SubagentRunRenderDetails } from "../types.js";
import type { RunState } from "../lib.js";
import type { CompletionDelivery } from "../completion-delivery.js";

export function registerWaitTool(
	pi: ExtensionAPI,
	liveAgents?: Map<string, Map<string, LiveAgent>>,
	completionDelivery?: CompletionDelivery,
): void {
	pi.registerTool({
		...ASYNC_SUBAGENT_TOOL_DESCRIPTIONS.waitAction,
		...INLINE_RENDERING,
		parameters: Type.Object({
			runDir: Type.Optional(Type.String({ description: "Run directory path. If omitted, waits on the latest project sub-agent run from .pi/subagents/registry.json or .pi/subagents/." })),
			agentIds: Type.Optional(Type.Array(Type.String(), { description: "Wait for specific agents only" })),
			timeout: Type.Optional(Type.Number({ description: "Max wait seconds (default 300)", default: 300 })),
			interval: Type.Optional(Type.Number({ description: "Poll interval seconds (default 3)", default: 3 })),
			failFast: Type.Optional(Type.Boolean({ description: "Return immediately on first failure (default false)", default: false })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const runDir = resolveSubagentRunDir(ctx.cwd, params.runDir);
			if (params.agentIds) {
				for (const id of params.agentIds) validateBasename(id, "agentId");
			}

			const agentIds = params.agentIds?.length ? params.agentIds : undefined;
			const timeout = params.timeout ?? 300;
			const reservation = completionDelivery?.begin(ctx.sessionManager?.getSessionFile?.(),
				[...(liveAgents?.get(runDir)?.values() ?? [])].filter((agent) => !agentIds || agentIds.includes(agent.agentId)));
			let deliveredState: RunState | undefined;
			try {
				const state = await pollRunWithUpdates(runDir, agentIds, {
					mode: "wait",
					timeoutSeconds: timeout,
					intervalSeconds: params.interval ?? 3,
					failFast: params.failFast ?? false,
					signal: signal ?? undefined,
					onUpdate,
					settledState: completionDelivery ? (state) => completionDelivery.settledState(state) : undefined,
				});

				const launched = state.agents.filter((a) => a.status !== "planned");
				const done = launched.filter((a) => a.status === "done").length;
				const failed = launched.filter((a) => a.status === "failed").length;
				const stopped = launched.filter((a) => a.status === "stopped").length;
				const stillRunning = launched.filter((a) => a.status === "running").length;

				const lines = [
					`Wait complete: ${done} done, ${failed} failed, ${stopped} stopped, ${stillRunning} still running`,
					"",
					...state.agents.map((a) => `${formatAgentStatus(a.status)} ${a.id}${a.exitCode !== undefined ? ` (exit ${a.exitCode})` : ""}`),
				];

				deliveredState = state;
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { runDir, agents: state.agents, mode: "wait" } satisfies SubagentRunRenderDetails,
				};
			} finally {
				reservation?.finish(deliveredState, signal);
			}
		},

		renderCall() {
			return emptyToolSlot();
		},

		renderResult() {
			// Waiting is a control/collection action. Do not create a second visible run panel.
			return emptyToolSlot();
		},
	});
}
