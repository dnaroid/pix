import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AutocompleteConfig } from "../../config.js";
import type { InputEditor } from "../../input-editor.js";
import { isRecord } from "../guards.js";
import { parseModelRef } from "../model/model-ref.js";
import type { SessionModel } from "../types.js";

const AUTOCOMPLETE_DEBOUNCE_MS = 350;
const AUTOCOMPLETE_MIN_TEXT_LENGTH = 3;
const AUTOCOMPLETE_TIMEOUT_MS = 3_000;
const AUTOCOMPLETE_MAX_TOKENS = 48;
const AUTOCOMPLETE_MAX_PROMPT_TOKENS = 1_200;
const AUTOCOMPLETE_INCLUDE_RECENT_MESSAGES = 0;
const AUTOCOMPLETE_MAX_SUFFIX_LENGTH = 320;
const AUTOCOMPLETE_HISTORY_MESSAGE_MAX_CHARS = 700;
const AUTOCOMPLETE_HISTORY_CONTEXT_MAX_CHARS = 3_600;
const AUTOCOMPLETE_TOKEN_CHARS = 4;

const AUTOCOMPLETE_SYSTEM_PROMPT = `You are an inline autocomplete engine for pix, a terminal UI for a coding agent.
Use provided recent active-session messages only as optional context; the current draft is the source of truth.
Continue only the user's current draft at the cursor.
Output only the exact suffix to append after the draft.
Do not repeat the draft. Do not answer the user. Do not explain.
If the draft already looks complete or the continuation is uncertain, output an empty string.
Keep the suffix short, in the user's language/style, and stop at a natural boundary.`;

export type AppAutocompleteControllerHost = {
	runtime(): AgentSessionRuntime | undefined;
	inputEditor(): InputEditor;
	autocompleteConfig(): AutocompleteConfig;
	isRunning(): boolean;
	render(): void;
};

type AutocompleteTarget = {
	text: string;
	cursor: number;
};

export type AutocompleteHistoryMessage = {
	role: "user" | "assistant";
	text: string;
};

type AutocompleteRunner = typeof completeInputWithPi;

export type AppAutocompleteControllerOptions = {
	completeInputWithPi?: AutocompleteRunner;
	debounceMs?: number;
};

export class AppAutocompleteController {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private lastObservedKey = "";
	private requestSeq = 0;
	private suggestion: { target: AutocompleteTarget; text: string } | undefined;
	private activeAbortController: AbortController | undefined;
	private readonly completeInputWithPi: AutocompleteRunner;
	private readonly debounceOverrideMs: number | undefined;

	constructor(
		private readonly host: AppAutocompleteControllerHost,
		options: AppAutocompleteControllerOptions = {},
	) {
		this.completeInputWithPi = options.completeInputWithPi ?? completeInputWithPi;
		this.debounceOverrideMs = options.debounceMs;
	}

	observeInput(): void {
		const target = this.currentTarget();
		const key = target ? this.targetKey(target) : "";
		if (key === this.lastObservedKey) return;

		this.lastObservedKey = key;
		this.suggestion = undefined;
		this.clearTimer();
		this.cancelInFlight();
		if (!target) return;

		const requestSeq = ++this.requestSeq;
		this.timer = setTimeout(() => {
			void this.runAutocomplete(target, requestSeq);
		}, this.currentDebounceMs());
		this.timer.unref?.();
	}

	suggestionText(): string | undefined {
		const target = this.currentTarget();
		if (!target || !this.suggestion) return undefined;
		return this.sameTarget(target, this.suggestion.target) ? this.suggestion.text : undefined;
	}

	acceptSuggestion(): boolean {
		const suggestion = this.suggestionText();
		if (!suggestion) return false;

		this.host.inputEditor().insert(suggestion);
		this.suggestion = undefined;
		this.lastObservedKey = "";
		this.clearTimer();
		this.host.render();
		return true;
	}

	dispose(): void {
		this.clearTimer();
		this.cancelInFlight();
		this.requestSeq += 1;
		this.suggestion = undefined;
	}

	private async runAutocomplete(target: AutocompleteTarget, requestSeq: number): Promise<void> {
		const runtime = this.host.runtime();
		const config = { ...this.host.autocompleteConfig() };
		if (!runtime || !config.modelRef.trim()) return;

		const abortController = new AbortController();
		this.activeAbortController = abortController;

		try {
			const completion = await this.completeInputWithPi(runtime, target.text, config, abortController.signal);
			if (requestSeq !== this.requestSeq) return;
			const current = this.currentTarget();
			if (!current || !this.sameTarget(current, target)) return;

			const suggestion = cleanupCompletion(completion, target.text, config);
			if (!suggestion) return;
			this.suggestion = { target, text: suggestion };
			if (this.host.isRunning()) this.host.render();
		} catch {
			// Inline autocomplete is best-effort; avoid surfacing transient model/auth errors while typing.
		} finally {
			if (this.activeAbortController === abortController) this.activeAbortController = undefined;
		}
	}

	private currentTarget(): AutocompleteTarget | undefined {
		const config = this.host.autocompleteConfig();
		if (!config.modelRef.trim()) return undefined;

		const editor = this.host.inputEditor();
		const text = editor.text;
		const cursor = editor.cursor;
		if (editor.hasSelection || editor.hasAttachments) return undefined;
		if (cursor !== text.length) return undefined;
		if (text.trim().length < AUTOCOMPLETE_MIN_TEXT_LENGTH) return undefined;
		if (text.startsWith("/") || text.startsWith("!")) return undefined;
		return { text, cursor };
	}

	private targetKey(target: AutocompleteTarget): string {
		return `${target.cursor}\u0000${target.text}`;
	}

	private sameTarget(a: AutocompleteTarget, b: AutocompleteTarget): boolean {
		return a.cursor === b.cursor && a.text === b.text;
	}

	private currentDebounceMs(): number {
		return numberInRange(this.debounceOverrideMs ?? this.host.autocompleteConfig().debounceMs, AUTOCOMPLETE_DEBOUNCE_MS, 0, 5_000);
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private cancelInFlight(): void {
		this.activeAbortController?.abort();
		this.activeAbortController = undefined;
	}
}

export async function completeInputWithPi(
	runtime: AgentSessionRuntime,
	draft: string,
	config: AutocompleteConfig,
	signal?: AbortSignal,
): Promise<string> {
	const parsedModel = parseModelRef(config.modelRef);
	const modelRuntime = runtime.services.modelRuntime;
	let model = modelRuntime.getModel(parsedModel.provider, parsedModel.modelId) as SessionModel | undefined;
	if (!model) {
		await modelRuntime.reloadConfig();
		model = modelRuntime.getModel(parsedModel.provider, parsedModel.modelId) as SessionModel | undefined;
	}
	if (!model) throw new Error(`Model not found: ${parsedModel.provider}/${parsedModel.modelId}`);

	const timeoutMs = numberInRange(config.timeoutMs, AUTOCOMPLETE_TIMEOUT_MS, 250, 10_000);
	const maxTokens = numberInRange(config.maxTokens, AUTOCOMPLETE_MAX_TOKENS, 8, 256);
	const maxPromptTokens = numberInRange(config.maxPromptTokens, AUTOCOMPLETE_MAX_PROMPT_TOKENS, 256, 16_000);
	const requestSignal = createTimeoutSignal(signal, timeoutMs);
	const requestMaxTokens = model.maxTokens > 0 ? Math.min(model.maxTokens, maxTokens) : maxTokens;
	const requestModel = { ...model, maxTokens: requestMaxTokens } satisfies SessionModel;
	const includeRecentMessages = numberInRange(config.includeRecentMessages, AUTOCOMPLETE_INCLUDE_RECENT_MESSAGES, 0, 20);
	const history = includeRecentMessages > 0 ? autocompleteHistoryFromMessages(runtime.session.messages, includeRecentMessages) : [];
	const prompt = buildAutocompletePrompt({ cwd: runtime.cwd, draft, history, maxPromptTokens });
	if (!prompt) return "";

	let output = "";
	let streamError: string | undefined;

	try {
		const stream = modelRuntime.streamSimple(requestModel, {
			systemPrompt: AUTOCOMPLETE_SYSTEM_PROMPT,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		}, {
			cacheRetention: "none",
			maxRetryDelayMs: 0,
			maxRetries: 0,
			maxTokens: requestModel.maxTokens,
			...(parsedModel.thinkingLevel && parsedModel.thinkingLevel !== "off" ? { reasoning: parsedModel.thinkingLevel } : {}),
			signal: requestSignal.signal,
			timeoutMs,
		});

		for await (const event of stream) {
			if (event.type === "text_delta") output += event.delta;
			else if (event.type === "done" && !output) output = assistantMessageText(event.message);
			else if (event.type === "error") streamError = event.error.errorMessage ?? event.reason;
		}

		if (streamError) throw new Error(streamError);
		return output;
	} finally {
		requestSignal.dispose();
	}
}

export function autocompleteHistoryFromMessages(messages: readonly unknown[], includeRecentMessages: number): AutocompleteHistoryMessage[] {
	const limit = numberInRange(includeRecentMessages, AUTOCOMPLETE_INCLUDE_RECENT_MESSAGES, 0, 20);
	if (limit <= 0) return [];

	const history: AutocompleteHistoryMessage[] = [];
	for (let index = messages.length - 1; index >= 0 && history.length < limit; index -= 1) {
		const message = messages[index];
		if (!isRecord(message)) continue;
		const role = message.role === "user" || message.role === "assistant" ? message.role : undefined;
		if (!role) continue;

		const text = compactHistoryText(messageText(message, role));
		if (!text) continue;
		history.push({ role, text: clipHistoryText(text, AUTOCOMPLETE_HISTORY_MESSAGE_MAX_CHARS) });
	}

	return trimHistoryContext(history.reverse(), AUTOCOMPLETE_HISTORY_CONTEXT_MAX_CHARS);
}

export function buildAutocompletePrompt(input: { cwd: string; draft: string; history: readonly AutocompleteHistoryMessage[]; maxPromptTokens?: number }): string {
	const maxPromptTokens = numberInRange(input.maxPromptTokens, AUTOCOMPLETE_MAX_PROMPT_TOKENS, 256, 16_000);
	let history = input.history.slice();
	let prompt = renderAutocompletePrompt({ ...input, history });

	while (history.length > 0 && autocompletePromptTokenEstimate(prompt) > maxPromptTokens) {
		history = history.slice(1);
		prompt = renderAutocompletePrompt({ ...input, history });
	}

	return autocompletePromptTokenEstimate(prompt) <= maxPromptTokens ? prompt : "";
}

function renderAutocompletePrompt(input: { cwd: string; draft: string; history: readonly AutocompleteHistoryMessage[] }): string {
	const lines = [
		"Complete the current terminal input for the active pix/pi coding-agent session.",
		`cwd: ${input.cwd}`,
	];

	if (input.history.length > 0) {
		lines.push(
			"",
			"Recent messages are context only; never continue them directly.",
			"<recent-active-session-messages>",
			formatAutocompleteHistory(input.history),
			"</recent-active-session-messages>",
		);
	}

	return [
		...lines,
		"",
		"Return only the suffix to append after <cursor>. Return nothing if unsure.",
		"<draft>",
		input.draft,
		"<cursor>",
		"</draft>",
	].join("\n");
}

export function autocompletePromptTokenEstimate(prompt: string, systemPrompt = AUTOCOMPLETE_SYSTEM_PROMPT): number {
	return estimateTextTokens(systemPrompt) + estimateTextTokens(prompt);
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / AUTOCOMPLETE_TOKEN_CHARS);
}

export function cleanupCompletion(output: string, draft: string, config?: Pick<AutocompleteConfig, "maxTokens">): string {
	let text = output.replace(/\r\n/gu, "\n").trimEnd();
	const fenced = /^```[^\n`]*\n([\s\S]*?)\n```$/u.exec(text.trim());
	if (fenced) text = fenced[1]!.trimEnd();
	if (text.startsWith(draft)) text = text.slice(draft.length);
	text = text
		.replace(/^<cursor>/iu, "")
		.replace(/^\s*(?:completion|suffix|autocomplete|продолжение)\s*:\s*/iu, "")
		.replace(/^\n+/u, "");
	if (!text.trim()) return "";
	const maxTokens = numberInRange(config?.maxTokens, AUTOCOMPLETE_MAX_TOKENS, 8, 256);
	const maxChars = Math.min(AUTOCOMPLETE_MAX_SUFFIX_LENGTH, maxTokens * 8);
	return text.slice(0, maxChars);
}

function formatAutocompleteHistory(history: readonly AutocompleteHistoryMessage[]): string {
	if (history.length === 0) return "(no previous user/assistant messages in this active session)";

	return history.map((message) => [
		`<message role="${message.role}">`,
		message.text.replace(/<\/message>/giu, "</ message>"),
		"</message>",
	].join("\n")).join("\n\n");
}

function assistantMessageText(message: AssistantMessage): string {
	return message.content
		.flatMap((content) => content.type === "text" ? [content.text] : [])
		.join("\n");
}

function messageText(message: Record<string, unknown>, role: AutocompleteHistoryMessage["role"]): string {
	return contentText(message.content, { includeImages: role === "user" });
}

function contentText(content: unknown, options: { includeImages: boolean }): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content.flatMap((part) => {
		if (!isRecord(part) || typeof part.type !== "string") return [];
		if (part.type === "text" && typeof part.text === "string") return [part.text];
		if (part.type === "image" && options.includeImages) return ["[image]"];
		return [];
	}).join("\n");
}

function compactHistoryText(text: string): string {
	return text
		.replace(/\r\n/gu, "\n")
		.split("\n")
		.filter((line) => !isMarkdownReferenceDefinition(line))
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

function trimHistoryContext(history: AutocompleteHistoryMessage[], maxChars: number): AutocompleteHistoryMessage[] {
	const trimmed = history.slice();
	while (trimmed.length > 0 && historyContextChars(trimmed) > maxChars) trimmed.shift();
	return trimmed;
}

function historyContextChars(history: readonly AutocompleteHistoryMessage[]): number {
	return history.reduce((sum, message) => sum + message.text.length + message.role.length + 32, 0);
}

function isMarkdownReferenceDefinition(line: string): boolean {
	return /^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/u.test(line);
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	return Math.min(max, Math.max(min, rounded));
}

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
	const abortController = new AbortController();
	const abort = (): void => abortController.abort();
	if (parent?.aborted) abort();
	else parent?.addEventListener("abort", abort, { once: true });

	const timer = setTimeout(abort, timeoutMs);
	timer.unref?.();

	return {
		signal: abortController.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", abort);
		},
	};
}
