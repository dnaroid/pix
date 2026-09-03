import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parse as parseJsonc } from "jsonc-parser";
import type { Logger } from "../logging.js";
import type { PiAgentMessage } from "../pi/pi-rpc-client.js";

const ERROR_INVALID_PARAMS = -32602;
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type AutocompleteHistoryMessage = { role: "user" | "assistant"; text: string };
const AUTOCOMPLETE_MAX_SUFFIX_LENGTH = 320;
const AUTOCOMPLETE_HISTORY_MESSAGE_MAX_CHARS = 700;
const AUTOCOMPLETE_HISTORY_CONTEXT_MAX_CHARS = 3_600;
const AUTOCOMPLETE_TOKEN_CHARS = 4;
const DEFAULT_AUTOCOMPLETE_CONFIG: AutocompleteConfig = {
	modelRef: "zai/glm-5-turbo",
	debounceMs: 350,
	timeoutMs: 3_000,
	maxTokens: 48,
	maxPromptTokens: 1_200,
	includeRecentMessages: 0,
};
const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const AUTOCOMPLETE_SYSTEM_PROMPT = `You are an inline autocomplete engine for pix, a terminal UI for a coding agent.
Use provided recent active-session messages only as optional context; the current draft is the source of truth.
Continue only the user's current draft at the cursor.
Output only the exact suffix to append after the draft.
Do not repeat the draft. Do not answer the user. Do not explain.
If the draft already looks complete or the continuation is uncertain, output an empty string.
Keep the suffix short, in the user's language/style, and stop at a natural boundary.`;

export interface AutocompleteRequest {
	readonly sessionId: string;
	readonly draft: string;
}

export interface AutocompleteResponse {
	readonly completion: string;
}

export interface AutocompleteSettingsRequest {
	readonly sessionId: string;
}

export interface AutocompleteSettingsResponse {
	readonly enabled: boolean;
	readonly debounceMs: number;
}

export interface AutocompleteConfig {
	readonly modelRef: string;
	readonly debounceMs: number;
	readonly timeoutMs: number;
	readonly maxTokens: number;
	readonly maxPromptTokens: number;
	readonly includeRecentMessages: number;
}

export interface AutocompleteCompleterInput {
	readonly cwd: string;
	readonly draft: string;
	readonly signal: AbortSignal;
	readonly getMessages: () => Promise<readonly PiAgentMessage[]>;
}

export type AutocompleteCompleter = (input: AutocompleteCompleterInput) => Promise<string>;

interface CreateAutocompleteCompleterOptions {
	readonly logger: Logger;
	readonly loadConfig?: (cwd: string) => AutocompleteConfig;
	readonly createModelRuntime?: () => Promise<ModelRuntime>;
}

export function parseAutocompleteRequest(value: unknown): AutocompleteRequest {
	if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.draft !== "string") {
		throw new RequestError(ERROR_INVALID_PARAMS, "pix/autocomplete requires string sessionId and draft fields");
	}
	return { sessionId: value.sessionId, draft: value.draft };
}

export function parseAutocompleteSettingsRequest(value: unknown): AutocompleteSettingsRequest {
	if (!isRecord(value) || typeof value.sessionId !== "string") {
		throw new RequestError(ERROR_INVALID_PARAMS, "pix/autocomplete/config requires a string sessionId field");
	}
	return { sessionId: value.sessionId };
}

export function autocompleteSettings(config: AutocompleteConfig): AutocompleteSettingsResponse {
	return { enabled: config.modelRef.trim().length > 0, debounceMs: config.debounceMs };
}

export function createAutocompleteCompleter(options: CreateAutocompleteCompleterOptions): AutocompleteCompleter {
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

	return async ({ cwd, draft, signal, getMessages }) => {
		const config = (options.loadConfig ?? loadAutocompleteConfig)(cwd);
		if (!isEligibleDraft(draft) || !config.modelRef.trim()) return "";
		const requestSignal = createTimeoutSignal(signal, config.timeoutMs);
		try {
			const parsedModel = parseModelRef(config.modelRef);
			const runtime = await raceWithSignal(getRuntime(), requestSignal.signal);
			let model = runtime.getModel(parsedModel.provider, parsedModel.modelId);
			if (!model) {
				await runtime.refresh({ signal: requestSignal.signal });
				model = runtime.getModel(parsedModel.provider, parsedModel.modelId);
			}
			if (!model) throw new Error(`Autocomplete model not found: ${parsedModel.provider}/${parsedModel.modelId}`);

			const history = config.includeRecentMessages > 0
				? await raceWithSignal(getMessages(), requestSignal.signal).catch((error: unknown) => {
					if (requestSignal.signal.aborted) throw error;
					options.logger.debug(`autocomplete history unavailable: ${stringifyUnknown(error)}`);
					return [];
				})
				: [];
			const prompt = buildAutocompletePrompt(cwd, draft, history, config);
			if (!prompt) return "";
			const requestMaxTokens = model.maxTokens > 0 ? Math.min(model.maxTokens, config.maxTokens) : config.maxTokens;
			const requestModel = { ...model, maxTokens: requestMaxTokens };
			let output = "";
			let streamError: string | undefined;
			const stream = runtime.streamSimple(
				requestModel,
				{
					systemPrompt: AUTOCOMPLETE_SYSTEM_PROMPT,
					messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
				},
				{
					signal: requestSignal.signal,
					...(parsedModel.thinkingLevel && parsedModel.thinkingLevel !== "off"
						? { reasoning: parsedModel.thinkingLevel }
						: {}),
					cacheRetention: "none",
					maxRetryDelayMs: 0,
					maxRetries: 0,
					maxTokens: requestMaxTokens,
					timeoutMs: config.timeoutMs,
				},
			);

			for await (const event of stream) {
				if (event.type === "text_delta") output += event.delta;
				else if (event.type === "done" && !output) output = extractAssistantText(event.message);
				else if (event.type === "error") streamError = event.error.errorMessage ?? event.reason;
			}
			if (streamError) throw new Error(streamError);
			return cleanCompletion(output, draft, config.maxTokens);
		} finally {
			requestSignal.dispose();
		}
	};
}

export function loadAutocompleteConfig(cwd: string): AutocompleteConfig {
	const globalPath = join(homedir(), ".config", "pi", "pix.jsonc");
	const projectPath = join(cwd, ".pi", "pix.jsonc");
	const globalConfig = readAutocompleteConfig(globalPath, DEFAULT_AUTOCOMPLETE_CONFIG);
	return readAutocompleteConfig(projectPath, globalConfig);
}

function readAutocompleteConfig(path: string, fallback: AutocompleteConfig): AutocompleteConfig {
	if (!existsSync(path)) return fallback;
	try {
		const raw = parseJsonc(readFileSync(path, "utf8")) as unknown;
		return autocompleteConfigFromParsed(raw, fallback);
	} catch {
		return fallback;
	}
}

export function autocompleteConfigFromParsed(raw: unknown, fallback: AutocompleteConfig): AutocompleteConfig {
	if (!isRecord(raw)) return fallback;
	const autocomplete = raw.autocomplete ?? raw.autoComplete;
	if (typeof autocomplete === "string") {
		return { ...DEFAULT_AUTOCOMPLETE_CONFIG, modelRef: autocomplete.trim() };
	}
	if (!isRecord(autocomplete)) return fallback;
	const modelRef = typeof autocomplete.modelRef === "string"
		? autocomplete.modelRef.trim()
		: typeof autocomplete.model === "string"
			? autocomplete.model.trim()
			: DEFAULT_AUTOCOMPLETE_CONFIG.modelRef;
	return {
		modelRef,
		debounceMs: numberInRange(autocomplete.debounceMs, DEFAULT_AUTOCOMPLETE_CONFIG.debounceMs, 100, 2_000),
		timeoutMs: numberInRange(autocomplete.timeoutMs, DEFAULT_AUTOCOMPLETE_CONFIG.timeoutMs, 250, 10_000),
		maxTokens: numberInRange(autocomplete.maxTokens, DEFAULT_AUTOCOMPLETE_CONFIG.maxTokens, 8, 256),
		maxPromptTokens: numberInRange(
			autocomplete.maxPromptTokens,
			DEFAULT_AUTOCOMPLETE_CONFIG.maxPromptTokens,
			256,
			16_000,
		),
		includeRecentMessages: numberInRange(
			autocomplete.includeRecentMessages ?? autocomplete.recentMessages,
			DEFAULT_AUTOCOMPLETE_CONFIG.includeRecentMessages,
			0,
			20,
		),
	};
}

function buildAutocompletePrompt(
	cwd: string,
	draft: string,
	messages: readonly PiAgentMessage[],
	config: AutocompleteConfig,
): string {
	let history = autocompleteHistoryFromMessages(messages, config.includeRecentMessages);
	let prompt = renderAutocompletePrompt(cwd, draft, history);
	while (history.length > 0 && autocompletePromptTokenEstimate(prompt) > config.maxPromptTokens) {
		history = history.slice(1);
		prompt = renderAutocompletePrompt(cwd, draft, history);
	}
	return autocompletePromptTokenEstimate(prompt) <= config.maxPromptTokens ? prompt : "";
}

function autocompleteHistoryFromMessages(
	messages: readonly PiAgentMessage[],
	includeRecentMessages: number,
): AutocompleteHistoryMessage[] {
	const history: AutocompleteHistoryMessage[] = [];
	for (let index = messages.length - 1; index >= 0 && history.length < includeRecentMessages; index--) {
		const message = messages[index];
		if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
		const text = compactHistoryText(messageText(message, message.role));
		if (text) history.push({ role: message.role, text: clipHistoryText(text, AUTOCOMPLETE_HISTORY_MESSAGE_MAX_CHARS) });
	}
	return trimHistoryContext(history.reverse(), AUTOCOMPLETE_HISTORY_CONTEXT_MAX_CHARS);
}

function renderAutocompletePrompt(cwd: string, draft: string, history: readonly AutocompleteHistoryMessage[]): string {
	const lines = [
		"Complete the current terminal input for the active pix/pi coding-agent session.",
		`cwd: ${cwd}`,
	];
	if (history.length > 0) {
		lines.push(
			"",
			"Recent messages are context only; never continue them directly.",
			"<recent-active-session-messages>",
			history.map((message) => [
				`<message role="${message.role}">`,
				message.text.replace(/<\/message>/giu, "</ message>"),
				"</message>",
			].join("\n")).join("\n\n"),
			"</recent-active-session-messages>",
		);
	}
	return [
		...lines,
		"",
		"Return only the suffix to append after <cursor>. Return nothing if unsure.",
		"<draft>",
		draft,
		"<cursor>",
		"</draft>",
	].join("\n");
}

function autocompletePromptTokenEstimate(prompt: string): number {
	return Math.ceil(AUTOCOMPLETE_SYSTEM_PROMPT.length / AUTOCOMPLETE_TOKEN_CHARS)
		+ Math.ceil(prompt.length / AUTOCOMPLETE_TOKEN_CHARS);
}

function cleanCompletion(raw: string, draft: string, maxTokens: number): string {
	let value = raw.replace(/\r\n/gu, "\n").trimEnd();
	const fenced = /^```[^\n`]*\n([\s\S]*?)\n```$/u.exec(value.trim());
	if (fenced) value = fenced[1]!.trimEnd();
	if (value.startsWith(draft)) value = value.slice(draft.length);
	value = value
		.replace(/^<cursor>/iu, "")
		.replace(/^\s*(?:completion|suffix|autocomplete|продолжение)\s*:\s*/iu, "")
		.replace(/^\n+/u, "");
	if (!value.trim()) return "";
	return value.slice(0, Math.min(AUTOCOMPLETE_MAX_SUFFIX_LENGTH, maxTokens * 8));
}

function extractAssistantText(message: unknown): string {
	if (!isRecord(message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is Record<string, unknown> => isRecord(part))
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => String(part.text))
		.join("");
}

function messageText(message: PiAgentMessage, role: AutocompleteHistoryMessage["role"]): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		if (part.type === "text" && typeof part.text === "string") return [part.text];
		if (part.type === "image" && role === "user") return ["[image]"];
		return [];
	}).join("\n");
}

function compactHistoryText(text: string): string {
	return text
		.replace(/\r\n/gu, "\n")
		.split("\n")
		.filter((line) => !/^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/u.test(line))
		.join("\n")
		.replace(/[\t ]+/gu, " ")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

function clipHistoryText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const headLength = Math.floor((maxChars - 3) / 2);
	const tailLength = maxChars - 3 - headLength;
	return `${text.slice(0, headLength).trimEnd()}\n…\n${text.slice(-tailLength).trimStart()}`;
}

function trimHistoryContext(
	history: AutocompleteHistoryMessage[],
	maxChars: number,
): AutocompleteHistoryMessage[] {
	const trimmed = history.slice();
	while (
		trimmed.length > 0
		&& trimmed.reduce((sum, message) => sum + message.text.length + message.role.length + 32, 0) > maxChars
	) trimmed.shift();
	return trimmed;
}

function parseModelRef(value: string): { provider: string; modelId: string; thinkingLevel?: ThinkingLevel } {
	const [modelPart, thinkingPart] = value.trim().split(":", 2);
	const slashIndex = modelPart?.indexOf("/") ?? -1;
	if (!modelPart || slashIndex <= 0 || slashIndex === modelPart.length - 1) {
		throw new Error("Autocomplete model must use provider/model format");
	}
	if (thinkingPart && !THINKING_LEVELS.has(thinkingPart as ThinkingLevel)) {
		throw new Error(`Unknown autocomplete thinking level: ${thinkingPart}`);
	}
	return {
		provider: modelPart.slice(0, slashIndex),
		modelId: modelPart.slice(slashIndex + 1),
		...(thinkingPart ? { thinkingLevel: thinkingPart as ThinkingLevel } : {}),
	};
}

function isEligibleDraft(draft: string): boolean {
	return draft.trim().length >= 3 && !draft.startsWith("/") && !draft.startsWith("!");
}

function createTimeoutSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	if (parent.aborted) abort();
	else parent.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, timeoutMs);
	timer.unref?.();
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent.removeEventListener("abort", abort);
		},
	};
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyUnknown(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
