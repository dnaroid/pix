import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { asyncSubagentToolDescriptions } from "../../tool-descriptions.js";
import { hasIndexedProjectRoot } from "../../lib/project.js";
import type { AgentCompletionHandler } from "../lib.js";
import { DEFAULT_SPAWN_WATCH_SECONDS, INLINE_RENDERING } from "../constants.js";
import { renderSubagentSpawnPrompts } from "../render.js";
import { emptyToolSlot } from "../ui.js";
import type { LiveAgent, SubagentRunRenderDetails } from "../types.js";
import { registerCleanupTool } from "./cleanup.js";
import { registerResultTool } from "./result.js";
import { registerSpawnTool } from "./spawn.js";
import { registerStatusTool } from "./status.js";
import { registerStopTool } from "./stop.js";
import { registerWaitTool } from "./wait.js";

const AgentTaskSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Short identifier for this agent (used as directory name). If omitted, assigns agent-1, agent-2, etc." })),
	task: Type.String({ description: "Focused task description for the sub-agent" }),
	scope: Type.Optional(Type.String({ description: "Relevant files/areas for this task" })),
	subagentType: Type.Optional(Type.String({ description: "Logical sub-agent type/profile from config. Usually omit this so the router selects from the current config; set only for an explicit user-requested role, deterministic tests, or another concrete override." })),
	model: Type.Optional(Type.String({ description: "Explicit model override for this sub-agent. Prefer subagentType for reusable routing." })),
	thinking: Type.Optional(Type.String({ description: "Per-agent thinking level override (off, minimal, low, medium, high, xhigh)." })),
	promptAppend: Type.Optional(Type.String({ description: "Extra prompt instructions appended after the generated/type prompt." })),
	promptOverride: Type.Optional(Type.String({ description: "Full prompt replacement for this sub-agent. Prefer configuring this per subagentType." })),
	focus: Type.Optional(Type.String({ description: "Optional focus/attention instructions for attached images or scoped inspection." })),
	attention: Type.Optional(Type.String({ description: "Alias for focus, accepted for compatibility." })),
	imagePaths: Type.Optional(Type.Array(Type.String(), { description: "Local image paths to attach to this sub-agent prompt (jpg, png, gif, or webp). Relative paths resolve from cwd." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool names to enable (e.g. ['read','grep','bash'])" })),
	extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Additional pi CLI args for this sub-agent" })),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Per-agent wall-clock timeout in seconds. Overrides config/default timeout for this task." })),
	parentObjective: Type.Optional(Type.String({ description: "Parent task context (default: 'current user task')" })),
});

const ACTION_TO_INTERNAL_TOOL: Record<string, string> = {
	spawn: "async_subagents_spawn",
	status: "async_subagents_status",
	wait: "async_subagents_wait",
	result: "async_subagents_result",
	stop: "async_subagents_stop",
	cleanup: "async_subagents_cleanup",
};

class ToolCollector {
	tools = new Map<string, any>();
	registerTool(tool: any): void { this.tools.set(tool.name, tool); }
}

function normalizeAction(value: unknown): string | undefined {
	return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function firstText(result: any): string {
	const item = result?.content?.[0];
	return item?.type === "text" ? item.text : "(no output)";
}

function hasString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validateActionParams(action: string, params: Record<string, unknown>): string | undefined {
	if (action === "result") {
		if (!hasString(params.agentId)) return "result requires agentId.";
	}
	return undefined;
}

export function registerSubagentsTool(
	pi: ExtensionAPI,
	liveAgents: Map<string, Map<string, LiveAgent>>,
	handleAgentCompletion: AgentCompletionHandler,
	onLiveAgentsChange?: () => void,
): void {
	const toolDescriptions = asyncSubagentToolDescriptions(hasIndexedProjectRoot());
	const collector = new ToolCollector();
	registerSpawnTool(collector as any, liveAgents, handleAgentCompletion, onLiveAgentsChange);
	registerStatusTool(collector as any);
	registerStopTool(collector as any, liveAgents, onLiveAgentsChange);
	registerWaitTool(collector as any);
	registerResultTool(collector as any);
	registerCleanupTool(collector as any);

	pi.registerTool({
		...toolDescriptions.subagents,
		...INLINE_RENDERING,
		parameters: Type.Object({
			action: Type.String({ description: "Operation to perform: spawn, status, wait, result, stop, or cleanup" }),

			// spawn options
			tasks: Type.Optional(Type.Array(AgentTaskSchema, { description: "spawn: agent tasks to launch" })),
			runDir: Type.Optional(Type.String({ description: "spawn/status/wait/result/stop: run directory path. spawn creates one when omitted; status/wait/stop default to the latest project run; result can resolve runDir by agentId through .pi/subagents/registry.json." })),
			slug: Type.Optional(Type.String({ description: "spawn: slug for a newly created run directory" })),
			thinking: Type.Optional(Type.String({ description: "spawn: thinking level for sub-agents (off, minimal, low, medium, high, xhigh)" })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "spawn: additional pi CLI args for sub-agents" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "spawn: wall-clock timeout in seconds for every spawned agent in this call; task timeoutSeconds overrides this." })),
			watchSeconds: Type.Optional(Type.Number({ description: "spawn: live update watch window (default/max 300s; 0 detaches immediately)", default: DEFAULT_SPAWN_WATCH_SECONDS })),

			// status/wait/stop/result options
			agentIds: Type.Optional(Type.Array(Type.String(), { description: "status/wait/stop: filter to these agent IDs" })),
			agentId: Type.Optional(Type.String({ description: "result: agent ID to read" })),
			timeout: Type.Optional(Type.Number({ description: "wait: max wait seconds (default 300)", default: 300 })),
			interval: Type.Optional(Type.Number({ description: "wait: poll interval seconds (default 3)", default: 3 })),
			failFast: Type.Optional(Type.Boolean({ description: "wait: return immediately on first failure (default false)", default: false })),
			force: Type.Optional(Type.Boolean({ description: "stop: send SIGKILL instead of SIGTERM (default false)", default: false })),
			signal: Type.Optional(Type.String({ description: "stop: signal to send: SIGTERM, SIGINT, or SIGKILL (default SIGTERM). Ignored when force=true." })),

			// cleanup options
			runRoot: Type.Optional(Type.String({ description: "cleanup: root directory (default: .pi/subagents)" })),
			days: Type.Optional(Type.Number({ description: "cleanup: remove runs older than N days (default 7)", default: 7 })),
			keep: Type.Optional(Type.Number({ description: "cleanup: always keep newest N runs (default 20)", default: 20 })),
			delete: Type.Optional(Type.Boolean({ description: "cleanup: actually delete (default: dry-run)", default: false })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const action = normalizeAction(params.action);
			const internalName = action ? ACTION_TO_INTERNAL_TOOL[action] : undefined;
			if (!action || !internalName) {
				return {
					content: [{ type: "text", text: "Invalid subagents action. Use one of: spawn, status, wait, result, stop, cleanup." }],
					isError: true,
				};
			}
			const validationError = validateActionParams(action, params);
			if (validationError) {
				return {
					content: [{ type: "text", text: validationError }],
					isError: true,
				};
			}

			const tool = collector.tools.get(internalName);
			if (!tool) throw new Error(`Internal subagents action is not registered: ${internalName}`);
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall() {
			return emptyToolSlot();
		},

		renderResult(result, _opts, theme) {
			const details = result.details as SubagentRunRenderDetails | undefined;
			if (!details) return new Text(firstText(result), 0, 0);
			if (details.mode === "spawn" && Array.isArray(details.agents) && theme) {
				return renderSubagentSpawnPrompts(details, _opts, theme);
			}
			return emptyToolSlot();
		},
	});
}
