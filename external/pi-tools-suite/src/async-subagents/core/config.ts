import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { ensurePiToolsSuiteUserConfig, getPiToolsSuiteUserConfigPath } from "../../config.js";
import type { AgentTask, RetryConfig } from "./types.js";

export interface SubagentTypeConfig {
	description?: string;
	model?: string;
	/** Ordered model fallbacks used when the selected model hits quota/rate limits. */
	fallbackModels?: string[];
	thinking?: string;
	tools?: string[];
	extraArgs?: string[];
	/** Extra prompt text appended after the generated or overridden prompt. */
	promptAppend?: string;
	/** Full prompt replacement. Supports prompt template variables. */
	promptOverride?: string;
	/** Retry configuration for agents of this type (overrides global retry). */
	retry?: Partial<RetryConfig>;
	/** Maximum bytes kept in result.json resultText; result.md remains the full raw output. */
	maxResultBytes?: number;
	/** Per-agent wall-clock timeout in milliseconds. */
	timeoutMs?: number;
}

export interface SubagentRoutingConfig {
	/** Ask a lightweight model to choose subagentType when a task omits it. */
	enabled?: boolean;
	/** Router model in provider/model form. Falls back to the current parent model if unavailable. */
	model?: string;
	/** Maximum task/scope characters sent to the router per task. */
	maxTaskChars?: number;
	/** Maximum router response tokens. */
	maxTokens?: number;
	/** Router complete() retries. */
	maxRetries?: number;
	/** Router sampling temperature. */
	temperature?: number;
	/** Router request timeout. */
	timeoutMs?: number;
	/** Show best-effort UI warnings when routing falls back. */
	debug?: boolean;
}

export type ResolvedSubagentRoutingConfig = Required<SubagentRoutingConfig>;

export interface SubagentVisionConfig {
	/** Glob-like model refs that should be treated as unable to inspect images, regardless of provider metadata. */
	blindModelPatterns?: string[];
}

export interface SubagentPreset {
	description?: string;
	model?: string;
	/** Ordered global model fallbacks used when this preset's selected model hits quota/rate limits. */
	fallbackModels?: string[];
	thinking?: string;
	extraArgs?: string[];
	/** Per-agent wall-clock timeout in milliseconds. */
	timeoutMs?: number;
	/** Optional per-subagentType overrides applied by this preset. */
	types?: Record<string, SubagentPresetTypeOverride>;
}

export interface SubagentPresetTypeOverride {
	model?: string;
	/** Ordered per-role fallbacks used before preset-level fallbackModels. */
	fallbackModels?: string[];
	thinking?: string;
	extraArgs?: string[];
	/** Per-agent wall-clock timeout in milliseconds. */
	timeoutMs?: number;
}

export interface SubagentConfig {
	defaultType?: string;
	types: Record<string, SubagentTypeConfig>;
	/** LLM-based role routing for tasks that omit subagentType. */
	routing?: SubagentRoutingConfig;
	/** Vision capability overrides for parent-model guidance. */
	vision?: SubagentVisionConfig;
	/** Named global spawn defaults selected with /subagent-preset. */
	presets?: Record<string, SubagentPreset>;
	/** Maximum concurrent agents per spawn batch (default 5, 0 = unlimited). */
	maxConcurrent?: number;
	/** Global retry defaults for all agent types. Per-type retry overrides these. */
	retry?: Partial<RetryConfig>;
	/** Maximum bytes kept in result.json resultText globally; per-type maxResultBytes overrides. */
	maxResultBytes?: number;
	/** Global per-agent wall-clock timeout in milliseconds. Defaults to the built-in 30 minutes. */
	timeoutMs?: number;
}

export interface CopySubagentConfigSampleResult {
	copied: boolean;
	targetPath: string;
	samplePath: string;
	existingFiles: string[];
}

export interface ResolvedAgentTaskConfig {
	task: AgentTask;
	extraArgs: string[];
	/** Ordered model fallbacks for the resolved model. Current-process exhausted models are skipped before spawning. */
	fallbackModels: string[];
	profile?: SubagentTypeConfig;
	/** Resolved retry config (merged from global + per-type). */
	retry: RetryConfig;
	/** Resolved max result bytes (per-type overrides global). */
	maxResultBytes?: number;
	/** Resolved per-agent wall-clock timeout in milliseconds. */
	timeoutMs?: number;
}

export interface ResolveAgentTaskOptions {
	/** Default model for spawned sub-agents when task/profile do not specify one. */
	model?: string;
	/** Default thinking level for spawned sub-agents when task/profile do not specify one. */
	defaultThinking?: string;
	/** Selected config preset. Supports global defaults plus per-subagentType overrides. */
	preset?: SubagentPreset;
	/** Forced thinking level, e.g. from the spawn action's global `thinking` parameter. */
	thinking?: string;
	extraArgs?: string[];
	/** Force every sub-agent to use this model, ignoring task/profile/env model selection. */
	forcedModel?: string;
	/** Force a wall-clock timeout for every sub-agent spawned by this call. */
	timeoutMs?: number;
}

const TRUE_ENV_PATTERN = /^(1|true|yes|on)$/i;
const FALSE_ENV_PATTERN = /^(0|false|no|off)$/i;

/** Default retry configuration: no retries, 2s base backoff. */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxRetries: 0,
	backoffMs: 2000,
};

/** Default maximum concurrent agents per spawn batch. */
export const DEFAULT_MAX_CONCURRENT = 5;

/** Default lightweight LLM router used when subagentType is omitted. */
export const DEFAULT_ROUTING_CONFIG: ResolvedSubagentRoutingConfig = {
	enabled: true,
	model: "zai/glm-4.5-air",
	maxTaskChars: 1200,
	maxTokens: 512,
	maxRetries: 1,
	temperature: 0,
	timeoutMs: 12_000,
	debug: false,
};

const BUILTIN_CONFIG: SubagentConfig = {
	maxConcurrent: DEFAULT_MAX_CONCURRENT,
	routing: { ...DEFAULT_ROUTING_CONFIG },
	vision: {
		blindModelPatterns: ["zai/glm*", "glm*", "*/glm*"],
	},
	types: {
		quick: {
			description: "Use for tiny cheap tasks: answer a simple question, inspect one known file, or verify one fact. Not for broad repo search.",
			thinking: "off",
		},
		scan: {
			description: "Use for finding files, symbols, text, or inventory across a repo. Return paths/facts; do not judge code quality.",
			thinking: "off",
		},
		research: {
			description: "Use for multi-file codebase research: read several files and explain how something works. No edits.",
			thinking: "low",
		},
		docs: {
			description: "Use for documentation work: README/API docs review, docs gaps, changelog, migration notes, examples.",
			thinking: "low",
		},
		frontend: {
			description: "Use for frontend UI/UX visual work: styling, layout, typography, animation, responsive states, component polish, and accessibility. Avoid backend/business logic unless needed for UI behavior.",
			thinking: "medium",
			promptAppend: [
				"Act as a frontend UI/UX engineer for visual and product-facing work.",
				"Prioritize layout, typography, spacing, color, motion, responsive states, accessibility, and consistency with the existing design system.",
				"Before editing, inspect nearby components/styles and infer the project's design language. Avoid backend/business-logic changes unless required for UI behavior.",
				"When no mockup exists, choose a clear aesthetic direction and explain it briefly. Verify with targeted build/lint/tests or screenshot-relevant checks when possible.",
			].join("\n"),
		},
		implement: {
			description: "Use when the sub-agent should make or plan code changes for a feature, bug fix, or refactor.",
			thinking: "high",
		},
		tests: {
			description: "Use for tests: locate coverage, find gaps, run/check targeted test commands, diagnose failing tests.",
			thinking: "medium",
		},
		review: {
			description: "Use for review/audit of existing code or changes: correctness, security, performance, maintainability, API risks, quality. Do not implement new code.",
			thinking: "high",
		},
		deep: {
			description: "Use for broad hard reasoning: architecture, root-cause analysis, cross-module impact, complex debugging or tradeoffs.",
			thinking: "high",
		},
		vision: {
			description: "Use only when task has imagePaths, screenshots, or asks to inspect visible UI/image content for a text-only parent.",
			model: "openai-codex/gpt-5.4-mini",
			thinking: "off",
			promptAppend: [
				"You are a vision helper for a parent model that may not be able to see images.",
				"Inspect any attached images and any image paths mentioned in the task/scope. Describe concrete visible details, UI state, text, layout, errors, and uncertainties.",
				"If focus instructions are provided, prioritize them, but still mention other important visible findings.",
				"Do not make code changes. Return a compact visual description that the parent agent can rely on.",
			].join("\n"),
		},
	},
};

export function loadSubagentConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): SubagentConfig {
	const config = cloneConfig(BUILTIN_CONFIG);
	if (!explicitSubagentConfigPath(cwd, env)) {
		for (const file of piToolsSuiteConfigFiles(cwd, env)) {
			mergeConfig(config, readPiToolsSuiteSubagentConfig(file));
		}
	}
	for (const file of configFiles(cwd, env)) {
		mergeConfig(config, readConfigFile(file));
	}
	applyEnvModelOverrides(config, env);
	applyEnvRoutingOverrides(config, env);
	return config;
}

export function configFiles(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const explicit = explicitSubagentConfigPath(cwd, env);
	if (explicit) {
		if (!fs.existsSync(explicit)) throw new Error(`Subagent config not found: ${explicit}`);
		return [explicit];
	}

	return existingSubagentConfigFiles(cwd, env);
}

function explicitSubagentConfigPath(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	const explicit = trimString(env.ASYNC_SUBAGENTS_CONFIG || env.PI_SUBAGENTS_CONFIG);
	return explicit ? path.resolve(cwd, expandHome(explicit)) : undefined;
}

export function getDefaultSubagentConfigPath(): string {
	return getPiToolsSuiteUserConfigPath();
}

export function getSubagentConfigSamplePath(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "async-subagents.sample.jsonc");
}

export function getSubagentConfigInitTargetPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	return explicitSubagentConfigPath(cwd, env) ?? getDefaultSubagentConfigPath();
}

export function existingSubagentConfigFiles(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const explicit = explicitSubagentConfigPath(cwd, env);
	if (explicit) return fs.existsSync(explicit) ? [explicit] : [];
	return piToolsSuiteConfigFiles(cwd, env).filter(hasPiToolsSuiteSubagentConfig);
}

function piToolsSuiteConfigFiles(cwd: string, env: NodeJS.ProcessEnv): string[] {
	return [
		getPiToolsSuiteUserConfigPath(),
		env.PI_CONFIG_DIR ? path.join(env.PI_CONFIG_DIR, "pi-tools-suite.jsonc") : undefined,
		findProjectPiToolsSuiteConfig(cwd),
	].filter((file): file is string => typeof file === "string" && fs.existsSync(file));
}

function findProjectPiToolsSuiteConfig(startDir: string): string | undefined {
	let dir = path.resolve(startDir);
	const root = path.parse(dir).root;
	while (true) {
		const candidate = path.join(dir, ".pi", "pi-tools-suite.jsonc");
		if (fs.existsSync(candidate)) return candidate;
		if (dir === root) return undefined;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function copySubagentConfigSample(cwd: string, env: NodeJS.ProcessEnv = process.env): CopySubagentConfigSampleResult {
	const samplePath = getSubagentConfigSamplePath();
	const existingFiles = existingSubagentConfigFiles(cwd, env);
	if (existingFiles.length > 0) return { copied: false, targetPath: existingFiles[0], samplePath, existingFiles };

	const explicit = explicitSubagentConfigPath(cwd, env);
	const targetPath = getSubagentConfigInitTargetPath(cwd, env);
	if (explicit) {
		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		try {
			fs.copyFileSync(samplePath, targetPath, fs.constants.COPYFILE_EXCL);
		} catch (error) {
			if (isNodeError(error) && error.code === "EEXIST") {
				return { copied: false, targetPath, samplePath, existingFiles: [targetPath] };
			}
			throw error;
		}
	} else {
		writePiToolsSuiteSubagentConfig(targetPath, readConfigFile(samplePath));
	}
	return { copied: true, targetPath, samplePath, existingFiles: [] };
}

export function resolveAgentTaskConfig(
	task: AgentTask,
	config: SubagentConfig,
	globalOptions: ResolveAgentTaskOptions = {},
): ResolvedAgentTaskConfig {
	const selectedType = selectSubagentType(task, config);
	const profile = selectedType ? config.types[selectedType] : undefined;
	const preset = globalOptions.preset;
	const presetType = selectedType ? preset?.types?.[selectedType] : undefined;
	const explicitType = trimString(task.subagentType);
	const taskExtraArgs = arrayOfStrings(task.extraArgs) ?? [];
	const profileExtraArgs = arrayOfStrings(profile?.extraArgs) ?? [];
	const presetTypeExtraArgs = arrayOfStrings(presetType?.extraArgs) ?? [];
	const presetExtraArgs = arrayOfStrings(preset?.extraArgs) ?? [];
	const globalExtraArgs = arrayOfStrings(globalOptions.extraArgs) ?? [];
	const promptAppend = joinTextBlocks(profile?.promptAppend, task.promptAppend);
	const forcedModel = trimString(globalOptions.forcedModel);
	const taskModel = trimString(task.model);
	const presetTypeModel = trimString(presetType?.model);
	const globalModel = trimString(globalOptions.model);
	const presetModel = trimString(preset?.model);
	const profileModel = trimString(profile?.model);
	const model = forcedModel || taskModel || presetTypeModel || globalModel || presetModel || profileModel;
	const fallbackModels = forcedModel || taskModel
		? []
		: resolveFallbackModels({ model, presetType, preset, profile });
	const extraArgs = forcedModel
		? stripModelArgs([...profileExtraArgs, ...presetTypeExtraArgs, ...taskExtraArgs, ...presetExtraArgs, ...globalExtraArgs])
		: [...profileExtraArgs, ...presetTypeExtraArgs, ...taskExtraArgs, ...presetExtraArgs, ...globalExtraArgs];
	const timeoutMs = task.timeoutMs ?? globalOptions.timeoutMs ?? presetType?.timeoutMs ?? preset?.timeoutMs ?? profile?.timeoutMs ?? config.timeoutMs;

	return {
		profile,
		extraArgs,
		fallbackModels,
		retry: resolveRetryConfig(config.retry, profile?.retry),
		maxResultBytes: profile?.maxResultBytes ?? config.maxResultBytes,
		timeoutMs,
		task: {
			...task,
			subagentType: explicitType || selectedType,
			model,
			thinking: trimString(globalOptions.thinking) || trimString(task.thinking) || trimString(presetType?.thinking) || trimString(globalOptions.defaultThinking) || trimString(preset?.thinking) || trimString(profile?.thinking),
			promptAppend,
			promptOverride: trimString(task.promptOverride) || trimString(profile?.promptOverride),
			tools: task.tools && task.tools.length > 0 ? task.tools : arrayOfStrings(profile?.tools),
			extraArgs: taskExtraArgs.length > 0 ? taskExtraArgs : undefined,
		},
	};
}

export function resolveSubagentRoutingConfig(config: SubagentConfig): ResolvedSubagentRoutingConfig {
	return { ...DEFAULT_ROUTING_CONFIG, ...(config.routing ?? {}) };
}

export function defaultSubagentType(config: SubagentConfig): string | undefined {
	return trimString(config.defaultType) || Object.keys(config.types).find((name) => trimString(name));
}

/** Merge global and per-type retry partials into a fully resolved RetryConfig. Per-type wins. */
export function resolveRetryConfig(
	globalRetry?: Partial<RetryConfig>,
	typeRetry?: Partial<RetryConfig>,
): RetryConfig {
	return {
		...DEFAULT_RETRY_CONFIG,
		...stripUndefined(globalRetry),
		...stripUndefined(typeRetry),
	};
}

export function shouldForceCurrentSubagentModel(env: NodeJS.ProcessEnv = process.env): boolean {
	return [
		env.ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL,
		env.PI_SUBAGENTS_FORCE_CURRENT_MODEL,
		env.ASYNC_SUBAGENTS_USE_CURRENT_MODEL,
		env.PI_SUBAGENTS_USE_CURRENT_MODEL,
	].some((value) => typeof value === "string" && TRUE_ENV_PATTERN.test(value.trim()));
}

export function currentModelRef(model: unknown): string | undefined {
	if (!isRecord(model)) return undefined;
	const id = trimString(model.id);
	if (!id) return undefined;
	const provider = trimString(model.provider);
	return provider && !id.includes("/") ? `${provider}/${id}` : id;
}

export function isBlindModelRef(modelRef: string | undefined, config: SubagentConfig): boolean {
	if (!modelRef) return false;
	return matchesAnyModelPattern(modelRef, config.vision?.blindModelPatterns ?? []);
}

export function selectSubagentType(task: AgentTask, config: SubagentConfig): string | undefined {
	const explicit = trimString(task.subagentType);
	if (explicit) return explicit;
	return defaultSubagentType(config);
}

function readConfigFile(file: string): Partial<SubagentConfig> {
	const raw = fs.readFileSync(file, "utf-8");
	const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
	if (!isRecord(parsed)) throw new Error(`Subagent config must be an object: ${file}`);
	return normalizeConfig(parsed, file);
}

function readPiToolsSuiteSubagentConfig(file: string): Partial<SubagentConfig> {
	const raw = fs.readFileSync(file, "utf-8");
	const parsed = parseJsonc(raw) as unknown;
	if (!isRecord(parsed)) return {};
	const section = parsed.asyncSubagents ?? parsed["async-subagents"] ?? parsed.subagents;
	return isRecord(section) ? normalizeConfig(section, file) : {};
}

function hasPiToolsSuiteSubagentConfig(file: string): boolean {
	const raw = fs.readFileSync(file, "utf-8");
	const parsed = parseJsonc(raw) as unknown;
	if (!isRecord(parsed)) return false;
	return isRecord(parsed.asyncSubagents ?? parsed["async-subagents"] ?? parsed.subagents);
}

function writePiToolsSuiteSubagentConfig(file: string, config: Partial<SubagentConfig>): void {
	ensurePiToolsSuiteUserConfig();
	const original = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "{}\n";
	const edits = modify(original, ["asyncSubagents"], config, {
		formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
	});
	const updated = applyEdits(original, edits);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, updated.endsWith("\n") ? updated : `${updated}\n`, "utf-8");
}

function normalizeConfig(value: Record<string, unknown>, file: string): Partial<SubagentConfig> {
	const output: Partial<SubagentConfig> = {};
	if (typeof value.defaultType === "string") output.defaultType = value.defaultType.trim();
	if (typeof value.routing === "boolean") output.routing = { enabled: value.routing };
	else if (isRecord(value.routing)) output.routing = normalizeRoutingConfig(value.routing);
	const vision = normalizeVisionConfig(value);
	if (vision) output.vision = vision;
	const maxConcurrent = finiteNumber(value.maxConcurrent);
	if (maxConcurrent !== undefined) output.maxConcurrent = Math.max(0, Math.round(maxConcurrent));
	const maxResultBytes = finiteNumber(value.maxResultBytes);
	if (maxResultBytes !== undefined) output.maxResultBytes = Math.max(0, Math.round(maxResultBytes));
	const timeoutMs = positiveMilliseconds(value.timeoutMs);
	if (timeoutMs !== undefined) output.timeoutMs = timeoutMs;
	if (isRecord(value.retry)) output.retry = normalizeRetryConfig(value.retry);
	if (value.presets !== undefined) {
		if (!isRecord(value.presets)) throw new Error(`Subagent config "presets" must be an object: ${file}`);
		const presets: Record<string, SubagentPreset> = {};
		for (const [name, rawPreset] of Object.entries(value.presets)) {
			if (!isRecord(rawPreset)) throw new Error(`Subagent preset "${name}" must be an object: ${file}`);
			presets[name] = {
				description: trimString(rawPreset.description),
				model: trimString(rawPreset.model),
				fallbackModels: modelList(rawPreset.fallbackModels, rawPreset.fallbackModel),
				thinking: trimString(rawPreset.thinking),
				extraArgs: arrayOfStrings(rawPreset.extraArgs),
				timeoutMs: positiveMilliseconds(rawPreset.timeoutMs),
				types: normalizePresetTypeOverrides(rawPreset.types, file, name),
			};
		}
		output.presets = presets;
	}
	if (value.types === undefined) return output;
	if (!isRecord(value.types)) throw new Error(`Subagent config "types" must be an object: ${file}`);

	const types: Record<string, SubagentTypeConfig> = {};
	for (const [name, rawProfile] of Object.entries(value.types)) {
		if (!isRecord(rawProfile)) throw new Error(`Subagent type "${name}" must be an object: ${file}`);
		types[name] = {
			description: trimString(rawProfile.description),
			model: trimString(rawProfile.model),
			fallbackModels: modelList(rawProfile.fallbackModels, rawProfile.fallbackModel),
			thinking: trimString(rawProfile.thinking),
			tools: arrayOfStrings(rawProfile.tools),
			extraArgs: arrayOfStrings(rawProfile.extraArgs),
			promptAppend: textBlock(rawProfile.promptAppend),
			promptOverride: textBlock(rawProfile.promptOverride),
			retry: isRecord(rawProfile.retry) ? normalizeRetryConfig(rawProfile.retry) : undefined,
			maxResultBytes: finiteNumber(rawProfile.maxResultBytes) !== undefined ? Math.max(0, Math.round(finiteNumber(rawProfile.maxResultBytes)!)) : undefined,
			timeoutMs: positiveMilliseconds(rawProfile.timeoutMs),
		};
	}
	output.types = types;
	return output;
}

function mergeConfig(target: SubagentConfig, source: Partial<SubagentConfig>): void {
	if (source.defaultType) target.defaultType = source.defaultType;
	if (source.routing) target.routing = { ...(target.routing ?? {}), ...source.routing };
	if (source.vision) target.vision = { ...(target.vision ?? {}), ...compactVisionConfig(source.vision) };
	if (source.maxConcurrent !== undefined) target.maxConcurrent = source.maxConcurrent;
	if (source.maxResultBytes !== undefined) target.maxResultBytes = source.maxResultBytes;
	if (source.timeoutMs !== undefined) target.timeoutMs = source.timeoutMs;
	if (source.retry) target.retry = { ...(target.retry ?? {}), ...source.retry };
	for (const [name, profile] of Object.entries(source.types ?? {})) {
		target.types[name] = { ...(target.types[name] ?? {}), ...compactProfile(profile) };
	}
	for (const [name, preset] of Object.entries(source.presets ?? {})) {
		target.presets = target.presets ?? {};
		target.presets[name] = { ...(target.presets[name] ?? {}), ...compactPreset(preset) };
	}
}

function normalizeRoutingConfig(value: Record<string, unknown>): SubagentRoutingConfig {
	const routing: SubagentRoutingConfig = {};
	if (typeof value.enabled === "boolean") routing.enabled = value.enabled;
	if (typeof value.model === "string" && value.model.trim()) routing.model = value.model.trim();
	if (typeof value.debug === "boolean") routing.debug = value.debug;
	const maxTaskChars = finiteNumber(value.maxTaskChars);
	if (maxTaskChars !== undefined) routing.maxTaskChars = Math.max(100, Math.round(maxTaskChars));
	const maxTokens = finiteNumber(value.maxTokens);
	if (maxTokens !== undefined) routing.maxTokens = Math.max(8, Math.round(maxTokens));
	const maxRetries = finiteNumber(value.maxRetries);
	if (maxRetries !== undefined) routing.maxRetries = Math.max(0, Math.round(maxRetries));
	const temperature = finiteNumber(value.temperature);
	if (temperature !== undefined) routing.temperature = Math.min(2, Math.max(0, temperature));
	const timeoutMs = finiteNumber(value.timeoutMs);
	if (timeoutMs !== undefined) routing.timeoutMs = Math.max(1000, Math.round(timeoutMs));
	return routing;
}

function normalizeVisionConfig(value: Record<string, unknown>): SubagentVisionConfig | undefined {
	const rawVision = value.vision;
	const output: SubagentVisionConfig = {};
	if (isRecord(rawVision)) {
		const patterns = patternList(rawVision.blindModelPatterns, rawVision.blindModelPattern, rawVision.blindModels, rawVision.blindModelMasks, rawVision.blindModelMask);
		if (patterns) output.blindModelPatterns = patterns;
	}
	const topLevelPatterns = patternList(value.blindModelPatterns, value.blindModelPattern, value.blindModels, value.blindModelMasks, value.blindModelMask);
	if (topLevelPatterns) output.blindModelPatterns = topLevelPatterns;
	return output.blindModelPatterns !== undefined ? output : undefined;
}

function matchesAnyModelPattern(modelRef: string, patterns: string[]): boolean {
	return patterns.some((pattern) => modelPatternRegExp(pattern).test(modelRef));
}

function modelPatternRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

function compactProfile(profile: SubagentTypeConfig): SubagentTypeConfig {
	const compact: SubagentTypeConfig = {};
	if (profile.description) compact.description = profile.description;
	if (profile.model) compact.model = profile.model;
	if (profile.fallbackModels && profile.fallbackModels.length > 0) compact.fallbackModels = profile.fallbackModels;
	if (profile.thinking) compact.thinking = profile.thinking;
	if (profile.tools && profile.tools.length > 0) compact.tools = profile.tools;
	if (profile.extraArgs && profile.extraArgs.length > 0) compact.extraArgs = profile.extraArgs;
	if (profile.promptAppend) compact.promptAppend = profile.promptAppend;
	if (profile.promptOverride) compact.promptOverride = profile.promptOverride;
	if (profile.retry) compact.retry = profile.retry;
	if (profile.maxResultBytes !== undefined) compact.maxResultBytes = profile.maxResultBytes;
	if (profile.timeoutMs !== undefined) compact.timeoutMs = profile.timeoutMs;
	return compact;
}

function compactPreset(preset: SubagentPreset): SubagentPreset {
	const compact: SubagentPreset = {};
	if (preset.description) compact.description = preset.description;
	if (preset.model) compact.model = preset.model;
	if (preset.fallbackModels && preset.fallbackModels.length > 0) compact.fallbackModels = preset.fallbackModels;
	if (preset.thinking) compact.thinking = preset.thinking;
	if (preset.extraArgs && preset.extraArgs.length > 0) compact.extraArgs = preset.extraArgs;
	if (preset.timeoutMs !== undefined) compact.timeoutMs = preset.timeoutMs;
	if (preset.types && Object.keys(preset.types).length > 0) compact.types = preset.types;
	return compact;
}

function compactVisionConfig(vision: SubagentVisionConfig): SubagentVisionConfig {
	const compact: SubagentVisionConfig = {};
	if (vision.blindModelPatterns) compact.blindModelPatterns = vision.blindModelPatterns;
	return compact;
}

function normalizePresetTypeOverrides(value: unknown, file: string, presetName: string): Record<string, SubagentPresetTypeOverride> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`Subagent preset "${presetName}" types must be an object: ${file}`);
	const types: Record<string, SubagentPresetTypeOverride> = {};
	for (const [name, rawOverride] of Object.entries(value)) {
		if (!isRecord(rawOverride)) throw new Error(`Subagent preset "${presetName}" type override "${name}" must be an object: ${file}`);
		const override: SubagentPresetTypeOverride = {};
		const model = trimString(rawOverride.model);
		const fallbackModels = modelList(rawOverride.fallbackModels, rawOverride.fallbackModel);
		const thinking = trimString(rawOverride.thinking);
		const extraArgs = arrayOfStrings(rawOverride.extraArgs);
		const timeoutMs = positiveMilliseconds(rawOverride.timeoutMs);
		if (model) override.model = model;
		if (fallbackModels && fallbackModels.length > 0) override.fallbackModels = fallbackModels;
		if (thinking) override.thinking = thinking;
		if (extraArgs && extraArgs.length > 0) override.extraArgs = extraArgs;
		if (timeoutMs !== undefined) override.timeoutMs = timeoutMs;
		if (override.model || override.fallbackModels || override.thinking || override.extraArgs || override.timeoutMs !== undefined) types[name] = override;
	}
	return Object.keys(types).length > 0 ? types : undefined;
}

function resolveFallbackModels(options: {
	model?: string;
	presetType?: SubagentPresetTypeOverride;
	preset?: SubagentPreset;
	profile?: SubagentTypeConfig;
}): string[] {
	const fallbacks = [
		...(options.presetType?.fallbackModels ?? []),
		...(options.preset?.fallbackModels ?? []),
		...(options.profile?.fallbackModels ?? []),
	];
	const seen = new Set<string>();
	if (options.model) seen.add(options.model);
	const result: string[] = [];
	for (const fallback of fallbacks) {
		const model = trimString(fallback);
		if (!model || seen.has(model)) continue;
		seen.add(model);
		result.push(model);
	}
	return result;
}

function applyEnvModelOverrides(config: SubagentConfig, env: NodeJS.ProcessEnv): void {
	for (const [name, profile] of Object.entries(config.types)) {
		const key = typeEnvKey(name);
		const model = trimString(env[`ASYNC_SUBAGENTS_${key}_MODEL`] || env[`PI_SUBAGENTS_${key}_MODEL`]);
		if (model) profile.model = model;
	}
}

function applyEnvRoutingOverrides(config: SubagentConfig, env: NodeJS.ProcessEnv): void {
	const routing = { ...DEFAULT_ROUTING_CONFIG, ...(config.routing ?? {}) };
	const enabled = trimString(env.ASYNC_SUBAGENTS_ROUTING || env.PI_SUBAGENTS_ROUTING);
	if (enabled) {
		if (FALSE_ENV_PATTERN.test(enabled)) routing.enabled = false;
		else if (TRUE_ENV_PATTERN.test(enabled)) routing.enabled = true;
	}
	const model = trimString(env.ASYNC_SUBAGENTS_ROUTING_MODEL || env.PI_SUBAGENTS_ROUTING_MODEL || env.ASYNC_SUBAGENTS_ROUTER_MODEL || env.PI_SUBAGENTS_ROUTER_MODEL);
	if (model) routing.model = model;
	const timeoutMs = finiteEnvNumber(env.ASYNC_SUBAGENTS_ROUTING_TIMEOUT_MS || env.PI_SUBAGENTS_ROUTING_TIMEOUT_MS);
	if (timeoutMs !== undefined) routing.timeoutMs = Math.max(1000, Math.round(timeoutMs));
	const debug = trimString(env.ASYNC_SUBAGENTS_ROUTING_DEBUG || env.PI_SUBAGENTS_ROUTING_DEBUG);
	if (debug) routing.debug = TRUE_ENV_PATTERN.test(debug);
	config.routing = routing;
}

function typeEnvKey(typeName: string): string {
	return typeName.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function stripJsonComments(input: string): string {
	let output = "";
	let inString = false;
	let quote = "";
	let escaped = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		const next = input[i + 1];
		if (inString) {
			output += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === quote) inString = false;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			output += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < input.length && input[i] !== "\n") i++;
			output += "\n";
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
			i++;
			continue;
		}
		output += ch;
	}
	return output.replace(/,\s*([}\]])/g, "$1");
}

function cloneConfig(config: SubagentConfig): SubagentConfig {
	return JSON.parse(JSON.stringify(config)) as SubagentConfig;
}

function expandHome(value: string): string {
	return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function trimString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveMilliseconds(value: unknown): number | undefined {
	const number = finiteNumber(value);
	return number !== undefined ? Math.max(1, Math.round(number)) : undefined;
}

function finiteEnvNumber(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function arrayOfStrings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
	return items.length > 0 ? items : undefined;
}

function modelList(...values: unknown[]): string[] | undefined {
	const seen = new Set<string>();
	const models: string[] = [];
	for (const value of values) {
		const items = Array.isArray(value) ? value : [value];
		for (const item of items) {
			const model = trimString(item);
			if (!model || seen.has(model)) continue;
			seen.add(model);
			models.push(model);
		}
	}
	return models.length > 0 ? models : undefined;
}

function patternList(...values: unknown[]): string[] | undefined {
	let sawArray = false;
	const seen = new Set<string>();
	const patterns: string[] = [];
	for (const value of values) {
		if (Array.isArray(value)) sawArray = true;
		const items = Array.isArray(value) ? value : [value];
		for (const item of items) {
			const pattern = trimString(item);
			if (!pattern || seen.has(pattern)) continue;
			seen.add(pattern);
			patterns.push(pattern);
		}
	}
	return sawArray || patterns.length > 0 ? patterns : undefined;
}

function textBlock(value: unknown): string | undefined {
	if (typeof value === "string") return trimString(value);
	const lines = arrayOfStrings(value);
	return lines && lines.length > 0 ? lines.join("\n") : undefined;
}

function joinTextBlocks(...values: Array<string | undefined>): string | undefined {
	const parts = values.map((value) => trimString(value)).filter((value): value is string => Boolean(value));
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function normalizeRetryConfig(value: Record<string, unknown>): Partial<RetryConfig> {
	const retry: Partial<RetryConfig> = {};
	const maxRetries = finiteNumber(value.maxRetries);
	if (maxRetries !== undefined) retry.maxRetries = Math.max(0, Math.round(maxRetries));
	const backoffMs = finiteNumber(value.backoffMs);
	if (backoffMs !== undefined) retry.backoffMs = Math.max(0, Math.round(backoffMs));
	if (Array.isArray(value.retryableExitCodes)) {
		retry.retryableExitCodes = value.retryableExitCodes
			.filter((code): code is number => typeof code === "number" && Number.isFinite(code))
			.map((code) => Math.round(code));
	}
	return retry;
}

function stripUndefined<T extends Record<string, unknown>>(obj?: Partial<T>): Partial<T> {
	if (!obj) return {};
	const result: Partial<T> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) (result as Record<string, unknown>)[key] = value;
	}
	return result;
}

function stripModelArgs(args: string[]): string[] {
	const output: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--model" || arg === "-m") {
			i++;
			continue;
		}
		if (arg.startsWith("--model=")) continue;
		output.push(arg);
	}
	return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
