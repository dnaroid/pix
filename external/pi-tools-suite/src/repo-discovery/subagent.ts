import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ignoreStaleExtensionContextError } from "../context-usage.js";
import repoDiscovery from "./index.js";

/** Query tools only: no setup commands or parent orchestration instructions. */
export default function subagentRepoDiscovery(pi: ExtensionAPI): void {
	const registered: string[] = [];
	const toolsOnly = {
		...pi,
		registerCommand: () => {},
		registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
			registered.push(tool.name);
			pi.registerTool(tool.name === "repo_audit" ? {
				...tool,
				promptSnippet: "Use repo_audit with only task-changed paths to inspect documentation relationships; report findings and coverage gaps to the parent.",
				promptGuidelines: ["Audit candidates are not proof of semantic drift. Read the relevant specs and dependencies. Stay within the assigned role's authority; do not delegate, initialize indexes or acknowledge unrelated specs."],
			} : tool);
		},
	};
	// Retain the ordinary indexed-project/idx gate and configured output profile.
	repoDiscovery(toolsOnly as unknown as Parameters<typeof repoDiscovery>[0]);
	const enableQueries = () => {
		try {
			const available = new Set(pi.getAllTools().map((tool) => tool.name));
			const active = pi.getActiveTools();
			const next = [...new Set([...active, ...registered.filter((name) => available.has(name))])];
			if (next.length !== active.length) pi.setActiveTools(next);
		} catch (error) {
			ignoreStaleExtensionContextError(error);
		}
	};
	pi.on("session_start", enableQueries);
	pi.on("model_select", enableQueries);
}
