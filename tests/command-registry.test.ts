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

	it("registers /queue as an argument-taking local command", async () => {
		let queued = "";
		const commands = createSlashCommands({
			...noopActions(),
			runQueueCommand: async (argumentsText) => {
				queued = argumentsText;
			},
		}, host());

		const queue = commands.find((command) => command.name === "queue");
		assert.equal(queue?.kind, "builtin");
		assert.equal(queue.allowArguments, true);

		await queue.run?.("send later");
		assert.equal(queued, "send later");
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

	it("registers default model commands as argument-taking local commands", async () => {
		const calls: string[] = [];
		const commands = createSlashCommands({
			...noopActions(),
			runDefaultModelSlashCommand: async (argumentsText) => {
				calls.push(`model:${argumentsText}`);
			},
			runDefaultThinkingSlashCommand: async (argumentsText) => {
				calls.push(`thinking:${argumentsText}`);
			},
		}, host());

		const defaultModel = commands.find((command) => command.name === "default-model");
		const defaultThinking = commands.find((command) => command.name === "default-thinking");
		assert.equal(defaultModel?.kind, "builtin");
		assert.equal(defaultModel.allowArguments, true);
		assert.equal(defaultThinking?.kind, "builtin");
		assert.equal(defaultThinking.allowArguments, true);

		await defaultModel.run?.("zai/glm-5-turbo");
		await defaultThinking.run?.("high");
		assert.deepEqual(calls, ["model:zai/glm-5-turbo", "thinking:high"]);
	});

	it("registers autocomplete as an argument-taking local command", async () => {
		let argumentsSeen = "not-called";
		const commands = createSlashCommands({
			...noopActions(),
			runAutocompleteSlashCommand: async (argumentsText) => {
				argumentsSeen = argumentsText;
			},
		}, host());

		const autocomplete = commands.find((command) => command.name === "autocomplete");
		assert.equal(autocomplete?.kind, "builtin");
		assert.equal(autocomplete.allowArguments, true);

		await autocomplete.run?.("zai/glm-5-turbo");
		assert.equal(argumentsSeen, "zai/glm-5-turbo");
	});

	it("allows /autocomplete with an empty argument to disable", async () => {
		let argumentsSeen = "not-called";
		const commands = createSlashCommands({
			...noopActions(),
			runAutocompleteSlashCommand: async (argumentsText) => {
				argumentsSeen = argumentsText;
			},
		}, host());

		await commands.find((command) => command.name === "autocomplete")?.run?.("");

		assert.equal(argumentsSeen, "");
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
		runDefaultModelSlashCommand: noop,
		runAutocompleteSlashCommand: noop,
		runScopedModelsCommand: noop,
		runThinkingSlashCommand: noop,
		runDefaultThinkingSlashCommand: noop,
		runEnhanceCommand: noop,
		runExportCommand: noop,
		runImportCommand: noop,
		runShareCommand: noop,
		runCopyCommand: noop,
		runQueueCommand: noop,
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
