import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parse as parseJsonc } from "jsonc-parser";
import { parseModelRef } from "./pix-settings.js";

const DEFAULT_PROMPT_ENHANCER_CONFIG = {
	modelRef: "openai-codex/gpt-5.6-luna",
	fallbackModels: [] as string[],
};
const PROMPT_ENHANCER_TIMEOUT_MS = 30_000;
const PROMPT_ENHANCER_MAX_TOKENS = 4_096;

const PROMPT_ENHANCER_SYSTEM_PROMPT = `You improve prompts for a coding agent.

Rewrite the user's draft into a clearer, more actionable prompt.
Preserve the user's intent and language.
Do not solve the task.
Do not add unsupported assumptions.
Add useful constraints, acceptance criteria, and context requests when helpful.
Output only the improved prompt. No commentary, no markdown fences.`;

export interface PromptEnhancerInput {
	readonly cwd: string;
	readonly draft: string;
	readonly signal: AbortSignal;
}

export type PromptEnhancer = (input: PromptEnhancerInput) => Promise<string>;

interface CreatePromptEnhancerOptions {
	readonly createModelRuntime?: () => Promise<ModelRuntime>;
	readonly loadModelRef?: (cwd: string) => string;
}

export function createPromptEnhancer(options: CreatePromptEnhancerOptions = {}): PromptEnhancer {
	let runtimePromise: Promise<ModelRuntime> | undefined;
	const getRuntime = async (): Promise<ModelRuntime> => {
		runtimePromise ??= (options.createModelRuntime ?? (() => ModelRuntime.create()))();
		try {
			return await runtimePromise;
		} catch (error) {
			runtimePromise = undefined;
			throw error;
		}
	};

	return async ({ cwd, draft, signal }) => {
		const normalizedDraft = draft.trim();
		if (normalizedDraft.length < 3) throw new Error("Type at least 3 characters to enhance");
		const modelRefs = options.loadModelRef
			? [(options.loadModelRef(cwd) ?? "").trim()].filter(Boolean)
			: loadPromptEnhancerModelRefs(cwd);
		const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(PROMPT_ENHANCER_TIMEOUT_MS)]);
		const runtime = await getRuntime();
		let refreshed = false;
		let lastError: unknown;

		for (const modelRef of modelRefs) {
			if (requestSignal.aborted) throw requestSignal.reason ?? new Error("Prompt enhancer request aborted");
			const parsed = parseModelRef(modelRef);
			if (!parsed) {
				lastError = new Error(`Invalid prompt enhancer model: ${modelRef}`);
				continue;
			}
			let model = runtime.getModel(parsed.provider, parsed.modelId);
			if (!model && !refreshed) {
				await runtime.refresh({ signal: requestSignal });
				refreshed = true;
				model = runtime.getModel(parsed.provider, parsed.modelId);
			}
			if (!model) {
				lastError = new Error(`Prompt enhancer model not found: ${parsed.provider}/${parsed.modelId}`);
				continue;
			}

			try {
				const maxTokens = model.maxTokens > 0
					? Math.min(model.maxTokens, PROMPT_ENHANCER_MAX_TOKENS)
					: PROMPT_ENHANCER_MAX_TOKENS;
				let output = "";
				let streamError: string | undefined;
				const stream = runtime.streamSimple(
					{ ...model, maxTokens },
					{
						systemPrompt: PROMPT_ENHANCER_SYSTEM_PROMPT,
						messages: [{ role: "user", content: buildEnhancerPrompt(normalizedDraft), timestamp: Date.now() }],
					},
					{
						signal: requestSignal,
						...(parsed.thinkingLevel && parsed.thinkingLevel !== "off"
							? { reasoning: parsed.thinkingLevel }
							: { reasoning: "minimal" as const }),
						cacheRetention: "none",
						maxRetryDelayMs: 0,
						maxRetries: 0,
						maxTokens,
						timeoutMs: PROMPT_ENHANCER_TIMEOUT_MS,
					},
				);
				for await (const event of stream) {
					if (event.type === "text_delta") output += event.delta;
					else if (event.type === "done" && !output) output = assistantText(event.message);
					else if (event.type === "error") streamError = event.error.errorMessage ?? event.reason;
				}
				if (streamError) throw new Error(streamError);
				const cleaned = cleanupEnhancedPrompt(output);
				if (!cleaned) throw new Error("Prompt enhancer returned an empty prompt");
				return cleaned;
			} catch (error) {
				if (requestSignal.aborted) throw requestSignal.reason ?? error;
				lastError = error;
			}
		}

		throw lastError ?? new Error("No prompt enhancer models are configured");
	};
}

export function loadPromptEnhancerModelRef(cwd: string, homeDir = homedir()): string {
	return loadPromptEnhancerModelRefs(cwd, homeDir)[0] ?? DEFAULT_PROMPT_ENHANCER_CONFIG.modelRef;
}

export function loadPromptEnhancerModelRefs(cwd: string, homeDir = homedir()): string[] {
	const globalPath = join(homeDir, ".config", "pi", "pix.jsonc");
	const projectPath = join(cwd, ".pi", "pix.jsonc");
	const globalConfig = { ...DEFAULT_PROMPT_ENHANCER_CONFIG, ...readPromptEnhancerConfig(globalPath) };
	const resolved = { ...globalConfig, ...readPromptEnhancerConfig(projectPath) };
	return configuredModelRefs(resolved.modelRef, resolved.fallbackModels);
}

function readPromptEnhancerConfig(path: string): { modelRef?: string; fallbackModels?: string[] } | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = parseJsonc(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.promptEnhancer)) return undefined;
		const value = parsed.promptEnhancer.modelRef ?? parsed.promptEnhancer.model;
		const modelRef = typeof value === "string" && value.trim() ? value.trim() : undefined;
		const fallbackModels = modelFallbackList(parsed.promptEnhancer.fallbackModels);
		return {
			...(modelRef ? { modelRef } : {}),
			...(Object.prototype.hasOwnProperty.call(parsed.promptEnhancer, "fallbackModels") ? { fallbackModels } : {}),
		};
	} catch {
		return undefined;
	}
}

function configuredModelRefs(primary: string, fallbacks: readonly string[] | undefined): string[] {
	return [...new Set([primary, ...(fallbacks ?? [])].map((ref) => ref.trim()).filter(Boolean))];
}

function modelFallbackList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean))];
}

function buildEnhancerPrompt(draft: string): string {
	return [
		"Rewrite this draft prompt. Output only the improved prompt.",
		"<draft>",
		draft,
		"</draft>",
	].join("\n");
}

function cleanupEnhancedPrompt(value: string): string {
	let text = value.replace(/\r\n/gu, "\n").trim();
	const fenced = /^```[^\n`]*\n([\s\S]*?)\n```$/u.exec(text);
	if (fenced) text = fenced[1]!.trim();
	return text;
}

function assistantText(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) =>
		isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
