import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

export interface ReloadContextInventory {
	readonly model: string;
	readonly skills: readonly string[];
	readonly tools: readonly string[];
	readonly agents: readonly string[] | undefined;
	readonly skillsReadable: boolean;
	readonly subagentsActive: boolean;
}

export function createReloadContextInventory(
	runtime: AgentSessionRuntime,
	agentTypes: readonly string[] | undefined,
): ReloadContextInventory {
	const session = runtime.session;
	const tools = unique(session.getActiveToolNames());
	const skillsReadable = tools.some(isSkillFileAccessTool);
	const subagentsActive = tools.includes("subagents");
	const skills = skillsReadable
		? unique(session.resourceLoader.getSkills().skills.map((skill) => skill.name)).sort(compareText)
		: [];
	const agents = subagentsActive && agentTypes !== undefined
		? unique(agentTypes).sort(compareText)
		: subagentsActive
			? undefined
			: [];
	return {
		model: currentModelLabel(runtime),
		skills,
		tools,
		agents,
		skillsReadable,
		subagentsActive,
	};
}

function isSkillFileAccessTool(toolName: string): boolean {
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
		`Skills (in context): ${inventory.skillsReadable ? listOrNone(inventory.skills) : "(none; read/bash inactive)"}`,
		"",
		`Tools (active): ${listOrNone(inventory.tools)}`,
		"",
		`Agents (available): ${formatAgents(inventory)}`,
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
	if (!inventory.subagentsActive) return "(none; subagents tool inactive)";
	if (inventory.agents === undefined) return "(catalog unavailable)";
	return listOrNone(inventory.agents);
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
