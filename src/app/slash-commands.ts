import type { AgentSessionRuntime, SlashCommandSource, SourceInfo } from "@earendil-works/pi-coding-agent";
import { fuzzySearch, type FuzzyMatch, type FuzzySearchItem } from "../fuzzy.js";
import type { ParsedSlashInput, SlashCommand } from "./types.js";

export function parseSlashInput(text: string): ParsedSlashInput | undefined {
	if (!text.startsWith("/")) return undefined;

	const body = text.slice(1);
	const match = /^(\S*)(?:\s+(.*))?$/.exec(body);
	const commandArguments = match?.[2];
	return {
		commandName: match?.[1] ?? body,
		hasArguments: commandArguments !== undefined,
		arguments: commandArguments ?? "",
	};
}

export function getResourceSlashCommands(runtime: AgentSessionRuntime | undefined, builtInCommands: readonly SlashCommand[]): SlashCommand[] {
	if (!runtime) return [];

	const commands: SlashCommand[] = [];
	const seen = new Set(builtInCommands.map((command) => command.name));
	const addResourceCommand = (command: Omit<SlashCommand, "kind" | "allowArguments">): void => {
		if (!command.name || seen.has(command.name)) return;
		seen.add(command.name);
		commands.push({
			...command,
			kind: "resource",
			allowArguments: true,
		});
	};

	for (const command of runtime.session.extensionRunner.getRegisteredCommands()) {
		addResourceCommand({
			name: command.invocationName,
			description: formatResourceDescription(command.description, "extension", command.sourceInfo),
			source: "extension",
			sourceInfo: command.sourceInfo,
			keywords: [command.name, "extension"],
		});
	}

	for (const template of runtime.session.promptTemplates) {
		addResourceCommand({
			name: template.name,
			description: formatResourceDescription(template.description, "prompt", template.sourceInfo),
			source: "prompt",
			sourceInfo: template.sourceInfo,
			keywords: ["prompt", "template", template.argumentHint ?? ""].filter(Boolean),
		});
	}

	if (runtime.services.settingsManager.getEnableSkillCommands()) {
		for (const skill of runtime.session.resourceLoader.getSkills().skills) {
			addResourceCommand({
				name: `skill:${skill.name}`,
				description: formatResourceDescription(skill.description, "skill", skill.sourceInfo),
				source: "skill",
				sourceInfo: skill.sourceInfo,
				keywords: ["skill", skill.name],
			});
		}
	}

	return commands;
}

export function getSlashCommandMatches(commands: readonly SlashCommand[], query: string, limit?: number): FuzzyMatch<SlashCommand>[] {
	const items: FuzzySearchItem<SlashCommand>[] = commands.map((command) => ({
		value: command,
		label: command.name,
		...(command.keywords === undefined ? {} : { keywords: command.keywords }),
	}));
	return fuzzySearch(items, query, limit === undefined ? {} : { limit });
}

function formatResourceDescription(description: string | undefined, source: SlashCommandSource, sourceInfo?: SourceInfo): string {
	const tag = resourceSourceTag(source, sourceInfo);
	return description ? `[${tag}] ${description}` : `[${tag}]`;
}

function resourceSourceTag(source: SlashCommandSource, sourceInfo?: SourceInfo): string {
	if (!sourceInfo) return source;
	return `${source}:${sourceInfo.scope}`;
}
