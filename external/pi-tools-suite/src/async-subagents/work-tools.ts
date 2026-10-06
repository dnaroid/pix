import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAstGrepTool } from "../ast-grep/tool.js";
import webSearch from "../web-search/index.js";
import { SUBAGENT_OPTIONAL_TOOLS, SUBAGENT_WORK_TOOLS_ENV, type SubagentWorkTools } from "./core/child-tools.js";

/** Tools-only optional capabilities, selected once by the common launch boundary. */
export default function subagentWorkTools(pi: ExtensionAPI): void {
	const config = JSON.parse(process.env[SUBAGENT_WORK_TOOLS_ENV] ?? "{}") as SubagentWorkTools;
	const requested = new Set((config.optional ?? []).filter((name) => SUBAGENT_OPTIONAL_TOOLS.includes(name as typeof SUBAGENT_OPTIONAL_TOOLS[number])));
	const toolsOnly: ExtensionAPI = {
		...pi,
		registerCommand: () => {},
		registerTool: (tool) => { if (requested.has(tool.name)) pi.registerTool(tool); },
	};
	if (requested.has("ast_grep")) registerAstGrepTool(toolsOnly, { readOnly: true });
	if (requested.has("web_search") || requested.has("web_fetch")) webSearch(toolsOnly);

	// Codex aliases map grep to shell. A read-only selection must use the
	// canonical builtin instead, and must remain read-only on model changes.
	if (!config.readOnlySelection) return;
	const selected = config.readOnlySelection;
	const allowed = new Set(selected);
	const select = () => {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools(selected.filter((name) => available.has(name)));
	};
	pi.on("session_start", select);
	pi.on("model_select", select);
	pi.on("before_agent_start", select);
	pi.on("tool_call", (event) => allowed.has(event.toolName)
		? undefined
		: { block: true, reason: `${event.toolName} is not available to this read-only child` });
}
