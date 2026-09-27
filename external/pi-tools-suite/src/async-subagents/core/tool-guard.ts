import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ignoreStaleExtensionContextError } from "../../context-usage.js";

export const SUBAGENT_DENIED_TOOLS = new Set([
	"question",
	"subagents",
	"async_subagents_spawn",
	"async_subagents_status",
	"async_subagents_wait",
	"async_subagents_result",
	"async_subagents_stop",
	"async_subagents_cleanup",
	// Approved policy (G2): the Claude provider registers this at
	// session_start; web search via the provider is prohibited in every child.
	"pi_claude_code_provider_web_search",
]);

export function filterSubagentTools(tools: readonly string[] | undefined): string[] | undefined {
	if (!tools) return undefined;
	return tools.filter((tool) => !SUBAGENT_DENIED_TOOLS.has(tool));
}

export default function subagentToolGuard(pi: ExtensionAPI): void {
	const toolApi = pi as ExtensionAPI & {
		getActiveTools?: () => string[];
		setActiveTools?: (tools: string[]) => void;
	};

	const applyGuard = () => {
		try {
			const activeTools = toolApi.getActiveTools?.() ?? [];
			const filtered = filterSubagentTools(activeTools) ?? [];
			if (filtered.length === activeTools.length) return;
			toolApi.setActiveTools?.(filtered);
		} catch (error) {
			ignoreStaleExtensionContextError(error);
		}
	};

	pi.on("session_start", applyGuard);
	pi.on("model_select", applyGuard);
	// Defense in depth: a denied tool that becomes active later (lazy
	// registration, reload) is still never executed.
	pi.on("tool_call", (event) => SUBAGENT_DENIED_TOOLS.has(event.toolName)
		? { block: true, reason: `${event.toolName} is not available to sub-agents` }
		: undefined);
}
