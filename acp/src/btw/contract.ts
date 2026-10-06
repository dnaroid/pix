/** Desktop-only side inference. Pure data shared by RPC, ACP and the UI. */
export const BTW_METHOD = "pix/session/btw";
export const BTW_CHANNEL = "btw";
export const BTW_RPC_PREFIX = "\u0000pix:btw:";
export const BTW_MAX_QUESTION = 8_000;
export const BTW_MAX_HISTORY = 40;
export const BTW_MAX_HISTORY_CHARS = 48_000;
export const BTW_MAX_EXCERPTS = 4;
export const BTW_MAX_EXCERPT_CHARS = 8_000;
export const BTW_MAX_RESPONSE = 32_000;
export const BTW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type BtwThinkingLevel = (typeof BTW_THINKING_LEVELS)[number];

export function isBtwThinkingLevel(value: unknown): value is BtwThinkingLevel {
	return typeof value === "string" && (BTW_THINKING_LEVELS as readonly string[]).includes(value);
}

export interface BtwMessage {
	readonly role: "user" | "assistant";
	readonly text: string;
}

export interface BtwExcerpt {
	readonly label: string;
	readonly text: string;
}

export type BtwCommand =
	| { readonly action: "state" }
	| { readonly action: "cancel"; readonly requestId: string; readonly runtimeId: string }
	| {
		readonly action: "ask";
		readonly requestId: string;
		readonly runtimeId: string;
		readonly question: string;
		readonly history: readonly BtwMessage[];
		readonly excerpts: readonly BtwExcerpt[];
		/** Undefined means use the parent's resolved model at submission time. */
		readonly modelRef?: string;
		/** Undefined inherits the parent's effort, clamped to the selected model. */
		readonly thinkingLevel?: BtwThinkingLevel;
		/** History is dropped, not silently reused, after a context replacement. */
		readonly contextKey?: string;
	};

export type BtwRequest = BtwCommand & { readonly sessionId: string };

export interface BtwState {
	readonly runtimeId: string;
	readonly contextKey: string;
	readonly busyRequestId: string | null;
}

export interface BtwContextInfo {
	readonly key: string;
	readonly capturedAt: number;
	readonly records: number;
	readonly inputChars: number;
	readonly truncated: boolean;
	readonly historyReset: boolean;
}

/** Cumulative text + sequence lets clients ignore late/out-of-order progress. */
export interface BtwEvent {
	readonly version: 1;
	readonly runtimeId: string;
	readonly requestId: string;
	readonly sequence: number;
	readonly phase: "streaming" | "done" | "cancelled" | "error" | "reset";
	readonly text: string;
	/** Cancellation may finish the UI before a provider releases its physical slot. */
	readonly busyRequestId?: string | null;
	readonly modelRef?: string;
	/** Effective effort captured for this request, not the next draft's selection. */
	readonly thinkingLevel?: BtwThinkingLevel;
	readonly context?: BtwContextInfo;
	readonly error?: string;
	readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function id(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
}

/** Do not let malformed private commands fall through to the parent prompt. */
export function parseBtwCommand(value: unknown): BtwCommand {
	if (!object(value)) throw new Error("Invalid BTW command");
	if (value.action === "state") return { action: "state" };
	if (!id(value.requestId) || !id(value.runtimeId)) throw new Error("Invalid BTW request identity");
	if (value.action === "cancel") return { action: "cancel", requestId: value.requestId, runtimeId: value.runtimeId };
	if (value.action !== "ask" || typeof value.question !== "string" || !value.question.trim()
		|| value.question.length > BTW_MAX_QUESTION) throw new Error("BTW question is empty or too long");
	if (!Array.isArray(value.history) || value.history.length > BTW_MAX_HISTORY
		|| !value.history.every((message) => object(message) && (message.role === "user" || message.role === "assistant")
			&& typeof message.text === "string" && message.text.length <= BTW_MAX_HISTORY_CHARS)) throw new Error("Invalid BTW history");
	const history = value.history.map((message) => ({ role: message.role as BtwMessage["role"], text: message.text as string }));
	if (history.reduce((sum, message) => sum + message.text.length, 0) > BTW_MAX_HISTORY_CHARS) throw new Error("BTW history is too long");
	if (!Array.isArray(value.excerpts) || value.excerpts.length > BTW_MAX_EXCERPTS
		|| !value.excerpts.every((excerpt) => object(excerpt) && typeof excerpt.label === "string" && excerpt.label.length <= 160
			&& typeof excerpt.text === "string" && excerpt.text.length > 0 && excerpt.text.length <= BTW_MAX_EXCERPT_CHARS)) throw new Error("Invalid BTW excerpts");
	if (value.modelRef !== undefined && (typeof value.modelRef !== "string" || value.modelRef.length > 256
		|| !/^[^\s/]+\/[^\s]+$/.test(value.modelRef))) throw new Error("Invalid BTW model");
	if (value.contextKey !== undefined && !id(value.contextKey)) throw new Error("Invalid BTW context key");
	if (value.thinkingLevel !== undefined && !isBtwThinkingLevel(value.thinkingLevel)) throw new Error("Invalid BTW thinking level");
	return {
		action: "ask", requestId: value.requestId, runtimeId: value.runtimeId, question: value.question,
		history, excerpts: value.excerpts.map((excerpt) => ({ label: excerpt.label as string, text: excerpt.text as string })),
		...(typeof value.modelRef === "string" ? { modelRef: value.modelRef } : {}),
		...(isBtwThinkingLevel(value.thinkingLevel) ? { thinkingLevel: value.thinkingLevel } : {}),
		...(typeof value.contextKey === "string" ? { contextKey: value.contextKey } : {}),
	};
}

export function parseBtwState(value: unknown): BtwState {
	if (!object(value) || !id(value.runtimeId) || !id(value.contextKey)
		|| !(value.busyRequestId === null || id(value.busyRequestId))) throw new Error("Invalid BTW state");
	return { runtimeId: value.runtimeId, contextKey: value.contextKey, busyRequestId: value.busyRequestId };
}

export function parseBtwEvent(value: unknown): BtwEvent | undefined {
	if (!object(value) || value.version !== 1 || !id(value.runtimeId) || !id(value.requestId)
		|| !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0
		|| !["streaming", "done", "cancelled", "error", "reset"].includes(String(value.phase))
		|| typeof value.text !== "string" || value.text.length > BTW_MAX_RESPONSE) return;
	if (value.busyRequestId !== undefined && value.busyRequestId !== null && !id(value.busyRequestId)) return;
	if (value.modelRef !== undefined && (typeof value.modelRef !== "string" || value.modelRef.length > 256)) return;
	if (value.thinkingLevel !== undefined && !isBtwThinkingLevel(value.thinkingLevel)) return;
	if (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 500)) return;
	if (value.context !== undefined) {
		const c = value.context;
		if (!object(c) || !id(c.key) || !Number.isSafeInteger(c.capturedAt) || Number(c.capturedAt) < 0
			|| !Number.isSafeInteger(c.records) || Number(c.records) < 0
			|| !Number.isSafeInteger(c.inputChars) || Number(c.inputChars) < 0
			|| typeof c.truncated !== "boolean" || typeof c.historyReset !== "boolean") return;
	}
	if (value.usage !== undefined && (!object(value.usage)
		|| ![value.usage.inputTokens, value.usage.outputTokens].every((n) => Number.isSafeInteger(n) && Number(n) >= 0))) return;
	return value as unknown as BtwEvent;
}
