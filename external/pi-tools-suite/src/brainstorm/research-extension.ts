import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import repoDiscovery from "../repo-discovery/index.js";
import webSearch from "../web-search/index.js";
import { COUNCIL_RESEARCH_TOOLS } from "./research-tools.js";
const allowed = new Set([...COUNCIL_RESEARCH_TOOLS, "Read", "Grep"]);

/** Explicitly loaded in council children, never the whole suite. */
export default function councilResearch(pi: ExtensionAPI): void {
	// Do not expose credential/setup/update commands in research children.
	const toolsOnly = { ...pi, registerCommand: () => {} };
	webSearch(toolsOnly);
	// repo-discovery's standalone facade uses a deliberately loose tool type.
	repoDiscovery(toolsOnly as unknown as Parameters<typeof repoDiscovery>[0]);

	const select = () => {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools(COUNCIL_RESEARCH_TOOLS.filter((name) => available.has(name)));
	};
	// Model aliases can map grep to an unrestricted shell for Codex. Restore
	// canonical read-only builtins after model-tools selection, never that alias.
	pi.on("session_start", select);
	pi.on("model_select", select);
	pi.on("before_agent_start", select);
	pi.on("tool_call", (event) => allowed.has(event.toolName)
		? undefined
		: { block: true, reason: `${event.toolName} is not available to read-only council participants` });
}
