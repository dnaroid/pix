import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { HeadsUpNotice } from "./contract.js";
import { cleanObserverText, type ContextRecord } from "./context.js";

export type ParsedHeadsUp = { kind: "none" } | { kind: "invalid" } | { kind: "notice"; notice: HeadsUpNotice };

export function parseHeadsUpResponse(message: AssistantMessage, records: readonly ContextRecord[], now: number, ttlMs: number): ParsedHeadsUp {
	if (message.stopReason !== "stop" || message.content.some((part) => part.type === "toolCall")) return { kind: "invalid" };
	let text = "";
	for (const part of message.content) {
		if (part.type === "text") text += part.text;
		if (text.length > 8000) return { kind: "invalid" };
	}
	let value: unknown;
	try { value = JSON.parse(text); } catch { return { kind: "invalid" }; }
	if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid" };
	const object = value as Record<string, unknown>;
	const keys = Object.keys(object);
	if (object.kind === "none") return { kind: keys.length === 1 ? "none" : "invalid" };
	if (object.kind !== "heads_up" || keys.length !== 4 || keys.some((key) => !["kind", "title", "consequence", "evidenceIds"].includes(key))) return { kind: "invalid" };
	if (typeof object.title !== "string" || object.title.length > 160 || typeof object.consequence !== "string" || object.consequence.length > 500) return { kind: "invalid" };
	const title = cleanObserverText(object.title, 160).replace(/\s+/g, " ");
	const consequence = cleanObserverText(object.consequence, 500).replace(/\s+/g, " ");
	if (!title || !consequence || !Array.isArray(object.evidenceIds) || object.evidenceIds.length < 1 || object.evidenceIds.length > 4) return { kind: "invalid" };
	const byId = new Map(records.map((record) => [record.id, record]));
	const ids = object.evidenceIds;
	if (ids.some((id) => typeof id !== "string" || !byId.has(id)) || new Set(ids).size !== ids.length) return { kind: "invalid" };
	return { kind: "notice", notice: {
		id: randomUUID(), title, consequence,
		evidence: (ids as string[]).map((id) => ({ id, text: cleanObserverText(byId.get(id)!.text, 1500) })),
		createdAt: now, expiresAt: now + ttlMs,
	} };
}
