import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { SESSION_RECOVERY_TOOL_DESCRIPTIONS } from "../tool-descriptions.js";

type Scope = "active" | "all";
type UnknownRecord = Record<string, unknown>;

type SessionManagerLike = {
	getBranch?: () => unknown;
	getEntries?: () => unknown;
	getHeader?: () => unknown;
	getSessionFile?: () => unknown;
	getSessionId?: () => unknown;
	getSessionName?: () => unknown;
};

type EntryLike = UnknownRecord & {
	id: string;
	type: string;
	parentId?: string | null;
	timestamp?: string;
};

type ToolCallLike = {
	id: string;
	name: string;
	arguments: unknown;
	entryId: string;
};

type FileEvidence = {
	readFiles: string[];
	modifiedFiles: string[];
};

type Section = {
	id: string;
	startEntryId: string;
	endEntryId: string;
	entries: EntryLike[];
	label: string;
};

const SCOPE_SCHEMA = StringEnum(["active", "all"] as const, {
	description: "Raw session scope. Defaults to the active root-to-leaf branch; all includes abandoned branches.",
});

const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_BODY_CHARS = 2_000;
const MAX_BODY_CHARS = 8_000;
const DEFAULT_SECTION_ENTRIES = 20;
const MAX_SECTION_ENTRIES = 50;
const DEFAULT_SEARCH_RESULTS = 20;
const MAX_SEARCH_RESULTS = 50;
const DEFAULT_OVERVIEW_SECTIONS = 20;
const MAX_OVERVIEW_SECTIONS = 100;
const DEFAULT_RECENT_ERRORS = 5;
const MAX_RECENT_ERRORS = 20;
const MAX_RECOVERY_FILES = 200;
const MAX_PENDING_TOOL_CALLS = 50;
const MAX_SEARCH_QUERY_CHARS = 500;

const READ_TOOL_NAMES = new Set([
	"read",
	"grep",
	"glob",
	"find",
	"ls",
	"ast_grep",
	"repo_architecture",
	"repo_structure",
	"repo_ast",
	"repo_search",
	"repo_explain",
	"repo_deps",
]);

const MUTATING_TOOL_NAMES = new Set(["write", "edit", "apply_patch", "ast_apply"]);

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntry(value: unknown): value is EntryLike {
	return isRecord(value) && typeof value.id === "string" && value.id.length > 0
		&& typeof value.type === "string" && value.type.length > 0;
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function scopeFrom(value: unknown): Scope {
	return value === "all" ? "all" : "active";
}

function callSafely<T>(operation: (() => unknown) | undefined, fallback: T): T {
	if (!operation) return fallback;
	try {
		return operation() as T;
	} catch {
		return fallback;
	}
}

function sessionManagerFrom(context: unknown): SessionManagerLike | undefined {
	if (!isRecord(context) || !isRecord(context.sessionManager)) return undefined;
	return context.sessionManager as SessionManagerLike;
}

function entriesFor(manager: SessionManagerLike | undefined, scope: Scope): EntryLike[] {
	if (!manager) return [];
	const raw = callSafely<unknown>(
		scope === "all"
			? () => manager.getEntries?.()
			: () => manager.getBranch?.(),
		[],
	);
	return Array.isArray(raw) ? raw.filter(isEntry) : [];
}

function messageFrom(entry: EntryLike): UnknownRecord | undefined {
	return entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
}

function messageRole(entry: EntryLike): string | undefined {
	const role = messageFrom(entry)?.role;
	return typeof role === "string" ? role : undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => (part as UnknownRecord).text as string)
		.join("\n");
}

function toolCallsFrom(entry: EntryLike): ToolCallLike[] {
	const message = messageFrom(entry);
	if (!message || !Array.isArray(message.content)) return [];

	const calls: ToolCallLike[] = [];
	for (const part of message.content) {
		if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string") continue;
		calls.push({ id: part.id, name: part.name, arguments: part.arguments, entryId: entry.id });
	}
	return calls;
}

function toolResultFrom(entry: EntryLike): UnknownRecord | undefined {
	const message = messageFrom(entry);
	return message?.role === "toolResult" ? message : undefined;
}

function summaryFrom(entry: EntryLike): string {
	if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
		return entry.summary;
	}
	return "";
}

function entryText(entry: EntryLike): string {
	const message = messageFrom(entry);
	const chunks: string[] = [];

	if (message) {
		const text = textFromContent(message.content);
		if (text) chunks.push(text);
		for (const call of toolCallsFrom(entry)) {
			chunks.push(call.name, serializeJson(call.arguments));
		}
	} else if (entry.type === "custom_message") {
		const text = textFromContent(entry.content);
		if (text) chunks.push(text);
	}

	const summary = summaryFrom(entry);
	if (summary) chunks.push(summary);
	return chunks.join("\n");
}

function preview(value: string, maximum = 120): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maximum) return singleLine;
	return `${singleLine.slice(0, Math.max(0, maximum - 1))}…`;
}

function truncate(value: string, maximum: number): string {
	if (value.length <= maximum) return value;
	return `${value.slice(0, Math.max(0, maximum - 20))}\n…[truncated]`;
}

function safeJson(value: unknown, maximum = 2_000): string {
	return truncate(serializeJson(value), maximum);
}

function serializeJson(value: unknown): string {
	try {
		const json = JSON.stringify(value);
		return json ?? String(value);
	} catch {
		return "[unserializable]";
	}
}

function sectionLabel(entry: EntryLike): string {
	const role = messageRole(entry);
	const text = entryText(entry);
	if (role === "user") return preview(text) || "User message";
	if (entry.type === "compaction") return `Compaction: ${preview(text) || entry.id}`;
	if (entry.type === "branch_summary") return `Branch summary: ${preview(text) || entry.id}`;
	return preview(text) || `${entry.type} ${entry.id}`;
}

function isSectionStart(entry: EntryLike, index: number): boolean {
	return index === 0 || messageRole(entry) === "user" || entry.type === "compaction" || entry.type === "branch_summary";
}

function buildSections(entries: EntryLike[]): Section[] {
	const sections: Section[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (isSectionStart(entry, index)) {
			sections.push({
				id: `section:${entry.id}`,
				startEntryId: entry.id,
				endEntryId: entry.id,
				entries: [entry],
				label: sectionLabel(entry),
			});
			continue;
		}

		const section = sections[sections.length - 1]!;
		section.entries.push(entry);
		section.endEntryId = entry.id;
	}
	return sections;
}

function stringValues(value: unknown): string[] {
	if (typeof value === "string") return value.trim() ? [value.trim()] : [];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function pathsFromArguments(argumentsValue: unknown): string[] {
	if (!isRecord(argumentsValue)) return [];
	const paths = [
		...stringValues(argumentsValue.path),
		...stringValues(argumentsValue.file_path),
		...stringValues(argumentsValue.paths),
	];
	return [...new Set(paths)];
}

function patchPaths(argumentsValue: unknown): string[] {
	if (!isRecord(argumentsValue)) return [];
	let patch = "";
	if (typeof argumentsValue.input === "string") patch = argumentsValue.input;
	else if (typeof argumentsValue.patch === "string") patch = argumentsValue.patch;
	if (!patch) return [];

	const paths: string[] = [];
	for (const line of patch.split(/\r?\n/)) {
		const piHeader = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) ?? line.match(/^\*\*\* Move to: (.+)$/);
		const unifiedHeader = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
		const candidate = piHeader?.[1] ?? unifiedHeader?.[1];
		if (candidate && candidate !== "/dev/null") paths.push(candidate.trim());
	}
	return [...new Set(paths.filter(Boolean))];
}

function evidenceFromEntries(entries: EntryLike[]): FileEvidence {
	const readFiles = new Set<string>();
	const modifiedFiles = new Set<string>();

	for (const entry of entries) {
		for (const call of toolCallsFrom(entry)) {
			const normalizedName = call.name.toLowerCase();
			if (READ_TOOL_NAMES.has(normalizedName)) {
				for (const file of pathsFromArguments(call.arguments)) readFiles.add(file);
			}
			if (MUTATING_TOOL_NAMES.has(normalizedName)) {
				for (const file of pathsFromArguments(call.arguments)) modifiedFiles.add(file);
				if (normalizedName === "apply_patch") {
					for (const file of patchPaths(call.arguments)) modifiedFiles.add(file);
				}
			}
		}

		if ((entry.type === "compaction" || entry.type === "branch_summary") && isRecord(entry.details)) {
			for (const file of stringValues(entry.details.readFiles)) readFiles.add(file);
			for (const file of stringValues(entry.details.modifiedFiles)) modifiedFiles.add(file);
		}
	}

	return { readFiles: [...readFiles], modifiedFiles: [...modifiedFiles] };
}

function sectionSummary(section: Section): UnknownRecord {
	const roles: Record<string, number> = {};
	let toolCalls = 0;
	let toolResults = 0;
	let errors = 0;

	for (const entry of section.entries) {
		const role = messageRole(entry);
		if (role) roles[role] = (roles[role] ?? 0) + 1;
		toolCalls += toolCallsFrom(entry).length;
		const result = toolResultFrom(entry);
		if (result) {
			toolResults += 1;
			if (result.isError === true) errors += 1;
		}
	}

	const files = evidenceFromEntries(section.entries);
	return {
		id: section.id,
		label: section.label,
		startEntryId: section.startEntryId,
		endEntryId: section.endEntryId,
		entryCount: section.entries.length,
		roles,
		toolCalls,
		toolResults,
		errors,
		readFileCount: files.readFiles.length,
		modifiedFileCount: files.modifiedFiles.length,
	};
}

function boundedHeadAndTail<T>(values: T[], maximum: number): { values: T[]; omitted: number } {
	if (values.length <= maximum) return { values, omitted: 0 };
	const headCount = Math.ceil(maximum / 2);
	const tailCount = Math.floor(maximum / 2);
	return {
		values: [...values.slice(0, headCount), ...values.slice(values.length - tailCount)],
		omitted: values.length - maximum,
	};
}

function leafCount(entries: EntryLike[]): number {
	if (entries.length === 0) return 0;
	const ids = new Set(entries.map((entry) => entry.id));
	const parents = new Set(
		entries
			.map((entry) => entry.parentId)
			.filter((parentId): parentId is string => typeof parentId === "string" && ids.has(parentId)),
	);
	return entries.reduce((count, entry) => count + (parents.has(entry.id) ? 0 : 1), 0);
}

function renderEntry(entry: EntryLike, bodyChars: number): string {
	const heading = [`[${entry.id}]`, entry.timestamp, entry.type, messageRole(entry)].filter(Boolean).join(" ");
	const lines = [heading];
	const message = messageFrom(entry);

	if (message) {
		const text = textFromContent(message.content);
		if (text) lines.push(truncate(text, bodyChars));
		for (const call of toolCallsFrom(entry)) {
			lines.push(`tool_call ${call.name}#${call.id} ${safeJson(call.arguments, bodyChars)}`);
		}
		if (message.role === "toolResult") {
			const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
			const callId = typeof message.toolCallId === "string" ? message.toolCallId : "unknown";
			lines.push(`tool_result ${toolName}#${callId}${message.isError === true ? " error" : ""}`);
		}
	} else if (entry.type === "compaction") {
		lines.push(truncate(summaryFrom(entry), bodyChars));
		if (typeof entry.firstKeptEntryId === "string") lines.push(`firstKeptEntryId: ${entry.firstKeptEntryId}`);
		if (typeof entry.tokensBefore === "number") lines.push(`tokensBefore: ${entry.tokensBefore}`);
	} else if (entry.type === "branch_summary") {
		lines.push(truncate(summaryFrom(entry), bodyChars));
		if (typeof entry.fromId === "string") lines.push(`fromId: ${entry.fromId}`);
	} else if (entry.type === "custom_message") {
		const text = textFromContent(entry.content);
		if (text) lines.push(truncate(text, bodyChars));
	} else {
		const fields = Object.fromEntries(
			Object.entries(entry).filter(([key]) => !["id", "parentId", "timestamp", "type"].includes(key)),
		);
		if (Object.keys(fields).length > 0) lines.push(safeJson(fields, bodyChars));
	}

	return lines.join("\n");
}

function contentResult(payload: unknown, details: UnknownRecord): { content: Array<{ type: "text"; text: string }>; details: UnknownRecord } {
	const serialized = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
	return {
		content: [{ type: "text", text: truncate(serialized, MAX_OUTPUT_CHARS) }],
		details,
	};
}

function emptyResult(scope: Scope): ReturnType<typeof contentResult> {
	return contentResult(
		`No raw session entries are available for scope ${scope}. The session may be new, ephemeral, or unavailable in this context.`,
		{ scope, entryCount: 0 },
	);
}

function sectionIdByEntry(sections: Section[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const section of sections) {
		for (const entry of section.entries) map.set(entry.id, section.id);
	}
	return map;
}

function searchSnippet(text: string, query: string, caseSensitive: boolean, maximum = 360): string {
	const haystack = caseSensitive ? text : text.toLocaleLowerCase();
	const needle = caseSensitive ? query : query.toLocaleLowerCase();
	const index = haystack.indexOf(needle);
	if (index < 0) return preview(text, maximum);
	const start = Math.max(0, index - Math.floor((maximum - needle.length) / 2));
	const end = Math.min(text.length, start + maximum);
	return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

function meaningfulAction(entry: EntryLike, excludedToolCallId: string): UnknownRecord | undefined {
	const role = messageRole(entry);
	const calls = toolCallsFrom(entry).filter((call) => call.id !== excludedToolCallId);
	const message = messageFrom(entry);
	const messageText = message ? textFromContent(message.content) : "";
	const text = messageText || summaryFrom(entry) || (entry.type === "custom_message" ? textFromContent(entry.content) : "");
	if (!text && calls.length === 0 && entry.type !== "compaction" && entry.type !== "branch_summary") return undefined;
	return {
		entryId: entry.id,
		type: entry.type,
		...(role ? { role } : {}),
		...(text ? { preview: preview(text, 300) } : {}),
		...(calls.length > 0 ? { toolCalls: calls.map((call) => ({ id: call.id, name: call.name })) } : {}),
	};
}

export default function sessionRecovery(pi: ExtensionAPI): void {
	pi.registerTool({
		...SESSION_RECOVERY_TOOL_DESCRIPTIONS.overview,
		parameters: Type.Object({
			scope: Type.Optional(SCOPE_SCHEMA),
			max_sections: Type.Optional(Type.Number({
				description: "Maximum section summaries to return, split between the head and tail.",
				minimum: 1,
				maximum: MAX_OVERVIEW_SECTIONS,
			})),
		}, { additionalProperties: false }),
		async execute(_toolCallId: string, params: { scope?: Scope; max_sections?: number }, _signal: AbortSignal, _onUpdate: unknown, ctx: unknown) {
			const scope = scopeFrom(params.scope);
			const manager = sessionManagerFrom(ctx);
			const entries = entriesFor(manager, scope);
			if (entries.length === 0) return emptyResult(scope);

			const activeEntries = entriesFor(manager, "active");
			const allEntries = entriesFor(manager, "all");
			const sections = buildSections(entries);
			const maximum = clampInteger(params.max_sections, DEFAULT_OVERVIEW_SECTIONS, 1, MAX_OVERVIEW_SECTIONS);
			const selected = boundedHeadAndTail(sections, maximum);
			const allLeaves = leafCount(allEntries);
			const header = callSafely<unknown>(() => manager?.getHeader?.(), undefined);
			const sessionId = callSafely<unknown>(() => manager?.getSessionId?.(), undefined);
			const sessionName = callSafely<unknown>(() => manager?.getSessionName?.(), undefined);
			const sessionFile = callSafely<unknown>(() => manager?.getSessionFile?.(), undefined);
			const payload = {
				scope,
				session: {
					id: typeof sessionId === "string" ? sessionId : null,
					name: typeof sessionName === "string" ? sessionName : null,
					persisted: typeof sessionFile === "string" && sessionFile.length > 0,
					hasParentSession: isRecord(header) && header.parentSession != null,
				},
				counts: {
					selectedEntries: entries.length,
					activeEntries: activeEntries.length,
					allEntries: allEntries.length,
					sections: sections.length,
					compactions: entries.filter((entry) => entry.type === "compaction").length,
					leaves: allLeaves,
					otherBranches: Math.max(0, allLeaves - (activeEntries.length > 0 ? 1 : 0)),
				},
				sections: selected.values.map(sectionSummary),
				omittedSections: selected.omitted,
			};
			return contentResult(payload, { scope, entryCount: entries.length, sectionCount: sections.length, omittedSections: selected.omitted });
		},
	});

	pi.registerTool({
		...SESSION_RECOVERY_TOOL_DESCRIPTIONS.readSection,
		parameters: Type.Object({
			section_id: Type.String({ description: "Stable section ID returned by session_overview or session_search.", maxLength: 200 }),
			scope: Type.Optional(SCOPE_SCHEMA),
			max_entries: Type.Optional(Type.Number({ description: "Maximum entries to render from the section.", minimum: 1, maximum: MAX_SECTION_ENTRIES })),
			max_body_chars: Type.Optional(Type.Number({ description: "Maximum rendered body characters per entry.", minimum: 100, maximum: MAX_BODY_CHARS })),
		}, { additionalProperties: false }),
		async execute(_toolCallId: string, params: { section_id: string; scope?: Scope; max_entries?: number; max_body_chars?: number }, _signal: AbortSignal, _onUpdate: unknown, ctx: unknown) {
			const scope = scopeFrom(params.scope);
			const entries = entriesFor(sessionManagerFrom(ctx), scope);
			if (entries.length === 0) return emptyResult(scope);
			const section = buildSections(entries).find((candidate) => candidate.id === params.section_id);
			if (!section) {
				return contentResult(
					`Section ${params.section_id} was not found in scope ${scope}. Run session_overview with the same scope to refresh section IDs.`,
					{ scope, sectionId: params.section_id, found: false },
				);
			}

			const maximum = clampInteger(params.max_entries, DEFAULT_SECTION_ENTRIES, 1, MAX_SECTION_ENTRIES);
			const bodyChars = clampInteger(params.max_body_chars, DEFAULT_BODY_CHARS, 100, MAX_BODY_CHARS);
			const rendered: string[] = [];
			let renderedChars = 0;
			let truncatedOutput = false;
			for (const entry of section.entries.slice(0, maximum)) {
				const next = renderEntry(entry, bodyChars);
				if (renderedChars + next.length + 2 > MAX_OUTPUT_CHARS - 500) {
					truncatedOutput = true;
					break;
				}
				rendered.push(next);
				renderedChars += next.length + 2;
			}
			const omittedEntries = section.entries.length - rendered.length;
			return contentResult(
				[`Section ${section.id}: ${section.label}`, ...rendered, omittedEntries > 0 ? `… ${omittedEntries} entries omitted` : ""].filter(Boolean).join("\n\n"),
				{
					scope,
					sectionId: section.id,
					entryCount: section.entries.length,
					renderedCount: rendered.length,
					omittedEntries,
					truncated: truncatedOutput || omittedEntries > 0,
				},
			);
		},
	});

	pi.registerTool({
		...SESSION_RECOVERY_TOOL_DESCRIPTIONS.search,
		parameters: Type.Object({
			query: Type.String({
				description: "Literal substring to find in raw session text and tool arguments.",
				minLength: 1,
				maxLength: MAX_SEARCH_QUERY_CHARS,
			}),
			scope: Type.Optional(SCOPE_SCHEMA),
			case_sensitive: Type.Optional(Type.Boolean({ description: "Use exact case matching. Defaults to false." })),
			limit: Type.Optional(Type.Number({ description: "Maximum matches to return.", minimum: 1, maximum: MAX_SEARCH_RESULTS })),
		}, { additionalProperties: false }),
		async execute(_toolCallId: string, params: { query: string; scope?: Scope; case_sensitive?: boolean; limit?: number }, _signal: AbortSignal, _onUpdate: unknown, ctx: unknown) {
			const scope = scopeFrom(params.scope);
			const entries = entriesFor(sessionManagerFrom(ctx), scope);
			if (entries.length === 0) return emptyResult(scope);
			const query = params.query.trim().slice(0, MAX_SEARCH_QUERY_CHARS);
			if (!query) return contentResult("Search query must not be empty.", { scope, query, matchCount: 0 });

			const caseSensitive = params.case_sensitive === true;
			const needle = caseSensitive ? query : query.toLocaleLowerCase();
			const limit = clampInteger(params.limit, DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
			const sections = buildSections(entries);
			const entrySections = sectionIdByEntry(sections);
			const matches: UnknownRecord[] = [];
			let totalMatches = 0;

			for (const entry of entries) {
				const text = entryText(entry);
				const haystack = caseSensitive ? text : text.toLocaleLowerCase();
				if (!text || !haystack.includes(needle)) continue;
				totalMatches += 1;
				if (matches.length >= limit) continue;
				matches.push({
					entryId: entry.id,
					sectionId: entrySections.get(entry.id),
					type: entry.type,
					...(messageRole(entry) ? { role: messageRole(entry) } : {}),
					timestamp: entry.timestamp ?? null,
					snippet: searchSnippet(text, query, caseSensitive),
				});
			}

			const payload = { scope, query, caseSensitive, totalMatches, returnedMatches: matches.length, matches };
			return contentResult(payload, { scope, query, matchCount: totalMatches, returnedCount: matches.length, truncated: totalMatches > matches.length });
		},
	});

	pi.registerTool({
		...SESSION_RECOVERY_TOOL_DESCRIPTIONS.recoveryContext,
		parameters: Type.Object({
			scope: Type.Optional(SCOPE_SCHEMA),
			recent_error_limit: Type.Optional(Type.Number({ description: "Maximum recent error tool results to report.", minimum: 1, maximum: MAX_RECENT_ERRORS })),
		}, { additionalProperties: false }),
		async execute(toolCallId: string, params: { scope?: Scope; recent_error_limit?: number }, _signal: AbortSignal, _onUpdate: unknown, ctx: unknown) {
			const scope = scopeFrom(params.scope);
			const entries = entriesFor(sessionManagerFrom(ctx), scope);
			if (entries.length === 0) return emptyResult(scope);

			const sections = buildSections(entries);
			const entrySections = sectionIdByEntry(sections);
			const userEntries = entries.filter((entry) => messageRole(entry) === "user" && entryText(entry).trim().length > 0);
			const pending = new Map<string, ToolCallLike>();
			const errors: UnknownRecord[] = [];

			for (const entry of entries) {
				for (const call of toolCallsFrom(entry)) pending.set(call.id, call);
				const result = toolResultFrom(entry);
				if (!result) continue;
				if (typeof result.toolCallId === "string") pending.delete(result.toolCallId);
				if (result.isError === true) {
					errors.push({
						entryId: entry.id,
						sectionId: entrySections.get(entry.id),
						toolCallId: typeof result.toolCallId === "string" ? result.toolCallId : null,
						toolName: typeof result.toolName === "string" ? result.toolName : null,
						message: preview(textFromContent(result.content), 500),
					});
				}
			}
			pending.delete(toolCallId);

			const errorLimit = clampInteger(params.recent_error_limit, DEFAULT_RECENT_ERRORS, 1, MAX_RECENT_ERRORS);
			const firstUser = userEntries[0];
			const latestUser = userEntries[userEntries.length - 1];
			const files = evidenceFromEntries(entries);
			const readFiles = boundedHeadAndTail(files.readFiles, MAX_RECOVERY_FILES);
			const modifiedFiles = boundedHeadAndTail(files.modifiedFiles, MAX_RECOVERY_FILES);
			const pendingCalls = boundedHeadAndTail([...pending.values()], MAX_PENDING_TOOL_CALLS);
			const lastAction = [...entries].reverse().map((entry) => meaningfulAction(entry, toolCallId)).find(Boolean) ?? null;
			const payload = {
				scope,
				originalUserRequest: firstUser ? {
					entryId: firstUser.id,
					sectionId: entrySections.get(firstUser.id),
					text: truncate(entryText(firstUser), DEFAULT_BODY_CHARS),
				} : null,
				latestUserInstruction: latestUser ? {
					entryId: latestUser.id,
					sectionId: entrySections.get(latestUser.id),
					text: truncate(entryText(latestUser), DEFAULT_BODY_CHARS),
				} : null,
				readFiles: readFiles.values,
				modifiedFiles: modifiedFiles.values,
				omittedReadFiles: readFiles.omitted,
				omittedModifiedFiles: modifiedFiles.omitted,
				recentErrors: errors.slice(-errorLimit),
				pendingToolCalls: pendingCalls.values.map((call) => ({
					id: call.id,
					name: call.name,
					entryId: call.entryId,
					sectionId: entrySections.get(call.entryId),
				})),
				omittedPendingToolCalls: pendingCalls.omitted,
				lastMeaningfulAction: lastAction,
				compactionCount: entries.filter((entry) => entry.type === "compaction").length,
				entryCount: entries.length,
				sectionCount: sections.length,
			};
			return contentResult(payload, {
				scope,
				entryCount: entries.length,
				sectionCount: sections.length,
				recentErrorCount: payload.recentErrors.length,
				pendingToolCallCount: payload.pendingToolCalls.length,
			});
		},
	});
}
