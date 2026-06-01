import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { ensurePiToolsSuiteUserConfig, getPiToolsSuiteUserConfigPath } from "../config";
import { publishStartupSection } from "../startup-section";

type PromptCommand = {
	description?: string;
	prompt: string;
};

type PromptCommandsConfig = {
	commands: Record<string, PromptCommand>;
};

const CONFIG_KEY = "promptCommands";
const COMMANDS_KEY = "commands";
const MENU_COMMAND = "prompt-commands";
const CREATE_LABEL = "+ Create command";
const RUN_LABEL = "▶ Run command";
const EDIT_LABEL = "✎ Edit command";
const RENAME_LABEL = "↪ Rename command";
const DELETE_LABEL = "⌫ Delete command";
const LIST_LABEL = "List commands";
const PATH_LABEL = "Show config path";
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESERVED_COMMAND_NAMES = new Set([
	MENU_COMMAND,
	"help",
	"model",
	"settings",
	"reload",
	"new",
	"resume",
	"fork",
	"clone",
	"tree",
	"compact",
	"login",
	"logout",
	"tools",
]);

function getConfigPath(): string {
	return getPiToolsSuiteUserConfigPath();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeCommand(value: unknown): PromptCommand | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.prompt !== "string" || !value.prompt.trim()) return undefined;
	const command: PromptCommand = { prompt: value.prompt };
	if (typeof value.description === "string" && value.description.trim()) {
		command.description = value.description.trim();
	}
	return command;
}

function normalizeCommands(rawCommands: Record<string, unknown>): Record<string, PromptCommand> {
	const commands: Record<string, PromptCommand> = {};
	for (const [rawName, rawCommand] of Object.entries(rawCommands)) {
		const name = rawName.trim();
		if (!isValidCommandName(name)) continue;
		const command = normalizeCommand(rawCommand);
		if (command) commands[name] = command;
	}
	return commands;
}

function loadPromptCommandsConfig(): PromptCommandsConfig {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) return { commands: {} };

	const parsed = parseJsonc(readFileSync(configPath, "utf-8")) as unknown;
	if (!isRecord(parsed)) throw new Error(`${configPath} must contain an object.`);

	const rawPromptCommands = parsed[CONFIG_KEY];
	if (rawPromptCommands === undefined) return { commands: {} };
	if (!isRecord(rawPromptCommands)) throw new Error(`${configPath} ${CONFIG_KEY} must contain an object.`);

	const rawCommands = rawPromptCommands[COMMANDS_KEY];
	if (rawCommands === undefined) return { commands: {} };
	if (!isRecord(rawCommands)) throw new Error(`${configPath} ${CONFIG_KEY}.${COMMANDS_KEY} must contain an object.`);

	return { commands: normalizeCommands(rawCommands) };
}

function promptCommandsConfigForSave(config: PromptCommandsConfig): Record<string, unknown> {
	return { [COMMANDS_KEY]: config.commands };
}

function writeSharedConfigValue(path: (string | number)[], value: unknown): void {
	const configPath = getConfigPath();
	ensurePiToolsSuiteUserConfig();
	const original = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "{}\n";
	const edits = modify(original, path, value, {
		formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
	});
	const updated = applyEdits(original, edits);
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, updated.endsWith("\n") ? updated : `${updated}\n`, "utf-8");
}

function savePromptCommandsConfig(config: PromptCommandsConfig): void {
	writeSharedConfigValue([CONFIG_KEY], promptCommandsConfigForSave(config));
}

function isValidCommandName(name: string): boolean {
	return NAME_PATTERN.test(name) && !RESERVED_COMMAND_NAMES.has(name);
}

function validateCommandName(pi: ExtensionAPI, name: string, existingName?: string): string | undefined {
	if (!NAME_PATTERN.test(name)) return "Use 1–64 chars: letters, numbers, _ or -, starting with a letter.";
	if (RESERVED_COMMAND_NAMES.has(name)) return `/${name} is reserved.`;

	const commands = safeGetCommands(pi);
	const collides = commands.some((command) => command.name === name && name !== existingName);
	if (collides) return `/${name} already exists.`;
	return undefined;
}

function safeGetCommands(pi: ExtensionAPI): Array<{ name: string }> {
	try {
		const commands = typeof pi?.getCommands === "function" ? pi.getCommands() : [];
		return Array.isArray(commands) ? commands.filter((command) => typeof command?.name === "string") : [];
	} catch {
		return [];
	}
}

function sortedCommandNames(commands: Record<string, PromptCommand>): string[] {
	return Object.keys(commands).sort((a, b) => a.localeCompare(b));
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else console.log(message);
}

function commandLabel(name: string, command: PromptCommand): string {
	const description = command.description ? ` — ${command.description}` : "";
	return `/${name}${description}`;
}

function commandSummary(name: string, command: PromptCommand): string {
	const description = command.description ? ` — ${command.description}` : "";
	return `/${name}${description}\n  ${truncate(command.prompt.replace(/\s+/g, " "), 120)}`;
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function renderPrompt(command: PromptCommand, ctx: ExtensionContext): string {
	let prompt = command.prompt;
	prompt = prompt.split("{cwd}").join(ctx.cwd).split("{{cwd}}").join(ctx.cwd);
	return prompt;
}

async function runPromptCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string, command: PromptCommand): Promise<void> {
	const prompt = renderPrompt(command, ctx).trim();
	if (!prompt) return notify(ctx, `/${name} has an empty prompt.`, "error");

	await ctx.waitForIdle();
	pi.sendUserMessage(prompt);
}

async function reloadAfterConfigChange(ctx: ExtensionCommandContext, message: string): Promise<void> {
	notify(ctx, `${message}\nReloading commands from ${getConfigPath()}…`);
	await ctx.reload();
}

async function selectCommand(ctx: ExtensionContext, title: string, commands: Record<string, PromptCommand>): Promise<string | undefined> {
	if (!ctx.hasUI) {
		notify(ctx, "Prompt command menu requires interactive UI.", "warning");
		return undefined;
	}

	const names = sortedCommandNames(commands);
	if (names.length === 0) {
		notify(ctx, `No prompt commands yet. Config: ${getConfigPath()}`, "warning");
		return undefined;
	}

	const labels = names.map((name) => commandLabel(name, commands[name]));
	const labelToName = new Map(labels.map((label, index) => [label, names[index]]));
	const selected = await ctx.ui.select(title, labels);
	return selected ? labelToName.get(selected) : undefined;
}

async function createOrEditCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, existingName?: string): Promise<void> {
	if (!ctx.hasUI) return notify(ctx, "Prompt command editor requires interactive UI.", "warning");

	const config = loadPromptCommandsConfig();
	const existing = existingName ? config.commands[existingName] : undefined;
	const name = existingName ?? (await ctx.ui.input("Slash command name (without /)", "review"))?.trim();
	if (!name) return;

	const nameError = validateCommandName(pi, name, existingName);
	if (nameError) return notify(ctx, nameError, "error");

	const description = (await ctx.ui.input("Description", existing?.description ?? "Run a saved prompt"))?.trim();
	const initialPrompt = existing?.prompt ?? "Use this saved prompt.";
	const prompt = await ctx.ui.editor(`Prompt for /${name}`, initialPrompt);
	if (prompt === undefined) return;
	if (!prompt.trim()) return notify(ctx, "Prompt cannot be empty.", "error");

	config.commands[name] = {
		...(description ? { description } : {}),
		prompt,
	};
	savePromptCommandsConfig(config);
	await reloadAfterConfigChange(ctx, `Saved /${name}.`);
}

async function editCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const config = loadPromptCommandsConfig();
	const name = await selectCommand(ctx, "Edit prompt command", config.commands);
	if (!name) return;
	await createOrEditCommand(pi, ctx, name);
}

async function renameCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return notify(ctx, "Prompt command editor requires interactive UI.", "warning");

	const config = loadPromptCommandsConfig();
	const oldName = await selectCommand(ctx, "Rename prompt command", config.commands);
	if (!oldName) return;

	const newName = (await ctx.ui.input(`New name for /${oldName}`, oldName))?.trim();
	if (!newName || newName === oldName) return;

	const nameError = validateCommandName(pi, newName, oldName);
	if (nameError) return notify(ctx, nameError, "error");

	config.commands[newName] = config.commands[oldName];
	delete config.commands[oldName];
	savePromptCommandsConfig(config);
	await reloadAfterConfigChange(ctx, `Renamed /${oldName} to /${newName}.`);
}

async function deleteCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return notify(ctx, "Prompt command editor requires interactive UI.", "warning");

	const config = loadPromptCommandsConfig();
	const name = await selectCommand(ctx, "Delete prompt command", config.commands);
	if (!name) return;

	const confirmed = await ctx.ui.confirm("Delete prompt command?", `Delete /${name} from ${getConfigPath()}?`);
	if (!confirmed) return;

	delete config.commands[name];
	savePromptCommandsConfig(config);
	await reloadAfterConfigChange(ctx, `Deleted /${name}.`);
}

function listCommands(ctx: ExtensionContext): void {
	const commands = loadPromptCommandsConfig().commands;
	const names = sortedCommandNames(commands);
	if (names.length === 0) return notify(ctx, `No prompt commands. Config: ${getConfigPath()}`, "warning");
	notify(ctx, [`Prompt commands (${getConfigPath()}):`, ...names.map((name) => commandSummary(name, commands[name]))].join("\n"));
}

async function runFromMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return notify(ctx, "Prompt command menu requires interactive UI.", "warning");

	const config = loadPromptCommandsConfig();
	const name = await selectCommand(ctx, "Run prompt command", config.commands);
	if (!name) return;

	await runPromptCommand(pi, ctx, name, config.commands[name]);
}

async function showMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return notify(ctx, "Prompt command menu requires interactive UI.", "warning");

	const action = await ctx.ui.select("Prompt command builder", [
		RUN_LABEL,
		CREATE_LABEL,
		EDIT_LABEL,
		RENAME_LABEL,
		DELETE_LABEL,
		LIST_LABEL,
		PATH_LABEL,
	]);

	if (action === RUN_LABEL) await runFromMenu(pi, ctx);
	else if (action === CREATE_LABEL) await createOrEditCommand(pi, ctx);
	else if (action === EDIT_LABEL) await editCommand(pi, ctx);
	else if (action === RENAME_LABEL) await renameCommand(pi, ctx);
	else if (action === DELETE_LABEL) await deleteCommand(ctx);
	else if (action === LIST_LABEL) listCommands(ctx);
	else if (action === PATH_LABEL) notify(ctx, getConfigPath());
}

function publishPromptCommandsStartupSection(): void {
	publishStartupSection({
		id: "prompt-commands",
		title: "prompt commands",
		body: startupPromptCommandList(),
	});
}

function startupPromptCommandList(): string {
	try {
		const names = sortedCommandNames(loadPromptCommandsConfig().commands);
		return names.length > 0 ? names.map((name) => `/${name}`).join(", ") : "no commands";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `error loading prompt commands: ${message}`;
	}
}

function registerDynamicPromptCommand(pi: ExtensionAPI, name: string): void {
	pi.registerCommand(name, {
		description: loadPromptCommandsConfig().commands[name]?.description ?? `Run saved prompt command /${name}`,
		handler: async (_input, ctx) => {
			const command = loadPromptCommandsConfig().commands[name];
			if (!command) {
				notify(ctx, `Prompt command /${name} no longer exists. Run /${MENU_COMMAND} or /reload.`, "warning");
				return;
			}
			await runPromptCommand(pi, ctx, name, command);
		},
	});
}

function registerMenuCommand(pi: ExtensionAPI, name: string, description: string): void {
	pi.registerCommand(name, {
		description,
		handler: async (_input, ctx) => {
			return showMenu(pi, ctx);
		},
	});
}

export default function promptCommands(pi: ExtensionAPI): void {
	publishPromptCommandsStartupSection();

	registerMenuCommand(pi, MENU_COMMAND, "Create, edit, delete, list, and run saved prompt slash commands");

	for (const name of sortedCommandNames(loadPromptCommandsConfig().commands)) {
		registerDynamicPromptCommand(pi, name);
	}
}
