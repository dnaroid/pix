import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPiToolsSuiteConfig } from "../../config.js";
import { readAgentDefinitionsFromDir, readProjectAgentDefinitions, type AgentDefinition } from "./agents-dir.js";
import { LEGACY_BROWSER_QA_TYPE, UI_QA_TYPE } from "./browser-qa.js";
import {
	applyVendorPolicy,
	defaultFrontierConfig,
	economyBlockReason,
	frontierCandidatesForRole,
	isFrontierModel,
	modelVendor,
	type FrontierConfig,
} from "./frontier-models.js";
import type { AgentTask, RetryConfig } from "./types.js";

export interface ModelByParentEntry {
	/** Model ref to use when the parent model matches the entry's pattern. */
	model: string;
	/** Ordered fallbacks used when this entry's model hits quota/rate limits; replaces the normal fallback chain. */
	fallbackModels: string[];
}

export interface SubagentTypeConfig {
	description?: string;
	/**
	 * Agent icon name resolved by UIs (pix TUI icon themes, Pix Desktop lucide
	 * icons). Opaque pass-through here: unknown names render as the neutral
	 * default agent icon.
	 */
	icon?: string;
	/** Ranked candidates owned by this role. Runtime availability never changes this configured order. */
	models?: string[];
	/**
	 * `frontier` takes candidates from the suite's `frontierModels` list instead
	 * of `models`, so new frontier releases need only a config edit.
	 */
	modelSelection?: "frontier";
	/** Legacy primary candidate; new profiles use models. */
	model?: string;
	/** Legacy candidates after model; new profiles use one ordered models list. */
	fallbackModels?: string[];
	/**
	 * Parent-model-aware model selection. Keys are glob model refs (e.g. "zai/*")
	 * matched against the current parent model; the first matching key wins.
	 * Raw values may be a model ref string or { model, fallbackModels? };
	 * normalized entries always carry an explicit fallbackModels array.
	 * Explicit task/forced/global model selection takes priority.
	 */
	modelByParent?: Record<string, ModelByParentEntry>;
	/**
	 * Optional parent-model allow-list. When present, this role is exposed only
	 * when the current parent model matches at least one pattern.
	 */
	forParentModels?: string[];
	/**
	 * Optional parent-model deny-list. A match hides the role even when
	 * forParentModels also matches.
	 */
	notForParentModels?: string[];
	/** Expose the role only to parents in this tier of the suite's frontier list. */
	forParentTier?: "frontier" | "non-frontier";
	/**
	 * Relationship between child candidates and the parent model's vendor.
	 * Vendors are model-family owners (openai, zai, anthropic, ...), so one
	 * model served by several providers counts as the same vendor.
	 * `require-other-if-frontier` requires another vendor for a frontier
	 * parent and prefers another vendor otherwise.
	 */
	parentProviderPolicy?: ParentProviderPolicy;
	/** @deprecated Use parentProviderPolicy: require-other. Retained as an input compatibility alias. */
	requireDifferentProvider?: boolean;
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

export type ParentProviderPolicy = "any" | "prefer-other" | "require-other" | "require-other-if-frontier";

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

export interface SubagentConfig {
	/** Ambiguous-task router hint and legacy resolver default; never a spawn error fallback. */
	defaultType?: string;
	types: Record<string, SubagentTypeConfig>;
	/** Fallback LLM role selection for omitted types; explicit valid types bypass it. */
	routing?: SubagentRoutingConfig;
	/** Vision capability overrides for parent-model guidance. */
	vision?: SubagentVisionConfig;
	/** Maximum concurrent agents per spawn batch (default 5, 0 = unlimited). */
	maxConcurrent?: number;
	/** Global retry defaults for all agent types. Per-type retry overrides these. */
	retry?: Partial<RetryConfig>;
	/** Maximum bytes kept in result.json resultText globally; per-type maxResultBytes overrides. */
	maxResultBytes?: number;
	/** Global per-agent wall-clock timeout in milliseconds. Defaults to the built-in 30 minutes. */
	timeoutMs?: number;
	/** Suite-level frontier model list and economy switch. Defaults to the built-in list. */
	frontier?: FrontierConfig;
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

export class SubagentModelSelectionError extends Error {
	constructor(taskId: string, message: string) {
		super(`Task ${taskId}: ${message} No agents were launched. Configure compatible model candidates or provide an explicit model override.`);
		this.name = "SubagentModelSelectionError";
	}
}

export interface ResolveAgentTaskOptions {
	/** Default model for spawned sub-agents when task/profile do not specify one. */
	model?: string;
	/** Default thinking level for spawned sub-agents when task/profile do not specify one. */
	defaultThinking?: string;
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
	fallbackModels: ["openai-codex/gpt-6-luna"],
	maxTaskChars: 1200,
	maxTokens: 512,
	maxRetries: 1,
	timeoutMs: 12_000,
	debug: false,
};

const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
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
	types: normalizeAgentDefinitions(readAgentDefinitionsFromDir(BUILTIN_AGENTS_DIR)),
	frontier: defaultFrontierConfig(),
};

export function loadSubagentConfig(cwd: string, env?: NodeJS.ProcessEnv): SubagentConfig {
	const runtimeEnv = env ?? process.env;
	const suiteConfig = loadPiToolsSuiteConfig([], {
		cwd,
		env: runtimeEnv,
		ensureUserConfig: false,
		...(env !== undefined && !runtimeEnv.HOME ? { includeUserConfig: false } : {}),
		...(runtimeEnv.HOME ? { homeDir: runtimeEnv.HOME } : {}),
	});
	const config = cloneConfig(BUILTIN_CONFIG);
	for (const name of suiteConfig.disabledBuiltinAgents) delete config.types[name];
	config.frontier = { models: suiteConfig.frontierModels, economy: suiteConfig.economy };
	// Project-local agent definitions (.pi/agents/*.md) are the only project
	// source of role/profile configuration and are loaded fresh on every call.
	mergeConfig(config, projectAgentTypes(cwd));
	applyEnvModelOverrides(config, runtimeEnv);
	applyEnvRoutingOverrides(config, runtimeEnv);
	applyEnvRuntimeOverrides(config, runtimeEnv);
	return config;
}

export function getBuiltinSubagentDefinitionsDir(): string {
	return BUILTIN_AGENTS_DIR;
}

/** Normalize `.pi/agents/*.md` definitions through the shared type-profile path. */
function projectAgentTypes(cwd: string): Partial<SubagentConfig> {
	const definitions = readProjectAgentDefinitions(cwd);
	const legacyUiQa = definitions[LEGACY_BROWSER_QA_TYPE];
	if (legacyUiQa) {
		if (!definitions[UI_QA_TYPE]) definitions[UI_QA_TYPE] = legacyUiQa;
		delete definitions[LEGACY_BROWSER_QA_TYPE];
	}
	const types = normalizeAgentDefinitions(definitions);
	if (Object.keys(types).length === 0) return {};
	return { types };
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
	const frontier = frontierConfigOf(config);
	const parentModelRef = trimString(globalOptions.parentModel);
	const parentVendor = modelVendor(parentModelRef, frontier);
	const parentProviderPolicy = effectiveParentProviderPolicy(profile, parentModelRef, frontier);
	if (parentProviderPolicy === "require-other" && (!parentVendor || !profile || !isSubagentTypeAvailableForParent(profile, parentModelRef, frontier))) {
		throw new SubagentModelSelectionError(task.id, "A known, permitted parent model is required for cross-vendor selection.");
	}
	const taskExtraArgs = arrayOfStrings(task.extraArgs) ?? [];
	const profileExtraArgs = arrayOfStrings(profile?.extraArgs) ?? [];
	const globalExtraArgs = arrayOfStrings(globalOptions.extraArgs) ?? [];
	const promptAppend = joinTextBlocks(profile?.promptAppend, task.promptAppend);
	const forcedModel = trimString(globalOptions.forcedModel);
	const taskModel = trimString(task.model);
	const parentMatch = resolveModelByParent(profile, parentModelRef);
	const parentMatchModel = trimString(parentMatch?.model);
	const globalModel = trimString(globalOptions.model);
	const profileModels = profileCandidateModels(profile, selectedType, frontier);
	const profileModel = profileModels[0];
	const usedParentMatch = Boolean(parentMatchModel) && !forcedModel && !taskModel
		&& !globalModel;
	const primaryModel = forcedModel || taskModel || (usedParentMatch ? parentMatchModel : undefined)
		|| globalModel || profileModel;
	const configuredFallbacks = forcedModel || taskModel
		? []
		: usedParentMatch && parentMatch?.fallbackModels !== undefined
			? parentMatch.fallbackModels
			: resolveFallbackModels({ model: primaryModel, profileModels, profile });
	const extraArgs = forcedModel
		? stripModelArgs([...profileExtraArgs, ...taskExtraArgs, ...globalExtraArgs])
		: [...profileExtraArgs, ...taskExtraArgs, ...globalExtraArgs];
	const cliModel = modelFromArgs(extraArgs);
	const explicitModel = forcedModel || cliModel || taskModel;
	let candidates = modelList(explicitModel || primaryModel, explicitModel ? [] : configuredFallbacks) ?? [];

	// Economy mode governs automatic and parent-requested choices; the forced
	// current model is already running as the parent and stays exempt.
	const economyBlocked: string[] = [];
	if (!forcedModel) {
		if (explicitModel) {
			const reason = economyBlockReason(explicitModel, frontier);
			if (reason) throw new SubagentModelSelectionError(task.id, `Explicit model override rejected: ${reason}.`);
		} else {
			candidates = candidates.filter((ref) => {
				if (!economyBlockReason(ref, frontier)) return true;
				economyBlocked.push(ref);
				return false;
			});
		}
	}

	if (parentProviderPolicy === "prefer-other" && !explicitModel) {
		candidates = applyVendorPolicy(candidates, "prefer-other", parentModelRef, frontier);
	}
	if (parentProviderPolicy === "require-other") {
		if (hasProviderArg(extraArgs)) {
			throw new SubagentModelSelectionError(task.id, "--provider cannot be combined with cross-vendor selection; use a provider/model reference.");
		}
		if (explicitModel && applyVendorPolicy([explicitModel], "require-other", parentModelRef, frontier).length === 0) {
			throw new SubagentModelSelectionError(task.id, `Explicit model override ${explicitModel} shares the parent's vendor (${parentVendor}); cross-vendor selection is required.`);
		}
		candidates = applyVendorPolicy(candidates, "require-other", parentModelRef, frontier);
		if (candidates.length === 0) {
			throw new SubagentModelSelectionError(task.id, `No model from a vendor other than the parent's (${parentVendor}) is available in the configured candidates/overrides${economyNote(economyBlocked)}.`);
		}
	}
	if (candidates.length === 0) {
		throw new SubagentModelSelectionError(task.id, economyBlocked.length > 0
			? `No model candidates remain${economyNote(economyBlocked)}.`
			: "No model candidates are configured; set models on the agent profile.");
	}
	const [model, ...fallbackModels] = candidates;
	const timeoutMs = task.timeoutMs ?? globalOptions.timeoutMs ?? profile?.timeoutMs ?? config.timeoutMs;

	return {
		profile,
		extraArgs,
		fallbackModels,
		retry: resolveRetryConfig(config.retry, profile?.retry),
		maxResultBytes: profile?.maxResultBytes ?? config.maxResultBytes,
		timeoutMs,
		task: {
			...task,
			subagentType: selectedType,
			model,
			thinking: trimString(globalOptions.thinking) || trimString(task.thinking) || trimString(globalOptions.defaultThinking) || trimString(profile?.thinking),
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
	const configured = normalizeSubagentType(config.defaultType, config);
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
	if (typeof model === "string") return trimString(model);
	if (!isRecord(model)) return undefined;
	const id = trimString(model.modelId) || trimString(model.id) || trimString(model.model) || trimString(model.name);
	if (!id) return undefined;
	const provider = trimString(model.provider) || trimString(model.providerId);
	// Ids may contain slashes themselves (OpenRouter "openai/gpt-..."); keep the
	// serving provider unless the id is already qualified with it.
	return provider && !id.toLowerCase().startsWith(`${provider.toLowerCase()}/`) ? `${provider}/${id}` : id;
}

export function isBlindModelRef(modelRef: string | undefined, config: SubagentConfig): boolean {
	if (!modelRef) return false;
	return matchesAnyModelPattern(modelRef, config.vision?.blindModelPatterns ?? []);
}

/** Whether one role is available to the current parent model. Deny wins. */
export function isSubagentTypeAvailableForParent(
	profile: SubagentTypeConfig,
	parentModelRef: string | undefined,
	frontier: FrontierConfig = defaultFrontierConfig(),
): boolean {
	// An unknown parent cannot be classified; keep the role visible as before.
	if (profile.forParentTier && parentModelRef) {
		const parentIsFrontier = isFrontierModel(parentModelRef, frontier);
		if ((profile.forParentTier === "frontier") !== parentIsFrontier) return false;
	}
	const included = profile.forParentModels;
	if (included !== undefined) {
		if (!parentModelRef || !matchesAnyModelPattern(parentModelRef, included)) return false;
	}
	const excluded = profile.notForParentModels;
	if (parentModelRef && excluded !== undefined && matchesAnyModelPattern(parentModelRef, excluded)) return false;
	return true;
}

/**
 * Return the effective config visible to a particular parent model. Only the
 * role catalog is filtered; routing policy, retry defaults, and other global
 * settings are preserved unchanged.
 */
export function filterSubagentConfigForParentModel(
	config: SubagentConfig,
	parentModelRef: string | undefined,
): SubagentConfig {
	const frontier = frontierConfigOf(config);
	const types = Object.fromEntries(
		Object.entries(config.types).filter(([name, profile]) => isSubagentTypeAvailableForParent(profile, parentModelRef, frontier)
			&& crossVendorRoleCanResolve(name, config, parentModelRef)),
	);
	return Object.keys(types).length === Object.keys(config.types).length ? config : { ...config, types };
}

export function selectSubagentType(task: AgentTask, config: SubagentConfig): string | undefined {
	const explicit = normalizeSubagentType(task.subagentType, config);
	if (explicit) return explicit;
	return defaultSubagentType(config);
}

/** Preserve explicit legacy browser-qa calls after the built-in role was broadened to ui-qa. */
export function normalizeSubagentType(value: string | undefined, config: SubagentConfig): string | undefined {
	const requested = trimString(value);
	if (!requested) return undefined;
	if (Object.prototype.hasOwnProperty.call(config.types, requested)) return requested;
	if (requested === LEGACY_BROWSER_QA_TYPE && Object.prototype.hasOwnProperty.call(config.types, UI_QA_TYPE)) return UI_QA_TYPE;
	return requested;
}

/**
 * Roles that must run on another vendor are hidden when static configuration
 * already proves no candidate can qualify (unknown parent, economy, or an
 * all-same-vendor list). Runtime availability is still checked at spawn.
 */
function crossVendorRoleCanResolve(name: string, config: SubagentConfig, parentModelRef: string | undefined): boolean {
	const policy = config.types[name]?.parentProviderPolicy;
	if (policy !== "require-other" && policy !== "require-other-if-frontier") return true;
	try {
		resolveAgentTaskConfig({ id: "catalog", task: "", subagentType: name }, config, { parentModel: parentModelRef });
		return true;
	} catch (error) {
		if (error instanceof SubagentModelSelectionError) return false;
		throw error;
	}
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
	const modelSelection = normalizeModelSelection(rawProfile.modelSelection, name, file);
	if (modelSelection && (models !== undefined || rawProfile.model !== undefined || rawProfile.fallbackModels !== undefined || rawProfile.modelByParent !== undefined)) {
		throw new Error(`Agent ${name}: modelSelection: ${modelSelection} conflicts with models/model/fallbackModels/modelByParent (${file})`);
	}
	const model = models === undefined ? trimString(rawProfile.model) : undefined;
	const fallbackModels = models === undefined ? modelList(rawProfile.fallbackModels, rawProfile.fallbackModel) : undefined;
	const parentProviderPolicy = normalizeParentProviderPolicy(rawProfile.parentProviderPolicy, name, file);
	const requireDifferentProvider = rawProfile.requireDifferentProvider;
	if (requireDifferentProvider !== undefined && typeof requireDifferentProvider !== "boolean") {
		throw new Error(`Agent ${name}: requireDifferentProvider must be a boolean (${file})`);
	}
	if (parentProviderPolicy && requireDifferentProvider === true && parentProviderPolicy !== "require-other") {
		throw new Error(`Agent ${name}: requireDifferentProvider conflicts with parentProviderPolicy (${file})`);
	}
	return {
		description: trimString(rawProfile.description),
		icon: trimString(rawProfile.icon),
		models,
		modelSelection,
		model,
		fallbackModels: models === undefined && (model || fallbackModels !== undefined) ? fallbackModels ?? [] : undefined,
		modelByParent: models === undefined ? normalizeModelByParent(rawProfile.modelByParent, name, file, fallbackModels ?? []) : undefined,
		forParentModels: normalizeParentModelPatterns(rawProfile.forParentModels, "forParentModels", name, file),
		notForParentModels: normalizeParentModelPatterns(rawProfile.notForParentModels, "notForParentModels", name, file),
		forParentTier: normalizeParentTier(rawProfile.forParentTier, name, file),
		parentProviderPolicy: parentProviderPolicy ?? (requireDifferentProvider ? "require-other" : undefined),
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

function mergeConfig(target: SubagentConfig, source: Partial<SubagentConfig>): void {
	for (const [name, profile] of Object.entries(source.types ?? {})) {
		target.types[name] = mergeTypeProfile(target.types[name] ?? {}, profile);
	}
}

/** Preserve legacy field overrides without allowing inherited primary models
 * to win over a newly supplied candidate list (or the reverse). */
function mergeTypeProfile(base: SubagentTypeConfig, source: SubagentTypeConfig): SubagentTypeConfig {
	const merged = { ...compactProfile(base), ...compactProfile(source) };
	// An explicit candidate list replaces frontier-list selection (and vice versa).
	if (source.modelSelection === undefined && (source.models !== undefined || source.model || source.fallbackModels !== undefined || source.modelByParent)) {
		delete merged.modelSelection;
	}
	if (source.modelSelection !== undefined) {
		delete merged.models;
		delete merged.model;
		delete merged.fallbackModels;
		delete merged.modelByParent;
	} else if (source.models !== undefined) {
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
	if (profile.modelSelection !== undefined) compact.modelSelection = profile.modelSelection;
	if (profile.model) compact.model = profile.model;
	if (profile.fallbackModels) compact.fallbackModels = profile.fallbackModels;
	if (profile.modelByParent) compact.modelByParent = profile.modelByParent;
	if (profile.forParentModels !== undefined) compact.forParentModels = profile.forParentModels;
	if (profile.notForParentModels !== undefined) compact.notForParentModels = profile.notForParentModels;
	if (profile.forParentTier !== undefined) compact.forParentTier = profile.forParentTier;
	if (profile.parentProviderPolicy !== undefined) compact.parentProviderPolicy = profile.parentProviderPolicy;
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

function normalizeModels(value: unknown, owner: string, file: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((ref) => typeof ref !== "string" || !/^[^\s/*]+\/[^\s*]+$/.test(ref.trim()))) {
		throw new Error(`Subagent ${owner} models must be an array of provider/model references: ${file}`);
	}
	return [...new Set(value.map((ref: string) => ref.trim()))];
}

function normalizeParentModelPatterns(
	value: unknown,
	field: "forParentModels" | "notForParentModels",
	typeName: string,
	file: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((pattern) => typeof pattern !== "string" || !pattern.trim())) {
		throw new Error(`Subagent type "${typeName}" ${field} must be an array of non-empty model patterns: ${file}`);
	}
	return [...new Set(value.map((pattern: string) => pattern.trim()))];
}

function normalizeParentProviderPolicy(value: unknown, typeName: string, file: string): SubagentTypeConfig["parentProviderPolicy"] {
	if (value === undefined) return undefined;
	if (value === "any" || value === "prefer-other" || value === "require-other" || value === "require-other-if-frontier") return value;
	throw new Error(`Subagent type "${typeName}" parentProviderPolicy must be one of any, prefer-other, require-other, require-other-if-frontier: ${file}`);
}

function normalizeModelSelection(value: unknown, typeName: string, file: string): SubagentTypeConfig["modelSelection"] {
	if (value === undefined) return undefined;
	if (value === "frontier") return value;
	throw new Error(`Subagent type "${typeName}" modelSelection must be frontier: ${file}`);
}

function normalizeParentTier(value: unknown, typeName: string, file: string): SubagentTypeConfig["forParentTier"] {
	if (value === undefined) return undefined;
	if (value === "frontier" || value === "non-frontier") return value;
	throw new Error(`Subagent type "${typeName}" forParentTier must be frontier or non-frontier: ${file}`);
}

function normalizeModelByParent(
	value: unknown,
	typeName: string,
	file: string,
	defaultFallbackModels: string[] = [],
): Record<string, ModelByParentEntry> | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) throw new Error(`Subagent type "${typeName}" modelByParent must be an object: ${file}`);
	const out: Record<string, ModelByParentEntry> = {};
	for (const [pattern, raw] of Object.entries(value)) {
		const pat = trimString(pattern);
		if (!pat) continue;
		if (typeof raw === "string") {
			const model = trimString(raw);
			if (model) out[pat] = { model, fallbackModels: [...defaultFallbackModels] };
			continue;
		}
		if (isRecord(raw)) {
			const model = trimString(raw.model);
			if (!model) throw new Error(`Subagent type "${typeName}" modelByParent["${pat}"].model must be a non-empty string: ${file}`);
			const hasFallbackOverride = Object.prototype.hasOwnProperty.call(raw, "fallbackModels")
				|| Object.prototype.hasOwnProperty.call(raw, "fallbackModel");
			out[pat] = {
				model,
				fallbackModels: hasFallbackOverride
					? modelList(raw.fallbackModels, raw.fallbackModel) ?? []
					: [...defaultFallbackModels],
			};
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
	profileModels: string[];
	profile?: SubagentTypeConfig;
}): string[] {
	const fallbacks = options.profile?.fallbackModels ?? options.profileModels.slice(1);
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

/** Collapse `require-other-if-frontier` to a concrete policy for this parent. */
function effectiveParentProviderPolicy(
	profile: SubagentTypeConfig | undefined,
	parentModelRef: string | undefined,
	frontier: FrontierConfig,
): Exclude<ParentProviderPolicy, "require-other-if-frontier"> {
	const policy = profile?.parentProviderPolicy ?? (profile?.requireDifferentProvider ? "require-other" : "any");
	if (policy !== "require-other-if-frontier") return policy;
	// Unknown parents cannot be classified, so the strict branch fails closed.
	return !parentModelRef || isFrontierModel(parentModelRef, frontier) ? "require-other" : "prefer-other";
}

function profileCandidateModels(profile: SubagentTypeConfig | undefined, role: string | undefined, frontier: FrontierConfig): string[] {
	if (profile?.models) return profile.models;
	if (profile?.modelSelection === "frontier") return frontierCandidatesForRole(role, frontier);
	return modelList(profile?.model, profile?.fallbackModels) ?? [];
}

function frontierConfigOf(config: SubagentConfig): FrontierConfig {
	return config.frontier ?? defaultFrontierConfig();
}

function hasProviderArg(args: string[]): boolean {
	return args.some((arg) => arg === "--provider" || arg.startsWith("--provider="));
}

function economyNote(blocked: string[]): string {
	return blocked.length > 0 ? ` (economy mode excluded ${blocked.join(", ")})` : "";
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
