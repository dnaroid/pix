import { complete } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionTitleConfig } from "./config.js";

type SessionEntryLike = {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

type TextContentLike = {
	type?: string;
	text?: unknown;
};

type TitleModelRegistry = {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKeyAndHeaders(model: Model<Api>): Promise<
		| { ok: true; apiKey?: string; headers?: Record<string, string> }
		| { ok: false; error: string }
	>;
};

const TITLE_SYSTEM_PROMPT = [
	"You name Pi coding-agent sessions from the user's first request.",
	"Return only one concise title, without quotes, markdown, emoji, or explanations.",
	"Use the same language as the task when possible.",
	"Keep it specific, 3-7 words, and under the requested character limit.",
].join("\n");

function parseModelRef(modelRef: string): { provider: string; modelId: string } | undefined {
	const trimmed = modelRef.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function messageContentText(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;

	const text = content
		.filter((block: TextContentLike): block is { type: string; text: string } => (
			block?.type === "text" && typeof block.text === "string"
		))
		.map((block) => block.text)
		.join("\n")
		.trim();

	return text || undefined;
}

export function firstUserMessageText(entries: readonly SessionEntryLike[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = messageContentText(entry.message.content);
		if (text) return text;
	}
	return undefined;
}

export function fallbackSessionTitleFromInput(input: string, maxTitleChars: number): string | undefined {
	const normalized = input
		.replace(/[\t\r\n]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.replace(/^[`"'«»“”()[\]{}<>.,:;!?~@#$%^&*_+=\\/|\-]+/gu, "")
		.trim();

	if (!normalized) return undefined;

	const words = normalized.split(/\s+/u).filter(Boolean);
	if (words.length === 0) return undefined;

	const selected: string[] = [];
	for (const word of words) {
		const next = selected.length === 0 ? word : `${selected.join(" ")} ${word}`;
		if (selected.length > 0 && next.length > maxTitleChars) break;
		selected.push(word);
		if (selected.length >= 8) break;
	}

	const candidate = selected.join(" ");
	return sanitizeSessionTitle(candidate || normalized, maxTitleChars);
}

function buildTitlePrompt(input: string, maxTitleChars: number): string {
	return [
		`Generate a session title under ${maxTitleChars} characters for this session.`,
		"If a parent session title is provided, use it only as context and focus on the new request.",
		"Output only the title.",
		"",
		"<session_context>",
		input,
		"</session_context>",
	].join("\n");
}

function responseText(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

export function sanitizeSessionTitle(raw: string, maxTitleChars: number): string | undefined {
	let title = raw
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean) ?? "";

	title = title
		.replace(/^```(?:\w+)?\s*/u, "")
		.replace(/```$/u, "")
		.replace(/^(?:title|название|имя сессии)\s*[:—-]\s*/iu, "")
		.replace(/["'`«»“”]+/gu, "")
		.replace(/[\t\r\n]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.replace(/[.。!！?？,:;]+$/u, "")
		.trim();

	if (!title) return undefined;
	if (title.length > maxTitleChars) {
		title = title.slice(0, maxTitleChars).trimEnd().replace(/[\s,;:—-]+$/u, "");
	}
	return title || undefined;
}

export function sessionTitleModelRefs(config: SessionTitleConfig): string[] {
	return [config.model, ...config.fallbackModels]
		.map((modelRef) => modelRef.trim())
		.filter(Boolean)
		.filter((modelRef, index, refs) => refs.indexOf(modelRef) === index);
}

export async function generateSessionTitle(
	input: string,
	modelRegistry: TitleModelRegistry,
	config: SessionTitleConfig,
	modelRef: string,
	signal: AbortSignal,
	onWarning?: (message: string) => void,
): Promise<string | undefined> {
	const parsedModel = parseModelRef(modelRef);
	if (!parsedModel) {
		onWarning?.(`Invalid session-title model: ${modelRef}`);
		return undefined;
	}

	const model = modelRegistry.find(parsedModel.provider, parsedModel.modelId);
	if (!model) {
		onWarning?.(`Session-title model not found: ${modelRef}`);
		return undefined;
	}

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) {
		onWarning?.(auth.error);
		return undefined;
	}

	const response = await complete(
		model,
		{
			systemPrompt: TITLE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildTitlePrompt(input, config.maxTitleChars) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
			...(auth.headers === undefined ? {} : { headers: auth.headers }),
			cacheRetention: "none",
			maxRetries: config.maxRetries,
			maxTokens: config.maxTokens,
			signal,
			timeoutMs: config.timeoutMs,
		},
	);

	return sanitizeSessionTitle(responseText(response), config.maxTitleChars);
}
