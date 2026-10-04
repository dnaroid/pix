import { filterSubagentConfigForContext, type SubagentConfig } from "./config.js";
import { SUBAGENT_DELEGATION_GUIDANCE } from "./agent-strategy.js";

export const SUBAGENT_TYPE_SELECTION_GUIDANCE = "Choose and set subagentType from the available catalog when a role clearly matches, preferring a matching project-local specialist. Preserve a user-requested role when it is available in the current catalog. Omit subagentType only when unsure or when the user explicitly requests automatic routing; the LLM router handles omissions only. Model/thinking overrides are not substitutes for choosing a role.";

const MAX_DESCRIPTION_CHARS = 500;

/**
 * Render the effective sub-agent type catalog for the parent system prompt.
 * The config has already merged built-ins, config files, and project-local
 * `.pi/agents/*.md`, so this stays aligned with what spawn/routing can use.
 */
export function buildSubagentCatalogPrompt(config: SubagentConfig, parentModelRef?: string, cwd?: string): string | undefined {
	const effectiveConfig = filterSubagentConfigForContext(config, { parentModelRef, cwd });
	const entries = Object.entries(effectiveConfig.types).sort(([left], [right]) => left.localeCompare(right));
	if (entries.length === 0) return undefined;
	const activeProjectReplacements = entries
		.map(([name]) => ({ name, metadata: effectiveConfig.projectAgentMetadata?.[name] }))
		.filter((item) => item.metadata?.replacesBuiltin)
		.map((item) => item.name);
	const projectReplacementGuidance = activeProjectReplacements.length > 0
		? `Project-local agent definitions replace same-named built-ins completely. Active project replacements of built-ins: ${activeProjectReplacements.join(", ")}.`
		: undefined;
	const knowledgeFinalizationGuidance = effectiveConfig.types["knowledge-auditor"]
		? "After all implementation edits, delegate the final task-scoped repository-knowledge audit to `knowledge-auditor` with the behavior/result and exact project-relative changed paths. Before finalizing, obtain its result and close task-related escalations/unreviewed specs or report blockers, including remaining knowledge dirty state. Later edits require re-review; spawning alone is not completion."
		: undefined;

	return [
		'<available_subagent_types>',
		"Effective sub-agent types available to the `subagents` tool for this project.",
		"These names are valid explicit `subagentType` values. Project-local `.pi/agents/*.md` roles are included when enabled by the current config.",
		SUBAGENT_TYPE_SELECTION_GUIDANCE,
		SUBAGENT_DELEGATION_GUIDANCE,
		...(projectReplacementGuidance ? [projectReplacementGuidance] : []),
		...(knowledgeFinalizationGuidance ? [knowledgeFinalizationGuidance] : []),
		...entries.map(([name, profile]) => `- ${escapePromptText(name)}: ${catalogDescription(profile.description)}`),
		'</available_subagent_types>',
	].join("\n");
}

function catalogDescription(description: string | undefined): string {
	const text = description?.trim() || "No description; use only when the task explicitly names this type.";
	const bounded = text.length <= MAX_DESCRIPTION_CHARS
		? text
		: `${text.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;
	return escapePromptText(bounded.replace(/\s+/g, " "));
}

function escapePromptText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
