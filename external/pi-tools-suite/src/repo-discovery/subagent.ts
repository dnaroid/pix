import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ignoreStaleExtensionContextError } from "../context-usage.js";
import projectSearch from "../project-search/index.js";

/** Query tools only: no setup commands or parent orchestration instructions. */
export default function subagentRepoDiscovery(pi: ExtensionAPI): void {
	const registered: string[] = [];
	const toolsOnly = {
		...pi,
		registerCommand: () => {},
		registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
			registered.push(tool.name);
			if (tool.name === "project_search") {
				// Keep the shared schema and execution, but omit parent-only workflow guidance.
				pi.registerTool({
					...tool,
					promptSnippet: "Use project_search only for enabled sources listed in its current schema; first pass maxFiles=3 without includeContent. Select code/knowledge or patch:<literal> only when those sources are enabled.",
					promptGuidelines: [
						"Project selection controls both search and indexing. Global provider configuration does not enable disabled sources. Native lexical search needs no key; never configure providers for the user. Session queries rank cached vectors and do not embed session documents.",
						"Use lexical mode to avoid provider embedding calls; scope with pathPrefix/dedupeFile and read returned file ranges for evidence.",
					],
				});
				return;
			}
			pi.registerTool(tool);
		},
	};
	projectSearch(toolsOnly as unknown as Parameters<typeof projectSearch>[0]);
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
