// Durable parent-session journal for the headless CLI (decision 0072).
//
// Every headless call runs in its own process and has no Pi session file, so
// sub-agent records written by the spawning broker would be invisible to a
// later `status`/`result` process. With a stable host session key the
// headless "parent" gets a deterministic UUID scope and an append-only
// JSONL journal in Pi session format next to its child sessions:
// `<cwd>/.pi/subagents/<scope>/headless-parent.jsonl`.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getRunRoot } from "../async-subagents/core/paths.js";
import { diagnosticErrorType, suiteDiagnostics } from "../lib/suite-diagnostics.js";

export const HEADLESS_PARENT_FILE = "headless-parent.jsonl";
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;

export interface HeadlessSessionManager {
	getSessionId(): string;
	getSessionFile(): undefined;
	getCwd(): string;
	getEntries?(): ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>;
	appendCustomEntry?(customType: string, data?: unknown): string;
}

/** Deterministic UUID-shaped scope for one project + host session key. */
export function headlessScopeId(root: string, sessionKey: string): string {
	const hex = createHash("sha256").update(`pix-headless\0${root}\0${sessionKey}`).digest("hex");
	const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function headlessJournalFile(root: string, sessionKey: string): string {
	return path.join(getRunRoot(root), headlessScopeId(root, sessionKey), HEADLESS_PARENT_FILE);
}

/**
 * Session manager for the headless host. Without a session key the scope is
 * per-process (records stay in memory, as before); with a key, sub-agent
 * records are persisted to and hydrated from the journal.
 */
export function createHeadlessSessionManager(root: string, sessionKey?: string): HeadlessSessionManager {
	if (!sessionKey) {
		return { getSessionId: () => "headless", getSessionFile: () => undefined, getCwd: () => root };
	}
	const id = headlessScopeId(root, sessionKey);
	const file = headlessJournalFile(root, sessionKey);
	return {
		getSessionId: () => id,
		getSessionFile: () => undefined,
		getCwd: () => root,
		getEntries() {
			let text: string;
			try {
				if (statSync(file).size > MAX_JOURNAL_BYTES) throw new Error("Headless subagent journal exceeds the 32 MiB read limit; archive it before continuing.");
				text = readFileSync(file, "utf8");
				if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES) throw new Error("Headless subagent journal exceeds the 32 MiB read limit; archive it before continuing.");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				suiteDiagnostics.report("error", "subagents", "journal-read-failed", root, { errorType: diagnosticErrorType(error) });
				throw error;
			}
			const entries: Array<{ type?: string; customType?: string; data?: unknown }> = [];
			// Concurrent appenders may leave a partial trailing line; skip it.
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line) as { type?: string; customType?: string; data?: unknown };
					if (entry?.type === "custom") entries.push(entry);
				} catch {
					/* partial or corrupt line */
				}
			}
			return entries;
		},
		appendCustomEntry(customType: string, data?: unknown) {
			mkdirSync(path.dirname(file), { recursive: true });
			const timestamp = new Date().toISOString();
			let prefix = "";
			if (!existsSync(file)) {
				prefix = `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: root })}\n`;
			}
			const entryId = randomUUID().slice(0, 8);
			// One write per line keeps concurrent CLI/broker appends line-atomic in practice.
			appendFileSync(file, `${prefix}${JSON.stringify({ type: "custom", id: entryId, parentId: null, timestamp, customType, data })}\n`, { mode: 0o600 });
			return entryId;
		},
	};
}
