import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const SUBAGENT_DENIED_TOOLS = new Set([
	"question",
	"subagents",
	"async_subagents_spawn",
	"async_subagents_status",
	"async_subagents_wait",
	"async_subagents_result",
	"async_subagents_stop",
	"async_subagents_cleanup",
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
		const activeTools = toolApi.getActiveTools?.() ?? [];
		const filtered = filterSubagentTools(activeTools) ?? [];
		if (filtered.length === activeTools.length) return;
		toolApi.setActiveTools?.(filtered);
	};

	pi.on("session_start", applyGuard);
	pi.on("model_select", applyGuard);
}
