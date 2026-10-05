import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { MAX_HEADS_UP_NOTICES, type HeadsUpNotice } from "./contract.js";
import { cleanObserverText, type ContextRecord } from "./context.js";

export type ParsedHeadsUp = { kind: "none" } | { kind: "invalid" } | { kind: "notice"; notices: HeadsUpNotice[] };

export function parseHeadsUpResponse(message: AssistantMessage, records: readonly ContextRecord[], now: number, ttlMs: number, active: readonly HeadsUpNotice[] = []): ParsedHeadsUp {
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
	if (object.kind !== "heads_up" || keys.length !== 2 || !Array.isArray(object.notices) || object.notices.length < 1 || object.notices.length > MAX_HEADS_UP_NOTICES) return { kind: "invalid" };
	const notices: HeadsUpNotice[] = [];
	const activeIds = new Set(active.map((card) => card.id));
	const retainedIds = new Set<string>();
	for (const value of object.notices) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid" };
		const item = value as Record<string, unknown>;
		const hasIdentity = "topic" in item || "subject" in item;
		if (Object.keys(item).length !== (hasIdentity ? 6 : 4) || Object.keys(item).some((key) => !["id", "title", "consequence", "evidenceIds", "topic", "subject"].includes(key))) return { kind: "invalid" };
		if (hasIdentity && (!validIdentity(item.topic, 80) || !validIdentity(item.subject, 160))) return { kind: "invalid" };
		if (item.id !== null && (typeof item.id !== "string" || !activeIds.has(item.id) || retainedIds.has(item.id))) return { kind: "invalid" };
		const existing = active.find((card) => card.id === item.id);
		// Legacy cards can gain an identity on review; once present it is immutable.
		if (existing?.topic && hasIdentity && (existing.topic !== item.topic || existing.subject !== item.subject)) return { kind: "invalid" };
		if (existing?.topic && !hasIdentity) { item.topic = existing.topic; item.subject = existing.subject; }
		if (typeof item.id === "string") retainedIds.add(item.id);
		const notice = parseNotice(item, records, now, ttlMs);
		if (!notice) return { kind: "invalid" };
		notices.push(notice);
	}
	return { kind: "notice", notices };
}

function validIdentity(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length <= max && value.trim().length > 0 && cleanObserverText(value, max) === value && !/[\r\n\t]/.test(value);
}

function parseNotice(object: Record<string, unknown>, records: readonly ContextRecord[], now: number, ttlMs: number): HeadsUpNotice | undefined {
	if (typeof object.title !== "string" || object.title.length > 160 || typeof object.consequence !== "string" || object.consequence.length > 500) return undefined;
	const title = cleanObserverText(object.title, 160).replace(/\s+/g, " ");
	const consequence = cleanObserverText(object.consequence, 500).replace(/\s+/g, " ");
	if (!title || !consequence || !Array.isArray(object.evidenceIds) || object.evidenceIds.length < 1 || object.evidenceIds.length > 4) return undefined;
	const byId = new Map(records.map((record) => [record.id, record]));
	const ids = object.evidenceIds;
	if (ids.some((id) => typeof id !== "string" || !byId.has(id)) || new Set(ids).size !== ids.length) return undefined;
	return {
		id: typeof object.id === "string" ? object.id : randomUUID(), title, consequence,
		...(typeof object.topic === "string" && typeof object.subject === "string" ? { topic: object.topic, subject: object.subject } : {}),
		evidence: (ids as string[]).map((id) => ({ id, text: cleanObserverText(byId.get(id)!.text, 1500) })),
		createdAt: now, expiresAt: now + ttlMs,
	};
}
