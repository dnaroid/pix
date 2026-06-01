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
} from "./app/icons.js";
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
};

export type ModelColorsConfig = {
	rules: Record<string, string>;
};

export type IconThemeConfig = {
	name: AppIconThemeName;
};

export type DictationLanguageModelConfig = {
	dirName: string;
	url: string;
	label: string;
};

export type DictationConfig = {
	languages: Record<string, DictationLanguageModelConfig>;
	language?: string;
};

export type PixConfig = {
	toolRenderer: ToolRendererConfig;
	outputFilters: OutputFiltersConfig;
	promptEnhancer: PromptEnhancerConfig;
	modelColors: ModelColorsConfig;
	iconTheme: IconThemeConfig;
	dictation: DictationConfig;
};

export function getPixConfigPath(homeDir = homedir()): string {
	return join(homeDir, ".config", "pi", "pix.jsonc");
}

const PIX_CONFIG_PATH = getPixConfigPath();

const DEFAULT_TOOL_RENDERER: ToolRendererConfig = {
	default: {
		previewLines: 0,
		direction: "head",
		color: "toolTitle",
	},
	tools: {
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

const DEFAULT_PROMPT_ENHANCER: PromptEnhancerConfig = {
	modelRef: "zai/glm-5-turbo",
};

const DEFAULT_MODEL_COLORS: ModelColorsConfig = {
	rules: {
		"zai/*": "success",
		"openai-codex/*": "modelOpenAI",
		"antigravity/*": "warning",
		"antigravity/antigravity-claude-*": "error",
	},
};

const DEFAULT_ICON_THEME: IconThemeConfig = {
	name: "nerdFont",
};

const DEFAULT_DICTATION: DictationConfig = {
	language: "en",
	languages: {
		en: {
			dirName: "vosk-model-small-en-us-0.15",
			url: "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip",
			label: "English",
		},
		ru: {
			dirName: "vosk-model-small-ru-0.22",
			url: "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip",
			label: "Russian",
		},
	},
};

const DCP_ID_METADATA_SAMPLE = "<dcp-id>m001</dcp-id>";
const DCP_ID_METADATA_PREFIX = "<dcp-id>m";
const DCP_ID_METADATA_SUFFIX = "</dcp-id>";

const DCP_XML_PAIRED_TAG_RE = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi;
const DCP_XML_OPEN_TAG_TO_END_RE = /<dcp[^>]*>[\s\S]*$/gi;
const DCP_XML_UNPAIRED_TAG_RE = /<\/?dcp[^>]*>/gi;
const DCP_MARKDOWN_REFERENCE_RE = /[ \t]*\[dcp(?:-[a-z0-9-]+)?\]:[ \t]*#(?:[ \t]+\([^\n]*\))?[ \t]*/gi;
const DCP_MARKDOWN_REFERENCE_LINE_RE = /^[ \t]*\[dcp(?:-[a-z0-9-]+)?\]:[ \t]*#(?:[ \t]+\([^\n]*\))?[ \t]*$/i;
const DCP_MARKDOWN_REFERENCE_PENDING_RE = /^\[d(?:c(?:p(?:-[a-z0-9-]*)?)?)?(?:\]?(?::[ \t]*#?(?:[ \t]*\([^\)\n]*)?)?)?$/i;
const DCP_XML_METADATA_LINE_RE = /^[ \t]*<dcp[^>]*>(?:[\s\S]*?<\/dcp[^>]*>)?[ \t]*$/i;
const DCP_DISPLAY_QUICK_CHECK_RE = /<\/?d(?:c(?:p)?)?|\[d(?:c(?:p)?)?/i;

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

	return modelRef ? { modelRef } : undefined;
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

function extractDictationConfig(raw: unknown): DictationConfig | undefined {
	if (!isPlainObject(raw)) return undefined;
	const dictation = raw.dictation ?? raw.voiceInput ?? raw.voice;
	if (!isPlainObject(dictation)) return undefined;

	const configuredLanguages = dictation.languages ?? dictation.models;
	if (!isPlainObject(configuredLanguages)) return undefined;

	const languages: Record<string, DictationLanguageModelConfig> = {};
	for (const [rawKey, value] of Object.entries(configuredLanguages)) {
		const key = rawKey.trim().toLowerCase();
		if (!key || !isPlainObject(value)) continue;

		const dirName = nonEmptyString(value.dirName) ?? nonEmptyString(value.model) ?? nonEmptyString(value.modelDir);
		const url = nonEmptyString(value.url);
		const label = nonEmptyString(value.label) ?? key.toUpperCase();
		if (!dirName || !url) continue;

		languages[key] = { dirName, url, label };
	}

	const language = normalizeDictationLanguage(dictation.language)
		?? normalizeDictationLanguage(dictation.selectedLanguage)
		?? normalizeDictationLanguage(dictation.currentLanguage);
	const selectedLanguage = language && languages[language] ? language : undefined;

	return Object.keys(languages).length > 0 ? {
		...(selectedLanguage ? { language: selectedLanguage } : {}),
		languages,
	} : undefined;
}

function normalizeDictationLanguage(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized.length > 0 ? normalized : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function defaultPixConfig(): PixConfig {
	return {
		toolRenderer: DEFAULT_TOOL_RENDERER,
		outputFilters: DEFAULT_OUTPUT_FILTERS,
		promptEnhancer: DEFAULT_PROMPT_ENHANCER,
		modelColors: DEFAULT_MODEL_COLORS,
		iconTheme: { name: resolveAppIconThemeNameFromEnv() },
		dictation: DEFAULT_DICTATION,
	};
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

export function loadPixConfig(): PixConfig {
	const configPath = PIX_CONFIG_PATH;

	try {
		ensurePixConfigExists(configPath);
	} catch (error) {
		process.stderr.write(`[pix] Failed to create ${configPath}: ${error instanceof Error ? error.message : String(error)}\n`);
		return defaultPixConfig();
	}

	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = parseJsonc(raw);
		const toolRenderer = extractToolRendererConfig(parsed) ?? DEFAULT_TOOL_RENDERER;
		const outputFilters = extractOutputFiltersConfig(parsed) ?? DEFAULT_OUTPUT_FILTERS;
		const promptEnhancer = extractPromptEnhancerConfig(parsed) ?? DEFAULT_PROMPT_ENHANCER;
		const modelColors = extractModelColorsConfig(parsed) ?? DEFAULT_MODEL_COLORS;
		const configuredIconTheme = extractIconThemeConfig(parsed) ?? DEFAULT_ICON_THEME;
		const iconTheme = { name: appIconThemeOverrideFromEnv() ?? configuredIconTheme.name } satisfies IconThemeConfig;
		const dictation = extractDictationConfig(parsed) ?? DEFAULT_DICTATION;
		return { toolRenderer, outputFilters, promptEnhancer, modelColors, iconTheme, dictation };
	} catch (error) {
		process.stderr.write(`[pix] Failed to load ${configPath}: ${error instanceof Error ? error.message : String(error)}\n`);
		return defaultPixConfig();
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

export function stripDcpDisplayMetadata(text: string): string {
	if (text.length === 0 || !DCP_DISPLAY_QUICK_CHECK_RE.test(text)) return text;

	let cleaned = stripDcpDisplayMetadataLines(text);

	// Strip fully paired XML-style DCP tags first. During streaming, strip an
	// unterminated opening XML tag and everything after it before removing
	// orphan tags, otherwise `<dcp-id>m123` would leave `m123` behind.
	cleaned = cleaned
		.replace(DCP_XML_PAIRED_TAG_RE, "")
		.replace(DCP_XML_OPEN_TAG_TO_END_RE, "")
		.replace(DCP_XML_UNPAIRED_TAG_RE, "");

	// Hide a partially streamed markdown reference line before the complete-line
	// regex can strip the prefix and strand the `(m123` payload.
	cleaned = suppressPendingDcpIdMetadataLine(cleaned).replace(DCP_MARKDOWN_REFERENCE_RE, "");
	cleaned = suppressPendingDcpIdMetadataLine(cleaned);
	cleaned = stripDcpDisplayMetadataLines(cleaned);
	return cleaned.replace(/\n{3,}/g, "\n\n").trimEnd();
}

function stripDcpDisplayMetadataLines(text: string): string {
	if (text.length === 0) return text;

	let removed = false;
	const keptLines = text.split("\n").filter((line) => {
		const normalizedLine = line.replace(/\r$/u, "");
		const isMetadataLine = DCP_MARKDOWN_REFERENCE_LINE_RE.test(normalizedLine) || DCP_XML_METADATA_LINE_RE.test(normalizedLine);
		if (isMetadataLine) removed = true;
		return !isMetadataLine;
	});

	return removed ? keptLines.join("\n") : text;
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

export function outputFiltersRemoveDcpIdMetadataLine(filters: readonly RegExp[]): boolean {
	return filters.length > 0 && applyOutputFilters(DCP_ID_METADATA_SAMPLE, filters).length === 0;
}

export function suppressPendingDcpIdMetadataLine(text: string): string {
	if (text.length === 0) return text;

	const lineStart = text.lastIndexOf("\n") + 1;
	const line = text.slice(lineStart);
	if (!isPendingDcpIdMetadataLine(line)) return text;

	// Hide the still-streaming metadata line and its line break until it either
	// becomes a complete filtered line or diverges from the metadata prefix.
	return lineStart > 0 ? text.slice(0, lineStart - 1) : "";
}

function isPendingDcpIdMetadataLine(line: string): boolean {
	const candidate = line.trimStart();
	if (candidate.length === 0) return false;
	return isPendingXmlDcpIdMetadataLine(candidate) || isPendingMarkdownDcpMetadataLine(candidate);
}

function isPendingXmlDcpIdMetadataLine(candidate: string): boolean {
	if (DCP_ID_METADATA_PREFIX.startsWith(candidate)) return true;
	if (!candidate.startsWith(DCP_ID_METADATA_PREFIX)) return false;

	const afterPrefix = candidate.slice(DCP_ID_METADATA_PREFIX.length);
	const digits = afterPrefix.match(/^\d*/)?.[0] ?? "";
	const afterDigits = afterPrefix.slice(digits.length);
	if (afterDigits.length === 0) return true;
	return DCP_ID_METADATA_SUFFIX.startsWith(afterDigits) && afterDigits.length < DCP_ID_METADATA_SUFFIX.length;
}

function isPendingMarkdownDcpMetadataLine(candidate: string): boolean {
	if (DCP_MARKDOWN_REFERENCE_LINE_RE.test(candidate)) return false;
	return DCP_MARKDOWN_REFERENCE_PENDING_RE.test(candidate);
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
