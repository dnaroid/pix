import { createHash } from "node:crypto";

import type { NotifyKind } from "./protocol.js";
import { TOPIC_ICON_COLORS } from "./telegram-api.js";

export const TELEGRAM_TEXT_LIMIT = 4096;
/** Leave headroom for the kind prefix. */
const CHUNK = 3900;
/** Longer answers are sent as a document instead of a burst of messages. */
export const MAX_INLINE_CHUNKS = 3;
const TOPIC_NAME_LIMIT = 128;

export function topicName(project: string, title: string | undefined): string {
	const cleanProject = project.replace(/\s+/g, " ").trim() || "project";
	const cleanTitle = (title ?? "").replace(/\s+/g, " ").trim() || "new session";
	const name = `${cleanProject} · ${cleanTitle}`;
	return name.length <= TOPIC_NAME_LIMIT ? name : `${name.slice(0, TOPIC_NAME_LIMIT - 1)}…`;
}

/** Same project (by absolute path) → same topic icon color across sessions. */
export function projectIconColor(cwd: string): number {
	const digest = createHash("sha256").update(cwd).digest();
	return TOPIC_ICON_COLORS[digest[0]! % TOPIC_ICON_COLORS.length]!;
}

const PREFIX: Record<NotifyKind, string> = {
	final: "✅ ",
	waiting: "❓ ",
	aborted: "⏹ ",
	error: "⚠️ ",
};

export function notifyPrefix(kind: NotifyKind): string {
	return PREFIX[kind];
}

/** Split on paragraph/line/space boundaries; never inside a surrogate pair. */
export function splitMessage(text: string, size = CHUNK): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > size) {
		const window = rest.slice(0, size);
		let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
		if (cut < size / 2) cut = window.lastIndexOf(" ");
		if (cut < size / 2) cut = size;
		const code = rest.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).replace(/^\n+/, "");
	}
	if (rest.trim() || chunks.length === 0) chunks.push(rest);
	return chunks;
}

/** t.me deep link to a topic of a private supergroup (-100XXXXXXXXXX). */
export function topicLink(chatId: number, threadId: number): string | undefined {
	const raw = String(chatId);
	return raw.startsWith("-100") ? `https://t.me/c/${raw.slice(4)}/${threadId}` : undefined;
}

/** Strip "@BotName" and return the bare lowercase command, if any. */
export function parseCommand(text: string): { command: string; args: string } | undefined {
	const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
	return match ? { command: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() } : undefined;
}
