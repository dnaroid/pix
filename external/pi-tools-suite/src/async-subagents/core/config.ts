import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { projectAgentsDir, readAgentDefinitionsFromDir, readProjectAgentDefinitions, type AgentDefinition } from "./agents-dir.js";
import type { AgentTask, RetryConfig } from "./types.js";

export interface ModelByParentEntry {
	/** Model ref to use when the parent model matches the entry's pattern. */
	model: string;
	/** Ordered fallbacks used when this entry's model hits quota/rate limits; replaces the normal fallback chain. */
	fallbackModels?: string[];
}

export interface SubagentTypeConfig {
	description?: string;
	/**
	 * Agent icon name resolved by UIs (pix TUI icon themes, Pix Desktop lucide
	 * icons). Opaque pass-through here: unknown names render as the neutral
	 * default agent icon.
	 */
	icon?: string;
	/** Ranked candidates. The preset filters availability, never changes this order. */
	models?: string[];
	/** Legacy primary candidate; new profiles use models. */
	model?: string;
	/** Legacy candidates after model; new profiles use one ordered models list. */
	fallbackModels?: string[];
	/**
	 * Parent-model-aware model selection. Keys are glob model refs (e.g. "zai/*")
	 * matched against the current parent model; the first matching key wins.
	 * Values may be a model ref string or { model, fallbackModels? }.
	 * Ordinary roles: explicit task/forced model and preset models take priority.
	 * Oracle alone keeps parent-aware selection ahead of presets.
	 */
	modelByParent?: Record<string, ModelByParentEntry>;
	thinking?: string;
	tools?: string[];
	/** Explicit skill files loaded after disabling normal skill discovery. */
	isolatedSkills?: string[];
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
	/** Router model in provider/model form. Falls back to fallbackModels, then the current parent model, if unavailable. */
	model?: string;
	/** Ordered router model fallbacks tried when the primary routing model is unavailable or fails. */
	fallbackModels?: string[];
	/** Maximum task/scope characters sent to the router per task. */
	maxTaskChars?: number;
	/** Maximum router response tokens. */
	maxTokens?: number;
	/** Router complete() retries. */
	maxRetries?: number;
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
	/** Available model pool. Agent candidate order wins; [] allows no models. */
	models?: string[];
	/** Legacy default model; prefer models for new presets. */
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
	/** Ambiguous-task router hint and legacy resolver default; never a spawn error fallback. */
	defaultType?: string;
	types: Record<string, SubagentTypeConfig>;
	/** Fallback LLM role selection for omitted types; explicit valid types bypass it. */
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

export interface ResolvedAgentTaskConfig {
	task: AgentTask;
	extraArgs: string[];
	/** Explicit skill files loaded with normal skill discovery disabled. */
	isolatedSkills: string[];
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

export class SubagentModelSelectionError extends Error {
	constructor(taskId: string, message: string) {
		super(`Task ${taskId}: ${message} No agents were launched. Configure a compatible model pool/candidate list or provide an explicit model override.`);
		this.name = "SubagentModelSelectionError";
	}
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
	/** Current parent model ref (provider/model). Enables type.modelByParent matching. */
	parentModel?: string;
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
	model: "zai/glm-5-turbo",
	fallbackModels: ["openai-codex/gpt-5.6-luna"],
	maxTaskChars: 1200,
	maxTokens: 512,
	maxRetries: 1,
	timeoutMs: 12_000,
	debug: false,
};

const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
const BUILTIN_PRESETS_FILE = path.join(BUILTIN_AGENTS_DIR, "presets.jsonc");
const DEFAULT_BLIND_MODEL_PATTERNS = [
	"zai/glm-4.5*", "glm-4.5*", "*/glm-4.5*",
	"zai/glm-5-turbo*", "glm-5-turbo*", "*/glm-5-turbo*",
	"zai/glm-5.3", "glm-5.3", "*/glm-5.3",
];

const BUILTIN_CONFIG: SubagentConfig = {
	defaultType: "research",
	maxConcurrent: DEFAULT_MAX_CONCURRENT,
	maxResultBytes: 100_000,
	routing: { ...DEFAULT_ROUTING_CONFIG },
	vision: { blindModelPatterns: DEFAULT_BLIND_MODEL_PATTERNS },
	presets: readPresetConfigFile(BUILTIN_PRESETS_FILE).presets,
	types: normalizeAgentDefinitions(readAgentDefinitionsFromDir(BUILTIN_AGENTS_DIR)),
};

export function loadSubagentConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): SubagentConfig {
	const config = cloneConfig(BUILTIN_CONFIG);
	mergeConfig(config, projectPresetConfig(cwd));
	// Project-local agent definitions (.pi/agents/*.md) are the only project
	// source of role/profile configuration and are loaded fresh on every call.
	mergeConfig(config, projectAgentTypes(cwd));
	applyEnvModelOverrides(config, env);
	applyEnvRoutingOverrides(config, env);
	applyEnvRuntimeOverrides(config, env);
	return config;
}

export function getBuiltinSubagentDefinitionsDir(): string {
	return BUILTIN_AGENTS_DIR;
}

export function getBuiltinSubagentPresetsPath(): string {
	return BUILTIN_PRESETS_FILE;
}

export function getProjectSubagentPresetsPath(cwd: string): string {
	return path.join(projectAgentsDir(cwd) ?? path.join(path.resolve(cwd), ".pi", "agents"), "presets.jsonc");
}

/** Normalize `.pi/agents/*.md` definitions through the shared type-profile path. */
function projectAgentTypes(cwd: string): Partial<SubagentConfig> {
	const definitions = readProjectAgentDefinitions(cwd);
	const types = normalizeAgentDefinitions(definitions);
	if (Object.keys(types).length === 0) return {};
	return { types };
}

function projectPresetConfig(cwd: string): Partial<SubagentConfig> {
	const dir = projectAgentsDir(cwd);
	if (!dir) return {};
	const file = path.join(dir, "presets.jsonc");
	return fs.existsSync(file) ? readPresetConfigFile(file) : {};
}

function normalizeAgentDefinitions(definitions: Record<string, AgentDefinition>): Record<string, SubagentTypeConfig> {
	const types: Record<string, SubagentTypeConfig> = {};
	for (const [name, definition] of Object.entries(definitions)) {
		types[name] = normalizeSubagentTypeProfile(definition.raw, name, definition.file);
	}
	return types;
}

export function resolveAgentTaskConfig(
	task: AgentTask,
	config: SubagentConfig,
	globalOptions: ResolveAgentTaskOptions = {},
): ResolvedAgentTaskConfig {
	const selectedType = selectSubagentType(task, config);
	const profile = selectedType ? config.types[selectedType] : undefined;
	const preset = globalOptions.preset;
	// A new pool preset has no per-role policy. Ignore any inherited legacy
	// matrix/defaults so changing the pool cannot resurrect an expensive model.
	const legacyPreset = preset?.models === undefined ? preset : undefined;
	const explicitType = trimString(task.subagentType);
	const requestedType = explicitType || trimString(config.defaultType);
	// Legacy preset matrices still apply to an explicitly configured type with
	// the same name. There are no implicit aliases between type names.
	const presetType = (requestedType ? legacyPreset?.types?.[requestedType] : undefined)
		?? (selectedType ? legacyPreset?.types?.[selectedType] : undefined);
	const taskExtraArgs = arrayOfStrings(task.extraArgs) ?? [];
	const profileExtraArgs = arrayOfStrings(profile?.extraArgs) ?? [];
	const presetTypeExtraArgs = arrayOfStrings(presetType?.extraArgs) ?? [];
	const presetExtraArgs = arrayOfStrings(legacyPreset?.extraArgs) ?? [];
	const globalExtraArgs = arrayOfStrings(globalOptions.extraArgs) ?? [];
	const promptAppend = joinTextBlocks(profile?.promptAppend, task.promptAppend);
	const forcedModel = trimString(globalOptions.forcedModel);
	const taskModel = trimString(task.model);
	const parentMatch = resolveModelByParent(profile, trimString(globalOptions.parentModel));
	const parentMatchModel = trimString(parentMatch?.model);
	const presetTypeModel = trimString(presetType?.model);
	const globalModel = trimString(globalOptions.model);
	const presetModel = trimString(legacyPreset?.model);
	const profileModels = profile?.models ?? modelList(profile?.model, profile?.fallbackModels) ?? [];
	const profileModel = profileModels[0];
	const usedParentMatch = Boolean(parentMatchModel) && !forcedModel && !taskModel
		&& (selectedType === "oracle" || !(presetTypeModel || globalModel || presetModel));
	const primaryModel = forcedModel || taskModel || (usedParentMatch ? parentMatchModel : undefined)
		|| presetTypeModel || globalModel || presetModel || profileModel;
	const configuredFallbacks = forcedModel || taskModel
		? []
		: usedParentMatch && parentMatch?.fallbackModels !== undefined
			? parentMatch.fallbackModels
			: resolveFallbackModels({ model: primaryModel, presetType, preset: legacyPreset, profileModels, profile });
	const extraArgs = forcedModel
		? stripModelArgs([...profileExtraArgs, ...presetTypeExtraArgs, ...taskExtraArgs, ...presetExtraArgs, ...globalExtraArgs])
		: [...profileExtraArgs, ...presetTypeExtraArgs, ...taskExtraArgs, ...presetExtraArgs, ...globalExtraArgs];
	const cliModel = modelFromArgs(extraArgs);
	const explicitModel = forcedModel || cliModel || taskModel;
	let candidates = modelList(explicitModel || primaryModel, explicitModel ? [] : configuredFallbacks) ?? [];
	if (!explicitModel) {
		if (selectedType === "oracle" && globalOptions.parentModel && !usedParentMatch
			&& !presetTypeModel && !presetModel && !globalModel && !profile?.model) {
			const parentProvider = globalOptions.parentModel.split("/")[0];
			candidates = [
				...candidates.filter((ref) => ref.split("/")[0] !== parentProvider),
				...candidates.filter((ref) => ref.split("/")[0] === parentProvider),
			];
		}
		if (preset?.models !== undefined) {
			const available = new Set(preset.models);
			candidates = candidates.filter((ref) => available.has(ref));
			if (candidates.length === 0) {
				throw new SubagentModelSelectionError(task.id, "No ranked candidate is in the active preset's models pool.");
			}
		}
	}
	if (candidates.length === 0) {
		throw new SubagentModelSelectionError(task.id, "No model candidates are configured; set models on the agent profile.");
	}
	const [model, ...fallbackModels] = candidates;
	const timeoutMs = task.timeoutMs ?? globalOptions.timeoutMs ?? presetType?.timeoutMs ?? legacyPreset?.timeoutMs ?? profile?.timeoutMs ?? config.timeoutMs;

	return {
		profile,
		extraArgs,
		isolatedSkills: arrayOfStrings(profile?.isolatedSkills) ?? [],
		fallbackModels,
		retry: resolveRetryConfig(config.retry, profile?.retry),
		maxResultBytes: profile?.maxResultBytes ?? config.maxResultBytes,
		timeoutMs,
		task: {
			...task,
			subagentType: selectedType,
			model,
			thinking: trimString(globalOptions.thinking) || trimString(task.thinking) || trimString(presetType?.thinking) || trimString(globalOptions.defaultThinking) || trimString(legacyPreset?.thinking) || trimString(profile?.thinking),
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
	const configured = trimString(config.defaultType);
	if (configured) return Object.prototype.hasOwnProperty.call(config.types, configured) ? configured : undefined;
	return Object.keys(config.types).find((name) => trimString(name));
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

function readPresetConfigFile(file: string): Partial<SubagentConfig> {
	const raw = fs.readFileSync(file, "utf-8");
	const parsed = parseJsonc(raw) as unknown;
	if (!isRecord(parsed)) throw new Error(`Subagent presets file must contain an object: ${file}`);
	return { presets: normalizePresetMap(parsed, file, "preset file") };
}

function normalizePresetMap(value: unknown, file: string, owner: string): Record<string, SubagentPreset> {
	if (!isRecord(value)) throw new Error(`Subagent ${owner} must be an object: ${file}`);
	const presets: Record<string, SubagentPreset> = {};
	for (const [name, rawPreset] of Object.entries(value)) {
		if (!isRecord(rawPreset)) throw new Error(`Subagent preset "${name}" must be an object: ${file}`);
		const models = normalizeModels(rawPreset.models, `preset "${name}"`, file);
		if (models === undefined) throw new Error(`Subagent preset "${name}" must define models: ${file}`);
		presets[name] = {
			description: trimString(rawPreset.description),
			models,
		};
	}
	return presets;
}

/**
 * Normalize one raw sub-agent type profile (`SubagentTypeConfig` shape) from
 * an agent Markdown definition. Bundled and project files share the same
 * validation and trimming path.
 */
export function normalizeSubagentTypeProfile(
	rawProfile: Record<string, unknown>,
	name: string,
	file: string,
): SubagentTypeConfig {
	const models = normalizeModels(rawProfile.models, `type "${name}"`, file);
	return {
		description: trimString(rawProfile.description),
		icon: trimString(rawProfile.icon),
		models,
		model: models === undefined ? trimString(rawProfile.model) : undefined,
		fallbackModels: models === undefined ? modelList(rawProfile.fallbackModels, rawProfile.fallbackModel) : undefined,
		modelByParent: models === undefined ? normalizeModelByParent(rawProfile.modelByParent, name, file) : undefined,
		thinking: trimString(rawProfile.thinking),
		tools: arrayOfStrings(rawProfile.tools),
		isolatedSkills: arrayOfStrings(rawProfile.isolatedSkills),
		extraArgs: arrayOfStrings(rawProfile.extraArgs),
		promptAppend: textBlock(rawProfile.promptAppend),
		promptOverride: textBlock(rawProfile.promptOverride),
		retry: isRecord(rawProfile.retry) ? normalizeRetryConfig(rawProfile.retry) : undefined,
		maxResultBytes: finiteNumber(rawProfile.maxResultBytes) !== undefined ? Math.max(0, Math.round(finiteNumber(rawProfile.maxResultBytes)!)) : undefined,
		timeoutMs: positiveMilliseconds(rawProfile.timeoutMs),
	};
}

function mergeConfig(target: SubagentConfig, source: Partial<SubagentConfig>): void {
	for (const [name, profile] of Object.entries(source.types ?? {})) {
		target.types[name] = mergeTypeProfile(target.types[name] ?? {}, profile);
	}
	for (const [name, preset] of Object.entries(source.presets ?? {})) {
		target.presets = target.presets ?? {};
		const previous = target.presets[name] ?? {};
		const merged = { ...previous, ...compactPreset(preset) };
		delete merged.model;
		delete merged.fallbackModels;
		delete merged.types;
		delete merged.thinking;
		delete merged.extraArgs;
		delete merged.timeoutMs;
		target.presets[name] = merged;
	}
}

/** Preserve legacy field overrides without allowing inherited primary models
 * to win over a newly supplied candidate list (or the reverse). */
function mergeTypeProfile(base: SubagentTypeConfig, source: SubagentTypeConfig): SubagentTypeConfig {
	const merged = { ...compactProfile(base), ...compactProfile(source) };
	if (source.models !== undefined) {
		merged.models = [...source.models];
		delete merged.model;
		delete merged.fallbackModels;
		delete merged.modelByParent;
	} else if (source.model || source.fallbackModels !== undefined) {
		const previous = base.models ?? modelList(base.model, base.fallbackModels) ?? [];
		delete merged.models;
		merged.model = source.model ?? previous[0];
		merged.fallbackModels = source.fallbackModels ?? base.fallbackModels ?? previous.slice(1);
	}
	return merged;
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
	if (profile.icon) compact.icon = profile.icon;
	if (profile.models !== undefined) compact.models = profile.models;
	if (profile.model) compact.model = profile.model;
	if (profile.fallbackModels) compact.fallbackModels = profile.fallbackModels;
	if (profile.modelByParent) compact.modelByParent = profile.modelByParent;
	if (profile.thinking) compact.thinking = profile.thinking;
	if (profile.tools && profile.tools.length > 0) compact.tools = profile.tools;
	if (profile.isolatedSkills && profile.isolatedSkills.length > 0) compact.isolatedSkills = profile.isolatedSkills;
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
	if (preset.models !== undefined) compact.models = preset.models;
	if (preset.model) compact.model = preset.model;
	if (preset.fallbackModels) compact.fallbackModels = preset.fallbackModels;
	if (preset.thinking) compact.thinking = preset.thinking;
	if (preset.extraArgs && preset.extraArgs.length > 0) compact.extraArgs = preset.extraArgs;
	if (preset.timeoutMs !== undefined) compact.timeoutMs = preset.timeoutMs;
	if (preset.types && Object.keys(preset.types).length > 0) compact.types = preset.types;
	return compact;
}

function normalizeModels(value: unknown, owner: string, file: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((ref) => typeof ref !== "string" || !/^[^\s/*]+\/[^\s*]+$/.test(ref.trim()))) {
		throw new Error(`Subagent ${owner} models must be an array of provider/model references: ${file}`);
	}
	return [...new Set(value.map((ref: string) => ref.trim()))];
}

function normalizeModelByParent(value: unknown, typeName: string, file: string): Record<string, ModelByParentEntry> | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) throw new Error(`Subagent type "${typeName}" modelByParent must be an object: ${file}`);
	const out: Record<string, ModelByParentEntry> = {};
	for (const [pattern, raw] of Object.entries(value)) {
		const pat = trimString(pattern);
		if (!pat) continue;
		if (typeof raw === "string") {
			const model = trimString(raw);
			if (model) out[pat] = { model };
			continue;
		}
		if (isRecord(raw)) {
			const model = trimString(raw.model);
			if (!model) throw new Error(`Subagent type "${typeName}" modelByParent["${pat}"].model must be a non-empty string: ${file}`);
			out[pat] = { model, fallbackModels: modelList(raw.fallbackModels, raw.fallbackModel) };
			continue;
		}
		throw new Error(`Subagent type "${typeName}" modelByParent["${pat}"] must be a string or object: ${file}`);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function resolveModelByParent(profile: SubagentTypeConfig | undefined, parentModelRef: string | undefined): ModelByParentEntry | undefined {
	const entries = profile?.modelByParent;
	if (!entries || !parentModelRef) return undefined;
	for (const [pattern, entry] of Object.entries(entries)) {
		if (modelPatternRegExp(pattern).test(parentModelRef)) return entry;
	}
	return undefined;
}

function resolveFallbackModels(options: {
	model?: string;
	presetType?: SubagentPresetTypeOverride;
	preset?: SubagentPreset;
	profileModels: string[];
	profile?: SubagentTypeConfig;
}): string[] {
	// A selected budget's fallback list is authoritative, including [] (none).
	const fallbacks = options.presetType?.fallbackModels
		?? options.preset?.fallbackModels ?? options.profile?.fallbackModels ?? options.profileModels.slice(1);
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
	for (const name of Object.keys(config.types)) {
		const key = typeEnvKey(name);
		const model = trimString(env[`ASYNC_SUBAGENTS_${key}_MODEL`] || env[`PI_SUBAGENTS_${key}_MODEL`]);
		if (model) {
			config.types[name] = mergeTypeProfile(config.types[name] ?? {}, { model });
		}
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

function applyEnvRuntimeOverrides(config: SubagentConfig, env: NodeJS.ProcessEnv): void {
	const maxConcurrent = finiteEnvNumber(env.PI_SUBAGENTS_MAX_CONCURRENT || env.ASYNC_SUBAGENTS_MAX_CONCURRENT);
	if (maxConcurrent !== undefined) config.maxConcurrent = Math.max(0, Math.round(maxConcurrent));
	const maxResultBytes = finiteEnvNumber(env.PI_SUBAGENTS_MAX_RESULT_BYTES || env.ASYNC_SUBAGENTS_MAX_RESULT_BYTES);
	if (maxResultBytes !== undefined) config.maxResultBytes = Math.max(0, Math.round(maxResultBytes));
	const timeoutMs = finiteEnvNumber(env.PI_SUBAGENTS_TIMEOUT_MS || env.ASYNC_SUBAGENTS_TIMEOUT_MS);
	if (timeoutMs !== undefined) config.timeoutMs = Math.max(1, Math.round(timeoutMs));
}

function typeEnvKey(typeName: string): string {
	return typeName.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function cloneConfig(config: SubagentConfig): SubagentConfig {
	return JSON.parse(JSON.stringify(config)) as SubagentConfig;
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
	return models.length > 0 || values.some(Array.isArray) ? models : undefined;
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

/** CLI overrides are explicit, too; retain the final flag's actual model. */
function modelFromArgs(args: string[]): string | undefined {
	let model: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--model" || args[i] === "-m") model = trimString(args[++i]);
		else if (args[i].startsWith("--model=")) model = trimString(args[i].slice("--model=".length));
	}
	return model;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
