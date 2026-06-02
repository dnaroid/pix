import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { CommandControllerHost } from "../src/app/commands/command-controller.js";
import { createSlashCommands, type CommandRegistryActions } from "../src/app/commands/command-registry.js";
import { getResourceSlashCommands, getSlashCommandMatches } from "../src/app/commands/slash-commands.js";

describe("command registry", () => {
	it("handles /usage locally", async () => {
		let ranUsage = false;
		const commands = createSlashCommands({
			...noopActions(),
			runUsageCommand: async () => {
				ranUsage = true;
			},
		}, host());

		const usage = commands.find((command) => command.name === "usage");
		assert.equal(usage?.kind, "builtin");
		assert.equal(usage.allowArguments, undefined);
		assert.equal(usage.suppressCommandEcho, true);

		await usage.run?.("");
		assert.equal(ranUsage, true);
	});

	it("does not expose a resource /usage command over the local command", () => {
		const commands = createSlashCommands(noopActions(), host());
		const runtime = {
			session: {
				extensionRunner: {
					getRegisteredCommands: () => [{
						name: "usage",
						invocationName: "usage",
						description: "resource usage command",
						sourceInfo: { scope: "project" },
					}],
				},
				promptTemplates: [],
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			services: { settingsManager: { getEnableSkillCommands: () => false } },
		} as unknown as AgentSessionRuntime;

		assert.equal(getResourceSlashCommands(runtime, commands).some((command) => command.name === "usage"), false);
	});

	it("registers /search as an argument-taking local command", async () => {
		let query = "";
		const commands = createSlashCommands({
			...noopActions(),
			runSearchCommand: async (argumentsText) => {
				query = argumentsText;
			},
		}, host());

		const search = commands.find((command) => command.name === "search");
		assert.equal(search?.kind, "builtin");
		assert.equal(search.allowArguments, true);

		await search.run?.("needle");
		assert.equal(query, "needle");
	});

	it("registers /update as an argument-taking local command", async () => {
		let argumentsSeen = "";
		const commands = createSlashCommands({
			...noopActions(),
			runUpdateCommand: async (argumentsText) => {
				argumentsSeen = argumentsText;
			},
		}, host());

		const update = commands.find((command) => command.name === "update");
		assert.equal(update?.kind, "builtin");
		assert.equal(update.allowArguments, true);

		await update.run?.("--check");
		assert.equal(argumentsSeen, "--check");
	});

	it("matches slash commands typed with the Russian keyboard layout selected", () => {
		const commands = createSlashCommands(noopActions(), host());
		const [match] = getSlashCommandMatches(commands, "туц", 1);

		assert.equal(match?.value.name, "new");
	});

	it("matches slash command fuzzy queries against command names only", () => {
		const commands = createSlashCommands(noopActions(), host());

		assert.equal(commands.find((command) => command.name === "hotkeys")?.keywords?.includes("help"), true);
		assert.equal(getSlashCommandMatches(commands, "help").some((match) => match.value.name === "hotkeys"), false);
		assert.equal(getSlashCommandMatches(commands, "hot")[0]?.value.name, "hotkeys");
	});
});

function host(): CommandControllerHost {
	return { stop: async () => undefined } as CommandControllerHost;
}

function noopActions(): CommandRegistryActions {
	const noop = async () => undefined;
	return {
		runSettingsCommand: noop,
		runModelSlashCommand: noop,
		runScopedModelsCommand: noop,
		runThinkingSlashCommand: noop,
		runEnhanceCommand: noop,
		runExportCommand: noop,
		runImportCommand: noop,
		runShareCommand: noop,
		runCopyCommand: noop,
		runNameCommand: noop,
		runSessionInfoCommand: noop,
		runUsageCommand: noop,
		runChangelogCommand: noop,
		runUpdateCommand: noop,
		runHotkeysCommand: noop,
		runForkCommand: noop,
		runCloneCommand: noop,
		runTreeCommand: noop,
		runJumpCommand: noop,
		runSearchCommand: noop,
		runUnsupportedBuiltinCommand: noop,
		runReloadCommand: noop,
		runResumePathCommand: noop,
		runResumeCommand: noop,
		runNewSessionCommand: noop,
		runNewTabCommand: noop,
		runCompactCommand: noop,
	};
}
