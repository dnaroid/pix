import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ignoreStaleExtensionContextError } from "../context-usage.js";
import { hasAvailableIndexedProjectRoot } from "../lib/project.js";
import projectSearch from "../project-search/index.js";
import repoDiscovery from "./index.js";

/** Query tools only: no setup commands or parent orchestration instructions. */
export default function subagentRepoDiscovery(pi: ExtensionAPI): void {
	const registered: string[] = [];
	const toolsOnly = {
		...pi,
		registerCommand: () => {},
		registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
			registered.push(tool.name);
			if (tool.name === "project_search") {
				// Children historically had access to indexed code/docs, not the
				// parent's other private session/task/commit history. Preserve
				// that boundary when replacing repo_search.
				pi.registerTool({
					...tool,
					description: "Read-only IDX code/document search for a subagent. Only code and knowledge sources are accessible; project session, task and Git histories are not exposed.",
					promptSnippet: "Use project_search with sources=['code','knowledge'] for unknown indexed code/document owners; first pass maxFiles=3 without includeContent. Never request sessions, tasks or commits.",
					promptGuidelines: [
						"Only code and knowledge are permitted in this subagent; query existing IDX state without initializing or changing it.",
						"Use lexical mode to avoid provider embedding calls; scope with pathPrefix/dedupeFile and read returned file ranges for evidence.",
					],
					parameters: {
						...tool.parameters,
						properties: {
							...(tool.parameters as unknown as { properties: Record<string, unknown> }).properties,
							sources: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true,
								items: { type: "string", enum: ["code", "knowledge"] },
								description: "Subagent may query only Code and Knowledge; omitted means both." },
						},
					} as typeof tool.parameters,
					async execute(id, params, signal, update, ctx) {
						const input = params && typeof params === "object" && !Array.isArray(params)
							? params as Record<string, unknown> : {};
						if (input.sources !== undefined && (!Array.isArray(input.sources) || !input.sources.length
							|| input.sources.some(source => source !== "code" && source !== "knowledge"))) {
							return { isError: true, content: [{ type: "text", text: "Subagent project_search allows only code and knowledge sources." }], details: { restricted: true } };
						}
						if (typeof input.query === "string" && /^patch:/iu.test(input.query.trim())) {
							return { isError: true, content: [{ type: "text", text: "Subagent project_search cannot inspect Git patch history." }], details: { restricted: true } };
						}
						return tool.execute(id, { ...input, sources: input.sources ?? ["code", "knowledge"] }, signal, update, ctx);
					},
				});
				return;
			}
			pi.registerTool(tool.name === "repo_audit" ? {
				...tool,
				promptSnippet: "Use repo_audit with only task-changed paths to inspect documentation relationships; report findings and coverage gaps to the parent.",
				promptGuidelines: ["Audit candidates are not proof of semantic drift. Read the relevant specs and dependencies. Stay within the assigned role's authority; do not delegate, initialize indexes or acknowledge unrelated specs."],
			} : tool);
		},
	};
	// Retain the ordinary indexed-project/idx gate and configured output profile.
	repoDiscovery(toolsOnly as unknown as Parameters<typeof repoDiscovery>[0]);
	if (hasAvailableIndexedProjectRoot()) projectSearch(toolsOnly as unknown as Parameters<typeof projectSearch>[0]);
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
