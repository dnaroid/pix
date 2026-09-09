import path from "node:path";
import { REPO_DISCOVERY_TOOLS, REPO_KNOWLEDGE_TOOL_DESCRIPTION } from "../tool-descriptions";
import { commandAvailable, directoryExists, findProjectRoot, hasAvailableIndexedProjectRoot } from "../lib/project.js";
import {
	applyNativeCompactPolicy,
	describeNativeCompactArgs,
	loadRepoDiscoveryProfile,
	truncateNativeCompactOutput,
	type NativePolicyOutcome,
	type RepoDiscoveryOutputMode,
	type RepoDiscoveryProfile,
} from "./native-compact.js";

const IDX_COMMANDS = ["architecture", "structure", "ast", "search", "explain", "deps"] as const;
const REPO_KNOWLEDGE_ACTIONS = [
	"context",
	"search",
	"show",
	"status",
	"audit",
	"discover",
	"impact",
	"catalog",
	"record",
	"verify",
	"relate",
	"remove",
] as const;
const REPO_KNOWLEDGE_MUTATING_ACTIONS = new Set<string>(["record", "verify", "relate", "remove"]);
const FILE_MUTATION_TOOL_NAMES = new Set(["write", "edit", "multiedit", "apply_patch", "ast_apply"]);
const KNOWLEDGE_MUTATION_NUDGE =
	"📚 repo_knowledge: behavior changed? Update the primary spec and run task-scoped action=impact; action=verify only after reviewing spec + code/tests. Skip for mechanical edits.";
const TARGET_COMMANDS = new Set<string>(["ast", "search", "explain", "deps"]);
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50_000;
const INIT_COMMAND_NAME = "idx-init";
const UPDATE_COMMAND_NAME = "idx-update";
const SYSTEM_CUSTOM_MESSAGE_TYPE = "pix-system";

const idxExecutionQueues = new Map<string, Promise<void>>();

type IdxCommand = (typeof IDX_COMMANDS)[number];
type RepoKnowledgeAction = (typeof REPO_KNOWLEDGE_ACTIONS)[number];
type KnowledgeClassification = "spec" | "spec-like" | "meta-index" | "design-only" | "guide" | "other";
type KnowledgeBehaviorType = "as-is" | "change" | "mixed" | "unknown";
type KnowledgeLifecycle = "active" | "proposed" | "historical" | "superseded" | "unknown";
type KnowledgeRelationKind = "implements" | "tests" | "related" | "supersedes" | "superseded-by";
type KnowledgeRelationAction = "add" | "remove";

type RepoDiscoveryParams = {
	command: IdxCommand;
	target?: string;
	args?: string[];
	maxLines?: number;
	maxBytes?: number;
	outputMode?: RepoDiscoveryOutputMode;
};

type RepoDiscoveryWrapperParams = Omit<RepoDiscoveryParams, "command">;

type RepoKnowledgeParams = {
	action: RepoKnowledgeAction;
	query?: string;
	path?: string;
	paths?: string[];
	classification?: KnowledgeClassification;
	behaviorType?: KnowledgeBehaviorType;
	lifecycle?: KnowledgeLifecycle;
	confidence?: "high" | "medium" | "low" | "unknown";
	summary?: string;
	topics?: string[];
	includeSecondary?: boolean;
	pathPrefix?: string;
	limit?: number;
	budget?: number;
	maxSpecs?: number;
	maxCode?: number;
	maxTests?: number;
	includeAll?: boolean;
	allUnclassified?: boolean;
	base?: string;
	semantic?: boolean;
	relationAction?: KnowledgeRelationAction;
	relationKind?: KnowledgeRelationKind;
	targetPaths?: string[];
	sourceReviewed?: boolean;
	evidenceReviewed?: boolean;
	metadataOnlyConfirmed?: boolean;
	maxLines?: number;
	maxBytes?: number;
	outputMode?: RepoDiscoveryOutputMode;
};

type ExecResult = {
	stdout: string;
	stderr: string;
	code?: number | null;
};

type ExtensionOn = {
	(event: "tool_result", handler: (event: RepoMutationResultEvent, ctx: ToolContext) => Promise<{ content: unknown[] } | undefined>): void;
	(event: "message_start", handler: (event: RepoMessageStartEvent, ctx: ToolContext) => Promise<void> | void): void;
};

type ExtensionAPI = {
	registerTool(tool: Record<string, unknown>): void;
	registerCommand(name: string, command: { description: string; handler: (args: string, ctx: CommandContext) => Promise<void> }): void;
	sendMessage<T = unknown>(message: { customType: string; content: string; display: boolean; details?: T }): void;
	exec(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeout?: number }): Promise<ExecResult>;
	on?: ExtensionOn;
};

type ToolContext = {
	cwd: string;
};

type RepoMutationResultEvent = {
	toolName: string;
	isError?: boolean;
	content: unknown[];
};

type RepoMessageStartEvent = {
	message?: {
		role?: string;
	};
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

function boundedIntegerSchema(description: string, defaultValue: number, maximum: number) {
	return { type: "integer", minimum: 1, maximum, description, default: defaultValue };
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
	if (!commandAvailable("idx")) {
		return {
			projectRoot,
			error: [
				`${toolName} is unavailable because idx is not on PATH.`,
				"Do not initialize, install, or create project-local index state implicitly.",
				"If the user wants indexed repository tools, ask for explicit permission to run /idx-init, then /reload.",
			].join("\n"),
		};
	}
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

	const idxCli = await ensureIdxCliAvailable(pi, projectRoot, signal);
	if (!idxCli.available) {
		return {
			projectRoot,
			initialized: false,
			alreadyIndexed: false,
			output: idxCli.output,
			exitCode: idxCli.exitCode,
			installedIdx: idxCli.installed,
		};
	}
	if (directoryExists(indexerDir)) {
		return {
			projectRoot,
			initialized: false,
			alreadyIndexed: true,
			output: idxCli.installed
				? `idx was installed and the project is already indexed: ${projectRoot}. Run /reload to expose repo_* tools.`
				: "Project is already indexed.",
			installedIdx: idxCli.installed,
		};
	}

	const init = await pi.exec("idx", ["init"], { cwd: projectRoot, signal, timeout: 600_000 });
	const initOutput = [init.stdout, init.stderr].filter(Boolean).join(init.stdout && init.stderr ? "\n" : "").trim() || "No output";
	const output = idxCli.installed
		? [`idx was not available; installed with npm install -g indexer-cli@latest:`, idxCli.output, `idx init output:`, initOutput].join("\n\n")
		: initOutput;
	return { projectRoot, initialized: (init.code ?? 0) === 0, alreadyIndexed: false, output, exitCode: init.code ?? 0, installedIdx: idxCli.installed };
}

async function ensureIdxCliAvailable(pi: ExtensionAPI, cwd: string, signal: AbortSignal | undefined) {
	const check = await runCommandSafely(pi, "sh", ["-lc", "command -v idx"], { cwd, signal, timeout: 30_000 });
	if ((check.code ?? 0) === 0) return { available: true, installed: false, output: "idx is available.", exitCode: 0 };

	const install = await runCommandSafely(pi, "npm", ["install", "-g", "indexer-cli@latest"], { cwd, signal, timeout: 600_000 });
	const installOutput = [install.stdout, install.stderr].filter(Boolean).join(install.stdout && install.stderr ? "\n" : "").trim() || "No output";
	const exitCode = install.code ?? 0;
	if (exitCode !== 0) {
		return {
			available: false,
			installed: false,
			output: [`idx is not available and npm install -g indexer-cli@latest failed:`, installOutput].join("\n\n"),
			exitCode,
		};
	}

	return { available: true, installed: true, output: installOutput, exitCode };
}

async function runCommandSafely(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	options: { cwd?: string; signal?: AbortSignal; timeout?: number },
): Promise<ExecResult> {
	try {
		return await pi.exec(command, args, options);
	} catch (error) {
		return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1 };
	}
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
	profile: RepoDiscoveryProfile,
) {
	if (signal?.aborted) return textResult(`${toolName} cancelled`);

	let policyOutcome: NativePolicyOutcome | undefined;
	let effectiveParams = params;
	if (profile === "native-compact") {
		const policy = applyNativeCompactPolicy({
			command: params.command,
			args: params.args,
			maxLines: params.maxLines,
			maxBytes: params.maxBytes,
			outputMode: params.outputMode,
		});
		policyOutcome = policy.outcome;
		if (policy.ok === false) return textResult(`Native Compact refused ${toolName}: ${policy.message}`, true, { nativePolicy: policy.outcome });
		effectiveParams = { ...params, args: policy.args, maxLines: policy.maxLines, maxBytes: policy.maxBytes };
	}

	const idxArgs = buildIdxArgs(effectiveParams, toolName);
	if (typeof idxArgs === "string") return textResult(idxArgs, true);

	const indexedProject = ensureIndexedProject(ctx.cwd, toolName);
	if (indexedProject.error) return textResult(indexedProject.error, true, { projectRoot: indexedProject.projectRoot });

	const result = await runQueuedIdx(indexedProject.projectRoot, () => pi.exec("idx", idxArgs, { cwd: indexedProject.projectRoot, signal, timeout: 120_000 }));
	const exitCode = result.code ?? 0;
	const combined = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
	const output = combined.trim() ? combined : "No output";
	const maxLines = positiveInteger(effectiveParams.maxLines, DEFAULT_MAX_LINES);
	const maxBytes = positiveInteger(effectiveParams.maxBytes, DEFAULT_MAX_BYTES);
	const truncated = profile === "native-compact"
		? truncateNativeCompactOutput(output, maxLines, maxBytes, effectiveParams.outputMode ?? "compact")
		: truncateOutput(output, maxLines, maxBytes);

	return textResult(truncated.text, exitCode !== 0, {
		command: ["idx", ...idxArgs],
		cwd: indexedProject.projectRoot,
		initializedProject: indexedProject.initialized,
		exitCode,
		truncation: truncated.truncation,
		...(policyOutcome ? { nativePolicy: policyOutcome } : {}),
	});
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function normalizedStrings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((item): item is string => nonEmpty(item)).map((item) => item.trim()))];
}

function positiveBounded(value: number | undefined, fallback: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return fallback;
	return Math.min(value, maximum);
}

function buildRepoKnowledgeArgs(params: RepoKnowledgeParams): string[] | string {
	if (!REPO_KNOWLEDGE_ACTIONS.includes(params.action)) {
		return `Invalid repo_knowledge action. Use one of: ${REPO_KNOWLEDGE_ACTIONS.join(", ")}.`;
	}

	const query = params.query?.trim();
	const sourcePath = params.path?.trim();
	const paths = normalizedStrings(params.paths);
	const topics = normalizedStrings(params.topics);
	const targets = normalizedStrings(params.targetPaths);

	switch (params.action) {
		case "context": {
			if (!query) return "repo_knowledge action=context requires query.";
			const args = [
				"context",
				query,
				"--budget",
				String(positiveBounded(params.budget, 1400, 8000)),
				"--max-specs",
				String(positiveBounded(params.maxSpecs, 4, 20)),
				"--max-code",
				String(positiveBounded(params.maxCode, 6, 30)),
				"--max-tests",
				String(positiveBounded(params.maxTests, 4, 20)),
			];
			if (params.includeSecondary) args.push("--include-secondary");
			if (nonEmpty(params.pathPrefix)) args.push("--path-prefix", params.pathPrefix.trim());
			return args;
		}
		case "search": {
			if (!query) return "repo_knowledge action=search requires query.";
			const args = ["wiki", "search", query, "--limit", String(positiveBounded(params.limit, 5, 20))];
			if (params.includeSecondary) args.push("--include-secondary");
			if (nonEmpty(params.pathPrefix)) args.push("--path-prefix", params.pathPrefix.trim());
			return args;
		}
		case "show":
			return sourcePath ? ["wiki", "show", "--path", sourcePath] : "repo_knowledge action=show requires path.";
		case "status":
		case "audit":
			return ["wiki", params.action, "--candidate-limit", String(positiveBounded(params.limit, 20, 100))];
		case "discover": {
			if (params.includeAll && params.allUnclassified) return "repo_knowledge discover cannot combine includeAll and allUnclassified.";
			const args = ["wiki", "discover", "--limit", String(positiveBounded(params.limit, 40, 200))];
			if (params.includeAll) args.push("--all");
			if (params.allUnclassified) args.push("--all-unclassified");
			return args;
		}
		case "impact": {
			const args = ["wiki", "impact", ...paths];
			if (nonEmpty(params.base)) args.push("--base", params.base.trim());
			args.push("--semantic-limit", String(positiveBounded(params.limit, 5, 20)));
			if (params.semantic === false) args.push("--no-semantic");
			return args;
		}
		case "catalog":
			return ["wiki", "catalog"];
		case "record": {
			if (!sourcePath) return "repo_knowledge action=record requires path.";
			if (!params.classification) return "repo_knowledge action=record requires classification.";
			if (params.sourceReviewed !== true) return "repo_knowledge record refused: read/classify the source first, then retry with sourceReviewed=true.";
			if (["spec", "spec-like"].includes(params.classification) && (!params.behaviorType || !params.lifecycle)) {
				return "repo_knowledge record for primary knowledge requires behaviorType and lifecycle.";
			}
			const args = ["wiki", "record", "--path", sourcePath, "--classification", params.classification];
			if (params.behaviorType) args.push("--type", params.behaviorType);
			if (params.lifecycle) args.push("--lifecycle", params.lifecycle);
			if (params.confidence) args.push("--confidence", params.confidence);
			if (nonEmpty(params.summary)) args.push("--summary", params.summary.trim());
			for (const topic of topics) args.push("--topic", topic);
			return args;
		}
		case "verify":
			if (!sourcePath) return "repo_knowledge action=verify requires path.";
			if (params.evidenceReviewed !== true) return "repo_knowledge verify refused: inspect the primary source and relevant code/tests first, then retry with evidenceReviewed=true.";
			return ["wiki", "verify", "--path", sourcePath];
		case "relate": {
			if (!sourcePath) return "repo_knowledge action=relate requires path.";
			if (params.evidenceReviewed !== true) return "repo_knowledge relate refused: review concrete evidence first; semantic/graph similarity alone is insufficient. Retry with evidenceReviewed=true.";
			if (!params.relationAction || !params.relationKind || targets.length === 0) {
				return "repo_knowledge relate requires relationAction, relationKind, and targetPaths.";
			}
			const flags: Record<KnowledgeRelationKind, Record<KnowledgeRelationAction, string>> = {
				implements: { add: "--add-code", remove: "--remove-code" },
				tests: { add: "--add-test", remove: "--remove-test" },
				related: { add: "--add-related-spec", remove: "--remove-related-spec" },
				supersedes: { add: "--add-supersedes", remove: "--remove-supersedes" },
				"superseded-by": { add: "--add-superseded-by", remove: "--remove-superseded-by" },
			};
			const args = ["wiki", "relate", "--path", sourcePath];
			const flag = flags[params.relationKind][params.relationAction];
			for (const target of targets) args.push(flag, target);
			return args;
		}
		case "remove":
			if (!sourcePath) return "repo_knowledge action=remove requires path.";
			if (params.metadataOnlyConfirmed !== true) return "repo_knowledge remove refused: confirm that only knowledge metadata should be removed and the source document must remain, then retry with metadataOnlyConfirmed=true.";
			return ["wiki", "remove", "--path", sourcePath];
	}
}

async function executeRepoKnowledge(
	pi: ExtensionAPI,
	params: RepoKnowledgeParams,
	signal: AbortSignal | undefined,
	ctx: ToolContext,
	profile: RepoDiscoveryProfile,
) {
	if (signal?.aborted) return textResult("repo_knowledge cancelled");
	const idxArgs = buildRepoKnowledgeArgs(params);
	if (typeof idxArgs === "string") return textResult(idxArgs, true, { action: params.action });

	const indexedProject = ensureIndexedProject(ctx.cwd, "repo_knowledge");
	if (indexedProject.error) return textResult(indexedProject.error, true, { projectRoot: indexedProject.projectRoot, action: params.action });

	const result = await runQueuedIdx(indexedProject.projectRoot, () =>
		pi.exec("idx", idxArgs, { cwd: indexedProject.projectRoot, signal, timeout: 180_000 }),
	);
	const exitCode = result.code ?? 0;
	const combined = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
	const output = combined.trim() ? combined : "No output";
	const native = profile === "native-compact";
	const maxLines = positiveInteger(params.maxLines, native ? 400 : 600);
	const maxBytes = positiveInteger(params.maxBytes, native ? 12_000 : 20_000);
	const truncated = native
		? truncateNativeCompactOutput(output, Math.min(maxLines, params.outputMode === "full" ? 2_000 : 400), Math.min(maxBytes, params.outputMode === "full" ? 50_000 : 12_000), params.outputMode ?? "compact")
		: truncateOutput(output, Math.min(maxLines, 2_000), Math.min(maxBytes, 50_000));

	return textResult(truncated.text, exitCode !== 0, {
		action: params.action,
		mutating: REPO_KNOWLEDGE_MUTATING_ACTIONS.has(params.action),
		command: ["idx", ...idxArgs],
		cwd: indexedProject.projectRoot,
		exitCode,
		truncation: truncated.truncation,
	});
}

const BASELINE_REPO_TOOL_PROPERTIES = {
	maxLines: numberSchema("Returned line cap, keeps top lines (default 2000). Prefer native limits/cursors before raising.", DEFAULT_MAX_LINES),
	maxBytes: numberSchema("Returned byte cap, keeps top bytes (default 50000). Narrow the query before raising.", DEFAULT_MAX_BYTES),
};

const NATIVE_COMPACT_REPO_TOOL_PROPERTIES = {
	maxLines: boundedIntegerSchema("Final delivered line cap. compact default/max 400; outputMode=full permits up to 2000.", 400, 2_000),
	maxBytes: boundedIntegerSchema("Final delivered byte cap. compact default/max 12000; outputMode=full permits up to 50000.", 12_000, 50_000),
};

const IDX_ARG_DESCRIPTIONS: Record<IdxCommand, string> = {
	architecture: "idx architecture flags: [--path-prefix <area>].",
	structure:
		"idx structure flags: [--path-prefix <area>] [--kind <kind>] [--max-depth <n>] [--max-files <n>] [--cursor <n>] [--include-internal] [--no-tests] [--include-tests-summary].",
	ast: "idx ast flags: [--max-depth <n>] [--max-nodes <n>] [--cursor <n>] [--no-include-text].",
	search:
		"idx search: default 3 results without code; --include-content only for narrow follow-up. Flags: [--max-files <n>] [--path-prefix <area>] [--chunk-types <types|api|impl|tests|imports>] [--mode hybrid|semantic|lexical|symbol] [--min-score <score>] [--include-content] [--include-imports] [--dedupe-file] [--dedupe-symbol] [--cluster] [--exclude-tests] [--include-tests].",
	explain:
		"idx explain flags: [--path-prefix <area>] [--include-body] [--body-lines <n>] [--signature-only].",
	deps: "idx deps flags: [--mode modules|module-imports|calls|call-graph] [--direction callers|callees|both] [--depth <n>] [--show-edges] [--tests].",
};

function argsSchema(command: IdxCommand, profile: RepoDiscoveryProfile) {
	const baseDescription = IDX_ARG_DESCRIPTIONS[command];
	return {
		type: "array",
		items: profile === "native-compact"
			? { type: "string", minLength: 1, description: "idx argv token; --flag=value is normalized and revalidated by Native Compact" }
			: stringSchema("idx argv token; pass flags and values as separate items"),
		description: profile === "native-compact"
			? `${baseDescription} ${describeNativeCompactArgs(command)}`
			: baseDescription,
	};
}

function repoToolParameters(command: IdxCommand, targetDescription: string | undefined, profile: RepoDiscoveryProfile) {
	const outputProperties = profile === "native-compact"
		? NATIVE_COMPACT_REPO_TOOL_PROPERTIES
		: BASELINE_REPO_TOOL_PROPERTIES;
	const properties = {
		args: argsSchema(command, profile),
		...outputProperties,
		...(profile === "native-compact" ? {
			outputMode: {
				type: "string",
				enum: ["compact", "full"],
				default: "compact",
				description: "Native Compact delivery: compact by default. Use full only on this same tool call when broader output is intentional or its compact result was actually truncated; do not switch an unrelated repo tool to full after a policy refusal.",
			},
		} : {}),
	};

	return {
		type: "object",
		properties: targetDescription ? { target: stringSchema(targetDescription), ...properties } : properties,
		required: targetDescription ? ["target"] : [],
		additionalProperties: false,
	};
}

function repoKnowledgeParameters(profile: RepoDiscoveryProfile) {
	const outputProperties = profile === "native-compact"
		? NATIVE_COMPACT_REPO_TOOL_PROPERTIES
		: {
			maxLines: numberSchema("Returned line cap for knowledge output (default 600; max delivery 2000). Narrow the action/query first.", 600),
			maxBytes: numberSchema("Returned byte cap for knowledge output (default 20000; max delivery 50000). Narrow before raising.", 20_000),
		};
	return {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: [...REPO_KNOWLEDGE_ACTIONS],
				description: "Knowledge action. record/verify/relate/remove mutate idx knowledge metadata; source spec files are edited with normal file tools.",
			},
			query: stringSchema("Behavior/contract query for context or search."),
			path: stringSchema("Project-relative primary knowledge path for show/record/verify/relate/remove."),
			paths: { type: "array", items: stringSchema("Project-relative task-changed path"), description: "Task-scoped changed paths for impact. Prefer this over whole-worktree fallback." },
			classification: { type: "string", enum: ["spec", "spec-like", "meta-index", "design-only", "guide", "other"] },
			behaviorType: { type: "string", enum: ["as-is", "change", "mixed", "unknown"] },
			lifecycle: { type: "string", enum: ["active", "proposed", "historical", "superseded", "unknown"] },
			confidence: { type: "string", enum: ["high", "medium", "low", "unknown"] },
			summary: stringSchema("Compact retrieval summary based on the reviewed primary source; never invent behavior."),
			topics: { type: "array", items: stringSchema("Retrieval topic") },
			includeSecondary: { type: "boolean", description: "Include design-only secondary knowledge for context/search." },
			pathPrefix: stringSchema("Optional project-relative scope for context/search."),
			limit: boundedIntegerSchema("Result/candidate/semantic limit depending on action.", 5, 200),
			budget: boundedIntegerSchema("Context token budget; context only.", 1400, 8000),
			maxSpecs: boundedIntegerSchema("Maximum primary specs in context.", 4, 20),
			maxCode: boundedIntegerSchema("Maximum implementation ranges/files in context.", 6, 30),
			maxTests: boundedIntegerSchema("Maximum test hints in context.", 4, 20),
			includeAll: { type: "boolean", description: "discover: include unchanged already-classified documents." },
			allUnclassified: { type: "boolean", description: "discover: include all unclassified document-like files regardless heuristic score." },
			base: stringSchema("Git base for impact when task-scoped paths are omitted; default HEAD."),
			semantic: { type: "boolean", description: "impact semantic candidate retrieval; default true." },
			relationAction: { type: "string", enum: ["add", "remove"] },
			relationKind: { type: "string", enum: ["implements", "tests", "related", "supersedes", "superseded-by"] },
			targetPaths: { type: "array", items: stringSchema("Reviewed relation target path") },
			sourceReviewed: { type: "boolean", description: "Required true for record only after reading/classifying the source document." },
			evidenceReviewed: { type: "boolean", description: "Required true for verify/relate only after reviewing concrete primary source + relevant code/tests/evidence." },
			metadataOnlyConfirmed: { type: "boolean", description: "Required true for remove; confirms only idx metadata is removed and the source file stays untouched." },
			...outputProperties,
			...(profile === "native-compact" ? {
				outputMode: {
					type: "string",
					enum: ["compact", "full"],
					default: "compact",
					description: "Knowledge output delivery mode. Keep compact unless this same result is actually truncated and broader output is necessary.",
				},
			} : {}),
		},
		required: ["action"],
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
	profile: RepoDiscoveryProfile,
) {
	pi.registerTool({
		name: options.name,
		label: options.label,
		description: options.description,
		promptSnippet: options.promptSnippet,
		promptGuidelines: options.promptGuidelines,
		parameters: repoToolParameters(options.command, options.targetDescription, profile),

		async execute(_toolCallId: string, params: RepoDiscoveryWrapperParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) {
			return executeRepoDiscovery(pi, { ...params, command: options.command }, signal, ctx, options.name, profile);
		},
	});
}

function registerRepoKnowledgeTool(pi: ExtensionAPI, profile: RepoDiscoveryProfile) {
	pi.registerTool({
		...REPO_KNOWLEDGE_TOOL_DESCRIPTION,
		parameters: repoKnowledgeParameters(profile),
		async execute(
			_toolCallId: string,
			params: RepoKnowledgeParams,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ToolContext,
		) {
			return executeRepoKnowledge(pi, params, signal, ctx, profile);
		},
	});
}

function mutationToolName(toolName: string): string {
	const base = toolName.includes(".") ? toolName.split(".").pop() ?? toolName : toolName;
	return base.toLowerCase();
}

function registerKnowledgeMutationNudge(pi: ExtensionAPI): void {
	if (!pi.on) return;
	let nudgedThisUserTurn = false;
	pi.on("message_start", async (event) => {
		if (event.message?.role === "user") nudgedThisUserTurn = false;
	});
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return undefined;
		if (!FILE_MUTATION_TOOL_NAMES.has(mutationToolName(event.toolName))) return undefined;
		if (!hasAvailableIndexedProjectRoot(ctx.cwd)) return undefined;
		if (nudgedThisUserTurn) return undefined;
		nudgedThisUserTurn = true;
		return {
			content: [
				...event.content,
				{ type: "text" as const, text: `\n---\n${KNOWLEDGE_MUTATION_NUDGE}\n---` },
			],
		};
	});
}

export type RepoDiscoveryExtensionOptions = {
	profile?: RepoDiscoveryProfile;
	cwd?: string;
};

export default function repoDiscoveryExtension(pi: ExtensionAPI, options: RepoDiscoveryExtensionOptions = {}) {
	const registrationCwd = options.cwd ?? process.cwd();
	const profileConfig = options.profile ? { profile: options.profile, issues: [] } : loadRepoDiscoveryProfile(registrationCwd);
	const profile = profileConfig.profile;
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

	if (!hasAvailableIndexedProjectRoot(registrationCwd)) return;

	registerKnowledgeMutationNudge(pi);
	for (const tool of REPO_DISCOVERY_TOOLS) registerRepoCommandTool(pi, tool, profile);
	registerRepoKnowledgeTool(pi, profile);

}
