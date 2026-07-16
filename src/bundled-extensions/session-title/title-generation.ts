import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
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

type TitleModelRuntime = Pick<ModelRuntime, "getModel" | "completeSimple">;

export const TITLE_SYSTEM_PROMPT = [
	"You name Pi coding-agent sessions from the user's first request.",
	"Return only one concise title, without quotes, markdown, emoji, or explanations.",
	"Use the same language as the task when possible.",
	"Keep it specific, 3-7 words, and under the requested character limit.",
].join("\n");

export function parseTitleModelRef(modelRef: string): { provider: string; modelId: string } | undefined {
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

export function buildTitlePrompt(input: string, maxTitleChars: number): string {
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

export function titleResponseText(response: { content: Array<{ type: string; text?: string }> }): string {
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

/** Host-side title generation through the canonical SDK ModelRuntime. */
export async function generateSessionTitleWithRuntime(
	input: string,
	modelRuntime: TitleModelRuntime,
	config: SessionTitleConfig,
	modelRef: string,
	signal: AbortSignal,
	onWarning?: (message: string) => void,
): Promise<string | undefined> {
	const parsedModel = parseTitleModelRef(modelRef);
	if (!parsedModel) {
		onWarning?.(`Invalid session-title model: ${modelRef}`);
		return undefined;
	}

	const model = modelRuntime.getModel(parsedModel.provider, parsedModel.modelId);
	if (!model) {
		onWarning?.(`Session-title model not found: ${modelRef}`);
		return undefined;
	}

	const response = await modelRuntime.completeSimple(
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
			cacheRetention: "none",
			maxRetries: config.maxRetries,
			maxTokens: config.maxTokens,
			signal,
			timeoutMs: config.timeoutMs,
		},
	);

	return sanitizeSessionTitle(titleResponseText(response), config.maxTitleChars);
}
