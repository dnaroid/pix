import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { ASYNC_SUBAGENT_TOOL_DESCRIPTIONS } from "../../tool-descriptions.js";
import { getRunState, resolveSubagentRunDir, validateBasename } from "../lib.js";
import { INLINE_RENDERING } from "../constants.js";
import { formatAgentStatus } from "../format.js";
import { emptyToolSlot } from "../ui.js";
import type { SubagentRunRenderDetails } from "../types.js";

export function registerStatusTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...ASYNC_SUBAGENT_TOOL_DESCRIPTIONS.statusAction,
		...INLINE_RENDERING,
		parameters: Type.Object({
			runDir: Type.Optional(Type.String({ description: "Run directory path. If omitted, uses the latest project sub-agent run from .pi/subagents/registry.json or .pi/subagents/." })),
			agentIds: Type.Optional(Type.Array(Type.String(), { description: "Filter to specific agent IDs" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runDir = resolveSubagentRunDir(ctx.cwd, params.runDir);
			if (params.agentIds) {
				for (const id of params.agentIds) validateBasename(id, "agentId");
			}
			const state = getRunState(runDir, params.agentIds);

			if (state.agents.length === 0) {
				return {
					content: [{ type: "text", text: "No agents found in run directory." }],
					details: { runDir, agents: [], mode: "status" } satisfies SubagentRunRenderDetails,
				};
			}

			const lines = state.agents.map((a) => {
				let line = `${formatAgentStatus(a.status)} ${a.id}`;
				if (a.pid) line += ` (pid ${a.pid})`;
				if (a.exitCode !== undefined) line += ` exit=${a.exitCode}`;
				if (a.startedAt) line += ` started=${a.startedAt}`;
				if (a.finishedAt) line += ` finished=${a.finishedAt}`;
				return line;
			});

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { runDir, agents: state.agents, mode: "status" } satisfies SubagentRunRenderDetails,
			};
		},

		renderCall() {
			return emptyToolSlot();
		},

		renderResult(result) {
			const details = result.details as SubagentRunRenderDetails | undefined;
			if (!details || details.agents.length === 0) return new Text("No agents found.", 0, 0);
			// The spawn action is the only visible run panel. Status checks feed the model, not the chat UI.
			return emptyToolSlot();
		},
	});
}
