export const CONTEXT_INVENTORY_EVENT = "pi-tools-suite:context-inventory";

export interface ContextInventoryState {
	readonly version: 1;
	readonly reason?: "startup" | "reload" | "new" | "resume" | "fork" | "model_select";
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly tools: readonly string[];
	readonly skills: readonly string[];
	readonly projectSkills?: readonly string[];
	readonly contextFiles?: readonly string[];
	readonly agents?: readonly string[];
	readonly projectAgents?: readonly string[];
}

export function parseContextInventoryState(value: unknown): ContextInventoryState | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	const tools = stringList(value.tools);
	const skills = stringList(value.skills);
	if (!tools || !skills) return undefined;
	const contextFiles = value.contextFiles === undefined ? undefined : stringList(value.contextFiles);
	if (value.contextFiles !== undefined && !contextFiles) return undefined;
	const agents = value.agents === undefined ? undefined : stringList(value.agents);
	if (value.agents !== undefined && !agents) return undefined;
	const projectSkills = value.projectSkills === undefined ? undefined : stringList(value.projectSkills);
	const projectAgents = value.projectAgents === undefined ? undefined : stringList(value.projectAgents);
	if (value.projectSkills !== undefined && !projectSkills) return undefined;
	if (value.projectAgents !== undefined && !projectAgents) return undefined;
	const reason = contextInventoryReason(value.reason);
	if (value.reason !== undefined && !reason) return undefined;
	for (const key of ["sessionId", "sessionFile", "model", "thinking"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") return undefined;
	}
	const sessionId = text(value.sessionId);
	const sessionFile = text(value.sessionFile);
	const model = text(value.model);
	const thinking = text(value.thinking);
	return {
		version: 1,
		...(reason ? { reason } : {}),
		...(sessionId ? { sessionId } : {}),
		...(sessionFile ? { sessionFile } : {}),
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		tools,
		skills,
		...(projectSkills === undefined ? {} : { projectSkills: projectSkills.filter((name) => skills.includes(name)) }),
		...(projectAgents === undefined ? {} : { projectAgents: projectAgents.filter((name) => agents?.includes(name)) }),
		...(contextFiles === undefined ? {} : { contextFiles }),
		...(agents === undefined ? {} : { agents }),
	};
}

function contextInventoryReason(value: unknown): ContextInventoryState["reason"] | undefined {
	return value === "startup"
		|| value === "reload"
		|| value === "new"
		|| value === "resume"
		|| value === "fork"
		|| value === "model_select"
		? value
		: undefined;
}

export function formatReloadContextInventory(
	state: ContextInventoryState | undefined,
	heading = "/reload — reloaded extensions, skills, prompts, and context files",
): string {
	if (!state) return heading;
	const model = state.model
		? `${state.model}${state.thinking && state.thinking !== "off" ? `:${state.thinking}` : ""}`
		: "unavailable";
	return [
		heading,
		"",
		`Model: ${model}`,
		"",
		`Context files (in context):${formatContextFiles(state.contextFiles)}`,
		"",
		formatScopedResources("Skills", state.skills, state.projectSkills, "in context"),
		"",
		`Tools (active): ${listOrNone(state.tools)}`,
		"",
		state.agents === undefined ? "Agents (available): (catalog unavailable)" : formatScopedResources("Agents", state.agents, state.projectAgents, "available"),
	].join("\n");
}

export function withFinalSkillCommands(
	state: ContextInventoryState | undefined,
	commands: readonly { name: string; source: string; sourceInfo?: unknown }[],
): ContextInventoryState | undefined {
	if (!state) return undefined;
	const skillsReadable = state.tools.some(isSkillFileAccessTool);
	const skillCommands = skillsReadable ? commands.filter((command) => command.source === "skill") : [];
	const skills = skillsReadable
		? [...new Set(skillCommands
			.map((command) => command.name.replace(/^skill:/u, "").trim())
			.filter(Boolean))].sort((left, right) => left.localeCompare(right))
		: [];
	// Old command transports carry no provenance; preserve known scope for surviving names.
	const hasSources = skillCommands.every((command) => isRecord(command.sourceInfo)
		&& ["user", "project", "temporary"].includes(String(command.sourceInfo.scope)));
	let projectSkills = state.projectSkills?.filter((name) => skills.includes(name));
	if (hasSources) {
		projectSkills = skills.filter((name) => skillCommands.some((command) =>
			command.name.replace(/^skill:/u, "").trim() === name && isRecord(command.sourceInfo) && command.sourceInfo.scope === "project"));
	}
	return { ...state, skills, ...(projectSkills === undefined ? {} : { projectSkills }) };
}

function formatScopedResources(label: string, names: readonly string[], project: readonly string[] | undefined, legacyLabel: string): string {
	if (project === undefined) return `${label} (${legacyLabel}): ${listOrNone(names)}`;
	return `${label} (global): ${listOrNone(names.filter((name) => !project.includes(name)))}\n${label} (project): ${listOrNone(names.filter((name) => project.includes(name)))}`;
}

/** Active tools that can load a discovered SKILL.md file. */
export function isSkillFileAccessTool(toolName: string): boolean {
	switch (toolName.trim().toLowerCase()) {
		case "read":
		case "bash":
		case "shell":
		case "shell_command":
			return true;
		default:
			return false;
	}
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
	return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function listOrNone(values: readonly string[]): string {
	return values.length > 0 ? values.map(escapeMarkdownIdentifier).join(", ") : "(none)";
}

/**
 * Inventory identifiers are rendered by Desktop through MarkdownText. Keep
 * underscores literal so names such as `repo_inspect` cannot be parsed
 * as emphasis spanning neighbouring comma-separated identifiers.
 */
function escapeMarkdownIdentifier(value: string): string {
	return value.replace(/_/gu, "\\_");
}

function escapeMarkdownPath(value: string): string {
	return value.replace(/[\\`*_{}\[\]()#+.!|>~-]/gu, "\\$&");
}

function formatContextFiles(paths: readonly string[] | undefined): string {
	if (paths === undefined) return " (inventory unavailable)";
	if (paths.length === 0) return " (none)";
	return `\n${paths.map((path) => `- ${escapeMarkdownPath(path)}`).join("\n")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
