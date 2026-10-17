import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { ASYNC_SUBAGENT_TOOL_DESCRIPTIONS } from "../../tool-descriptions.js";
import * as path from "node:path";
import { getRunState, stopAgents, validateBasename, validateStopSignal } from "../lib.js";
import { resolveSubagentRunDir } from "../core/lookup.js";
import { INLINE_RENDERING } from "../constants.js";
import { formatAgentStatus } from "../format.js";
import { emptyToolSlot } from "../ui.js";
import type { LiveAgent, SubagentRunRenderDetails } from "../types.js";

export function registerStopTool(
	pi: ExtensionAPI,
	liveAgents?: Map<string, Map<string, LiveAgent>>,
	onLiveAgentsChange?: () => void,
): void {
	pi.registerTool({
		...ASYNC_SUBAGENT_TOOL_DESCRIPTIONS.stopAction,
		...INLINE_RENDERING,
		parameters: Type.Object({
			runDir: Type.Optional(Type.String({ description: "Batch name (or run key). If omitted, uses this session's latest sub-agent batch." })),
			agentIds: Type.Optional(Type.Array(Type.String(), { description: "Specific agent IDs to stop. If omitted, stops all running agents in the run." })),
			force: Type.Optional(Type.Boolean({ description: "Send SIGKILL instead of SIGTERM (default false)", default: false })),
			signal: Type.Optional(Type.String({ description: "Stop signal to send: SIGTERM, SIGINT, or SIGKILL (default SIGTERM). Ignored when force=true." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runDir = resolveSubagentRunDir(ctx, params.runDir);
			if (params.agentIds) {
				for (const id of params.agentIds) validateBasename(id, "agentId");
			}

			const stopSignal = params.force ? "SIGKILL" : validateStopSignal(params.signal ?? "SIGTERM");
			const results = stopAgents(runDir, params.agentIds?.length ? params.agentIds : undefined, { signal: stopSignal });
			removeStoppedLiveAgents(liveAgents, runDir, results.filter((result) => result.stopped).map((result) => result.id));
			onLiveAgentsChange?.();
			const state = getRunState(runDir, params.agentIds);

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No agents found in this batch." }],
					details: { runDir, agents: [], mode: "stop" } satisfies SubagentRunRenderDetails,
				};
			}

			const lines = [
				`Stop requested in batch ${path.basename(runDir)}`,
				"",
				...results.map((result) => {
					if (result.stopped) {
						return `[stopped] ${result.id}${result.pid ? ` (pid ${result.pid})` : ""}${result.signal ? ` signal=${result.signal}` : ""}`;
					}
					const suffix = result.error ? `error=${result.error}` : result.message;
					return `${formatAgentStatus(result.previousStatus)} ${result.id}${result.pid ? ` (pid ${result.pid})` : ""}: ${suffix}`;
				}),
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { runDir, agents: state.agents, mode: "stop" } satisfies SubagentRunRenderDetails,
				isError: results.some((result) => result.error),
			};
		},

		renderCall() {
			return emptyToolSlot();
		},

		renderResult() {
			return emptyToolSlot();
		},
	});
}

function removeStoppedLiveAgents(liveAgents: Map<string, Map<string, LiveAgent>> | undefined, runDir: string, agentIds: string[]): void {
	if (!liveAgents || agentIds.length === 0) return;
	const liveRun = liveAgents.get(runDir);
	if (!liveRun) return;
	for (const agentId of agentIds) liveRun.delete(agentId);
	if (liveRun.size === 0) liveAgents.delete(runDir);
}
