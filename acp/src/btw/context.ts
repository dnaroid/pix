import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BtwCommand, BtwContextInfo } from "./contract.js";

type Projection = ReturnType<AgentSession["sessionManager"]["buildSessionProjection"]>;
type Message = { role: string; content?: unknown; toolName?: string; toolCallId?: string; isError?: boolean; [key: string]: unknown };
export type BtwAsk = Extract<BtwCommand, { action: "ask" }>;

/** Bounds traversal before serialization; this is not a general secrets scanner. */
export function cleanBtwText(value: string, limit = 16_000): string {
	return value.slice(0, limit)
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\p{Cc}\p{Cf}]/gu, (char) => /[\n\r\t]/.test(char) ? char : "")
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted private key]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/gi, "[redacted]")
		.replace(/((?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[redacted]");
}

function boundedValue(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return cleanBtwText(value, 4_000);
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (depth >= 3) return "[omitted]";
	if (Array.isArray(value)) return value.slice(0, 8).map((item) => boundedValue(item, depth + 1));
	if (typeof value !== "object") return "[omitted]";
	return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, item]) => [
		key.slice(0, 100), /password|secret|credential|api.?key|authorization|private.?key|access.?token/i.test(key)
			? "[redacted]" : boundedValue(item, depth + 1),
	]));
}

function textParts(content: unknown): string {
	if (typeof content === "string") return cleanBtwText(content);
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content.slice(0, 64)) {
		if (part?.type === "text" && typeof part.text === "string") text += cleanBtwText(part.text, 16_000 - text.length) + "\n";
		if (text.length >= 16_000) break;
	}
	return text.slice(0, 16_000);
}

export interface BtwParentRecord { id: string; kind: string; text: string }

/** Use only the canonical projection, never raw history or in-flight agent state. */
export function btwParentRecords(projection: Projection): { records: BtwParentRecord[]; omitted: number } {
	// Bound retained text before cleaning/serializing it, not only the final wire payload.
	// Preserve the initial and latest user constraints even across long tool-only runs.
	const visible = projection.entries.filter((entry) => entry.messages.length > 0);
	const userEntries = visible.filter((entry) => entry.messages.some((message) => message.role === "user"));
	const selected = new Set([...visible.slice(-512), ...userEntries.slice(0, 1), ...userEntries.slice(-3)]);
	const entries = visible.filter((entry) => selected.has(entry));
	const completedCalls = new Set<string>();
	for (const entry of entries) for (const raw of entry.messages) {
		const message = raw as unknown as Message;
		if (message.role === "toolResult" && typeof message.toolCallId === "string") completedCalls.add(message.toolCallId);
	}
	const records: BtwParentRecord[] = [];
	let omitted = visible.length - entries.length;
	for (const entry of entries) for (const raw of entry.messages) {
		const message = raw as unknown as Message;
		if (message.role === "system") continue;
		let text = textParts(message.content);
		let kind = message.role;
		if (message.role === "assistant") {
			if (message.stopReason === "aborted" || message.stopReason === "error") { omitted++; continue; }
			const calls = Array.isArray(message.content) ? message.content.filter((part) => part?.type === "toolCall") : [];
			if (calls.some((call) => !completedCalls.has(call.id))) { omitted++; continue; }
			for (const call of calls.slice(0, 8)) {
				text += `\nTool request (see its separate result): ${String(call.name).slice(0, 80)} ${JSON.stringify(boundedValue(call.arguments))}`;
			}
		} else if (message.role === "toolResult") {
			kind = `tool ${String(message.toolName ?? "unknown").slice(0, 80)} ${message.isError ? "FAILED" : "result (not necessarily a mutation)"}`;
		} else if (message.role === "compactionSummary" || message.role === "branchSummary") {
			text = typeof message.summary === "string" ? cleanBtwText(message.summary) : text;
		} else if (message.role === "bashExecution") {
			if (message.excludeFromContext === true) continue;
			kind = `bash result exit=${String(message.exitCode ?? "unknown")} cancelled=${message.cancelled === true}`;
			text = typeof message.output === "string" ? cleanBtwText(message.output) : text;
		} else if (message.role !== "user" && message.role !== "custom") continue;
		if (!text.trim()) continue;
		if (text.length >= 16_000) omitted++;
		records.push({ id: entry.sourceEntry.id, kind, text: cleanBtwText(text) });
	}
	return { records, omitted };
}

/** Ancestry changes/edits reset side history; ordinary appended turns and usage do not. */
export class BtwContextTracker {
	key = randomUUID();
	private leaf: string | undefined;
	observe(branch: readonly { id: string; type: string }[]): string {
		if (this.leaf !== undefined) {
			const previous = branch.findIndex((entry) => entry.id === this.leaf);
			if (previous < 0 || branch.slice(previous + 1).some((entry) => ["context_edit", "compaction", "branch_summary"].includes(entry.type))) this.key = randomUUID();
		}
		this.leaf = branch.at(-1)?.id;
		return this.key;
	}
	invalidate(): void { this.key = randomUUID(); this.leaf = undefined; }
}

export function buildBtwInput(projection: Projection, command: BtwAsk, key: string, byteBudget: number, now: number): { input: string; context: BtwContextInfo } {
	const historyReset = command.contextKey !== key;
	const history = historyReset ? [] : command.history.map((message) => ({ role: message.role, text: cleanBtwText(message.text, 48_000) }));
	const question = cleanBtwText(command.question, 8_000);
	const excerpts = command.excerpts.map((excerpt) => ({ label: cleanBtwText(excerpt.label, 160), text: cleanBtwText(excerpt.text, 8_000) }));
	const parent = btwParentRecords(projection);
	const selected: BtwParentRecord[] = [];
	let historyClipped = false;
	let omitted = parent.omitted;
	const body = () => JSON.stringify({ parent: selected, omittedParentRecords: omitted + parent.records.length - selected.length,
		previousSideConversation: history, historyClipped, excerpts, question });
	const bytes = (value: string) => Buffer.byteLength(value, "utf8");
	// Exact current question/excerpts take priority. Old complete exchanges go first.
	while (history.length && (bytes(JSON.stringify(history)) > byteBudget / 3 || bytes(body()) > byteBudget - 1_000)) {
		history.splice(0, 2); historyClipped = true;
	}
	if (bytes(body()) > byteBudget) throw new Error("BTW question and excerpts exceed this model's context budget");
	const candidates = [...parent.records];
	const firstUser = candidates.find((record) => record.kind === "user");
	const priority = [...candidates.filter((record) => record.kind === "user").slice(-3).reverse(), ...(firstUser ? [firstUser] : []), ...candidates.toReversed()];
	const included = new Set<BtwParentRecord>();
	// Compute each candidate's contribution once. Re-serializing an ever-growing
	// payload for every record made long-session snapshots quadratic on the runtime thread.
	let remaining = byteBudget - bytes(body());
	for (const record of priority) {
		if (included.has(record)) continue;
		const size = bytes(JSON.stringify(record)) + (selected.length ? 1 : 0);
		if (size > remaining) continue;
		selected.push(record); included.add(record); remaining -= size;
	}
	const order = new Map(candidates.map((record, index) => [record, index]));
	selected.sort((a, b) => order.get(a)! - order.get(b)!);
	const input = body();
	return { input, context: { key, capturedAt: now, records: selected.length, inputChars: input.length,
		truncated: omitted > 0 || selected.length < parent.records.length || historyClipped, historyReset: historyReset && command.history.length > 0 } };
}
