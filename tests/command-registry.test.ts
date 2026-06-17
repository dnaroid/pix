import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { CommandControllerHost } from "../src/app/commands/command-controller.js";
import { createSlashCommands, type CommandRegistryActions } from "../src/app/commands/command-registry.js";
import { getResourceSlashCommands, getSlashCommandMatches, parseSlashInput } from "../src/app/commands/slash-commands.js";

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

	it("registers /history as an argument-taking local command", async () => {
		let query = "";
		const commands = createSlashCommands({
			...noopActions(),
			runHistoryCommand: async (argumentsText) => {
				query = argumentsText;
			},
		}, host());

		const history = commands.find((command) => command.name === "history");
		assert.equal(history?.kind, "builtin");
		assert.equal(history.allowArguments, true);

		await history.run?.("needle");
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

	it("registers no-context-files as an argument-taking local command", async () => {
		let argumentsSeen = "not-called";
		const commands = createSlashCommands({
			...noopActions(),
			runNoContextFilesSlashCommand: async (argumentsText) => {
				argumentsSeen = argumentsText;
			},
		}, host());

		const noContextFiles = commands.find((command) => command.name === "no-context-files");
		assert.equal(noContextFiles?.kind, "builtin");
		assert.equal(noContextFiles.allowArguments, true);

		await noContextFiles.run?.("on");
		assert.equal(argumentsSeen, "on");
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

	it("parses slash input boundaries and arguments", () => {
		assert.equal(parseSlashInput("plain text"), undefined);
		assert.deepEqual(parseSlashInput("/"), { commandName: "", hasArguments: false, arguments: "" });
		assert.deepEqual(parseSlashInput("/model"), { commandName: "model", hasArguments: false, arguments: "" });
		assert.deepEqual(parseSlashInput("/model   zai/glm high"), { commandName: "model", hasArguments: true, arguments: "zai/glm high" });
	});

	it("collects extension, prompt, and skill slash commands with source tags and duplicate filtering", () => {
		const builtIns = [{ name: "known", description: "known", kind: "builtin" }] as ReturnType<typeof createSlashCommands>;
		const runtime = {
			session: {
				extensionRunner: {
					getRegisteredCommands: () => [
						{ name: "internal", invocationName: "known", description: "duplicate", sourceInfo: { scope: "project" } },
						{ name: "ext-internal", invocationName: "ext", description: undefined, sourceInfo: { scope: "user" } },
					],
				},
				promptTemplates: [
					{ name: "ask", description: "ask prompt", argumentHint: "topic", sourceInfo: { scope: "project" } },
					{ name: "", description: "ignored" },
				],
				resourceLoader: {
					getSkills: () => ({ skills: [{ name: "debug", description: "debug skill", sourceInfo: { scope: "user" } }] }),
				},
			},
			services: { settingsManager: { getEnableSkillCommands: () => true } },
		} as unknown as AgentSessionRuntime;

		const commands = getResourceSlashCommands(runtime, builtIns);

		assert.deepEqual(commands.map((command) => command.name), ["ext", "ask", "skill:debug"]);
		assert.equal(commands.every((command) => command.kind === "resource" && command.allowArguments), true);
		assert.equal(commands[0]?.description, "[extension:user]");
		assert.equal(commands[1]?.description, "[prompt:project] ask prompt");
		assert.deepEqual(commands[1]?.keywords, ["prompt", "template", "topic"]);
		assert.equal(commands[2]?.description, "[skill:user] debug skill");
	});

	it("wires every builtin slash command to the expected action", async () => {
		const calls: string[] = [];
		let stopped = false;
		const actions = recordingActions(calls);
		const commands = createSlashCommands(actions, { stop: async () => { stopped = true; } } as CommandControllerHost);

		for (const command of commands) {
			await command.run?.(command.name === "resume" ? "'/tmp/session.jsonl' --ignored" : " args ");
		}

		assert.equal(stopped, true);
		assert.ok(calls.includes("runSettingsCommand"));
		assert.ok(calls.includes("runModelSlashCommand: args "));
		assert.ok(calls.includes("runDefaultModelSlashCommand: args "));
		assert.ok(calls.includes("runAutocompleteSlashCommand: args "));
		assert.ok(calls.includes("runNoContextFilesSlashCommand: args "));
		assert.ok(calls.includes("runScopedModelsCommand: args "));
		assert.ok(calls.includes("runThinkingSlashCommand: args "));
		assert.ok(calls.includes("runDefaultThinkingSlashCommand: args "));
		assert.ok(calls.includes("runEnhanceCommand"));
		assert.ok(calls.includes("runExportCommand: args "));
		assert.ok(calls.includes("runImportCommand: args "));
		assert.ok(calls.includes("runShareCommand"));
		assert.ok(calls.includes("runCopyCommand"));
		assert.ok(calls.includes("runQueueCommand: args "));
		assert.ok(calls.includes("runNameCommand: args "));
		assert.ok(calls.includes("runSessionInfoCommand"));
		assert.ok(calls.includes("runUsageCommand"));
		assert.ok(calls.includes("runChangelogCommand"));
		assert.ok(calls.includes("runUpdateCommand: args "));
		assert.ok(calls.includes("runHotkeysCommand"));
		assert.ok(calls.includes("runForkCommand: args "));
		assert.ok(calls.includes("runCloneCommand"));
		assert.ok(calls.includes("runTreeCommand: args "));
		assert.ok(calls.includes("runJumpCommand: args "));
		assert.ok(calls.includes("runHistoryCommand: args "));
		assert.ok(calls.includes("runSearchCommand: args "));
		assert.ok(calls.some((call) => call.startsWith("runUnsupportedBuiltinCommand:login:")));
		assert.ok(calls.some((call) => call.startsWith("runUnsupportedBuiltinCommand:logout:")));
		assert.ok(calls.includes("runReloadCommand"));
		assert.ok(calls.includes("runResumePathCommand:/tmp/session.jsonl"));
		assert.ok(calls.includes("runNewSessionCommand"));
		assert.ok(calls.includes("runNewTabCommand"));
		assert.ok(calls.includes("runDeleteCommand: args "));
		assert.ok(calls.includes("runCompactCommand:args"));
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
		runNoContextFilesSlashCommand: noop,
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
		runHistoryCommand: noop,
		runSearchCommand: noop,
		runUnsupportedBuiltinCommand: noop,
		runReloadCommand: noop,
		runResumePathCommand: noop,
		runResumeCommand: noop,
		runNewSessionCommand: noop,
		runNewTabCommand: noop,
		runDeleteCommand: noop,
		runCompactCommand: noop,
	};
}

function recordingActions(calls: string[]): CommandRegistryActions {
	const record = (name: string) => async (...args: unknown[]) => {
		calls.push([name, ...args].join(":"));
	};
	return {
		runSettingsCommand: record("runSettingsCommand"),
		runModelSlashCommand: record("runModelSlashCommand"),
		runDefaultModelSlashCommand: record("runDefaultModelSlashCommand"),
		runAutocompleteSlashCommand: record("runAutocompleteSlashCommand"),
		runNoContextFilesSlashCommand: record("runNoContextFilesSlashCommand"),
		runScopedModelsCommand: record("runScopedModelsCommand"),
		runThinkingSlashCommand: record("runThinkingSlashCommand"),
		runDefaultThinkingSlashCommand: record("runDefaultThinkingSlashCommand"),
		runEnhanceCommand: record("runEnhanceCommand"),
		runExportCommand: record("runExportCommand"),
		runImportCommand: record("runImportCommand"),
		runShareCommand: record("runShareCommand"),
		runCopyCommand: record("runCopyCommand"),
		runQueueCommand: record("runQueueCommand"),
		runNameCommand: record("runNameCommand"),
		runSessionInfoCommand: record("runSessionInfoCommand"),
		runUsageCommand: record("runUsageCommand"),
		runChangelogCommand: record("runChangelogCommand"),
		runUpdateCommand: record("runUpdateCommand"),
		runHotkeysCommand: record("runHotkeysCommand"),
		runForkCommand: record("runForkCommand"),
		runCloneCommand: record("runCloneCommand"),
		runTreeCommand: record("runTreeCommand"),
		runJumpCommand: record("runJumpCommand"),
		runHistoryCommand: record("runHistoryCommand"),
		runSearchCommand: record("runSearchCommand"),
		runUnsupportedBuiltinCommand: record("runUnsupportedBuiltinCommand"),
		runReloadCommand: record("runReloadCommand"),
		runResumePathCommand: record("runResumePathCommand"),
		runResumeCommand: record("runResumeCommand"),
		runNewSessionCommand: record("runNewSessionCommand"),
		runNewTabCommand: record("runNewTabCommand"),
		runDeleteCommand: record("runDeleteCommand"),
		runCompactCommand: record("runCompactCommand"),
	};
}
