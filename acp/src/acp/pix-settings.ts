import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { defaultModelFromParsed, type PixDefaultModel } from "./default-model.js";

export const PIX_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type PixThinkingLevel = typeof PIX_THINKING_LEVELS[number];

export interface PixCommandSettings {
	readonly defaultModel?: PixDefaultModel;
	readonly autocompleteModelRef: string;
}

const formattingOptions = { insertSpaces: true, tabSize: 2 };

export function loadPixCommandSettings(homeDir = homedir()): PixCommandSettings {
	const path = pixConfigPath(homeDir);
	if (!existsSync(path)) return { autocompleteModelRef: "zai/glm-5-turbo" };
	try {
		const parsed = parseJsonc(readFileSync(path, "utf8")) as unknown;
		const configured = defaultModelFromParsed(parsed);
		const defaultModel = configured ? parseModelRef(configured.modelRef) : undefined;
		const autocompleteModelRef = autocompleteModelFromParsed(parsed) ?? "zai/glm-5-turbo";
		return {
			...(configured && defaultModel ? {
				defaultModel: {
					provider: defaultModel.provider,
					modelId: defaultModel.modelId,
					...(configured.thinking === undefined ? {} : { thinkingLevel: configured.thinking }),
				},
			} : {}),
			autocompleteModelRef,
		};
	} catch {
		return { autocompleteModelRef: "zai/glm-5-turbo" };
	}
}

export function savePixDefaultModel(modelRef: string, homeDir = homedir()): string {
	const parsed = parseModelRef(modelRef);
	if (!parsed) throw new Error("Model must use provider/model[:thinking] format");
	const path = pixConfigPath(homeDir);
	let source = readConfigSource(path);
	const current = defaultModelFromParsed(parseJsonc(source) as unknown);
	const next = {
		modelRef: `${parsed.provider}/${parsed.modelId}`,
		...(parsed.thinkingLevel ?? current?.thinking
			? { thinking: parsed.thinkingLevel ?? current?.thinking }
			: {}),
	};
	source = applyEdits(source, modify(source, ["defaultModel"], next, { formattingOptions, getInsertionIndex: () => 0 }));
	writeConfig(path, source);
	return `${next.modelRef}${next.thinking ? `:${next.thinking}` : ""}`;
}

export function savePixDefaultThinking(
	level: string,
	fallbackModelRef: string | undefined,
	homeDir = homedir(),
): string {
	if (!isThinkingLevel(level)) throw new Error(`Unknown thinking level: ${level}`);
	const path = pixConfigPath(homeDir);
	let source = readConfigSource(path);
	const current = defaultModelFromParsed(parseJsonc(source) as unknown);
	const modelRef = current?.modelRef ?? fallbackModelRef;
	if (!modelRef || !parseModelRef(modelRef)) {
		throw new Error("Set /default-model first or select a session model before setting default thinking");
	}
	const normalizedModel = parseModelRef(modelRef)!;
	const next = { modelRef: `${normalizedModel.provider}/${normalizedModel.modelId}`, thinking: level };
	source = applyEdits(source, modify(source, ["defaultModel"], next, { formattingOptions, getInsertionIndex: () => 0 }));
	writeConfig(path, source);
	return `${next.modelRef}:${level}`;
}

export function savePixAutocompleteModel(modelRef: string, homeDir = homedir()): string {
	const trimmed = modelRef.trim();
	if (trimmed && !parseModelRef(trimmed)) {
		throw new Error("Autocomplete model must use provider/model[:thinking] format");
	}
	const path = pixConfigPath(homeDir);
	let source = readConfigSource(path);
	source = applyEdits(source, modify(source, ["autocomplete", "modelRef"], trimmed, { formattingOptions }));
	writeConfig(path, source);
	return trimmed;
}

export function loadPixIgnoreContextFiles(cwd: string, homeDir = homedir()): boolean {
	const globalPath = pixConfigPath(homeDir);
	const projectPath = join(cwd, ".pi", "pix.jsonc");
	const globalValue = readIgnoreContextFiles(globalPath);
	return readIgnoreContextFiles(projectPath) ?? globalValue ?? false;
}

export function saveProjectPixIgnoreContextFiles(cwd: string, ignoreContextFiles: boolean): boolean {
	const path = join(cwd, ".pi", "pix.jsonc");
	let source = readConfigSource(path);
	source = applyEdits(source, modify(source, ["ignoreContextFiles"], ignoreContextFiles, { formattingOptions }));
	writeConfig(path, source);
	return ignoreContextFiles;
}

export function parseModelRef(value: string): {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel?: PixThinkingLevel;
} | undefined {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, slash);
	let modelId = trimmed.slice(slash + 1);
	let thinkingLevel: PixThinkingLevel | undefined;
	const colon = modelId.lastIndexOf(":");
	if (colon > 0) {
		const suffix = modelId.slice(colon + 1);
		if (!isThinkingLevel(suffix)) return undefined;
		modelId = modelId.slice(0, colon);
		thinkingLevel = suffix;
	}
	if (!modelId) return undefined;
	return { provider, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

export function isThinkingLevel(value: string): value is PixThinkingLevel {
	return (PIX_THINKING_LEVELS as readonly string[]).includes(value);
}

function autocompleteModelFromParsed(raw: unknown): string | undefined {
	if (!isRecord(raw)) return undefined;
	const autocomplete = raw.autocomplete ?? raw.autoComplete;
	if (typeof autocomplete === "string") return autocomplete.trim();
	if (!isRecord(autocomplete)) return undefined;
	const value = autocomplete.modelRef ?? autocomplete.model;
	return typeof value === "string" ? value.trim() : undefined;
}

function readIgnoreContextFiles(path: string): boolean | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = parseJsonc(readFileSync(path, "utf8")) as unknown;
		return isRecord(parsed) && typeof parsed.ignoreContextFiles === "boolean"
			? parsed.ignoreContextFiles
			: undefined;
	} catch {
		return undefined;
	}
}

function pixConfigPath(homeDir: string): string {
	return join(homeDir, ".config", "pi", "pix.jsonc");
}

function readConfigSource(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf8") : "{\n}\n";
}

function writeConfig(path: string, source: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, source, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
