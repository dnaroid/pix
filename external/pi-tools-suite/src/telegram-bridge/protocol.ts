/**
 * Local NDJSON protocol between session extensions (clients) and the single
 * broker that owns Telegram polling. Every pi session process on the machine,
 * across all projects and Desktop windows, connects to the same broker socket.
 */

export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_NOTIFY_TEXT = 200_000;

export type NotifyKind = "final" | "waiting" | "aborted" | "error";

export type ClientMessage =
	| { t: "register"; sessionId: string; project: string; cwd: string; title?: string }
	| { t: "rename"; sessionId: string; title: string }
	| { t: "unregister"; sessionId: string }
	| { t: "notify"; sessionId: string; kind: NotifyKind; text: string }
	| { t: "ack"; sessionId: string; requestId: string; ok: boolean; error?: string };

export type BrokerMessage =
	| { t: "prompt"; sessionId: string; requestId: string; text: string }
	| { t: "stop"; sessionId: string; requestId: string };

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const NOTIFY_KINDS = new Set<NotifyKind>(["final", "waiting", "aborted", "error"]);

function str(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length <= max;
}

export function parseClientMessage(value: unknown): ClientMessage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const m = value as Record<string, unknown>;
	if (!str(m.sessionId, 256) || !SESSION_ID.test(m.sessionId)) return undefined;
	const sessionId = m.sessionId;
	switch (m.t) {
		case "register":
			if (!str(m.project, 512) || !str(m.cwd, 4096) || (m.title !== undefined && !str(m.title, 1024))) return undefined;
			return { t: "register", sessionId, project: m.project, cwd: m.cwd, ...(m.title !== undefined ? { title: m.title } : {}) };
		case "rename":
			return str(m.title, 1024) ? { t: "rename", sessionId, title: m.title } : undefined;
		case "unregister":
			return { t: "unregister", sessionId };
		case "notify":
			return NOTIFY_KINDS.has(m.kind as NotifyKind) && str(m.text, MAX_NOTIFY_TEXT)
				? { t: "notify", sessionId, kind: m.kind as NotifyKind, text: m.text } : undefined;
		case "ack":
			if (!str(m.requestId, 128) || typeof m.ok !== "boolean" || (m.error !== undefined && !str(m.error, 2000))) return undefined;
			return { t: "ack", sessionId, requestId: m.requestId, ok: m.ok, ...(m.error !== undefined ? { error: m.error } : {}) };
		default:
			return undefined;
	}
}

export function parseBrokerMessage(value: unknown): BrokerMessage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const m = value as Record<string, unknown>;
	if (!str(m.sessionId, 256) || !str(m.requestId, 128)) return undefined;
	if (m.t === "prompt" && str(m.text, MAX_NOTIFY_TEXT)) return { t: "prompt", sessionId: m.sessionId, requestId: m.requestId, text: m.text };
	if (m.t === "stop") return { t: "stop", sessionId: m.sessionId, requestId: m.requestId };
	return undefined;
}

/** Incremental LF-delimited JSON reader with a per-line size bound. */
export class LineDecoder {
	private buffer = "";
	private overflow = false;

	constructor(private readonly onLine: (value: unknown) => void, private readonly maxBytes = MAX_LINE_BYTES) {}

	push(chunk: string): void {
		let start = 0;
		for (let index = chunk.indexOf("\n"); index !== -1; index = chunk.indexOf("\n", start)) {
			const piece = chunk.slice(start, index);
			start = index + 1;
			if (this.overflow) { this.overflow = false; this.buffer = ""; continue; }
			const line = this.buffer + piece;
			this.buffer = "";
			if (!line.trim()) continue;
			try { this.onLine(JSON.parse(line)); } catch { /* Malformed peer line: ignore. */ }
		}
		if (this.overflow) return;
		this.buffer += chunk.slice(start);
		if (this.buffer.length > this.maxBytes) { this.buffer = ""; this.overflow = true; }
	}
}

export function encodeLine(message: ClientMessage | BrokerMessage): string {
	return `${JSON.stringify(message)}\n`;
}
