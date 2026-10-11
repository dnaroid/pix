import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

export type ReloadAgentCatalog = readonly string[] | { readonly types: readonly string[]; readonly projectTypes?: readonly string[] };

export interface ReloadContextInventory {
	readonly model: string;
	readonly contextFiles: readonly string[];
	readonly skills: readonly string[];
	readonly projectSkills: readonly string[];
	readonly tools: readonly string[];
	readonly agents: readonly string[] | undefined;
	readonly projectAgents?: readonly string[];
	readonly skillsReadable: boolean;
	readonly subagentsActive: boolean;
}

export function createReloadContextInventory(
	runtime: AgentSessionRuntime,
	agentCatalog: ReloadAgentCatalog | undefined,
): ReloadContextInventory {
	const session = runtime.session;
	const tools = unique(session.getActiveToolNames());
	const skillsReadable = tools.some(isSkillFileAccessTool);
	const subagentsActive = tools.includes("subagents");
	const loadedSkills = skillsReadable ? session.resourceLoader.getSkills().skills : [];
	const agentTypes = agentCatalog && ("types" in agentCatalog ? agentCatalog.types : agentCatalog);
	const projectTypes = agentCatalog && "types" in agentCatalog ? agentCatalog.projectTypes : undefined;
	const skills = skillsReadable
		? unique(loadedSkills.map((skill) => skill.name)).sort(compareText)
		: [];
	const agents = subagentsActive && agentTypes !== undefined
		? unique(agentTypes).sort(compareText)
		: subagentsActive
			? undefined
			: [];
	return {
		model: currentModelLabel(runtime),
		contextFiles: unique(session.resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.path)),
		skills,
		projectSkills: unique(loadedSkills.filter((skill) => skill.sourceInfo?.scope === "project").map((skill) => skill.name)).sort(compareText),
		tools,
		agents,
		...(projectTypes === undefined ? {} : { projectAgents: subagentsActive ? unique(projectTypes).filter((name) => agents?.includes(name)).sort(compareText) : [] }),
		skillsReadable,
		subagentsActive,
	};
}

/**
 * Active tools that can load a discovered SKILL.md file. Tool names come from
 * model-specific adapters, so compare their supported names case-insensitively.
 */
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

export function formatReloadContextInventory(
	inventory: ReloadContextInventory,
	heading = "Reloaded keybindings, extensions, skills, prompts, themes",
): string {
	return [
		heading,
		"",
		`Model: ${inventory.model}`,
		"",
		`Context files (in context):${inventory.contextFiles.length ? `\n${inventory.contextFiles.map((path) => `- ${path}`).join("\n")}` : " (none)"}`,
		"",
		inventory.skillsReadable ? formatScopedResources("Skills", inventory.skills, inventory.projectSkills) : "Skills (in context): (none; read/bash inactive)",
		"",
		`Tools (active): ${listOrNone(inventory.tools)}`,
		"",
		formatAgents(inventory),
	].join("\n");
}

function currentModelLabel(runtime: AgentSessionRuntime): string {
	const model = runtime.session.model;
	if (!model) return "unavailable";
	const thinking = runtime.session.thinkingLevel;
	const modelRef = `${model.provider}/${model.id}`;
	return !thinking || thinking === "off" ? modelRef : `${modelRef}:${thinking}`;
}

function formatAgents(inventory: ReloadContextInventory): string {
	if (!inventory.subagentsActive) return "Agents (available): (none; subagents tool inactive)";
	if (inventory.agents === undefined) return "Agents (available): (catalog unavailable)";
	if (inventory.projectAgents === undefined) return `Agents (available): ${listOrNone(inventory.agents)}`;
	return formatScopedResources("Agents", inventory.agents, inventory.projectAgents);
}

function formatScopedResources(label: string, names: readonly string[], project: readonly string[]): string {
	return `${label} (global): ${listOrNone(names.filter((name) => !project.includes(name)))}\n${label} (project): ${listOrNone(names.filter((name) => project.includes(name)))}`;
}

function listOrNone(values: readonly string[]): string {
	return values.length > 0 ? values.join(", ") : "(none)";
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function compareText(left: string, right: string): number {
	return left.localeCompare(right);
}
