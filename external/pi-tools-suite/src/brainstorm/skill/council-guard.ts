import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Same allowlist as COUNCIL_TOOLS in scripts/lib/protocol.mjs (kept in sync by tests). */
export const COUNCIL_GUARD_TOOLS = ["read", "grep", "web_search", "web_fetch", "project_search"];
const ACTIVE = [...COUNCIL_GUARD_TOOLS, "todo", "compress"];
const allowed = new Set([...ACTIVE, "Read", "Grep"]);

/**
 * Loaded only in council participant processes via --extension. Model tool
 * aliases may map grep to an unrestricted shell; restore canonical read-only
 * tools after every selection and block everything else at call time.
 */
export default function councilGuard(pi: ExtensionAPI): void {
	const select = () => {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools(ACTIVE.filter((name) => available.has(name)));
	};
	pi.on("session_start", select);
	pi.on("model_select", select);
	pi.on("before_agent_start", select);
	pi.on("tool_call", (event) => allowed.has(event.toolName)
		? undefined
		: { block: true, reason: `${event.toolName} is not available to read-only council participants` });
}
