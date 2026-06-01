import path from "node:path";
import { REPO_DISCOVERY_TOOLS } from "../tool-descriptions";
import { directoryExists, findIndexedProjectRoot, findProjectRoot } from "../lib/project.js";

const IDX_COMMANDS = ["architecture", "structure", "ast", "search", "explain", "deps"] as const;
const TARGET_COMMANDS = new Set<string>(["ast", "search", "explain", "deps"]);
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50_000;
const INIT_COMMAND_NAME = "idx-init";
const UPDATE_COMMAND_NAME = "idx-update";
const SYSTEM_CUSTOM_MESSAGE_TYPE = "pix-system";

const idxExecutionQueues = new Map<string, Promise<void>>();

type IdxCommand = (typeof IDX_COMMANDS)[number];

type RepoDiscoveryParams = {
	command: IdxCommand;
	target?: string;
	args?: string[];
	maxLines?: number;
	maxBytes?: number;
};

type RepoDiscoveryWrapperParams = Omit<RepoDiscoveryParams, "command">;

type ExecResult = {
	stdout: string;
	stderr: string;
	code?: number | null;
};

type ExtensionAPI = {
	registerTool(tool: Record<string, unknown>): void;
	registerCommand(name: string, command: { description: string; handler: (args: string, ctx: CommandContext) => Promise<void> }): void;
	sendMessage<T = unknown>(message: { customType: string; content: string; display: boolean; details?: T }): void;
	exec(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeout?: number }): Promise<ExecResult>;
};

type ToolContext = {
	cwd: string;
};

type CommandContext = {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
};

export type Truncation = {
	truncated: boolean;
	totalLines: number;
	outputLines: number;
	totalBytes: number;
	outputBytes: number;
};

function textResult(text: string, isError = false, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		isError,
		details,
	};
}

function sendSystemMessage(pi: ExtensionAPI, text: string, details?: Record<string, unknown>): void {
	pi.sendMessage({
		customType: SYSTEM_CUSTOM_MESSAGE_TYPE,
		content: text,
		display: true,
		...(details === undefined ? {} : { details }),
	});
}

function stringSchema(description: string) {
	return { type: "string", description };
}

function numberSchema(description: string, defaultValue: number) {
	return { type: "number", description, default: defaultValue };
}

function validateCommand(command: string): command is IdxCommand {
	return IDX_COMMANDS.includes(command as IdxCommand);
}

function positiveInteger(value: number | undefined, fallback: number): number {
	if (typeof value !== "number") return fallback;
	if (!Number.isInteger(value)) return fallback;
	return value > 0 ? value : fallback;
}

function ensureIndexedProject(cwd: string, toolName: string) {
	const projectRoot = findProjectRoot(cwd);
	const indexerDir = path.join(projectRoot, ".indexer-cli");
	if (directoryExists(indexerDir)) return { projectRoot, initialized: false };

	return {
		projectRoot,
		error: [
			`${toolName} is disabled because this project is not indexed: ${projectRoot}`,
			"Missing .indexer-cli in the project root.",
			"Ask the user for explicit permission to initialize and index this project with /idx-init, then run /reload.",
		].join("\n"),
	};
}

async function initializeIndexedProject(pi: ExtensionAPI, cwd: string, signal: AbortSignal | undefined) {
	const projectRoot = findProjectRoot(cwd);
	const indexerDir = path.join(projectRoot, ".indexer-cli");
	if (directoryExists(indexerDir)) return { projectRoot, initialized: false, alreadyIndexed: true, output: "Project is already indexed." };

	const init = await pi.exec("idx", ["init"], { cwd: projectRoot, signal, timeout: 600_000 });
	const output = [init.stdout, init.stderr].filter(Boolean).join(init.stdout && init.stderr ? "\n" : "").trim() || "No output";
	return { projectRoot, initialized: (init.code ?? 0) === 0, alreadyIndexed: false, output, exitCode: init.code ?? 0 };
}

async function updateIndexerCli(pi: ExtensionAPI, cwd: string, signal: AbortSignal | undefined) {
	const projectRoot = findProjectRoot(cwd);
	const update = await pi.exec("idx", ["update"], { cwd: projectRoot, signal, timeout: 600_000 });
	const output = [update.stdout, update.stderr].filter(Boolean).join(update.stdout && update.stderr ? "\n" : "").trim() || "No output";
	return { projectRoot, updated: (update.code ?? 0) === 0, output, exitCode: update.code ?? 0 };
}

async function runQueuedIdx<T>(projectRoot: string, task: () => Promise<T>): Promise<T> {
	const previous = idxExecutionQueues.get(projectRoot) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => { release = resolve; });
	const queued = previous.catch(() => undefined).then(() => current);
	idxExecutionQueues.set(projectRoot, queued);

	await previous.catch(() => undefined);
	try {
		return await task();
	} finally {
		release();
		if (idxExecutionQueues.get(projectRoot) === queued) idxExecutionQueues.delete(projectRoot);
	}
}

function truncateUtf8Prefix(text: string, maxBytes: number) {
	let output = "";
	let outputBytes = 0;

	for (const char of text) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (outputBytes + charBytes > maxBytes) break;
		output += char;
		outputBytes += charBytes;
	}

	return output;
}

export function truncateOutput(text: string, maxLines: number, maxBytes: number): { text: string; truncation: Truncation } {
	const totalBytes = Buffer.byteLength(text, "utf8");
	const lines = text.split("\n");
	const outputLines: string[] = [];
	let outputBytes = 0;

	for (const line of lines) {
		if (outputLines.length >= maxLines) break;

		const separatorBytes = outputLines.length > 0 ? 1 : 0;
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (outputBytes + separatorBytes + lineBytes > maxBytes) {
			if (outputLines.length === 0 && maxBytes > 0) outputLines.push(truncateUtf8Prefix(line, maxBytes));
			break;
		}

		outputLines.push(line);
		outputBytes += separatorBytes + lineBytes;
	}

	const output = outputLines.join("\n");
	const finalOutputLines = outputLines.length;
	const finalOutputBytes = Buffer.byteLength(output, "utf8");
	const truncated = finalOutputLines < lines.length || finalOutputBytes < totalBytes;

	return {
		text: truncated
			? `${output}\n\n[Output truncated from the bottom: showing the first ${finalOutputLines} of ${lines.length} lines (${finalOutputBytes} of ${totalBytes} bytes). Narrow the idx query or raise maxLines/maxBytes if needed.]`
			: output,
		truncation: {
			truncated,
			totalLines: lines.length,
			outputLines: finalOutputLines,
			totalBytes,
			outputBytes: finalOutputBytes,
		},
	};
}

function buildIdxArgs(params: RepoDiscoveryParams, toolName: string): string[] | string {
	const command = params.command?.trim();
	if (!validateCommand(command)) return `Invalid ${toolName} command. Use one of: ${IDX_COMMANDS.join(", ")}.`;

	const target = params.target?.trim();
	const requiresTarget = TARGET_COMMANDS.has(command);
	if (requiresTarget && !target) return `${toolName} command "${command}" requires target.`;
	if (!requiresTarget && target) return `${toolName} command "${command}" does not accept target; put flags in args.`;

	const args = params.args ?? [];
	if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string" && arg.length > 0)) {
		return `${toolName} args must be a non-empty string array when provided.`;
	}

	return target ? [command, target, ...args] : [command, ...args];
}

async function executeRepoDiscovery(
	pi: ExtensionAPI,
	params: RepoDiscoveryParams,
	signal: AbortSignal | undefined,
	ctx: ToolContext,
	toolName: string,
) {
	if (signal?.aborted) return textResult(`${toolName} cancelled`);

	const idxArgs = buildIdxArgs(params, toolName);
	if (typeof idxArgs === "string") return textResult(idxArgs, true);

	const indexedProject = ensureIndexedProject(ctx.cwd, toolName);
	if (indexedProject.error) return textResult(indexedProject.error, true, { projectRoot: indexedProject.projectRoot });

	const result = await runQueuedIdx(indexedProject.projectRoot, () => pi.exec("idx", idxArgs, { cwd: indexedProject.projectRoot, signal, timeout: 120_000 }));
	const exitCode = result.code ?? 0;
	const combined = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
	const output = combined.trim() ? combined : "No output";
	const maxLines = positiveInteger(params.maxLines, DEFAULT_MAX_LINES);
	const maxBytes = positiveInteger(params.maxBytes, DEFAULT_MAX_BYTES);
	const truncated = truncateOutput(output, maxLines, maxBytes);

	return textResult(truncated.text, exitCode !== 0, {
		command: ["idx", ...idxArgs],
		cwd: indexedProject.projectRoot,
		initializedProject: indexedProject.initialized,
		exitCode,
		truncation: truncated.truncation,
	});
}

const COMMON_REPO_TOOL_PROPERTIES = {
	maxLines: numberSchema("Maximum output lines to return before truncating from the bottom (keeps the first/top lines; default 2000).", DEFAULT_MAX_LINES),
	maxBytes: numberSchema("Maximum output bytes to return before truncating from the bottom (keeps the first/top lines; default 50000).", DEFAULT_MAX_BYTES),
};

const IDX_ARG_DESCRIPTIONS: Record<IdxCommand, string> = {
	architecture: "idx architecture flags: [--path-prefix <area>] [--include-fixtures].",
	structure:
		"idx structure flags: [--path-prefix <area>] [--kind <kind>] [--max-depth <n>] [--max-files <n>] [--cursor <n>] [--include-internal] [--include-fixtures] [--no-tests] [--include-tests-summary].",
	ast: "idx ast flags: [--max-depth <n>] [--max-nodes <n>] [--cursor <n>] [--no-include-text].",
	search:
		"idx search flags: [--max-files <n>] [--path-prefix <area>] [--chunk-types <types|api|impl|tests|imports>] [--mode hybrid|semantic|lexical|symbol] [--min-score <score>] [--include-content] [--include-imports] [--dedupe-file] [--dedupe-symbol] [--cluster] [--exclude-tests] [--include-tests].",
	explain:
		"idx explain flags: [--path-prefix <area>] [--include-fixtures] [--include-body] [--body-lines <n>] [--signature-only].",
	deps: "idx deps flags: [--mode modules|module-imports|calls|call-graph] [--direction callers|callees|both] [--depth <n>] [--show-edges] [--tests].",
};

function argsSchema(command: IdxCommand) {
	return {
		type: "array",
		items: stringSchema("idx argv token; pass flags and values as separate items"),
		description: IDX_ARG_DESCRIPTIONS[command],
	};
}

function repoToolParameters(command: IdxCommand, targetDescription?: string) {
	const properties = { args: argsSchema(command), ...COMMON_REPO_TOOL_PROPERTIES };

	return {
		type: "object",
		properties: targetDescription ? { target: stringSchema(targetDescription), ...properties } : properties,
		required: targetDescription ? ["target"] : [],
		additionalProperties: false,
	};
}

function registerRepoCommandTool(
	pi: ExtensionAPI,
	options: {
		name: string;
		label: string;
		command: IdxCommand;
		description: string;
		promptSnippet: string;
		promptGuidelines: string[];
		targetDescription?: string;
	},
) {
	pi.registerTool({
		name: options.name,
		label: options.label,
		description: options.description,
		promptSnippet: options.promptSnippet,
		promptGuidelines: options.promptGuidelines,
		parameters: repoToolParameters(options.command, options.targetDescription),

		async execute(_toolCallId: string, params: RepoDiscoveryWrapperParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) {
			return executeRepoDiscovery(pi, { ...params, command: options.command }, signal, ctx, options.name);
		},
	});
}

export default function repoDiscoveryExtension(pi: ExtensionAPI) {
	pi.registerCommand(INIT_COMMAND_NAME, {
		description: "Initialize idx repository discovery for this project, then reload Pi to expose repo_* tools",
		handler: async (_args: string, ctx: CommandContext) => {
			try {
				if (ctx.hasUI) ctx.ui.notify("Running idx init for this project...", "info");
				const result = await initializeIndexedProject(pi, ctx.cwd, undefined);
				if (result.alreadyIndexed) {
					sendSystemMessage(pi, `${result.output}\n${result.projectRoot}`, {
						command: INIT_COMMAND_NAME,
						cwd: result.projectRoot,
						alreadyIndexed: true,
					});
					if (ctx.hasUI) ctx.ui.notify("idx: project is already indexed", "info");
					return;
				}

				const output = truncateOutput(result.output, 30, 4_000).text;
				if (!result.initialized) {
					sendSystemMessage(pi, `idx init failed in ${result.projectRoot}:\n${output}`, {
						command: INIT_COMMAND_NAME,
						cwd: result.projectRoot,
						exitCode: result.exitCode,
					});
					if (ctx.hasUI) ctx.ui.notify(`idx init failed in ${result.projectRoot}`, "error");
					return;
				}

				sendSystemMessage(pi, [`idx init completed in ${result.projectRoot}.`, output, "Run /reload to load repo_* discovery tools into this session."].join("\n\n"), {
					command: INIT_COMMAND_NAME,
					cwd: result.projectRoot,
					exitCode: result.exitCode,
				});
				if (ctx.hasUI) ctx.ui.notify("idx init completed", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendSystemMessage(pi, `idx init failed:\n${message}`, { command: INIT_COMMAND_NAME, cwd: ctx.cwd });
				if (ctx.hasUI) ctx.ui.notify(message, "error");
			}
		},
	});

	pi.registerCommand(UPDATE_COMMAND_NAME, {
		description: "Update the global indexer-cli install with idx update",
		handler: async (_args: string, ctx: CommandContext) => {
			try {
				if (ctx.hasUI) ctx.ui.notify("Running idx update...", "info");
				const result = await updateIndexerCli(pi, ctx.cwd, undefined);
				const output = truncateOutput(result.output, 30, 4_000).text;
				if (!result.updated) {
					sendSystemMessage(pi, `idx update failed in ${result.projectRoot}:\n${output}`, {
						command: UPDATE_COMMAND_NAME,
						cwd: result.projectRoot,
						exitCode: result.exitCode,
					});
					if (ctx.hasUI) ctx.ui.notify(`idx update failed in ${result.projectRoot}`, "error");
					return;
				}

				sendSystemMessage(pi, [`idx update completed in ${result.projectRoot}.`, output].join("\n\n"), {
					command: UPDATE_COMMAND_NAME,
					cwd: result.projectRoot,
					exitCode: result.exitCode,
				});
				if (ctx.hasUI) ctx.ui.notify("idx update completed", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendSystemMessage(pi, `idx update failed:\n${message}`, { command: UPDATE_COMMAND_NAME, cwd: ctx.cwd });
				if (ctx.hasUI) ctx.ui.notify(message, "error");
			}
		},
	});

	if (!findIndexedProjectRoot(process.cwd())) return;

	for (const tool of REPO_DISCOVERY_TOOLS) registerRepoCommandTool(pi, tool);

}
