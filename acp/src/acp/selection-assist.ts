import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parse as parseJsonc } from "jsonc-parser";
import { createAssistModelRunner, type AssistDelta, type AssistModelRunner } from "./assist-model-runner.js";
import { pixProjectConfigPath, pixUserConfigPath } from "./pix-config-paths.js";

/** Desktop selection helpers: explain selected code, translate selected chat text. */
export type SelectionAssistAction = "explain" | "translate";

export const DEFAULT_SELECTION_ASSIST_LANGUAGE = "ru";
const SELECTION_ASSIST_TIMEOUT_MS = 30_000;
/** Explanations stay short so they arrive at autocomplete-like speed. */
const EXPLAIN_MAX_TOKENS = 400;
const TRANSLATE_MAX_TOKENS = 2_048;

export interface SelectionAssistInput {
	readonly cwd: string;
	readonly action: SelectionAssistAction;
	readonly text: string;
	/** Surrounding source used only to understand the selection. */
	readonly context?: string;
	/** Workspace-relative or absolute path of the source file, when known. */
	readonly path?: string;
	readonly signal: AbortSignal;
	/** Streamed output: `reset` discards text from a failed fallback candidate. */
	readonly onDelta?: (delta: AssistDelta) => Promise<void> | void;
}

export type SelectionAssistant = (input: SelectionAssistInput) => Promise<string>;

export interface SelectionAssistConfig {
	readonly modelRefs: readonly string[];
	readonly language: string;
}

interface CreateSelectionAssistantOptions {
	readonly createModelRuntime?: () => Promise<ModelRuntime>;
	readonly loadConfig?: (cwd: string) => SelectionAssistConfig;
	/** Shared model runner; defaults to one owned by this assistant. */
	readonly runner?: AssistModelRunner;
}

export function createSelectionAssistant(options: CreateSelectionAssistantOptions = {}): SelectionAssistant {
	const run = options.runner ?? createAssistModelRunner(options.createModelRuntime);
	return async ({ cwd, action, text, context, path, signal, onDelta }) => {
		const config = (options.loadConfig ?? loadSelectionAssistConfig)(cwd);
		if (config.modelRefs.length === 0) throw new Error("No selection assistant model is configured");
		const systemPrompt = action === "explain" ? explainSystemPrompt(config.language) : translateSystemPrompt(config.language);
		const prompt = action === "explain" ? buildExplainPrompt(text, context, path) : buildTranslatePrompt(text);
		return run({
			modelRefs: config.modelRefs,
			systemPrompt,
			prompt,
			maxTokens: action === "explain" ? EXPLAIN_MAX_TOKENS : TRANSLATE_MAX_TOKENS,
			timeoutMs: SELECTION_ASSIST_TIMEOUT_MS,
			signal,
			...(onDelta ? { onDelta } : {}),
		});
	};
}

/**
 * Resolve `selectionAssist` from the active profile (project overrides user).
 * When no model is configured it reuses the autocomplete chain.
 */
export function loadSelectionAssistConfig(cwd: string, homeDir = homedir()): SelectionAssistConfig {
	const sources = [readConfig(pixUserConfigPath(homeDir)), readConfig(pixProjectConfigPath(cwd))];
	let modelRef = "";
	let fallbackModels: string[] = [];
	let autocompleteRef = "";
	let autocompleteFallbacks: string[] = [];
	let language = DEFAULT_SELECTION_ASSIST_LANGUAGE;
	for (const cfg of sources) {
		if (!cfg) continue;
		const assist = isRecord(cfg.selectionAssist) ? cfg.selectionAssist : undefined;
		if (assist) {
			if (typeof assist.modelRef === "string" && assist.modelRef.trim()) modelRef = assist.modelRef.trim();
			if (Object.prototype.hasOwnProperty.call(assist, "fallbackModels")) fallbackModels = stringList(assist.fallbackModels);
			if (typeof assist.language === "string" && assist.language.trim()) language = assist.language.trim();
		}
		const autocomplete = isRecord(cfg.autocomplete) ? cfg.autocomplete : undefined;
		if (autocomplete) {
			if (typeof autocomplete.modelRef === "string" && autocomplete.modelRef.trim()) autocompleteRef = autocomplete.modelRef.trim();
			if (Object.prototype.hasOwnProperty.call(autocomplete, "fallbackModels")) autocompleteFallbacks = stringList(autocomplete.fallbackModels);
		}
	}
	const refs = modelRef ? [modelRef, ...fallbackModels] : [autocompleteRef, ...autocompleteFallbacks];
	return { modelRefs: [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))], language };
}

function explainSystemPrompt(language: string): string {
	return `You explain source code to a developer reading it in a code viewer.
Explain what the selected code does: its purpose, the key steps of its logic and any non-obvious details (side effects, edge cases, error handling).
Use the surrounding context only to understand the selection; explain the selection itself.
Be brief: at most 2-4 short sentences or up to 4 short bullets. No headings, no restating the code. Use Markdown; wrap identifiers in backticks.
Do not rewrite or suggest changes unless something is clearly a bug.
Answer in the language with this code/name: ${language}.`;
}

function translateSystemPrompt(language: string): string {
	return `You are a translator. Translate the user's text into the language with this code/name: ${language}.
Preserve meaning, tone, Markdown formatting, code, identifiers, paths and URLs exactly.
If the text is already in the target language, return it unchanged.
Output only the translation. No commentary.`;
}

function buildExplainPrompt(text: string, context: string | undefined, path: string | undefined): string {
	return [
		...(path ? [`File: ${path}`] : []),
		...(context && context !== text ? ["<context>", context, "</context>"] : []),
		"<selection>",
		text,
		"</selection>",
	].join("\n");
}

function buildTranslatePrompt(text: string): string {
	return ["<text>", text, "</text>"].join("\n");
}

function readConfig(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = parseJsonc(readFileSync(path, "utf8")) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
