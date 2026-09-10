import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { applyEdits, modify, parse } from "jsonc-parser";
import {
	appIconThemeFromFallbackFlag,
	appIconThemeOverrideFromEnv,
	parseAppIconThemeName,
	resolveAppIconThemeNameFromEnv,
	type AppIconThemeName,
} from "./icon-theme.js";
import { DEFAULT_PIX_CONFIG_JSONC } from "./default-pix-config.js";

export type ToolRendererRule = {
	previewLines?: number;
	direction?: "head" | "tail";
	color?: string;
	defaultExpanded?: boolean;
	compactHidden?: boolean;
	hidden?: boolean;
};

export type ResolvedToolRule = {
	previewLines: number;
	direction: "head" | "tail";
	color: string;
	defaultExpanded?: boolean;
	compactHidden?: boolean;
	hidden?: boolean;
};

export type ToolRendererConfig = {
	default: ToolRendererRule;
	tools: Record<string, ToolRendererRule>;
};

export type OutputFiltersConfig = {
	patterns: string[];
};

export type PromptEnhancerConfig = {
	modelRef: string;
	fallbackModels: string[];
};

export type AutocompleteConfig = {
	/** Empty string disables inline LLM autocomplete. */
	modelRef: string;
	/** Ordered model fallbacks tried after modelRef. */
	fallbackModels: string[];
	/** Delay after typing before asking the model. */
	debounceMs: number;
	/** Hard timeout for a best-effort completion request. */
	timeoutMs: number;
	/** Maximum output tokens requested from the provider. */
	maxTokens: number;
	/** Approximate maximum input prompt tokens, including system prompt and optional history. */
	maxPromptTokens: number;
	/** Number of recent active-session user/assistant messages to include as context. */
	includeRecentMessages: number;
};

export type DefaultModelConfig = {
	modelRef: string;
	fallbackModels: string[];
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

export type ModelColorsConfig = {
	rules: Record<string, string>;
};

export type IconThemeConfig = {
	name: AppIconThemeName;
};

export type DictationLanguageModelConfig = {
	label: string;
	/** Deepgram language code. Defaults to the language map key. */
	deepgramLanguage?: string;
	/** Deprecated Vosk model fields kept only for config compatibility. */
	dirName?: string;
	url?: string;
};

export type DictationConfig = {
	languages: Record<string, DictationLanguageModelConfig>;
	language?: string;
	model?: string;
	/** Long-lived Deepgram API key. Prefer the user config, not project config. */
	apiKey?: string;
};

export type PixConfig = {
	toolRenderer: ToolRendererConfig;
	outputFilters: OutputFiltersConfig;
	defaultModel?: DefaultModelConfig;
	/** User-level whitelist for model pickers. Undefined means show every available model. */
	visibleModels?: string[];
	promptEnhancer: PromptEnhancerConfig;
	autocomplete: AutocompleteConfig;
	modelColors: ModelColorsConfig;
	iconTheme: IconThemeConfig;
	dictation: DictationConfig;
	ignoreContextFiles: boolean;
	maxProjectSessions: number;
};

const PIX_SCHEMA_URL = "https://unpkg.com/pi-ui-extend/schemas/pix.json";

export function getPixConfigPath(homeDir = homedir()): string {
	return join(homeDir, ".config", "pi", "pix.jsonc");
}

export function getProjectPixConfigPath(cwd: string): string {
	return join(cwd, ".pi", "pix.jsonc");
}

const PIX_CONFIG_PATH = getPixConfigPath();

const DEFAULT_TOOL_RENDERER: ToolRendererConfig = {
	default: {
		previewLines: 0,
		direction: "head",
		color: "toolTitle",
	},
	tools: {
		thinking: { previewLines: 0, direction: "head", color: "assistantForeground" },
		bash: { previewLines: 6, direction: "tail", color: "warning" },
		Bash: { previewLines: 6, direction: "tail", color: "warning" },
		shell: { previewLines: 6, direction: "tail", color: "warning" },
		shell_command: { previewLines: 6, direction: "tail", color: "warning" },
		"repo_*": { previewLines: 6, direction: "head", color: "warning" },
		apply_patch: { previewLines: 9999, direction: "head", color: "toolMutation", defaultExpanded: true },
		edit: { previewLines: 9999, direction: "head", color: "toolMutation", defaultExpanded: true },
		Edit: { previewLines: 9999, direction: "head", color: "toolMutation", defaultExpanded: true },
		write: { previewLines: 9999, direction: "head", color: "toolMutation", defaultExpanded: true },
		Write: { previewLines: 9999, direction: "head", color: "toolMutation", defaultExpanded: true },
		ast_apply: { previewLines: 9999, direction: "head", color: "toolMutation", defaultExpanded: true },
		Read: { previewLines: 0, direction: "head", color: "success" },
		read: { previewLines: 0, direction: "head", color: "success" },
		ast_grep: { previewLines: 6, direction: "head", color: "toolSearch" },
		compress: { previewLines: 0, direction: "head", color: "info" },
		web_search: { previewLines: 6, direction: "tail", color: "toolSearch" },
		web_fetch: { previewLines: 12, direction: "tail", color: "toolSearch" },
		question: { previewLines: 6, direction: "tail", color: "accent" },
		subagents: { previewLines: 0, direction: "tail", color: "muted" },
		todo: { hidden: true, color: "accent" },
		ls: { color: "success" },
		LS: { color: "success" },
		grep: { color: "toolSearch" },
		Grep: { color: "toolSearch" },
		find: { color: "toolSearch" },
		Glob: { color: "toolSearch" },
		"ast_*": { color: "toolSearch" },
		skill: { previewLines: 0, color: "toolSearch" },
	},
};

const DEFAULT_OUTPUT_FILTERS: OutputFiltersConfig = {
	patterns: [],
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ConfigThinkingLevel = (typeof THINKING_LEVELS)[number];

const DEFAULT_PROMPT_ENHANCER: PromptEnhancerConfig = {
	modelRef: "openai-codex/gpt-5.6-luna",
	fallbackModels: [],
};

const DEFAULT_AUTOCOMPLETE: AutocompleteConfig = {
	modelRef: "zai/glm-5-turbo",
	fallbackModels: [],
	debounceMs: 350,
	timeoutMs: 3000,
	maxTokens: 48,
	maxPromptTokens: 1200,
	includeRecentMessages: 0,
};

const DEFAULT_MODEL_COLORS: ModelColorsConfig = {
	rules: {
		"zai/*": "success",
		"openai-codex/*": "modelOpenAI",
		"antigravity/*": "warning",
		"antigravity/antigravity-claude-*": "error",
	},
};

const DEFAULT_DICTATION: DictationConfig = {
	language: "en",
	model: "nova-3",
	languages: {
		en: {
			label: "English",
			deepgramLanguage: "en",
		},
		ru: {
			label: "Russian",
			deepgramLanguage: "ru",
		},
	},
};

function parseJsonc(text: string): unknown {
	return parse(text, undefined, { allowTrailingComma: true });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractToolRendererConfig(raw: unknown): ToolRendererConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const tr = raw.toolRenderer;
	if (!isPlainObject(tr)) return undefined;

	const defaultRule = extractToolRendererRule(tr.default);
	const tools: Record<string, ToolRendererRule> = {};

	if (isPlainObject(tr.tools)) {
		for (const [key, value] of Object.entries(tr.tools)) {
			const rule = extractToolRendererRule(value);
			if (rule) tools[key] = rule;
		}
	}

	return {
		default: defaultRule ?? DEFAULT_TOOL_RENDERER.default,
		tools,
	};
}

function extractOutputFiltersConfig(raw: unknown): OutputFiltersConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const filters = raw.outputFilters;
	if (!isPlainObject(filters)) return undefined;

	const configuredPatterns = filters.patterns ?? filters.samples;
	const patterns = Array.isArray(configuredPatterns)
		? configuredPatterns.filter((pattern): pattern is string => typeof pattern === "string" && pattern.trim().length > 0)
		: undefined;

	return patterns ? { patterns } : undefined;
}

function extractPromptEnhancerConfig(raw: unknown): PromptEnhancerConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const enhancer = raw.promptEnhancer;
	if (!isPlainObject(enhancer)) return undefined;

	const modelRef = nonEmptyString(enhancer.modelRef) ?? nonEmptyString(enhancer.model);

	return modelRef ? { modelRef, fallbackModels: modelFallbackList(enhancer.fallbackModels) } : undefined;
}

function extractAutocompleteConfig(raw: unknown): AutocompleteConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const autocomplete = raw.autocomplete ?? raw.autoComplete;
	if (typeof autocomplete === "string") return { ...DEFAULT_AUTOCOMPLETE, fallbackModels: [], modelRef: autocomplete.trim() };
	if (!isPlainObject(autocomplete)) return undefined;

	const modelRef = autocompleteModelRef(autocomplete);
	return {
		...DEFAULT_AUTOCOMPLETE,
		...(modelRef === undefined ? {} : { modelRef }),
		fallbackModels: modelFallbackList(autocomplete.fallbackModels),
		debounceMs: numberInRange(autocomplete.debounceMs, DEFAULT_AUTOCOMPLETE.debounceMs, 100, 2_000),
		timeoutMs: numberInRange(autocomplete.timeoutMs, DEFAULT_AUTOCOMPLETE.timeoutMs, 250, 10_000),
		maxTokens: numberInRange(autocomplete.maxTokens, DEFAULT_AUTOCOMPLETE.maxTokens, 8, 256),
		maxPromptTokens: numberInRange(autocomplete.maxPromptTokens, DEFAULT_AUTOCOMPLETE.maxPromptTokens, 256, 16_000),
		includeRecentMessages: numberInRange(
			autocomplete.includeRecentMessages ?? autocomplete.recentMessages,
			DEFAULT_AUTOCOMPLETE.includeRecentMessages,
			0,
			20,
		),
	};
}

function autocompleteModelRef(autocomplete: Record<string, unknown>): string | undefined {
	if (typeof autocomplete.modelRef === "string") return autocomplete.modelRef.trim();
	if (typeof autocomplete.model === "string") return autocomplete.model.trim();
	return undefined;
}

function extractDefaultModelConfig(raw: unknown): DefaultModelConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const configured = raw.defaultModel ?? raw.modelDefault;

	if (typeof configured === "string") {
		return normalizeDefaultModelRef(configured);
	}

	if (!isPlainObject(configured)) return undefined;
	const modelRef = nonEmptyString(configured.modelRef) ?? nonEmptyString(configured.model);
	if (!modelRef) return undefined;

	const normalizedModel = normalizeDefaultModelRef(modelRef);
	if (!normalizedModel) return undefined;

	const thinking = normalizeDefaultThinking(configured.thinking)
		?? normalizeDefaultThinking(configured.thinkingLevel)
		?? normalizedModel.thinking;
	return {
		modelRef: normalizedModel.modelRef,
		fallbackModels: modelFallbackList(configured.fallbackModels),
		...(thinking === undefined ? {} : { thinking }),
	};
}

function extractVisibleModelsConfig(raw: unknown): string[] | undefined {
	if (!isPlainObject(raw) || !Array.isArray(raw.visibleModels)) return undefined;
	return [...new Set(raw.visibleModels
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean))];
}

function extractModelColorsConfig(raw: unknown): ModelColorsConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const modelColors = raw.modelColors;
	if (!isPlainObject(modelColors)) return undefined;

	const source = isPlainObject(modelColors.rules) ? modelColors.rules : modelColors;
	const rules: Record<string, string> = {};
	for (const [pattern, color] of Object.entries(source)) {
		if (pattern === "rules" || typeof color !== "string") continue;
		const trimmedPattern = pattern.trim();
		const trimmedColor = color.trim();
		if (trimmedPattern.length > 0 && trimmedColor.length > 0) rules[trimmedPattern] = trimmedColor;
	}

	return Object.keys(rules).length > 0 ? { rules } : undefined;
}

function extractIconThemeConfig(raw: unknown): IconThemeConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const iconTheme = raw.iconTheme ?? raw.icons;

	const directTheme = parseAppIconThemeName(iconTheme) ?? appIconThemeFromFallbackFlag(iconTheme);
	if (directTheme) return { name: directTheme };

	if (!isPlainObject(iconTheme)) return undefined;
	const configuredTheme = parseAppIconThemeName(iconTheme.name)
		?? parseAppIconThemeName(iconTheme.theme)
		?? appIconThemeFromFallbackFlag(iconTheme.useFallback)
		?? appIconThemeFromFallbackFlag(iconTheme.fallback);

	return configuredTheme ? { name: configuredTheme } : undefined;
}

function extractDictationConfig(
	raw: unknown,
	fallback: DictationConfig,
	options: { allowApiKey?: boolean } = {},
): DictationConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const dictation = raw.dictation ?? raw.voiceInput ?? raw.voice;
	if (!isPlainObject(dictation)) return undefined;

	const configuredLanguages = dictation.languages ?? dictation.models;
	const replacesLanguages = isPlainObject(configuredLanguages);
	let languages = fallback.languages;
	if (replacesLanguages) {
		const parsedLanguages: Record<string, DictationLanguageModelConfig> = {};
		for (const [rawKey, value] of Object.entries(configuredLanguages)) {
			const key = rawKey.trim().toLowerCase();
			if (!key || !isPlainObject(value)) continue;

			const label = nonEmptyString(value.label) ?? key.toUpperCase();
			const deepgramLanguage = nonEmptyString(value.deepgramLanguage)
				?? nonEmptyString(value.language)
				?? key;
			const dirName = nonEmptyString(value.dirName) ?? nonEmptyString(value.model) ?? nonEmptyString(value.modelDir);
			const url = nonEmptyString(value.url);

			parsedLanguages[key] = {
				label,
				deepgramLanguage,
				...(dirName ? { dirName } : {}),
				...(url ? { url } : {}),
			};
		}
		if (Object.keys(parsedLanguages).length > 0) languages = parsedLanguages;
	}

	const configuredLanguage = normalizeDictationLanguage(dictation.language)
		?? normalizeDictationLanguage(dictation.selectedLanguage)
		?? normalizeDictationLanguage(dictation.currentLanguage);
	const selectedLanguage = configuredLanguage && languages[configuredLanguage]
		? configuredLanguage
		: !replacesLanguages && fallback.language && languages[fallback.language]
			? fallback.language
			: undefined;
	const configuredModel = nonEmptyString(dictation.model) ?? nonEmptyString(dictation.deepgramModel);
	const model = configuredModel ?? (replacesLanguages ? undefined : fallback.model);
	const apiKey = options.allowApiKey === false
		? fallback.apiKey
		: nonEmptyString(dictation.apiKey) ?? nonEmptyString(dictation.deepgramApiKey) ?? fallback.apiKey;

	return Object.keys(languages).length > 0 ? {
		...(selectedLanguage === undefined ? {} : { language: selectedLanguage }),
		...(model === undefined ? {} : { model }),
		...(apiKey === undefined ? {} : { apiKey }),
		languages,
	} : undefined;
}

function extractIgnoreContextFiles(raw: unknown): boolean | undefined {
	if (!isPlainObject(raw)) return undefined;
	return typeof raw.ignoreContextFiles === "boolean" ? raw.ignoreContextFiles : undefined;
}

function extractMaxProjectSessions(raw: unknown): number | undefined {
	if (!isPlainObject(raw)) return undefined;
	if (typeof raw.maxProjectSessions !== "number" || !Number.isFinite(raw.maxProjectSessions)) return undefined;
	return Math.max(0, Math.floor(raw.maxProjectSessions));
}

function normalizeDictationLanguage(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeThinkingLevel(value: unknown): ConfigThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return THINKING_LEVELS.includes(normalized as ConfigThinkingLevel) ? normalized as ConfigThinkingLevel : undefined;
}

function normalizeDefaultThinking(value: unknown): ConfigThinkingLevel | undefined {
	return normalizeThinkingLevel(value);
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function modelFallbackList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean))];
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	return Math.min(max, Math.max(min, rounded));
}

export function defaultPixConfig(): PixConfig {
	return {
		toolRenderer: cloneToolRendererConfig(DEFAULT_TOOL_RENDERER),
		outputFilters: { patterns: [...DEFAULT_OUTPUT_FILTERS.patterns] },
		promptEnhancer: { ...DEFAULT_PROMPT_ENHANCER, fallbackModels: [...DEFAULT_PROMPT_ENHANCER.fallbackModels] },
		autocomplete: { ...DEFAULT_AUTOCOMPLETE, fallbackModels: [...DEFAULT_AUTOCOMPLETE.fallbackModels] },
		modelColors: { rules: { ...DEFAULT_MODEL_COLORS.rules } },
		iconTheme: { name: resolveAppIconThemeNameFromEnv() },
		dictation: cloneDictationConfig(DEFAULT_DICTATION),
		ignoreContextFiles: false,
		maxProjectSessions: 0,
	};
}

function cloneToolRendererConfig(config: ToolRendererConfig): ToolRendererConfig {
	return {
		default: { ...config.default },
		tools: Object.fromEntries(Object.entries(config.tools).map(([name, rule]) => [name, { ...rule }])),
	};
}

function cloneDictationConfig(config: DictationConfig): DictationConfig {
	return {
		languages: Object.fromEntries(Object.entries(config.languages).map(([language, model]) => [language, { ...model }])),
		...(config.language === undefined ? {} : { language: config.language }),
		...(config.model === undefined ? {} : { model: config.model }),
		...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
	};
}

function pixConfigFromParsed(
	parsed: unknown,
	fallback: PixConfig = defaultPixConfig(),
	options: { allowDictationApiKey?: boolean; allowVisibleModels?: boolean } = {},
): PixConfig {
	const toolRenderer = extractToolRendererConfig(parsed) ?? fallback.toolRenderer;
	const outputFilters = extractOutputFiltersConfig(parsed) ?? fallback.outputFilters;
	const defaultModel = extractDefaultModelConfig(parsed) ?? fallback.defaultModel;
	const visibleModels = options.allowVisibleModels === false
		? fallback.visibleModels
		: extractVisibleModelsConfig(parsed) ?? fallback.visibleModels;
	const promptEnhancer = extractPromptEnhancerConfig(parsed) ?? fallback.promptEnhancer;
	const autocomplete = extractAutocompleteConfig(parsed) ?? fallback.autocomplete;
	const modelColors = extractModelColorsConfig(parsed) ?? fallback.modelColors;
	const configuredIconTheme = extractIconThemeConfig(parsed) ?? fallback.iconTheme;
	const iconTheme = { name: appIconThemeOverrideFromEnv() ?? configuredIconTheme.name } satisfies IconThemeConfig;
	const dictation = extractDictationConfig(parsed, fallback.dictation, {
		allowApiKey: options.allowDictationApiKey ?? true,
	}) ?? fallback.dictation;
	const ignoreContextFiles = extractIgnoreContextFiles(parsed) ?? fallback.ignoreContextFiles;
	const maxProjectSessions = extractMaxProjectSessions(parsed) ?? fallback.maxProjectSessions;
	return {
		toolRenderer,
		outputFilters,
		...(defaultModel === undefined ? {} : { defaultModel }),
		...(visibleModels === undefined ? {} : { visibleModels: [...visibleModels] }),
		promptEnhancer,
		autocomplete,
		modelColors,
		iconTheme,
		dictation,
		ignoreContextFiles,
		maxProjectSessions,
	};
}

export function resolveDefaultModelRef(config: PixConfig): string | undefined {
	const modelRef = config.defaultModel?.modelRef.trim();
	if (!modelRef) return undefined;

	const thinking = config.defaultModel?.thinking;
	if (!thinking) return stripThinkingSuffix(modelRef);

	return `${stripThinkingSuffix(modelRef)}:${thinking}`;
}

export function savePixDefaultModel(modelRef: string): DefaultModelConfig | undefined {
	const normalized = normalizeDefaultModelRef(modelRef);
	if (!normalized) return undefined;

	const configPath = PIX_CONFIG_PATH;
	const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : "{\n}\n";
	const updated = upsertPixDefaultModelInJsonc(source, modelRef);
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, updated);
	return extractDefaultModelConfig(parseJsonc(updated));
}

export function savePixDefaultThinking(thinking: string, fallbackModelRef?: string): DefaultModelConfig | undefined {
	const normalizedThinking = normalizeDefaultThinking(thinking);
	if (!normalizedThinking) return undefined;

	const configPath = PIX_CONFIG_PATH;
	const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : "{\n}\n";
	const updated = upsertPixDefaultThinkingInJsonc(source, normalizedThinking, fallbackModelRef);
	const defaultModel = extractDefaultModelConfig(parseJsonc(updated));
	if (!defaultModel) return undefined;

	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, updated);
	return defaultModel;
}

export function savePixAutocompleteModel(modelRef: string): AutocompleteConfig {
	const configPath = PIX_CONFIG_PATH;
	const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : "{\n}\n";
	const updated = upsertPixAutocompleteModelInJsonc(source, modelRef);
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, updated);
	return extractAutocompleteConfig(parseJsonc(updated)) ?? { ...DEFAULT_AUTOCOMPLETE, modelRef: modelRef.trim() };
}

export function savePixVisibleModels(modelRefs: readonly string[]): string[] {
	const configPath = PIX_CONFIG_PATH;
	const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : "{\n}\n";
	const normalized = normalizeVisibleModelRefs(modelRefs);
	const updated = upsertPixVisibleModelsInJsonc(source, normalized);
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, updated);
	return extractVisibleModelsConfig(parseJsonc(updated)) ?? normalized;
}

export function saveProjectPixIgnoreContextFiles(cwd: string, ignoreContextFiles: boolean): boolean {
	const configPath = getProjectPixConfigPath(cwd);
	const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : `{
  "$schema": "${PIX_SCHEMA_URL}"
}
`;
	const updated = upsertPixIgnoreContextFilesInJsonc(source, ignoreContextFiles);
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, updated);
	return extractIgnoreContextFiles(parseJsonc(updated)) ?? ignoreContextFiles;
}

export function upsertPixIgnoreContextFilesInJsonc(source: string, ignoreContextFiles: boolean): string {
	const formattingOptions = { insertSpaces: true, tabSize: 2 };
	return applyEdits(source, modify(source, ["ignoreContextFiles"], ignoreContextFiles, { formattingOptions }));
}

export function upsertPixVisibleModelsInJsonc(source: string, modelRefs: readonly string[]): string {
	const formattingOptions = { insertSpaces: true, tabSize: 2 };
	return applyEdits(source, modify(source, ["visibleModels"], normalizeVisibleModelRefs(modelRefs), { formattingOptions }));
}

export function upsertPixDefaultModelInJsonc(source: string, modelRef: string): string {
	const normalized = normalizeDefaultModelRef(modelRef);
	if (!normalized) return source;

	const parsed = parseJsonc(source);
	const current = extractDefaultModelConfig(parsed);
	const thinking = normalized.thinking ?? current?.thinking;
	const next: DefaultModelConfig = {
		modelRef: normalized.modelRef,
		fallbackModels: current?.fallbackModels ?? [],
		...(thinking === undefined ? {} : { thinking }),
	};
	return upsertPixDefaultModelObjectInJsonc(source, parsed, next);
}

export function upsertPixDefaultThinkingInJsonc(source: string, thinking: string, fallbackModelRef?: string): string {
	const normalizedThinking = normalizeDefaultThinking(thinking);
	if (!normalizedThinking) return source;

	const parsed = parseJsonc(source);
	const current = extractDefaultModelConfig(parsed);
	const fallback = fallbackModelRef ? normalizeDefaultModelRef(fallbackModelRef) : undefined;
	const modelRef = current?.modelRef ?? fallback?.modelRef;
	if (!modelRef) return source;

	const next: DefaultModelConfig = {
		modelRef: stripThinkingSuffix(modelRef),
		fallbackModels: current?.fallbackModels ?? fallback?.fallbackModels ?? [],
		thinking: normalizedThinking,
	};
	return upsertPixDefaultModelObjectInJsonc(source, parsed, next);
}

function upsertPixDefaultModelObjectInJsonc(source: string, parsed: unknown, config: DefaultModelConfig): string {
	const formattingOptions = { insertSpaces: true, tabSize: 2 };
	if (!isPlainObject(parsed) || !isPlainObject(parsed.defaultModel)) {
		return applyEdits(source, modify(source, ["defaultModel"], config, { formattingOptions, getInsertionIndex: () => 0 }));
	}

	let updated = applyEdits(source, modify(source, ["defaultModel", "modelRef"], config.modelRef, { formattingOptions }));
	updated = applyEdits(updated, modify(updated, ["defaultModel", "fallbackModels"], config.fallbackModels, { formattingOptions }));
	if (config.thinking !== undefined) {
		updated = applyEdits(updated, modify(updated, ["defaultModel", "thinking"], config.thinking, { formattingOptions }));
	}
	return updated;
}

export function upsertPixAutocompleteModelInJsonc(source: string, modelRef: string): string {
	const formattingOptions = { insertSpaces: true, tabSize: 2 };
	const parsed = parseJsonc(source);
	const current = extractAutocompleteConfig(parsed);
	let updated = applyEdits(source, modify(source, ["autocomplete", "modelRef"], modelRef.trim(), { formattingOptions }));
	updated = applyEdits(updated, modify(updated, ["autocomplete", "fallbackModels"], current?.fallbackModels ?? [], { formattingOptions }));
	return updated;
}

function normalizeDefaultModelRef(modelRef: string): DefaultModelConfig | undefined {
	const trimmed = modelRef.trim();
	if (!trimmed) return undefined;

	const colonIndex = trimmed.lastIndexOf(":");
	if (colonIndex <= 0) return { modelRef: trimmed, fallbackModels: [] };

	const suffix = trimmed.slice(colonIndex + 1);
	const thinking = normalizeDefaultThinking(suffix);
	return thinking
		? { modelRef: trimmed.slice(0, colonIndex), fallbackModels: [], thinking }
		: { modelRef: trimmed, fallbackModels: [] };
}

function normalizeVisibleModelRefs(modelRefs: readonly string[]): string[] {
	return [...new Set(modelRefs.map((entry) => entry.trim()).filter(Boolean))];
}

function stripThinkingSuffix(modelRef: string): string {
	const colonIndex = modelRef.lastIndexOf(":");
	if (colonIndex <= 0) return modelRef;

	const suffix = modelRef.slice(colonIndex + 1);
	return normalizeDefaultThinking(suffix) ? modelRef.slice(0, colonIndex) : modelRef;
}

function extractToolRendererRule(value: unknown): ToolRendererRule | undefined {
	if (!isPlainObject(value)) return undefined;

	const rule: ToolRendererRule = {};
	if (typeof value.previewLines === "number") rule.previewLines = value.previewLines;
	if (value.direction === "head" || value.direction === "tail") rule.direction = value.direction;
	if (typeof value.color === "string") rule.color = value.color;
	if (typeof value.defaultExpanded === "boolean") rule.defaultExpanded = value.defaultExpanded;
	if (value.compactHidden === true) rule.compactHidden = true;
	if (typeof value.hidden === "boolean") rule.hidden = value.hidden;

	return Object.keys(rule).length > 0 ? rule : undefined;
}

function isFileExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error
		&& (error as { code?: unknown }).code === "EEXIST";
}

function ensurePixConfigExists(configPath: string): void {
	if (existsSync(configPath)) return;

	mkdirSync(dirname(configPath), { recursive: true });
	try {
		writeFileSync(configPath, DEFAULT_PIX_CONFIG_JSONC, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if (isFileExistsError(error)) return;
		throw error;
	}
}

export function loadPixConfig(cwd?: string): PixConfig {
	const configPath = PIX_CONFIG_PATH;

	try {
		ensurePixConfigExists(configPath);
	} catch (error) {
		process.stderr.write(`[pix] Failed to create ${configPath}: ${error instanceof Error ? error.message : String(error)}\n`);
		return loadProjectPixConfig(cwd, defaultPixConfig());
	}

	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = parseJsonc(raw);
		return loadProjectPixConfig(cwd, pixConfigFromParsed(parsed));
	} catch (error) {
		process.stderr.write(`[pix] Failed to load ${configPath}: ${error instanceof Error ? error.message : String(error)}\n`);
		return loadProjectPixConfig(cwd, defaultPixConfig());
	}
}

function loadProjectPixConfig(cwd: string | undefined, fallback: PixConfig): PixConfig {
	if (!cwd) return fallback;

	const configPath = getProjectPixConfigPath(cwd);
	if (!existsSync(configPath)) return fallback;

	try {
		const raw = readFileSync(configPath, "utf8");
		return pixConfigFromParsed(parseJsonc(raw), fallback, {
			allowDictationApiKey: false,
			// Model visibility is a user UI preference shared by TUI and Desktop.
			// Project config must not silently fork that picker state.
			allowVisibleModels: false,
		});
	} catch (error) {
		process.stderr.write(`[pix] Failed to load ${configPath}: ${error instanceof Error ? error.message : String(error)}\n`);
		return fallback;
	}
}

export function savePixDictationLanguage(language: string): void {
	const normalizedLanguage = normalizeDictationLanguage(language);
	if (!normalizedLanguage) return;

	const configPath = PIX_CONFIG_PATH;
	const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : "{\n}\n";
	const updated = upsertPixDictationLanguageInJsonc(source, normalizedLanguage);
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, updated);
}

export function upsertPixDictationLanguageInJsonc(source: string, language: string): string {
	const normalizedLanguage = normalizeDictationLanguage(language);
	if (!normalizedLanguage) return source;

	const edits = modify(source, ["dictation", "language"], normalizedLanguage, {
		formattingOptions: { insertSpaces: true, tabSize: 2 },
		getInsertionIndex: (properties) => properties.includes("languages") ? 0 : properties.length,
	});
	return applyEdits(source, edits);
}

export function resolveModelColor(modelRef: string, config: ModelColorsConfig): string | undefined {
	const normalizedModelRef = modelRef.trim().toLowerCase();
	if (!normalizedModelRef) return undefined;

	let bestColor: string | undefined;
	let bestSpecificity = -1;

	for (const [pattern, color] of Object.entries(config.rules)) {
		const normalizedPattern = pattern.trim().toLowerCase();
		if (!normalizedPattern || !globMatch(normalizedPattern, normalizedModelRef)) continue;

		const specificity = normalizedPattern.replace(/\*/gu, "").length;
		if (specificity > bestSpecificity) {
			bestColor = color;
			bestSpecificity = specificity;
		}
	}

	return bestColor;
}

export function compileOutputFilterPatterns(patterns: readonly string[]): RegExp[] {
	return patterns.flatMap((pattern) => compileOutputFilterPattern(pattern));
}

export function applyOutputFilters(text: string, filters: readonly RegExp[]): string {
	if (filters.length === 0 || text.length === 0) return text;

	const lines = text.split("\n");
	const filteredLines: string[] = [];
	let previousLineWasRemoved = false;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const isTrailingLineBreakFromRemovedLine = line.length === 0 && index === lines.length - 1 && previousLineWasRemoved;
		if (isTrailingLineBreakFromRemovedLine) continue;

		const filtered = applyOutputFiltersToLine(line, filters);
		if (filtered !== line && filtered.trim().length === 0) {
			previousLineWasRemoved = true;
			continue;
		}
		filteredLines.push(filtered);
		previousLineWasRemoved = false;
	}

	return filteredLines.join("\n");
}

function applyOutputFiltersToLine(line: string, filters: readonly RegExp[]): string {
	let filtered = line;
	for (const filter of filters) {
		filtered = filtered.replace(filter, "");
	}
	return filtered;
}

function compileOutputFilterPattern(pattern: string): RegExp[] {
	const trimmed = pattern.trim();
	if (!trimmed) return [];

	try {
		const regexLiteral = parseRegexLiteral(trimmed);
		if (regexLiteral) return [regexLiteral];
		return [new RegExp(globPatternSource(trimmed), "g")];
	} catch (error) {
		process.stderr.write(`[pix] Ignoring invalid output filter pattern ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}\n`);
		return [];
	}
}

function parseRegexLiteral(pattern: string): RegExp | undefined {
	if (!pattern.startsWith("/")) return undefined;

	const delimiterIndex = pattern.lastIndexOf("/");
	if (delimiterIndex === 0) return undefined;

	const source = pattern.slice(1, delimiterIndex);
	const flags = pattern.slice(delimiterIndex + 1);
	return new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
}

function globPatternSource(pattern: string): string {
	return pattern.split("*").map(escapeRegex).join("[^\\n]*");
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveToolRule(
	toolName: string,
	config: ToolRendererConfig,
): ResolvedToolRule {
	// Exact match first
	const exact = config.tools[toolName];
	if (exact) {
		const result: ResolvedToolRule = {
			previewLines: exact.previewLines ?? config.default.previewLines ?? 3,
			direction: exact.direction ?? config.default.direction ?? "head",
			color: exact.color ?? config.default.color ?? "muted",
		};
		if (exact.defaultExpanded != null) result.defaultExpanded = exact.defaultExpanded;
		else if (config.default.defaultExpanded != null) result.defaultExpanded = config.default.defaultExpanded;
		if (exact.compactHidden != null) result.compactHidden = exact.compactHidden;
		if (exact.hidden != null) result.hidden = exact.hidden;
		else if (config.default.hidden != null) result.hidden = config.default.hidden;
		return result;
	}

	// Wildcard match (longest pattern wins)
	let bestMatch: ToolRendererRule | undefined;
	let bestLength = -1;

	for (const [pattern, rule] of Object.entries(config.tools)) {
		if (!pattern.includes("*")) continue;
		if (globMatch(pattern, toolName) && pattern.length > bestLength) {
			bestMatch = rule;
			bestLength = pattern.length;
		}
	}

	if (bestMatch) {
		const result: ResolvedToolRule = {
			previewLines: bestMatch.previewLines ?? config.default.previewLines ?? 3,
			direction: bestMatch.direction ?? config.default.direction ?? "head",
			color: bestMatch.color ?? config.default.color ?? "muted",
		};
		if (bestMatch.defaultExpanded != null) result.defaultExpanded = bestMatch.defaultExpanded;
		else if (config.default.defaultExpanded != null) result.defaultExpanded = config.default.defaultExpanded;
		if (bestMatch.compactHidden != null) result.compactHidden = bestMatch.compactHidden;
		if (bestMatch.hidden != null) result.hidden = bestMatch.hidden;
		else if (config.default.hidden != null) result.hidden = config.default.hidden;
		return result;
	}

	const result: ResolvedToolRule = {
		previewLines: config.default.previewLines ?? 3,
		direction: config.default.direction ?? "head",
		color: config.default.color ?? "muted",
	};
	if (config.default.defaultExpanded != null) result.defaultExpanded = config.default.defaultExpanded;
	if (config.default.hidden != null) result.hidden = config.default.hidden;
	return result;
}

function globMatch(pattern: string, name: string): boolean {
	const regexStr = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
	return new RegExp(regexStr).test(name);
}

export function resolveColor(
	colorRef: string,
	themeColors: Record<string, string>,
): string {
	// If it's a theme color name, look it up
	const themeColor = themeColors[colorRef];
	if (themeColor) return themeColor;

	// If it looks like a hex color, return as-is
	if (colorRef.startsWith("#")) return colorRef;

	// Fallback to muted
	return themeColors.muted ?? Object.values(themeColors)[0] ?? colorRef;
}
