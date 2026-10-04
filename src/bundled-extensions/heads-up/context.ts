/** Bounded transcript data, never executable instructions or hidden thinking. */
export interface ContextRecord {
	readonly id: string;
	readonly kind: "user" | "assistant" | "tool" | "delegated";
	readonly text: string;
	readonly clipped?: boolean;
}
export interface MessageLike { readonly role: string; readonly content?: unknown; readonly toolName?: string; readonly isError?: boolean; }
const MAX_RECORDS = 64;
const MAX_RECORD_CHARS = 3000;
const SENSITIVE_KEY = /(?:password|passwd|secret|credential|api[_-]?key|access[_-]?token|authorization|private[_-]?key)/i;

/** Best-effort redaction, not a guarantee that arbitrary repository data is secret-free. */
export function cleanObserverText(value: string, max = MAX_RECORD_CHARS): string {
	const cleaned = value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\p{Cf}\p{Cc}]/gu, (char) => /[\n\r\t]/.test(char) ? char : "")
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted private key]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/gi, "[redacted]")
		.replace(/((?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[redacted]")
		.trim();
	return cleaned.length <= max ? cleaned : `${cleaned.slice(0, Math.max(0, max - 1)).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return cleanObserverText(content.slice(0, MAX_RECORD_CHARS * 2));
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content.slice(0, 32)) {
		if (part?.type === "text" && typeof part.text === "string") text += `${part.text.slice(0, MAX_RECORD_CHARS * 2)}\n`;
		if (text.length >= MAX_RECORD_CHARS) break;
	}
	return cleanObserverText(text);
}

/** Bound traversal before serializing tool arguments (no large object stringify). */
function boundedValue(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return cleanObserverText(value.slice(0, 1200), 600);
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (depth >= 3) return "[omitted]";
	if (Array.isArray(value)) return value.slice(0, 6).map((item) => boundedValue(item, depth + 1));
	if (typeof value !== "object") return "[omitted]";
	return Object.fromEntries(Object.entries(value).slice(0, 10).map(([key, item]) => [
		cleanObserverText(key, 80), SENSITIVE_KEY.test(key) ? "[redacted]" : boundedValue(item, depth + 1),
	]));
}

export function recordsFromMessage(message: MessageLike, id: string): ContextRecord[] {
	if (!id || id.length > 128) return [];
	if (!["user", "assistant", "toolResult"].includes(message.role)) return [];
	let text = textOfContent(message.content);
	if (message.role === "assistant" && Array.isArray(message.content)) {
		const calls = message.content.slice(0, 32).filter((part) => part?.type === "toolCall").slice(0, 6);
		for (const call of calls) text += `\nTool request ${cleanObserverText(String(call.name), 80)}: ${JSON.stringify(boundedValue(call.arguments)).slice(0, 1000)}`;
	}
	if (message.role === "toolResult") text = `Tool ${cleanObserverText(message.toolName ?? "unknown", 80)} (${message.isError ? "error" : "result"}): ${text}`;
	const clipped = text.length >= MAX_RECORD_CHARS || text.endsWith("…");
	text = cleanObserverText(text);
	return text ? [{ id, kind: message.role === "toolResult" ? "tool" : message.role as "user" | "assistant", text, ...(clipped ? { clipped: true } : {}) }] : [];
}

export class HeadsUpContext {
	private records: ContextRecord[] = [];
	private firstUser: ContextRecord | undefined;
	private omitted = 0;

	reset(records: readonly ContextRecord[] = []): void {
		this.records = []; this.firstUser = undefined; this.omitted = 0;
		for (const record of records) this.add(record);
	}
	add(record: ContextRecord): void {
		if (!record.id || record.id.length > 128) return;
		const text = cleanObserverText(record.text);
		if (!text) return;
		const normalized = { ...record, text, ...(text !== record.text ? { clipped: true } : {}) };
		if (record.kind === "user" && !this.firstUser) this.firstUser = normalized;
		this.records = this.records.filter((entry) => entry.id !== record.id);
		this.records.push(normalized);
		if (this.records.length > MAX_RECORDS) { this.records.shift(); this.omitted++; }
	}
	addMessage(message: MessageLike, id: string): void { for (const record of recordsFromMessage(message, id)) this.add(record); }
	addTurn(message: MessageLike, id: string, results: readonly MessageLike[], resultIds: readonly string[]): void {
		this.addMessage(message, id);
		results.forEach((result, index) => { const resultId = resultIds[index]; if (resultId) this.addMessage(result, resultId); });
	}

	/** Exact serialized payload bound, including JSON escaping and feedback. */
	toInput(maxChars: number, previous: readonly string[] = []): { records: ContextRecord[]; body: string } {
		const chosen = new Map<string, ContextRecord>();
		// Feedback must not crowd all evidence out when a small context limit is configured.
		const past: string[] = [];
		for (const text of previous.slice(-16).toReversed()) {
			const candidate = cleanObserverText(text, 400);
			if (JSON.stringify([candidate, ...past]).length > maxChars / 4) break;
			past.unshift(candidate);
		}
		const serialize = () => JSON.stringify({ records: [...chosen.values()], omitted: this.omitted + this.records.filter((entry) => !chosen.has(entry.id)).length, previousNotices: past });
		const add = (record: ContextRecord) => {
			if (chosen.has(record.id)) return;
			chosen.set(record.id, record);
			if (serialize().length > maxChars) chosen.delete(record.id);
		};
		// Latest instructions get priority; the original request survives long tool sequences.
		for (const record of this.records.filter((entry) => entry.kind === "user").slice(-3).reverse()) add(record);
		if (this.firstUser) add(this.firstUser);
		for (const record of this.records.toReversed()) add(record);
		return { records: [...chosen.values()], body: serialize() };
	}
	snapshot(): readonly ContextRecord[] { return this.records.slice(); }
}
