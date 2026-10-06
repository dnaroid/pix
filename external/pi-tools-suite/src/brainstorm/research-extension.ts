import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COUNCIL_RESEARCH_TOOLS } from "./research-tools.js";
const allowed = new Set([...COUNCIL_RESEARCH_TOOLS, "Read", "Grep", "todo"]);

/** Explicitly loaded in council children, never the whole suite. */
export default function councilResearch(pi: ExtensionAPI): void {
	// Common spawn owns both gated repo queries and the requested tools-only
	// web capabilities. This extension owns only the stricter council guard.

	const select = () => {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools([...COUNCIL_RESEARCH_TOOLS, "todo"].filter((name) => available.has(name)));
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
