import { SessionManager, type SessionEntry, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../guards.js";
import { renderContent, renderUserMessageContent } from "../rendering/message-content.js";
import { sanitizeText } from "../rendering/render-text.js";
import type { Entry, PixMenuItem } from "../types.js";

const DEFAULT_MAX_SEARCH_RESULTS = 50;
const DEFAULT_SNIPPET_LENGTH = 160;
const DEFAULT_SCROLL_SAMPLE_LENGTH = 80;

export type SessionSearchMatch = {
	sessionEntryId?: string;
	role?: string;
	text: string;
	matchIndex: number;
};

export type SessionSearchResult = {
	session: SessionInfo;
	query: string;
	snippet: string;
	match: SessionSearchMatch;
};

export type SessionSearchOptions = {
	cwd: string;
	maxResults?: number;
	snippetLength?: number;
	onProgress?: (loaded: number, total: number) => void;
};

export async function searchSessions(query: string, options: SessionSearchOptions): Promise<SessionSearchResult[]> {
	const needle = normalizeSearchText(query);
	if (!needle) return [];

	const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS);
	const sessions = await SessionManager.list(options.cwd, undefined, options.onProgress);
	const results: SessionSearchResult[] = [];

	for (const session of sessions) {
		if (results.length >= maxResults) break;
		if (!normalizeSearchText(session.allMessagesText).includes(needle)) continue;

		const match = findSessionMatch(session, needle);
		if (!match) continue;

		results.push({
			session,
			query,
			snippet: createSearchSnippet(match.text, needle, options.snippetLength ?? DEFAULT_SNIPPET_LENGTH),
			match,
		});
	}

	return results;
}

export function createSessionSearchMenuItems(results: readonly SessionSearchResult[]): PixMenuItem<SessionSearchResult>[] {
	return results.map((result) => {
		const title = sessionSearchResultTitle(result.session);
		const { date, time } = formatSessionSearchDateTime(result.session.modified);
		const messages = `${result.session.messageCount} msg${result.session.messageCount !== 1 ? "s" : ""}`;
		return {
			value: result,
			label: title,
			description: `${result.snippet}  ·  ${date} ${time} · ${messages} · ${result.session.id.slice(0, 8)}`,
			keywords: [
				result.session.id,
				result.session.name ?? "",
				result.session.firstMessage,
				result.snippet,
				result.match.role ?? "",
			].filter(Boolean),
		};
	});
}

export function searchResultTargetEntry(entries: readonly Entry[], result: SessionSearchResult): Entry | undefined {
	const targetSessionEntryId = result.match.sessionEntryId;
	if (targetSessionEntryId) {
		const userEntry = entries.find((entry): entry is Extract<Entry, { kind: "user" }> => (
			entry.kind === "user" && entry.sessionEntryId === targetSessionEntryId
		));
		if (userEntry) return userEntry;
	}

	const queryNeedle = normalizeSearchText(result.query);
	if (queryNeedle) {
		const queryMatch = entries.find((entry) => normalizeSearchText(entrySearchText(entry)).includes(queryNeedle));
		if (queryMatch) return queryMatch;
	}

	const matchNeedle = normalizeSearchText(result.match.text);
	if (!matchNeedle) return undefined;
	return entries.find((entry) => {
		const text = normalizeSearchText(entrySearchText(entry));
		return text.includes(matchNeedle) || matchNeedle.includes(text);
	});
}

export function searchResultScrollNeedles(result: SessionSearchResult): string[] {
	const needle = normalizeSearchText(result.query);
	return uniqueNonEmptyStrings([
		createSearchSample(result.match.text, needle, DEFAULT_SCROLL_SAMPLE_LENGTH),
		stripSnippetEllipses(result.snippet),
		result.query,
	]);
}

function findSessionMatch(session: SessionInfo, needle: string): SessionSearchMatch | undefined {
	try {
		const manager = SessionManager.open(session.path);
		for (const entry of manager.getBranch()) {
			const text = sessionEntrySearchText(entry);
			if (!text) continue;

			const matchIndex = normalizeSearchText(text).indexOf(needle);
			if (matchIndex < 0) continue;

			const role = sessionEntryRole(entry);
			return {
				sessionEntryId: entry.id,
				...(role === undefined ? {} : { role }),
				text,
				matchIndex,
			};
		}
	} catch {
		return undefined;
	}

	return undefined;
}

function sessionEntrySearchText(entry: SessionEntry): string {
	if (entry.type === "message") return messageSearchText(entry.message);
	if (entry.type === "custom_message") return renderUserMessageContent(entry.content);
	if (entry.type === "compaction") return entry.summary;
	if (entry.type === "branch_summary") return entry.summary;
	return "";
}

function sessionEntryRole(entry: SessionEntry): string | undefined {
	if (entry.type === "custom_message") return entry.customType;
	if (entry.type !== "message" || !isRecord(entry.message)) return entry.type;
	return typeof entry.message.role === "string" ? entry.message.role : entry.type;
}

function messageSearchText(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return message.role === "user" ? renderUserMessageContent(content) : renderContent(content);
}

function entrySearchText(entry: Entry): string {
	switch (entry.kind) {
		case "tool":
			return `${entry.toolName}\n${entry.argsText}\n${entry.output}`;
		case "shell":
			return `${entry.command}\n${entry.output}`;
		case "user":
		case "assistant":
		case "custom":
		case "system":
		case "session-aborted":
		case "thinking":
		case "error":
		case "queued":
			return entry.text;
	}
}

function createSearchSnippet(text: string, needle: string, maxLength: number): string {
	const compact = compactDisplayText(text);
	const normalized = normalizeSearchText(compact);
	const matchIndex = normalized.indexOf(needle);
	if (matchIndex < 0) return compact.slice(0, maxLength);

	const safeMaxLength = Math.max(20, maxLength);
	const context = Math.max(10, Math.floor((safeMaxLength - needle.length) / 2));
	const start = Math.max(0, matchIndex - context);
	const end = Math.min(compact.length, matchIndex + needle.length + context);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < compact.length ? "…" : "";
	return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function createSearchSample(text: string, needle: string, maxLength: number): string {
	const compact = compactDisplayText(text);
	if (!compact) return "";

	const normalized = normalizeSearchText(compact);
	const matchIndex = needle ? normalized.indexOf(needle) : -1;
	if (matchIndex < 0) return compact.slice(0, Math.max(20, maxLength));

	const safeMaxLength = Math.max(20, maxLength, needle.length);
	const context = Math.max(0, Math.floor((safeMaxLength - needle.length) / 2));
	const start = Math.max(0, matchIndex - context);
	const end = Math.min(compact.length, matchIndex + needle.length + context);
	return compact.slice(start, end);
}

function stripSnippetEllipses(snippet: string): string {
	return compactDisplayText(snippet.replace(/^…/u, "").replace(/…$/u, ""));
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = normalizeSearchText(trimmed);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(trimmed);
	}
	return result;
}

function compactDisplayText(text: string): string {
	return sanitizeText(text).replace(/\s+/gu, " ").trim();
}

function normalizeSearchText(text: string): string {
	return compactDisplayText(text).toLocaleLowerCase();
}

function sessionSearchResultTitle(session: SessionInfo): string {
	const name = session.name?.trim();
	if (name) return name;
	const firstMessage = compactDisplayText(session.firstMessage);
	if (firstMessage) return firstMessage.slice(0, 60);
	return `session ${session.id.slice(0, 8)}`;
}

function formatSessionSearchDateTime(dateTime: Date): { date: string; time: string } {
	return {
		date: dateTime.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }),
		time: dateTime.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
	};
}
